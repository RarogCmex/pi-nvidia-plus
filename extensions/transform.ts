/**
 * Шов B: чистая трансформация запроса — без пи и сети.
 * Вход: пейлоад, `id` модели, уровень мышления; выход: тот же пейлоад + флаг изменения.
 * Маппинги мышления верифицированы живыми пробами (исследование 03, тикет 05).
 */

export type Payload = Record<string, unknown>;

export interface TransformContext {
  modelId?: string;
  thinkingLevel?: string;
  /** Дефолт `max_tokens`, если в пейлоаде нет ни `max_tokens`, ни `max_completion_tokens`. */
  defaultMaxTokens?: number;
}

export interface TransformResult {
  payload: Payload;
  modified: boolean;
}

// ── Thinking-маппинги, верифицированные живыми пробами (исследование 03) ────
const MINIMAX_M3 = "minimaxai/minimax-m3";
const NEMOTRON_THINKING_MODELS = new Set([
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
]);

function minimaxThinkingMode(level: string): string {
  if (level === "off") return "disabled";
  if (level === "high" || level === "xhigh" || level === "max") return "enabled";
  return "adaptive"; // minimal / low / medium
}

/** Что хук инжектит для модели+уровня (для статус-строки и /nvidia-plus-status). */
export function thinkingPlan(modelId: string, level: string): string | undefined {
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

/**
 * Полная трансформация запроса: мышление по семействам → нормализация
 * контент-массивов → дефолт `max_tokens`. Мутирует и возвращает пейлоад.
 */
export function transformRequest(payload: Payload, ctx: TransformContext): TransformResult {
  let modified = false;
  if (ctx.modelId && typeof ctx.thinkingLevel === "string") {
    modified = applyThinking(payload, ctx.modelId, ctx.thinkingLevel) || modified;
  }
  modified = normalizeContentArrays(payload) || modified;
  if (payload.max_tokens == null && payload.max_completion_tokens == null) {
    payload.max_tokens = ctx.defaultMaxTokens ?? 16384;
    modified = true;
  }
  return { payload, modified };
}
