/**
 * pi-nvidia-plus — спайк тикета 05 (архитектура D2: хук-онли, без registerProvider).
 *
 * Проверяет чек-лист `.scratch/pi-nvidia-plus/issues/05-architecture-decision.md`:
 *  1) оверрайды в формате пи (`reasoning` + `thinkingLevelMap`) проявляют уровни
 *     мышления в UI — данные в `overrides/models.json`, применяются командой
 *     `/nvidia-plus-apply`;
 *  2) `before_provider_request` реально инжектит thinking-параметры по семействам,
 *     уровень берётся из `ctx.thinkingLevel`;
 *  3) предупреждения: статическое при выборе мёртвой модели (`model_select`);
 *     динамическое после 404/410/429/5xx в `after_provider_response` невозможно —
 *     событие не стреляет на ошибках (см. тикет);
 *  4) идемпотентное применение оверрайдов в `~/.pi/agent/models.json`, владение
 *     только своими `id`; леджер — `~/.pi/agent/nvidia-plus-models.json`;
 *  5) все обработчики гейтятся по `provider === "nvidia"`.
 *
 * Сосуществование с `pi-free` (apmantza): его провайдеры имеют собственные `id`
 * (`merge`, `tokenrouter`, …) — гейты по провайдеру исключают пересечение;
 * статус-ключ `nvidia-plus` не пересекается с его `quota`; `models.json`
 * трогается только в провайдере `nvidia`.
 *
 * Отладка: `PI_NVIDIA_PLUS_DEBUG=1` пишет финальные пейлоады в
 * `~/.pi/nvidia-plus-debug.log`.
 *
 * Прокси (тикеты 10/11): `NVIDIA_NIM_PROXY` (например, `http://192.168.88.248:8870`)
 * маршрутирует только запросы к `https://integrate.api.nvidia.com` через выборочный
 * глобальный диспетчер (вариант A исследования 04); остальной трафик не трогается.
 * Обёртка наблюдает ответы и показывает диагностику 429/5xx (retry-after, request ID)
 * прямо во время ретрай-пауз пи.
 *
 * Ротация ключей (тикет 15): пул `~/.pi/agent/nvidia-keys.json` (или `NVIDIA_NIM_KEYS[_FILE]`)
 * ставит обёртку даже без прокси; на 429 после исчерпания повторов ключ меняется,
 * на 401/403 — исключается до конца сессии; аварийные выключатели —
 * `NVIDIA_NIM_KEY_ROTATION=0` и `/nvidia-plus-keys off|on`. При выключенном прозрачном
 * повторе (`NVIDIA_NIM_TRANSPORT_RETRY=0`) ротация вырождается в переключение на первый же 429.
 *
 * Наблюдаемость (тикет 16): прокси-интро и префлайт — только при выбранной модели `nvidia`
 * (на старте сессии или при выборе); на не-`nvidia` сессиях расширение себя не проявляет.
 */
import { appendFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyFiles, loadState, loadDiscoveryReport, rollbackFiles, writeDiscovered, MODELS_JSON, STATE_FILE } from "./store.ts";
import { transformRequest, thinkingPlan, type Payload } from "./transform.ts";
import { parseModelsResponse, classifyDiscovery } from "./discovery.ts";
import { KeyPool, KeyRotator, maskKey, DEFAULT_KEYS_FILE_NAME } from "./keys.ts";
import { t } from "./i18n.ts";
import {
  parseProxyUrl,
  ensureDispatcherInstalled,
  isProxyConnectError,
  describeProxyFailure,
  formatDiagnostic,
  markDispatcher,
  NVIDIA_ORIGIN,
  type NimDiagnostic,
} from "./proxy.ts";

const PROVIDER = "nvidia";
const DEBUG = process.env.PI_NVIDIA_PLUS_DEBUG === "1";
const DEBUG_LOG = join(homedir(), ".pi", "nvidia-plus-debug.log");

// ── Мёртвые модели встроенного каталога (аудит, тикет 02) ───────────────────
// 410 EOL — надёжно; 404-стойкий — по пробам (404 бывает транзитным).
const DEAD_MODELS: Record<string, string> = {
  "meta/llama-3.1-70b-instruct": "410 EOL",
  "meta/llama-3.1-8b-instruct": "410 EOL",
  "meta/llama-3.3-70b-instruct": "410 EOL",
  "nvidia/llama-3.1-nemotron-nano-8b-v1": "410 EOL",
  "nvidia/llama-3.1-nemotron-nano-vl-8b-v1": "410 EOL",
  "nvidia/llama-3.3-nemotron-super-49b-v1": "410 EOL",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": "410 EOL",
  "nvidia/nemotron-nano-12b-v2-vl": "410 EOL",
  "nvidia/nvidia-nemotron-nano-9b-v2": "410 EOL",
  "thinkingmachines/inkling": "410 EOL",
  "deepseek-ai/deepseek-v4-flash-0731": "flapping: 200 once, then persistent 404 (2026-08-28)",
  "nvidia/nemotron-3.5-lightning-30b-a3b": "flapping: live until 2026-08-27, persistent 404 since 2026-08-28",
  "google/gemma-3-4b-it": "404 in all probes",
  "google/gemma-3-12b-it": "404 in all probes",
  "mistralai/mistral-7b-instruct-v0.3": "404 in all probes",
  "moonshotai/kimi-k2.6": "404 in all probes",
  "nvidia/cosmos-reason2-8b": "404 in all probes",
  "nvidia/llama-3.1-nemotron-70b-instruct": "404 in all probes (re-check ticket 08)",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1": "404 in all probes",
  // Вне базы пи (аудит 02; нужно для живого обнаружения — не добавлять мёртвых)
  "01-ai/yi-large": "404 in all probes (audit 02)",
  "ai21labs/jamba-1.5-large-instruct": "404 in all probes (audit 02)",
  "databricks/dbrx-instruct": "404 in all probes (audit 02)",
  "deepseek-ai/deepseek-v4-flash": "410 EOL (audit 02)",
  "deepseek-ai/deepseek-v4-pro": "410 EOL (audit 02)",
  "microsoft/phi-3-vision-128k-instruct": "404 in all probes (audit 02)",
  "microsoft/phi-3.5-moe-instruct": "404 in all probes (audit 02)",
  "mistralai/codestral-22b-instruct-v0.1": "404 in all probes (audit 02)",
  "mistralai/mistral-large": "404 in all probes (audit 02)",
  "mistralai/mistral-large-2-instruct": "404 in all probes (audit 02)",
  "mistralai/mixtral-8x22b-v0.1": "404 in all probes (audit 02)",
  "nvidia/llama-3.1-nemotron-51b-instruct": "404 in all probes (audit 02)",
  "nvidia/nemotron-4-340b-instruct": "404 in all probes (audit 02)",
  "nvidia/nemotron-mini-4b-instruct": "410 EOL (audit 02)",
  "nvidia/nemotron-nano-3-30b-a3b": "404 in all probes (audit 02)",
  "nvidia/vila": "404 in all probes (audit 02)",
  "writer/palmyra-creative-122b": "404 in all probes (audit 02)",
};

function debug(stage: string, label: string, payload: unknown): void {
  if (!DEBUG) return;
  try {
    appendFileSync(
      DEBUG_LOG,
      `--- ${new Date().toISOString()} ${stage} ${label} ---\n${JSON.stringify(payload, null, 2)}\n`,
    );
  } catch {
    // спайк: лог не критичен
  }
}

function findRequestId(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (/request[-_]?id/i.test(key) && typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// ── Прокси: состояние и установка (тикеты 10/11) ─────────────────────────────
// Нужен экземпляр undici самого пи: у расширения свой node_modules, и его undici
// на глобальный диспетчер пи не влияет. Ищем от входа пи (process.argv[1]).
type Notifier = (message: string, type?: "info" | "warning" | "error") => void;
interface ProxyState {
  configured: boolean;
  url?: URL;
  installError?: string;
  installed: boolean;
  preflightDone: boolean;
  preflightError?: string;
  notify?: Notifier;
}

const proxyState: ProxyState = { configured: false, installed: false, preflightDone: false };
let proxyErrorNotified = false;
// Критерий приёмки №2 (ошибка запроса): наблюдатель диспетчера видит 404/410,
// которые минуют `after_provider_response`. Уведомляем один раз на модель+статус.
const notifiedDeadResponses = new Set<string>();
// Диагностика 429/5xx после повторов: не чаще раза в минуту на модель+статус,
// чтобы ретрай-цикл пи не заваливал пользователя одинаковыми предупреждениями.
const lastDiagnosticNotify = new Map<string, number>();
let lastNvidiaModelId: string | undefined;

// Прозрачный транспортный повтор 429/5xx (тикет 14): короткие рейт-лимиты и
// шлюзовые ошибки повторяются под наблюдателем, и пи с моделью их не видят.
// Темп (живое замечание тикета 15): 4 попытки на ключ с плоской задержкой 2 с —
// живой NIM заголовки в 429 не даёт, а рейт-лимит на аккаунт плавает.
const TRANSPORT_RETRY = { maxRetries: 3, minDelayMs: 2_000, maxDelayMs: 30_000 } as const;
function transportRetryEnabled(): boolean {
  const raw = process.env.NVIDIA_NIM_TRANSPORT_RETRY?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

// ── Ротация ключей NIM (тикет 15) ──────────────────────────────────────────────
// Пул читается из файла/окружения (расширение его никогда не пишет); ключ пи всегда первый в кольце — его подставляет сам пи в `Authorization`.
const keyPool = new KeyPool({
  defaultPath: join(homedir(), ".pi", "agent", DEFAULT_KEYS_FILE_NAME),
  env: process.env as Record<string, string | undefined>,
  onWarn: (message) => proxyState.notify?.(message, "warning"),
});
const keyRotator = new KeyRotator();
const keyRotationState = {
  enabled: (() => {
    const raw = process.env.NVIDIA_NIM_KEY_ROTATION?.trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
  })(),
  installedWithRotation: false,
};

// Представление ротации — один раз и только при выбранной модели nvidia:
// на старте сессии (если она уже стоит) или при выборе модели.
let rotationIntroNotified = false;
function notifyRotationIntro(ui: { notify: Notifier }): void {
  if (rotationIntroNotified || !keyPool.hasSource()) return;
  rotationIntroNotified = true;
  const poolSize = keyPool.refresh().length;
  const state = keyRotationState.enabled ? t("rotationStateOn") : t("rotationStateOff");
  ui.notify(
    t("rotationIntro", { state, source: keyPool.describe(), count: poolSize }),
    "info",
  );
}

// Прокси-интро (тикет 16) — один раз и только при выбранной модели nvidia:
// на старте сессии (если она уже стоит) или при выборе модели. На не-`nvidia`
// сессиях расширение не должно проявляться (критерий приёмки №5).
let proxyIntroNotified = false;
function notifyProxyIntro(ui: { notify: Notifier }): void {
  if (proxyIntroNotified || !proxyState.configured || !proxyState.url) return;
  proxyIntroNotified = true;
  if (proxyState.installError) {
    ui.notify(t("proxyNotEnabled", { error: proxyState.installError }), "error");
    return;
  }
  ui.notify(t("proxyIntro", { url: proxyState.url.toString().replace(/\/$/, "") }), "info");
  void preflightProxy();
}

function resolvePiUndici(): { undici?: any; error?: string } {
  // argv[1] может быть симлинком (например, ~/.local/bin/pi) — createRequire
  // его не разворачивает, поэтому берём realpath.
  const candidates: string[] = [];
  if (process.argv[1]) {
    candidates.push(process.argv[1]);
    try {
      candidates.push(realpathSync(process.argv[1]));
    } catch {
      // нет реального пути — пробуем как есть
    }
  }
  const main = (process as unknown as { mainModule?: { filename?: string } }).mainModule;
  if (main?.filename) candidates.push(main.filename);
  for (const base of candidates) {
    try {
      const undici = createRequire(base)("undici");
      if (undici?.Dispatcher && typeof undici.setGlobalDispatcher === "function") return { undici };
    } catch {
      // пробуем следующую базу
    }
  }
  return { error: t("proxyUndiciNotFound", { bases: candidates.join(", ") || t("basesNone") }) };
}

/** Идемпотентная установка обёртки; безопасно вызывать перед каждым запросом. */
function ensureTransportInstalled(): void {
  if (proxyState.installError) return;
  const proxyReady = !!(proxyState.configured && proxyState.url);
  // Пул ключей (тикет 15): обёртка ставится и без прокси, если пул задан.
  const poolPresent = keyPool.hasSource();
  if (!proxyReady && !poolPresent) return; // без конфигурации поведение не меняется
  const { undici, error } = resolvePiUndici();
  if (!undici) {
    proxyState.installError = error;
    debug("proxy-install-error", "undici не найден", { error });
    return;
  }
  const DispatcherBase = undici.Dispatcher;
  const rotation = poolPresent
    ? {
        rotator: keyRotator,
        getPoolKeys: () => keyPool.refresh(),
        enabled: () => keyRotationState.enabled,
        onSwitch: (info: { from: string; to: string; status: number }) => {
          debug("nvidia-rotation-switch", `${maskKey(info.from)} → ${maskKey(info.to)}`, {
            from: maskKey(info.from),
            to: maskKey(info.to),
            status: info.status,
          });
          proxyState.notify?.(
            t("rotationSwitch", { status: info.status, from: maskKey(info.from), to: maskKey(info.to) }),
            "info",
          );
        },
        onDeadKey: (key: string, status: number) => {
          debug("nvidia-rotation-dead", `ключ ${maskKey(key)} мёртв (${status})`, { ключ: maskKey(key), статус: status });
          proxyState.notify?.(
            t("rotationDeadKey", { status, key: maskKey(key) }),
            "warning",
          );
        },
        onExhausted: (info: { attempts: number; status: number }) => {
          debug("nvidia-rotation-exhausted", `${info.attempts} попыток — пул исчерпан`, info);
          proxyState.notify?.(
            t("rotationExhausted", { status: info.status, attempts: info.attempts }),
            "warning",
          );
        },
        onCooldownWait: (ms: number) => {
          const seconds = Math.max(1, Math.round(ms / 1000));
          debug("nvidia-rotation-wait", `все ключи в кулдауне, жду ${ms} мс`, {});
          proxyState.notify?.(t("rotationCooldownWait", { seconds }), "info");
        },
        log: (stage: string, label: string, payload: unknown) => debug(stage, label, payload),
      }
    : undefined;
  const result = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => undici.getGlobalDispatcher(),
      setGlobalDispatcher: (d) => undici.setGlobalDispatcher(d),
      createProxyAgent: (url: URL) => new undici.ProxyAgent(url.toString()),
      createRetryAgent: (agent, retryOptions) => new undici.RetryAgent(agent, retryOptions),
      adapt: (duck) => {
        class SelectiveDispatcher extends DispatcherBase {
          dispatch(opts: unknown, handler: unknown): boolean {
            return duck.dispatch(opts, handler);
          }
          close(): Promise<void> {
            return duck.close();
          }
          destroy(): Promise<void> {
            return duck.destroy();
          }
        }
        const instance = new SelectiveDispatcher();
        markDispatcher(instance);
        return instance;
      },
    },
    {
      proxyUrl: proxyReady ? proxyState.url : undefined,
      rotation,
      onObserved: (status, headers) => {
        debug("nvidia-response", `status=${status}`, { status, headers });
        if (status === 404 || status === 410) {
          // Уведомляем только для запросов с известной моделью: внутренние запросы
          // без модельного контекста (префлайт, дискавери) не должны пугать пользователя.
          if (!lastNvidiaModelId) return;
          const key = `${status}:${lastNvidiaModelId}`;
          if (!notifiedDeadResponses.has(key)) {
            notifiedDeadResponses.add(key);
            const dead = DEAD_MODELS[lastNvidiaModelId];
            proxyState.notify?.(
              dead
                ? t("deadObservedMarked", { status, modelId: lastNvidiaModelId, reason: dead })
                : t("deadObservedUnknown", { status, modelId: lastNvidiaModelId }),
              "warning",
            );
          }
        }
      },
      onDiagnostic: (d: NimDiagnostic) => {
        debug("nvidia-diagnostic", `status=${d.status}`, d);
        const key = `${d.status}:${lastNvidiaModelId ?? "?"}`;
        const now = Date.now();
        const last = lastDiagnosticNotify.get(key);
        if (last !== undefined && now - last < 60_000) return;
        lastDiagnosticNotify.set(key, now);
        proxyState.notify?.(formatDiagnostic(d), "warning");
      },
      onProxyError: (message) => {
        debug("proxy-error", message, {});
        proxyState.preflightError ??= message;
        if (!proxyErrorNotified) {
          proxyErrorNotified = true;
          proxyState.notify?.(`pi-nvidia-plus: ${message}`, "error");
        }
      },
      retry: transportRetryEnabled()
        ? {
            ...TRANSPORT_RETRY,
            onRetryScheduled: (info) => {
              debug("nvidia-retry", `статус=${info.status}, повтор ${info.attempt}, задержка ${info.delayMs} мс`, info);
              const seconds = Math.max(1, Math.round(info.delayMs / 1000));
              proxyState.notify?.(
                t("retryScheduled", {
                  status: info.status,
                  attempt: info.attempt + 1,
                  total: TRANSPORT_RETRY.maxRetries + 1,
                  seconds,
                }),
                "info",
              );
            },
          }
        : undefined,
    },
  );
  if (result.installed) {
    proxyState.installed = true;
    keyRotationState.installedWithRotation = !!rotation;
    debug(
      "proxy-installed",
      proxyReady ? proxyState.url!.toString() : "(без прокси — ротация ключей)",
      { fallback: "предыдущий глобальный диспетчер", повтор: transportRetryEnabled(), ротация: !!rotation },
    );
  } else {
    debug("proxy-install-skip", proxyReady ? proxyState.url!.toString() : "(без прокси)", { already: result.already });
  }
}

async function preflightProxy(): Promise<void> {
  if (!proxyState.configured || proxyState.preflightDone || !proxyState.url) return;
  proxyState.preflightDone = true;
  try {
    // Любой HTTP-ответ — прокси достижим. Идём на `/v1/models` (200 без
    // авторизации), а не на корень: корень отдаёт 404, и наблюдатель не должен
    // показывать пользователю ложное предупреждение о мёртвой модели.
    await fetch(`${NVIDIA_ORIGIN}/v1/models`, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    const cause = (e as { cause?: unknown } | null)?.cause ?? e;
    if (isProxyConnectError(e) || isProxyConnectError(cause)) {
      proxyState.preflightError = describeProxyFailure(proxyState.url.toString(), cause);
      proxyState.notify?.(proxyState.preflightError, "error");
    }
  }
}

function initProxyFromEnv(): void {
  const parsed = parseProxyUrl(process.env.NVIDIA_NIM_PROXY);
  debug("proxy-init", "разбор NVIDIA_NIM_PROXY", {
    raw: process.env.NVIDIA_NIM_PROXY ?? "(не задана)",
    url: parsed.url?.toString(),
    error: parsed.error,
  });
  if (parsed.error) {
    proxyState.configured = false;
    proxyState.installError = parsed.error;
    return;
  }
  if (parsed.url) {
    proxyState.configured = true;
    proxyState.url = parsed.url;
  }
  ensureTransportInstalled(); // ставится и без прокси, если задан пул ключей (тикет 15)
  if (proxyState.installError) {
    proxyState.notify?.(t("proxyNotEnabled", { error: proxyState.installError }), "error");
  }
}

/** Строка статус-бара; `undefined` очищает ключ для не-`nvidia` моделей. */
function statusLine(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model || model.provider !== PROVIDER) return undefined;
  const level = ctx.thinkingLevel;
  const plan = typeof level === "string" ? thinkingPlan(model.id, level) : undefined;
  return `nv+ ${model.id} · thinking ${level ?? "?"}${plan ? ` → ${plan}` : t("statusNoInjection")}`;
}

export default function piNvidiaPlus(pi: ExtensionAPI): void {
  // ── Прокси и диагностика (тикеты 10/11) ────────────────────────────────
  initProxyFromEnv();

  // ── Автоприменение оверрайдов (вариант «b», тикет 05) ──────────────────
  // Хука на чтение models.json в пи нет. Применяем на загрузке расширения —
  // пи перечитывает конфиг встроенным `refresh()` сразу после загрузки
  // расширений, поэтому оверрайды подхватываются уже в первой сессии.
  // `session_start` досвечивает результат и повторяет попытку при сбое.
  // Политика: пользовательские правки никогда не перезаписываются без `force`.
  let factoryApplied = false;
  try {
    if (loadState()?.enabled !== false) {
      factoryApplied = applyFiles(false).changed;
    }
  } catch {
    // session_start повторит и сообщит об ошибке.
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) proxyState.notify = (message, type) => ctx.ui.notify(message, type);
    // Пи мог пересоздать глобальный диспетчер до загрузки расширения.
    ensureTransportInstalled();
    // Прокси и ротация представляются только при выбранной модели nvidia (тикет 16).
    if (ctx.hasUI && ctx.model?.provider === PROVIDER) {
      notifyProxyIntro(ctx.ui);
      notifyRotationIntro(ctx.ui);
    }
    try {
      if (loadState()?.enabled === false) return; // погашено откатом
      const result = applyFiles(false);
      if (result.changed) {
        await ctx.modelRegistry.refresh({ allowNetwork: false });
      }
      if (!ctx.hasUI) return;
      if (result.changed || factoryApplied) {
        ctx.ui.notify(
          t("applyAutoApplied", { overrides: result.summary.overrideIds.length, models: result.summary.modelIds.length }),
          "info",
        );
      }
      factoryApplied = false;
      for (const conflict of result.conflicts) {
        ctx.ui.notify(
          t("applyConflictSkipped", {
            providerId: conflict.providerId,
            modelId: conflict.modelId,
            kind: conflict.kind,
            reason: conflict.reason,
          }),
          "warning",
        );
      }
    } catch (e) {
      if (ctx.hasUI) {
        ctx.ui.notify(t("applyAutoFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
      }
    }
  });

  // ── Интерактивная статус-строка: выбор модели и смена уровня ─────────────
  pi.on("model_select", (event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("nvidia-plus", statusLine(ctx));
    if (event.model.provider !== PROVIDER) {
      // При уходе на другой провайдер модельный контекст nvidia сбрасывается,
      // чтобы фоновые запросы без модели не приписывались старой модели.
      lastNvidiaModelId = undefined;
      return;
    }
    notifyProxyIntro(ctx.ui);
    notifyRotationIntro(ctx.ui);
    const dead = DEAD_MODELS[event.model.id];
    if (dead) {
      ctx.ui.notify(
        t("deadOnSelect", { modelId: event.model.id, reason: dead }),
        "warning",
      );
      return;
    }
    // Динамическое предупреждение по итогам живого обнаружения (тикет 12).
    const report = loadDiscoveryReport();
    if (report?.missingKnown.includes(event.model.id)) {
      ctx.ui.notify(
        t("deadMissingKnown", { modelId: event.model.id, discoveredAt: report.discoveredAt }),
        "warning",
      );
    }
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    if (!ctx.hasUI || ctx.model?.provider !== PROVIDER) return;
    ctx.ui.setStatus("nvidia-plus", statusLine(ctx));
  });

  // ── (2) Поведение — кодом: thinking-инжект + нормализация ────────────────
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return; // (5) другие провайдеры не трогаем
    lastNvidiaModelId = ctx.model.id;
    // Пи пересоздаёт глобальный диспетчер при /reload и смене настроек —
    // переустанавливаем обёртку лениво перед каждым запросом (идемпотентно).
    ensureTransportInstalled();
    const payload = event.payload as Payload | null;
    if (!payload || typeof payload !== "object") return;

    const modelId = typeof payload.model === "string" ? payload.model : undefined;
    debug("request-before", `${modelId ?? "?"} level=${ctx.thinkingLevel}`, payload);

    const { modified } = transformRequest(payload, {
      modelId,
      thinkingLevel: ctx.thinkingLevel,
      defaultMaxTokens: ctx.model?.maxTokens ?? 16384,
    });

    debug("request-after", `${modelId ?? "?"} modified=${modified}`, payload);
    if (ctx.hasUI) ctx.ui.setStatus("nvidia-plus", statusLine(ctx));
    return modified ? payload : undefined;
  });

  // ── Динамические предупреждения + диагностика 429/5xx ────────────────────
  // Внимание: событие не стреляет на ошибках (404/410/429 минуют хук) — см. тикет 05.
  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return;
    debug("response", `${ctx.model.id} status=${event.status}`, {
      status: event.status,
      headers: event.headers,
    });
    if (!ctx.hasUI) return;
    const { status } = event;
    if (status < 400) return;
    const modelId = ctx.model.id;
    const requestId = findRequestId(event.headers);
    const ref = requestId ? t("respRef", { id: requestId }) : "";
    if (status === 429) {
      const retryAfter = event.headers?.["retry-after"];
      ctx.ui.notify(
        t("respRateLimit", {
          modelId,
          retryAfter: retryAfter ? t("respRateLimitRetryAfter", { value: retryAfter }) : t("respRateLimitNoHeader"),
          ref,
        }),
        "warning",
      );
    } else if (status === 404 || status === 410) {
      const dead = DEAD_MODELS[modelId];
      ctx.ui.notify(
        t("respError", {
          status,
          modelId,
          dead: dead ? t("respDeadNote", { reason: dead }) : "",
          ref,
        }),
        "warning",
      );
    } else {
      ctx.ui.notify(t("respErrorPlain", { status, modelId, ref }), "warning");
    }
  });

  // ── (4) Метаданные — данными: применение/откат оверрайдов ────────────────
  pi.registerCommand("nvidia-plus-apply", {
    description: t("cmdApplyDesc"),
    handler: async (args, ctx) => {
      try {
        const force = /\bforce\b/i.test(args ?? "");
        const result = applyFiles(force);
        for (const conflict of result.conflicts) {
          ctx.ui.notify(
            t("applyConflictHead", {
              providerId: conflict.providerId,
              modelId: conflict.modelId,
              kind: conflict.kind,
              reason: conflict.reason,
            }) + (force ? t("applyConflictOverwritten") : t("applyConflictPending")),
            "warning",
          );
        }
        if (result.changed) {
          await ctx.modelRegistry.refresh({ allowNetwork: false });
          ctx.ui.notify(
            t("applyApplied", {
              overrides: result.summary.overrideIds.length,
              models: result.summary.modelIds.length,
              path: MODELS_JSON,
              ledger: STATE_FILE,
            }),
            "info",
          );
          return;
        }
        ctx.ui.notify(
          result.conflicts.length > 0 ? t("applyNothingConflicts") : t("applyUpToDate"),
          "info",
        );
      } catch (e) {
        ctx.ui.notify(t("applyFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
      }
    },
  });

  pi.registerCommand("nvidia-plus-rollback", {
    description: t("cmdRollbackDesc"),
    handler: async (_args, ctx) => {
      try {
        const result = rollbackFiles();
        if (!result.hadState) {
          ctx.ui.notify(t("rollbackNothing"), "info");
          return;
        }
        for (const k of result.kept) {
          ctx.ui.notify(
            t("rollbackKept", { providerId: k.providerId, modelId: k.modelId, kind: k.kind }),
            "warning",
          );
        }
        if (result.changed) {
          await ctx.modelRegistry.refresh({ allowNetwork: false });
          ctx.ui.notify(
            t("rollbackRemoved", { count: result.removed.length }),
            "info",
          );
          return;
        }
        ctx.ui.notify(t("rollbackClean"), "info");
      } catch (e) {
        ctx.ui.notify(t("rollbackFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
      }
    },
  });

  // ── Диагностика: что видит хук ────────────────────────────────────────────
  pi.registerCommand("nvidia-plus-status", {
    description: t("cmdStatusDesc"),
    handler: async (_args, ctx) => {
      const auto = loadState()?.enabled === false ? t("statusAutoOff") : t("statusAutoOn");
      const proxy = proxyState.configured
        ? proxyState.installError
          ? t("statusProxyInstallError", { url: proxyState.url?.toString() ?? "?", error: proxyState.installError })
          : proxyState.preflightError
            ? t("statusProxyPreflightError", { url: proxyState.url?.toString() ?? "?", error: proxyState.preflightError })
            : proxyState.installed
              ? t("statusProxyInstalled", { url: proxyState.url?.toString() ?? "?" })
              : t("statusProxyPlain", { url: proxyState.url?.toString() ?? "?" })
        : t("statusProxyNotConfigured");
      const retryState = proxyState.configured || keyPool.hasSource()
        ? transportRetryEnabled()
          ? t("statusRetryOn", { count: TRANSPORT_RETRY.maxRetries })
          : t("statusRetryOff")
        : undefined;
      const rotationState = keyPool.hasSource()
        ? t(keyRotationState.enabled ? "statusRotationOn" : "statusRotationOff", {
            source: keyPool.describe(),
            count: keyPool.refresh().length,
          })
        : t("statusRotationNoPool");
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER) {
        ctx.ui.notify(
          `pi-nvidia-plus (${auto}; ${proxy}${retryState ? `; ${retryState}` : ""}; ${rotationState}): ${t("statusNotNvidia", { model: model ? `${model.provider}/${model.id}` : "none" })}`,
          "info",
        );
        return;
      }
      const level = ctx.thinkingLevel;
      const plan = typeof level === "string" ? thinkingPlan(model.id, level) : undefined;
      ctx.ui.notify(
        `pi-nvidia-plus (${auto}; ${proxy}${retryState ? `; ${retryState}` : ""}; ${rotationState}): ${t("statusThinking", {
          modelId: model.id,
          level: level ?? "?",
          plan: plan ? t("statusInjectsPlan", { plan }) : t("statusNoInjection"),
        })}`,
        "info",
      );
    },
  });

  // ── Пул ключей NIM (тикет 15) ───────────────────────────────────────
  pi.registerCommand("nvidia-plus-keys", {
    description: t("cmdKeysDesc"),
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "off" || arg === "on") {
        keyRotationState.enabled = arg === "on";
        ctx.ui.notify(
          t("rotationToggled", { state: arg === "on" ? t("rotationToggledOn") : t("rotationToggledOff") }),
          "info",
        );
        return;
      }
      const poolKeys = keyPool.refresh();
      if (!keyPool.hasSource() && poolKeys.length === 0) {
        ctx.ui.notify(
          t("keysPoolNotSet", { file: DEFAULT_KEYS_FILE_NAME }),
          "info",
        );
        return;
      }
      const piKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER).catch(() => undefined);
      const ring = [...(piKey ? [piKey] : []), ...poolKeys.filter((k) => k !== piKey)];
      const now = Date.now();
      const rows = keyRotator.statusFor(ring, now).map((row, index) => {
        const piMark = index === 0 && piKey ? t("keysPiKeyMark") : "";
        const state =
          row.state === "dead"
            ? t("keysStateDead")
            : row.state === "cooldown"
              ? t("keysStateCooldown", { seconds: Math.max(1, Math.round(row.cooldownLeftMs / 1000)) })
              : row.active
                ? t("keysStateActive")
                : t("keysStateReady");
        return `${row.masked}${piMark} — ${state}`;
      });
      const rotation = keyRotationState.enabled ? t("rotationStateOn") : t("rotationStateOff");
      const installedHint =
        !keyRotationState.installedWithRotation && proxyState.installed
          ? t("keysInstalledWithoutRotation")
          : "";
      ctx.ui.notify(
        t("keysStatusSummary", {
          state: rotation,
          source: keyPool.describe(),
          count: poolKeys.length,
          rows: rows.join("; "),
          hint: installedHint,
        }),
        "info",
      );
    },
  });

  // ── Живое обнаружение моделей (тикет 12) ───────────────────────────────
  // Триггер — команда, а не старт сессии: обнаружение опционально и не должно
  // добавлять сетевую зависимость к каждой загрузке пи.
  pi.registerCommand("nvidia-plus-discover", {
    description: t("cmdDiscoverDesc"),
    handler: async (_args, ctx) => {
      try {
        ensureTransportInstalled();
        const headers: Record<string, string> = {};
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const res = await fetch(`${NVIDIA_ORIGIN}/v1/models`, {
          headers,
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          ctx.ui.notify(t("discoverHttpError", { status: res.status }), "error");
          return;
        }
        const live = parseModelsResponse(await res.json());
        if (live.length === 0) {
          ctx.ui.notify(t("discoverParseError"), "error");
          return;
        }
        const baseIds = ctx.modelRegistry
          .getAll()
          .filter((m) => m.provider === PROVIDER)
          .map((m) => m.id);
        const summary = classifyDiscovery(live, { baseIds, deadIds: Object.keys(DEAD_MODELS) });
        writeDiscovered({
          models: summary.newChat.map((id) => ({ id })),
          report: {
            discoveredAt: new Date().toISOString(),
            live: summary.live,
            chat: summary.chat,
            nonChat: summary.nonChat,
            missingKnown: summary.missingKnown,
          },
        });
        debug("discovery", `live=${summary.live}`, summary);

        if (summary.newChat.length > 0) {
          const result = applyFiles(false);
          if (result.changed) await ctx.modelRegistry.refresh({ allowNetwork: false });
          for (const conflict of result.conflicts) {
            ctx.ui.notify(
              t("discoverConflict", {
                providerId: conflict.providerId,
                modelId: conflict.modelId,
                kind: conflict.kind,
                reason: conflict.reason,
              }),
              "warning",
            );
          }
        }

        const added = summary.newChat.length > 0 ? t("discoverAdded", { ids: summary.newChat.join(", ") }) : "";
        const missing = summary.missingKnown.length > 0 ? t("discoverMissing", { ids: summary.missingKnown.join(", ") }) : "";
        ctx.ui.notify(
          t("discoverSummary", {
            live: summary.live,
            chat: summary.chat.length,
            nonChat: summary.nonChat.length,
            added,
            missing,
          }),
          "info",
        );
      } catch (e) {
        const cause = (e as { cause?: unknown } | null)?.cause ?? e;
        const hint =
          proxyState.configured && proxyState.url && (isProxyConnectError(e) || isProxyConnectError(cause))
            ? ` — ${describeProxyFailure(proxyState.url.toString(), cause)}`
            : "";
        ctx.ui.notify(
          t("discoverFailed", { hint, error: e instanceof Error ? e.message : String(e) }),
          "error",
        );
      }
    },
  });
}
