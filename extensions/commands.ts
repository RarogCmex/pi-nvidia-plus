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
  description?: string;
}

function item(value: string, name: string, description: string): CompletionItem {
  return { value, label: name, description };
}

/* ------------------------------------------------------------------ */
/* Третий уровень: динамические id для `proxy pin <host:port>`           */
/* ------------------------------------------------------------------ */

export interface PinIdSuggestion {
  /** Display identity (`host:port`). */
  id: string;
  /** Состояние эндпоинта для колонки описания TUI. */
  description: string;
}

/**
 * Провайдер динамических id текущего пула прокси. Каталог команд — данные
 * (чистые), а пул живёт во входной точке: она подсовывает провайдер, который
 * возвращает display identity текущего пула (или пустой список).
 */
let pinIdsProvider: (() => PinIdSuggestion[]) | undefined;

export function setDynamicPinIds(provider: (() => PinIdSuggestion[]) | undefined): void {
  pinIdsProvider = provider;
}

function pinIdItems(prefixValue: string, idPrefix: string): CompletionItem[] | null {
  const ids = pinIdsProvider?.() ?? [];
  const items = ids
    .filter((entry) => entry.id.startsWith(idPrefix))
    .map((entry) => item(`${prefixValue}${entry.id}`, entry.id, entry.description));
  return items.length > 0 ? items : null;
}

/** Подсказка второго уровня в подписи: `keys [check|on|off]`, `proxy [check|pin|on|off]`. */
export function argsHint(command: CommandSpec): string {
  if (!command.args?.length) return "";
  return ` [${command.args.map((a) => a.name.trimEnd()).join("|")}]`;
}

/** Строка для usage/unknown: `keys [check|on|off] — …`. */
export function formatCommandLine(command: CommandSpec): string {
  return `${command.name}${argsHint(command)} — ${command.description}`;
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
    {
      name: "proxy",
      description: t("cmdProxyDesc"),
      // `pin ` — с хвостовым пробелом: value заменяет argumentText целиком и
      // сразу открывает третий уровень (список display identity пула).
      args: [
        arg("check", "cmdProxyCheckDesc"),
        { name: "pin ", description: t("cmdProxyPinDesc") },
        arg("on", "cmdProxyOnDesc"),
        arg("off", "cmdProxyOffDesc"),
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
    if (text.length > 0) {
      const exact = commands.find((c) => c.name === text);
      if (exact?.args?.length) {
        const nested = exact.args.map((a) =>
          item(`${exact.name} ${a.name.trimEnd()}${a.name.endsWith(" ") ? " " : ""}`, a.name.trimEnd(), a.description),
        );
        return nested.length > 0 ? nested : null;
      }
    }
    const items = commands
      .filter((c) => c.name.startsWith(text))
      .map((c) => item(`${c.name} `, `${c.name}${argsHint(c)}`, c.description));
    return items.length > 0 ? items : null;
  }

  const name = text.slice(0, space);
  const rest = text.slice(space).trimStart();
  const command = commands.find((c) => c.name === name);
  if (!command?.args?.length) return null;

  // Третий уровень: аргумент с хвостовым пробелом в каталоге (`pin `) —
  // динамические id текущего пула (тикет 02, контракт value из тикета 27).
  const secondSpace = rest.indexOf(" ");
  if (secondSpace !== -1) {
    const argName = rest.slice(0, secondSpace);
    const argSpec = command.args.find((a) => a.name.trimEnd() === argName);
    if (!argSpec || !argSpec.name.endsWith(" ")) return null;
    const idPrefix = rest.slice(secondSpace + 1);
    if (idPrefix.includes(" ")) return null;
    return pinIdItems(`${name} ${argName} `, idPrefix);
  }

  const items = command.args
    .filter((a) => a.name.trimEnd().startsWith(rest))
    .map((a) => item(`${name} ${a.name.trimEnd()}${a.name.endsWith(" ") ? " " : ""}`, a.name.trimEnd(), a.description));
  return items.length > 0 ? items : null;
}

const ROOT = "nvidia-plus";

/**
 * Разбор текста редактора до курсора. Нужен, потому что Tab после пробела
 * в TUI вызывает провайдер с `force: true`, и CombinedAutocompleteProvider
 * тогда отдаёт файлы, минуя `getArgumentCompletions`.
 */
export function nvidiaPlusArgSuggestions(textBeforeCursor: string): { items: CompletionItem[]; prefix: string } | null {
  if (!textBeforeCursor.startsWith(`/${ROOT}`)) return null;
  const rest = textBeforeCursor.slice(1 + ROOT.length);
  if (rest.length === 0) {
    // Имя набрано, пробела нет: Tab идёт как дополнение команды. Value без `/`,
    // prefix — `/nvidia-plus`; applyCompletion соберёт `/nvidia-plus apply `.
    const items = nvidiaPlusCommands().map((c) =>
      item(`${ROOT} ${c.name}`, `${c.name}${argsHint(c)}`, c.description),
    );
    return { items, prefix: `/${ROOT}` };
  }
  if (!rest.startsWith(" ")) return null;
  const prefix = rest.slice(1);
  const items = completeArgs(prefix, nvidiaPlusCommands());
  if (!items) return null;
  return { items, prefix };
}
