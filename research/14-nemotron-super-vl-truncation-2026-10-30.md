# 14 — «Response was truncated before completion» на nemotron-3.5-super-vl

Дата: 2026-10-30. Метод: разбор живой сессии pi (записи `message`/`custom tps`
в `.jsonl`), встроенная карточка модели в pi 1.4.0 и pi-ai, документация NVIDIA
(NIM 2.0.13 «Control Reasoning», `docs.api.nvidia.com` reference модели,
build-карточка). **Живых проб не делали** — вывод целиком на документации и
записях сессии; какие пробы остались незакрытыми, сказано в §5.

## §1. Симптом

Сессия `01a18c64-7581-7069-a1e6-298e28bd8641`, провайдер `nvidia`, модель
`nvidia/nemotron-3.5-super-vl-120b-a12b` (дефолт 1.4.0), уровень мышления
`high`. Через ~2 минуты после начала — подряд десятки сообщений с плашкой
*Response was truncated before completion.* Разбор записей:

| поле | значение во всех оборванных ответах |
|---|---|
| `stopReason` | `length` |
| `usage.output` | **ровно 8192** |
| контент-блоки | один `thinking` (~24–28 тыс. символов), `text` нет |
| `custom tps` | `output: 8192`, рост `input` ровно на 15 токенов за шаг |

Рост `input` на 15 токенов — это скрытая реплика автопродолжения
(`pi-retry:continue` = «Continue exactly where you left off without repeating
content.»), то есть цикл: обрыв → продолжение → снова обрыв. Всего 89
оборванных ответов, один `toolUse` и один `error` («Stream ended without
finish_reason») между ними.

Складываем: pi отправлял `max_tokens: 8192`, модель всё это время рассуждала, и
`finish_reason: "length"` приходил на пустом `content`. Это ровно тот сценарий,
что описан в документации NIM для этой модели.

## §2. Причина — два поля карточки pi

Встроенная карточка pi 1.4.0 (`$PIAI/dist/providers/data/nvidia.json`):

```json
{ "id": "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "reasoning": true,
  "compat": { "supportsReasoningEffort": false, "maxTokensField": "max_tokens", ... },
  "contextWindow": 1048576,
  "maxTokens": 8192 }
```

1. **`maxTokens: 8192` меньше серверного дефолта (16384) и потолка карточки
   (32768).** Это и есть наблюдаемые «ровно 8192».
2. **Мышление не управлялось никак.** `supportsReasoningEffort: false`, карты
   уровней нет, `thinkingFormat` не из тех, что pi умеет (`openai-completions`
   уходит в ветку «ничего не слать»), и id не входил в
   `NEMOTRON_THINKING_MODELS` хука. То есть селектор `off`…`high` в UI
   переключался, а на провод не уходило ни одного параметра — модель думала в
   своём дефолте (`reasoning` включён по умолчанию), и её reasoning-токены
   списывались с тех же 8192.

`pi-ai` в этой ветке действительно не шлёт ничего: `openai-completions` ставит
`reasoning_effort` только при `compat.supportsReasoningEffort`, а ветки
`thinkingFormat` (`zai`/`qwen`/`deepseek`/`openrouter`/…) не совпадают.

## §3. Что говорит документация NVIDIA

NIM 2.0.13, `get-started/advanced/get-started-nemotron-3.5-super-vl.html`:

> Reasoning is on by default, and reasoning tokens count toward `max_tokens`. […]
> With reasoning on, the model returns its chain of thought in the `reasoning`
> field […] so a small `max_tokens` can end inside the reasoning and leave
> `content` empty.
> Set `max_tokens` to 8192 or higher for video requests, **or turn reasoning off**
> for the request with `"chat_template_kwargs": {"enable_thinking": false}`.

Таблица «Control Reasoning»:

| поле | значения | эффект |
|---|---|---|
| `chat_template_kwargs.enable_thinking` | `true` (default) / `false` | `false` выключает reasoning, модель отвечает сразу |
| `reasoning_effort` | `low` / `medium` / `high` | `low`/`medium` — короткий режим, `high` (или отсутствие поля) — полный |

`docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b`
(reference модели): `max_tokens` 1–32768, default 16384; `reasoning_budget`
-1–32768, default 16384; рекомендованный сэмплинг — **текст** 1.0/0.95,
**vision** 0.6/0.95. Схема запроса (`modelschemas.com`, снята с того же
reference) добавляет: «the hosted function caps completion budgets at 131072
tokens» и «Prefer `reasoning_effort` for the none, low, and high reasoning
modes».

Отдельно предупреждение, которое закрывает один соблазн: `thinking_token_budget`
для этой модели **не** инструмент ограничения reasoning — по достижении бюджета
ответ не завершается, а продолжается до `max_tokens` и кончается
`finish_reason: "length"` с пустым `content`. Значит поле
`compat.thinkingTokenBudgetField` из pi-ai здесь не подходит (и `reasoning_budget`
в его перечислении нет вовсе).

## §4. Решение (в `overrides/models.json`)

```json
"nvidia/nemotron-3.5-super-vl-120b-a12b": {
  "reasoning": true,
  "maxTokens": 32768,
  "compat": { "supportsReasoningEffort": true },
  "thinkingLevelMap": {
    "off": "none", "minimal": "low", "low": "low",
    "medium": "high", "high": "high", "xhigh": "high", "max": "high"
  }
}
```

- Нативный путь pi (как у `minimaxai/minimax-m3.1-flash`): `supportsReasoningEffort:
  true` + карта уровней, и pi сам кладёт `reasoning_effort` — `off`→`none`
  документированно выключает reasoning-токены.
- `chat_template_kwargs.enable_thinking` **не** используется, хотя карточка
  вендора его показывает: NVIDIA называет `reasoning_effort` предпочтительной
  формой, а два хозяина одного решения (хук + карта) дали бы
  `enable_thinking=true` рядом с `reasoning_effort=none` — и тогда никто не
  знает, что победит. `test/transform.test.ts` фиксирует, что хук семейства
  `nemotron` этот id не трогает.
- `maxTokens: 32768` — потолок из reference модели; `reasoning_budget` по
  умолчанию 16384, то есть при таком бюджете ответу остаётся ещё столько же.
- `samplingParams` **не** записаны: у модели текст и vision расходятся
  (1.0/0.95 vs 0.6/0.95), а pi выбирает сэмплинг по модели, не по содержимому
  запроса — записывать одну из пар значило бы врать про вторую.

## §5. Живые прогоны (2026-10-30, по явной просьбе пользователя)

### §5.1. Приём `reasoning_effort` на hosted-эндпоинте

Тривиальный промпт («Reply with exactly the word OK.»), `max_tokens: 512`,
`stream: false`, ключ из пула (маска только в логе):

| тело запроса | статус | reasoning | ответ | вывод |
|---|---|---|---|---|
| `reasoning_effort: "none"` | 200 | **0** токенов (0 симв.) | `OK` | выключение работает — именно это уходит на уровне `off` |
| `reasoning_effort: "low"` | 200 | 31 токен | `OK` | принимается |
| `reasoning_effort: "medium"` | 200 | 22 токена | `OK` | **принимается** (в reference поля нет, в NIM-гайде `low`/`medium`/`high` есть) |
| `reasoning_effort: "high"` | 200 | 24 токена | `OK` | принимается |
| `reasoning_effort: "off"` | **400** | — | — | сентинел `"off"` невалиден: `off` в UI обязан маппиться в `none` |
| `chat_template_kwargs.enable_thinking=false` | 200 | 0 | `OK` | альтернативный путь тоже работает (контроль) |

Итог правки: карта уровней уточнена после прогона — `medium` теперь `medium`
(в первой редакции был `high` по документации). Сервер это значение принимает,
а незачем отображать средний уровень в максимальный.

### §5.2. Потолок `max_tokens` (400-оракул, 2 запроса)

| проба | результат |
|---|---|
| `max_tokens: 20 000 000` | `400 Validation: Max tokens must not exceed 1048576` |
| `max_tokens: 1 048 576` | `200` |

То есть **серверный** потолок равен контексту (1M), а не карточным 32768:
reference модели (`1..32768`, дефолт 16384) — это карточный потолок вывода.
Пишем `maxTokens: 32768` намеренно: это карточное значение и оно оставляет
`reasoning_budget` (дефолт 16384) плюс столько же на ответ; задирать до 1M
значило бы просить у модели мегабайт вывода на каждом ходу.

### §5.3. End-to-end через сам pi

`pi -p -ne -e extensions/pi-nvidia-plus.ts --model nvidia/nemotron-3.5-super-vl-120b-a12b ...`
(изоляция от прочих расширений, включая `pi-retry`, который и делал цикл):

| уровень | запрос | что ушло на провод | результат |
|---|---|---|---|
| `off` | «Reply with exactly the word OK.» | `max_tokens=32768, reasoning_effort="none"` | `OK` за **1.8 с** |
| `high` | «What is 47*13+9? Answer with the number only.» | `max_tokens=32768, reasoning_effort="high"` | `620`, без обрыва, ~40 с с рассуждением |

Провод сверен по `PI_NVIDIA_PLUS_DEBUG=1` (`request-after` в
`<agentDir>/nvidia-plus-debug.log`), а не по догадке.

### §5.4. Что осталось

Сэмплинг для vision (`0.6/0.95` при картинке против `1.0/0.95` на тексте) — не
записан намеренно и ждёт реального кейса: pi выбирает сэмплинг по модели, а не
по содержимому запроса, поэтому одна из пар заведомо будет врать.

## §6. Побочное наблюдение: цикл продления — не наша сторона

Обрыв в pi рисуется плашкой *Response was truncated before completion.*
(`assistant-message` в `dist/` хоста, ветка `stopReason === "length"`).
Автопродолжение — `@monotykamary/pi-retry`: на `stopReason: "length"` он шлёт
скрытую реплику `pi-retry:continue` и **не ограничивает число итераций**
(`stateContinuation`, «Max_tokens continuation state (indefinite - no cap
needed)»). Для модели, которая весь бюджет тратит на reasoning, это означало 89
шагов и ~89×8192 выходных токенов. Расширение тут ничего не меняет: лечится
причина (карта уровней + потолок), а не цикл.
