// Тесты шва живого обнаружения: разбор /v1/models, фильтр не-чат моделей,
// классификация против известного каталога. Фикстуры — реальные данные NIM.
import assert from "node:assert";
import {
  parseModelsResponse,
  isChatModel,
  classifyDiscovery,
  type LiveModel,
} from "../extensions/discovery.ts";

// 1. parseModelsResponse: OpenAI-форма {data: [...]}, массив, мусор, дубликаты.
{
  const openaiShape = {
    object: "list",
    data: [
      { id: "meta/llama-3.2-11b-vision-instruct", object: "model", owned_by: "meta" },
      { id: "nvidia/embed-qa-4", owned_by: "nvidia" },
    ],
  };
  assert.deepEqual(parseModelsResponse(openaiShape), [
    { id: "meta/llama-3.2-11b-vision-instruct", ownedBy: "meta" },
    { id: "nvidia/embed-qa-4", ownedBy: "nvidia" },
  ]);

  // Голый массив и форма {models: [...]}
  assert.deepEqual(parseModelsResponse([{ id: "a/b" }]), [{ id: "a/b", ownedBy: undefined }]);
  assert.deepEqual(parseModelsResponse({ models: [{ id: "a/b" }] }), [{ id: "a/b", ownedBy: undefined }]);

  // Мусор → пустой список, без исключений
  assert.deepEqual(parseModelsResponse(null), []);
  assert.deepEqual(parseModelsResponse("не объект"), []);
  assert.deepEqual(parseModelsResponse({}), []);
  assert.deepEqual(parseModelsResponse({ data: 42 }), []);

  // Записи без id пропускаются; дубликаты схлопываются
  const messy = { data: [{ id: "a/b" }, { object: "model" }, { id: "a/b" }, { id: "" }] };
  assert.deepEqual(parseModelsResponse(messy), [{ id: "a/b", ownedBy: undefined }]);
}

// 2. isChatModel: реальные не-чат модели NIM отсеиваются, чат — остаются.
{
  const nonChat = [
    // эмбеддинги
    "nvidia/embed-qa-4",
    "nvidia/nemotron-3-embed-1b",
    "nvidia/nv-embedqa-mistral-7b-v2",
    "nvidia/llama-3.2-nv-embedqa-1b-v1",
    "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1",
    "nvidia/llama-nemotron-embed-vl-1b-v2",
    "snowflake/arctic-embed-l",
    // reward
    "nvidia/nemotron-4-340b-reward",
    // guard / безопасность
    "meta/llama-guard-4-12b",
    "nvidia/llama-3.1-nemoguard-8b-content-safety",
    "nvidia/llama-3.1-nemoguard-8b-topic-control",
    "nvidia/llama-3.1-nemotron-safety-guard-8b-v3",
    "nvidia/nemotron-3.5-content-safety",
    // перевод
    "nvidia/riva-translate-4b-instruct",
    "nvidia/riva-translate-4b-instruct-v1.1",
    "nvidia/riva-translate-4b-instruct-v2",
    // утилитарные
    "nvidia/nemotron-parse",
    "nvidia/ai-synthetic-video-detector",
    "nvidia/ising-calibration-1.5-31b",
    "google/deplot",
    "nvidia/nvclip",
  ];
  for (const id of nonChat) assert.equal(isChatModel(id), false, `должен быть отсеян: ${id}`);

  const chat = [
    "meta/llama-3.2-11b-vision-instruct",
    "minimaxai/minimax-m3",
    "moonshotai/kimi-k3",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "openai/gpt-oss-120b",
    "stepfun-ai/step-3.7-flash",
    "google/gemma-4-31b-it",
    "writer/palmyra-med-70b-32k",
    "microsoft/kosmos-2",
    "nvidia/vila",
    "adept/fuyu-8b",
    "poolside/laguna-xs-2.1",
  ];
  for (const id of chat) assert.equal(isChatModel(id), true, `должен остаться: ${id}`);
}

// 3. classifyDiscovery: новые чат-модели и пропавшие известные.
{
  const live: LiveModel[] = [
    { id: "minimaxai/minimax-m3" },        // известен (база) — не новый
    { id: "google/gemma-4-31b-it" },       // живой чат, не в базе → новый
    { id: "nvidia/embed-qa-4" },           // не-чат → отсеян
    { id: "deepseek-ai/deepseek-v4-pro-0813" }, // новый чат
  ];
  const summary = classifyDiscovery(live, {
    baseIds: ["minimaxai/minimax-m3", "nvidia/nemotron-nano-9b-v2"],
    deadIds: ["deepseek-ai/deepseek-v4-flash-0731"],
  });
  assert.equal(summary.live, 4);
  assert.deepEqual([...summary.chat].sort(), ["deepseek-ai/deepseek-v4-pro-0813", "google/gemma-4-31b-it", "minimaxai/minimax-m3"]);
  assert.deepEqual(summary.nonChat, ["nvidia/embed-qa-4"]);
  assert.deepEqual([...summary.newChat].sort(), ["deepseek-ai/deepseek-v4-pro-0813", "google/gemma-4-31b-it"]);
  // nemotron-nano-9b-v2 в базе, но не в живых и не в известных мёртвых… он в deadIds? нет → подозреваемый
  assert.deepEqual(summary.missingKnown, ["nvidia/nemotron-nano-9b-v2"]);
}

// 3a. Известно-мёртвые не попадают в подозреваемые; мёртвые в живых не помечаются новыми.
{
  const live: LiveModel[] = [{ id: "deepseek-ai/deepseek-v4-flash-0731" }]; // жив по /v1/models, но помечен мёртвым
  const summary = classifyDiscovery(live, {
    baseIds: ["deepseek-ai/deepseek-v4-flash-0731"],
    deadIds: ["deepseek-ai/deepseek-v4-flash-0731"],
  });
  assert.deepEqual(summary.newChat, []);
  assert.deepEqual(summary.missingKnown, []);
}

console.log("discovery: все проверки прошли");
