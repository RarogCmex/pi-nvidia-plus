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
  providers?: Record<string, { modelOverrides?: Record<string, unknown>; models?: Array<Record<string, unknown>> }>;
};

// ── 1. Файл — валидный models.json по схеме установленной pi ─────────────────
const piRoot = realpathSync(join("node_modules", "@earendil-works", "pi-coding-agent"));
const piRequire = createRequire(join(piRoot, "index.js"));
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
assert.ok(Object.keys(overrides).length >= 7, "оверрайдов подозрительно мало — файл повреждён?");

// ── 1b. Своих карточек в `models` нет: они затеняют встроенные карточки pi ───
// pi применяет запись `models` ЗАМЕНОЙ, а не патчем (`applyModelsJson`:
// `models[existingIndex] = modelFromJson(…)`), поэтому своя карточка для id,
// который встроенный каталог уже несёт, молча роняет всё, чего в ней нет:
// пер-модельные `headers` (`NVCF-POLL-SECONDS: 3600` — без него NVCF отвечает
// 202 вместо генерации), `thinkingLevelMap`, `inputLimits`. Так было с kimi-k3
// (pi вернул карточку в базу — запись убрали) и с `deepseek-ai/deepseek-v4.1-flash`
// на pi ≥ 1.3.0, где встроенная карточка стала полнее нашей «полной карточки 1M».
// Правка отдельных полей — через `modelOverrides`: он мержится поключно
// (`applyModelOverride`, compat — через `mergeCompat`).
const piAiRequire = createRequire(join(piRoot, "node_modules", "@earendil-works", "pi-ai", "index.js"));
const { nvidiaProvider } = piAiRequire("./dist/providers/nvidia.js") as {
  nvidiaProvider: () => { getModels(): Array<{ id: string }> };
};
const builtinIds = new Set(nvidiaProvider().getModels().map((model) => model.id));
const shadowed = (parsed.providers?.nvidia?.models ?? [])
  .map((card) => card?.id)
  .filter((id): id is string => typeof id === "string" && builtinIds.has(id));
assert.deepEqual(
  shadowed,
  [],
  "запись в models заменяет встроенную карточку pi целиком (теряются headers/thinkingLevelMap) — перенесите правку полей в modelOverrides",
);

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
  "samplingParamsByThinkingLevel",
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

// ── 3b. minimax-m3.1-flash: нативный reasoning_effort, валидные варианты NIM ─
// Живые пробы (research/07 для kimi-k3, 2026-10-05; m3.1-flash, 2026-10-23):
// NIM принимает только none/minimal/low/medium/high/xhigh/max (`off`→400),
// поэтому off обязан маппиться в `none`, а не в `off`/`null`/`on`.
// (Прежний носитель паттерна moonshotai/kimi-k3 — 410 EOL 2026-10-15, оверрайд
// убран; карта переехала в собственную карточку m3.1-flash из `models`. На pi
// 1.5.0 id появился во встроенном каталоге, и запись в `models` стала бы заменой
// встроенной карточки с потерей `inputLimits`, поэтому правки полей переехали в
// `modelOverrides` — та же миграция, что была с kimi-k3 и deepseek-v4.1-flash.)
const m31 = overrides["minimaxai/minimax-m3.1-flash"];
assert.ok(m31, "оверрайд minimaxai/minimax-m3.1-flash пропал");
assert.equal(
  (m31.compat as Record<string, unknown> | undefined)?.supportsReasoningEffort,
  true,
  "m3.1-flash без supportsReasoningEffort:true — карта мышления инертна, пи не шлёт reasoning_effort (research/07 §1)",
);
const m31Map = m31.thinkingLevelMap as Record<string, unknown>;
assert.ok(m31Map, "m3.1-flash: нет thinkingLevelMap");
assert.equal(m31Map.off, "none", 'm3.1-flash: off должен быть "none" — NIM отвергает "off" (400)');
const NIM_EFFORT_VARIANTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
for (const [level, value] of Object.entries(m31Map)) {
  assert.ok(
    typeof value === "string" && NIM_EFFORT_VARIANTS.has(value),
    `m3.1-flash: уровень ${level} → «${String(value)}» не является валидным вариантом NIM (none…max)`,
  );
}

// ── 3c. ultra и lightning: нативный reasoning_effort вместо enable_thinking ─
// Ретест 2026-11-26 (research/16 §5): ключ чат-шаблона принимается 200, но
// reasoning на них не выключает и не включает — единственная рабочая ручка —
// top-level reasoning_effort (`none…max`, `off`→400). Прежние deepseek-v4.1-flash
// (EOL 2026-11-16) и gpt-oss-20b (EOL 2026-11-18) ушли в DEAD_MODELS (блок 3g).
for (const id of ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning-30b-a3b"]) {
  const entry = overrides[id];
  assert.ok(entry, `оверрайд ${id} пропал`);
  assert.equal(
    (entry.compat as Record<string, unknown> | undefined)?.supportsReasoningEffort,
    true,
    `${id} без supportsReasoningEffort:true — reasoning_effort не уйдёт`,
  );
  const map = entry.thinkingLevelMap as Record<string, unknown>;
  assert.ok(map, `${id}: нет thinkingLevelMap`);
  assert.equal(map.off, "none", `${id}: off должен быть "none" — "off" отвергается 400`);
  for (const [level, value] of Object.entries(map)) {
    assert.ok(
      typeof value === "string" && NIM_EFFORT_VARIANTS.has(value),
      `${id}: уровень ${level} → «${String(value)}» вне шкалы NIM none…max`,
    );
  }
  assert.ok(
    !Object.values(map).includes("off"),
    `${id}: значение "off" сервер отвергает 400 — карта не может его слать`,
  );
}

// ── 3d. nemotron-3.5-super-vl: мышление по документации NVIDIA, не по хуку ───
// Встроенная карточка pi 1.4.0 несёт maxTokens 8192 и `supportsReasoningEffort:
// false` без карты уровней, поэтому на провод не уходило НИЧЕГО, а мышление у
// модели включено по умолчанию и его токены считаются в max_tokens: каждый
// ответ заканчивался `finish_reason: "length"` на пустом content (сессия
// 01a18c64, 2026-10-30, research/14). Документация NIM (docs.nvidia.com NIM 2.0.13
// §Control Reasoning, docs.api.nvidia.com reference): `reasoning_effort` —
// none|low|high (по умолчанию high), `none` выключает reasoning-токены, а
// `max_tokens` принимает до 32768 при дефолте 16384. Поэтому путь здесь
// нативный (pi сам шлёт reasoning_effort), а не хук nemotron-семейства:
// `enable_thinking=true` рядом с `reasoning_effort` — два разных хозяина одного
// решения.
const superVl = overrides["nvidia/nemotron-3.5-super-vl-120b-a12b"];
assert.ok(superVl, "оверрайд nvidia/nemotron-3.5-super-vl-120b-a12b пропал");
assert.equal(
  (superVl.compat as Record<string, unknown> | undefined)?.supportsReasoningEffort,
  true,
  "super-vl без supportsReasoningEffort:true — селектор уровней inert, reasoning_effort не уходит (регрессия к обрезаниям)",
);
const superVlMap = superVl.thinkingLevelMap as Record<string, unknown>;
assert.ok(superVlMap, "super-vl: нет thinkingLevelMap");
assert.equal(superVlMap.off, "none", 'super-vl: off должен быть "none" — только он выключает reasoning-токены');
// Ретест 2026-11-26 (research/16 §5) расширил шкалу на проводе до полной NIM-овской
// none…max: `low`/`medium`/`high` → 200 с растущим reasoning-каналом, `off` и
// `bogus` → 400. Поэтому карта растянута на ту же шкалу, а не сжата в
// документированные low|high (сжатие молча поднимало бы `low` до `high`).
const SUPER_VL_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
for (const [level, value] of Object.entries(superVlMap)) {
  assert.ok(
    typeof value === "string" && SUPER_VL_EFFORTS.has(value),
    `super-vl: уровень ${level} → «${String(value)}» вне шкалы NIM none…max`,
  );
}
// `off` — единственное значение, которое сервер отвергает 400: `none` обязателен.
assert.ok(
  !Object.values(superVlMap).includes("off"),
  'super-vl: значение "off" сервер отвергает 400 — карта не может его слать',
);
// 8192 из встроенной карточки — меньше серверного дефолта (16384): reasoning
// съедал весь бюджет и ответ обрывался. Потолок карточки модели — 32768.
assert.equal(superVl.maxTokens, 32768, "super-vl: maxTokens должен быть карточным потолком 32768, а не 8192 из pi");

// ── 3e. google/diffusiongemma-26b-a4b-it и meta/muse-glimmer-30b — EOL ───────
// Обе ушли в DEAD_MODELS (2026-11-12 и 2026-11-24, research/16 §2); блок 3g
// гарантирует, что для них больше нет ни оверрайда, ни своей карточки.
assert.equal(
  overrides["google/diffusiongemma-26b-a4b-it"],
  undefined,
  "diffusiongemma: мышление ведёт хук (и модель EOL), оверрайд не нужен",
);

// ── 3g. Оверрайд не может висеть на мёртвой модели ────────────────────────
// Реальный дефект 2026-10-30: `z-ai/glm-5.3` получил 410 EOL 2026-10-28 и ушёл
// из живого `/v1/models`, а оверрайд (и запись в `models`) продолжали его
// «улучшать». Найден ручным аудитом — этот гейт ловит его автоматически.
const { DEAD_MODELS } = (await import("../extensions/dead-models.ts")) as {
  DEAD_MODELS: Record<string, string>;
};
const deadOverrides = Object.keys(overrides).filter((id) => id in DEAD_MODELS);
assert.deepEqual(
  deadOverrides,
  [],
  "оверрайд на мёртвой модели: уберите запись (иначе она влияет на id, которого нет в проде)",
);
const deadCards = (parsed.providers?.nvidia?.models ?? [])
  .map((card) => card?.id)
  .filter((id): id is string => typeof id === "string" && id in DEAD_MODELS);
assert.deepEqual(deadCards, [], "своя карточка на мёртвой модели");

rmSync(dir, { recursive: true, force: true });

// ── 4. Файл остаётся машиночитаемым (без комментариев и хвостовых запятых) ────
assert.equal(
  parsed.providers?.nvidia?.modelOverrides !== undefined,
  true,
  "структура providers.nvidia.modelOverrides обязательна",
);
assert.doesNotThrow(() => JSON.parse(raw), "overrides/models.json обязан быть строгим JSON");

console.log("overrides-schema: все проверки прошли");
