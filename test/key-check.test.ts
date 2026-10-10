/**
 * Классификация пробы ключа (тикет 23 / баг NVCF 202): живой — не только 200.
 * NVCF-модели вроде deepseek-v4-pro-0813 без NVCF-POLL-SECONDS сразу отдают 202
 * (задание принято) — это «жив», а не «не определён». Ждать генерацию пулу из
 * сотен ключей нельзя: заголовок poll как раз превратил бы прогрев в минуты.
 * Запуск: node test/key-check.test.ts
 */
import assert from "node:assert/strict";
import {
  classifyKeyAuthProbe,
  classifyKeyProbeStatus,
  keyCheckUnknownSample,
  planKeyCleanup,
  type KeyCleanupEntry,
} from "../extensions/key-check.ts";

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


// ── Оракул «жив ли ключ» без генерации (исследование 09) ─────────────────────
// 403/401 — кредиты отвергнуты; 404 — «Function not found for account»:
// авторизация ПРОЙДЕНА, аккаунт назван в ответе. Тела ответов не для логов.
{
  assert.equal(classifyKeyAuthProbe(403), "dead");
  assert.equal(classifyKeyAuthProbe(401), "dead");
  assert.equal(classifyKeyAuthProbe(404), "alive", "404-for-account: auth прошёл");
  assert.equal(classifyKeyAuthProbe(400), "alive", "валидация тела после auth");
  assert.equal(classifyKeyAuthProbe(422), "alive");
  assert.equal(classifyKeyAuthProbe(429), "alive", "рейт-лимит — ключ жив");
  assert.equal(classifyKeyAuthProbe(200), "alive");
  assert.equal(classifyKeyAuthProbe(202), "alive");
  assert.equal(classifyKeyAuthProbe(410), "unknown", "модель пробы умерла — вердикта нет, ключ не трогаем");
  assert.equal(classifyKeyAuthProbe(500), "unknown");
  assert.equal(classifyKeyAuthProbe(503), "unknown");
}

// ── План чистки: удаляются только подтверждённые dead ───────────────────────
{
  const entry = (raw: string, outcome?: "alive" | "dead" | "unknown", probeKey?: string): KeyCleanupEntry => ({
    raw,
    probeKey: probeKey ?? (outcome ? `nvapi-zzzz${raw.slice(-4)}` : undefined),
    outcome,
  });

  // Обычный случай: dead удаляются, unknown и непробованные остаются,
  // порядок исходных записей сохранён, маски без кредов.
  const plan = planKeyCleanup([
    entry("nvapi-aaaa1", "alive"),
    entry("nvapi-bbbb2", "dead"),
    entry("$ENV_KEY", undefined, undefined),
    entry("nvapi-cccc3", "unknown"),
    entry("nvapi-dddd4", "dead"),
  ]);
  assert.deepEqual(plan.keep, ["nvapi-aaaa1", "$ENV_KEY", "nvapi-cccc3"]);
  assert.equal(plan.droppedCount, 2);
  assert.equal(plan.probedCount, 4);
  assert.equal(plan.refusal, undefined);
  assert.equal(JSON.stringify(plan.dropped).includes("nvapi-bbbb2"), false, "в dropped только маски");
  assert.ok(plan.dropped.every((m) => m.startsWith("…")), `маски: ${plan.dropped}`);

  // Гард «слишком много мёртвых» — только на большом пуле (≥ 10 замеров):
  // на маленьком вычищать большинство — норма, а не сломанный оракул.
  const big = planKeyCleanup([
    entry("nvapi-0001", "dead"), entry("nvapi-0002", "dead"), entry("nvapi-0003", "dead"),
    entry("nvapi-0004", "dead"), entry("nvapi-0005", "dead"), entry("nvapi-0006", "dead"),
    entry("nvapi-0007", "alive"), entry("nvapi-0008", "alive"), entry("nvapi-0009", "alive"),
    entry("nvapi-0010", "unknown"), entry("nvapi-0011", "unknown"),
  ]);
  assert.equal(big.refusal, "too-many-dead");
  assert.equal(big.droppedCount, 6);
  assert.equal(big.probedCount, 11);

  // Маленький пул, три из четырёх мёртвы — чистка легитимна, не отказ.
  const small = planKeyCleanup([
    entry("nvapi-aaaa1", "dead"),
    entry("nvapi-bbbb2", "alive"),
    entry("nvapi-cccc3", "dead"),
    entry("nvapi-dddd4", "dead"),
  ]);
  assert.equal(small.refusal, undefined);
  assert.deepEqual(small.keep, ["nvapi-bbbb2"]);

  // Большой пул, ровно половина — не отказ (граница > 0.5, не >=).
  const half = planKeyCleanup([
    ...Array.from({ length: 5 }, (_, i) => entry(`nvapi-h${i}0`, "dead")),
    ...Array.from({ length: 5 }, (_, i) => entry(`nvapi-h${i}1`, "alive")),
  ]);
  assert.equal(half.refusal, undefined);

  // Гвард «пул опустеет»: единственный ключ мёртв — писать нечего.
  const wipe = planKeyCleanup([entry("nvapi-eeee5", "dead")]);
  assert.equal(wipe.refusal, "empty-result");
  assert.deepEqual(wipe.keep, []);

  // Пустой вход — не отказ, просто нечего делать.
  const empty = planKeyCleanup([]);
  assert.equal(empty.refusal, undefined);
  assert.deepEqual(empty.keep, []);

  // Все живы — dropped пуст, keep в исходном порядке.
  const clean = planKeyCleanup([entry("nvapi-ffff6", "alive"), entry("nvapi-gggg7", "alive")]);
  assert.deepEqual(clean.keep, ["nvapi-ffff6", "nvapi-gggg7"]);
  assert.equal(clean.droppedCount, 0);
}

console.log("ok");
