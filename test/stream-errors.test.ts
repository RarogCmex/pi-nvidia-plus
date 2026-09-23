/**
 * Тесты шва классификации оборванных потоков (extensions/stream-errors.ts,
 * лог 01a0ceb8: NIM обрывает SSE без finish_reason на длинном thinking-выводе).
 * Запуск: node test/stream-errors.test.ts
 */
import assert from "node:assert/strict";
import { isTruncatedStreamError } from "../extensions/stream-errors.ts";

// Канонический случай из лога: assistant + stopReason error + текст pi-ai.
assert.equal(
  isTruncatedStreamError({
    role: "assistant",
    stopReason: "error",
    errorMessage: "Stream ended without finish_reason",
  }),
  true,
);

// Варианты формулировок терминальных маркеров и транспорта.
for (const errorMessage of [
  "Stream ended without finish_reason",
  "Anthropic stream ended before message_stop",
  "stream ended without a terminal response event",
  "Response ended prematurely",
  "terminated",
  "socket hang up",
]) {
  assert.equal(isTruncatedStreamError({ role: "assistant", stopReason: "error", errorMessage }), true, errorMessage);
}

// Не-обрыв потока не классифицируется как обрыв.
for (const errorMessage of [
  "Service temporarily overloaded",
  "429 Too Many Requests",
  "Request was aborted",
  "quota exceeded",
  "connection error",
  undefined,
]) {
  assert.equal(
    isTruncatedStreamError({ role: "assistant", stopReason: "error", errorMessage }),
    false,
    String(errorMessage),
  );
}

// «terminated» в тексте — обрыв; но только при stopReason error.
assert.equal(
  isTruncatedStreamError({ role: "assistant", stopReason: "stop", errorMessage: "terminated" }),
  false,
);

// Другие роли и пустые входы игнорируются.
assert.equal(isTruncatedStreamError({ role: "user", stopReason: "error", errorMessage: "stream ended without finish_reason" }), false);
assert.equal(isTruncatedStreamError(undefined), false);
assert.equal(isTruncatedStreamError(null), false);
assert.equal(isTruncatedStreamError({}), false);

console.log("stream-errors: ok");
