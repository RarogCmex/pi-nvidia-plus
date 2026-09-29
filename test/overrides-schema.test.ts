/**
 * `overrides/models.json` применяется к **настоящему** `~/.pi/agent/models.json`
 * пользователя, поэтому его значения проверяет не наше представление о схеме pi,
 * а сама pi: тест грузит файл её собственным загрузчиком конфигов.
 *
 * Зачем это отдельным тестом. Значение `compat.thinkingFormat` — перечисление, и
 * список в нём растёт между версиями pi. Ошибка здесь выглядит безобидно
 * («формат не тот») и не ловится ни офлайн-тестами хука, ни тайпчеком: JSON не
 * проверяется типами. Реальный риск — не «невалидное значение», а **валидное, но
 * делающее не то**: например `qwen-chat-template` схема принимает, но он
 * дополнительно и безусловно шлёт `preserve_thinking: true`, который нельзя ни
 * выключить, ни настроить через `chatTemplateKwargs`. Поэтому ниже зафиксирован и
 * выбор формата, а не только его допустимость.
 *
 * Запуск: node test/overrides-schema.test.ts
 * Требует `node scripts/link-pi.mjs` (как и весь typecheck).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OVERRIDES_PATH = join("overrides", "models.json");
const raw = readFileSync(OVERRIDES_PATH, "utf8");
const parsed = JSON.parse(raw) as {
  providers?: Record<string, { modelOverrides?: Record<string, unknown> }>;
};

// ── 1. Файл — валидный models.json по схеме установленной pi ─────────────────
const piRequire = createRequire(
  join(realpathSync(join("node_modules", "@earendil-works", "pi-coding-agent")), "index.js"),
);
const { ModelConfig } = piRequire("./dist/core/model-config.js") as {
  ModelConfig: { load(path: string): Promise<{ providers: Map<string, any>; error?: unknown }> };
};

const dir = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-overrides-"));
const candidate = join(dir, "models.json");
writeFileSync(candidate, raw);
const loaded = await ModelConfig.load(candidate);

assert.equal(
  loaded.error,
  undefined,
  `pi отклонила ${OVERRIDES_PATH}: ${JSON.stringify(loaded.error)} — файл попадёт в models.json пользователя`,
);
assert.deepEqual([...loaded.providers.keys()], ["nvidia"], "оверрайды должны касаться только провайдера nvidia");

const nvidia = loaded.providers.get("nvidia");
const overrides = (nvidia?.modelOverrides ?? {}) as Record<string, Record<string, unknown>>;
assert.ok(Object.keys(overrides).length >= 8, "оверрайдов подозрительно мало — файл повреждён?");

// ── 2. Каждый оверрайд — только метаданные, никаких сюрпризов ────────────────
const ALLOWED_KEYS = new Set([
  "name",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "inputLimits",
  "cost",
  "promptCache",
  "contextWindow",
  "maxTokens",
  "samplingParams",
  "headers",
  "compat",
]);

for (const [id, entry] of Object.entries(overrides)) {
  const extra = Object.keys(entry).filter((k) => !ALLOWED_KEYS.has(k));
  assert.deepEqual(extra, [], `${id}: ключи вне схемы ModelOverride`);

  // Расширение владеет только своими записями: никаких apiKey/baseUrl/headers
  // с креденшелами в оверрайдах быть не должно.
  assert.equal(entry.headers, undefined, `${id}: headers в оверрайде — не место для креденшелов`);
  const compat = (entry.compat ?? {}) as Record<string, unknown>;
  assert.equal(compat.apiKey, undefined, `${id}: apiKey в compat`);

  // reasoning: true без thinkingLevelMap — это селектор, который pi не сможет
  // наполнить уровнями; такая запись бесполезна и выглядит как баг.
  if (entry.reasoning === true && compat.thinkingFormat === undefined) {
    assert.ok(
      entry.thinkingLevelMap !== undefined,
      `${id}: reasoning:true без thinkingLevelMap и без thinkingFormat — pi нечего предложить`,
    );
  }
}

// ── 3. Выбор thinkingFormat зафиксирован, а не просто допустим ───────────────
// `chat-template` — единственный формат, состав полей которого задаётся данными
// (`compat.chatTemplateKwargs`). `qwen-chat-template` схема тоже принимает, но он
// безусловно добавляет `preserve_thinking: true` и игнорирует `chatTemplateKwargs`,
// то есть на провод уходит поле, которое нельзя ни проверить, ни выключить.
// Для `poolside/laguna-xs-2.1` состав полей измерен у вендора модели: нужен ровно
// `enable_thinking`.
const laguna = overrides["poolside/laguna-xs-2.1"];
assert.ok(laguna, "оверрайд poolside/laguna-xs-2.1 пропал");
const lagunaCompat = (laguna.compat ?? {}) as Record<string, unknown>;
assert.equal(
  lagunaCompat.thinkingFormat,
  "chat-template",
  "верните chat-template: qwen-chat-template добавил бы неизменяемый preserve_thinking:true",
);
assert.deepEqual(
  lagunaCompat.chatTemplateKwargs,
  { enable_thinking: { $var: "thinking.enabled" } },
  "состав chat_template_kwargs должен оставаться управляемым через данные",
);
assert.equal(
  lagunaCompat.requiresReasoningContentOnAssistantMessages,
  true,
  "эхо reasoning_content — задокументированное требование вендора",
);

// Ни один оверрайд не должен нести формат с захардкоженным составом полей, пока
// это не проверено живьём на соответствующем маршруте.
for (const [id, entry] of Object.entries(overrides)) {
  const format = ((entry.compat ?? {}) as Record<string, unknown>).thinkingFormat;
  assert.notEqual(
    format,
    "qwen-chat-template",
    `${id}: qwen-chat-template шлёт preserve_thinking:true безусловно — используйте chat-template + chatTemplateKwargs`,
  );
}

rmSync(dir, { recursive: true, force: true });

// ── 4. Файл остаётся машиночитаемым (без комментариев и хвостовых запятых) ────
assert.equal(
  parsed.providers?.nvidia?.modelOverrides !== undefined,
  true,
  "структура providers.nvidia.modelOverrides обязательна",
);
assert.doesNotThrow(() => JSON.parse(raw), "overrides/models.json обязан быть строгим JSON");

console.log("overrides-schema: все проверки прошли");
