/**
 * i18n-слой расширения (тикет 17): все пользовательские тексты в двух
 * языках — английском (по умолчанию) и русском.
 *
 * Локаль выбирается из окружения: `PI_NVIDIA_PLUS_LANG` имеет приоритет и,
 * если задан, решает сам; дальше первый заданный из `LC_ALL` / `LC_MESSAGES`
 * / `LANG` (`C`/`POSIX` считаются незаданными); значение, не начинающееся на
 * `ru`, даёт английский.
 *
 * Модуль — листовой шов без зависимостей: `setLocale` для тестов и живой
 * смены, `tIn` для явной локали. Подстановки `{name}`; наборы подстановок
 * в обеих локалях обязаны совпадать (проверяет `test/i18n.test.ts`).
 *
 * Не переводится: отладочные метки `debug(...)`, машинные строки
 * (`reason` конфликтов из `merge-models.ts`), имена собственные.
 */

export type Locale = "en" | "ru";

export const MESSAGES = {
  // ── Описания команд ──────────────────────────────────────────────────
  cmdApplyDesc: {
    en: "Apply pi-nvidia-plus overrides to models.json (own ids only; 'force' overwrites conflicting entries)",
    ru: "Применить оверрайды pi-nvidia-plus к models.json (только свои id; 'force' перезаписывает конфликтующие записи)",
  },
  cmdRollbackDesc: {
    en: "Remove pi-nvidia-plus entries from models.json (only entries matching the ledger)",
    ru: "Убрать записи pi-nvidia-plus из models.json (только записи по леджеру)",
  },
  cmdStatusDesc: {
    en: "nvidia: current model, thinking level and what the hook injects",
    ru: "nvidia: текущая модель, уровень мышления и что инжектит хук",
  },
  cmdKeysDesc: {
    en: "NIM key pool status; 'check' probes keys; 'off'/'on' toggles rotation in the live session",
    ru: "Статус пула ключей NIM; 'check' проверяет ключи; 'off'/'on' переключает ротацию в живой сессии",
  },
  cmdKeysCheckDesc: {
    en: "probe each pool key against the selected nvidia model",
    ru: "проверить каждый ключ пула на выбранной nvidia-модели",
  },
  cmdKeysOnDesc: {
    en: "enable key rotation in this session",
    ru: "включить ротацию ключей в этой сессии",
  },
  cmdKeysOffDesc: {
    en: "disable key rotation in this session",
    ru: "выключить ротацию ключей в этой сессии",
  },
  cmdApplyForceDesc: {
    en: "overwrite conflicting models.json entries",
    ru: "перезаписать конфликтующие записи models.json",
  },
  cmdDiscoverDesc: {
    en: "Live NIM discovery: GET /v1/models, add new chat models, mark missing known models",
    ru: "Живое обнаружение NIM: GET /v1/models, добавляет новые чат-модели, помечает отсутствующие известные",
  },

  // ── Прокси (тикеты 10/11/16) ─────────────────────────────────────────
  proxyIntro: {
    en: "pi-nvidia-plus: NIM requests go through proxy {url}",
    ru: "pi-nvidia-plus: запросы NIM идут через прокси {url}",
  },
  proxyNotEnabled: {
    en: "pi-nvidia-plus: proxy not enabled — {error}",
    ru: "pi-nvidia-plus: прокси не включён — {error}",
  },

  keysCheckNoModel: {
    en: "pi-nvidia-plus: key check needs a selected nvidia model — the pool is probed against it",
    ru: "pi-nvidia-plus: проверке ключей нужна выбранная nvidia-модель — пул проверяется по ней",
  },
  keysCheckStart: {
    en: "pi-nvidia-plus: probing {count} keys against {modelId} (one request each, no rotation/retries)…",
    ru: "pi-nvidia-plus: проверяю {count} ключей на {modelId} (по одному запросу, без ротации и повторов)…",
  },
  keysCheckSummary: {
    en: "pi-nvidia-plus: key check on {modelId} in {seconds} s — alive: {ok}, dead: {dead}, rate-limited: {limited}, unclear: {unknown}{deadList}",
    ru: "pi-nvidia-plus: проверка ключей на {modelId} за {seconds} с — живые: {ok}, мёртвые: {dead}, лимитированы: {limited}, не определены: {unknown}{deadList}",
  },
  keysCheckDeadList: {
    en: "; dead (removed from rotation for this session): {ids}",
    ru: "; мёртвые (исключены из ротации до конца сессии): {ids}",
  },
  keysCheckFailed: {
    en: "pi-nvidia-plus: key check failed — {error}",
    ru: "pi-nvidia-plus: проверка ключей не удалась — {error}",
  },
  rotationSwitchMore: {
    en: " (and {count} more switches in the last 5 s)",
    ru: " (и ещё {count} переключений за 5 с)",
  },

  cmdRootDesc: {
    en: "pi-nvidia-plus: subcommand — apply|rollback|status|keys|discover (autocomplete lists them and their args)",
    ru: "pi-nvidia-plus: подкоманда — apply|rollback|status|keys|discover (автодополнение перечислит их и аргументы)",
  },
  cmdUsage: {
    en: "pi-nvidia-plus subcommands: {list}",
    ru: "подкоманды pi-nvidia-plus: {list}",
  },
  cmdUnknown: {
    en: "pi-nvidia-plus: unknown subcommand “{command}”. Available: {list}",
    ru: "pi-nvidia-plus: неизвестная подкоманда «{command}». Доступны: {list}",
  },
  cmdKeysUnknown: {
    en: "pi-nvidia-plus keys: unknown argument “{command}”. Available: {list} (empty shows pool status)",
    ru: "pi-nvidia-plus keys: неизвестный аргумент «{command}». Доступны: {list} (пустое показывает статус пула)",
  },

  // ── Метрики сессии (тикет 20) ─────────────────────────────────────────
  metricsSummary: {
    en: "session: {total} responses ({statuses}){groups}",
    ru: "сессия: ответов {total} ({statuses}){groups}",
  },
  metricsNoResponses: {
    en: "session: no NIM responses observed yet",
    ru: "сессия: ответов NIM пока не наблюдалось",
  },
  metricsGroupRetries: {
    en: "retries: {n}",
    ru: "повторов: {n}",
  },
  metricsGroupKeySwitches: {
    en: "key switches: {n}",
    ru: "переключений ключа: {n}",
  },
  metricsGroupDeadKeys: {
    en: "dead keys: {n}",
    ru: "мёртвых ключей: {n}",
  },
  metricsGroupCooldownWaits: {
    en: "cooldown waits: {n}",
    ru: "ожиданий кулдауна: {n}",
  },
  proxyUndiciNotFound: {
    en: "could not locate pi's undici (bases: {bases})",
    ru: "не удалось найти undici пи (базы: {bases})",
  },
  basesNone: {
    en: "none",
    ru: "нет",
  },
  proxyParseError: {
    en: "could not parse NVIDIA_NIM_PROXY: {value}",
    ru: "не удалось разобрать NVIDIA_NIM_PROXY: {value}",
  },
  proxyUnreachable: {
    en: "NIM proxy {url} unreachable ({detail}) — check NVIDIA_NIM_PROXY",
    ru: "прокси NIM {url} недоступен ({detail}) — проверьте переменную NVIDIA_NIM_PROXY",
  },

  // ── Диагностика 429/5xx (тикет 11) ───────────────────────────────────
  diagRetryIn: {
    en: ", retry in {seconds}s",
    ru: ", повтор через {seconds} с",
  },
  diagRequestId: {
    en: ", request {id}",
    ru: ", запрос {id}",
  },
  diagRateLimit: {
    en: "NIM 429: rate limit{retry}{request}",
    ru: "NIM 429: ограничение частоты{retry}{request}",
  },
  diagServerError: {
    en: "NIM {status}: server error{retry}{request}",
    ru: "NIM {status}: ошибка сервера{retry}{request}",
  },

  // ── Прозрачный транспортный повтор (тикет 14) ────────────────────────
  retryScheduled: {
    en: "NIM {status}: retrying transparently (attempt {attempt} of {total}, in {seconds}s)",
    ru: "NIM {status}: повторяю прозрачно (попытка {attempt} из {total}, через {seconds} с)",
  },
  statusRetryOn: {
    en: "transparent 429/5xx retry: on (up to {count} retries)",
    ru: "прозрачный повтор 429/5xx: вкл (до {count} повторов)",
  },
  statusRetryOff: {
    en: "transparent 429/5xx retry: off (NVIDIA_NIM_TRANSPORT_RETRY)",
    ru: "прозрачный повтор 429/5xx: выкл (NVIDIA_NIM_TRANSPORT_RETRY)",
  },

  // ── Ротация ключей (тикет 15) ────────────────────────────────────────
  rotationIntro: {
    en: "pi-nvidia-plus: NIM key rotation {state} — pool {source}: {count} keys + pi key first. Status: /nvidia-plus-keys",
    ru: "pi-nvidia-plus: ротация ключей NIM {state} — пул {source}: {count} кл. + ключ пи первым. Статус: /nvidia-plus-keys",
  },
  rotationStateOn: {
    en: "on",
    ru: "вкл",
  },
  rotationStateOff: {
    en: "off (enable: /nvidia-plus-keys on)",
    ru: "выкл (включить: /nvidia-plus-keys on)",
  },
  rotationSwitch: {
    en: "NIM {status}: key {from} exhausted — switching to key {to} (pool rotation)",
    ru: "NIM {status}: ключ {from} исчерпан — переключаюсь на ключ {to} (ротация пула)",
  },
  rotationDeadKey: {
    en: "NIM {status}: key {key} is dead — excluded from rotation until the end of the session",
    ru: "NIM {status}: ключ {key} мёртв — исключён из ротации до конца сессии",
  },
  rotationExhausted: {
    en: "NIM {status}: two rotation rounds ({attempts} attempts) did not help — returning the error to pi. Pool status: /nvidia-plus-keys",
    ru: "NIM {status}: два круга ротации ({attempts} попыток) не помогли — отдаю ошибку пи. Статус пула: /nvidia-plus-keys",
  },
  rotationCooldownWait: {
    en: "NIM 429: all pool keys are in cooldown — waiting {seconds}s (interrupt with Esc)",
    ru: "NIM 429: все ключи пула в кулдауне — жду {seconds} с (прерывается по Esc)",
  },
  rotationToggled: {
    en: "pi-nvidia-plus: key rotation {state} (env: NVIDIA_NIM_KEY_ROTATION)",
    ru: "pi-nvidia-plus: ротация ключей {state} (среда: NVIDIA_NIM_KEY_ROTATION)",
  },
  rotationToggledOn: {
    en: "enabled",
    ru: "включена",
  },
  rotationToggledOff: {
    en: "disabled",
    ru: "выключена",
  },
  statusRotationOn: {
    en: "key rotation: on (pool {source}, {count} + pi key)",
    ru: "ротация ключей: вкл (пул {source}, {count} + ключ пи)",
  },
  statusRotationOff: {
    en: "key rotation: off (pool {source}, {count} + pi key)",
    ru: "ротация ключей: выкл (пул {source}, {count} + ключ пи)",
  },
  statusRotationNoPool: {
    en: "key rotation: no pool configured",
    ru: "ротация ключей: пул не задан",
  },

  // ── Пул ключей: файл и предупреждения (тикет 15) ─────────────────────
  keysFileNotJson: {
    en: "keys file is not JSON: {error}",
    ru: "файл ключей — не JSON: {error}",
  },
  keysFileShape: {
    en: 'keys file: expected object {"keys": [...]}',
    ru: 'файл ключей: ожидается объект {"keys": [...]}',
  },
  keysFileNoArray: {
    en: 'keys file: missing "keys" array',
    ru: 'файл ключей: нет массива "keys"',
  },
  keysFileNotStrings: {
    en: 'keys file: "keys" must contain only strings',
    ru: 'файл ключей: в "keys" только строки',
  },
  keysFileEmptyString: {
    en: 'keys file: empty string in "keys"',
    ru: 'файл ключей: пустая строка в "keys"',
  },
  keysFileVanished: {
    en: "keys file {path} vanished — keeping the previous pool ({count} keys)",
    ru: "файл ключей {path} пропал — использую прежний пул ({count} кл.)",
  },
  keysFilePerms: {
    en: "keys file {path} has mode {mode} — 600 recommended (keys are still readable, but better restrict)",
    ru: "файл ключей {path} имеет права {mode} — рекомендуется 600 (ключи читаются, но лучше ограничить)",
  },
  keysFileUnreadable: {
    en: "keys file {path} is not readable ({error})",
    ru: "файл ключей {path} не читается ({error})",
  },
  keysFileParse: {
    en: "keys file {path}: {error}",
    ru: "файл ключей {path}: {error}",
  },
  keysUnresolved: {
    en: "key from {source} did not resolve (no variable in {key}) — skipped",
    ru: "ключ из {source} не разрешился (нет переменной в {key}) — пропущен",
  },
  keysPoolNotSet: {
    en: 'pi-nvidia-plus: no key pool — create ~/.pi/agent/{file} ({"keys": ["nvapi-…", …]}) or set NVIDIA_NIM_KEYS[_FILE]; rotation is inactive',
    ru: 'pi-nvidia-plus: пул ключей не задан — создайте ~/.pi/agent/{file} ({"keys": ["nvapi-…", …]}) или задайте NVIDIA_NIM_KEYS[_FILE]; ротация не активна',
  },
  keysPiKeyMark: {
    en: " (pi key)",
    ru: " (ключ пи)",
  },
  keysStateDead: {
    en: "dead (401/403)",
    ru: "мёртв (401/403)",
  },
  keysStateCooldown: {
    en: "cooldown {seconds}s left",
    ru: "кулдаун ещё {seconds} с",
  },
  keysStateActive: {
    en: "active",
    ru: "активен",
  },
  keysStateReady: {
    en: "ready",
    ru: "готов",
  },
  keysStatusSummary: {
    en: "pi-nvidia-plus: rotation {state}; pool {source} ({count} + pi key); {rows}. Each pi process rotates independently{hint}",
    ru: "pi-nvidia-plus: ротация {state}; пул {source} ({count} + ключ пи); {rows}. Каждый процесс пи ротирует независимо{hint}",
  },
  keysInstalledWithoutRotation: {
    en: "; wrapper installed without rotation — /reload or restart will pick up the pool",
    ru: "; обёртка установлена без ротации — /reload или перезапуск подхватит пул",
  },

  // ── Мёртвые модели (тикеты 08/12) ────────────────────────────────────
  deadObservedMarked: {
    en: "NIM {status}: {modelId} — reported dead ({reason}). Try another model.",
    ru: "NIM {status}: {modelId} — помечена мёртвой ({reason}). Попробуйте другую модель.",
  },
  deadObservedUnknown: {
    en: "NIM {status}: {modelId} — no model with this id in the live catalog. Try another model.",
    ru: "NIM {status}: {modelId} — модели с таким id нет в живом каталоге. Попробуйте другую модель.",
  },
  deadOnSelect: {
    en: "⚠ {modelId}: reported dead on NIM ({reason}). Requests will likely fail — you can still try, or pick another model.",
    ru: "⚠ {modelId}: помечена мёртвой на NIM ({reason}). Запросы скорее всего не пройдут — можно попробовать, либо выбрать другую модель.",
  },
  deadMissingKnown: {
    en: "⚠ {modelId}: was absent from the live NIM catalog at the last discovery ({discoveredAt}). Requests may fail.",
    ru: "⚠ {modelId}: отсутствовала в живом каталоге NIM при последнем обнаружении ({discoveredAt}). Запросы могут не пройти.",
  },

  // ── Ответы провайдера (наблюдатель и хук) ────────────────────────────
  respRateLimit: {
    en: "NIM 429 (rate limit) on {modelId}{retryAfter}{ref}",
    ru: "NIM 429 (рейт-лимит) на {modelId}{retryAfter}{ref}",
  },
  respRateLimitRetryAfter: {
    en: " · retry after {value}",
    ru: " · повтор через {value}",
  },
  respRateLimitNoHeader: {
    en: " · no retry-after header",
    ru: " · нет заголовка retry-after",
  },
  respError: {
    en: "NIM {status} on {modelId}{dead} · retry or pick another model{ref}",
    ru: "NIM {status} на {modelId}{dead} · повторите или выберите другую модель{ref}",
  },
  respErrorPlain: {
    en: "NIM {status} on {modelId}{ref}",
    ru: "NIM {status} на {modelId}{ref}",
  },
  respDeadNote: {
    en: " — reported dead ({reason})",
    ru: " — помечена мёртвой ({reason})",
  },
  respRef: {
    en: " · request {id}",
    ru: " · запрос {id}",
  },

  // ── Применение/откат оверрайдов (тикеты 05/06) ───────────────────────
  applyAutoApplied: {
    en: "pi-nvidia-plus: auto-applied {overrides} modelOverrides + {models} models (ledger: nvidia-plus-models.json)",
    ru: "pi-nvidia-plus: автоприменены {overrides} modelOverrides + {models} models (леджер: nvidia-plus-models.json)",
  },
  applyConflictSkipped: {
    en: 'pi-nvidia-plus: skipped {providerId}/{modelId} ({kind}) — {reason}; run "/nvidia-plus-apply force" to overwrite',
    ru: 'pi-nvidia-plus: пропущено {providerId}/{modelId} ({kind}) — {reason}; выполните "/nvidia-plus-apply force" для перезаписи',
  },
  applyAutoFailed: {
    en: "pi-nvidia-plus: auto-apply failed — {error}",
    ru: "pi-nvidia-plus: автоприменение не удалось — {error}",
  },
  applyConflictHead: {
    en: "pi-nvidia-plus conflict: {providerId}/{modelId} ({kind}) — {reason}",
    ru: "конфликт pi-nvidia-plus: {providerId}/{modelId} ({kind}) — {reason}",
  },
  applyConflictOverwritten: {
    en: "; overwritten",
    ru: "; перезаписано",
  },
  applyConflictPending: {
    en: '; skipped, rerun with "force" to overwrite',
    ru: '; пропущено, повторите с "force" для перезаписи',
  },
  applyApplied: {
    en: "pi-nvidia-plus: applied {overrides} modelOverrides + {models} models to {path} (ledger: {ledger}). Reopen /model to reload.",
    ru: "pi-nvidia-plus: применено {overrides} modelOverrides + {models} models в {path} (леджер: {ledger}). Переоткройте /model для перезагрузки.",
  },
  applyNothingConflicts: {
    en: 'pi-nvidia-plus: nothing applied — all pending entries conflict (use "force" to overwrite).',
    ru: 'pi-nvidia-plus: ничего не применено — все записи конфликтуют (используйте "force" для перезаписи).',
  },
  applyUpToDate: {
    en: "pi-nvidia-plus: models.json already up to date.",
    ru: "pi-nvidia-plus: models.json уже актуален.",
  },
  applyFailed: {
    en: "pi-nvidia-plus: apply failed — {error}",
    ru: "pi-nvidia-plus: применение не удалось — {error}",
  },
  rollbackNothing: {
    en: "pi-nvidia-plus: nothing to roll back (no ledger file).",
    ru: "pi-nvidia-plus: откатывать нечего (нет файла леджера).",
  },
  rollbackKept: {
    en: "pi-nvidia-plus: kept {providerId}/{modelId} ({kind}) — edited since last apply; remove it manually if needed",
    ru: "pi-nvidia-plus: сохранено {providerId}/{modelId} ({kind}) — правилось после последнего применения; удалите вручную, если нужно",
  },
  rollbackRemoved: {
    en: "pi-nvidia-plus: removed {count} entries from models.json; auto-apply disabled until next apply. Reopen /model to reload.",
    ru: "pi-nvidia-plus: удалено записей из models.json: {count}; автоприменение выключено до следующего применения. Переоткройте /model для перезагрузки.",
  },
  rollbackClean: {
    en: "pi-nvidia-plus: models.json already clean; auto-apply disabled.",
    ru: "pi-nvidia-plus: models.json уже чист; автоприменение выключено.",
  },
  rollbackFailed: {
    en: "pi-nvidia-plus: rollback failed — {error}",
    ru: "pi-nvidia-plus: откат не удался — {error}",
  },

  // ── Команда статуса ────────────────────────────────────────────────────
  statusAutoOn: {
    en: "auto-apply on",
    ru: "автоприменение вкл",
  },
  statusAutoOff: {
    en: "auto-apply disabled",
    ru: "автоприменение выкл",
  },
  statusProxyNotConfigured: {
    en: "proxy: not configured (NVIDIA_NIM_PROXY)",
    ru: "прокси: не настроен (NVIDIA_NIM_PROXY)",
  },
  statusProxyInstallError: {
    en: "proxy {url}: not enabled ({error})",
    ru: "прокси {url}: не включён ({error})",
  },
  statusProxyPreflightError: {
    en: "proxy {url}: installed, but {error}",
    ru: "прокси {url}: установлен, но {error}",
  },
  statusProxyInstalled: {
    en: "proxy {url} (installed)",
    ru: "прокси {url} (установлен)",
  },
  statusProxyPlain: {
    en: "proxy {url}",
    ru: "прокси {url}",
  },
  statusNotNvidia: {
    en: "current model is not nvidia ({model})",
    ru: "текущая модель не nvidia ({model})",
  },
  statusThinking: {
    en: "{modelId} · thinking {level}{plan}",
    ru: "{modelId} · thinking {level}{plan}",
  },
  statusNoInjection: {
    en: " · no injection for this family",
    ru: " · нет инжекта для этого семейства",
  },
  statusInjectsPlan: {
    en: " → injects {plan}",
    ru: " → инжектит {plan}",
  },

  // ── Живое обнаружение (тикет 12) ─────────────────────────────────────
  discoverHttpError: {
    en: "pi-nvidia-plus: NIM /v1/models returned HTTP {status}",
    ru: "pi-nvidia-plus: NIM /v1/models вернул HTTP {status}",
  },
  discoverParseError: {
    en: "pi-nvidia-plus: could not parse the NIM /v1/models response",
    ru: "pi-nvidia-plus: не удалось разобрать ответ NIM /v1/models",
  },
  discoverConflict: {
    en: "pi-nvidia-plus: {providerId}/{modelId} ({kind}) — {reason}",
    ru: "pi-nvidia-plus: {providerId}/{modelId} ({kind}) — {reason}",
  },
  discoverSummary: {
    en: "pi-nvidia-plus: discovery — {live} live (chat: {chat}, non-chat filtered: {nonChat}){added}{missing}",
    ru: "pi-nvidia-plus: обнаружение — живых {live} (чат: {chat}, не-чат отсеяно: {nonChat}){added}{missing}",
  },
  discoverAdded: {
    en: "; added new: {ids}",
    ru: "; добавлено новых: {ids}",
  },
  discoverMissing: {
    en: "; missing (suspected dead): {ids}",
    ru: "; отсутствуют (подозрение на смерть): {ids}",
  },
  discoverFailed: {
    en: "pi-nvidia-plus: discovery failed{hint} ({error})",
    ru: "pi-nvidia-plus: обнаружение не удалось{hint} ({error})",
  },
} satisfies Record<string, { en: string; ru: string }>;

export type MessageKey = keyof typeof MESSAGES;

/** Явная локаль (переопределяет окружение); `undefined` — автоопределение. */
let override: Locale | undefined;

export function setLocale(locale: Locale | undefined): void {
  override = locale;
}

/**
 * Выбор локали из окружения: `PI_NVIDIA_PLUS_LANG` (приоритет), дальше первый
 * заданный из `LC_ALL` / `LC_MESSAGES` / `LANG` (`C`/`POSIX` пропускаются);
 * не-`ru` — английский.
 */
export function detectLocale(env: Record<string, string | undefined> = process.env): Locale {
  const explicit = env.PI_NVIDIA_PLUS_LANG?.trim();
  // Явная переменная решает сама (тикет 17: «всё, что не начинается на `ru`,
  // — английский»): провал в окружение был бы молчаливым нарушением приоритета.
  if (explicit) return explicit.toLowerCase().startsWith("ru") ? "ru" : "en";
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const value = env[name]?.trim();
    if (!value || value === "C" || value.toUpperCase() === "POSIX") continue;
    return value.toLowerCase().startsWith("ru") ? "ru" : "en";
  }
  return "en";
}

export function getLocale(): Locale {
  return override ?? detectLocale();
}

/** Сообщение в явной локали (для тестов и предпросмотра). */
export function tIn(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  const template = MESSAGES[key][locale];
  if (!params) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

/** Сообщение в текущей локали. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return tIn(getLocale(), key, params);
}
