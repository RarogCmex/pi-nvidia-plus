/**
 * pi-nvidia-plus — спайк тикета 05 (архитектура D2: хук-онли, без registerProvider).
 *
 * Проверяет чек-лист `.scratch/pi-nvidia-plus/issues/05-architecture-decision.md`:
 *  1) оверрайды в формате пи (`reasoning` + `thinkingLevelMap`) проявляют уровни
 *     мышления в UI — данные в `overrides/models.json`, применяются командой
 *     `/nvidia-plus-apply`;
 *  2) `before_provider_request` реально инжектит thinking-параметры по семействам,
 *     уровень берётся из `ctx.thinkingLevel`;
 *  3) предупреждения: статическое при выборе мёртвой модели (`model_select`),
 *     динамическое после 404/410/429/5xx (`after_provider_response`);
 *  4) идемпотентное применение оверрайдов в `~/.pi/agent/models.json`, владение
 *     только своими `id`;
 *  5) все обработчики гейтятся по `provider === "nvidia"` — другие провайдеры
 *     не затрагиваются.
 *
 * Отладка: `PI_NVIDIA_PLUS_DEBUG=1` пишет финальные пейлоады в
 * `~/.pi/nvidia-plus-debug.log`.
 */
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mergeModelsJson, type ModelsJson } from "./merge-models.ts";

const PROVIDER = "nvidia";
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const OVERRIDES_FILE = join(EXT_DIR, "..", "overrides", "models.json");
const MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");
const MODELS_JSON_BACKUP = `${MODELS_JSON}.bak-pi-nvidia-plus`;
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
  "deepseek-ai/deepseek-v4-flash-0731": "404-стойкий по пробам",
  "google/gemma-3-4b-it": "404-стойкий по пробам",
  "google/gemma-3-12b-it": "404-стойкий по пробам",
  "mistralai/mistral-7b-instruct-v0.3": "404-стойкий по пробам",
  "moonshotai/kimi-k2.6": "404-стойкий по пробам",
  "nvidia/cosmos-reason2-8b": "404-стойкий по пробам",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1": "404-стойкий по пробам",
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

export default function piNvidiaPlus(pi: ExtensionAPI): void {
  // ── (2) Поведение — кодом: thinking-инжект + нормализация ────────────────
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return; // (5) другие провайдеры не трогаем
    const payload = event.payload as Payload | null;
    if (!payload || typeof payload !== "object") return;

    const modelId = typeof payload.model === "string" ? payload.model : undefined;
    debug("request-before", modelId ?? "?", payload);

    let modified = false;
    const level = ctx.thinkingLevel;
    let note: string | undefined;
    if (modelId && typeof level === "string") {
      modified = applyThinking(payload, modelId, level) || modified;
      note = thinkingPlan(modelId, level);
    }
    modified = normalizeContentArrays(payload) || modified;
    if (payload.max_tokens == null && payload.max_completion_tokens == null) {
      payload.max_tokens = ctx.model?.maxTokens ?? 16384;
      modified = true;
    }

    debug("request-after", `${modelId ?? "?"} modified=${modified}`, payload);
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "nvidia-plus",
        `nv+ ${modelId ?? "?"} · thinking ${level ?? "?"}${note ? ` → ${note}` : " · инжекта нет"}`,
      );
    }
    return modified ? payload : undefined;
  });

  // ── (3) Динамические предупреждения + диагностика 429/5xx ────────────────
  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return;
    debug("response", `${ctx.model.id} status=${event.status}`, { status: event.status, headers: event.headers });
    if (!ctx.hasUI) return;
    const { status } = event;
    if (status < 400) return;
    const modelId = ctx.model.id;
    const requestId = findRequestId(event.headers);
    const ref = requestId ? ` · request ${requestId}` : "";
    if (status === 429) {
      const retryAfter = event.headers?.["retry-after"];
      ctx.ui.notify(
        `NIM 429 (рейт-лимит) для ${modelId}${retryAfter ? ` · повтор через ${retryAfter}` : " · заголовка retry-after нет"}${ref}`,
        "warning",
      );
    } else if (status === 404 || status === 410) {
      const dead = DEAD_MODELS[modelId];
      ctx.ui.notify(
        `NIM ${status} для ${modelId}${dead ? ` — похоже, мертва (${dead})` : ""} · повторить или выбрать другую модель${ref}`,
        "warning",
      );
    } else {
      ctx.ui.notify(`NIM ${status} для ${modelId}${ref}`, "warning");
    }
  });

  // ── (3) Статическое предупреждение при выборе мёртвой модели ─────────────
  pi.on("model_select", (event, ctx) => {
    if (event.model.provider !== PROVIDER || !ctx.hasUI) return;
    const dead = DEAD_MODELS[event.model.id];
    if (dead) {
      ctx.ui.notify(
        `⚠ ${event.model.id}: похоже, мертва на NIM (${dead}). 404/429/503 — не приговор: попробуйте запрос или выберите другую модель.`,
        "warning",
      );
    }
  });

  // ── (4) Метаданные — данными: применение оверрайдов ──────────────────────
  pi.registerCommand("nvidia-plus-apply", {
    description: "Применить оверрайды pi-nvidia-plus к ~/.pi/agent/models.json (владение только своими id)",
    handler: async (_args, ctx) => {
      try {
        const source = JSON.parse(readFileSync(OVERRIDES_FILE, "utf8")) as ModelsJson;
        const foreignProviders = Object.keys(source.providers ?? {}).filter((p) => p !== PROVIDER);
        if (foreignProviders.length > 0) {
          throw new Error(`в оверрайдах чужие провайдеры: ${foreignProviders.join(", ")}`);
        }
        const target: ModelsJson = existsSync(MODELS_JSON)
          ? (JSON.parse(readFileSync(MODELS_JSON, "utf8")) as ModelsJson)
          : {};
        if (existsSync(MODELS_JSON)) copyFileSync(MODELS_JSON, MODELS_JSON_BACKUP);

        const { merged, summary } = mergeModelsJson(target, source);
        writeFileSync(MODELS_JSON, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

        ctx.ui.notify(
          `pi-nvidia-plus: оверрайды применены — modelOverrides: ${summary.overrideIds.length}, models: ${summary.modelIds.length}. Бэкап: ${MODELS_JSON_BACKUP}. Откройте /model, чтобы подхватить.`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`pi-nvidia-plus: ошибка применения — ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // ── Диагностика: что видит хук ────────────────────────────────────────────
  pi.registerCommand("nvidia-plus-status", {
    description: "nvidia: текущая модель, уровень мышления и что инжектит хук",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER) {
        ctx.ui.notify(
          `pi-nvidia-plus: текущая модель не nvidia (${model ? `${model.provider}/${model.id}` : "нет"})`,
          "info",
        );
        return;
      }
      const level = ctx.thinkingLevel;
      const plan = typeof level === "string" ? thinkingPlan(model.id, level) : undefined;
      ctx.ui.notify(
        `pi-nvidia-plus: ${model.id} · thinking ${level ?? "?"}${plan ? ` → инжект: ${plan}` : " · для этого семейства инжекта нет"}`,
        "info",
      );
    },
  });
}
