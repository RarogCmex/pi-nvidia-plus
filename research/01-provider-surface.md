# 01 — Поверхность пи/pi-ai для улучшения встроенного провайдера nvidia на месте

Тикет: 01 — поверхность провайдера (внутренние рабочие заметки не публикуются).
Дата: 2026-08-26. Источники — первичные: исходники установленного
`@earendil-works/pi-coding-agent` и его `pi-ai`, плюс официальная документация
в поставке. Живые пробы не требовались (вопрос про код пи).

Обозначения:
- `PI` = `~/.local/lib/node_modules/@earendil-works/pi-coding-agent`
- `PIAI` = `$PI/node_modules/@earendil-works/pi-ai`

---

## 1. Что делает `pi.registerProvider("nvidia", ...)` для встроенного провайдера

**Это слой поверх встроенного провайдера, а не деструктивная замена.**
Цепочка: `pi.registerProvider` → `ExtensionRunner.runtime.registerProvider`
(`$PI/dist/core/extensions/runner.js:9125`) → `ModelRegistry.registerProvider`
(`$PI/dist/core/model-registry.js:85`) → `ModelRuntime.registerProvider`
(`$PI/dist/core/model-runtime.js:555`).

`ModelRuntime` держит слои (`$PI/dist/core/model-runtime.js:42-50`):

- `builtins` — встроенные провайдеры из `pi-ai/providers/all` (nvidia в том числе);
- `nativeExtensionProviders` — полные `Provider`-объекты (`registerNativeProvider`);
- `extensionProviders` — конфиги из `registerProvider(name, config)`;
- `config` — `models.json` пользователя (`~/.pi/agent/models.json`).

`recomposeProvider` (`model-runtime.js:133-158`): если оверлеев нет — встроенный
провайдер используется **без изменений** («so its auth/login/stream behavior is
exact»); иначе собирается `composeModelProvider(providerId, base, config,
extension)` (`$PI/dist/core/provider-composer.js`).

### Семантика моделей

Композиция моделей: `applyExtension(providerId, applyModelsJson(providerId,
base.getModels(), config), extension)` (`provider-composer.js`,
`composeModelProvider`).

- **С массивом `models`** — список моделей **полностью заменяется**:
  `applyExtension` возвращает `config.models.map(...)`; в него попадают только
  модели расширения. Каждая дефиниция наследует дефолты `api`/`baseUrl` у
  встроенной модели с тем же `id` (иначе у первой встроенной модели).
  Это подтверждает предположение `goal.md`: «registerProvider заменяет весь
  список моделей».
- **Без `models`** — встроенные модели сохраняются; возможен только
  `baseUrl`-оверрайд (пример в доках: `pi.registerProvider("anthropic", {
  baseUrl })` «keeps all models», `$PI/docs/extensions.md:1824-1827`).

### Авторизация

`composeApiKeyAuth` (`provider-composer.js`) наследует `base.auth.apiKey`, если
расширение не задаёт свой `apiKey`. Для nvidia встроенный
`envApiKeyAuth("NVIDIA API key", ["NVIDIA_API_KEY"])`
(`$PIAI/dist/providers/nvidia.js:10`) **сохраняется**: уже настроенный ключ
пользователя (и сохранённые креды через `inherited.resolve`) продолжают
работать при перерегистрации.

### Стриминг

`streamWith` в `composeModelProvider`: если `base` поддерживает `api` модели
(для nvidia это `openai-completions`), используется `base.stream`/
`base.streamSimple` — то есть **встроенный стриминг сохраняется** при
перерегистрации с тем же `api`. Кастомный `streamSimple` расширения
используется только если расширение само его задало (+`api`).

### Нужен ли `unregisterProvider` beforehand?

Нет. Повторная регистрация мёржит определённые значения поверх предыдущей
регистрации, сохраняя `undefined` (`model-runtime.js:560-568`, комментарий
«Re-registration merges defined values over the previous registration»).
`unregisterProvider` удаляет оверлей и **восстанавливает встроенный провайдер**
(`model-runtime.js:591-596`; доки: `$PI/docs/extensions.md:1844-1846` —
«Built-in models that were overridden by the provider are restored»). Обе
операции применяются немедленно после фазы загрузки, `/reload` не нужен
(доки: `extensions.md:1721-1723, 1848-1849`).

### Три ловушки перерегистрации (важно для тикета 05)

1. **Теряются пер-модельные `headers` каталога.** Дефиниции моделей расширения
   проходят `applyExtension`/`modelFromJson` с `headers: undefined`
   (`provider-composer.js`). Каталогный `NVCF-POLL-SECONDS: 3600`
   (`$PIAI/dist/providers/data/nvidia.json`, стоит на всех 32 моделях) при этом
   исчезает. Его надо явно переопределить в `headers` каждой дефиниции —
   тогда он вернётся в запрос через `rawModelHeaders` →
   `resolveConfiguredModelHeaders` → auth-headers → `options.headers`
   (`provider-composer.js: rawModelHeaders, resolveCompatibilityRequestConfig`;
   `$PIAI/dist/api/openai-completions.js:516-540` — `createClient` мёржит
   `model.headers`, затем `optionsHeaders` последними).
2. **Отбрасывается remote-оверлей каталога.** Встроенные провайдеры обёрнуты
   `withRemoteCatalog` (`$PI/dist/core/remote-catalog-provider.js`; в
   `ModelRuntime.create`, `model-runtime.js:88-94`): встроенный список мёржится
   с оверлеем с `https://pi.dev/api/models/providers/nvidia` (интервал проверки
   4 часа, `REMOTE_CATALOG_REFRESH_INTERVAL_MS`; персистится в
   `~/.pi/agent/models-store.json`). На этой машине оверлей уже есть:
   22 модели, `lastModified ≈ 2026-08`. При регистрации с `models` этот оверлей
   не влияет на итоговый список (полная замена); без `models` — сохраняется.
   `mergeModels` заменяет по `id` и добавляет новые
   (`remote-catalog-provider.js:7-16`).
3. **Слой `models.json` пользователя остаётся сверху.** `modelOverrides` из
   `models.json` применяются последними и умеют мёржить метаданные:
   `reasoning`, `thinkingLevelMap` (мёрдж по ключам), `compat` (включая
   `chatTemplateKwargs`), `headers`, `contextWindow`, `maxTokens`
   (`provider-composer.js: applyModelsJson + applyModelOverride`,
   `ModelOverrideSchema` в бандле). Это альтернативный путь правки метаданных
   без перерегистрации, но расширение не может поставлять `models.json` за
   пользователя — только документировать.

---

## 2. Хук `before_provider_request`: возможности и границы

- **Только тело запроса.** Хук вызывается через `onPayload` агента
  (`$PI/dist/core/sdk.js:209-215`) после того, как провайдер-специфичный
  payload построен (для `openai-completions`: `$PIAI/dist/api/openai-completions.js:176`
  — `options.onPayload(params, model)`), и перед отправкой. Возврат `undefined`
  — без изменений; любое другое значение заменяет payload для следующих
  обработчиков и для запроса (`$PI/dist/core/extensions/runner.js:776-800`,
  `$PI/docs/extensions.md:687-700`).
- **Метаданные модели хуком не меняются** — метаданные берутся из реестра на
  этапе построения payload; хук видит их только чтение.
- **Уровень мышления виден.** `ctx` хука (`runner.js: createContext`)
  предоставляет `ctx.model` (текущая модель), `ctx.thinkingLevel` (выбранный
  уровень), `ctx.modelRegistry`, `ctx.ui` и др. В самом `event` — только
  `payload`, но `ctx.thinkingLevel`/`ctx.model` достаточно, чтобы принимать
  решения и переписывать payload (P0/P2).
- Ретраи переиспользуют те же заголовки/хук не перезапускают
  (`extensions.md:678-679` — «Runs once per provider request; retries reuse the
  same headers»).
- Смежные швы: `before_provider_headers` (правка заголовков,
  `$PI/dist/core/sdk.js:201-205`) и `after_provider_response`
  (`event.status`, `event.headers` — нормализованные заголовки ответа;
  `$PI/docs/extensions.md:705-716`, `$PI/dist/core/sdk.js:216-225`; вызывается
  из стриминга: `$PIAI/dist/api/openai-completions.js:190`). Для P4 (429)
  этого достаточно, с оговоркой из доков: «Header availability depends on
  provider and transport» — для `openai-completions` заголовки доступны.

**Вывод:** хук покрывает инжект параметров в тело запроса (thinking,
нормализация), но не метаданные каталога.

---

## 3. Где живут «плюсы» встроенного nvidia

| Плюс | Где живёт | Специфичность | Что переносить при перерегистрации |
|---|---|---|---|
| `NVCF-POLL-SECONDS: 3600` | пер-модельные `headers` в каталоге `$PIAI/dist/providers/data/nvidia.json` (все 32 модели) | данные каталога, не код; в запрос попадают через `createClient` (`openai-completions.js:516`) | **да**: переопределить в `headers` каждой модели расширения (ловушка №1) |
| Ретраи `ResourceExhausted` | общий шаблон ретраев `pi-ai`: `RETRYABLE_PROVIDER_ERROR_PATTERN` включает `"ResourceExhausted"` с комментарием «gRPC based providers (e.g. NVIDIA NIM)» (`$PIAI/dist/utils/retry.js:76`); применяется агент-уровневым авторетраем (`$PI/dist/core/agent-session.js:2177` — `isRetryableAssistantError`, бюджет из `settings.retry`) | **общий механизм**, не специфика провайдера | ничего: работает для любого провайдера через тот же путь |
| Attribution-хедеры | `$PI/dist/core/provider-attribution.js`: для моделей с `provider === "nvidia"` **или** `baseUrl` на `integrate.api.nvidia.com` добавляется `X-BILLING-INVOKE-ORIGIN: Pi` (только при включённом install-telemetry); применяется в `transformHeaders` стрим-обёртки (`$PI/dist/core/sdk.js:201`, `mergeProviderAttributionHeaders`) | код пи-кодинг-агента, ключ — `provider`/хост | ничего: при `providerId = "nvidia"` и том же `baseUrl` продолжается автоматически |
| Авторизация `NVIDIA_API_KEY` / сохранённые креды | `envApiKeyAuth("NVIDIA API key", ["NVIDIA_API_KEY"])` (`$PIAI/dist/providers/nvidia.js:10`) | наследуется `composeApiKeyAuth` | ничего, если не задавать свой `apiKey` |
| Стриминг `openai-completions` | общий `$PIAI/dist/api/openai-completions.js` | общий | ничего: `composeModelProvider` делегирует в `base.streamSimple` |

**Вывод:** единственный реально теряемый при перерегистрации плюс —
пер-модельные заголовки каталога (и, формально, оверлей каталога, если он не
нужен). Остальное либо общее, либо привязано к `provider`/`baseUrl`, которые
сохраняются.

---

## 4. Как пи решает показывать уровни мышления в UI

- Селектор уровней: `model.reasoning ? getSupportedThinkingLevels(model) :
  ["off"]` (`$PI/dist/modes/interactive/components/settings-selector.js:424`);
  тот же источник использует `agent-session`
  (`$PI/dist/core/agent-session.js:1331`).
- `getSupportedThinkingLevels` (`$PIAI/dist/models.js:551-559`):
  - `reasoning: false` → только `["off"]`;
  - уровни, чьё значение в `thinkingLevelMap` равно `null`, исключаются;
  - `xhigh`/`max` появляются **только при явном маппинге** в `thinkingLevelMap`
    (`mapped !== undefined`); `off..high` доступны по умолчанию при
    `reasoning: true`.
- Выбранный уровень клампится `clampThinkingLevel` (`$PIAI/dist/models.js:560`)
  и попадает в стриминг как `options.reasoningEffort`
  (`$PIAI/dist/api/openai-completions.js:507-510`).

**Итого: два поля управляют доступностью уровней — `model.reasoning` и
`model.thinkingLevelMap`.** Оба меняются только через метаданные
(перерегистрация или `models.json modelOverrides`), хуком — нельзя.
`compat.supportsReasoningEffort` влияет лишь на запись `reasoning_effort` в
тело запроса (`openai-completions.js:703-712`), не на UI.

Текущий каталог (проверено по `$PIAI/dist/providers/data/nvidia.json`):
32 модели; `reasoning: true` у 23; `thinkingLevelMap` — только у
`deepseek-ai/deepseek-v4-flash-0731` (`high`/`max`); `supportsReasoningEffort`
нет ни у кого; `thinkingFormat` задан только у того же deepseek (`"deepseek"`).

### Нативные механизмы инжекта thinking (альтернатива/дополнение к хуку)

В `openai-completions.js` (ветки `compat.thinkingFormat`, все гейтятся
`model.reasoning`, строки ~600-700) уже есть форматы:

- `"chat-template"` — пишет `chat_template_kwargs` из
  `compat.chatTemplateKwargs`; значения могут быть переменными:
  `{"$var": "thinking.enabled"}` → `!!reasoningEffort`,
  `{"$var": "thinking.effort"}` → значение из `thinkingLevelMap` по уровню
  (или уровень как есть), `{"$var": "thinking.budget"}`; флаг `omitWhenOff`
  убирает ключ при `off` (`openai-completions.js:745-772` —
  `buildChatTemplateValues`/`resolveChatTemplateKwargValue`). Этого достаточно
  для Qwen (`enable_thinking`), GLM (`enable_thinking` + маппинг усилий),
  DeepSeek через `chat_template_kwargs` и т.п.
- `"qwen"` — top-level `enable_thinking`; `"zai"` — `thinking.type`
  enabled/disabled (+`clear_thinking`) и опционально `reasoning_effort`;
  `"deepseek"` — `thinking.type` enabled/disabled + `reasoning_effort`;
  `"string-thinking"`, `"together"`, `"openrouter"`, `"baseten"`, `"ant-ling"`.

Это значит: для семейств, укладываемых в эти форматы, управление мышлением
реализуется **чисто метаданными** (`thinkingFormat` + `chatTemplateKwargs` +
`thinkingLevelMap`) без хука. Хук остаётся нужен для нестандартных форм
(MiniMax `thinking_mode`, Nemotron через system-message/`reasoning_budget`,
явное выключение там, где формат не покрывает) и для нормализации запроса (P2).

---

## 5. `pi install <локальный путь>`

- Локальный путь — отдельный тип источника
  (`$PI/dist/core/package-manager.js: parseSource`, `isLocalPath`).
- **Никакого копирования/симлинка**: `install` для `local` только проверяет
  существование пути (`package-manager.js:777-783`); запись источника уходит в
  `packages` в `settings.json` (глобально, или проектно с `-l`);
  `getInstalledPath` резолвит сам путь
  (`package-manager.js:676-680`). Пакет грузится **живьём из этого пути** —
  правки в репо видны без переустановки.
- Обнаружение ресурсов: ключ `pi` в `package.json`
  (`{"pi": {"extensions": ["./extensions"]}}`) либо конвенционные каталоги
  (`extensions/` грузит `.ts`/`.js`) (`$PI/docs/packages.md` — «Creating a Pi
  Package» / «Package Structure»).
- Ядро (`@earendil-works/pi-ai`, `pi-coding-agent`, `typebox` и др.) — в
  `peerDependencies` с `"*"`, пи их бандлит сам
  (`$PI/docs/packages.md` — «Dependencies»).
- Цикл разработки: правка → `/reload` (ресурсы перезагружаются,
  `$PI/dist/core/agent-session.js:2150+` — `reload` → `resourceLoader.reload()`;
  `registerProvider` в фабрике расширения ставится в очередь и применяется при
  инициализации раннера, `$PI/docs/extensions.md:181, 1721-1723`). Альтернатива
  без установки: `pi -e ./path` (запуск с расширением на один прогон,
  `$PI/docs/packages.md:50-54`).

---

## Сводка для карты

1. `registerProvider("nvidia", {models})` — полная замена списка моделей поверх
   встроенного провайдера; без `models` — только оверрайд `baseUrl`.
   `unregister` не нужен; авторизация, стриминг, ретраи, атрибут-хедеры
   сохраняются. Теряются только пер-модельные заголовки каталога (переопределять)
   и (при замене) оверлей каталога с `pi.dev`.
2. `before_provider_request` — только тело запроса; уровень мышления и модель
   видны через `ctx`. Метаданные не меняет.
3. Плюсы встроенного: заголовок `NVCF` — данные каталога; ретраи
   `ResourceExhausted` — общий механизм пи-ай; `X-BILLING-INVOKE-ORIGIN` — код
   пи по `provider`/хосту. Специфичного кода провайдера почти нет
   (`nvidia.js` — 14 строк конфигурации).
4. Уровни мышления в UI определяют `reasoning` + `thinkingLevelMap`;
   разблокировка `xhigh`/`max` — только через метаданные. Часть семейств
   покрывается нативными `thinkingFormat`/`chatTemplateKwargs` без хука.
5. Локальная установка — ссылка на путь без копирования; разработка через
   `/reload`; пакет описывается `pi`-ключом в `package.json`.
