#!/usr/bin/env node
/**
 * Standalone model discovery script for pi-nvidia-plus.
 * Fetches live models from NVIDIA API and classifies them against the known catalog.
 * Uses the same logic as the `/nvidia-plus discover` command.
 * 
 * Usage:
 *   node scripts/discover-models.mjs
 * 
 * Environment variables:
 *   NVIDIA_API_KEY - API key for authentication (optional, but recommended)
 *   NVIDIA_NIM_PROXY - Proxy URL (e.g., http://192.168.88.248:8870)
 *   NVIDIA_NIM_PROXIES - Comma-separated list of proxy URLs
 *   NVIDIA_NIM_PROXIES_FILE - Path to proxy pool file
 */

import { fetch, ProxyAgent } from "undici";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NVIDIA_ORIGIN = "https://integrate.api.nvidia.com";

// ─── Copied/ported from extensions/discovery.ts ────────────────────────────

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseModelsResponse(payload) {
  let items;
  if (Array.isArray(payload)) {
    items = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) items = payload.data;
    else if (Array.isArray(payload.models)) items = payload.models;
  }
  if (!Array.isArray(items)) return [];

  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (typeof id !== "string" || id.trim().length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      ownedBy: typeof item.owned_by === "string" ? item.owned_by : undefined,
    });
  }
  return out;
}

const NON_CHAT_PATTERNS = [
  /embed/i,
  /rerank/i,
  /\breward\b/i,
  /guard/i,
  /content-safety/i,
  /topic-control/i,
  /translate/i,
  /\bparse(r)?\b/i,
  /detector/i,
  /calibration/i,
  /\bdeplot\b/i,
  /\bocr\b/i,
  /clip/i,
  /\b(tts|asr|whisper|speech)\b/i,
  /(stable-?diffusion|sdxl|\bflux\b|dall-?e|imagen|image-?gen)/i,
];

function isChatModel(id) {
  return !NON_CHAT_PATTERNS.some((pattern) => pattern.test(id));
}

// ─── Dead models list from pi-nvidia-plus.ts ───────────────────────────────

const DEAD_MODELS = {
  "meta/llama-3.1-70b-instruct": "410 EOL",
  "meta/llama-3.1-8b-instruct": "410 EOL",
  "meta/llama-3.3-70b-instruct": "410 EOL",
  "nvidia/llama-3.1-nemotron-nano-8b-v1": "410 EOL",
  "nvidia/llama-3.1-nemotron-nano-vl-8b-v1": "410 EOL",
  "nvidia/llama-3.3-nemotron-super-49b-v1": "410 EOL",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": "410 EOL",
  "nvidia/nemotron-nano-12b-v2-vl": "410 EOL",
  "nvidia/nvidia-nemotron-nano-9b-v2": "410 EOL",
  "thinkingmachines/inkling": "410 EOL",
  "deepseek-ai/deepseek-v4-flash-0731": "EOL announced: deprecated 2026-09-19, unsupported after 2026-09-21 per build.nvidia.com; chat probes hang (2026-09-18)",
  "deepseek-ai/deepseek-v4-pro-0813": "410 EOL (probe 2026-09-18)",
  "minimaxai/minimax-m3": "410 EOL (probe 2026-09-18)",
  "meta/muse-glimmer-30b": "404 on probe 2026-09-18 (was alive)",
  "google/gemma-3-4b-it": "404 in all probes",
  "google/gemma-3-12b-it": "404 in all probes",
  "mistralai/mistral-7b-instruct-v0.3": "404 in all probes",
  "moonshotai/kimi-k2.6": "404 in all probes",
  "nvidia/cosmos-reason2-8b": "404 in all probes",
  "nvidia/llama-3.1-nemotron-70b-instruct": "404 in all probes (re-check ticket 08)",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1": "404 in all probes",
  "nvidia/nemotron-3-nano-30b-a3b": "410 EOL (probe 2026-09-18)",
  "openai/gpt-oss-120b": "410 EOL (probe 2026-09-18)",
  "stepfun-ai/step-3.7-flash": "410 EOL (probe 2026-09-18)",
  "01-ai/yi-large": "404 in all probes (audit 02)",
  "ai21labs/jamba-1.5-large-instruct": "404 in all probes (audit 02)",
  "databricks/dbrx-instruct": "404 in all probes (audit 02)",
  "deepseek-ai/deepseek-v4-flash": "410 EOL (audit 02)",
  "deepseek-ai/deepseek-v4-pro": "410 EOL (audit 02)",
  "microsoft/phi-3-vision-128k-instruct": "404 in all probes (audit 02)",
  "microsoft/phi-3.5-moe-instruct": "404 in all probes (audit 02)",
  "mistralai/codestral-22b-instruct-v0.1": "404 in all probes (audit 02)",
  "mistralai/mistral-large": "404 in all probes (audit 02)",
  "mistralai/mistral-large-2-instruct": "404 in all probes (audit 02)",
  "mistralai/mixtral-8x22b-v0.1": "404 in all probes (audit 02)",
  "nvidia/llama-3.1-nemotron-51b-instruct": "404 in all probes (audit 02)",
  "nvidia/nemotron-4-340b-instruct": "404 in all probes (audit 02)",
  "nvidia/nemotron-mini-4b-instruct": "410 EOL (audit 02)",
  "nvidia/nemotron-nano-3-30b-a3b": "404 in all probes (audit 02)",
  "nvidia/vila": "404 in all probes (audit 02)",
  "writer/palmyra-creative-122b": "404 in all probes (audit 02)",
};

// ─── Proxy handling ────────────────────────────────────────────────────────

function parseProxyEndpoint(raw) {
  const value = raw?.trim();
  if (!value) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol === "socks5h:") url.protocol = "socks5:";
  if (!["http:", "https:", "socks5:", "socks:"].includes(url.protocol)) {
    return null;
  }
  if (!url.hostname) return null;
  return url;
}

function createProxyDispatcher(proxyUrl) {
  let url = proxyUrl;
  if (url.startsWith("socks5h://")) {
    url = "socks5://" + url.slice(10);
  }
  return new ProxyAgent(url);
}

function getProxyDispatcher() {
  // Check proxy pool first (NVIDIA_NIM_PROXIES)
  const proxiesEnv = process.env.NVIDIA_NIM_PROXIES;
  if (proxiesEnv) {
    const list = proxiesEnv.split(",").map(s => s.trim()).filter(Boolean);
    if (list.length > 0) {
      const proxy = parseProxyEndpoint(list[0]);
      if (proxy) return createProxyDispatcher(proxy.toString());
    }
  }
  
  // Check proxy pool file
  const proxiesFile = process.env.NVIDIA_NIM_PROXIES_FILE;
  if (proxiesFile && existsSync(proxiesFile)) {
    try {
      const content = readFileSync(proxiesFile, "utf8");
      const parsed = JSON.parse(content);
      if (parsed.proxies && parsed.proxies.length > 0) {
        const proxy = parseProxyEndpoint(parsed.proxies[0]);
        if (proxy) return createProxyDispatcher(proxy.toString());
      }
    } catch {}
  }
  
  // Check default proxy pool file
  const defaultPath = join(homedir(), ".pi", "agent", "nvidia-proxies.json");
  if (existsSync(defaultPath)) {
    try {
      const content = readFileSync(defaultPath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed.proxies && parsed.proxies.length > 0) {
        const proxy = parseProxyEndpoint(parsed.proxies[0]);
        if (proxy) return createProxyDispatcher(proxy.toString());
      }
    } catch {}
  }
  
  // Legacy single proxy
  const legacyProxy = process.env.NVIDIA_NIM_PROXY;
  if (legacyProxy) {
    const proxy = parseProxyEndpoint(legacyProxy);
    if (proxy) return createProxyDispatcher(proxy.toString());
  }
  
  return null;
}

// ─── Model catalog loading ─────────────────────────────────────────────────

function loadKnownModels() {
  const modelsPath = join(homedir(), ".pi", "agent", "models.json");
  if (!existsSync(modelsPath)) {
    console.warn("⚠️  models.json not found at", modelsPath);
    return { baseIds: [], deadIds: Object.keys(DEAD_MODELS) };
  }
  
  try {
    const content = readFileSync(modelsPath, "utf8");
    const parsed = JSON.parse(content);
    const nvidiaModels = parsed.providers?.nvidia?.models || [];
    const baseIds = nvidiaModels.map(m => m.id);
    return { baseIds, deadIds: Object.keys(DEAD_MODELS) };
  } catch (e) {
    console.error("❌ Failed to parse models.json:", e.message);
    return { baseIds: [], deadIds: Object.keys(DEAD_MODELS) };
  }
}

// ─── Discovery logic ───────────────────────────────────────────────────────

async function discoverModels() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  pi-nvidia-plus Model Discovery                                  ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  // Load known models
  const { baseIds, deadIds } = loadKnownModels();
  console.log(`📚 Known models (from models.json): ${baseIds.length}`);
  console.log(`💀 Known dead models: ${deadIds.length}\n`);

  // Setup proxy
  const dispatcher = getProxyDispatcher();
  if (dispatcher) {
    console.log("🌐 Using proxy for discovery");
  } else {
    console.log("🌐 No proxy configured (direct connection)");
  }

  // Fetch live models
  console.log("\n📡 Fetching models from NVIDIA API...");
  const headers = {};
  const apiKey = process.env.NVIDIA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    console.log(`🔑 Using API key: …${apiKey.slice(-4)}`);
  } else {
    console.log("🔑 No API key (unauthenticated request)");
  }

  let liveModels;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    const res = await fetch(`${NVIDIA_ORIGIN}/v1/models`, {
      headers,
      dispatcher,
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (!res.ok) {
      console.error(`❌ HTTP ${res.status}: ${res.statusText}`);
      const text = await res.text();
      console.error(text.slice(0, 500));
      process.exit(1);
    }
    
    const json = await res.json();
    liveModels = parseModelsResponse(json);
    console.log(`✅ Received ${liveModels.length} models from API`);
  } catch (e) {
    console.error(`❌ Failed to fetch models: ${e.message}`);
    process.exit(1);
  }

  // Classify
  console.log("\n🔍 Classifying models...\n");
  
  const baseSet = new Set(baseIds);
  const deadSet = new Set(deadIds);
  
  const chat = [];
  const nonChat = [];
  const newChat = [];
  const liveIds = new Set();
  
  for (const model of liveModels) {
    liveIds.add(model.id);
    if (!isChatModel(model.id)) {
      nonChat.push(model.id);
      continue;
    }
    chat.push(model.id);
    if (!baseSet.has(model.id) && !deadSet.has(model.id)) {
      newChat.push(model.id);
    }
  }
  
  const missingKnown = [];
  for (const id of baseIds) {
    if (!liveIds.has(id) && !deadSet.has(id)) {
      missingKnown.push(id);
    }
  }

  // Print results
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("📊 DISCOVERY SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════════\n");
  
  console.log(`Total models from API:     ${liveModels.length}`);
  console.log(`Chat models:               ${chat.length}`);
  console.log(`Non-chat models (filtered): ${nonChat.length}`);
  console.log(`New chat models (not in catalog): ${newChat.length}`);
  console.log(`Missing known models:      ${missingKnown.length}\n`);

  if (newChat.length > 0) {
    console.log("✨ NEW CHAT MODELS (not in catalog):");
    for (const id of newChat.sort()) {
      const owned = liveModels.find(m => m.id === id)?.ownedBy;
      console.log(`   ${id}${owned ? ` (by ${owned})` : ""}`);
    }
    console.log("");
  }

  if (missingKnown.length > 0) {
    console.log("⚠️  MISSING KNOWN MODELS (in catalog but not in live API):");
    for (const id of missingKnown.sort()) {
      const deadReason = DEAD_MODELS[id];
      console.log(`   ${id}${deadReason ? ` — ${deadReason}` : ""}`);
    }
    console.log("");
  }

  if (nonChat.length > 0) {
    console.log("📦 NON-CHAT MODELS (filtered out):");
    for (const id of nonChat.sort()) {
      console.log(`   ${id}`);
    }
    console.log("");
  }

  // All chat models
  console.log("📋 ALL CHAT MODELS (live):");
  for (const id of chat.sort()) {
    const isNew = newChat.includes(id);
    const isDead = deadSet.has(id);
    const mark = isNew ? " ✨" : isDead ? " 💀" : "";
    console.log(`   ${id}${mark}`);
  }

  return {
    live: liveModels.length,
    chat,
    nonChat,
    newChat,
    missingKnown,
  };
}

discoverModels().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});