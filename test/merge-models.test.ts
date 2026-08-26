/**
 * Тесты чистого мержа оверрайдов (расширение: extensions/merge-models.ts).
 * Запуск: node test/merge-models.test.ts (Node ≥ 22.6, type stripping).
 */
import assert from "node:assert/strict";
import { mergeModelsJson, type ModelsJson } from "../extensions/merge-models.ts";

// Фикстуры повторяют реальную ситуацию: у пользователя есть свой провайдер
// (atomesus) и записи в nvidia, частью из которых расширение владеет.
const source: ModelsJson = {
  providers: {
    nvidia: {
      modelOverrides: {
        "minimaxai/minimax-m3": { reasoning: true, thinkingLevelMap: { off: "disabled" } },
      },
      models: [{ id: "moonshotai/kimi-k3", contextWindow: 1048576, maxTokens: 131072 }],
    },
  },
};

const target: ModelsJson = {
  providers: {
    atomesus: {
      baseUrl: "https://api.atomesus.com",
      api: "openai-completions",
      models: [{ id: "cipher" }],
    },
    nvidia: {
      modelOverrides: {
        "minimaxai/minimax-m3": { reasoning: false }, // наш id — будет заменён
        "openai/gpt-oss-20b": { contextWindow: 999999 }, // чужой — не трогаем
      },
      models: [{ id: "some/custom-model", contextWindow: 4096 }],
    },
  },
};

// 1. Идемпотентность: повторное применение ничего не меняет.
const once = mergeModelsJson(target, source).merged;
const twice = mergeModelsJson(once, source).merged;
assert.deepEqual(twice, once, "мерж не идемпотентен");

// 2. Чужие провайдеры не затрагиваются.
assert.deepEqual(once.providers?.atomesus, target.providers?.atomesus, "чужой провайдер изменён");

// 3. Свой id в modelOverrides заменён целиком, чужой не тронут.
const nvidia = once.providers?.nvidia;
assert.deepEqual(
  nvidia?.modelOverrides?.["minimaxai/minimax-m3"],
  { reasoning: true, thinkingLevelMap: { off: "disabled" } },
  "свой modelOverride не заменён",
);
assert.deepEqual(
  nvidia?.modelOverrides?.["openai/gpt-oss-20b"],
  { contextWindow: 999999 },
  "чужой modelOverride изменён",
);

// 4. models[]: чужие записи сохранены, наша добавлена; дубликат заменяется.
assert.ok(nvidia?.models?.some((m) => m.id === "some/custom-model"), "чужая модель удалена");
assert.ok(nvidia?.models?.some((m) => m.id === "moonshotai/kimi-k3"), "своя модель не добавлена");
const reapply = mergeModelsJson(once, source).merged;
assert.equal(
  reapply.providers?.nvidia?.models?.filter((m) => m.id === "moonshotai/kimi-k3").length,
  1,
  "повторное применение дублирует модель",
);

// 5. Пустой целевой файл — создаётся только наш провайдер.
const fromEmpty = mergeModelsJson({}, source).merged;
assert.ok(fromEmpty.providers?.nvidia?.modelOverrides?.["minimaxai/minimax-m3"], "мерж в пустой файл не сработал");
assert.deepEqual(Object.keys(fromEmpty.providers ?? {}), ["nvidia"], "в пустом файле появились лишние провайдеры");

// 6. Исходный target не мутируется.
assert.deepEqual(target.providers?.nvidia?.modelOverrides?.["minimaxai/minimax-m3"], { reasoning: false });

// 7. summary считает корректно.
const { summary } = mergeModelsJson(target, source);
assert.deepEqual(summary.overrideIds, ["nvidia/minimaxai/minimax-m3"]);
assert.deepEqual(summary.modelIds, ["nvidia/moonshotai/kimi-k3"]);

// 8. Невалидный оверрайд-файл отклоняется.
assert.throws(() => mergeModelsJson(target, { providers: { nvidia: { models: [{ contextWindow: 1 }] } } } as unknown as ModelsJson));

console.log("merge-models: все проверки прошли");
