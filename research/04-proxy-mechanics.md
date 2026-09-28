# 04 — Механика индивидуального прокси для провайдера `nvidia`

Результат research-тикета 04 — механика прокси (внутренние рабочие заметки не публикуются).
Все цитаты путей — относительно `~/.local/lib/node_modules/@earendil-works/pi-coding-agent`
(пи: `pi-coding-agent`, пи-ай: `node_modules/@earendil-works/pi-ai`).

## Вывод коротко

Пи **уже глобально уважает** `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (undici
`EnvHttpProxyAgent` как глобальный диспетчер) — но это прокси для **всего** трафика,
а задача — только `nvidia`. Проверенные варианты «только для nvidia»:

1. **Рекомендуемый: выборочный глобальный диспетчер в расширении** — обёртка над
   текущим диспетчером: запросы к `https://integrate.api.nvidia.com` идут через
   `undici.ProxyAgent(NVIDIA_NIM_PROXY)`, всё остальное делегируется прежнему
   диспетчеру. Не трогает ни провайдер, ни стриминг; работает для инференса,
   `GET /v1/models` и проб. Проверено живым тестом (включая SSE-стрим).
2. **Запасной: делегирование в `streamSimple` с инжектом `fetch`** —
   `pi.registerProvider("nvidia", { api: "openai-completions", streamSimple })`,
   где `streamSimple` делегирует в штатный `openAICompletionsApi()` с
   `...options, fetch: proxyFetch`. Полностью переиспользует встроенный стриминг
   (ретраи, заголовки), но требует перерегистрации провайдера.

Вариант 1 ортогонален решению тикета 05 (архитектура) и совместим с любым его
исходом — поэтому рекомендуемый.

## 1. Уважает ли пи `HTTPS_PROXY`/`NO_PROXY`? Да, глобально

- `dist/core/http-dispatcher.js`: `configureHttpDispatcher()` создаёт
  `undici.EnvHttpProxyAgent` и ставит его глобальным диспетчером
  (`undici.setGlobalDispatcher(...)`), затем `undici.install()` подменяет
  `globalThis.fetch` на fetch undici, который ходит через глобальный диспетчер.
  `applyHttpProxySettings()` копирует настройку `settings.httpProxy` в
  `HTTP_PROXY`/`HTTPS_PROXY`.
- `dist/main.js:453-454`: `applyHttpProxySettings(...getGlobalSettings().httpProxy)`
  и `configureHttpDispatcher()` вызываются при старте.
- `docs/settings.md:90`: `httpProxy` — глобальная настройка, «applied as
  `HTTP_PROXY` and `HTTPS_PROXY`».
- `docs/environment-variables.md:92`: `HTTP_PROXY`, `HTTPS_PROXY` документированы.
- `NO_PROXY` поддерживается самим `EnvHttpProxyAgent`
  (`node_modules/undici/lib/dispatcher/env-http-proxy-agent.js:82-113`).

**Почему этого недостаточно:** `NO_PROXY` — только список исключений, выразить
«проксировать единственный хост» нельзя. Глобальный прокси затронул бы все
провайдеры (нарушение критерия приёмки №6 из `goal.md`).

## 2. Транспорт провайдера `nvidia`: где швы

Провайдер: `pi-ai/dist/providers/nvidia.js` — обычный `createProvider` c
`api: openAICompletionsApi()`.

- `pi-ai/dist/api/openai-completions.js:174` — `createClient(model, context, apiKey, options?.headers, options?.fetch, ...)`;
  `:515-545` — `createClient` передаёт `fetch` в `new OpenAI({ ..., fetch, defaultHeaders: headers })`.
  То есть **`ModelOptions.fetch` — публичная точка инжекта транспорта**
  (`pi-ai/dist/types.d.ts:58-62`: «Optional fetch implementation for provider
  HTTP requests. Defaults to `globalThis.fetch`»).
- Пи-ядро `fetch` **не передаёт**: `dist/core/sdk.js:194-207` (`streamFn`) и
  `dist/core/model-runtime.js:457-468` — в опциях только таймауты/ретраи/`transformHeaders`.
  Значит по умолчанию работает `globalThis.fetch` → глобальный диспетчер.
- `before_provider_request` правит **только тело запроса** (`onPayload`,
  `dist/core/sdk.js:209+`) — транспорт через него не подменить.
- Заголовки attribution/`NVCF-POLL-SECONDS`:
  - модельные `headers` (в т.ч. `NVCF-POLL-SECONDS: 3600`) заданы в
    `pi-ai/dist/providers/data/nvidia.json` и подмешиваются в
    `createClient` (`...model.headers`, `openai-completions.js:516`);
  - attribution докидываются через `transformHeaders`
    (`dist/core/sdk.js:200-205`), который отрабатывает **до** вызова
    `provider.streamSimple` (`dist/core/model-runtime.js:433-437`) — то есть
    любой `streamSimple`, даже кастомный, получает их в `options.headers`.
- Ретраи `ResourceExhausted` — `pi-ai/dist/utils/retry.js:76`, используется
  штатным `retryProviderRequest` внутри `openai-completions.js`.

## 3. Варианты и оценка

### Вариант A — выборочный глобальный диспетчер (рекомендация)

Расширение при загрузке (и после каждого `/reload`):

```js
const { createRequire } = require("node:module");
const piUndici = createRequire("<путь к пи>/package.json").resolve("undici") // НУЖЕН экземпляр именно пи
// обёртка:
//   origin === "https://integrate.api.nvidia.com" -> proxyAgent.dispatch(...)
//   иначе                                          -> прежний диспетчер
undici.setGlobalDispatcher(new SelectiveDispatcher(...))
```

- Покрывает инференс (через `globalThis.fetch` → диспетчер), а `GET /v1/models`
  и пробы расширение делает тем же `fetch` — всё через прокси.
- Другие провайдеры и остальной трафик идут через прежний диспетчер
  (включая пользовательский глобальный `httpProxy`) — критерий №6 соблюдается.
- **Важно:** нужен экземпляр undici самого пи — у расширения свой `node_modules`,
  и свой `undici` имеет собственный глобальный диспетчер, который на пи не влияет.
  Путь к экземпляру пи проверен: `createRequire('<путь к pi-coding-agent>/package.json').resolve('undici')`
  → `.../pi-coding-agent/node_modules/undici/index.js`.
- **Риск:** пи пересоздаёт диспетчер — `configureHttpDispatcher()` вызывается в
  `applyRuntimeSettings()` (`dist/modes/interactive/interactive-mode.js:1524`,
  вызовы на 1550 и 4992 — старт и `/reload`) и при смене «HTTP idle timeout»
  в настройках (`interactive-mode.js:3822`). Если пересоздание происходит
  **после** загрузки расширения, обёртка затирается. Митигация при реализации:
  идемпотентная проверка `undici.getGlobalDispatcher()` (не оборачивать себя
  повторно) и переустановка в нужный момент; порядок «настройки → расширения»
  при `/reload` проверить в тикете 10 живым экспериментом.

### Вариант B — делегирование в `streamSimple` с инжектом `fetch` (запасной)

`docs/custom-provider.md` прямо называет прокси первым кейсом `registerProvider`
(«Proxies - Route requests through corporate proxies or API gateways») и
документирует импорт: `import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai"`.

```js
const base = openAICompletionsApi();
pi.registerProvider("nvidia", {
  api: "openai-completions",
  streamSimple: (model, context, options) =>
    base.streamSimple(model, context, { ...options, fetch: proxyFetch }),
});
```

- Маршрут: `provider-composer.js:306-323` — `extension.streamSimple` вызывается,
  когда `model.api === extension.api`; `options.headers` уже содержат
  результат `transformHeaders` (attribution) — встроенные плюсы сохраняются,
  ретраи `ResourceExhausted` — внутри делегата.
- Не зависит от глобального диспетчера → нет риска пересоздания.
- Минусы: это перерегистрация провайдера (пересечение с тикетом 05);
  `GET /v1/models` для дискавери всё равно придётся проксировать отдельно
  (своим `fetch`); при варианте с моделями в `registerProvider`
  `applyExtension` (`provider-composer.js:118-134`) **обнуляет** `headers`
  моделей — `NVCF-POLL-SECONDS` надо явно переносить.

### Вариант C — только `before_provider_request`

Невозможно: хук правит только payload, транспорт не трогает (§2). Отклонён.

### Вариант D — глобальный `HTTPS_PROXY` без расширения

Уже работает сегодня, но проксирует все провайдеры — не соответствует задаче
«только для `nvidia`». Упомянуть в документации расширения как существующую
механику (не дублировать её).

## 4. Конфигурация (по решению на чартовании)

- Только env: `NVIDIA_NIM_PROXY` (читается расширением при загрузке).
- Без переменной — поведение не меняется (никакой обёртки не ставим).
- Прокси покрывает все запросы провайдера: инференс, `GET /v1/models`, пробы.
- Ошибка при недоступном прокси: `undici ProxyAgent` даст `ECONNREFUSED`-подобную
  ошибку на коннекте; для «понятной ошибки» расширению стоит делать префлайт
  прокси при загрузке и показывать уведомление.

## 5. Практическая проверка (2026-08-26, прокси `http://127.0.0.1:8870`)

Скрипт: одноразовая проба (undici взят из экземпляра пи через
`createRequire`; ключ — из окружения, не коммитился). Результаты:

1. **`ProxyAgent` + SSE**: `POST /v1/chat/completions`
   (`meta/llama-3.2-11b-vision-instruct`, `stream: true`) → HTTP 200, 3 SSE-чанта,
   поток завершился `data: [DONE]`.
2. **Обёртка-диспетчер**: запрос к `integrate.api.nvidia.com/v1/models` через
   обёртку → HTTP 200, 83 модели; запрос к `https://example.com` через прежний
   диспетчер → HTTP 200 (маршрутизация избирательная работает).
3. **SSE через обёртку-диспетчер** (глобальный `fetch` без явного диспетчера):
   HTTP 200, 3 SSE-чанта.

Попутные факты для тикета 02 (каталог):
- `nvidia/nemotron-mini-4b-instruct` — EOL 2026-08-26, возвращает 410.
- Живой каталог = 83 модели; `nvidia/llama-3.1-nemotron-70b-instruct`
  в живом списке **присутствует** (в `goal.md` помечен мёртвым — перепроверить
  при аудите).

## Рекомендация для тикета 05/10

Брать **вариант A** как основной: он не зависит от выбора архитектуры (05),
не трогает каталог и стриминг, проверен живым SSE. Вариант B держать как
запасной на случай, если пересоздание диспетчера при `/reload`/смене настроек
окажется неудобно обходить. При реализации (тикет 10) обязательно: экземпляр
undici только пи; идемпотентная обёртка; живой тест порядка `/reload`;
префлайт прокси с понятной ошибкой.
