/**
 * Тесты чистой логики владения оверрайдами (extensions/merge-models.ts).
 * Запуск: node test/merge-models.test.ts (Node ≥ 22.6, type stripping).
 */
import assert from "node:assert/strict";
import {
  applyOverrides,
  deepEqual,
  mergeModelsJson,
  rollbackOverrides,
  type ModelsJson,
  type OwnedState,
} from "../extensions/merge-models.ts";

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

// 9. deepEqual: порядок ключей не важен, вложенность сравнивается.
assert.ok(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }));
assert.ok(!deepEqual({ a: 1 }, { a: 2 }));
assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }));
assert.ok(!deepEqual([1, 2], [2, 1]));

// 10. applyOverrides: первое применение без леджера — конфликт на чужую запись.
const firstApply = applyOverrides(target, source, undefined);
assert.equal(firstApply.conflicts.length, 1, "ожидался один конфликт (чужая запись на нашем id)");
assert.equal(firstApply.conflicts[0].modelId, "minimaxai/minimax-m3");
assert.ok(firstApply.changed);

// 11. applyOverrides: повторное применение по леджеру — конфликтов нет.
const secondApply = applyOverrides(firstApply.merged, source, firstApply.state);
assert.equal(secondApply.conflicts.length, 0, "повторное применение даёт конфликты");
assert.equal(secondApply.changed, false, "повторное применение меняет models.json");

// 12. applyOverrides: пользовательская правка после применения — конфликт.
const userEdited: ModelsJson = JSON.parse(JSON.stringify(firstApply.merged));
userEdited.providers!.nvidia.modelOverrides!["minimaxai/minimax-m3"] = { reasoning: true, contextWindow: 123 };
const conflictApply = applyOverrides(userEdited, source, firstApply.state);
assert.equal(conflictApply.conflicts.length, 1, "пользовательская правка не обнаружена");
assert.match(conflictApply.conflicts[0].reason, /edited after last apply/);

// 13. rollbackOverrides: удаляет только записи из леджера, совпадающие с текущими;
// чужие записи того же провайдера остаются.
const rollback = rollbackOverrides(secondApply.merged, firstApply.state);
assert.ok(rollback.changed, "откат ничего не меняет");
assert.equal(
  rollback.merged.providers?.nvidia?.modelOverrides?.["minimaxai/minimax-m3"],
  undefined,
  "наш modelOverride не удалён",
);
assert.ok(
  !rollback.merged.providers?.nvidia?.models?.some((m) => m.id === "moonshotai/kimi-k3"),
  "наша модель не удалена",
);
assert.deepEqual(
  rollback.merged.providers?.nvidia?.modelOverrides?.["openai/gpt-oss-20b"],
  { contextWindow: 999999 },
  "чужой modelOverride удалён",
);
assert.deepEqual(rollback.merged.providers?.atomesus, target.providers?.atomesus, "чужой провайдер задет откатом");
assert.equal(rollback.kept.length, 0);
assert.equal(rollback.remainingState, undefined);

// 14. rollbackOverrides: изменённая пользователем запись пропускается и остаётся в леджере.
const editedForRollback: ModelsJson = JSON.parse(JSON.stringify(firstApply.merged));
editedForRollback.providers!.nvidia.models![1] = { id: "moonshotai/kimi-k3", contextWindow: 1 };
const partialRollback = rollbackOverrides(editedForRollback, firstApply.state);
assert.ok(partialRollback.merged.providers?.nvidia?.models?.some((m) => m.id === "moonshotai/kimi-k3"), "изменённая запись удалена");
assert.equal(partialRollback.kept.length, 1, "изменённая запись не попала в kept");
assert.ok(partialRollback.remainingState?.providers.nvidia.models["moonshotai/kimi-k3"], "kept-запись не сохранена в леджере");
assert.equal(
  partialRollback.merged.providers?.nvidia?.modelOverrides?.["minimaxai/minimax-m3"],
  undefined,
  "совпадающая запись не удалена при откате",
);

// 15. rollback с пустым леджером ничего не делает (защита вызывающего кода).
const emptyLedger: OwnedState = { version: 1, appliedAt: "x", providers: {} };
assert.equal(rollbackOverrides(once, emptyLedger).changed, false);

console.log("merge-models: все проверки прошли");
