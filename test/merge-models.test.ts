/**
 * Тесты чистой логики владения оверрайдами (extensions/merge-models.ts).
 * Запуск: node test/merge-models.test.ts (Node ≥ 22.19 — границу задаёт pi; type
 * stripping без флага доступен с 22.18).
 */
import assert from "node:assert/strict";
import {
  applyOverrides,
  deepEqual,
  mergeModelsJson,
  mergeOwnedStates,
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

// 10. applyOverrides: первое применение без леджера, `overwrite: true` — конфликт и перезапись.
const firstApply = applyOverrides(target, source, undefined, true);
assert.equal(firstApply.conflicts.length, 1, "ожидался один конфликт (чужая запись на нашем id)");
assert.equal(firstApply.conflicts[0].modelId, "minimaxai/minimax-m3");
assert.ok(firstApply.changed);
assert.deepEqual(
  firstApply.merged.providers?.nvidia.modelOverrides?.["minimaxai/minimax-m3"],
  source.providers?.nvidia.modelOverrides?.["minimaxai/minimax-m3"],
  "при overwrite конфликтная запись не перезаписана",
);

// 10a. applyOverrides: `overwrite: false` — конфликтная запись пропускается, остальные применяются.
const gentleApply = applyOverrides(target, source, undefined, false);
assert.equal(gentleApply.conflicts.length, 1, "конфликт не обнаружен в мягком режиме");
assert.deepEqual(
  gentleApply.merged.providers?.nvidia.modelOverrides?.["minimaxai/minimax-m3"],
  { reasoning: false },
  "мягкий режим перезаписал пользовательскую запись",
);
assert.ok(
  gentleApply.merged.providers?.nvidia.models?.some((m) => m.id === "moonshotai/kimi-k3"),
  "мягкий режим не применил бесконфликтную запись",
);
assert.equal(gentleApply.state.providers.nvidia.modelOverrides["minimaxai/minimax-m3"], undefined,
  "пропущенная запись попала в леджер применённых");

// 11. applyOverrides: повторное применение по леджеру — конфликтов нет.
const secondApply = applyOverrides(firstApply.merged, source, firstApply.state, true);
assert.equal(secondApply.conflicts.length, 0, "повторное применение даёт конфликты");
assert.equal(secondApply.changed, false, "повторное применение меняет models.json");

// 12. applyOverrides: пользовательская правка после применения.
// overwrite: true — конфликт с перезаписью; overwrite: false — пропуск.
const userEdited: ModelsJson = JSON.parse(JSON.stringify(firstApply.merged));
userEdited.providers!.nvidia.modelOverrides!["minimaxai/minimax-m3"] = { reasoning: true, contextWindow: 123 };
const conflictApply = applyOverrides(userEdited, source, firstApply.state, true);
assert.equal(conflictApply.conflicts.length, 1, "пользовательская правка не обнаружена");
assert.match(conflictApply.conflicts[0].reason, /edited after last apply/);
const conflictGentle = applyOverrides(userEdited, source, firstApply.state, false);
assert.deepEqual(
  conflictGentle.merged.providers?.nvidia.modelOverrides?.["minimaxai/minimax-m3"],
  { reasoning: true, contextWindow: 123 },
  "мягкий режим затёр пользовательскую правку",
);

// 12a. mergeOwnedStates: леджер накапливает записи между применениями.
const mergedStates = mergeOwnedStates(firstApply.state, secondApply.state);
assert.ok(mergedStates.providers.nvidia.modelOverrides["minimaxai/minimax-m3"], "леджер потерял запись");
assert.equal(mergedStates.enabled, true);
const mergedWithEmpty = mergeOwnedStates(undefined, secondApply.state);
assert.ok(mergedWithEmpty.providers.nvidia.models["moonshotai/kimi-k3"], "мерж с пустым предыдущим леджером сломан");

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

// 16. Запись, убранная из оверрайд-файла, удаляется при следующем применении,
// если она совпадает с леджером (пользовательскую версию не трогаем).
{
  // Было применено две записи; затем оверрайд-файл потерял модель.
  const desiredShrunk: ModelsJson = {
    providers: {
      nvidia: {
        modelOverrides: source.providers?.nvidia.modelOverrides,
        // models[] больше нет — запись должна уйти из target
      },
    },
  };
  const withModel = applyOverrides(target, source, undefined, true);
  const afterShrink = applyOverrides(withModel.merged, desiredShrunk, withModel.state, false);
  assert.ok(afterShrink.changed, "удаление устаревшей записи не помечено изменением");
  assert.ok(
    !afterShrink.merged.providers?.nvidia?.models?.some((m) => m.id === "moonshotai/kimi-k3"),
    "устаревшая модель не удалена",
  );
  assert.equal(afterShrink.state.providers.nvidia.models["moonshotai/kimi-k3"], undefined,
    "устаревшая запись осталась в леджере");
  assert.ok(afterShrink.merged.providers?.nvidia?.modelOverrides?.["minimaxai/minimax-m3"],
    "актуальная запись задета чисткой");
  // Чужая модель того же провайдера не задета.
  assert.ok(afterShrink.merged.providers?.nvidia?.models?.some((m) => m.id === "some/custom-model"),
    "чужая модель удалена чисткой");
}

// 16a. Устаревшая запись, изменённая пользователем после применения, не удаляется.
{
  const withModel = applyOverrides(target, source, undefined, true);
  const editedByUser = JSON.parse(JSON.stringify(withModel.merged)) as ModelsJson;
  const idx = editedByUser.providers!.nvidia.models!.findIndex((m) => m.id === "moonshotai/kimi-k3");
  editedByUser.providers!.nvidia.models![idx] = { id: "moonshotai/kimi-k3", contextWindow: 1 };
  const desiredShrunk: ModelsJson = { providers: { nvidia: { modelOverrides: source.providers?.nvidia.modelOverrides } } };
  const kept = applyOverrides(editedByUser, desiredShrunk, withModel.state, false);
  assert.ok(kept.merged.providers?.nvidia?.models?.some((m) => m.id === "moonshotai/kimi-k3"),
    "изменённая пользователем устаревшая запись удалена");
  assert.ok(kept.state.providers.nvidia.models["moonshotai/kimi-k3"],
    "изменённая устаревшая запись не осталась в леджере");
}

console.log("merge-models: все проверки прошли");
