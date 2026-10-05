#!/usr/bin/env node
/**
 * Standalone model discovery script for pi-nvidia-plus.
 * Fetches live models from NVIDIA API and classifies them against the known catalog.
 * Uses the same logic as the `/nvidia-plus discover` command.
 *
 * Классификация и таблица мёртвых моделей ИМПОРТИРУЮТСЯ из `extensions/*.ts`
 * (Node ≥ 22.19 исполняет TypeScript напрямую, type-stripping без флага) —
 * прежние копии рассинхронизировались (исследование 06, §2: `starcoder` жил
 * в discovery.ts, но не здесь).
 *
 * Usage:
 *   node scripts/discover-models.mjs [--probe-routes] [--probe-eol] [--direct]
 *
 *   --direct        ignore proxy configuration and go to NIM directly
 *
 * Flags (both keyless — no `authorization` header, no key quota is spent;
 * NIM resolves the model before auth, see research/06-gateway-recon-keyless-oracles.md §1):
 *   --probe-routes  probe every live model with a keyless POST /v1/chat/completions
 *                   and report the chat-route ground truth:
 *                     404 (text/plain)          — no chat route at all
 *                     401                       — chat route exists
 *                     410 (application/problem+json) — EOL, exact date extracted
 *                   Flags heuristic false positives (models `isChatModel()` passes
 *                   but the oracle says have no chat route). ~150 ms pacing.
 *   --probe-eol     probe DEAD_MODELS ids keyless and print exact EOL dates,
 *                   plus any mismatch against the table (evidence for updating it).
 *
 * Environment variables:
 *   NVIDIA_API_KEY - API key for authentication (optional; only used for GET /v1/models)
 *   NVIDIA_NIM_PROXY - Proxy URL (e.g., http://127.0.0.1:8870)
 *   NVIDIA_NIM_PROXIES - Comma-separated list of proxy URLs
 *   NVIDIA_NIM_PROXIES_FILE - Path to proxy pool file
 */

import { fetch, ProxyAgent } from "undici";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseModelsResponse, isChatModel } from "../extensions/discovery.ts";
import { DEAD_MODELS } from "../extensions/dead-models.ts";

const NVIDIA_ORIGIN = "https://integrate.api.nvidia.com";
const PROBE_PACING_MS = 150;

// ─── Dead models list from extensions/dead-models.ts ───────────────────────
// Импорт выше; отдельной копии больше нет — таблица одна на расширение и скрипт.

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

// ─── Keyless oracle (research/06, §1) ──────────────────────────────────────
// NIM резолвит модель ДО проверки авторизации, поэтому POST /v1/chat/completions
// без заголовка `authorization` различает три исхода:
//   404 (text/plain `404 page not found`)     — chat-роута у модели нет вообще;
//   401                                        — chat-роут есть (живость не определяется);
//   410 (application/problem+json)             — модель снята с публикации, точная дата EOL.
// Ключ не нужен и квота не тратится. Границы оракула — исследование 06, §1:
// живость чат-модели он НЕ определяет, а 404 авторизованных проб (слой NVCF)
// не подтверждает: такие модели keyless-ом дают 401.

async function probeKeylessRoute(id, dispatcher) {
  try {
    const res = await fetch(`${NVIDIA_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" }, // намеренно без authorization
      body: JSON.stringify({ model: id, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      dispatcher,
      signal: AbortSignal.timeout(15000),
    });
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    if (res.status === 410 && ct.includes("application/problem+json")) {
      const m = body.match(/end of life on (\d{4}-\d{2}-\d{2})T/);
      return { outcome: "eol", status: 410, eolDate: m ? m[1] : undefined };
    }
    if (res.status === 404 && ct.includes("text/plain")) return { outcome: "no-route", status: 404 };
    if (res.status === 401) return { outcome: "route", status: 401 };
    return { outcome: "unknown", status: res.status };
  } catch (e) {
    return { outcome: "error", error: String(e?.message ?? e).slice(0, 120) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeRoutes(liveModels, dispatcher) {
  console.log(`\n🔑 Keyless route probe (${liveModels.length} models, ~${Math.round((liveModels.length * PROBE_PACING_MS) / 1000)}s pacing)...`);
  const results = new Map();
  for (const model of liveModels) {
    const r = await probeKeylessRoute(model.id, dispatcher);
    results.set(model.id, r);
    const mark = r.outcome === "no-route" ? "✗" : r.outcome === "eol" ? "💀" : r.outcome === "route" ? "✓" : "?";
    console.log(`   ${mark} ${model.id} — ${r.outcome}${r.eolDate ? ` (EOL ${r.eolDate})` : ""}${r.status ? ` [HTTP ${r.status}]` : ""}${r.error ? ` ${r.error}` : ""}`);
    await sleep(PROBE_PACING_MS);
  }
  // Сверка эвристики с ground truth (исследование 06, §2).
  const falsePositives = []; // эвристика пускает в чат, а роута нет
  const eol = [];            // ещё в каталоге, но уже 410
  for (const model of liveModels) {
    const r = results.get(model.id);
    if (r?.outcome === "no-route" && isChatModel(model.id)) falsePositives.push(model.id);
    if (r?.outcome === "eol") eol.push({ id: model.id, eolDate: r.eolDate });
  }
  console.log("\n📐 HEURISTIC vs ORACLE");
  if (falsePositives.length === 0) {
    console.log("   ✅ no false positives: every model isChatModel() passes has a chat route");
  } else {
    console.log("   ⚠️  FALSE POSITIVES (heuristic passes, oracle says no chat route):");
    for (const id of falsePositives) console.log(`      ${id} — add a narrow pattern to NON_CHAT_PATTERNS`);
  }
  if (eol.length > 0) {
    console.log("   💀 IN CATALOG BUT EOL (410):");
    for (const { id, eolDate } of eol) console.log(`      ${id} — EOL ${eolDate ?? "?"}`);
  }
  const noRoute = [...results.values()].filter((r) => r.outcome === "no-route").length;
  const route = [...results.values()].filter((r) => r.outcome === "route").length;
  console.log(`   totals: route=${route}, no-route=${noRoute}, eol=${eol.length}, other=${results.size - route - noRoute - eol.length}`);
  return results;
}

async function probeEol(dispatcher) {
  const ids = Object.keys(DEAD_MODELS);
  console.log(`\n💀 Keyless EOL probe of DEAD_MODELS (${ids.length} ids)...`);
  const mismatches = [];
  let dated = 0;
  for (const id of ids) {
    const r = await probeKeylessRoute(id, dispatcher);
    const reason = DEAD_MODELS[id];
    const reasonDate = /(\d{4}-\d{2}-\d{2})/.exec(reason)?.[1];
    if (r.outcome === "eol") {
      dated++;
      const ok = reasonDate === r.eolDate || (r.eolDate && reason.includes(r.eolDate));
      console.log(`   ${ok ? "✅" : "⚠️ "} ${id} — EOL ${r.eolDate ?? "?"} (table: ${reason})`);
      if (!ok) mismatches.push({ id, eolDate: r.eolDate, reason });
    } else {
      console.log(`   ➖ ${id} — ${r.outcome}${r.status ? ` [HTTP ${r.status}]` : ""} (table: ${reason})`);
    }
    await sleep(PROBE_PACING_MS);
  }
  console.log(`\n   410 with exact date: ${dated}/${ids.length}`);
  if (mismatches.length > 0) {
    console.log("   ⚠️  MISMATCHES — update extensions/dead-models.ts:");
    for (const m of mismatches) console.log(`      ${m.id}: oracle EOL ${m.eolDate}, table says «${m.reason}»`);
  }
  console.log("   note: 401 here means the HTTP route is alive — it does NOT contradict");
  console.log("   «404 in every probe» entries (that 404 is the NVCF function layer, research/06 §6.2).");
}

// ─── Discovery logic ───────────────────────────────────────────────────────

async function discoverModels() {
  const probeRoutesFlag = process.argv.includes("--probe-routes");
  const probeEolFlag = process.argv.includes("--probe-eol");

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  pi-nvidia-plus Model Discovery                                  ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  // Load known models
  const { baseIds, deadIds } = loadKnownModels();
  console.log(`📚 Known models (from models.json): ${baseIds.length}`);
  console.log(`💀 Known dead models: ${deadIds.length}\n`);

  // Setup proxy
  const directFlag = process.argv.includes("--direct");
  const dispatcher = directFlag ? undefined : getProxyDispatcher();
  if (directFlag) {
    console.log("🌐 --direct: ignoring proxy configuration");
  } else if (dispatcher) {
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

  // Keyless oracles (no key, no quota — research/06, §1)
  if (probeRoutesFlag) await probeRoutes(liveModels, dispatcher);
  if (probeEolFlag) await probeEol(dispatcher);

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
