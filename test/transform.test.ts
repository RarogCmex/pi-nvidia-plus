/**
 * Тесты шва B: чистая трансформация запроса (extensions/transform.ts).
 * Запуск: node test/transform.test.ts
 *
 * Источник истины — таблица маппингов из `.scratch/pi-nvidia-plus/spec.md`
 * (подтверждена живыми пробами тикета 05) и пользовательская история №19.
 */
import assert from "node:assert/strict";
import { transformRequest, thinkingPlan, type Payload } from "../extensions/transform.ts";

const M3 = "minimaxai/minimax-m3";
const N3 = "nvidia/nemotron-3-super-120b-a12b";
const LIGHTNING = "nvidia/nemotron-3.5-lightning-30b-a3b";
const OTHER = "moonshotai/kimi-k3";

function kwargs(p: Payload): Record<string, unknown> {
  return (p.chat_template_kwargs ?? {}) as Record<string, unknown>;
}

// 1. MiniMax M3: уровень пи → thinking_mode (таблица спеки).
const minimaxRows: Array<[string, string]> = [
  ["off", "disabled"],
  ["minimal", "adaptive"],
  ["low", "adaptive"],
  ["medium", "adaptive"],
  ["high", "enabled"],
  ["xhigh", "enabled"],
  ["max", "enabled"],
];
for (const [level, mode] of minimaxRows) {
  const r = transformRequest({ model: M3, messages: [] }, { modelId: M3, thinkingLevel: level });
  assert.equal(kwargs(r.payload).thinking_mode, mode, `M3 ${level} → thinking_mode`);
  assert.ok(r.modified, `M3 ${level}: пейлоад не помечен изменённым`);
}

// 2. Неметрон 3.x/3.5: off → enable_thinking=false; minimal/low → +low_effort; остальное → enable_thinking=true.
for (const modelId of [N3, LIGHTNING]) {
  const off = transformRequest({ model: modelId }, { modelId, thinkingLevel: "off" });
  assert.equal(kwargs(off.payload).enable_thinking, false, `${modelId} off`);
  assert.ok(!("low_effort" in kwargs(off.payload)), `${modelId} off: low_effort не удалён`);

  for (const level of ["minimal", "low"]) {
    const r = transformRequest({ model: modelId }, { modelId, thinkingLevel: level });
    assert.equal(kwargs(r.payload).enable_thinking, true, `${modelId} ${level}`);
    assert.equal(kwargs(r.payload).low_effort, true, `${modelId} ${level}: low_effort`);
  }
  for (const level of ["medium", "high", "xhigh", "max"]) {
    const r = transformRequest({ model: modelId }, { modelId, thinkingLevel: level });
    assert.equal(kwargs(r.payload).enable_thinking, true, `${modelId} ${level}`);
    assert.ok(!("low_effort" in kwargs(r.payload)), `${modelId} ${level}: low_effort должен быть удалён`);
  }
}

// 3. Идемпотентность: уже верный параметр не помечается изменением.
const idem = transformRequest(
  { model: M3, chat_template_kwargs: { thinking_mode: "enabled" }, max_tokens: 8192 },
  { modelId: M3, thinkingLevel: "high" },
);
assert.equal(idem.modified, false, "повторный инжект того же уровня помечен изменением");

// 4. Чужое семейство: мышление не инжектится, но нормализация и max_tokens работают.
const other = transformRequest(
  { model: OTHER, messages: [{ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
  { modelId: OTHER, thinkingLevel: "max", defaultMaxTokens: 4096 },
);
assert.equal(kwargs(other.payload).thinking_mode, undefined, "чужому семейству инжектится мышление");
assert.equal((other.payload.messages as any[])[0].content, "a\nb", "текстовый контент-массив не свернут");
assert.equal(other.payload.max_tokens, 4096, "дефолт max_tokens не применён");
assert.ok(other.modified);

// 5. Контент-массивы с не-текстовыми частями не трогаются (не молча ломаем данные).
const mixed = transformRequest(
  { model: OTHER, messages: [{ content: [{ type: "text", text: "a" }, { type: "image_url" }] }, { content: [] }] },
  { modelId: OTHER },
);
assert.ok(Array.isArray((mixed.payload.messages as any[])[0].content), "смешанный контент-массив изменён");

// 6. max_tokens не трогается, если уже задан (включая max_completion_tokens).
const withMax = transformRequest({ model: OTHER, max_tokens: 10 }, { modelId: OTHER });
assert.equal(withMax.payload.max_tokens, 10);
const withCompletion = transformRequest({ model: OTHER, max_completion_tokens: 20 }, { modelId: OTHER });
assert.equal(withCompletion.payload.max_tokens, undefined, "max_tokens добавлен поверх max_completion_tokens");

// 7. Строка плана для статус-строки/диагностики.
assert.equal(thinkingPlan(M3, "max"), 'chat_template_kwargs.thinking_mode="enabled"');
assert.equal(thinkingPlan(N3, "off"), "chat_template_kwargs.enable_thinking=false");
assert.equal(thinkingPlan(N3, "minimal"), "chat_template_kwargs.enable_thinking=true, low_effort=true");
assert.equal(thinkingPlan(OTHER, "high"), undefined, "план для чужого семейства не пуст");

// 8. Нет уровня или нет модели — трансформация только нормализует.
const bare = transformRequest(
  { model: M3, messages: [{ content: [{ type: "text", text: "x" }] }] },
  { modelId: M3 },
);
assert.equal((bare.payload.messages as any[])[0].content, "x");
assert.equal(kwargs(bare.payload).thinking_mode, undefined, "без уровня инжектится мышление");

console.log("transform: все проверки прошли");
