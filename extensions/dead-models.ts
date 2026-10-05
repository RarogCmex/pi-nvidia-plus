/**
 * Мёртвые модели встроенного каталога — модуль данных (аудит 02, добор
 * 2026-09-18, keyless-пробы 2026-10-05 — исследование 06, §1).
 *
 * Вынесен из входной точки, чтобы `scripts/discover-models.mjs` импортировал
 * таблицу напрямую (type-stripping, Node ≥ 22.19), а не держал копию.
 *
 * 410 EOL — надёжный признак; дата после «410 EOL» — точная дата снятия с
 * публикации из keyless-ответа `application/problem+json` («has reached its
 * end of life on <дата>T…Z»), проба 2026-10-05 без ключа и без квоты.
 * «404 in every probe» — по авторизованным пробам (404 бывает транзитным),
 * поэтому дата в скобках обязательна. Keyless-проба эти записи подтвердить
 * НЕ может: все они отвечают 401 — HTTP-роут жив, смерть произошла на слое
 * вызова функции NVCF (исследование 06, §6.2).
 *
 * ЗНАЧЕНИЯ ВИДНЫ ПОЛЬЗОВАТЕЛЮ: они подставляются в `{reason}` уведомлений
 * (i18n.ts: deadOnSelect, deadObservedMarked, respDeadNote). Никаких внутренних
 * идентификаторов — номеров рабочих элементов, «audit NN», «ticket NN», «лог
 * XXXXXXXX» — и никаких дневниковых подробностей. test/dead-models.test.ts
 * это проверяет.
 */
export const DEAD_MODELS: Record<string, string> = {
  "meta/llama-3.1-70b-instruct": "410 EOL 2026-08-26",
  "meta/llama-3.1-8b-instruct": "410 EOL 2026-08-26",
  "meta/llama-3.3-70b-instruct": "410 EOL 2026-08-26",
  "nvidia/llama-3.1-nemotron-nano-8b-v1": "410 EOL 2026-08-26",
  "nvidia/llama-3.1-nemotron-nano-vl-8b-v1": "410 EOL 2026-08-26",
  "nvidia/llama-3.3-nemotron-super-49b-v1": "410 EOL 2026-08-26",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": "410 EOL 2026-08-26",
  "nvidia/nemotron-nano-12b-v2-vl": "410 EOL 2026-08-26",
  "nvidia/nvidia-nemotron-nano-9b-v2": "410 EOL 2026-08-26",
  "thinkingmachines/inkling": "410 EOL 2026-08-25",
  "deepseek-ai/deepseek-v4-flash-0731": "end of life after 2026-09-21, announced by NVIDIA (chat probes hung on 2026-09-18)",
  "deepseek-ai/deepseek-v4-pro-0813": "410 EOL 2026-09-14",
  "minimaxai/minimax-m3": "410 EOL 2026-09-09",
  "meta/muse-glimmer-30b": "404 on probe 2026-09-18 (answered before that)",
  // nvidia/nemotron-3.5-lightning-30b-a3b воскресла: 200 на пробах 2026-09-18 — убрана из мёртвых
  "google/gemma-3-4b-it": "404 in every probe",
  "google/gemma-3-12b-it": "404 in every probe",
  "mistralai/mistral-7b-instruct-v0.3": "404 in every probe",
  "moonshotai/kimi-k2.6": "404 in every probe",
  "nvidia/cosmos-reason2-8b": "404 in every probe",
  "nvidia/llama-3.1-nemotron-70b-instruct": "404 in every probe",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1": "404 in every probe",
  // Вне базы пи (аудит 02; нужно для живого обнаружения — не добавлять мёртвых)
  // Пробы 2026-09-18: наши бывшие оверрайды, померли
  "nvidia/nemotron-3-nano-30b-a3b": "410 EOL 2026-09-01",
  "openai/gpt-oss-120b": "410 EOL 2026-09-03",
  "stepfun-ai/step-3.7-flash": "410 EOL 2026-08-28",
  "01-ai/yi-large": "404 in every probe (catalog audit 2026-08-26)",
  "ai21labs/jamba-1.5-large-instruct": "404 in every probe (catalog audit 2026-08-26)",
  "databricks/dbrx-instruct": "404 in every probe (catalog audit 2026-08-26)",
  "deepseek-ai/deepseek-v4-flash": "410 EOL 2026-08-07",
  "deepseek-ai/deepseek-v4-pro": "410 EOL 2026-08-07",
  "microsoft/phi-3-vision-128k-instruct": "404 in every probe (catalog audit 2026-08-26)",
  "microsoft/phi-3.5-moe-instruct": "404 in every probe (catalog audit 2026-08-26)",
  "mistralai/codestral-22b-instruct-v0.1": "404 in every probe (catalog audit 2026-08-26)",
  "mistralai/mistral-large": "404 in every probe (catalog audit 2026-08-26)",
  "mistralai/mistral-large-2-instruct": "404 in every probe (catalog audit 2026-08-26)",
  "mistralai/mixtral-8x22b-v0.1": "404 in every probe (catalog audit 2026-08-26)",
  "nvidia/llama-3.1-nemotron-51b-instruct": "404 in every probe (catalog audit 2026-08-26)",
  "nvidia/nemotron-4-340b-instruct": "404 in every probe (catalog audit 2026-08-26)",
  "nvidia/nemotron-mini-4b-instruct": "410 EOL 2026-08-26",
  "nvidia/nemotron-nano-3-30b-a3b": "404 in every probe (catalog audit 2026-08-26)",
  "nvidia/vila": "404 in every probe (catalog audit 2026-08-26)",
  "writer/palmyra-creative-122b": "404 in every probe (catalog audit 2026-08-26)",
};
