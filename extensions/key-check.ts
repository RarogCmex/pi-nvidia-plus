/**
 * Классификация одной HTTP-пробы ключа NIM (команда `/nvidia-plus keys check`).
 * Транспорт и ротация сюда не входят — только правило «статус → исход».
 *
 * 202 считается живым: NVCF-модели (deepseek-v4-pro-0813 и др. с
 * `NVCF-POLL-SECONDS`) без заголовка long-poll сразу отвечают 202 Accepted.
 * Прогрев пула не должен ждать генерацию и не должен слать этот заголовок.
 *
 * Осторожно с 401: здесь это «ключ мёртв», потому что проба идёт С ключом.
 * Тот же статус на ПУСТОМ ключе означает противоположное — «chat-роут модели
 * жив» (NIM резолвит модель до проверки авторизации — исследование 06, §1).
 * Эти два смысла живут на разных слоях; не переиспользуйте классификатор для
 * keyless-проб.
 */
import { maskKey } from "./keys.ts";

export type KeyCheckOutcome = "ok" | "dead" | "limited" | "unknown";

export function classifyKeyProbeStatus(statusCode: number): KeyCheckOutcome {
  if (statusCode === 200 || statusCode === 202) return "ok";
  if (statusCode === 401 || statusCode === 403) return "dead";
  if (statusCode === 429) return "limited";
  return "unknown";
}

/** Короткий пример для сводки, когда часть проб «не определена». Ключи вычищаются. */
export function keyCheckUnknownSample(entries: Array<{ status?: number; error?: string }>): string | undefined {
  for (const entry of entries) {
    if (typeof entry.status === "number") return `HTTP ${entry.status}`;
    if (entry.error) return redactKeyMaterial(entry.error).slice(0, 100);
  }
  return undefined;
}

function redactKeyMaterial(text: string): string {
  return text.replace(/nvapi-[A-Za-z0-9_-]+/gi, "nvapi-…");
}

/* ------------------------------------------------------------------ */
/* Оракул «жив ли ключ» без генерации (исследование 09)                  */
/* ------------------------------------------------------------------ */

/**
 * Порядок обработки запроса NIM: авторизация → резолв chat-функции под
 * аккаунт → валидация тела → генерация. Проба оракула шлёт модель из живого
 * каталога и тело БЕЗ `messages`, до генерации не доходит ни один запрос.
 * Классификация по статусу (эмпирика 2026-10-10, 436 ключей: {403, 404}):
 *   401/403 — кредиты отвергнуты («Authorization failed»);
 *   404     — «Function not found for account»: авторизация ПРОЙДЕНА, аккаунт
 *             назван в ответе — ключ жив (тела ответов не для логов);
 *   400/422 — авторизация пройдена, тело отвергнуто валидацией;
 *   429     — жив, но рейт-лимит.
 * В отличие от `classifyKeyProbeStatus`, здесь 404 — «жив»: тот классификатор
 * написан под мини-чат, где 404 значит «модель не та», и его нельзя
 * переиспользовать для этого оракула.
 */
export type KeyAuthOutcome = "alive" | "dead" | "unknown";

export function classifyKeyAuthProbe(statusCode: number): KeyAuthOutcome {
  if (statusCode === 401 || statusCode === 403) return "dead";
  if (statusCode === 200 || statusCode === 202 || statusCode === 400 || statusCode === 404 || statusCode === 422 || statusCode === 429) {
    return "alive";
  }
  return "unknown";
}

/** Одна запись пул-файла с вердиктом пробы. */
export interface KeyCleanupEntry {
  /** Запись файла как есть — может быть `$VAR`-ссылкой. */
  raw: string;
  /** Резолв для пробы; env-ссылка без резолва не пробуется и не удаляется. */
  probeKey?: string;
  outcome?: KeyAuthOutcome;
}

export type KeyCleanupRefusal = "too-many-dead" | "empty-result";

export interface KeyCleanupPlan {
  /** `raw`-записи, которые остаются, в исходном порядке. */
  keep: string[];
  /** Маски (`…XXXX`) удалённых записей — креды не покидают план. */
  dropped: string[];
  droppedCount: number;
  /** Сколько записей вообще дошли до пробы (у остальных outcome нет). */
  probedCount: number;
  /** Отказ писать: вызывающий обязан проверить это ПЕРВЫМ. */
  refusal?: KeyCleanupRefusal;
}

/**
 * План чистки пула. Удаляются ТОЛЬКО подтверждённые `dead` — `unknown`
 * (5xx, сетевые срывы) и непробованные env-ссылки остаются. Гварды:
 *   too-many-dead — мёртвых больше половины И замеров хотя бы 10: на
 *     большом пуле это значит «сломался оракул» (например, модель пробы
 *     исчезла из каталога и 404 приходит до авторизации), а не «умер полпула»;
 *     на маленьком пуле (несколько ключей) вычищать большинство — норма;
 *   empty-result — чистка опустошила бы пул целиком.
 * Оба отказа не меняют `keep` — план описывает, что БЫЛО БЫ; решение писать
 * остаётся за вызывающим, увидевшим `refusal`.
 */
export function planKeyCleanup(entries: readonly KeyCleanupEntry[]): KeyCleanupPlan {
  const keep: string[] = [];
  const dropped: string[] = [];
  let probedCount = 0;
  for (const entry of entries) {
    if (entry.outcome !== undefined) probedCount++;
    if (entry.outcome === "dead") {
      dropped.push(maskKey(entry.probeKey ?? entry.raw));
      continue;
    }
    keep.push(entry.raw);
  }
  let refusal: KeyCleanupRefusal | undefined;
  if (dropped.length > 0 && probedCount >= 10 && dropped.length / probedCount > 0.5) {
    refusal = "too-many-dead";
  } else if (keep.length === 0 && entries.length > 0) {
    refusal = "empty-result";
  }
  return { keep, dropped, droppedCount: dropped.length, probedCount, refusal };
}
