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
  // Живые пробы 2026-08-30: chat_template_kwargs.enable_thinking, low_effort и
  // top-level reasoning_effort/reasoning_budget принимаются; `enable_thinking`
  // вне chat_template_kwargs отвергается 400.
  // Этот id с тех пор в DEAD_MODELS (410 на пробах 2026-09-18), но маппинг
  // оставлен намеренно: список мёртвых — точка во времени, и если NIM вернёт
  // id или выпустит суффиксную версию того же семейства, запрос должен уйти
  // с правильными параметрами. Предупреждение о смерти показывает DEAD_MODELS,
  // не этот набор.
  "nvidia/nemotron-3-nano-30b-a3b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
]);

// Gemma 4 (тикет 19): в режиме мышления модель виснет — ответ не приходит
// за 120 с (headers timeout) при любом plain/effort/enable_thinking=true;
// с chat_template_kwargs.enable_thinking=false отвечает за ~2 с. Поэтому
// мышление выключается насильно на любом уровне — иначе модель непригодна.
const GEMMA4 = /^google\/gemma-4/;

// ── Гипотезы из референсов ────────────────────────────────────────────────
// Источник — `pi-extension-nvidia-nim@1.5.1` (npm, MIT; `handlers/thinking.ts`,
// `config/model-families.ts`), разбор — research/05-reference-plugins.md.
// DeepSeek V4 проверена живыми пробами 2026-08-28 на
// `deepseek-ai/deepseek-v4-pro-0813` (thinking=false гасит reasoning_content,
// thinking=true + reasoning_effort low/high/max дают его); GLM остаётся гипотезой.
const DEEPSEEK_V4 = /^deepseek-ai\/deepseek-v4/;
const GLM = /^z-ai\/glm/;

// Намеренно НЕ обрабатываются здесь (нативный путь пи, а не хук):
//  - `openai/gpt-oss-20b` и `moonshotai/kimi-k3` принимают стандартный top-level
//    `reasoning_effort`, поэтому управляются метаданными в `overrides/models.json`
//    (`compat.supportsReasoningEffort: true` + `thinkingLevelMap`), а не кодом.
//    Для kimi это единственно рабочий путь: его встроенная карта была инертной
//    (`supportsReasoningEffort:false`, без `thinkingFormat`), пи не слал ничего,
//    и модель рассуждала неограниченно (живые пробы 2026-10-05 — исследование 07).
//    NIM принимает только `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`
//    (`off`→HTTP 400), поэтому `off` маппится в `none`. Не добавляйте kimi-хендлер
//    сюда и не «чините» его карту в `off`/`on` — это вернуло бы 400.

function minimaxThinkingMode(level: string): string {
  if (level === "off") return "disabled";
  if (level === "high" || level === "xhigh" || level === "max") return "enabled";
  return "adaptive"; // minimal / low / medium
}

/**
 * Что хук инжектит для модели+уровня (для статус-строки и /nvidia-plus status).
 *
 * Возвращает **только** wire-параметры, без пояснений: строка уходит в UI, а
 * модуль остаётся чистым швом без pi и без локали. Пояснение — отдельный ключ
 * `thinkingPlanCaveat`, который переводит i18n-слой.
 */
export function thinkingPlan(modelId: string, level: string): string | undefined {
  if (GEMMA4.test(modelId)) {
    return "chat_template_kwargs.enable_thinking=false";
  }
  if (modelId === MINIMAX_M3) {
    return `chat_template_kwargs.thinking_mode="${minimaxThinkingMode(level)}"`;
  }
  if (NEMOTRON_THINKING_MODELS.has(modelId)) {
    if (level === "off") return "chat_template_kwargs.enable_thinking=false";
    const low = level === "minimal" || level === "low" ? ", low_effort=true" : "";
    return `chat_template_kwargs.enable_thinking=true${low}`;
  }
  if (DEEPSEEK_V4.test(modelId)) {
    return level === "off"
      ? "chat_template_kwargs.thinking=false"
      : "chat_template_kwargs.thinking=true, reasoning_effort";
  }
  if (GLM.test(modelId)) {
    if (level === "off") return "chat_template_kwargs.enable_thinking=false, clear_thinking=true";
    const effort = level === "minimal" ? "" : `, reasoning_effort=${level === "xhigh" || level === "max" ? "max" : "high"}`;
    return `chat_template_kwargs.enable_thinking=true, clear_thinking=false${effort}`;
  }
  return undefined;
}

/**
 * Ключ i18n-сообщения с оговоркой к плану инжекта, если для модели она есть.
 * Ключи стабильны и перечислены в `extensions/i18n.ts` (`planCaveat*`); здесь
 * намеренно нет готового текста, чтобы `PI_NVIDIA_PLUS_LANG=en` не получал
 * русскую строку.
 */
export function thinkingPlanCaveat(modelId: string): "planCaveatGemma4Hangs" | undefined {
  if (GEMMA4.test(modelId)) return "planCaveatGemma4Hangs";
  return undefined;
}

/**
 * Метаданные модели, нужные, чтобы предсказать нативный `reasoning_effort` пи
 * (путь `supportsReasoningEffort` в pi-ai `openai-completions`). Берутся из
 * объекта модели в точке входа — то есть из уже применённых оверрайдов, а не из
 * захардкоженной копии (иначе карта в коде и в `overrides/models.json` разошлись
 * бы — ровно тот дрейф, от которого лечит единый источник).
 */
export interface NativeEffortMeta {
  supportsReasoningEffort?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

/**
 * Какое top-level `reasoning_effort` пи сам (без нашего хука) положит в запрос
 * для модели с `compat.supportsReasoningEffort` на данном уровне. Зеркалит две
 * ветки pi-ai `openai-completions`:
 *  - уровень `off` → пи шлёт `thinkingLevelMap.off`, если это строка; `null`/нет
 *    → поле НЕ уходит (`undefined`);
 *  - прочий уровень → `thinkingLevelMap[level] ?? level` (pi: `?? level`, поэтому
 *    отсутствующее/`null`-значение даёт имя уровня).
 *
 * Только для нативного пути; семейства, которые ведёт `transform.ts`, описывает
 * `thinkingPlan`. Возвращает `undefined`, когда `supportsReasoningEffort` выключен
 * (модель не на нативном пути — вызывающий код решает, что показывать).
 */
export function nativeReasoningEffort(level: string, meta: NativeEffortMeta): string | undefined {
  if (!meta.supportsReasoningEffort) return undefined;
  const map = meta.thinkingLevelMap ?? {};
  if (level === "off") {
    const off = map.off;
    return typeof off === "string" ? off : undefined; // null/нет → поле не уходит
  }
  const mapped = map[level];
  return typeof mapped === "string" ? mapped : level; // null/нет → имя уровня (pi: ?? level)
}

/**
 * План «что реально уходит в NIM» для статус-строки и `/nvidia-plus status`
 * (пункт 6 исследования 06, §5.4): пара «запрошенный уровень → wire-значение».
 * Сначала семейства хука (`thinkingPlan`), затем нативный путь пи
 * (`nativeReasoningEffort`) — так kimi-k3/gpt-oss-20b показывают настоящий
 * `reasoning_effort`, а не «нет инжекта». Возвращает machine-строку (wire-параметр,
 * не переводится — как остальные планы); `undefined` — нечего показать.
 */
export function wireThinkingPlan(
  modelId: string,
  level: string,
  meta: { reasoning?: boolean } & NativeEffortMeta,
): string | undefined {
  const hooked = thinkingPlan(modelId, level);
  if (hooked) return hooked;
  if (meta.reasoning && meta.supportsReasoningEffort) {
    const effort = nativeReasoningEffort(level, meta);
    return effort === undefined ? "reasoning_effort omitted" : `reasoning_effort="${effort}"`;
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
  if (GEMMA4.test(modelId)) {
    const kwargs = ensureChatTemplateKwargs(payload);
    if (kwargs.enable_thinking === false) return false;
    kwargs.enable_thinking = false;
    delete kwargs.low_effort;
    return true;
  }
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

/**
 * DeepSeek V4: пи шлёт `thinking` и `reasoning_effort` top-level, NIM требует их в
 * `chat_template_kwargs`. Преобразование по референс-хендлеру "deepseek-v4".
 * Проверено живыми пробами 2026-08-28 на `deepseek-ai/deepseek-v4-pro-0813`:
 * `thinking=false` — 200 без reasoning_content; `thinking=true` + `reasoning_effort`
 * low/high/max — 200, reasoning_content появляется и растёт с усилием.
 */
function applyDeepSeekV4Thinking(payload: Payload, level: string): boolean {
  const kwargs = ensureChatTemplateKwargs(payload);
  const on = level !== "off";
  let modified = false;
  if (kwargs.thinking !== on) {
    kwargs.thinking = on;
    modified = true;
  }
  if (on) {
    const effort = typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : "high";
    if (kwargs.reasoning_effort !== effort) {
      kwargs.reasoning_effort = effort;
      modified = true;
    }
  } else if ("reasoning_effort" in kwargs) {
    delete kwargs.reasoning_effort;
    modified = true;
  }
  if ("thinking" in payload) {
    delete payload.thinking;
    modified = true;
  }
  if ("reasoning_effort" in payload) {
    delete payload.reasoning_effort;
    modified = true;
  }
  return modified;
}

/**
 * GLM (гипотеза из референсов, живых моделей нет — не проверена): пи в формате
 * `zai` шлёт объект `thinking` + `reasoning_effort`; GLM на NIM требует
 * `enable_thinking`/`clear_thinking` в `chat_template_kwargs` и отображённое
 * усилие top-level (референс-хендлер "qwen-chat-template" для `z-ai/glm`).
 */
function applyGlmThinking(payload: Payload, level: string): boolean {
  const kwargs = ensureChatTemplateKwargs(payload);
  const on = level !== "off";
  let modified = false;
  if (kwargs.enable_thinking !== on) {
    kwargs.enable_thinking = on;
    modified = true;
  }
  const clear = !on;
  if (kwargs.clear_thinking !== clear) {
    kwargs.clear_thinking = clear;
    modified = true;
  }
  if ("preserve_thinking" in kwargs) {
    delete kwargs.preserve_thinking;
    modified = true;
  }
  const effort = on
    ? level === "xhigh" || level === "max"
      ? "max"
      : level === "minimal"
        ? undefined
        : "high"
    : undefined;
  if (effort === undefined) {
    if ("reasoning_effort" in payload) {
      delete payload.reasoning_effort;
      modified = true;
    }
  } else if (payload.reasoning_effort !== effort) {
    payload.reasoning_effort = effort;
    modified = true;
  }
  if ("thinking" in payload) {
    delete payload.thinking;
    modified = true;
  }
  return modified;
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
  // Gemma 4 гасим даже без выбранного уровня: пи не присылает thinkingLevel
  // для моделей без reasoning-флага, а она без enable_thinking=false виснет.
  const level = ctx.thinkingLevel ?? (ctx.modelId && GEMMA4.test(ctx.modelId) ? "off" : undefined);
  if (ctx.modelId && typeof level === "string") {
    if (DEEPSEEK_V4.test(ctx.modelId)) {
      modified = applyDeepSeekV4Thinking(payload, level) || modified;
    } else if (GLM.test(ctx.modelId)) {
      modified = applyGlmThinking(payload, level) || modified;
    } else {
      modified = applyThinking(payload, ctx.modelId, level) || modified;
    }
  }
  modified = normalizeContentArrays(payload) || modified;
  if (payload.max_tokens == null && payload.max_completion_tokens == null) {
    payload.max_tokens = ctx.defaultMaxTokens ?? 16384;
    modified = true;
  }
  return { payload, modified };
}
