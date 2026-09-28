/**
 * Классификация пробы ключа (тикет 23 / баг NVCF 202): живой — не только 200.
 * NVCF-модели вроде deepseek-v4-pro-0813 без NVCF-POLL-SECONDS сразу отдают 202
 * (задание принято) — это «жив», а не «не определён». Ждать генерацию пулу из
 * сотен ключей нельзя: заголовок poll как раз превратил бы прогрев в минуты.
 * Запуск: node test/key-check.test.ts
 */
import assert from "node:assert/strict";
import { classifyKeyProbeStatus, keyCheckUnknownSample } from "../extensions/key-check.ts";

{
  assert.equal(classifyKeyProbeStatus(200), "ok");
  assert.equal(classifyKeyProbeStatus(202), "ok", "NVCF accepted — ключ жив, генерацию не ждём");
  assert.equal(classifyKeyProbeStatus(401), "dead");
  assert.equal(classifyKeyProbeStatus(403), "dead");
  assert.equal(classifyKeyProbeStatus(429), "limited");
  assert.equal(classifyKeyProbeStatus(400), "unknown");
  assert.equal(classifyKeyProbeStatus(404), "unknown");
  assert.equal(classifyKeyProbeStatus(451), "unknown");
  assert.equal(classifyKeyProbeStatus(500), "unknown");
}

{
  assert.equal(keyCheckUnknownSample([]), undefined);
  assert.equal(keyCheckUnknownSample([{ status: 451 }]), "HTTP 451");
  assert.equal(
    keyCheckUnknownSample([{ error: "Error: connect EHOSTUNREACH 203.0.113.1:8870" }]),
    "Error: connect EHOSTUNREACH 203.0.113.1:8870",
  );
  assert.equal(
    keyCheckUnknownSample([{ error: "boom nvapi-super-secret-key-zzzz" }])?.includes("nvapi-super-secret"),
    false,
    "ключ из текста ошибки не должен утекать в сводку",
  );
  assert.equal(keyCheckUnknownSample([{ status: 451 }, { error: "later" }]), "HTTP 451", "первый статус важнее");
}

console.log("ok");
