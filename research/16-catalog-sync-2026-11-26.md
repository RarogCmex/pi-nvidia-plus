# 16 — Синхронизация каталога NIM и ретест Nemotron 3.5 / 3-ultra (2026-11-26)

Дата: 2026-11-26 (дополнение ноябрьских 410-отставок — 2026-11-27 keyless POST).
Метод: keyless `GET /v1/models` и keyless `POST /v1/chat/completions` (метод
[`06`](06-gateway-recon-keyless-oracles.md), §1 — без ключа и без квоты),
малые авторизованные пробы (тривиальный промпт, `max_tokens` 16–512) и
400-оракул `max_tokens` (метод [`11`](11-pi-1.2-catalog-fields-probes.md), §2).

## §1. Снимок каталога (NIM vs pi 1.6.1)

- Живой `/v1/models`: **30 id** (15 с чат-лексикой в `isChatModel()`, 15
  не-чат: embed / guard / content-safety / translate / detector / calibration /
  nvclip / starcoder2).
- Встроенный каталог **pi 1.6.1** (`$PIAI/dist/providers/data/nvidia.json`):
  **11 записей**, дефолт провайдера по-прежнему
  `nvidia/nemotron-3.5-super-vl-120b-a12b` (`$PI/dist/core/model-resolver.js`).
- Из новых в `/v1/models` иногда приходят метаданные прямо в объекте модели:
  `context_window`, `model_type`, `supports_structured_output`,
  `supports_thinking`, `supports_tools` (например, у `moonshotai/kimi-k3.1-pro`).
- Не-чат модели с живым HTTP-роутом (`nvidia/nemotron-3.5-content-safety`,
  `nvidia/riva-translate-4b-instruct-v2`, `nvidia/ising-calibration-1.5-31b`,
  `nvidia/ai-synthetic-video-detector`) на keyless POST отвечают `401` (роут
  есть), но без чат-контракта — лексика `NON_CHAT_PATTERNS` продолжает
  отсеивать их корректно.

## §2. Ретест `DEAD_MODELS` и ноябрьские отставки

1. **17 прежних «404 in every probe» переведены на точные даты `410 EOL`** по
   keyless-ответу `application/problem+json`:
   - 16 id → `410 EOL 2026-11-15`: `mistralai/mistral-7b-instruct-v0.3`,
     `moonshotai/kimi-k2.6`, `nvidia/llama-3.1-nemotron-70b-instruct`,
     `nvidia/llama-3.1-nemotron-ultra-253b-v1`, `01-ai/yi-large`,
     `ai21labs/jamba-1.5-large-instruct`, `databricks/dbrx-instruct`,
     `microsoft/phi-3-vision-128k-instruct`, `microsoft/phi-3.5-moe-instruct`,
     `mistralai/codestral-22b-instruct-v0.1`, `mistralai/mistral-large`,
     `mistralai/mistral-large-2-instruct`, `mistralai/mixtral-8x22b-v0.1`,
     `nvidia/llama-3.1-nemotron-51b-instruct`, `nvidia/nemotron-4-340b-instruct`,
     `nvidia/vila`, `writer/palmyra-creative-122b`.
   - `nvidia/nemotron-nano-3-30b-a3b` → `410 EOL 2026-09-01`.
2. **Ушли из `/v1/models` и из встроенного каталога pi 1.6.1 (подтверждены
   keyless 410):**
   - `nvidia/nemotron-3-super-120b-a12b` → `410 EOL 2026-10-03` (оверрайд
     убран, id перенесён в `DEAD_MODELS`, из `NEMOTRON_THINKING_MODELS` удалён).
   - `google/diffusiongemma-26b-a4b-it` → `410 EOL 2026-11-12` (добавлен в
     `DEAD_MODELS`; прежний хук в `transform.ts` оставлен как страховка для
     семейства, как `MINIMAX_M3` и `DEEPSEEK_V4`).
   - `deepseek-ai/deepseek-v4.1-flash` → `410 EOL 2026-11-16` (оверрайд убран,
     id в `DEAD_MODELS`).
   - `openai/gpt-oss-20b` → `410 EOL 2026-11-18` (оверрайд убран, id в
     `DEAD_MODELS`).
   - `meta/muse-glimmer-30b` → `410 EOL 2026-11-24` (оверрайд убран, id в
     `DEAD_MODELS`).
3. **Оставшиеся `404 in every probe` (3 id):** `google/gemma-3-4b-it`,
   `google/gemma-3-12b-it`, `nvidia/cosmos-reason2-8b`. На keyless POST все три
   отдают `401` (HTTP-роут жив, смерть на слое NVCF — [`06`](06-gateway-recon-keyless-oracles.md), §6.2),
   поэтому keyless-оракул их подтвердить не может. При единичной пробе с ключом
   `nvidia/cosmos-reason2-8b` ответила `200`, но до трёхкратного подтверждения
   (как в [`10`](10-nim-route-dependent-hangs-2026-10-12.md), §2 для
   `muse-glimmer`) запись оставлена в `DEAD_MODELS`.

В итоге в `overrides/models.json` остались **7** живых `modelOverrides` и **1**
собственная карточка (`nvidia/nemotron-3.5-bolt-e4b`); `discover-models.mjs`
показывает ноль пропавших известных моделей.

## §3. Живые пробы отдельных id (с ключом)

- **`nvidia/nemotron-3.5-bolt-e4b`:** `200`, `chat_template_kwargs.enable_thinking`
  по-прежнему управляет (`false`/plain → без reasoning, `true` → reasoning);
  400-оракул потолка `max_tokens` = **1 048 576**; только текст (запрос с
  картинкой → `422 media could not be screened`). На `high` без ключа один раз
  отдавал reasoning — нестабильность сервера, в каталог не прошивается.
- **`z-ai/glm-5.3-flash`:** `200` только при наличии ключа и `reasoning_effort`;
  без поля `messages` в теле отвечает `400 missing field 'messages'`; значения
  `reasoning_effort` `"off"` и `"bogus-level"` отвергаются `400`;
  `reasoning_content` присутствует всегда.
- **`moonshotai/kimi-k3.1-pro`:** живой id в `/v1/models` (метаданные:
  `context_window: 1048576`, `model_type: "vlm"`, `supports_thinking`,
  `supports_tools`, `supports_structured_output`), но все генерации виснут до
  `headersTimeout` (60 с, 180 с; три разных ключа, direct + пул) — тот же класс
  непригодности, что у `gemma-4-31b-it` ([`12`](12-catalog-sync-2026-10-23.md), §4).
  В каталог карточка не добавлена.
- **`mistralai/mistral-large-4-1t-a52b`:** `200`, ~64 t/s, `max_tokens: 20 000 000`
  принимается `200` (явного потолка не валидирует); 1T MoE NVFP4; иногда отдает
  `content: null` вместе с `reasoning_content`.
- **`fastino/gliner2-pii`:** жив в `/v1/models`, ключ принят, но контракт не
  чатовый — `422 invalid extraction request; check model, messages, labels and
  parameters` (с картинкой → `422 media could not be screened`). Это NER-модель
  извлечения сущностей, добавлен узкий фильтр `/\bgliner/i` в `NON_CHAT_PATTERNS`
  (`extensions/discovery.ts`).
- **`stepfun-ai/step-5-preview`:** `200`, при `max_tokens: 32` отдаёт
  `finish_reason: "length"` и `content: null` (reasoning съедает бюджет; класс
  уже описан в [`14`](14-nemotron-super-vl-truncation-2026-10-30.md)).

## §4. Наблюдение по ключам (Auth / тариф)

Ключ pi из `auth.json` на тех же живых моделях отдавал `403 Authorization failed`,
тогда как другие активные ключи из пула (при просмотре свыше трёх сотен записей
живой встретился дальше первых десятков) для тех же id стабильно давали `200`.
Для диагностики это важно помнить: `403` на конкретной учётке не доказывает
смерть модели — ротация пула это обходит штатно.

## §5. Ретест Nemotron 3.5 / 3-ultra: `NEMOTRON_NATIVE_EFFORT` (`none…max`)

Ретест 2026-11-26 показал расхождение между прежним хуком `NEMOTRON_THINKING_MODELS`
и реальным поведением сервера на трёх моделях:

1. `nvidia/nemotron-3-ultra-550b-a55b`
2. `nvidia/nemotron-3.5-lightning-30b-a3b`
3. `nvidia/nemotron-3.5-super-vl-120b-a12b`

Наблюдения:

- **`chat_template_kwargs.enable_thinking` больше не выключатель на 3.5 /
  ultra.** Plain-запросы отдают `reasoning_content` (на `lightning` при `max_tokens=8`
  встречались и ответы с `reasoning_content`, и ответы `OK` без reasoning —
  на сервере сосуществуют обе линии бэкенда). Передача `enable_thinking` (`true`
  или `false`) принимается с HTTP 200, но reasoning-каналом на этих трёх id не
  управляет — в отличие от `nemotron-3.5-bolt-e4b` и
  `nemotron-3-nano-omni-30b-a3b-reasoning`, где ключ по-прежнему работает.
- **Полная шкала `reasoning_effort` = `none…max`.** Ретест `super-vl` и
  проверка `ultra`/`lightning` показали, что на проводе принимается вся
  NIM-шкала `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`
  (а `"off"` и `"bogus"` сервер отвергает `400`). Прежняя карта `super-vl`
  (`minimal/low→low`, `medium→medium`, `high/xhigh/max→high`, опиравшаяся на
  документацию `none|low|high` из [`14`](14-nemotron-super-vl-truncation-2026-10-30.md))
  молча эскалировала `minimal` до `low` и сжимала верхние уровни; прежняя карта
  `ultra`/`lightning` (`off→off`, `minimal/low→low`, `medium…max→on`) передавала
  в `thinkingLevelMap` значения для хука, а не нативный `reasoning_effort`.

### Принятое решение

- В `extensions/transform.ts` выделен `NEMOTRON_NATIVE_EFFORT` (`ultra`,
  `lightning`, `super-vl`):
  - `NEMOTRON_THINKING_MODELS` сужен только до id с доказанно рабочим ключом
    `chat_template_kwargs.enable_thinking` (`nemotron-3-nano-30b-a3b`,
    `nemotron-3-nano-omni-30b-a3b-reasoning`, `nemotron-3.5-bolt-e4b`);
  - для `NEMOTRON_NATIVE_EFFORT` `thinkingPlan()` возвращает `undefined`, а
    `applyThinking()` не кладёт `enable_thinking`/`low_effort` ни на одном
    уровне (единственный хозяин — нативный `reasoning_effort`);
  - `thinkingPlanCaveat()` возвращает новый ключ `planCaveatNemotronNativeEffort`
    (`extensions/i18n.ts`, en+ru): предупреждает, что
    `chat_template_kwargs.enable_thinking` здесь не выключатель и гасит
    мышление только `off` через `reasoning_effort="none"`.
- В `overrides/models.json` всем трём id в `NEMOTRON_NATIVE_EFFORT` выставлено
  `compat.supportsReasoningEffort: true` и идентичная шкала `off→"none"`,
  `minimal…max→identity`.
