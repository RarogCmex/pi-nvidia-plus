/**
 * Живое обнаружение моделей NIM (тикет 12): чистый разбор `GET /v1/models`,
 * фильтр не-чат моделей и классификация против известного каталога.
 * Сетевые запросы и запись оверрайдов — во входной точке и файловом слое.
 */

export interface LiveModel {
  id: string;
  ownedBy?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Разбор ответа `GET /v1/models`: OpenAI-форма `{data: [...]}`, `{models: [...]}`
 * или голый массив. Записи без `id` пропускаются, дубликаты схлопываются.
 * Любой мусор даёт пустой список без исключений.
 */
export function parseModelsResponse(payload: unknown): LiveModel[] {
  let items: unknown;
  if (Array.isArray(payload)) {
    items = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) items = payload.data;
    else if (Array.isArray(payload.models)) items = payload.models;
  }
  if (!Array.isArray(items)) return [];

  const seen = new Set<string>();
  const out: LiveModel[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (typeof id !== "string" || id.trim().length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      ownedBy: typeof item.owned_by === "string" ? item.owned_by : undefined,
    });
  }
  return out;
}

/**
 * Признаки не-чат моделей: эмбеддинги, ретрайверы/реранкеры, reward-модели,
 * защитные классификаторы (guard/безопасность), перевод, парсинг, детекторы,
 * калибровка, утилиты зрения (deplot), генерация изображений/речь.
 * Список консервативный: отсеивается только явно не-чат.
 */
const NON_CHAT_PATTERNS: RegExp[] = [
  /embed/i,
  /rerank/i,
  /\breward\b/i,
  /guard/i,
  /content-safety/i,
  /topic-control/i,
  /translate/i,
  /\bparse(r)?\b/i,
  /detector/i,
  /calibration/i,
  /\bdeplot\b/i,
  /\bocr\b/i,
  /clip/i,
  /\b(tts|asr|whisper|speech)\b/i,
  /(stable-?diffusion|sdxl|\bflux\b|dall-?e|imagen|image-?gen)/i,
];

export function isChatModel(id: string): boolean {
  return !NON_CHAT_PATTERNS.some((pattern) => pattern.test(id));
}

export interface DiscoverySummary {
  /** Всего моделей в живом списке. */
  live: number;
  /** Живые чат-модели. */
  chat: string[];
  /** Живые не-чат модели (отсеяны). */
  nonChat: string[];
  /** Живые чат-модели, которых нет в известном каталоге и в списке мёртвых. */
  newChat: string[];
  /** Известные (базовые) модели, отсутствующие в живом списке и не помеченные мёртвыми. */
  missingKnown: string[];
}

export interface KnownCatalog {
  /** Модели, уже известные пи (база + добавленные оверрайдами). */
  baseIds: Iterable<string>;
  /** Помеченные мёртвыми (статический список и прежние обнаружения). */
  deadIds: Iterable<string>;
}

/** Классификация живого списка против известного каталога. */
export function classifyDiscovery(live: LiveModel[], known: KnownCatalog): DiscoverySummary {
  const base = new Set(known.baseIds);
  const dead = new Set(known.deadIds);

  const chat: string[] = [];
  const nonChat: string[] = [];
  const newChat: string[] = [];
  const liveIds = new Set<string>();

  for (const model of live) {
    liveIds.add(model.id);
    if (!isChatModel(model.id)) {
      nonChat.push(model.id);
      continue;
    }
    chat.push(model.id);
    if (!base.has(model.id) && !dead.has(model.id)) newChat.push(model.id);
  }

  const missingKnown: string[] = [];
  for (const id of base) {
    if (!liveIds.has(id) && !dead.has(id)) missingKnown.push(id);
  }

  return { live: live.length, chat, nonChat, newChat, missingKnown };
}
