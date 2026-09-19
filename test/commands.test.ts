/**
 * Тесты автодополнения `/nvidia-plus` (тикет 27): первый и второй уровень.
 * Шов: completeArgs(prefix, commands) — prefix это весь текст после
 * `/nvidia-plus `; value пункта заменяет prefix целиком (контракт TUI
 * CombinedAutocompleteProvider).
 */
import assert from "node:assert/strict";
import { completeArgs, nvidiaPlusArgSuggestions, nvidiaPlusCommands, setDynamicPinIds, type CommandSpec } from "../extensions/commands.ts";
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
//    Подпись несёт подсказку второго уровня: keys [check|on|off], apply [force].
{
  const items = completeArgs("", catalog);
  assert.deepEqual(items?.map((i) => i.value), ["apply ", "rollback ", "status ", "keys ", "discover "]);
  assert.deepEqual(items?.map((i) => i.label), [
    "apply [force]",
    "rollback",
    "status",
    "keys [check|on|off]",
    "discover",
  ]);
  assert.deepEqual(items?.map((i) => i.description), [
    "apply-desc",
    "rollback-desc",
    "status-desc",
    "keys-desc",
    "discover-desc",
  ]);
}

// 2. Префикс имени фильтрует первый уровень; точное имя с детьми сразу
//    раскрывает второй (Tab без пробела иначе уникально допишет `keys `
//    и закроет выпадашку).
{
  assert.deepEqual(values("k"), ["keys "]);
  assert.deepEqual(values("keys"), ["keys check", "keys on", "keys off"]);
  assert.deepEqual(values("a"), ["apply "]);
  assert.deepEqual(values("apply"), ["apply force"]);
  assert.deepEqual(values("status"), ["status "]);
  assert.equal(values("z"), null);
}

// 3. Первый уровень без аргументов: label — имя, description — отдельно (колонка TUI).
{
  const items = completeArgs("status", catalog);
  assert.deepEqual(items, [{ value: "status ", label: "status", description: "status-desc" }]);
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

// 5. Подпись второго уровня — имя аргумента, не полный value; описание в description.
{
  const items = completeArgs("keys c", catalog);
  assert.deepEqual(items, [{ value: "keys check", label: "check", description: "check-desc" }]);
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
  assert.deepEqual(values("  keys"), ["keys check", "keys on", "keys off"]);
  assert.deepEqual(values("  keys c"), ["keys check"]);
}

// 8. Лишние пробелы между токенами не ломают второй уровень.
{
  assert.deepEqual(values("keys  c"), ["keys check"]);
}

// 9. Живой каталог nvidia-plus: keys и apply имеют второй уровень; proxy — третий.
{
  setLocale("en");
  const names = nvidiaPlusCommands().map((c) => c.name);
  assert.deepEqual(names, ["apply", "rollback", "status", "keys", "proxy", "discover"]);
  const keys = completeArgs("keys ", nvidiaPlusCommands());
  assert.deepEqual(keys?.map((i) => i.value), ["keys check", "keys on", "keys off"]);
  assert.equal(keys?.[0].label, "check");
  assert.equal(keys?.[0].description, "probe each pool key against the selected nvidia model");
  const apply = completeArgs("apply ", nvidiaPlusCommands());
  assert.deepEqual(apply?.map((i) => i.value), ["apply force"]);
  assert.equal(apply?.[0].label, "force");
  assert.equal(apply?.[0].description, "overwrite conflicting models.json entries");
  const root = completeArgs("", nvidiaPlusCommands());
  assert.equal(root?.find((i) => i.value === "keys ")?.label, "keys [check|on|off]");
  assert.equal(root?.find((i) => i.value === "apply ")?.label, "apply [force]");
  const proxy = completeArgs("proxy ", nvidiaPlusCommands());
  assert.deepEqual(proxy?.map((i) => i.value), ["proxy check", "proxy pin ", "proxy on", "proxy off"]);
  assert.equal(root?.find((i) => i.value === "proxy ")?.label, "proxy [check|pin|on|off]");

  // Третий уровень: `proxy pin ` (с пробелом) открывает динамический список id.
  setDynamicPinIds(() => [
    { id: "a.example:8080", description: "ready" },
    { id: "b.example:3128", description: "cooldown 42s left" },
  ]);
  const third = completeArgs("proxy pin ", nvidiaPlusCommands());
  assert.deepEqual(third?.map((i) => i.value), ["proxy pin a.example:8080", "proxy pin b.example:3128"]);
  assert.deepEqual(third?.map((i) => i.label), ["a.example:8080", "b.example:3128"]);
  assert.deepEqual(third?.map((i) => i.description), ["ready", "cooldown 42s left"]);
  // Фильтр по префиксу id.
  const filtered = completeArgs("proxy pin b", nvidiaPlusCommands());
  assert.deepEqual(filtered?.map((i) => i.value), ["proxy pin b.example:3128"]);
  // Пустой пул — подсказки id нет.
  setDynamicPinIds(() => []);
  assert.equal(completeArgs("proxy pin ", nvidiaPlusCommands()), null);
  setDynamicPinIds(undefined);
  setLocale(undefined);
}

// 10. Разбор строки редактора: Tab после пробела в TUI идёт с force=true
//    и CombinedAutocompleteProvider тогда отдаёт файлы, не getArgumentCompletions.
//    nvidiaPlusArgSuggestions перехватывает `/nvidia-plus …` целиком.
{
  assert.equal(nvidiaPlusArgSuggestions("/nvidia-plus-keys"), null);
  assert.equal(nvidiaPlusArgSuggestions("/nvidia-plu"), null, "неполное имя — встроенному провайдеру");
  assert.equal(nvidiaPlusArgSuggestions("/model "), null);
  assert.equal(nvidiaPlusArgSuggestions("nvidia-plus "), null);

  // `/nvidia-plus` без пробела: Tab не добавляет пробел, TUI считает это
  // дополнением имени команды (prefix со слэшем, value без ведущего `/`).
  const noSpace = nvidiaPlusArgSuggestions("/nvidia-plus");
  assert.equal(noSpace?.prefix, "/nvidia-plus");
  assert.deepEqual(noSpace?.items.map((i) => i.value), [
    "nvidia-plus apply",
    "nvidia-plus rollback",
    "nvidia-plus status",
    "nvidia-plus keys",
    "nvidia-plus proxy",
    "nvidia-plus discover",
  ]);
  assert.deepEqual(noSpace?.items.map((i) => i.label), [
    "apply [force]",
    "rollback",
    "status",
    "keys [check|on|off]",
    "proxy [check|pin|on|off]",
    "discover",
  ]);

  const root = nvidiaPlusArgSuggestions("/nvidia-plus ");
  assert.equal(root?.prefix, "");
  assert.deepEqual(root?.items.map((i) => i.value), ["apply ", "rollback ", "status ", "keys ", "proxy ", "discover "]);

  const keys = nvidiaPlusArgSuggestions("/nvidia-plus keys ");
  assert.equal(keys?.prefix, "keys ");
  assert.deepEqual(keys?.items.map((i) => i.value), ["keys check", "keys on", "keys off"]);

  const partial = nvidiaPlusArgSuggestions("/nvidia-plus k");
  assert.equal(partial?.prefix, "k");
  assert.deepEqual(partial?.items.map((i) => i.value), ["keys "]);

  const keysExact = nvidiaPlusArgSuggestions("/nvidia-plus keys");
  assert.equal(keysExact?.prefix, "keys");
  assert.deepEqual(keysExact?.items.map((i) => i.value), ["keys check", "keys on", "keys off"]);

  // proxy: второй уровень — `pin ` с хвостовым пробелом (контракт value),
  // третий уровень — id текущего пула через редакторный перехват.
  const proxy = nvidiaPlusArgSuggestions("/nvidia-plus proxy ");
  assert.equal(proxy?.prefix, "proxy ");
  assert.deepEqual(proxy?.items.map((i) => i.value), ["proxy check", "proxy pin ", "proxy on", "proxy off"]);

  setDynamicPinIds(() => [{ id: "us.ntt:42435", description: "ready" }]);
  const pinIds = nvidiaPlusArgSuggestions("/nvidia-plus proxy pin ");
  assert.equal(pinIds?.prefix, "proxy pin ");
  assert.deepEqual(pinIds?.items.map((i) => i.value), ["proxy pin us.ntt:42435"]);
  const pinPartial = nvidiaPlusArgSuggestions("/nvidia-plus proxy pin us");
  assert.deepEqual(pinPartial?.items.map((i) => i.value), ["proxy pin us.ntt:42435"]);
  setDynamicPinIds(undefined);
}

console.log("commands: все проверки прошли");
