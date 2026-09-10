/**
 * Тесты автодополнения `/nvidia-plus` (тикет 27): первый и второй уровень.
 * Шов: completeArgs(prefix, commands) — prefix это весь текст после
 * `/nvidia-plus `; value пункта заменяет prefix целиком (контракт TUI
 * CombinedAutocompleteProvider).
 */
import assert from "node:assert/strict";
import { completeArgs, nvidiaPlusCommands, type CommandSpec } from "../extensions/commands.ts";
import { setLocale } from "../extensions/i18n.ts";

const catalog: CommandSpec[] = [
  { name: "apply", description: "apply-desc", args: [{ name: "force", description: "force-desc" }] },
  { name: "rollback", description: "rollback-desc" },
  { name: "status", description: "status-desc" },
  {
    name: "keys",
    description: "keys-desc",
    args: [
      { name: "check", description: "check-desc" },
      { name: "on", description: "on-desc" },
      { name: "off", description: "off-desc" },
    ],
  },
  { name: "discover", description: "discover-desc" },
];

function values(prefix: string): string[] | null {
  const items = completeArgs(prefix, catalog);
  return items ? items.map((i) => i.value) : null;
}

// 1. Пустой prefix — все подкоманды первого уровня; value с пробелом,
//    чтобы Tab сразу открыл второй уровень (TUI сам пробел к args не добавляет).
{
  assert.deepEqual(values(""), ["apply ", "rollback ", "status ", "keys ", "discover "]);
}

// 2. Префикс имени фильтрует первый уровень.
{
  assert.deepEqual(values("k"), ["keys "]);
  assert.deepEqual(values("keys"), ["keys "]);
  assert.deepEqual(values("a"), ["apply "]);
  assert.equal(values("z"), null);
}

// 3. Подпись первого уровня: «имя — описание», без хвостового пробела value.
{
  const items = completeArgs("status", catalog);
  assert.deepEqual(items, [{ value: "status ", label: "status — status-desc" }]);
}

// 4. После имени и пробела — второй уровень; value включает подкоманду,
//    потому что TUI заменяет весь argumentText.
{
  assert.deepEqual(values("keys "), ["keys check", "keys on", "keys off"]);
  assert.deepEqual(values("keys c"), ["keys check"]);
  assert.deepEqual(values("keys check"), ["keys check"]);
  assert.deepEqual(values("apply "), ["apply force"]);
  assert.deepEqual(values("apply f"), ["apply force"]);
}

// 5. Подпись второго уровня — имя аргумента, не полный value.
{
  const items = completeArgs("keys c", catalog);
  assert.deepEqual(items, [{ value: "keys check", label: "check — check-desc" }]);
}

// 6. Нет второго уровня / неизвестная подкоманда / третий токен / неизвестный
//    аргумент — молча null (подсказка тогда в handler, не в Tab).
{
  assert.equal(values("status "), null);
  assert.equal(values("status x"), null);
  assert.equal(values("nope "), null);
  assert.equal(values("keys check extra"), null);
  assert.equal(values("keys x"), null);
}

// 7. Лидирующие пробелы отбрасываются; value канонический (замена вычищает prefix).
{
  assert.deepEqual(values("  keys"), ["keys "]);
  assert.deepEqual(values("  keys c"), ["keys check"]);
}

// 8. Лишние пробелы между токенами не ломают второй уровень.
{
  assert.deepEqual(values("keys  c"), ["keys check"]);
}

// 9. Живой каталог nvidia-plus: keys и apply имеют второй уровень.
{
  setLocale("en");
  const names = nvidiaPlusCommands().map((c) => c.name);
  assert.deepEqual(names, ["apply", "rollback", "status", "keys", "discover"]);
  const keys = completeArgs("keys ", nvidiaPlusCommands());
  assert.deepEqual(keys?.map((i) => i.value), ["keys check", "keys on", "keys off"]);
  assert.equal(keys?.[0].label, "check — probe each pool key against the selected nvidia model");
  const apply = completeArgs("apply ", nvidiaPlusCommands());
  assert.deepEqual(apply?.map((i) => i.value), ["apply force"]);
  assert.equal(apply?.[0].label, "force — overwrite conflicting models.json entries");
  setLocale(undefined);
}

console.log("commands: все проверки прошли");
