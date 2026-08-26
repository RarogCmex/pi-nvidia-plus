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
import { applyFiles, rollbackFiles, MODELS_JSON, STATE_FILE } from "./store.ts";

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

// ── Thinking-маппинги, верифицированные живыми пробами (исследование 03) ────
const MINIMAX_M3 = "minimaxai/minimax-m3";
const NEMOTRON_THINKING_MODELS = new Set([
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
]);

type Payload = Record<string, unknown>;

function minimaxThinkingMode(level: string): string {
  if (level === "off") return "disabled";
  if (level === "high" || level === "xhigh" || level === "max") return "enabled";
  return "adaptive"; // minimal / low / medium
}

/** Что хук инжектит для модели+уровня (для статус-строки и /nvidia-plus-status). */
function thinkingPlan(modelId: string, level: string): string | undefined {
  if (modelId === MINIMAX_M3) {
    return `chat_template_kwargs.thinking_mode="${minimaxThinkingMode(level)}"`;
  }
  if (NEMOTRON_THINKING_MODELS.has(modelId)) {
    if (level === "off") return "chat_template_kwargs.enable_thinking=false";
    const low = level === "minimal" || level === "low" ? ", low_effort=true" : "";
    return `chat_template_kwargs.enable_thinking=true${low}`;
  }
  return undefined;
}

function ensureChatTemplateKwargs(payload: Payload): Payload {
  let kwargs = payload.chat_template_kwargs as Payload | undefined;
  if (!kwargs || typeof kwargs !== "object") {
    kwargs = {};
    payload.chat_template_kwargs = kwargs;
  }
  return kwargs;
}

/** Инжектит thinking по семейству; возвращает, изменён ли пейлоад. */
function applyThinking(payload: Payload, modelId: string, level: string): boolean {
  if (modelId === MINIMAX_M3) {
    const kwargs = ensureChatTemplateKwargs(payload);
    const mode = minimaxThinkingMode(level);
    if (kwargs.thinking_mode === mode) return false;
    kwargs.thinking_mode = mode;
    return true;
  }
  if (NEMOTRON_THINKING_MODELS.has(modelId)) {
    const kwargs = ensureChatTemplateKwargs(payload);
    let modified = false;
    if (level === "off") {
      if (kwargs.enable_thinking !== false) {
        kwargs.enable_thinking = false;
        modified = true;
      }
      if ("low_effort" in kwargs) {
        delete kwargs.low_effort;
        modified = true;
      }
    } else {
      if (kwargs.enable_thinking !== true) {
        kwargs.enable_thinking = true;
        modified = true;
      }
      const low = level === "minimal" || level === "low";
      if (low && kwargs.low_effort !== true) {
        kwargs.low_effort = true;
        modified = true;
      } else if (!low && "low_effort" in kwargs) {
        delete kwargs.low_effort;
        modified = true;
      }
    }
    return modified;
  }
  return false;
}

/** Текстовые контент-массивы → строка (старые/мелкие NIM отвергают массивы). */
function normalizeContentArrays(payload: Payload): boolean {
  const messages = payload.messages as Array<{ content?: unknown }> | undefined;
  if (!Array.isArray(messages)) return false;
  let modified = false;
  for (const message of messages) {
    if (!message || !Array.isArray(message.content) || message.content.length === 0) continue;
    const parts = message.content as Array<{ type?: string; text?: string }>;
    if (parts.every((p) => p && p.type === "text" && typeof p.text === "string")) {
      message.content = parts.map((p) => p.text).join("\n");
      modified = true;
    }
  }
  return modified;
}

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

    let modified = false;
    const level = ctx.thinkingLevel;
    if (modelId && typeof level === "string") {
      modified = applyThinking(payload, modelId, level) || modified;
    }
    modified = normalizeContentArrays(payload) || modified;
    if (payload.max_tokens == null && payload.max_completion_tokens == null) {
      payload.max_tokens = ctx.model?.maxTokens ?? 16384;
      modified = true;
    }

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
    description: "Apply pi-nvidia-plus overrides to models.json (own ids only; ledger in nvidia-plus-models.json)",
    handler: async (_args, ctx) => {
      try {
        const result = applyFiles();
        for (const conflict of result.conflicts) {
          ctx.ui.notify(
            `pi-nvidia-plus conflict: ${conflict.providerId}/${conflict.modelId} (${conflict.kind}) — ${conflict.reason}`,
            "warning",
          );
        }
        if (!result.changed) {
          ctx.ui.notify("pi-nvidia-plus: models.json already up to date.", "info");
          return;
        }
        ctx.ui.notify(
          `pi-nvidia-plus: applied ${result.summary.overrideIds.length} modelOverrides + ${result.summary.modelIds.length} models to ${MODELS_JSON} (ledger: ${STATE_FILE}). Reopen /model to reload.`,
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
        ctx.ui.notify(
          result.changed
            ? `pi-nvidia-plus: removed ${result.removed.length} entries from models.json. Reopen /model to reload.`
            : "pi-nvidia-plus: models.json already clean.",
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`pi-nvidia-plus: rollback failed — ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // ── Диагностика: что видит хук ────────────────────────────────────────────
  pi.registerCommand("nvidia-plus-status", {
    description: "nvidia: current model, thinking level and what the hook injects",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER) {
        ctx.ui.notify(
          `pi-nvidia-plus: current model is not nvidia (${model ? `${model.provider}/${model.id}` : "none"})`,
          "info",
        );
        return;
      }
      const level = ctx.thinkingLevel;
      const plan = typeof level === "string" ? thinkingPlan(model.id, level) : undefined;
      ctx.ui.notify(
        `pi-nvidia-plus: ${model.id} · thinking ${level ?? "?"}${plan ? ` → injects ${plan}` : " · no injection for this family"}`,
        "info",
      );
    },
  });
}
