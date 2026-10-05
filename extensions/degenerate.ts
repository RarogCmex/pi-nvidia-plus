/**
 * Шов: классификация дегенеративного вывода при HTTP 200 (исследование 06, §3–4).
 *
 * NIM может вернуть успешный ответ — HTTP 200, `finish_reason` присутствует,
 * `usage` корректен, — в котором испорчено само содержимое: коллапс повторений
 * (`42424242…`, `The!!!!…`), утечка special-токена (`<|close|>`) или пустой
 * `content` при `finish_reason: stop` (дегенерация reasoning-канала).
 * `stream-errors.ts` этот класс не ловит: поток не обрывается.
 *
 * Транспортный уровень бессилен так же, как при обрыве потока: контент уже
 * стримится в пи, прозрачный повтор продублировал бы вывод. Правильный уровень
 * — `message_end`: наблюдение, метрика, уведомление с подсказкой.
 *
 * Важное различение (исследование 06, §4): пустой ответ при `finish_reason:
 * length` — это честно съеденный рассуждением бюджет (лечится увеличением
 * `max_tokens`), а пустой ответ при `finish_reason: stop` — дегенерация
 * (лечится повтором запроса; увеличение `max_tokens` не помогает).
 *
 * Наивный детектор «доля самого частого n-грамма» НЕ РАБОТАЕТ: на реальном
 * коллапсе `42` × 2000 граммы делятся поровну между `42` и `24`, доля
 * топ-грамма ровно 0.50 при любом n (измерено). Рабочий набор — три признака:
 * сжимаемость (zlib), доля одного символа, утечка special-токена.
 *
 * Модуль — чистый классификатор без пи и сети, ядро юнит-тестов.
 */
import { deflateSync } from "node:zlib";

/** Сообщение в форме `message_end` (утяжелённые поля не важны). */
export interface AssistantMessageLike {
  role?: string;
  stopReason?: string;
  content?: Array<{ type?: string; text?: string; thinking?: string }>;
}

/** Тексты ответа, извлечённые из блоков контента. */
export interface DegenerateSource {
  /** Соединённый текст блоков `text`. */
  text: string;
  /** Соединённый текст блоков `thinking` (reasoning-канал). */
  thinking: string;
  /** Есть ли блоки вызовов инструментов (пустой текст при них — норма). */
  hasToolCalls: boolean;
  stopReason?: string;
}

export type DegenerateVerdict =
  | { kind: "ok" }
  /** Коллапс повторений (периодический или односимвольный). */
  | { kind: "collapse"; where: "text" | "thinking" }
  /** Утечка special-токена — признак сломанного chat-template на сервере. */
  | { kind: "token-leak"; where: "text" | "thinking"; token: string }
  /** Пустой ответ при `stop`: дегенерация reasoning-канала, лечится повтором. */
  | { kind: "empty-stop" }
  /** Пустой ответ при `length`: бюджет съеден рассуждением, лечится max_tokens. */
  | { kind: "empty-length" };

/** Извлечение текстов из сообщения пи; не-assistant сообщения дают `undefined`. */
export function toDegenerateSource(message: AssistantMessageLike | undefined | null): DegenerateSource | undefined {
  if (!message || message.role !== "assistant") return undefined;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  let hasToolCalls = false;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") thinkingParts.push(block.thinking);
    else if (block.type === "toolCall") hasToolCalls = true;
  }
  return {
    text: textParts.join("\n"),
    thinking: thinkingParts.join("\n"),
    hasToolCalls,
    stopReason: message.stopReason,
  };
}

/**
 * Калибровка порогов — на живых корпусах (исследование 06, §4):
 * связная проза 0.413, сгенерированный JSON 0.160, реальные коллапсы
 * 0.007–0.009. Порог 0.08 стоит с запасом в обе стороны (ближайший
 * легитимный корпус выше вдвое, ближайший брак ниже почти в девять раз),
 * поэтому не требует тюнинга под каждую модель.
 */
const ZLIB_RATIO_THRESHOLD = 0.08;
const ZLIB_MIN_LENGTH = 300;
const CHAR_SHARE_THRESHOLD = 0.75;
const CHAR_SHARE_MIN_LENGTH = 16;
const SPECIAL_TOKEN_RE = /<\|[a-z_]{2,20}\|>/;

/**
 * Признак коллапса: текст без пробелов либо почти не сжимается (zlib, уровень
 * 9 — циклический текст ужимается почти в ноль), либо состоит из одного
 * символа (>75% — ловит короткие `"The!!!!…"`, куда сжимаемость не дотягивается).
 */
export function isRepetitionCollapse(raw: string): boolean {
  const t = raw.replace(/\s+/g, "");
  const bytes = Buffer.byteLength(t, "utf8");
  if (bytes >= ZLIB_MIN_LENGTH) {
    const compressed = deflateSync(t, { level: 9 });
    if (compressed.byteLength / bytes < ZLIB_RATIO_THRESHOLD) return true;
  }
  if (bytes >= CHAR_SHARE_MIN_LENGTH) {
    const counts = new Map<string, number>();
    let max = 0;
    for (const ch of t) {
      const n = (counts.get(ch) ?? 0) + 1;
      counts.set(ch, n);
      if (n > max) max = n;
    }
    if (max / [...t].length > CHAR_SHARE_THRESHOLD) return true;
  }
  return false;
}

/** Утечка special-токена (`<|close|>`, `<|im_start|>` и т.п.) из исходного текста. */
export function findSpecialTokenLeak(raw: string): string | undefined {
  const match = SPECIAL_TOKEN_RE.exec(raw);
  return match ? match[0] : undefined;
}

/**
 * Классификация ответа. Таблица §4 ключуется по видимому `content` и
 * `finish_reason`: пустой текст при tool-calls — норма; пустой текст при
 * `length` — бюджет съеден рассуждением (рассуждение при этом может быть
 * вполне связным); пустой текст при `stop` — дегенерация. Дегенерация
 * reasoning-канала проверяется РАНЬШЕ: измеренный вариант kimi — `content:
 * null` + мусор в `reasoning_content` + `stop` — это коллапс, а не empty-stop.
 */
export function classifyDegenerate(source: DegenerateSource): DegenerateVerdict {
  const textEmpty = source.text.trim().length === 0;
  const thinkingEmpty = source.thinking.trim().length === 0;

  if (!thinkingEmpty) {
    const token = findSpecialTokenLeak(source.thinking);
    if (token) return { kind: "token-leak", where: "thinking", token };
    if (isRepetitionCollapse(source.thinking)) return { kind: "collapse", where: "thinking" };
  }
  if (!textEmpty) {
    const token = findSpecialTokenLeak(source.text);
    if (token) return { kind: "token-leak", where: "text", token };
    if (isRepetitionCollapse(source.text)) return { kind: "collapse", where: "text" };
    return { kind: "ok" };
  }
  // Пустой видимый текст: сначала tool-calls (норма), затем два пустых ответа §4.
  if (source.hasToolCalls) return { kind: "ok" };
  if (source.stopReason === "length") return { kind: "empty-length" };
  if (source.stopReason === "stop") return { kind: "empty-stop" };
  return { kind: "ok" };
}

/** Вердикт означает бракованный ответ (а не диагностику бюджета). */
export function isDegenerateVerdict(verdict: DegenerateVerdict): boolean {
  return verdict.kind === "collapse" || verdict.kind === "token-leak" || verdict.kind === "empty-stop";
}
