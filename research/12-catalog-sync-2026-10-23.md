# 12 — Синхронизация каталога 2026-10-23: bolt-e4b, m3.1-flash, kimi-k3, ретест мёртвых

Дата: 2026-10-23. Метод: keyless-пробы роутов (`GET /v1/models` + `POST
/v1/chat/completions` без `authorization` — исследование 06, §1), авторизованные
пробы `max_tokens=16` (тривиальный промпт, ноль заметной квоты), 400-оракул
`reasoning_effort`/`max_tokens` (метод исследования 11), карточки
build.nvidia.com и Hugging Face. Живой каталог: 85 id, 61 чат, 11 без
chat-роута; против встроенного каталога pi 1.4.0 (21 id).

## §1. Ретест DEAD_MODELS

- Все семь «404 in every probe»-записей, которые pi 1.4.0 держит во встроенном
  каталоге (`google/gemma-3-4b-it`, `google/gemma-3-12b-it`,
  `mistralai/mistral-7b-instruct-v0.3`, `moonshotai/kimi-k2.6`,
  `nvidia/cosmos-reason2-8b`, `nvidia/llama-3.1-nemotron-70b-instruct`,
  `nvidia/llama-3.1-nemotron-ultra-253b-v1`), снова ответили **404** на
  авторизованную пробу `max_tokens=16` — таблица не изменилась. Keyless-оракул
  для них по-прежнему даёт 401 (HTTP-роут жив, смерть на слое NVCF — 06, §6.2).
- Все 410-записи сверены keyless-оракулом: даты EOL совпадают с таблицей.
- **`moonshotai/kimi-k3` — новый труп: 410, EOL 2026-10-15.** Оверрайд из
  `overrides/models.json` убран (pi 1.4.0 вычел id из встроенного каталога ещё
  раньше), id добавлен в `DEAD_MODELS`. Карта `off`→`none` из исследования 07
  переезжает на живого носителя того же паттерна — `minimaxai/minimax-m3.1-flash`.

## §2. nvidia/nemotron-3.5-bolt-e4b — новый член семейства

Вышел 2026-10-23 (блог NVIDIA: «Bolt E4B coming Oct. 23»). Карточки: HF
`nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB` — база Gemma-4-E4B, 8B (4B
эффективных), **только текст**, контекст 64K in / 64K out, рекомендованный
сэмплинг **temperature 1.0, top_p 0.95** в обоих режимах мышления; reasoning —
через `chat_template_kwargs.enable_thinking` (+ «runtime thinking budget»).

Живые пробы на NIM (2026-10-23, через выходы пула):

| запрос | результат |
|---|---|
| plain, `max_tokens=256` | 200, reasoning-канала нет — мышление **выключено по умолчанию** |
| `chat_template_kwargs.enable_thinking=false` | 200, без reasoning — управление работает |
| `chat_template_kwargs.enable_thinking=true, low_effort=true` | 200, `reasoning_content` присутствует |
| top-level `reasoning_effort: "bogus-level"` | **400** — отвергается, как у всего семейства |
| 400-оракул `max_tokens` | потолок **1 048 576** (1 048 577→400, 1 048 576→200) — как у lightning |

Итог: id добавлен в `NEMOTRON_THINKING_MODELS` (`transform.ts`) и получил
собственную карточку в `overrides/models.json` (`models`, id нет во встроенном
каталоге pi). `enable_thinking=true` без `low_effort` на bolt не пробовалась —
семейная экстраполяция, помечена гипотезой в комментарии.

## §3. minimaxai/minimax-m3.1-flash — мышление всегда включено, усилие нативное

Карточка build.nvidia.com: coding/reasoning, 220B MoE, контекст 262K,
text+image+video на входе, сэмплинг temperature 1.0, top_p 0.95. Живые пробы
(2026-10-23):

| запрос | результат |
|---|---|
| plain | 200, `reasoning_content` присутствует — мышление **включено по умолчанию** |
| `chat_template_kwargs.thinking_mode: "off"` / `"bogus"` | 200 без изменений — kwarg m3 **молча игнорируется** |
| `reasoning_effort: "bogus-level"` | **400** — валидируется |
| `reasoning_effort: "off"` | **400** — как у kimi-k3 (07, §2) |
| `reasoning_effort: "low"` / `"high"` | 200; объём reasoning растёт с уровнем |
| `reasoning_effort: "none"` | 200 — принят; полное ли отключение — не доказано (пробы шли вперемешку с 429) |
| 400-оракул `max_tokens` | отдельного потолка нет: ограничение — `context_length` 262 144 (prompt+output) |

Итог: карточка в `overrides/models.json` (`models`) — нативный путь, как у
kimi-k3: `supportsReasoningEffort: true`, identity-карта `off`→`none`.
`thinking_mode` семейства m3 на m3.1 не работает — ветка `MINIMAX_M3` в
`transform.ts` остаётся точной на id (`minimaxai/minimax-m3`), m3.1-flash в неё
не входит.

## §4. google/gemma-4-31b-it — живой роут, но непригоден

Карточка build.nvidia.com: dense 31B, reasoning, 262K контекст,
text+image+video. Пробы 2026-10-23: keyless-роут жив (401), но авторизованные
запросы **висят до headers-timeout** (30–120 с) на всех выходах пула и
напрямую — и plain, и с `chat_template_kwargs.enable_thinking=false`, и с
`max_tokens=16`. Это хуже случая исследования 10/тикета 19: там
`enable_thinking=false` спасала. Модель не добавлена в каталог — карточки нет,
добавлять не на что; ревизовать при следующем обновлении каталога.

## §5. Прочее

- `nvidia/nemotron-3-super-120b-a12b` по-прежнему жив (keyless 401), хотя pi
  1.4.0 вычел его из встроенного каталога — оверрайд остаётся.
- Остальные новые чат-id живого каталога (legacy google/meta/ibm/nvidia-модели,
  `zyphra/zamba2-7b-instruct`, `meta/muse-glimmer-30b` и т.п.) не несут
  thinking-поверхности, требующей кураторства; их добавляет `/nvidia-plus
  discover` голыми карточками по запросу пользователя.
- Пробы шли через пул выходов; два из первых ключей пула отвечали 401/403 —
  ротация сработала штатно.

