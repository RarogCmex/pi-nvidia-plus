/**
 * Тесты шва C: файловый слой с параметризованными путями (extensions/store.ts).
 * Запуск: node test/store.test.ts
 * Все пробы — во временном каталоге; реальный `~/.pi/agent` не трогается.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFiles, rollbackFiles, loadState, storePaths, type StorePaths } from "../extensions/store.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-store-"));

function freshDir(label: string): string {
  const d = join(dir, label);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

function writeOverrides(overridesFile: string): void {
  writeFileSync(
    overridesFile,
    JSON.stringify({
      providers: {
        nvidia: {
          modelOverrides: {
            "minimaxai/minimax-m3": { reasoning: true, thinkingLevelMap: { off: "disabled" } },
          },
          models: [{ id: "moonshotai/kimi-k3", contextWindow: 1048576, maxTokens: 131072 }],
        },
      },
    }),
    "utf8",
  );
}

function readModels(paths: StorePaths): any {
  return JSON.parse(readFileSync(paths.modelsJson, "utf8"));
}

// 1. Пути строятся от базового каталога; дефолты — как раньше (~/.pi/agent).
const paths = storePaths("/tmp/base");
assert.equal(paths.modelsJson, "/tmp/base/models.json");
assert.equal(paths.stateFile, "/tmp/base/nvidia-plus-models.json");
assert.equal(paths.backupFile, "/tmp/base/models.json.bak-pi-nvidia-plus");
const defaults = storePaths();
assert.ok(defaults.modelsJson.endsWith(join(".pi", "agent", "models.json")), "дефолт сменился");

// 2. Применение в чистый каталог создаёт models.json и леджер; повтор — идемпотентен.
{
  const base = freshDir("apply-clean");
  const overridesFile = join(base, "overrides.json");
  writeOverrides(overridesFile);
  const p = storePaths(base, overridesFile);

  const first = applyFiles(false, p);
  assert.ok(first.changed, "первое применение ничего не изменило");
  assert.deepEqual(first.summary.overrideIds, ["nvidia/minimaxai/minimax-m3"]);
  assert.ok(first.summary.modelIds.includes("nvidia/moonshotai/kimi-k3"));
  const models = readModels(p);
  assert.ok(models.providers.nvidia.modelOverrides["minimaxai/minimax-m3"]);
  assert.equal(loadState(p)?.enabled, true, "леджер не активен после применения");

  const second = applyFiles(false, p);
  assert.equal(second.changed, false, "повторное применение меняет файлы");
  assert.equal(second.conflicts.length, 0);
}

// 3. Пользовательская запись на нашем id — конфликт; без `force` пропускается.
{
  const base = freshDir("apply-conflict");
  const overridesFile = join(base, "overrides.json");
  writeOverrides(overridesFile);
  const p = storePaths(base, overridesFile);
  writeFileSync(
    p.modelsJson,
    JSON.stringify({ providers: { nvidia: { modelOverrides: { "minimaxai/minimax-m3": { reasoning: false } } } } }),
    "utf8",
  );

  const gentle = applyFiles(false, p);
  assert.equal(gentle.conflicts.length, 1, "конфликт не обнаружен");
  assert.equal(readModels(p).providers.nvidia.modelOverrides["minimaxai/minimax-m3"].reasoning, false,
    "мягкое применение затёрло пользовательскую запись");

  const forced = applyFiles(true, p);
  assert.equal(readModels(p).providers.nvidia.modelOverrides["minimaxai/minimax-m3"].reasoning, true,
    "force не перезаписал конфликт");
  assert.ok(forced.changed);
}

// 4. Откат удаляет наши записи, гасит автоприменение и создаёт бэкап рядом с models.json.
{
  const base = freshDir("rollback");
  const overridesFile = join(base, "overrides.json");
  writeOverrides(overridesFile);
  const p = storePaths(base, overridesFile);

  applyFiles(true, p);
  const result = rollbackFiles(p);
  assert.ok(result.changed && result.hadState);
  assert.equal(result.removed.length, 2, "откат не убрал обе записи");
  const models = readModels(p);
  assert.equal(models.providers?.nvidia?.modelOverrides?.["minimaxai/minimax-m3"], undefined);
  assert.ok(!models.providers?.nvidia?.models?.some((m: any) => m.id === "moonshotai/kimi-k3"));
  assert.equal(loadState(p)?.enabled, false, "откат не погасил автоприменение");
  readFileSync(p.backupFile, "utf8"); // бэкап существует и читается

  // повторный откат — нечего делать, но флаг гасится
  const again = rollbackFiles(p);
  assert.equal(again.changed, false);
  assert.ok(again.hadState, "леджер исчез после первого отката");

  // после отката повторное применение снова работает
  const reapply = applyFiles(false, p);
  assert.ok(reapply.changed, "применение после отката не сработало");
}

// 5. Откат без леджера — ничего не делает.
{
  const base = freshDir("rollback-empty");
  const p = storePaths(base, join(base, "overrides.json"));
  const result = rollbackFiles(p);
  assert.equal(result.hadState, false);
  assert.equal(result.changed, false);
}

// 6. Оверрайд-файл с чужим провайдером отклоняется.
{
  const base = freshDir("foreign");
  const overridesFile = join(base, "overrides.json");
  writeFileSync(overridesFile, JSON.stringify({ providers: { openai: {} } }), "utf8");
  const p = storePaths(base, overridesFile);
  assert.throws(() => applyFiles(false, p), /foreign providers/);
}

rmSync(dir, { recursive: true, force: true });
console.log("store: все проверки прошли");
