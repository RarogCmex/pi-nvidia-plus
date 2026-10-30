# 15 — Аудит современных карточек pi против документации вендоров (2026-10-30)

Дата: 2026-10-30. Повод — разбор сессии, где `nemotron-3.5-super-vl` обрывался на
`finish_reason: "length"` ([`14`](14-nemotron-super-vl-truncation-2026-10-30.md)):
тот дефект был не про одну модель, а про класс — «карточка pi объявляет модель
reasoning-моделью, но не даёт ни одного способа управлять мышлением, и её
`maxTokens` не рассчитан на reasoning». Вопрос: сколько ещё таких.

Метод (всё бесплатно — ни одного токена квоты):

- офлайн — встроенный каталог pi 1.4.0
  (`$PIAI/dist/providers/data/nvidia.json`, 21 id) и наш `overrides/models.json`;
- **keyless** `GET /v1/models` (живой каталог NIM, 85 id) — метод [`06`](06-gateway-recon-keyless-oracles.md);
- **keyless** `POST /v1/chat/completions` (без `authorization`): 401 = роут жив,
  410 = EOL с точной датой, 404 = не резолвится — тот же оракул, что в `06` §1;
- документация вендора: NIM «Control Reasoning» / get-started страницы,
  `docs.api.nvidia.com/nim/reference/<id>-infer` (это схема **hosted**
  `integrate.api.nvidia.com` — curl в примерах идёт туда), build-карточки.

## §1. Классы дефектов

**A. `reasoning: true`, но управление мышлением инертно.** У pi в каталоге
NIM **ни один** id не несёт `thinkingLevelMap`, и у всех — `supportsReasoningEffort:
false`; `thinkingFormat` тоже не задан. Значит без нашего оверрайда запрос
уходит без параметра мышления на любом уровне, а селектор `off`…`max` в UI
остаётся декорацией. Опасность не косметическая: у моделей с reasoning по
умолчанию это и есть механизм «бюджет ушёл в размышление, `content` пуст».

**B. `maxTokens` меньше реального потолка и меньше потребности reasoning.**
Найдено ровно один раз (`super-vl`: 8192 при серверном дефолте 16384 и
потолке 32768) — причина обрыва в `14`.

**C. Оверрайд (или карточка) висит на мёртвой модели.** `z-ai/glm-5.3` получил
**410 EOL 2026-10-28** (keyless, точная дата) и ушёл из `/v1/models`; оверрайд
продолжал «улучшать» несуществующий id.

Класс «`maxTokens == contextWindow`» проверялся отдельно и **снят**:
`pi-ai` клампит `max_tokens` на каждом запросе
(`clampMaxTokensToContext` = `min(model.maxTokens, ctx − prompt − 4096)`), так что
шапка `1048576` у `step-5-preview` безвредна. Прежнее утверждение
[`11`](11-pi-1.2-catalog-fields-probes.md) §2 о «съеденном входном остатке»
относится к другому слою (`contextWindow` — бюджет компакции) и здесь не
воспроизводится.

## §2. Что показала сверка (живые id)

| id | документация вендора | состояние карточки pi | решение |
|---|---|---|---|
| `nvidia/nemotron-3.5-super-vl-120b-a12b` | reasoning on по умолчанию, токены reasoning идут в `max_tokens`; `reasoning_effort` `none`/`low`/`high` (дефолт high); `max_tokens` 1–32768, дефолт 16384 | 8192, effort выключен, карты нет | **сделано** (`14`): effort + `maxTokens` 32768 |
| `meta/muse-glimmer-30b` | `reasoning_effort` `none`…`max`, дефолт **high**; reasoning делит `max_tokens` (1–131072, дефолт 2048); «recommended pair is temperature 0.95 with top_p 1.0. Greedy decoding measurably degrades it» | effort выключен, карты нет, сэмплинга нет | **сделано и проверено**: native effort + `none`…`max` + `samplingParams` 0.95/1.0; `none` тоже думает (§4) → оговорка в статусе |
| `google/diffusiongemma-26b-a4b-it` | мышление **только** через `chat_template_kwargs.enable_thinking` (true/false), `max_tokens` 1–32768 | effort выключен, `thinkingFormat` нет | **сделано иначе, чем планировалось**: проба показала, что `false` (и дефолт) отдают пустой ответ, поэтому не «по уровню», а принудительный `enable_thinking=true` в хуке (§4) |
| `z-ai/glm-5.3-flash` | «Reasoning cannot be turned off»; поддерживается `low`/`high`/`max` (дефолт `max`); `none`/`minimal`/`medium`/`xhigh` **принимаются и исполняются на `max`**; `enable_thinking=false` reasoning не гасит; для чата просят `clear_thinking=true` | effort выключен; наш хук был **гипотезой** и ошибался во всех трёх пунктах (`clear_thinking=false`, `enable_thinking=false` на off, `low`→`high`) | **сделано**: хук переписан — `enable_thinking=true`, `clear_thinking=true`, усилие только `low`/`high`/`max`, `off`→`low` + оговорка в статусе |
| `z-ai/glm-5.3` | — | в каталоге pi есть | **410 EOL 2026-10-28**: оверрайд убран, id в `DEAD_MODELS` |
| `stepfun-ai/step-5-preview` | reasoning «remains enabled on this checkpoint», `enable_thinking=false` **не** выключает (прямое предупреждение в схеме); `reasoning_effort` в hosted-схеме нет; `max_tokens` 1–1048576, дефолт 4096 | effort выключен — и это правильно | **ничего не делаем**: инъекции нет по причине, а не по недосмотру; записано в Limitations |
| `minimaxai/minimax-m3.1-flash` (наша карточка) | reference перечисляет только `max_tokens` (1–65536) и сэмплинг 1.0/0.95, про усилие молчит | нативный `reasoning_effort`, `off`→`none`, `maxTokens` 262144 | **не трогаем**: живые пробы [`12`](12-catalog-sync-2026-10-23.md) §3 показали, что hosted принимает `reasoning_effort` (bogus→400, low/high работают), хотя reference его не описывает — здесь проба сильнее документации |
| `nvidia/nemotron-3.5-bolt-e4b` (наша карточка) | `enable_thinking` + `low_effort`, cap 1 048 576 | хук семейства + карточка | без изменений (пробы `12` §2) |
| `deepseek-ai/deepseek-v4.1-flash`, `openai/gpt-oss-20b`, `poolside/laguna-xs-2.1` | нативный `reasoning_effort` / `chat-template` | уже покрыты | без изменений |
| `meta/llama-3.2-11b-vision-instruct` (4096), `-90b-` (8192) | не reasoning-модели | — | дефект класса B неприменим |
| `moonshotai/kimi-k2.6`, `nvidia/cosmos-reason2-8b`, `google/gemma-3-*`, `mistralai/mistral-7b-instruct-v0.3`, `nvidia/llama-3.1-nemotron-70b-instruct`, `-ultra-253b-v1` | keyless 401 (роут жив, смерть на NVCF-слое) | в `DEAD_MODELS` как «404 in every probe» | без изменений (ретест 2026-10-23 — `12` §1) |

## §3. Новые гейты в тестах

Ручной аудит нашёл класс C — значит, он должен ловиться сам:

- `test/overrides-schema.test.ts` блок 3g: **ни один оверрайд и ни одна своя
  карточка не могут ссылаться на id из `DEAD_MODELS`** (импорт самой таблицы,
  без pi). Это ровно дефект `glm-5.3`.
- блоки 3e/3f: `muse-glimmer` обязан нести `supportsReasoningEffort: true` и
  вендорную пару сэмплинга; у `diffusiongemma` **не должно быть** оверрайда —
  мышление ведёт хук, принудительно (проба §4 показала, что иначе ответ пуст).
- `test/transform.test.ts`: GLM — `clear_thinking` всегда `true`,
  `enable_thinking` всегда `true`, `reasoning_effort` только из
  `low|high|max` **на всех семи уровнях** (иначе `none`/`minimal`/`medium`
  уехали бы на провод и сервер молча исполнил бы их на `max`); статус-строка
  показывает реальное усилие и оговорку `planCaveatReasoningAlwaysOn`.

## §4. Живые прогоны (2026-10-30, по явной просьбе пользователя)

| что проверяли | как | результат |
|---|---|---|
| `super-vl`: приём `reasoning_effort` | 6 запросов через `scripts/probe-catalog-fields.mjs` §6 | `none` — **0** reasoning-токенов; `low`/`medium`/`high` приняты (31/22/24); `"off"` — 400 (сентинел невалиден); `enable_thinking=false` — 0. Карта уточнена: `medium`→`medium`. Подробно — [`14`](14-nemotron-super-vl-truncation-2026-10-30.md) §5 |
| `super-vl`: потолок `max_tokens` | 400-оракул, 2 запроса | серверный потолок **1 048 576** (= контексту), карточный — 32768. Оставлено `maxTokens: 32768` |
| `super-vl`: весь путь через pi | `pi -p` с `--thinking off` и `high` | `OK` за 1.8 с и `620` (без обрыва), на проводе `max_tokens=32768` + `reasoning_effort` none/high |
| `muse-glimmer`: `none` против `high` | 2 запроса (§6) | оба 200, `none` **тоже** отдаёт reasoning-канал: 69 выходных токенов против 129. Значит `off` — «минимум», а не «выключено»; оговорка в статусе (`planCaveatReasoningAlwaysOn`), мапа оставлена (`none` — самый дешёвый документированный уровень) |
| `muse-glimmer`: провод | `pi -p --thinking off` + `PI_NVIDIA_PLUS_DEBUG=1` | `reasoning_effort="none"`, `temperature=0.95`, `top_p=1` — как задумано; ответ верный |
| `diffusiongemma`: дефолт / `false` / `true` | 3 запроса (§6) + 2 прогона pi (`--thinking off`/`high`) | дефолт и `false` — 200 с `finish_reason: "stop"`, **1** выходной токен и пустой `content`; в pi это выглядит как `<channel\|>`; с `true` — `OK`/`Paris`. Вывод: мышление включено принудительно хуком на любом уровне (`planCaveatDiffusionGemmaEmpty`), оверрайд не нужен |
| `glm-5.3-flash` | 6 проб × (direct + 3 выхода пула), `--timeout 25000` | **не измеримо сегодня**: все 24 попытки — headers-timeout. Провод не сломан (keyless 401), значит висит сама модель/маршрут — тот же класс, что в [`10`](10-nim-route-dependent-hangs-2026-10-12.md). Маппинг GLM остаётся документационным |

Итог аудита: из четырёх гипотез две подтвердились (super-vl, muse-glimmer), одна
опровергнута (diffusiongemma: «переключатель» оказался не переключателем, а
обязательным флагом — и наследованным дефектом pi-карточки), одна осталась
непроверяемой по сети (GLM).

### Что ещё ждёт пробы

- `glm-5.3-flash` — три запроса, когда маршрут оживёт: `reasoning_effort`
  `low`/`high`/`max` + контроль `enable_thinking=false` (ждать reasoning-канал
  даже на `false`) и `bogus` (ждать 400).
- Сэмплинг для vision у `super-vl` (`0.6/0.95` против `1.0/0.95`) — только по
  реальному кейсу: pi выбирает сэмплинг по модели, а не по содержимому запроса.
- `stepfun-ai/step-5-preview` — проверять нечего, пока вендор не даст выключатель
  reasoning (сейчас прямо предупреждает не слать `enable_thinking=false`).
