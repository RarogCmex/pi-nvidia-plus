# 05 — Анализ референсных расширений (материал к выбору архитектуры)

Дата: 2026-08-26. Разобраны два опубликованных расширения, оба под **MIT**:
`pi-nvidia-nim@1.1.23` (npm, xRyul; upstream `github.com/xRyul/pi-nvidia-nim`)
и `pi-extension-nvidia-nim@1.5.1` (npm, stridertibe; upstream
`github.com/Tibbee/pi-nvidia-nim-provider`). Пакеты извлекались через
`npm pack` — локальные клоны в это дерево не входят.

| | `xRyul/pi-nvidia-nim` v1.1.23 | `Tibbee/pi-nvidia-nim-provider` = npm `pi-extension-nvidia-nim` v1.5.1 |
|---|---|---|
| Структура | монолит, один `index.ts` (926 строк) | модули: `config/`, `handlers/`, `models/` (+`metadata.json`, `capabilities.ts`), `lib/`, `tools/`, `test/` |
| Провайдер | отдельный `nvidia-nim` | отдельный `nvidia-nim` |
| Thinking-инжект | кастомный `streamSimple` + `onPayload` | хук `before_provider_request` (**без кастомного стриминга**) |
| Диагностика 429/5xx | нет | `after_provider_response`: retry-after, request ID |
| Каталог | хардкод-таблицы, живой дискавери при `session_start` | снапшот `metadata.json` (67 моделей), генерится скрейперами; мёртвые вычищены (1.5.0: −25×410, −32 «в списке, но 404») |
| Тесты | один тест авторизации | снапшоты запросов, контракты, рефактор-чеки |
| Инструменты | — | `probe_nim.ts` (пробный стенд), `fetch_nim_metadata.ts` (скрейпер ReadMe-страниц NVIDIA), `fetch_modelsdev_nvidia.ts` (models.dev) |

## Плюсы и минусы

### Оригинал (xRyul)

**Плюсы:**
- Важный факт в комментарии: `streamSimple` в пи регистрируется **глобально по типу `api`**, а не по провайдеру — кастомный стример вызывается для ВСЕХ `openai-completions`-провайдеров, нужен явный pass-through по `model.provider`. Подтверждает, что путь кастомного стриминга опасен.
- Живой дискавери при `session_start` с классификацией исходов (`auth`/`transient`/`invalid`/`network`) и уведомлением через `ctx.ui.notify` — готовый шаблон для тикета 12 (P5).
- Резолв ключа: сначала авторизация пи (`auth.json`, CLI-оверрайд), потом env-фолбэк; поддержка `$ENVVAR`-ссылок в `apiKey`-конфиге; маска `nvapi-[REDACTED]` в логах.
- Практические совместимости: `supportsDeveloperRole: false` (developer-роль + thinking-kwargs даёт 500 на NIM), `maxTokensField: "max_tokens"`, отдельные флаги для Mistral (`requiresToolResultName`, `requiresThinkingAsText`, `requiresMistralToolIds`).
- Сплющивание контент-массивов в строки — уже реализовано (наш P2).
- Нативные `thinkingLevelMap` + `thinkingFormat: "chat-template"` с `chatTemplateKwargs`/`$var` для Inkling и MiniMax M3 — то же, что нашли мы в тикете 01.

**Минусы:**
- Кастомный `streamSimple` — антипаттерн по `goal.md`; pass-through-гард хрупкий.
- Дублирующий провайдер `nvidia-nim` — пользователь обязан менять модели.
- Каталог устаревший и мёртвый (модели из него уже 410/404 по нашему аудиту 02); контексты/макс-токены — хардкод без источников.
- Никакой диагностики 429/5xx.

### Форк (Tibbee / npm-пакет)

**Плюсы:**
- Архитектура ровно та, что предпочитает `goal.md`: `registerProvider` (статика) + `before_provider_request` + `after_provider_response`, без кастомного стриминга.
- `handlers/thinking.ts` — готовые трансформы по семействам: `deepseek-v4` (kwargs `thinking`+`reasoning_effort` none/high/max), `minimax-inline` (`thinking_mode` disabled/adaptive/enabled), `nemotron-3-super-effort` (`enable_thinking`+`low_effort`+`reasoning_budget`), `nemotron-system-detailed` («detailed thinking on/off»), `nemotron-system-think` (`/think`//`/no_think` + min/max thinking tokens), `qwen-chat-template` с особой веткой GLM (`enable_thinking`/`clear_thinking` + top-level `reasoning_effort`).
- Практический нюанс: в событии `before_provider_request` **нет поля `provider`** (пи 0.73) — форк определяет «свои» запросы через `ctx.model.provider` + членство `payload.model` в реестре.
- `thinkingLevelMap` с явными `null` — невыясненные уровни скрываются из UI вместо тихих алиасов.
- `models/capabilities.ts` — дисциплина свидетельств: `claimed` / `documented` / `probe-passed` / `probe-failed` отдельно для семантики, запроса, ответа, стриминга, тулов. Совпадает с методологией нашего аудита.
- Скрейперы + `metadata.json`: статический снапшот с инструментом пересборки — готовый ответ на вопрос «статика vs живьё» (тикет 08): статика, генерируемая инструментами.
- CHANGELOG 1.5.0 независимо подтверждает наш аудит 02: 410-модели и «в списке `/v1/models`, но 404 на вызов» (32 модели, «проверено тремя проходами с часовыми интервалами»).
- Диагностика 429 (`retry-after`) и 5xx (`x-request-id` / `x-nvca-request-id`) через `ctx.ui.notify` — готовый шаблон тикета 11 (P4).
- Дебаг-лог финального payload по `NIM_DEBUG=1` (`~/.pi/nim-debug.log`).

**Минусы:**
- Тоже дублирующий провайдер `nvidia-nim`, не улучшение встроенного.
- Гейт по членству в реестре: модель вне `STATIC_MODEL_MAP` не получает ни нормализации, ни макс-токенов.
- GLM/Qwen-маппинги завязаны на модели, которых уже нет живьём (по аудиту 02) — верифицировать не на чем, остаётся только код.
- Нет прокси (наш P3 нет ни у кого — новое поле).
- Скрейперы заточены под страницы документации; пересборка требует ручного присмотра.

## Что берём как источник вдохновения

1. **Форк — архитектурный шаблон** (тикет 05): `registerProvider` + хуки, модульная структура `config/handlers/models`. Адаптация: регистрируем `"nvidia"` in-place, а не отдельный провайдер.
2. **`handlers/thinking.ts`** — стартовые трансформы семейств (тикет 07); сверять с нашими живыми пробами 03 (M3 и Nemotron подтверждены, DeepSeek/GLM/Qwen живьём не проверить).
3. **Диагностика** (тикет 11): обработчик `after_provider_response` форка — почти как есть.
4. **Нормализация** (тикет 09): `normalizeContentArrays` + дефолт `max_tokens` — почти как есть; снять ограничение «только для моделей из реестра».
5. **Каталог** (тикет 08): снапшот `metadata.json` + скрейперы `tools/` как способ пересборки; статусы смертей из CHANGELOG 1.5.0 сверить с нашим аудитом 02.
6. **Дисциплина свидетельств** (`capabilities.ts`) — перенести в наши таблицы метаданных: источник и уровень уверенности по каждой модели.
7. **Из оригинала**: классификация исходов дискавери + `ctx.ui.notify` (тикет 12); совместимости `supportsDeveloperRole`/`maxTokensField`/mistral-флаги; факт о глобальности `streamSimple` — аргумент против кастомного стриминга в тикете 05.

## Где расходимся с обоими

- Цель — улучшение встроенного `nvidia` на месте (`registerProvider("nvidia", ...)`, по находкам 01 — список заменяется, авторизация/стриминг/ретраи сохраняются).
- P3-прокси: нет ни у кого; механика — из находок 04 (выборочный глобальный диспетчер).
- Нативные `thinkingFormat` пи там, где хватает (находки 01/03), — меньше кода в хуке, чем у обоих референсов.
