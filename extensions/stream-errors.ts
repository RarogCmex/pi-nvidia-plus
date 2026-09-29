/**
 * Шов: классификация ошибок оборванного потока (наблюдалось на nemotron-3-ultra).
 *
 * NIM обрывает SSE-поток посреди генерации (часто на длинном thinking-выводе
 * или на таймауте шлюза): поток заканчивается без финального чанка с
 * `finish_reason`, и pi-ai бросает `Stream ended without finish_reason`
 * (openai-completions). Пи ретраит такие ошибки сам (паттерн `ended without`
 * в ретрай-каталоге pi-ai), поэтому до финализированного сообщения с
 * `stopReason:"error"` дело доходит только когда повторы исчерпаны.
 *
 * Транспортный слой здесь бессилен: к моменту обрыва контент уже стримится
 * в пи, прозрачный повтор привёл бы к дублированию вывода. Правильный уровень
 * — `message_end`: наблюдение, метрика, уведомление с подсказкой.
 *
 * Модуль — чистый классификатор без пи и сети, ядро юнит-тестов.
 */

/** Финализированное сообщение, какое видно в `message_end` (утяжелённые поля не важны). */
export interface StreamErrorMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Тексты обрыва потока у pi-ai/openai-completions. Якорь — семейство
 * преждевременных окончаний из ретрай-каталога pi-ai: `stream ended
 * without …` (finish_reason), `stream ended before …` (message_stop,
 * terminal response event), `ended prematurely`, а также транспортные
 * `socket hang up` и `terminated`.
 */
const TRUNCATED_STREAM_RE = /stream ended (without|before)|ended prematurely|socket hang up|\bterminated\b/i;

/** Ошибка именно оборванного потока (не любая ошибка сообщения). */
export function isTruncatedStreamError(message: StreamErrorMessageLike | undefined | null): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "error") return false;
  const text = message.errorMessage;
  return typeof text === "string" && TRUNCATED_STREAM_RE.test(text);
}
