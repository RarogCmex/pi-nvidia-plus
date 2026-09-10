/**
 * Классификация одной HTTP-пробы ключа NIM (команда `/nvidia-plus keys check`).
 * Транспорт и ротация сюда не входят — только правило «статус → исход».
 *
 * 202 считается живым: NVCF-модели (deepseek-v4-pro-0813 и др. с
 * `NVCF-POLL-SECONDS`) без заголовка long-poll сразу отвечают 202 Accepted.
 * Прогрев пула не должен ждать генерацию и не должен слать этот заголовок.
 */
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
