/**
 * Иерархия slash-команды `/nvidia-plus` (тикеты 24/27): каталог подкоманд
 * и чистое автодополнение аргументов.
 *
 * Контракт TUI (`CombinedAutocompleteProvider`): `prefix` — весь текст после
 * `/nvidia-plus `, выбранный `value` заменяет этот текст целиком. Поэтому
 * второй уровень возвращает `"keys check"`, а не `"check"`.
 */

import { t, type MessageKey } from "./i18n.ts";

export interface CommandArg {
  name: string;
  description: string;
}

export interface CommandSpec {
  name: string;
  description: string;
  args?: readonly CommandArg[];
}

export interface CompletionItem {
  value: string;
  label: string;
}

function item(value: string, name: string, description: string): CompletionItem {
  return { value, label: `${name} — ${description}` };
}

/** Каталог `/nvidia-plus` в текущей локали (описания через i18n). */
export function nvidiaPlusCommands(): CommandSpec[] {
  const arg = (name: string, key: MessageKey): CommandArg => ({ name, description: t(key) });
  return [
    { name: "apply", description: t("cmdApplyDesc"), args: [arg("force", "cmdApplyForceDesc")] },
    { name: "rollback", description: t("cmdRollbackDesc") },
    { name: "status", description: t("cmdStatusDesc") },
    {
      name: "keys",
      description: t("cmdKeysDesc"),
      args: [
        arg("check", "cmdKeysCheckDesc"),
        arg("on", "cmdKeysOnDesc"),
        arg("off", "cmdKeysOffDesc"),
      ],
    },
    { name: "discover", description: t("cmdDiscoverDesc") },
  ];
}

/**
 * Автодополнение аргументов `/nvidia-plus`. Пустой результат — `null`
 * (TUI тогда не показывает выпадашку). Первый уровень даёт value с хвостовым
 * пробелом: TUI сам пробел к аргументам не добавляет.
 */
export function completeArgs(prefix: string, commands: readonly CommandSpec[]): CompletionItem[] | null {
  const text = prefix.trimStart();
  const space = text.indexOf(" ");
  if (space === -1) {
    const items = commands
      .filter((c) => c.name.startsWith(text))
      .map((c) => item(`${c.name} `, c.name, c.description));
    return items.length > 0 ? items : null;
  }

  const name = text.slice(0, space);
  const rest = text.slice(space).trimStart();
  if (rest.includes(" ")) return null;

  const command = commands.find((c) => c.name === name);
  if (!command?.args?.length) return null;

  const items = command.args
    .filter((a) => a.name.startsWith(rest))
    .map((a) => item(`${name} ${a.name}`, a.name, a.description));
  return items.length > 0 ? items : null;
}
