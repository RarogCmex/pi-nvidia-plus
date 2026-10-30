# research/ — датированные разборы, на которых стоит расширение

Это **свидетельства**, а не документация пользователя. Пользовательская
документация — в [../README.md](../README.md). Каждый файл здесь отвечает на
один вопрос, заданный при проектировании, и помечен датой, когда ответ был
получен.

## Состав

| файл | о чём | дата | метод |
|---|---|---|---|
| [`01-provider-surface.md`](01-provider-surface.md) | что именно делает `pi.registerProvider("nvidia", …)` со встроенным провайдером; какие `compat`-поля и нативные `thinkingFormat` есть у pi | 2026-08-26 | чтение исходников pi и pi-ai |
| [`02-nim-catalog-audit.md`](02-nim-catalog-audit.md) | живой аудит каталога NIM: какие id отвечают, какие 404/410 | 2026-08-26 | не-стриминг chat completion, `max_tokens=16`, повторы по правилам из §«Методологические оговорки» |
| [`03-thinking-mappings.md`](03-thinking-mappings.md) | как управлять мышлением по семействам NIM; где хватает нативного формата pi, а где нужна конверсия в хуке | 2026-08-26 | живые пробы (`stream: false`, `max_tokens` 256–700) + разбор референсных расширений |
| [`04-proxy-mechanics.md`](04-proxy-mechanics.md) | куда в pi/pi-ai можно подставить undici-диспетчер, чтобы маршрутизировать только один хост | 2026-08-26 | чтение исходников |
| [`05-pi-internals.md`](05-pi-internals.md) | как устроен провайдер `nvidia` внутри pi: слои каталога, авторизация, ретраи | 2026-08-26 | чтение исходников |
| [`05-reference-plugins.md`](05-reference-plugins.md) | разбор двух существующих NIM-расширений как материал к выбору архитектуры | 2026-08-26 | чтение опубликованных пакетов |
| [`06-gateway-recon-keyless-oracles.md`](06-gateway-recon-keyless-oracles.md) | что можно узнать о NIM **без ключа** (три исхода keyless-пробы: 404/401/410); ложно-положительный в `NON_CHAT_PATTERNS`; непокрытый класс отказа — деградация вывода при HTTP 200 и рабочий детектор repetition-collapse; приёмы стороннего key-rotation прокси | 2026-10-05 | keyless-пробы `integrate.api.nvidia.com` (80 моделей) + read-only разбор стороннего шлюза |
| [`07-kimi-k3-thinking-probe.md`](07-kimi-k3-thinking-probe.md) | живая проба kimi-k3 **с ключом**: карта мышления была инертной (`supportsReasoningEffort:false`), валидные варианты `reasoning_effort` у NIM (`none`…`max`, `off`→400), коллапс reasoning-канала воспроизведён напрямую и **не зависит от уровня** — гипотеза 06 §3 «off→null спасёт» опровергнута; боевая проверка детектора `degenerate.ts` | 2026-10-05 | живые `POST /v1/chat/completions` с ключом pi (14 запросов) + чтение `dist/` pi-ai |
| [`08-proxy-pool-provider-matrix.md`](08-proxy-pool-provider-matrix.md) | однороден ли пул выходов: матрица 29 выходов × 16 keyless-целей — NIM 29/29, но провайдер-селективность реальна (webshare-выход виснет на openai/google/groq/xai/cerebras/fireworks/huggingface при живом NIM); качество для NIM не предсказывает качество для остальных | 2026-10-10 | 928 keyless-проб каталогов через агенты выходов (undici pi), 2 раунда, 20 с |
| [`09-key-validity-without-generation.md`](09-key-validity-without-generation.md) | ключ NIM проверяется БЕЗ генерации: auth идёт раньше резолва функции, поэтому 403 = мёртв, 404-for-account = жив; рабочий прогон 436 ключей — 384/52/0, ноль токенов; 404 двусмыслен, если модель не из живого каталога (резолв-до-auth из 06) | 2026-10-10 | `POST /v1/chat/completions` без поля `messages`, модель из keyless-каталога + контроль фейковым ключом |
| [`10-nim-route-dependent-hangs-2026-10-12.md`](10-nim-route-dependent-hangs-2026-10-12.md) | зависание запросов NIM зависит от пары «модель × выход» (один выход в одну минуту виснет на glm-5.3 и отвечает на kimi-k3): таймауты 300 с оставляли карантин, ротацию и ретраи мимо; ретест DEAD_MODELS (muse-glimmer воскресла), сверка карточек build.nvidia.com (1M у super/lightning подтверждён живой пробой ~300K токенов) и починка сломанной карточки deepseek-v4.1-flash | 2026-10-12 | матрица авторизованных проб 11 моделей × direct+13 выходов (2+ раунда), keyless-роуты, длинноконтекстные пробы, чтение исходников undici 8.10.2 и pi-ai provider-retry |
| [`11-pi-1.2-catalog-fields-probes.md`](11-pi-1.2-catalog-fields-probes.md) | поля каталога pi 1.0.2–1.2.0 для NIM: официальные sampling-рекомендации nemotron (super/lightning 1.0/0.95, nano-omni 0.6/0.95 vs off 0.2/top_k=1), записаны в overrides; 400-оракул потолка `max_tokens` (cap = 1 048 576 у super/lightning, у ultra/nano-omni валидации нет); 0731 получила явный 410; `inputLimits` отложено — pi ресайзит сам | 2026-10-13 | чтение схем/бандла pi 1.2.0, карточки docs.api.nvidia.com, живые пробы (~30 вызовов, stream:true, обрыв тела) |
| [`12-catalog-sync-2026-10-23.md`](12-catalog-sync-2026-10-23.md) | синхронизация каталога: bolt-e4b — новый член семейства nemotron (enable_thinking/low_effort, дефолт off, cap 1 048 576), m3.1-flash — `thinking_mode` игнорируется, нативный `reasoning_effort` (off→400), kimi-k3 — 410 EOL 2026-10-15, ретест всех «404 in every probe» (снова 404), gemma-4-31b-it висит даже с `enable_thinking=false` — в каталог не добавлена | 2026-10-23 | keyless-роуты, авторизованные пробы max_tokens=16, 400-оракулы усилия/`max_tokens`, карточки build.nvidia.com и HF |
| [`13-proxy-tunnel-rejection-2026-10-23.md`](13-proxy-tunnel-rejection-2026-10-23.md) | 407-стена авторизации прокси — это отказ CONNECT (`unreachable`), а не «не определён»: undici отдаёт его как `UND_ERR_ABORTED` без `statusCode`/`cause`, распознаём по тексту; 8 выходов пула из 29 были «неизвестны», а на деле не работали; сводка `proxy check` теперь печатает причину по каждому не-ok выходу | 2026-10-23 | живая диагностика пула (29 выходов), локальный прокси с 407 на CONNECT, чтение undici 8.10.2 |
| [`14-nemotron-super-vl-truncation-2026-10-30.md`](14-nemotron-super-vl-truncation-2026-10-30.md) | «Response was truncated before completion» на дефолтной модели pi 1.4.0: карточка хоста даёт `maxTokens` 8192 и `supportsReasoningEffort: false` без карты уровней, а у модели reasoning включён по умолчанию и его токены идут в тот же бюджет — каждый ответ кончался `length` на пустом `content` (89 раз подряд, продлевал `pi-retry`); лечится нативным `reasoning_effort` (off→none) плюс `maxTokens` 32768 по документации NIM | 2026-10-30 | разбор записей живой сессии pi + встроенная карточка pi 1.4.0/pi-ai + документация NVIDIA (NIM 2.0.13, reference модели, build-карточка); живых проб не было — что осталось непроверенным, §5 |
| [`15-catalog-card-audit-2026-10-30.md`](15-catalog-card-audit-2026-10-30.md) | аудит встроенных карточек pi 1.4.0 против документации вендоров: у всех 21 id в каталоге NIM мышление не управляется (нет карты уровней + `supportsReasoningEffort:false`); найдены три живые модели без нашего покрытия (muse-glimmer — native `reasoning_effort` none…max + вендорный сэмплинг 0.95/1.0, diffusiongemma — только `chat_template_kwargs.enable_thinking`, step-5 — reasoning не выключается и `enable_thinking=false` запрещён вендором), ошибка в GLM-хуке (reasoning не гасится, нужен `clear_thinking=true`, шкала low|high|max) и оверрайд на мёртвом `z-ai/glm-5.3` (410 EOL 2026-10-28); класс «maxTokens == contextWindow» снят — pi-ai клампит на каждом запросе | 2026-10-30 | keyless `GET /v1/models` и keyless `POST /v1/chat/completions` (без ключа, без квоты), reference-схемы docs.api.nvidia.com для hosted-эндпоинта, встроенный каталог pi 1.4.0/pi-ai; новые гейты в тестах (оверрайд не может ссылаться на мёртвый id) |
| [`goal.md`](goal.md) | **исторический** план работ: приоритеты P0…P5, открытые вопросы, критерии приёмки | 2026-08 | — |

## Как это читать

**Версии.** Разборы писались против pi 0.73 (установленный
`@earendil-works/pi-coding-agent` и его `pi-ai` на момент написания). Само
расширение в настоящий момент проверено против **pi 0.87.1 / pi-ai 0.87.1 /
undici 8.10.2 / Node 26**, а с 2026-09-30 также против **pi 0.99.1**, с
2026-10-03 против **pi 1.0.0** (бандл нёс те же undici 8.10.2 и
`@types/node` 22.19.19), с 2026-10-12 против **pi 1.2.0** (undici всё ещё
8.10.2, `@types/node` 26.6.5) и с 2026-10-22 против **pi 1.3.0 / 1.4.0**
(undici по-прежнему 8.10.2, `@types/node` 26.6.5, `engines.node` тот же):
typecheck и все 27 файлов тестов зелёные, а
загрузка расширения на 1.0.0, 1.2.0 и 1.4.0 проверена в изолированном
`PI_CODING_AGENT_DIR`. Пробы, сделанные позже даты файла, в эти разборы не
вносились — они записаны в комментариях кода (например, `DEAD_MODELS` в
`extensions/pi-nvidia-plus.ts` несёт дату каждой пробы). Две поправки к тому,
что ниже датировано старым хостом: с pi 1.4.0 атрибуционные заголовки
(включая NIM) проставляет client identity в `pi-ai` (`getIdentityHeaders`), а
не `provider-attribution.js` + `transformHeaders` из `01` §3, и хук
`before_provider_headers` их больше не видит; встроенный каталог nvidia на
1.4.0 — 21 id, в нём появилась полная карточка
`deepseek-ai/deepseek-v4.1-flash` и новые `nvidia/nemotron-3.5-super-vl-120b-a12b`
(дефолт хоста) и `stepfun-ai/step-5-preview`, а
`nvidia/nemotron-3-super-120b-a12b` с `moonshotai/kimi-k3` из него ушли —
таблицы `02`, `10` и `11` читай с этой поправкой.

**Цитаты путей и номера строк.** Файлы `01`, `04`, `05-pi-internals` цитируют
скомпилированный `dist/` pi по номерам строк. Обозначение `$PI` — каталог
установленного `@earendil-works/pi-coding-agent`, `$PIAI` —
`$PI/node_modules/@earendil-works/pi-ai`. **Номера строк хрупки**: между
версиями pi они уезжают. Долговечная часть цитаты — имя символа
(`composeModelProvider`, `applyExtension`, `rawModelHeaders`,
`recomposeProvider`); ищите по нему.

**`$PI` не равен `$(npm root -g)`.** pi может стоять в глобальном префиксе npm,
в nvm, в pnpm-сторе или в пользовательском префиксе (`~/.local`). Чтобы узнать
свой `$PI`:

```bash
node -e 'const fs=require("fs"),path=require("path");let p=fs.realpathSync(require("child_process").execFileSync("which",["pi"],{encoding:"utf8"}).trim());while(p!==path.dirname(p)&&!(fs.existsSync(path.join(p,"package.json"))&&JSON.parse(fs.readFileSync(path.join(p,"package.json"))).name==="@earendil-works/pi-coding-agent"))p=path.dirname(p);console.log(p)'
```

`scripts/link-pi.mjs` делает тот же поиск автоматически.

**Номера рабочих элементов.** `тикет NN` и `Story NN` в этих файлах и в
комментариях кода — метки происхождения из локального, **не публикуемого**
трекера (`.scratch/`). Из репозитория они не резолвятся; смысл всегда стоит в
окружающем тексте. `исследование NN` / `research NN` / `находки NN` резолвятся —
это файлы из таблицы выше.

**`goal.md` — не спецификация текущего состояния.** Приоритеты `P0…P5` —
словарь того плана; в README их нет намеренно. Пункт «Не цели» и «Критерий
приёмки» описывают замысел на август 2026, а не контракт опубликованной версии.
Фактическое поведение — в README и в коде.

**Ключи.** Живые пробы делались с несколькими независимыми ключами `nvapi-*`.
Ни значения, ни префиксы ключей в этих файлах не приводятся — только условные
номера и результаты. **Исключение — файл 06**: его пробы к
`integrate.api.nvidia.com` сделаны вообще без ключа (`GET /v1/models` и
`POST /v1/chat/completions` без заголовка `authorization`), поэтому квоту они не
тратят и воспроизводятся кем угодно; поведенческие замеры моделей в нём сняты
через сторонний открытый прокси, что помечено в легенде достоверности файла.
