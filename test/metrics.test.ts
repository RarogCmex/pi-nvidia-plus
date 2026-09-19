/**
 * Тесты шва метрик (extensions/metrics.ts, тикет 20).
 * Запуск: node test/metrics.test.ts
 */
import assert from "node:assert/strict";
import { SessionMetrics } from "../extensions/metrics.ts";

const m = new SessionMetrics();

// Пустой счётчик: пустые части.
assert.equal(m.totalResponses(), 0);
assert.deepEqual(m.formatParts(), { responses: [], groups: [] });

// Подсчёт по статусам, сортировка в выводе.
m.noteResponse(200);
m.noteResponse(200);
m.noteResponse(429);
m.noteResponse(404);
m.noteResponse(200);
assert.equal(m.totalResponses(), 5);
assert.deepEqual(m.formatParts().responses, ["200×3", "404×1", "429×1"]);

// Нулевые группы скрываются, ненулевые — в фиксированном порядке.
m.retries = 2;
m.keySwitches = 1;
assert.deepEqual(m.formatParts().groups, [
  { kind: "retries", value: 2 },
  { kind: "keySwitches", value: 1 },
]);
m.inBandRetries = 4;
m.deadKeys = 1;
m.cooldownWaits = 3;
assert.deepEqual(m.formatParts().groups.map((g) => g.kind), [
  "retries",
  "inBandRetries",
  "keySwitches",
  "deadKeys",
  "cooldownWaits",
]);

// Счётчик смены pin прокси (spec proxy-pool): виден в сводке только ненулевым.
m.proxySwitches = 2;
assert.deepEqual(m.formatParts().groups.map((g) => g.kind), [
  "retries",
  "inBandRetries",
  "keySwitches",
  "deadKeys",
  "cooldownWaits",
  "proxySwitches",
]);
assert.equal(m.snapshot().proxySwitches, 2);

// Снимок — копия: мутации снимка не влияют на счётчик.
const snap = m.snapshot();
snap.responses.set(500, 99);
assert.equal(m.snapshot().responses.has(500), false);
assert.equal(snap.retries, 2);

// Экземпляры независимы.
const other = new SessionMetrics();
assert.equal(other.totalResponses(), 0);

console.log("metrics: все проверки прошли");
