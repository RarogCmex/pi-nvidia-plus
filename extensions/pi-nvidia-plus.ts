/**
 * pi-nvidia-plus — улучшение встроенного провайдера `nvidia` на месте.
 *
 * Архитектура: хук-онли, без `registerProvider`. Авторизация, стриминг,
 * ретраи и атрибут-хедеры встроенного провайдера остаются нетронутыми;
 * расширение добавляет только то, чего встроенный не умеет.
 *
 *  1) оверрайды метаданных в формате pi (`reasoning` + `thinkingLevelMap`)
 *     проявляют уровни мышления в UI — данные в `overrides/models.json`,
 *     применяются командой `/nvidia-plus apply` и автоматически на старте сессии;
 *  2) `before_provider_request` инжектит thinking-параметры по семействам,
 *     уровень берётся из `ctx.thinkingLevel` (`transform.ts`);
 *  3) предупреждения о мёртвых моделях — статическое при выборе
 *     (`model_select`) и динамическое по коду ответа в наблюдателе диспетчера:
 *     `after_provider_response` на ошибках не стреляет, поэтому 404/410/429/5xx
 *     ловит транспортный слой;
 *  4) идемпотентное применение оверрайдов в `~/.pi/agent/models.json`, владение
 *     только своими `id`; леджер — `~/.pi/agent/nvidia-plus-models.json`;
 *  5) все обработчики гейтятся по `provider === "nvidia"`.
 *
 * Сосуществование с другими расширениями: провайдеры чужих расширений имеют
 * собственные `id` (`merge`, `tokenrouter`, …), поэтому гейты по провайдеру
 * исключают пересечение; статус-ключ `nvidia-plus` не пересекается с чужими;
 * `models.json` трогается только в провайдере `nvidia` и только по своему леджеру.
 *
 * Отладка: `PI_NVIDIA_PLUS_DEBUG=1` пишет финальные пейлоады в
 * `<agentDir>/nvidia-plus-debug.log` (каталог конфига пи: `~/.pi/agent` по
 * умолчанию, `$PI_CODING_AGENT_DIR` — если задан).
 *
 * Прокси: `NVIDIA_NIM_PROXIES[_FILE]` (легаси — одиночный `NVIDIA_NIM_PROXY`,
 * например `http://127.0.0.1:8870`) маршрутизирует только запросы к
 * `https://integrate.api.nvidia.com` через выборочный глобальный диспетчер
 * (вариант A из `research/04-proxy-mechanics.md`); остальной трафик не
 * трогается. Обёртка наблюдает ответы и показывает диагностику 429/5xx
 * (retry-after, request ID) прямо во время ретрай-пауз pi.
 *
 * Ротация ключей: пул `~/.pi/agent/nvidia-keys.json` (или `NVIDIA_NIM_KEYS[_FILE]`)
 * ставит обёртку даже без прокси; на 429 после исчерпания повторов ключ меняется,
 * на 401/403 — исключается до конца сессии; аварийные выключатели —
 * `NVIDIA_NIM_KEY_ROTATION=0` и `/nvidia-plus keys off|on`. При выключенном прозрачном
 * повторе (`NVIDIA_NIM_TRANSPORT_RETRY=0`) ротация вырождается в переключение на первый же 429.
 *
 * Наблюдаемость: прокси-интро и префлайт — только при выбранной модели `nvidia`
 * (на старте сессии или при выборе); на не-`nvidia` сессиях расширение себя не проявляет.
 */
import { appendFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentFile, applyFiles, loadState, loadDiscoveryReport, rollbackFiles, writeDiscovered, modelsJsonPath, stateFilePath } from "./store.ts";
import { transformRequest, wireThinkingPlan, thinkingPlanCaveat, type Payload } from "./transform.ts";
import { parseModelsResponse, classifyDiscovery } from "./discovery.ts";
import { KeyPool, KeyRotator, maskKey, DEFAULT_KEYS_FILE_NAME } from "./keys.ts";
import {
  DEFAULT_PROXIES_FILE_NAME,
  PROXY_CHECK_CONCURRENCY,
  PROXY_PROBE_TIMEOUT_MS,
  ProxyPool,
  ProxyRotator,
  maskProxy,
  redactProxyCredentials,
  runProxyProbes,
  type ProxyProbeAttempt,
  type ProxyProbeEndpoint,
} from "./proxy-pool.ts";
import { classifyKeyProbeStatus, keyCheckUnknownSample, type KeyCheckOutcome } from "./key-check.ts";
import { isTruncatedStreamError } from "./stream-errors.ts";
import { classifyDegenerate, toDegenerateSource, type DegenerateVerdict } from "./degenerate.ts";
import { DEAD_MODELS } from "./dead-models.ts";
import { SessionMetrics } from "./metrics.ts";
import { t } from "./i18n.ts";
import { completeArgs, formatCommandLine, nvidiaPlusArgSuggestions, nvidiaPlusCommands, setDynamicPinIds } from "./commands.ts";
import {
  parseProxyUrl,
  ensureDispatcherInstalled,
  isProxyConnectError,
  describeProxyFailure,
  describeEndpointFailure,
  formatDiagnostic,
  markDispatcher,
  NVIDIA_ORIGIN,
  getNvidiaDirectDispatcher,
  getProxyEndpointAgent,
  type NimDiagnostic,
} from "./proxy.ts";

const PROVIDER = "nvidia";
// Сессионные счётчики транспортного слоя (тикет 20): питаются из коллбэков
// диспетчера, показываются в /nvidia-plus status и /nvidia-plus keys.
const metrics = new SessionMetrics();

/** Компактная сводка метрик для команд; пустую сессию не рябит. */
function metricsSummary(): string {
  // Обрыв потока виден и без транспортного наблюдения (нет пула/прокси —
  // ответов в счётчике нет, а message_end всё равно ловит ошибку).
  if (metrics.totalResponses() === 0 && metrics.truncatedStreams === 0 && metrics.degenerateResponses === 0) {
    return t("metricsNoResponses");
  }
  const { responses, groups } = metrics.formatParts();
  const groupLabels: Record<string, string> = {
    retries: t("metricsGroupRetries", { n: metrics.retries }),
    inBandRetries: t("metricsGroupInBandRetries", { n: metrics.inBandRetries }),
    keySwitches: t("metricsGroupKeySwitches", { n: metrics.keySwitches }),
    deadKeys: t("metricsGroupDeadKeys", { n: metrics.deadKeys }),
    cooldownWaits: t("metricsGroupCooldownWaits", { n: metrics.cooldownWaits }),
    proxySwitches: t("metricsGroupProxySwitches", { n: metrics.proxySwitches }),
    truncatedStreams: t("metricsGroupTruncatedStreams", { n: metrics.truncatedStreams }),
    degenerateResponses: t("metricsGroupDegenerateResponses", { n: metrics.degenerateResponses }),
  };
  const extra = groups.length > 0 ? `; ${groups.map((g) => groupLabels[g.kind]).join("; ")}` : "";
  return t("metricsSummary", {
    total: metrics.totalResponses(),
    statuses: responses.join(", ") || "—",
    groups: extra,
  });
}
const DEBUG = process.env.PI_NVIDIA_PLUS_DEBUG === "1";
// Каталог конфига пи, а не зашитый `~/.pi`: резолвится при вызове (см. `agentFile`).
const debugLogPath = (): string => agentFile("nvidia-plus-debug.log");

// ── Мёртвые модели встроенного каталога ────────────────────────────────────
// Таблица вынесена в `dead-models.ts`: её импортируют и входная точка, и
// `scripts/discover-models.mjs` — копии уже расходились (в скрипте не было
// `starcoder` из discovery.ts, исследование 06, §2). Правила датирования,
// словарь причин и правило «значения видны пользователю» — в шапке того
// модуля и в test/dead-models.test.ts.
export { DEAD_MODELS };

function debug(stage: string, label: string, payload: unknown): void {
  if (!DEBUG) return;
  try {
    appendFileSync(
      debugLogPath(),
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
// Карантин CONNECT: одно уведомление на display identity за сессию — веер
// пи-сабагентов не должен заваливать пользователя одинаковыми ошибками.
const notifiedQuarantines = new Set<string>();
let proxyEmptyPoolNotified = false;
// Критерий приёмки №2 (ошибка запроса): наблюдатель диспетчера видит 404/410,
// которые минуют `after_provider_response`. Уведомляем один раз на модель+статус.
const notifiedDeadResponses = new Set<string>();
// Диагностика 429/5xx после повторов: не чаще раза в минуту на модель+статус,
// чтобы ретрай-цикл пи не заваливал пользователя одинаковыми предупреждениями.
const lastDiagnosticNotify = new Map<string, number>();
// Обрыв потока без finish_reason (NIM обрывает SSE на длинном thinking-выводе):
// тот же дроссель — раз в минуту на модель. pi ретраит «ended without …» сам,
// поэтому уведомление приходит только когда повторы исчерпаны; веер дочерних
// процессов pi не должен дублировать его.
const lastTruncatedNotify = new Map<string, number>();
// Дегенеративный вывод при HTTP 200 (исследование 06, §3): тот же дроссель —
// раз в минуту на модель. Отказ интермиттирующий и лечится повтором, поэтому
// уведомление — подсказка, а не диагноз каждого ответа.
const lastDegenerateNotify = new Map<string, number>();
let lastNvidiaModelId: string | undefined;
// Дроссель уведомлений о переключении ключей (тикет 25, pi-subagents).
let lastSwitchNotifyAt = 0;
let suppressedSwitchCount = 0;

// Прозрачный транспортный повтор 429/5xx: короткие рейт-лимиты и шлюзовые
// ошибки повторяются под наблюдателем, и pi с моделью их не видят.
// Темп: `maxRetries: 3` — то есть до 4 попыток на ключ — с экспоненциальным
// откатом 2 с → 30 с. Плоской задержки здесь нет; короткий нижний порог нужен
// потому, что живой NIM заголовки в 429 не отдаёт, а рейт-лимит на аккаунт
// плавает, так что опереться на retry-after нельзя.
const TRANSPORT_RETRY = { maxRetries: 3, minDelayMs: 2_000, maxDelayMs: 30_000 } as const;
// Прозрачный повтор in-band перегрузки (тикет 29): NIM отдаёт HTTP 200 с SSE-
// событием `{"error":{"message":"Service temporarily overloaded"}}` — статусные
// слои её не видят, а пи-ретрай делает ошибку видимой модели. Откат чуть
// длиннее статусного: перегрузка сервиса рассасывается медленнее бакета ключа.
const IN_BAND_RETRY = { maxRetries: 3, minDelayMs: 5_000, maxDelayMs: 30_000 } as const;
function transportRetryEnabled(): boolean {
  const raw = process.env.NVIDIA_NIM_TRANSPORT_RETRY?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

// ── Ротация ключей NIM (тикет 15) ──────────────────────────────────────────────
// Пул читается из файла/окружения (расширение его никогда не пишет); ключ пи всегда первый в кольце — его подставляет сам пи в `Authorization`.
// `defaultPath` резолвится один раз на импорте расширения: пи стартует с уже
// заданным окружением, а вот сообщения пользователю обязаны показывать путь
// живьём — поэтому ниже они строятся через `agentFile()`, а не этой константой.
const keyPool = new KeyPool({
  defaultPath: agentFile(DEFAULT_KEYS_FILE_NAME),
  env: process.env as Record<string, string | undefined>,
  onWarn: (message) => proxyState.notify?.(message, "warning"),
});
const keyRotator = new KeyRotator();
// Тикет 26: общая память о мёртвых/кулдаунах между процессами pi (дети
// pi-subagents — отдельные процессы со своим KeyRotator). Выключатель:
// NVIDIA_NIM_SHARED_ROTATION=0. Включается только при заданном пуле.
if (keyPool.hasSource() && !/^(0|false|no|off)$/i.test(process.env.NVIDIA_NIM_SHARED_ROTATION?.trim() ?? "")) {
  keyRotator.attachSharedState(agentFile("nvidia-keys-state.json"));
}
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

// ── Пул прокси NIM (spec proxy-pool) ─────────────────────────────
// Та же форма, что у пула ключей: один победивший источник (инлайн / файл /
// легаси-одиночка), горячая перезагрузка, расширение файл не пишет.
const proxyPool = new ProxyPool({
  defaultPath: agentFile(DEFAULT_PROXIES_FILE_NAME),
  env: process.env as Record<string, string | undefined>,
  onWarn: (message) => proxyState.notify?.(message, "warning"),
});
const proxyRotator = new ProxyRotator();
// Тикет 04: общая память о карантинах между процессами pi (дети pi-subagents).
// Выключатель: NVIDIA_NIM_SHARED_PROXY=0 (те же falsey-токены, что у ключей).
// Подключается только когда источник — ПУЛ (легаси-одиночка живёт как сегодня).
function proxySharedStateEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.NVIDIA_NIM_SHARED_PROXY?.trim() ?? "");
}
if (proxyPool.hasSource() && proxyPool.winningSource()?.kind !== "legacy" && proxySharedStateEnabled()) {
  proxyRotator.attachSharedState(agentFile("nvidia-proxies-state.json"));
}
const proxyRotationState = {
  enabled: (() => {
    const raw = process.env.NVIDIA_NIM_PROXY_ROTATION?.trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
  })(),
};
function proxyDirectFallbackEnabled(): boolean {
  const raw = process.env.NVIDIA_NIM_PROXY_FALLBACK_DIRECT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Пул (не легаси-одиночка) задан — ставится кольцо. */
function proxyPoolActive(): boolean {
  if (!proxyPool.hasSource()) return false;
  return proxyPool.winningSource()?.kind !== "legacy";
}

/** Display identity текущего эффективного pin (или «—»). */
function pinnedProxyDisplay(): string {
  const pin = proxyRotator.effectivePin();
  return pin ? maskProxy(pin) : t("proxyNonePinned");
}

// Представление кольца прокси — один раз и только при выбранной модели nvidia
// (тикет 16: на Claude/OpenAI-сессиях расширение молчит).
let proxyPoolIntroNotified = false;
function notifyProxyPoolIntro(ui: { notify: Notifier }): void {
  // Легаси-одиночка представляется прежним proxyIntro — кольцо только для пула.
  if (proxyPoolIntroNotified || !proxyPoolActive()) return;
  proxyPoolIntroNotified = true;
  const pool = proxyPool.refresh();
  const errors = proxyPool.parseErrors();
  if (errors.length > 0 && pool.length === 0) {
    // Опечатка/socks в источнике — не «не настроен», а видимая ошибка (тикет 18).
    ui.notify(t("proxyPoolIntroParseErrors", { source: proxyPool.describe(), errors: errors.join("; ") }), "error");
    return;
  }
  proxyRotator.setPool(pool);
  const state = proxyRotationState.enabled ? t("proxyRingStateOn") : t("proxyRingStateOff");
  ui.notify(
    t("proxyPoolIntro", { state, source: proxyPool.describe(), count: pool.length, pin: pinnedProxyDisplay() }),
    "info",
  );
  // Story 23: часть записей не разобралась (socks/опечатка) — интро называет их
  // явно, даже когда пул в целом рабочий: ошибка не должна молчать.
  if (errors.length > 0) {
    ui.notify(t("proxyPoolIntroParseErrors", { source: proxyPool.describe(), errors: errors.join("; ") }), "warning");
  }
  void preflightProxy();
}

// Прокси-интро (тикет 16) — один раз и только при выбранной модели nvidia:
// на старте сессии (если она уже стоит) или при выборе модели. На не-`nvidia`
// сессиях расширение не должно проявляться (критерий приёмки №5).
let proxyIntroNotified = false;
function notifyProxyIntro(ui: { notify: Notifier }): void {
  // Тикет 18: ошибка разбора NVIDIA_NIM_PROXY тоже проявляется здесь —
  // при ней configured сброшен, и гейт вида `configured && url` её молча
  // проглатывал. Показываем один раз и только при выбранной nvidia-модели.
  if (proxyIntroNotified) return;
  if (!proxyState.installError && !(proxyState.configured && proxyState.url)) return;
  proxyIntroNotified = true;
  if (proxyState.installError) {
    ui.notify(t("proxyNotEnabled", { error: proxyState.installError }), "error");
    return;
  }
  ui.notify(t("proxyIntro", { url: proxyState.url!.toString().replace(/\/$/, "") }), "info");
  void preflightProxy();
}

// ── Проверка пула ключей (тикет 23): `/nvidia-plus keys check` ─────────────
// Проба идёт в обход ротации/повторов, но через ТОТ ЖЕ внутренний агент, что и
// чат (`getNvidiaDirectDispatcher`): новый ProxyAgent открывает свежий TCP к
// прокси и на этой сети получает EHOSTUNREACH, пока keep-alive чата жив.
// NVCF-POLL-SECONDS намеренно не шлём: иначе 436 ключей на pro ждали бы генерацию;
// 202 Accepted без long-poll — ключ жив (см. classifyKeyProbeStatus).
type KeyCheckProbe = { outcome: KeyCheckOutcome; status?: number; error?: string };

async function probeKeyOnce(undici: any, dispatcher: unknown, modelId: string, key: string): Promise<KeyCheckProbe> {
  try {
    const res = await undici.request("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      dispatcher,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 8 }),
      headersTimeout: 20_000,
      bodyTimeout: 20_000,
    });
    await res.body.text();
    const outcome = classifyKeyProbeStatus(res.statusCode);
    if (outcome === "unknown") debug("keys-check", `ключ ${maskKey(key)} — статус ${res.statusCode}`, {});
    return { outcome, status: res.statusCode };
  } catch (e) {
    const error = String(e).slice(0, 120);
    debug("keys-check", `ключ ${maskKey(key)} — ${error}`, {});
    return { outcome: "unknown", error };
  }
}

/** Параллельность 4 — компромисс между скоростью прогрева и лимитами NIM. */
async function checkKeyPool(modelId: string, keysToCheck: string[]): Promise<Map<string, KeyCheckProbe>> {
  ensureTransportInstalled();
  const { undici, error } = resolvePiUndici();
  if (!undici) throw new Error(error ?? "undici недоступен");
  const dispatcher = getNvidiaDirectDispatcher();
  const results = new Map<string, KeyCheckProbe>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < keysToCheck.length) {
      const key = keysToCheck[cursor++];
      results.set(key, await probeKeyOnce(undici, dispatcher, modelId, key));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return results;
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
  // Пул прокси (spec proxy-pool): кольцо ставится при пул-источнике;
  // легаси-одиночка идёт прежним путём `proxyUrl` (пул из одного).
  const ringMode = proxyPoolActive();
  // Пул ключей (тикет 15): обёртка ставится и без прокси, если пул задан.
  const poolPresent = keyPool.hasSource();
  if (!ringMode && !proxyReady && !poolPresent) return; // без конфигурации поведение не меняется
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
          metrics.keySwitches++;
          debug("nvidia-rotation-switch", `${maskKey(info.from)} → ${maskKey(info.to)}`, {
            from: maskKey(info.from),
            to: maskKey(info.to),
            status: info.status,
          });
          // Тикет 25 (pi-subagents): веер детей не должен заваливать
          // пользователя — не чаще одного уведомления в 5 с, подавленные
          // переключения суммируются и доезжают в следующем видимом.
          const nowMs = Date.now();
          if (nowMs - lastSwitchNotifyAt < 5_000) {
            suppressedSwitchCount++;
            return;
          }
          const more = suppressedSwitchCount;
          suppressedSwitchCount = 0;
          lastSwitchNotifyAt = nowMs;
          proxyState.notify?.(
            t("rotationSwitch", { status: info.status, from: maskKey(info.from), to: maskKey(info.to) }) +
              (more > 0 ? t("rotationSwitchMore", { count: more }) : ""),
            "info",
          );
        },
        onDeadKey: (key: string, status: number) => {
          metrics.deadKeys++;
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
          metrics.cooldownWaits++;
          const seconds = Math.max(1, Math.round(ms / 1000));
          debug("nvidia-rotation-wait", `все ключи в кулдауне, жду ${ms} мс`, {});
          proxyState.notify?.(t("rotationCooldownWait", { seconds }), "info");
        },
        log: (stage: string, label: string, payload: unknown) => debug(stage, label, payload),
      }
    : undefined;
  // Кольцо прокси: pick один на dispatch, весь внутренний круг ключей и
  // повторов — на том же выходе (pin-инвариант). Все per-href луки разделяют
  // ОДИН key-ротатор (`rotation` выше инжектится в каждый через stackInner).
  const proxyRing = ringMode
    ? {
        rotator: proxyRotator,
        getPoolHrefs: () => proxyPool.refresh(),
        rotationEnabled: () => proxyRotationState.enabled,
        directFallbackEnabled: proxyDirectFallbackEnabled,
        onPinSwitch: (info: { from?: string; to: string }) => {
          metrics.proxySwitches++;
          debug("proxy-pin-switch", `${info.from ?? "—"} → ${info.to}`, info);
        },
        onQuarantine: (info: { display: string; cooldownMs: number; detail: string; message: string }) => {
          debug("proxy-quarantine", `${info.display} — ${info.detail}, карантин ${info.cooldownMs} мс`, {});
          proxyState.preflightError ??= info.message;
          // Не спамим на веере: одно уведомление на display за сессию (дети
          // pi-subagents headless — уведомляет только родитель).
          if (notifiedQuarantines.has(info.display)) return;
          notifiedQuarantines.add(info.display);
          proxyState.notify?.(`pi-nvidia-plus: ${info.message}`, "error");
        },
        onDirectFallback: (allowed: boolean) => {
          if (proxyEmptyPoolNotified) return;
          proxyEmptyPoolNotified = true;
          debug("proxy-direct-fallback", allowed ? "пустой пул — direct по флагу" : "пустой пул — direct запрещён", {});
          proxyState.notify?.(
            t(allowed ? "proxyPoolEmptyDirect" : "proxyPoolEmptyNoDirect"),
            allowed ? "warning" : "error",
          );
        },
      }
    : undefined;
  const result = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => undici.getGlobalDispatcher(),
      setGlobalDispatcher: (d) => undici.setGlobalDispatcher(d),
      createProxyAgent: (url: URL) => {
        // Тикет 05: socks5 обслуживает нативный Socks5ProxyAgent (ProxyAgent
        // делегирует сам, ундичи ≥ 8). На старом ундичи без него бросаем
        // понятную ошибку — кольцо карантинит выход и берёт соседа.
        if ((url.protocol === "socks5:" || url.protocol === "socks:") && !undici.Socks5ProxyAgent) {
          throw new Error(t("proxySocksUnsupported", { display: maskProxy(url) }));
        }
        return new undici.ProxyAgent(url.toString());
      },
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
      proxyUrl: !ringMode && proxyReady ? proxyState.url : undefined,
      proxyPool: proxyRing,
      rotation,
      onObserved: (status, headers) => {
        metrics.noteResponse(status);
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
              metrics.retries++;
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
      // In-band перегрузка (тикет 29): тот же выключатель — это тоже прозрачный
      // транспортный повтор, просто срабатывает на содержимое SSE, а не на статус.
      inBandRetry: transportRetryEnabled()
        ? {
            ...IN_BAND_RETRY,
            onRetryScheduled: (info) => {
              metrics.inBandRetries++;
              debug("nvidia-inband-retry", `«${info.reason}», повтор ${info.attempt}, задержка ${info.delayMs} мс`, info);
              const seconds = Math.max(1, Math.round(info.delayMs / 1000));
              proxyState.notify?.(
                t("retryScheduledInBand", {
                  reason: info.reason,
                  attempt: info.attempt,
                  total: IN_BAND_RETRY.maxRetries + 1,
                  seconds,
                }),
                "info",
              );
            },
            onExhausted: (info) => {
              debug("nvidia-inband-exhausted", `«${info.reason}», ${info.attempts} попыток`, info);
              proxyState.notify?.(
                t("retryInBandExhausted", { reason: info.reason, attempts: info.attempts }),
                "warning",
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
      ringMode ? `(кольцо прокси: ${proxyPool.describe()})` : proxyReady ? maskProxy(proxyState.url!) : "(без прокси — ротация ключей)",
      { fallback: "предыдущий глобальный диспетчер", повтор: transportRetryEnabled(), ротация: !!rotation, кольцо: ringMode },
    );
  } else {
    debug(
      "proxy-install-skip",
      ringMode ? "(кольцо прокси)" : proxyReady ? maskProxy(proxyState.url!) : "(без прокси)",
      { already: result.already },
    );
  }
}

async function preflightProxy(): Promise<void> {
  if (proxyState.preflightDone) return;
  if (proxyPoolActive()) {
    // Story 22: префлайт бьёт ТОЛЬКО pin/первый — десять жилых CONNECT-ов не
    // должны блокировать выбор модели. Любой HTTP-ответ — выход достижим.
    proxyState.preflightDone = true;
    ensureTransportInstalled();
    const pin = proxyRotator.effectivePin();
    if (!pin) return;
    const { undici } = resolvePiUndici();
    const agent = getProxyEndpointAgent(pin);
    if (!undici || !agent) return;
    const display = maskProxy(pin);
    const startedAt = Date.now();
    try {
      const res = await undici.request(`${NVIDIA_ORIGIN}/v1/models`, {
        method: "GET",
        dispatcher: agent,
        headersTimeout: PROXY_PROBE_TIMEOUT_MS,
        bodyTimeout: PROXY_PROBE_TIMEOUT_MS,
      });
      await res.body.text();
      proxyRotator.markOk(pin, Date.now() - startedAt);
    } catch (e) {
      const cause = (e as { cause?: unknown } | null)?.cause ?? e;
      if (isProxyConnectError(e) || isProxyConnectError(cause)) {
        proxyRotator.markConnectFailed(pin);
        proxyState.preflightError = describeEndpointFailure(display, cause);
        proxyState.notify?.(proxyState.preflightError, "error");
      }
    }
    return;
  }
  if (!proxyState.configured || !proxyState.url) return;
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
  const winning = proxyPool.winningSource();
  if (winning && winning.kind !== "legacy") {
    // Пул (инлайн/файл): разбираем сейчас, чтобы ошибки/предупреждения доехали
    // до интро; кольцо ставится в ensureTransportInstalled.
    const hrefs = proxyPool.refresh();
    proxyRotator.setPool(hrefs);
    proxyState.configured = true;
    debug("proxy-init", "пул прокси", {
      source: proxyPool.describe(),
      count: hrefs.length,
      displays: hrefs.map((h) => maskProxy(h)),
      errors: proxyPool.parseErrors(),
    });
    ensureTransportInstalled();
    return;
  }
  // Легаси-одиночка (или ничего): байт-в-байт как сегодня.
  const parsed = parseProxyUrl(process.env.NVIDIA_NIM_PROXY);
  // Story 39: даже в отладочном логе userinfo не показываем.
  debug("proxy-init", "разбор NVIDIA_NIM_PROXY", {
    raw: process.env.NVIDIA_NIM_PROXY ? redactProxyCredentials(process.env.NVIDIA_NIM_PROXY) : "(не задана)",
    url: parsed.url ? maskProxy(parsed.url) : undefined,
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
  // Ошибка разбора/установки показывается в notifyProxyIntro при выборе
  // nvidia-модели (тикеты 16/18): здесь, на загрузке, UI-нотификатора ещё нет.
}

/**
 * Пара «запрошенный уровень → реально ушедший в NIM» (пункт 6 исследования 06,
 * §5.4): статус-строка и `/nvidia-plus status` показывают wire-значение не только
 * для семейств хука, но и для нативного пути пи (kimi-k3, gpt-oss-20b —
 * `reasoning_effort` из применённого `thinkingLevelMap`). Метаданные берутся из
 * объекта модели, а не из копии карты — единственный источник остаётся в оверрайдах.
 */
function wirePlanFor(model: ExtensionContext["model"], level: string | undefined): string | undefined {
  if (!model || typeof level !== "string") return undefined;
  const m = model as {
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
    compat?: { supportsReasoningEffort?: boolean } | null;
  };
  return wireThinkingPlan(model.id, level, {
    reasoning: m.reasoning,
    supportsReasoningEffort: m.compat?.supportsReasoningEffort,
    thinkingLevelMap: m.thinkingLevelMap,
  });
}

/** Строка статус-бара; `undefined` очищает ключ для не-`nvidia` моделей. */
function statusLine(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model || model.provider !== PROVIDER) return undefined;
  const level = ctx.thinkingLevel;
  const plan = wirePlanFor(model, level);
  const caveatKey = thinkingPlanCaveat(model.id);
  const caveat = caveatKey ? t(caveatKey) : "";
  return `nv+ ${model.id} · thinking ${level ?? "?"}${plan ? ` → ${plan}${caveat}` : t("statusNoInjection")}`;
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
    if (ctx.hasUI) {
      proxyState.notify = (message, type) => ctx.ui.notify(message, type);
      // Третий уровень автодополнения `proxy pin <id>`: id текущего пула.
      setDynamicPinIds(proxyPinIds);
      // Tab после `/nvidia-plus ` в TUI идёт с force=true и минует
      // getArgumentCompletions (файлы вместо подкоманд). Перехват сверху.
      ctx.ui.addAutocompleteProvider((current) => ({
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
          const ours = nvidiaPlusArgSuggestions(text);
          if (ours) return ours;
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
      }));
    }
    // Пи мог пересоздать глобальный диспетчер до загрузки расширения.
    ensureTransportInstalled();
    // Прокси и ротация представляются только при выбранной модели nvidia (тикет 16).
    if (ctx.hasUI && ctx.model?.provider === PROVIDER) {
      notifyProxyPoolIntro(ctx.ui);
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
    notifyProxyPoolIntro(ctx.ui);
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

  // ── Обрыв потока без finish_reason ──────────────────────────────────────
  // NIM обрывает SSE посреди генерации (часто на длинном thinking-выводе):
  // pi-ai бросает «Stream ended without finish_reason». Пи ретраит её сам
  // (паттерн «ended without» в его каталоге), поэтому `message_end` с такой
  // ошибкой означает: повторы исчерпаны, ответ усечён. Транспортный слой тут
  // бессилен — контент уже у пи, прозрачный повтор удвоил бы вывод. Остаётся
  // наблюдаемость: счётчик в /nvidia-plus status, отладочный лог и одно
  // дросселированное уведомление с подсказкой (уровень мышления / выход прокси).
  pi.on("message_end", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return;
    if (isTruncatedStreamError(event.message)) {
      metrics.truncatedStreams++;
      const message = event.message as { errorMessage?: string };
      debug("stream-truncated", `${ctx.model.id}: ${message.errorMessage}`, {});
      if (!ctx.hasUI) return;
      const now = Date.now();
      const last = lastTruncatedNotify.get(ctx.model.id);
      if (last !== undefined && now - last < 60_000) return;
      lastTruncatedNotify.set(ctx.model.id, now);
      ctx.ui.notify(t("streamTruncated", { modelId: ctx.model.id }), "warning");
      return;
    }
    // ── Дегенеративный вывод при HTTP 200 (исследование 06, §3–4) ────────────
    // Поток не оборван, finish_reason есть, но содержимое — коллапс повторений,
    // утечка special-токена или пустой ответ при `stop`. Транспорт бессилен
    // (контент уже у пи), поэтому уровень тот же, что у обрыва: наблюдение,
    // счётчик в /nvidia-plus status, одно дросселированное уведомление.
    const source = toDegenerateSource(event.message as never);
    if (!source) return;
    const verdict: DegenerateVerdict = classifyDegenerate(source);
    if (verdict.kind === "ok") return;
    metrics.degenerateResponses++;
    debug("degenerate-response", `${ctx.model.id}: ${verdict.kind}`, verdict);
    if (!ctx.hasUI) return;
    const now = Date.now();
    const last = lastDegenerateNotify.get(ctx.model.id);
    if (last !== undefined && now - last < 60_000) return;
    lastDegenerateNotify.set(ctx.model.id, now);
    const modelId = ctx.model.id;
    if (verdict.kind === "collapse") {
      const where = t(verdict.where === "text" ? "degenerateWhereText" : "degenerateWhereThinking");
      ctx.ui.notify(t("degenerateCollapse", { modelId, where }), "warning");
    } else if (verdict.kind === "token-leak") {
      ctx.ui.notify(t("degenerateTokenLeak", { modelId, token: verdict.token }), "warning");
    } else if (verdict.kind === "empty-stop") {
      ctx.ui.notify(t("degenerateEmptyStop", { modelId }), "warning");
    } else {
      // empty-length: честная нехватка бюджета — не брак, а подсказка.
      ctx.ui.notify(t("degenerateEmptyLength", { modelId }), "info");
    }
  });

  // ── Обработчики подкоманд (тикет 24): регистрация одной командой ниже ──
  // ── (4) Метаданные — данными: применение/откат оверрайдов ────────────────
  const cmdApply = async (args: string | undefined, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) => {
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
              path: modelsJsonPath(),
              ledger: stateFilePath(),
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
  };

  const cmdRollback = async (_args: string | undefined, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) => {
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
  };

  // ── Диагностика: что видит хук ────────────────────────────────────────────
  const cmdStatus = async (_args: string | undefined, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) => {
      const auto = loadState()?.enabled === false ? t("statusAutoOff") : t("statusAutoOn");
      // Тикет 18: при битом разборе configured сброшен — показываем ошибку,
      // а не «не настроен», чтобы опечатка в переменной не молчала.
      // Story 18 (proxy-pool): заголовок называет pin и count; полное кольцо —
      // только в панели `/nvidia-plus proxy`.
      const proxy = proxyPoolActive()
        ? t(proxyState.installed ? "statusProxyPoolInstalled" : "statusProxyPool", {
            rotation: proxyRotationState.enabled ? t("proxyRingStateOn") : t("proxyRingStateOff"),
            source: proxyPool.describe(),
            count: proxyPool.refresh().length,
            pin: pinnedProxyDisplay(),
          }) +
          (proxyState.preflightError ? ` — ${proxyState.preflightError}` : "") +
          // Story 23: ошибки разбора видны и в status, не только в панели.
          (proxyPool.parseErrors().length > 0
            ? ` — ${t("proxyPanelParseErrors", { errors: proxyPool.parseErrors().join("; ") }).replace(/^; /, "")}`
            : "")
        : proxyState.configured
          ? proxyState.installError
            ? t("statusProxyInstallError", { url: proxyState.url?.toString() ?? "?", error: proxyState.installError })
            : proxyState.preflightError
              ? t("statusProxyPreflightError", { url: proxyState.url?.toString() ?? "?", error: proxyState.preflightError })
              : proxyState.installed
                ? t("statusProxyInstalled", { url: proxyState.url?.toString() ?? "?" })
                : t("statusProxyPlain", { url: proxyState.url?.toString() ?? "?" })
          : proxyState.installError
            ? t("statusProxyInstallError", { url: "?", error: proxyState.installError })
            : t("statusProxyNotConfigured");
      const retryState = proxyState.configured || keyPool.hasSource() || proxyPool.hasSource()
        ? transportRetryEnabled()
          ? t("statusRetryOn", { count: TRANSPORT_RETRY.maxRetries })
          : t("statusRetryOff")
        : undefined;
      const metricsState = metricsSummary();
      const rotationState = keyPool.hasSource()
        ? t(keyRotationState.enabled ? "statusRotationOn" : "statusRotationOff", {
            source: keyPool.describe(),
            count: keyPool.refresh().length,
          })
        : t("statusRotationNoPool");
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER) {
        ctx.ui.notify(
          `pi-nvidia-plus (${auto}; ${proxy}${retryState ? `; ${retryState}` : ""}; ${rotationState}; ${metricsState}): ${t("statusNotNvidia", { model: model ? `${model.provider}/${model.id}` : "none" })}`,
          "info",
        );
        return;
      }
      const level = ctx.thinkingLevel;
      const plan = wirePlanFor(model, level);
      const caveatKey = thinkingPlanCaveat(model.id);
      ctx.ui.notify(
        `pi-nvidia-plus (${auto}; ${proxy}${retryState ? `; ${retryState}` : ""}; ${rotationState}; ${metricsState}): ${t("statusThinking", {
          modelId: model.id,
          level: level ?? "?",
          plan: plan
            ? t("statusInjectsPlan", { plan: `${plan}${caveatKey ? t(caveatKey) : ""}` })
            : t("statusNoInjection"),
        })}`,
        "info",
      );
  };

  // ── Пул ключей NIM (тикеты 15/23) ───────────────────────────────────────
  const cmdKeys = async (args: string | undefined, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg && arg !== "check" && arg !== "off" && arg !== "on") {
        const list = (nvidiaPlusCommands().find((c) => c.name === "keys")?.args ?? [])
          .map((a) => `${a.name} — ${a.description}`)
          .join("; ");
        ctx.ui.notify(t("cmdKeysUnknown", { command: arg, list }), "info");
        return;
      }
      if (arg === "check") {
        // Тикет 23: проверка пула по текущей выбранной nvidia-модели.
        const model = ctx.model;
        if (!model || model.provider !== PROVIDER) {
          ctx.ui.notify(t("keysCheckNoModel"), "warning");
          return;
        }
        const poolKeys = keyPool.refresh();
        if (poolKeys.length === 0) {
          ctx.ui.notify(t("keysPoolNotSet", { file: agentFile(DEFAULT_KEYS_FILE_NAME) }), "info");
          return;
        }
        ctx.ui.notify(t("keysCheckStart", { count: poolKeys.length, modelId: model.id }), "info");
        const startedAt = Date.now();
        try {
          const results = await checkKeyPool(model.id, poolKeys);
          const groups: Record<KeyCheckOutcome, string[]> = { ok: [], dead: [], limited: [], unknown: [] };
          const unknownProbes: KeyCheckProbe[] = [];
          for (const [key, probe] of results) {
            groups[probe.outcome].push(key);
            if (probe.outcome === "unknown") unknownProbes.push(probe);
          }
          // Мёртвые сразу помечаем в ротаторе — сессия их больше не трогает.
          for (const key of groups.dead) keyRotator.markDead(key);
          const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          const deadList = groups.dead.length > 0 ? t("keysCheckDeadList", { ids: groups.dead.map(maskKey).join(", ") }) : "";
          const sample = keyCheckUnknownSample(unknownProbes);
          const unknownHint = sample ? t("keysCheckUnknownHint", { sample }) : "";
          ctx.ui.notify(
            t("keysCheckSummary", {
              modelId: model.id,
              seconds,
              ok: groups.ok.length,
              dead: groups.dead.length,
              limited: groups.limited.length,
              unknown: groups.unknown.length,
              deadList,
              unknownHint,
            }),
            groups.dead.length > 0 || (groups.unknown.length > 0 && groups.ok.length === 0) ? "warning" : "info",
          );
        } catch (e) {
          ctx.ui.notify(t("keysCheckFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
        }
        return;
      }
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
          t("keysPoolNotSet", { file: agentFile(DEFAULT_KEYS_FILE_NAME) }),
          "info",
        );
        return;
      }
      const piKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER).catch(() => undefined);
      const ring = [...(piKey ? [piKey] : []), ...poolKeys.filter((k) => k !== piKey)];
      const now = Date.now();
      // Кулдауны — на пару (ключ, модель): показываем состояние для текущей модели.
      const displayModel = ctx.model?.provider === PROVIDER ? ctx.model.id : undefined;
      const rows = keyRotator.statusFor(ring, now, displayModel).map((row, index) => {
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
          rows: rows.join("; ") + (rows.length > 0 ? "; " : ""),
          hint: installedHint ? `${installedHint}; ${metricsSummary()}` : metricsSummary(),
        }),
        "info",
      );
  };

  // ── Пул прокси NIM (spec proxy-pool): `/nvidia-plus proxy …` ────────
  // TUI-панель настроек (сестра `keys`): файл пула остаётся пользовательским,
  // глаголы мутируют только состояние сессии (pin, кольцо, побочный эффект check).
  const proxyPanelText = (): string => {
    const pool = proxyPool.refresh();
    proxyRotator.setPool(pool);
    if (!proxyPool.hasSource() && pool.length === 0) {
      return t("proxyPoolNotSet", { file: agentFile(DEFAULT_PROXIES_FILE_NAME) });
    }
    const now = Date.now();
    const errors = proxyPool.parseErrors();
    if (pool.length === 0 && errors.length > 0) {
      // Ошибка разбора — не «не настроен» (тикет 18): показываем её явно.
      return t("proxyPoolIntroParseErrors", { source: proxyPool.describe(), errors: errors.join("; ") });
    }
    const statuses = proxyRotator.statusFor(now);
    const rows = statuses.map((row) => {
      const state =
        row.state === "cooldown"
          ? t("proxyRowCooldown", { seconds: Math.max(1, Math.round(row.cooldownLeftMs / 1000)) })
          : t("proxyRowReady");
      const pinnedMark = row.pinned ? t("proxyRowPinnedMark") : "";
      const latency = row.lastLatencyMs !== undefined ? t("proxyRowLatency", { ms: row.lastLatencyMs }) : "";
      return `${row.display}${pinnedMark} — ${state}${latency}`;
    });
    const pin = proxyRotator.effectivePin();
    const pinLatency = statuses.find((s) => s.pinned)?.lastLatencyMs;
    const edit = t("proxyPanelEdit", { source: proxyPool.describe() });
    const metricsPart = metrics.proxySwitches > 0 ? t("proxyPanelMetrics", { n: metrics.proxySwitches }) : "";
    const parsePart = errors.length > 0 ? t("proxyPanelParseErrors", { errors: errors.join("; ") }) : "";
    const state = proxyRotationState.enabled ? t("proxyRingStateOn") : t("proxyRingStateOff");
    return t("proxyPanelSummary", {
      state,
      source: proxyPool.describe(),
      count: pool.length,
      pin: pin ? maskProxy(pin) : t("proxyNonePinned"),
      pinLatency: pinLatency !== undefined ? t("proxyRowLatency", { ms: pinLatency }) : "",
      rows: rows.length > 0 ? rows.join("; ") : t("proxyPanelEmptyRows"),
      edit,
      metrics: metricsPart,
      parseErrors: parsePart,
    });
  };

  /** Display identity пула для автодополнения `proxy pin <id>`. */
  const proxyPinIds = (): Array<{ id: string; description: string }> => {
    const pool = proxyPool.refresh();
    proxyRotator.setPool(pool);
    const now = Date.now();
    return proxyRotator.statusFor(now).map((row) => ({
      id: row.display,
      description:
        row.state === "cooldown"
          ? t("proxyRowCooldown", { seconds: Math.max(1, Math.round(row.cooldownLeftMs / 1000)) })
          : t("proxyRowReady"),
    }));
  };

  /** Одна проба `proxy check`: GET /v1/models через агент конкретного выхода. */
  const probeProxyEndpoint = async (
    undici: { request: (url: string, init: unknown) => Promise<{ statusCode: number; body: { text(): Promise<string> } }> },
    endpoint: ProxyProbeEndpoint,
  ): Promise<ProxyProbeAttempt> => {
    try {
      const agent = getProxyEndpointAgent(endpoint.href);
      if (!agent) return { error: new Error("no agent") };
      const res = await undici.request(`${NVIDIA_ORIGIN}/v1/models`, {
        method: "GET",
        dispatcher: agent,
        headersTimeout: PROXY_PROBE_TIMEOUT_MS,
        bodyTimeout: PROXY_PROBE_TIMEOUT_MS,
      });
      await res.body.text();
      // Любой HTTP-ответ — выход достижим (story 13: проба про выход, не про auth).
      return { status: res.statusCode };
    } catch (e) {
      return { error: e };
    }
  };

  const cmdProxy = async (args: string | undefined, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) => {
    const trimmed = (args ?? "").trim();
    const [verb, ...verbRest] = trimmed.split(/\s+/).filter(Boolean);
    if (verb && verb !== "check" && verb !== "pin" && verb !== "on" && verb !== "off") {
      // Story 20: неизвестный аргумент — список глаголов, а не молчаливая панель.
      const list = (nvidiaPlusCommands().find((c) => c.name === "proxy")?.args ?? [])
        .map((a) => `${a.name.trimEnd()} — ${a.description}`)
        .join("; ");
      ctx.ui.notify(t("cmdProxyUnknown", { command: verb, list }), "info");
      return;
    }
    if (verb === "on" || verb === "off") {
      proxyRotationState.enabled = verb === "on";
      ctx.ui.notify(
        t("proxyRotationToggled", {
          state: verb === "on" ? t("proxyRotationToggledOn") : t("proxyRotationToggledOff"),
        }),
        "info",
      );
      return;
    }
    if (verb === "pin") {
      const ids = proxyPinIds();
      if (ids.length === 0) {
        ctx.ui.notify(t("proxyPoolNotSet", { file: agentFile(DEFAULT_PROXIES_FILE_NAME) }), "info");
        return;
      }
      const id = verbRest.join(" ").trim();
      if (!id) {
        // Story 55: без id — usage + список id (info, не молчаливая панель).
        ctx.ui.notify(t("proxyPinUsage", { ids: ids.map((entry) => entry.id).join(", ") }), "info");
        return;
      }
      if (!proxyRotator.pinByDisplay(id)) {
        ctx.ui.notify(t("proxyPinUnknown", { command: id, ids: ids.map((entry) => entry.id).join(", ") }), "info");
        return;
      }
      ctx.ui.notify(t("proxyPinnedSet", { display: id }), "info");
      return;
    }
    if (verb === "check") {
      // Story 15: без выбранной nvidia-модели — явный отказ (на других провайдерах молчим).
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER) {
        ctx.ui.notify(t("proxyCheckNoModel"), "warning");
        return;
      }
      const pool = proxyPool.refresh();
      proxyRotator.setPool(pool);
      if (pool.length === 0) {
        const errors = proxyPool.parseErrors();
        ctx.ui.notify(
          errors.length > 0
            ? t("proxyPoolIntroParseErrors", { source: proxyPool.describe(), errors: errors.join("; ") })
            : t("proxyPoolNotSet", { file: agentFile(DEFAULT_PROXIES_FILE_NAME) }),
          "info",
        );
        return;
      }
      ensureTransportInstalled();
      const { undici, error } = resolvePiUndici();
      if (!undici) {
        ctx.ui.notify(t("proxyCheckFailed", { error: error ?? "undici" }), "error");
        return;
      }
      ctx.ui.notify(t("proxyCheckStart", { count: pool.length }), "info");
      const startedAt = Date.now();
      // Story 51: Esc во время check останавливает ХВОСТ проб (сводка — по уже
      // полученным). Перехват терминального ввода только на время прогона.
      const abortCtl = new AbortController();
      let offTerminal: (() => void) | undefined;
      const terminalInput = ctx.ui.onTerminalInput as ((handler: (data: string) => { consume?: boolean } | undefined) => () => void) | undefined;
      if (typeof terminalInput === "function") {
        offTerminal = terminalInput.call(ctx.ui, (data: string) => {
          if (data === "\x1b") {
            abortCtl.abort();
            return { consume: true };
          }
          return undefined;
        });
      }
      try {
        const endpoints: ProxyProbeEndpoint[] = pool.map((href) => ({ href, display: maskProxy(href) }));
        const plan = await runProxyProbes(
          endpoints,
          (endpoint) => probeProxyEndpoint(undici, endpoint),
          { concurrency: PROXY_CHECK_CONCURRENCY, isAborted: () => abortCtl.signal.aborted },
        );
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const counts = { ok: 0, unreachable: 0, unknown: 0 };
        for (const row of plan.rows) counts[row.outcome] += 1;
        const okRows = plan.rows
          .filter((row) => row.outcome === "ok")
          .map((row) => t("proxyCheckOkRow", { display: row.display, ms: row.latencyMs ?? 0 }))
          .join("");
        // Story 14 + исходы проб в состояние сессии — одной операцией шва
        // (applyProbeResults): ok пишет exit quality и гасит карантин,
        // unreachable карантинит (TTL), самый быстрый ok становится pin.
        const pinnedDisplay = proxyRotator.applyProbeResults(plan.rows);
        const pinNote = pinnedDisplay
          ? t("proxyCheckPinNote", { display: pinnedDisplay })
          : t("proxyCheckNoOk", { pin: pinnedProxyDisplay() });
        const abortedNote = plan.aborted ? t("proxyCheckAborted", { skipped: plan.skipped }) : "";
        ctx.ui.notify(
          t("proxyCheckSummary", {
            seconds,
            ok: counts.ok,
            unreachable: counts.unreachable,
            unknown: counts.unknown,
            okRows,
            pinNote,
            abortedNote,
          }),
          counts.ok === 0 ? "warning" : "info",
        );
      } catch (e) {
        ctx.ui.notify(t("proxyCheckFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
      } finally {
        offTerminal?.();
      }
      return;
    }
    // Пустые аргументы — панель настроек (story 53).
    ctx.ui.notify(proxyPanelText(), "info");
  };

  // ── Живое обнаружение моделей (тикет 12) ───────────────────────────────
  // Триггер — команда, а не старт сессии: обнаружение опционально и не должно
  // добавлять сетевую зависимость к каждой загрузке пи.
  const cmdDiscover = async (_args: string | undefined, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) => {
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
        const pinHref = proxyPoolActive() ? proxyRotator.effectivePin() : undefined;
        const hint =
          pinHref && (isProxyConnectError(e) || isProxyConnectError(cause))
            ? ` — ${describeEndpointFailure(maskProxy(pinHref), cause)}`
            : proxyState.configured && proxyState.url && (isProxyConnectError(e) || isProxyConnectError(cause))
              ? ` — ${describeProxyFailure(proxyState.url.toString(), cause)}`
              : "";
        ctx.ui.notify(
          t("discoverFailed", { hint, error: e instanceof Error ? e.message : String(e) }),
          "error",
        );
      }
  };

  // ── Одна команда с подкомандами (тикеты 24/27): меню не загромождается ──
  type CmdCtx = Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1];
  const runners: Record<string, (args: string | undefined, ctx: CmdCtx) => Promise<void>> = {
    apply: cmdApply,
    rollback: cmdRollback,
    status: cmdStatus,
    keys: cmdKeys,
    proxy: cmdProxy,
    discover: cmdDiscover,
  };

  pi.registerCommand("nvidia-plus", {
    description: t("cmdRootDesc"),
    getArgumentCompletions: (prefix: string) => completeArgs(prefix, nvidiaPlusCommands()),
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const [sub, ...rest] = trimmed.split(/\s+/).filter(Boolean);
      const run = sub ? runners[sub] : undefined;
      if (!run) {
        const list = nvidiaPlusCommands().map(formatCommandLine).join("; ");
        ctx.ui.notify(
          t(sub ? "cmdUnknown" : "cmdUsage", { command: sub ?? "", list }),
          "info",
        );
        return;
      }
      await run(rest.join(" "), ctx);
    },
  });
}
