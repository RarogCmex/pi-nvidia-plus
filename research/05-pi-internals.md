# 05 — Как устроен `nvidia` внутри пи (супер-подробный разбор)

Дата: 2026-08-26. Источники: `dist/core/provider-composer.js`, `model-runtime.js`, `sdk.js`,
`pi-ai/dist/api/openai-completions.js`, `pi-ai/dist/utils/retry.js`, `~/.pi/agent/models-store.json`.

## Слои каталога (низ → верх)

`composeModelProvider(providerId, base, modelConfig, extension)` (provider-composer.js:285) собирает
провайдера послойно; `getModels()` применяется в таком порядке:

1. **Встроенный каталог** `pi-ai/.../providers/data/nvidia.json` (32 модели):
   пер-модельные `headers: {"NVCF-POLL-SECONDS":"3600"}`, полный `compat`
   (`maxTokensField: max_tokens`, `supportsDeveloperRole: false`, у `deepseek-v4-flash-0731` —
   нативный `thinkingFormat: "deepseek"` + `thinkingLevelMap {high,max}`), контексты/макс-токены.
2. **`models-store.json`** (`~/.pi/agent/models-store.json`) — кэш models.dev, обновляется
   `pi update --models`. Для nvidia — 22 модели, **байт-в-байт совпадают со встроенными**
   (сверено по трём моделям: различий нет). Уникальных данных не несёт.
3. **`models.json` (пользовательский конфиг)** — `applyModelsJson`: provider-уровневые
   `baseUrl`/`headers`/`compat`/`apiKey` (compat мержится во все модели), апсерт своих `models[]`
   поверх встроенных.
4. **Расширение** — `applyExtension` (provider-composer.js:112):
   - без `models` — только подмена `baseUrl` (каталог не трогается);
   - с `models` — **полная замена списка**; на собранном объекте модели `headers` обнуляется
     (строка 132), НО `rawModelHeaders` (provider-composer.js:268) читает `extension.models[].headers`
     из исходного конфига расширения и добавляет их в запрос через `getAuth` →
     `resolveConfiguredModelHeaders` → `options.headers`. То есть **пер-модельные хедеры из
     `registerProvider` доходят до запроса**;
   - важно: замена происходит ПОСЛЕ `applyModelsJson` — модели, добавленные пользователем в
     `models.json` для `nvidia`, нашей перерегистрацией **стираются**.
5. **`modelOverrides` из `models.json`** — применяются **последними**, поверх всего, включая
   модели расширения (имя, `reasoning`, `thinkingLevelMap` — мерж, `input`, `cost`, `contextWindow`,
   `maxTokens`, `samplingParams`, `headers`, `compat` — мерж). Пользовательские патчи переживают
   наше расширение.

`recomposeProvider` (model-runtime.js:133): без конфига и расширения встроенный провайдер
используется **нетронутым** («so its auth/login/stream behavior is exact»); при ошибке композиции —
откат на встроенный (расширение не убивает провайдера, а деградирует к нему).

## Авторизация

`composeApiKeyAuth`: если расширение НЕ передаёт `apiKey`, наследуется авторизация встроенного
провайдера (настроенный ключ пользователя). Если передать `apiKey: "$ENV"` — резолв переключается
на указанный источник.

## Пайплайн запроса

`ModelRuntime.streamSimple` → `prepareRequest` (auth-резолв + мерж сконфигурированных хедеров в
`options.headers`) → `provider.streamSimple` → `streamWith` (provider-composer.js:309):

1. `extension.streamSimple` — ТОЛЬКО если `model.api === extension.api` (область — один
   провайдер, не глобально по api; комментарий xRyul о глобальности устарел);
2. иначе `base.streamSimple` (встроенный);
3. иначе глобальный api-провайдер из `pi-ai`.

Внутри `pi-ai/api/openai-completions.js`:
- payload собирается из `model.compat` (нативные `thinkingFormat`/`chatTemplateKwargs`/
  `reasoning_effort`), затем `options.onPayload(params)` (строка 176) — в пи это
  `runner.emitBeforeProviderRequest(payload)` (sdk.js:208) → хук **видит уже финальное тело**
  после нативной thinking-механики;
- хедеры: `{ "User-Agent": ..., ...model.headers }` + `options.headers` (строка 516) →
  `NVCF-POLL-SECONDS` в базовом пути идёт из `model.headers`, при перерегистрации — из
  `options.headers` (см. выше);
- `retryProviderRequest` (строка 185) — ретраи транзиентных ошибок, включая `ResourceExhausted`
  (`utils/retry.js:76`) — внутри api-слоя, живут при любом варианте без кастомного стриминга;
- `options.onResponse({status, headers})` (строка 190) → `after_provider_response` (sdk.js:215).

## Выводы для вариантов архитектуры

- Всё стриминговое (ретраи, атрибуция, User-Agent, нативная thinking-механика) живёт в api-слое
  `pi-ai` и сохраняется, пока расширение не подставляет `streamSimple`.
- Хук `before_provider_request` исполняется ПОСЛЕ нативных `compat`-механизмов — можно
  докручивать то, что нативные форматы не покрыли.
- `refreshModels` в `ProviderConfigInput` — нативный механизм живого обновления каталога
  (кандидат для P5; композится с `base.refreshModels`).
- Оверлей `models-store.json` для nvidia не несёт уникальных данных — при перерегистрации
  терять нечего.
