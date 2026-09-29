# 03 — Маппинги управления мышлением по семействам NIM

Дата: 2026-08-26. Отображение уровней мышления pi на wire-параметры по
семействам NIM.

Источники:

- Референс-пакеты с npm (извлечены `npm pack`, читались исходники):
  `pi-extension-nvidia-nim@1.5.1` (stridertibe) — `handlers/thinking.ts`,
  `config/model-families.ts`; `pi-nvidia-nim@1.1.23` (xRyul) — `index.ts`.
- Живые пробы `https://integrate.api.nvidia.com` (две сессии, `stream: false`,
  короткие арифметические промпты, `max_tokens` 256–700). Ключи `nvapi-*` —
  **замаскированы**; из нескольких ключей отвечали все, кроме одного
  (403 Authorization failed).
- Нативные механизмы пи — из находок отчёта `01-provider-surface.md`
  (в этом же каталоге).

---

## TL;DR

1. Надёжно проверяемы живыми пробами два механизма:
   **`thinking_mode` у MiniMax M3** и **`enable_thinking` (+ `low_effort` /
   `reasoning_budget`) у Nemotron 3.x / 3.5 Lightning**. Обе группы моделей
   без параметров либо не думают (M3), либо думают по умолчанию (Nemotron);
   явное выключение работает.
2. **`deepseek-ai/deepseek-v4-flash-0731` — единственная модель встроенной
   базы пи с `thinkingLevelMap` — стойко отвечает 404** («Function … not
   found») на всех трёх опробованных ключах. Маппинг не верифицируется; для
   каталога (тикет 02) модель фактически мертва.
3. **Живых моделей семейств GLM и Qwen в каталоге нет**: `z-ai/glm4.7`,
   `glm5`, `glm-5.2` — EOL (410); `qwen/*` — 404, в живом списке отсутствуют.
   Для них остаются только референсные маппинги (не верифицированы).
4. Неверные значения булевых флагов (`enable_thinking: "yes-please"`)
   принимаются без ошибки (200) и интерпретируются как ложь → мышление
   выключается. Реакцию M3 на неверный `thinking_mode` выяснить не удалось
   из-за жёсткого рейт-лимита (все попытки 429).
5. Значительная часть управлений выражается **нативными механизмами пи
   (только метаданные, без хука)**: `thinkingFormat: "chat-template"` с
   `chatTemplateKwargs` и переменными `$var`, а также
   `supportsReasoningEffort` + `thinkingLevelMap`. Хук
   `before_provider_request` нужен для `thinking_mode`, system-message
   моделей, `low_effort`/`reasoning_budget` и конверсий «топ-уровень →
   `chat_template_kwargs`». Подробности — раздел 3.

---

## 1. Результаты живых проб

Все пробы — через прокси, `stream: false`; «reasoning» = длина
`reasoning_content` в сообщении ответа.

### MiniMax M3 — `minimaxai/minimax-m3`

| Проба | Параметры | Результат |
|---|---|---|
| базовая | без параметров | 200, `reasoning_content` пуст — адаптивное мышление: на простом запросе модель не думает |
| `enabled` | `chat_template_kwargs.thinking_mode: "enabled"` | 200, reasoning ~274 симв. — мышление форсируется |
| `adaptive` | `thinking_mode: "adaptive"` | 200, reasoning ~253 симв. — модель сама решила думать |
| `disabled` | `thinking_mode: "disabled"` | 200, reasoning 0 — выключение работает |
| неверное | `thinking_mode: "bogus"` | **не определено**: ≥6 попыток в обеих сессиях (паузы до 3 мин) — каждый раз 429. У модели очень жёсткий рейт-лимит; 429 приходят без заголовка `retry-after` |

### Nemotron 3 Super 120B — `nvidia/nemotron-3-super-120b-a12b`

| Проба | Параметры | Результат |
|---|---|---|
| базовая | без параметров | 200, reasoning 74–154 симв. — **думает по умолчанию** |
| выкл | `chat_template_kwargs.enable_thinking: false` | 200, reasoning 0 — явное выключение работает |
| слабое | `enable_thinking: true, low_effort: true` | 200, reasoning 43–53 симв. — короче обычного |
| неверное | `enable_thinking: "yes-please"` | 200, reasoning 0 — принято, трактуется как ложь (выкл) |
| бюджет | `enable_thinking: true, reasoning_budget: 64` | 200, reasoning ~125 — принимается без ошибки (факт соблюдения бюджета не проверялся) |

### Nemotron 3 Ultra 550B — `nvidia/nemotron-3-ultra-550b-a55b`

| Проба | Параметры | Результат |
|---|---|---|
| базовая | без параметров | сначала 503 «Service temporarily overloaded», после ретрая 200, reasoning ~62 симв. — думает по умолчанию |
| выкл | `enable_thinking: false` | 200, reasoning 0 |
| неверное | `enable_thinking: "yes-please"` | 503 ×3, затем 200 reasoning 0 — принято как ложь |

### Nemotron 3.5 Lightning 30B — `nvidia/nemotron-3.5-lightning-30b-a3b`

| Проба | Параметры | Результат |
|---|---|---|
| базовая | без параметров | 200, reasoning ~953 симв. — думает по умолчанию и много |
| выкл | `enable_thinking: false` | 200, reasoning 0 |
| бюджет | `enable_thinking: true` + `reasoning_budget: 1024` | 200, reasoning ~952 — принимается |
| топ-уровневый | `reasoning_effort: "high"` (top-level) | 200, reasoning ~831 — принимается без ошибки |
| неверное | `enable_thinking: "yes-please"` | 200, reasoning 0 — принято как ложь |
| `low_effort` | `enable_thinking: true, low_effort: true` | 200, reasoning ~1048 — **не укоротило** (эффект `low_effort` на этой модели сомнителен; на Super 120B работал) |

### Прочие пробы

| Модель | Результат |
|---|---|
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 200, reasoning ~231 симв. без параметров — reasoning-модель |
| `deepseek-ai/deepseek-v4-flash-0731` | 404 «Function id … not found» — все варианты (`baseline`, `chat_template_kwargs` с `thinking`+`reasoning_effort` high/max, `thinking:false`, top-level `reasoning_effort`, неверный `effort`), ретраи на 3 ключах — стойко |
| `z-ai/glm4.7` | 410 EOL 2026-05-14 |
| `z-ai/glm5` | 410 EOL 2026-05-18 |
| `z-ai/glm-5.2` | 410 EOL 2026-08-21 |
| `zai-org/glm-5.2` | 404 page not found |
| `qwen/qwen3-235b-a22b` | 404 page not found |
| `qwen/qwq-32b` | 404 ×6 (вкл/выкл) |
| `moonshotai/kimi-k2.6` | числится в `/v1/models`, но на вызов 404 «Function not found» ×4 — список моделей ненадёжен |
| `mistralai/mistral-7b-instruct-v0.3` | 404 «Function not found» — мертва (совпадает с `goal.md`) |
| `deepseek-ai/deepseek-v4-pro` | 410 EOL 2026-08-07 |
| `deepseek-ai/deepseek-v3.2` | 404 page not found |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | 410 EOL 2026-08-26 |
| Muse Glimmer / GPT-OSS / Step-3.7 / Laguna / Kimi K3 | не пробовались — **не определено** |

---

## 2. Маппинги из референсов

### 2.1 `pi-extension-nvidia-nim@1.5.1` (stridertibe)

Семейства (`config/model-families.ts`, первое совпадение выигрывает) и их
обработчики (`handlers/thinking.ts`):

| Семейство | Модели (паттерн) | Механизм | Уровни (пи → значение) |
|---|---|---|---|
| `deepseek-v4` | `^deepseek-ai/deepseek-v4` | хук: `chat_template_kwargs: {thinking: bool, reasoning_effort: "high"\|"max"}` (top-level `thinking`/`reasoning_effort` удаляются) | off→`none`, high→`high`, max→`max`, промежуточные скрыты (`null`) |
| `glm` | `^z-ai/glm` | хук поверх нативного `zai`: `chat_template_kwargs: {enable_thinking, clear_thinking}` + top-level `reasoning_effort` high/max; при выключении `enable_thinking:false, clear_thinking:true` | off→`none`, high→`high`, max→`max` |
| `minimax-m3` | `^minimaxai/minimax-m3` | хук: `chat_template_kwargs.thinking_mode: disabled\|adaptive\|enabled` | off→`disabled`, minimal/low/medium/high→`adaptive`, xhigh→`enabled` |
| `inkling` | `^thinkingmachines/inkling` | ничего не посылать (думает всегда, тумблеры игнорирует) | только `off` скрыт |
| `laguna-xs-2.1` | `^poolside/laguna-xs-2\.1` | нативный пи `qwen-chat-template` | без маппинга |
| `gpt-oss` | `^openai/gpt-oss` | `supportsReasoningEffort: true` | minimal→`low` |
| `nemotron-super-detailed` | `nvidia/llama-3.3-nemotron-super-49b-v1` | хук: системное сообщение `detailed thinking on/off` | всё кроме off → `high` |
| `nemotron-system-think` | `llama-3.3-nemotron-super-49b-v1.5`, `nvidia-nemotron-nano-9b-v2` | хук: системное сообщение `/think` / `/no_think`; для Nano 9B v2 дополнительно `min_thinking_tokens:1024`, `max_thinking_tokens:4096` | всё кроме off → `high` |
| `nemotron-3-super-effort` | `nemotron-3-super-120b-a12b`, `nemotron-3-ultra-550b-a55b`, `nemotron-3.5-lightning*` | хук: `chat_template_kwargs.enable_thinking` + `low_effort` (только для уровня `low`) | Super: off→`none`, minimal/low→`low`, medium/high/xhigh→`high`; Ultra: off→`none`, minimal/low/medium→`medium`, high/xhigh→`high`; Lightning: off→`none`, minimal/low→`low`, medium/high/xhigh→`high` |
| `muse-glimmer` | `^meta/muse-glimmer` | top-level `reasoning_effort` | off→`none`, minimal→`minimal`, low→`low`, medium→`medium`, high→`high`, xhigh/max→`max` |
| `stepfun` | `^stepfun-ai/` | `supportsReasoningEffort: true` | off→`null` (мышление не выключается!), minimal/low→`low`, medium→`medium`, high/xhigh→`high` |
| общий `nemotron` | `^nvidia/.*nemotron` | `reasoningBudget: 32768` | — |
| `mistral` | `^mistralai/` | `requiresThinkingAsText`, `requiresToolResultName` | — |

### 2.2 `pi-nvidia-nim@1.1.23` (xRyul)

Помодельные `chat_template_kwargs` (`index.ts`, `THINKING_CONFIGS`):

| Модель | Включение | Выключение | Дополнительно |
|---|---|---|---|
| `deepseek-ai/deepseek-v4-flash`, `-v4-pro` | `{thinking: true}` | `{thinking: false}` | `reasoning_effort` внутрь `chat_template_kwargs` (high/max) |
| `deepseek-ai/deepseek-v3.1/3.1-terminus/3.2`, r1-distill-* | `{thinking: true}` | `{thinking: false}` | |
| `z-ai/glm4.7`, `z-ai/glm5` | `{enable_thinking: true, clear_thinking: false}` | `{enable_thinking: false}` | комментарий: думают всегда, но управляются |
| `moonshotai/kimi-k2.6`, `kimi-k2-thinking` | `{thinking: true}` | `{thinking: false}` | плюс top-level `reasoning_effort` |
| `qwen/qwen3-235b-a22b`, `qwen3-coder-480b-a35b-instruct`, `qwen3-next-80b-a3b-thinking`, `qwq-32b` | `{enable_thinking: true}` | `{enable_thinking: false}` | |
| `microsoft/phi-4-mini-flash-reasoning` | `{enable_thinking: true}` | `{enable_thinking: false}` | |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1`, `llama-3.3-nemotron-super-49b-v1`, `-v1.5` | `{thinking: true}` | `{thinking: false}` | (расходится со стридертибе: там — системные сообщения) |
| `mistralai/magistral-small-2506` | `{enable_thinking: true}` | `{enable_thinking: false}` | |

Примечания из шапки пакета: V3.x — `chat_template_kwargs: {thinking: true}`;
V4 — `{thinking: true, reasoning_effort: "high"|"max"}`; GLM-5/4.7 —
`{enable_thinking: true, clear_thinking: false}`; Kimi — `{thinking: true}`
(принимает и `reasoning_effort`); Qwen3 — `{enable_thinking: true}`.

**Расхождение референсов** по `llama-3.3-nemotron-super-49b-*`: xRyul шлёт
`chat_template_kwargs.thinking`, stridertibe — системные сообщения. Живой
модели для разрешения спора нет (v1.5 — EOL 2026-08-26; v1 в живом каталоге
отсутствует).

---

## 3. Сопоставление с нативными механизмами пи

Из находок отчёта `01-provider-surface.md`:

- `thinkingFormat: "chat-template"` + `compat.chatTemplateKwargs` — пи сам
  пишет `chat_template_kwargs`; значения могут быть переменными
  `{"$var": "thinking.enabled"}` (булево «думать/нет»),
  `{"$var": "thinking.effort"}` (значение из `thinkingLevelMap` по уровню),
  `{"$var": "thinking.budget"}`; флаг `omitWhenOff` убирает ключ при `off`.
- `compat.supportsReasoningEffort: true` — пи пишет top-level
  `reasoning_effort` (значение из `thinkingLevelMap`).
- Доступность уровней в UI: `off..high` — по умолчанию при `reasoning: true`;
  `xhigh`/`max` — только при явном `thinkingLevelMap`; `null` в маппинге
  скрывает уровень.

| Семейство | Живая модель? | Хватит ли нативных механизмов | Что нужно |
|---|---|---|---|
| MiniMax M3 | да | **почти да**: `chat-template` с `thinking_mode: {"$var": "thinking.effort"}` + `thinkingLevelMap` (off→`disabled`, low..high→`adaptive`, xhigh→`enabled`) | только метаданные; проверить на практике, что `$var: thinking.effort` подставляет строки маппинга |
| Nemotron 3 Super/Ultra/3.5 Lightning | да | **частично**: `enable_thinking: {"$var": "thinking.enabled"}` (+ `omitWhenOff: false`, чтобы при `off` уходило явное `false` — модели думают по умолчанию) | `low_effort` (истина только для уровня `low`) простой `$var`-схемой не выражается — хук, либо не слать вовсе (эффект на 3.5 Lightning пробами не подтверждён, на Super 120B подтверждён) |
| Muse Glimmer, GPT-OSS, StepFun | да | **да**: `supportsReasoningEffort` + `thinkingLevelMap` | только метаданные (у StepFun `off: null` — мышление не выключается) |
| GLM (`z-ai/*`) | нет (все EOL) | **нет**: нужно `clear_thinking` (обратное от `enabled`) и маппинг усилия в top-level `reasoning_effort` | хук (как у stridertibe); верификация невозможна — моделей нет |
| DeepSeek V4 | мертва (404) | **нет**: нативный формат `deepseek` шлёт `thinking`+`reasoning_effort` top-level, а NIM требует их в `chat_template_kwargs` | хук-конверсия (как у обоих референсов); верификация невозможна |
| Qwen | нет в каталоге | **да**: `chat-template`/`qwen` с `enable_thinking: {"$var": "thinking.enabled"}` | только метаданные; пробовать нечего |
| Nemotron system-message (`llama-3.3-nemotron-super-49b-v1`/`v1.5`, `nano-9b-v2`) | нет в живом каталоге | **нет**: инжект системных сообщений — только хук | хук; пока не для кого |
| Kimi | числится, но 404 | не определено | пробы невозможны |

**Вывод для тикета 05/07:** живой функционал (M3, Nemotron 3.x, Muse
Glimmer, GPT-OSS, StepFun) почти целиком закрывается метаданными
(`thinkingLevelMap` + `compat`), хук нужен в худшем случае для `low_effort`;
хук-конверсии для мёртвых/EOL семейств (GLM, DeepSeek V4, Qwen, Kimi,
system-message Nemotron) стоит держать в расширении как гипотезы из
референсов, но помечать непроверенными.

---

## 4. Текущая встроенная база пи (контекст)

По `pi-ai/dist/providers/data/nvidia.json`: 32 модели; `reasoning: true` у 23;
`thinkingLevelMap` и `thinkingFormat: "deepseek"` — только у
`deepseek-ai/deepseek-v4-flash-0731` (которая, по пробам, 404);
`supportsReasoningEffort` нет ни у одной модели. То есть встроенный каталог
управление мышлением практически не декларирует — расширение должно донести
`reasoning`/`thinkingLevelMap`/`compat` через перерегистрацию (метаданные
хуком не меняются — находка 01).

---

## 5. Методологические оговорки

- **Статусы моделей — только по пробам.** Список `GET /v1/models` ненадёжен:
  `moonshotai/kimi-k2.6` числится, но на вызов отвечает 404 «Function not
  found»; аналогично `gemma-3-*` и `deepseek-v4-flash-0731` (по данным
  параллельного аудита каталога).
- **Правило ретраев**: стойкий 410 — надёжный признак смерти (эндпоинт сам
  сообщает дату EOL); 404/429/503 — повод повторить (модель может сперва
  дать 404, потом 429/`ResourceExhausted`, и только потом заработать); одна
  проба ничего не доказывает. Мёртвой модель считается после 3–4 повторов с
  паузами.
- **404 «Function … not found for account …»** у `deepseek-v4-flash-0731`
  воспроизводился на 6 разных живых ключах (3 аккаунта в сообщении об
  ошибке) — похоже на снятие функции с хостинга, а не на ограничение ключа,
  но формально это ошибка уровня «функция не найдена для аккаунта».
- **Рейт-лимиты**: у `minimaxai/minimax-m3` очень жёсткие 429 (кластер
  запросов вымораживает ключ на минуты), заголовок `retry-after` в ответах
  429 **не приходил** (`retry-after: None`) — важно для тикета 11
  (диагностика): опираться на `retry-after` нельзя, нужен текст/статус.
  503 «Service temporarily overloaded» наблюдались у `nemotron-3-ultra-550b`.
- Пробы не стриминговые (`stream: false`); поведение тех же параметров в
  SSE-стриме отдельно не проверялось (по референсам — одинаковое).
- Соблюдение `reasoning_budget` на стороне эндпоинта не проверялось
  (принимается без ошибки; длина рассуждений при малом бюджете не
  контролировалась).
- Реакция M3 на неверное значение `thinking_mode` — **не определено**
  (429-стена); неверные значения `enable_thinking` у Nemotron принимаются
  как ложь.
- Ключи в этом файле не приводятся; использовано 6 живых ключей из
  локального хранилища, один ключ — 403 (протух/отозван).

## 6. Ссылки

- Ветка `research/01-provider-surface` — поверхность провайдера пи
  (нативные форматы `thinkingFormat`, `chatTemplateKwargs`, `$var`,
  `thinkingLevelMap`, семантика уровней в UI).
- Тикет: 03 — отображение уровней мышления.
- Референсы: `pi-extension-nvidia-nim@1.5.1`, `pi-nvidia-nim@1.1.23` (npm).
