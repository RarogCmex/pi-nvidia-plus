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
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyFiles, loadState, rollbackFiles, MODELS_JSON, STATE_FILE } from "./store.ts";
import { transformRequest, thinkingPlan, type Payload } from "./transform.ts";

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
  "deepseek-ai/deepseek-v4-flash-0731": "404 in all probes",
  "google/gemma-3-4b-it": "404 in all probes",
  "google/gemma-3-12b-it": "404 in all probes",
  "mistralai/mistral-7b-instruct-v0.3": "404 in all probes",
  "moonshotai/kimi-k2.6": "404 in all probes",
  "nvidia/cosmos-reason2-8b": "404 in all probes",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1": "404 in all probes",
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

/** Строка статус-бара; `undefined` очищает ключ для не-`nvidia` моделей. */
function statusLine(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model || model.provider !== PROVIDER) return undefined;
  const level = ctx.thinkingLevel;
  const plan = typeof level === "string" ? thinkingPlan(model.id, level) : undefined;
  return `nv+ ${model.id} · thinking ${level ?? "?"}${plan ? ` → ${plan}` : " · no injection for this family"}`;
}

export default function piNvidiaPlus(pi: ExtensionAPI): void {
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
    try {
      if (loadState()?.enabled === false) return; // погашено откатом
      const result = applyFiles(false);
      if (result.changed) {
        await ctx.modelRegistry.refresh({ allowNetwork: false });
      }
      if (!ctx.hasUI) return;
      if (result.changed || factoryApplied) {
        ctx.ui.notify(
          `pi-nvidia-plus: auto-applied ${result.summary.overrideIds.length} modelOverrides + ${result.summary.modelIds.length} models (ledger: nvidia-plus-models.json)`,
          "info",
        );
      }
      factoryApplied = false;
      for (const conflict of result.conflicts) {
        ctx.ui.notify(
          `pi-nvidia-plus: skipped ${conflict.providerId}/${conflict.modelId} (${conflict.kind}) — ${conflict.reason}; run "/nvidia-plus-apply force" to overwrite`,
          "warning",
        );
      }
    } catch (e) {
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-nvidia-plus: auto-apply failed — ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    }
  });

  // ── Интерактивная статус-строка: выбор модели и смена уровня ─────────────
  pi.on("model_select", (event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("nvidia-plus", statusLine(ctx));
    if (event.model.provider !== PROVIDER) return;
    const dead = DEAD_MODELS[event.model.id];
    if (dead) {
      ctx.ui.notify(
        `⚠ ${event.model.id}: reported dead on NIM (${dead}). Requests will likely fail — you can still try, or pick another model.`,
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
    const ref = requestId ? ` · request ${requestId}` : "";
    if (status === 429) {
      const retryAfter = event.headers?.["retry-after"];
      ctx.ui.notify(
        `NIM 429 (rate limit) on ${modelId}${retryAfter ? ` · retry after ${retryAfter}` : " · no retry-after header"}${ref}`,
        "warning",
      );
    } else if (status === 404 || status === 410) {
      const dead = DEAD_MODELS[modelId];
      ctx.ui.notify(
        `NIM ${status} on ${modelId}${dead ? ` — reported dead (${dead})` : ""} · retry or pick another model${ref}`,
        "warning",
      );
    } else {
      ctx.ui.notify(`NIM ${status} on ${modelId}${ref}`, "warning");
    }
  });

  // ── (4) Метаданные — данными: применение/откат оверрайдов ────────────────
  pi.registerCommand("nvidia-plus-apply", {
    description: "Apply pi-nvidia-plus overrides to models.json (own ids only; 'force' overwrites conflicting entries)",
    handler: async (args, ctx) => {
      try {
        const force = /\bforce\b/i.test(args ?? "");
        const result = applyFiles(force);
        for (const conflict of result.conflicts) {
          ctx.ui.notify(
            `pi-nvidia-plus conflict: ${conflict.providerId}/${conflict.modelId} (${conflict.kind}) — ${conflict.reason}${force ? "; overwritten" : "; skipped, rerun with \"force\" to overwrite"}`,
            "warning",
          );
        }
        if (result.changed) {
          await ctx.modelRegistry.refresh({ allowNetwork: false });
          ctx.ui.notify(
            `pi-nvidia-plus: applied ${result.summary.overrideIds.length} modelOverrides + ${result.summary.modelIds.length} models to ${MODELS_JSON} (ledger: ${STATE_FILE}). Reopen /model to reload.`,
            "info",
          );
          return;
        }
        ctx.ui.notify(
          result.conflicts.length > 0
            ? "pi-nvidia-plus: nothing applied — all pending entries conflict (use \"force\" to overwrite)."
            : "pi-nvidia-plus: models.json already up to date.",
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`pi-nvidia-plus: apply failed — ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("nvidia-plus-rollback", {
    description: "Remove pi-nvidia-plus entries from models.json (only entries matching the ledger)",
    handler: async (_args, ctx) => {
      try {
        const result = rollbackFiles();
        if (!result.hadState) {
          ctx.ui.notify("pi-nvidia-plus: nothing to roll back (no ledger file).", "info");
          return;
        }
        for (const k of result.kept) {
          ctx.ui.notify(
            `pi-nvidia-plus: kept ${k.providerId}/${k.modelId} (${k.kind}) — edited since last apply; remove it manually if needed`,
            "warning",
          );
        }
        if (result.changed) {
          await ctx.modelRegistry.refresh({ allowNetwork: false });
          ctx.ui.notify(
            `pi-nvidia-plus: removed ${result.removed.length} entries from models.json; auto-apply disabled until next apply. Reopen /model to reload.`,
            "info",
          );
          return;
        }
        ctx.ui.notify("pi-nvidia-plus: models.json already clean; auto-apply disabled.", "info");
      } catch (e) {
        ctx.ui.notify(`pi-nvidia-plus: rollback failed — ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // ── Диагностика: что видит хук ────────────────────────────────────────────
  pi.registerCommand("nvidia-plus-status", {
    description: "nvidia: current model, thinking level and what the hook injects",
    handler: async (_args, ctx) => {
      const auto = loadState()?.enabled === false ? "auto-apply disabled" : "auto-apply on";
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER) {
        ctx.ui.notify(
          `pi-nvidia-plus (${auto}): current model is not nvidia (${model ? `${model.provider}/${model.id}` : "none"})`,
          "info",
        );
        return;
      }
      const level = ctx.thinkingLevel;
      const plan = typeof level === "string" ? thinkingPlan(model.id, level) : undefined;
      ctx.ui.notify(
        `pi-nvidia-plus (${auto}): ${model.id} · thinking ${level ?? "?"}${plan ? ` → injects ${plan}` : " · no injection for this family"}`,
        "info",
      );
    },
  });
}
