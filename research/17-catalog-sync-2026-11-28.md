# 17 — Синхронизация каталога NIM и репробинг эндпоинтов (2026-11-28)

Дата: 2026-11-28.
Запрос: обновить эндпоинты и сведения о них по
<https://build.nvidia.com/models>, прогнать живые пробы.
Метод: keyless `GET /v1/models` и keyless `POST /v1/chat/completions`
(метод [`06`](06-gateway-recon-keyless-oracles.md), §1 — без ключа и без
квоты), keyless-ретест всех 47 записей `DEAD_MODELS`, малые авторизованные
пробы (тривиальный промпт, `max_tokens` 16–512), 400-оракул `max_tokens`
(метод [`11`](11-pi-1.2-catalog-fields-probes.md), §2) и перемер
keyless-таблицы провайдеров (`scripts/proxy-pool-audit.mjs providers`,
репорт [`08`](08-proxy-pool-provider-matrix.md)).

Это **продолжение** [`16`](16-catalog-sync-2026-11-26.md): значения,
датированные 26-м, не переписываются задним числом, а лишь перепроверяются
здесь.

## §1. Снимок каталога (NIM vs pi 1.7.0)

- Живой `/v1/models` (keyless, 2026-11-28): **30 id → 14 чат + 16 не-чат**
  (embed / guard / content-safety / translate / detector / calibration /
  nvclip / starcoder2). Состав чат-лексики не изменился с 26-го.
- Встроенный каталог **pi 1.7.0** (`$PIAI/dist/providers/data/nvidia.json`):
  **11 записей**, дефолт по-прежнему `nvidia/nemotron-3.5-super-vl-120b-a12b`
  (`$PI/dist/core/model-resolver.js`). Каталог **побайтово совпадает** с
  1.6.1 — подтверждено диффом обоих `nvidia.json`, новых id и правок карточек
  нет. Тем самым ретест 1.7.0 из release 0.5.1 («pi 1.7.0 touches no nvidia
  id») держится и на уровне данных провайдера, а не только changelog.
- Относительно 11 встроенных карточек в живом NIM есть **3 чат-id без
  карточки pi**: `mistralai/mistral-large-4-1t-a52b`,
  `moonshotai/kimi-k3.1-pro` и `nvidia/nemotron-3.5-bolt-e4b` (последний
  несёт нашу собственную карточку в `overrides/models.json`). Первые два
  остаются без карточки и оверрайда — см. §4.
- Метаданные прямо в объекте `/v1/models` приходят **не у всех**: в этот раз
  их нёс только `moonshotai/kimi-k3.1-pro` (`context_window: 1048576`,
  `model_type: "vlm"`, `supports_structured_output/thinking/tools: true`).
  Полагаться на них как на источник каталога нельзя — только как на подсказку.
- Не-чат id с живым HTTP-роутом (`nvidia/nemotron-3.5-content-safety`,
  `nvidia/riva-translate-4b-instruct-v2`, `nvidia/ising-calibration-1.5-31b`,
  `nvidia/ai-synthetic-video-detector`) на keyless POST отвечают `401` (роут
  есть), но чат-контракта не имеют — лексика `NON_CHAT_PATTERNS` отсеивает их
  корректно.
- `build.nvidia.com/models` (источник запроса) отражает тот же живой набор:
  чат-ids совпадают с `/v1/models`, а `nemotron-3.5-parse`, `embed-1b/8b`,
  `rerank-8b` и прочая не-чат-обвязка приходят в не-чат ветке (в
  `DEAD_MODELS`/каталог не идут).

## §2. Роут- и EOL-оракул (keyless, без квоты)

- Роут-проба 30 id: **21 route / 9 no-route / 0 eol / 0 other**. Эвристика
  `isChatModel()` дала **ноль ложных срабатываний** — ни одна модель, которую
  она пускает в чат, не оказалась без роута.
- EOL-проба **всех 47 записей `DEAD_MODELS`**: **44/47** отдали
  `application/problem+json` с точной датой `410 EOL`, и **каждая из 44
  совпала с датой в таблице** (16×`2026-11-15`, 4×`2026-08-26`, 2×`2026-08-07`,
  2×`2026-09-01`, и по одной 2026-08-25 / -28 / -03 / -09-03 / -09-09 /
  -09-14 / -09-21 / -10-03 / -10-15 / -10-28 / -11-12 / -11-16 / -11-18 /
  -11-24). Правок `DEAD_MODELS` ретест не потребовал.
- Оставшиеся **3 записи `404 in every probe`** — `google/gemma-3-4b-it`,
  `google/gemma-3-12b-it`, `nvidia/cosmos-reason2-8b` — на keyless POST снова
  отдают `401` (HTTP-роут жив, смерть на слое NVCF:
  [`06`](06-gateway-recon-keyless-oracles.md), §6.2), поэтому keyless-оракул их
  подтвердить не может. **Авторизованное подтверждение 2026-11-28:** все три
  отдают `404 Function '…': Not found for account '…'` **на валидных ключах**
  (проверено минимум двумя разными ключами/аккаунтами) — смерть
  account-scoped на NVCF, а не на HTTP-роуте. Записи остаются в `DEAD_MODELS`.
- `nvidia/riva-translate-4b-instruct-v2` попадает в не-чат ветку (перевод), но
  keyless POST у него 401; в чат-каталог не добавляется — верно.

## §3. Потолок `max_tokens` стал единым `1 048 576`

400-оракул `max_tokens` больше **не пер-модельный**:

- `max_tokens=20000000` → `400 Validation: Max tokens must not exceed 1048576`
  на **всех** пробованных id (bolt-e4b, lightning, nano-omni, ultra, super-vl,
  step-5-preview, mistral-large-4-1t-a52b, kimi-k3.1-pro).
- Подтверждение «ровно `1048576`»: `200` у bolt-e4b, nano-omni, ultra,
  super-vl, step-5-preview; kimi-k3.1-pro — `HANG` напрямую, но `200` через
  выход пула (маршрутный завис, [`10`](10-nim-route-dependent-hangs-2026-10-12.md));
  mistral-large-4-1t-a52b — `400` даже на `1048576`, потому что его собственный
  `context_length` равен `1048576`, а промпт добавляет сверху (`limit 1048576,
  actual 1048598`).

Это **регресс от [`16`](16-catalog-sync-2026-11-26.md) §3 и
[`11`](11-pi-1.2-catalog-fields-probes.md) §2**, где потолок был разным:
`super`/`lightning` — `1 048 576`, `ultra`/`nano-omni` — без валидации,
`mistral-large-4` принимал `20 000 000`. Теперь потолок один на весь шлюз.

Влияние на расширение — нулевое: `extensions/transform.ts` подставляет
`defaultMaxTokens = ctx.model?.maxTokens ?? 16384`, а не потолок шлюза; ни одна
карточка/оверрайд не зашивает `max_tokens` выше `1 048 576`. Факт зафиксирован
здесь, потому что пер-модельные потолки из `11`/`16` теперь неактуальны.

## §4. Живые пробы отдельных id (с ключом)

- **`nvidia/glm-5.3-flash` (регресс: полный HANG).** 2026-11-28 модель виснет
  на **любом** теле и **любом** выходе: `reasoning_effort` `low`/`high`/`max`/
  `off`/`bogus` и `chat_template_kwargs.enable_thinking=false` /
  `clear_thinking=true` — все семь тел `HANG 23` (таймаут), причём как
  `[direct]`, так и через четыре разных выхода пула; четыре разных ключа дают
  то же. Это **модель-скоупный устойчивый завис** (класс
  [`10`](10-nim-route-dependent-hangs-2026-10-12.md),
  [`12`](12-catalog-sync-2026-10-23.md) §4, [`16`](16-catalog-sync-2026-11-26.md)
  §3 `kimi-k3.1-pro`), а не ключ-скоупный. 26-го эта же модель отвечала `200`
  (тот же ключ, тот же выход) — то есть состояние NIM, не наша поломка.
  Оверрайд `z-ai/glm-5.3-flash` **оставлен** (может ожить, как `muse-glimmer`
  в [`10`](10-nim-route-dependent-hangs-2026-10-12.md) §2), но это вторая
  подряд проверка, где id непригоден; помечено в README (Limitations).
- **`nvidia/nemotron-3-ultra-550b-a55b` / `nvidia/nemotron-3.5-lightning-30b-a3b`
  — нативный `reasoning_effort` подтверждён.** `none` → `200` с нулём
  reasoning-токенов; `low`/`high` → `200` и масштабируют reasoning-канал
  (ultra: 69/91 токенов на low/high; lightning: 113/147); `"off"` → `400`;
  `chat_template_kwargs.enable_thinking=false` → `200`, но reasoning остаётся
  (не выключатель). Совпадает с [`16`](16-catalog-sync-2026-11-26.md) §5 —
  оверрайды (native map `off→none`, `minimal…max→identity`) не меняются.
- **`nvidia/nemotron-3.5-super-vl-120b-a12b`** — то же: `none` → 0 reasoning,
  `minimal`/`low`/`medium`/`high`/`xhigh`/`max` все `200` (шкала принимается
  целиком), `"off"` → `400`. Оверрайд с `maxTokens: 32768` не трогаем.
- **`nvidia/nemotron-3.5-bolt-e4b`** — `enable_thinking` `false` и `true` на
  тривиальном промпте **оба дали 0 reasoning** (в [`16`](16-catalog-sync-2026-11-26.md)
  §3 `true` давал reasoning). Промпт слишком короткий, чтобы делать вывод;
  карточка и хук остаются как есть.
- **`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`** — `enable_thinking:false`
  → 0 reasoning; вендорская пара `0.6/0.95` → reasoning 45 токенов. Оверрайд
  (`samplingParams` + `samplingParamsByThinkingLevel`) без изменений.
- **`stepfun-ai/step-5-preview`** — сэмплинг `1.0/0.95/top_k=0` принят `200`,
  reasoning 46 токенов; поведение из `[14]`/`[16]` держится.
- **`mistralai/mistral-large-4-1t-a52b` (жив, но карточку не добавляем).**
  Точечный репробинг 2026-11-28: `{}` → `200` (и через выход, и 3/3 напрямую),
  канал `content` **не пуст** («OK»), reasoning 16–17 токенов. Потолок
  `max_tokens=20000000` → `400` (единый шлюзовый `1 048 576`), а ровно
  `1048576` → `400 context_length` (`limit 1048576, actual 1048598`) — у модели
  свой `context_window` = `1 048 576`, и промпт добавляется сверху. Прежний
  «иногда `content: null`» из [`16`](16-catalog-sync-2026-11-26.md) §3 **не
  воспроизвёлся**. Карточку всё равно **не добавляем**: live `/v1/models` не
  несёт лимитов, официальной карточки под id нет, а pi 1.5.0 уже показала, что
  своя `models`-запись бьёт встроенную карточку целиком и становится
  даунгрейдом (тот же урок, что с `minimax-m3.1-flash`: свои дельты идут в
  `modelOverrides`, когда id появится у pi). До этого id в pi неселектируем, как и раньше.
- **`moonshotai/kimi-k3.1-pro` (жив в `/v1/models`, но непригоден).**
  Точечный репробинг 2026-11-28: генерационные тела (`{}` и
  `max_tokens=1048576`) виснут и напрямую, и через **все** выходы пула; прошёл
  лишь один 400-валидатор (через выход, 11.7 с) — то есть HTTP-роут есть,
  а генерация не отвечает. Метаданные в `/v1/models` (`context_window:
  1048576`, `model_type: "vlm"`, `supports_thinking/tools/structured_output`)
  это подтверждают, но пользоваться нельзя. Класс — [`16`](16-catalog-sync-2026-11-26.md)
  §3 `kimi-k3.1-pro` / [`12`](12-catalog-sync-2026-10-23.md) §4 `gemma-4-31b-it`.
  Карточку не добавляем.
- **`fastino/gliner2-pii`** — `422 invalid extraction request…` (негативный
  контроль NER-фильтра, [`16`](16-catalog-sync-2026-11-26.md) §3) держится.
- **`nvidia/cosmos-reason2-8b`** — все три контрактные пробы (`reasoning_effort`
  `high`/`bogus`, `enable_thinking:false`) → `404`; подтверждает §2.

## §5. Эндпоинты пула: выходы, ключи, таблица провайдеров

- **Выходы (`proxies:audit`):** 16/16 стабильны — три раунда подряд, все
  `< 20 с`. Пул не менялся.
- **Ключи (`keys:auth-check`, без генерации):** 325/325 живы, 0 мёртвых
  (404-оракул [`09`](09-key-validity-without-generation.md)). Чистить нечего.
- **Таблица keyless-целей провайдеров (`proxies:providers`):** правка —
  **`deepseek` переведён с `expectation: "any"` на `"json"`**: оба замера
  (напрямую и через выход пула) дают `401 application/json` с телом
  `Authentication Fails (governor)`. Прежнее «401 без content-type», ради
  которого стояло `any` (комментарий таблицы, [`08`](08-proxy-pool-provider-matrix.md)),
  больше не воспроизводится; «any» ослабляло распознавание вендорской
  заглушки прокси, так что `json` здесь строже. `together` (401 text/plain) и
  `cohere` (403 text/html) остаются `any` — у них не-JSON держится.
  `nvidia` напрямую в этом окружении не отвечает (`Connect Timeout`), но через
  выход — `200 application/json`; таблица не при чём.

## §6. Принятые решения

1. **Оверрайды не меняются; добавлены две `models`-карточки.** Ни одна проба
   не разошлась с существующими картами мышления/сэмплинга; пер-модельный
   потолок из `11`/`16` не зашит ни в одну карточку. Новые карточки (§7) идут
   отдельно от 7 `modelOverrides`.
2. **Значения `DEAD_MODELS` не меняются** — ретест подтвердил все 44 даты; три
   `404 in every probe` подтверждены авторизованно как account-scoped NVCF-404
   (комментарий модуля данных дополнен датой 2026-11-28).
3. **Таблица провайдеров:** `deepseek` → `expectation: "json"` (см. §5).
4. **Обе карточки добавлены в `models`** (по запросу, 2026-11-28): id живы в
   NIM, но отсутствуют во встроенном каталоге pi 1.7.0 — без своей карточки они
   неселектируемы (как `bolt-e4b`). Лимиты и контракт — §7. Гейт 1b
   `test/overrides-schema.test.ts` покраснеет, если pi когда-нибудь внесёт эти id
   в базу: тогда запись переедет в `modelOverrides` (урок `minimax-m3.1-flash`).
5. **`glm-5.3-flash`:** оверрайд оставлен (оживаемость), регресс-завис вынесен
   в README (Limitations) как наблюдение на 2026-11-28.

## §7. Две новые карточки: `mistral-large-4-1t-a52b` и `kimi-k3.1-pro`

Добавлены по явному запросу (методика лимитов — [`../skills/pi-provider-plugin/references/research.md`](../../skills/pi-provider-plugin/references/research.md):
Lane B — карточки вендора как гипотезы, Lane C — free-оракулы). Источники по
доверию: живой замер > machine-readable listing/API-reference > проза карточки.

### `mistralai/mistral-large-4-1t-a52b`

- **Документация.** Modelcard (build.nvidia.com): вход Text, Image, выход Text,
  1T-total / 52B-active MoE, «combined input/output context length is 1M tokens»;
  get-started (docs.nvidia.com): 1 048 576-токенное окно. API-reference: `max_tokens`
  Default 4096, **Minimum 1 / Maximum 262 144**; `reasoning_effort` = `low`|`medium`|`high`
  (**Default `high`**), модель **думает всегда**, `"none"` → **HTTP 400**.
  Проза build-«Specifications» сказала «Context Length: 262K» — **расхождение**
  (решает замер).
- **Free-оракулы.** `GET /v1/models/{id}` (keyless) отдаёт только базовые поля —
  лимитов нет. 400-оракул `max_tokens`: `262144` / `262145` / `300000` → **200**
  (докский потолок 262 144 **не enforced**); `1048576` → `400 context_length`
  (`limit 1048576, actual 1048598`). ⇒ окно = **1 048 576**, и `max_tokens`
  ограничен только **общим бюджетом `prompt + max_tokens ≤ 1 048 576`**.
- **Контракт мышления (живые пробы).** `reasoning_effort` `low`/`medium`/`high` →
  `200` (reasoning_tokens 30–31), без поля → `200` (reasoning 75, дефолт `high`);
  `none` / `off` / `bogus-level` → **400**. Форс-ризонер.
- **Карточка:** `contextWindow` `1048576`, `maxTokens` `1048576` (общий бюджет —
  README-caveat, не уменьшаем), `input ["text","image"]`, `reasoning: true`,
  `compat.supportsReasoningEffort: true` (host `nvidia` — исключение авто-детекта
  pi, флаг обязателен), карта `off: null` (скрыть), `minimal/low→low`,
  `medium→medium`, `high/xhigh/max→high` (доковая шкала `low|medium|high`).

### `moonshotai/kimi-k3.1-pro`

- **Документация.** build-карточка: context 1M, вход Text/Image/Video, выход Text,
  function calling / structured output / reasoning; `/v1/models` (и retrieve)
  несёт `context_window: 1048576`, `model_type: "vlm"`, `supports_structured_output/thinking/tools: true`.
  Infer-reference (docs.api.nvidia.com): `max_tokens` **1..65 536**, `reasoning_effort`
  `low`|`medium`|`high`|`max` (**Default `low`**), `temperature 0..1` (прочие
  sampling-параметры зафиксированы вендором); build-apireference дал enum
  `low|high|max` — **расхождение** в наборе effort-токенов. Выходной лимит
  карточкой **не раскрыт**.
- **Замер невозможен.** Генерация мертва: `{}`, `max_tokens=1048576` и
  стриминговый `max_tokens=64` (`reasoning_effort=low` и без) виснут и напрямую,
  и через выходы пула (0 байт до таймаута 45 с; в §4 — то же на 3 выходах).
  Прошёл лишь один 400-валидатор (через выход). ⇒ контракт мышления и потолок
  **doc-only, пробой не подтверждены**.
- **Карточка:** `contextWindow` `1048576` (замер через retrieve + карточка),
  `maxTokens` `65536` (doc-only), `input ["text","image"]` (pi не умеет video),
  `reasoning: true` (`supports_thinking` в listing + карточка),
  `compat.supportsReasoningEffort: true`, карта `off: null` (форс-ризонер, как
  `kimi-k3`), `minimal/low→low`, `medium→medium`, `high→high`, `xhigh/max→max`.
- **Caveat.** Карточка делает id селектируемым, но **модель сейчас не генерирует**
  (см. README Limitations); при оживании маршрута контракт мышления надо
  перемерить и при расхождении поправить карту.

Обе записи — в `models` (не `modelOverrides`), потому что id отсутствуют во
встроенном каталоге pi 1.7.0; гейт 1b отслеживает возможное появление id у pi.
