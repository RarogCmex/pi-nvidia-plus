#!/usr/bin/env node
/**
 * Живые пробы для research/11 (пункты §1 и §2; §6 — план, свидетельств пока
 * нет): сверка официальных sampling-рекомендаций и поиск потолка `max_tokens`
 * через 400-оракул шлюза NIM.
 *
 * Экономика: каждый запрос — тривиальный промпт + маленький бюджет генерации;
 * на модель — несколько вызовов. Ключ НЕ печатается (только маска).
 *
 * Использование:
 *   node scripts/probe-catalog-fields.mjs [--keys FILE] [--only sampling|maxtokens|thinking]
 *   [--models id1,id2] [--proxy-tries N]
 * Дефолт файла ключей: ~/.pi/agent/nvidia-keys.json (или $PI_CODING_AGENT_DIR).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { maskKey, parseKeysFileContent, interpolateEnvValue } from "../extensions/keys.ts";
import { parseProxiesFileContent, parseProxyEndpoint, maskProxy } from "../extensions/proxy-pool.ts";

const require = createRequire(import.meta.url);
const undici = require("undici"); // undici линкуется link-pi.mjs из установки pi (ProxyAgent, Socks5ProxyAgent)

const URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const argv = process.argv.slice(2);
const opt = (n, f) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : f; };
const ONLY = opt("--only", undefined);
const ONLY_MODELS = opt("--models", "").split(",").filter(Boolean);
const WANT = (id) => ONLY_MODELS.length === 0 || ONLY_MODELS.includes(id);
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const keysFile = opt("--keys", join(agentDir, "nvidia-keys.json"));
const proxiesFile = join(agentDir, "nvidia-proxies.json");
// Повисший маршрут «модель × выход» (исследование 10): повтор через
// несколько выходов пула, до --proxy-tries штук.
const PROXY_TRIES = Number(opt("--proxy-tries", "3"));
const proxies = (() => {
  try { return parseProxiesFileContent(readFileSync(proxiesFile, "utf8")).proxies ?? []; }
  catch { return []; }
})();
let proxyCursor = Math.floor(Math.random() * Math.max(proxies.length, 1));

function dispatcherFor(rawEntry) {
  const parsed = parseProxyEndpoint(rawEntry);
  if (!parsed.href) return undefined;
  const mask = parsed.display;
  let agent;
  try { agent = new undici.ProxyAgent(parsed.href); } catch { return undefined; }
  return { agent, mask };
}

const parsed = parseKeysFileContent(readFileSync(keysFile, "utf8"));
const allKeys = (parsed.keys ?? [])
  .map((raw) => (raw.startsWith("nvapi-") ? raw : interpolateEnvValue(raw, process.env)))
  .filter(Boolean);
if (allKeys.length === 0) { console.error("✗ ни одного резолвящегося ключа в", keysFile); process.exit(1); }
let keyIndex = 0;
let key = allKeys[keyIndex];
console.log(`Ключ: ${maskKey(key)} (пул: ${allKeys.length})`);

async function rawChat(body, timeoutMs = 120_000) {
  const started = Date.now();
  const res = await undici.request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    headersTimeout: 20_000,
    bodyTimeout: timeoutMs,
  });
  const text = await res.body.text();
  let usage; let finish; let preview;
  try {
    const j = JSON.parse(text);
    usage = j.usage && `${j.usage.completion_tokens}/${j.usage.total_tokens}`;
    finish = j.choices?.[0]?.finish_reason;
    preview = (j.choices?.[0]?.message?.reasoning_content ?? "") + "|" +
      (j.choices?.[0]?.message?.content ?? "");
    preview = preview.slice(0, 80).replace(/\s+/g, " ") || undefined;
    if (j.error) preview = `ERR: ${JSON.stringify(j.error).slice(0, 220)}`;
  } catch { preview = text.slice(0, 220).replace(/\s+/g, " "); }
  return { status: res.statusCode, ms: Date.now() - started, finish, usage, preview };
}

// Ротация: 401/403 = мёртв (исследование 09) — берём следующий ключ пула.
// 404/410 раньше auth (проба модели) — статус пробуемой функции важнее ключа.
async function chat(body, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    const r = await rawChat(body, timeoutMs);
    if (r.status !== 401 && r.status !== 403) return r;
    keyIndex = (keyIndex + 1) % allKeys.length;
    if (keyIndex === 0) { console.error(`✗ все ${allKeys.length} ключей ответили 401/403`); process.exit(2); }
    key = allKeys[keyIndex];
  }
  throw new Error("key rotation timeout");
}

// То же, но без разбора тела: для стриминговых проб (статус/заголовки важны,
// тело обрывает вызывающий). dispatcher — прокси-выход (иначе direct), signal
// отсекает зависшие маршруты.
async function keyrotatingRequest(body, options = {}) {
  const { dispatcher, timeoutMs = 25_000 } = options;
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    const res = await undici.request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.statusCode !== 401 && res.statusCode !== 403) return res;
    await res.body.text();
    keyIndex = (keyIndex + 1) % allKeys.length;
    if (keyIndex === 0) { console.error(`✗ все ${allKeys.length} ключей ответили 401/403`); process.exit(2); }
    key = allKeys[keyIndex];
  }
  throw new Error("key rotation timeout");
}

const PROMPT = [{ role: "user", content: "Reply with exactly the word OK." }];

// ── §1: sampling-рекомендации (подтверждение, что шлюз принимает заявленные
// в карточках параметры, включая top_k в non-thinking режиме) ───────────────
const samplingProbes = [
  { model: "nvidia/nemotron-3-super-120b-a12b", body: { temperature: 1.0, top_p: 0.95, max_tokens: 512 } },
  { model: "nvidia/nemotron-3.5-lightning-30b-a3b", body: { temperature: 1.0, top_p: 0.95, max_tokens: 512 } },
  { model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", body: { temperature: 0.6, top_p: 0.95, max_tokens: 512 } },
  {
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    body: { temperature: 0.2, top_k: 1, max_tokens: 128, chat_template_kwargs: { enable_thinking: false } },
  },
  // Карточки новых моделей (2026-10-17): super-vl — текст 1.0/0.95;
  // step-5-preview — 1.0/0.95 + top_k=0 (рекомендация билдера StepFun).
  { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", body: { temperature: 1.0, top_p: 0.95, max_tokens: 512 } },
  { model: "stepfun-ai/step-5-preview", body: { temperature: 1.0, top_p: 0.95, top_k: 0, max_tokens: 512 } },
];

// ── §2: потолок max_tokens (текст 400-оракула) ─────────────────────────────
const maxTokensModels = [
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "deepseek-ai/deepseek-v4-flash-0731",
  "deepseek-ai/deepseek-v4.1-flash",
  "moonshotai/kimi-k3",
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "stepfun-ai/step-5-preview",
];

// ── §6: управление мышлением новых моделей (карточные механизмы) ───────────
// Номер — следующий свободный пункт research/11 (§3 там занят решением по
// `inputLimits`/vision): это план, прогон не сделан, свидетельств нет.
// super-vl: chat_template_kwargs.enable_thinking (True/False по карточке);
// средний уровень — medium_effort=True (HF-карточка: "off, on (medium), and on").
// step-5: reasoning_effort low/medium/high (всегда думает, off не предусмотрен);
// неизвестные значения — отдельные пробы, чтобы отличить 400 от тихого
// сброса на дефолт.
const thinkingProbes = [
  { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", body: { chat_template_kwargs: { enable_thinking: false }, max_tokens: 64 } },
  { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", body: { chat_template_kwargs: { enable_thinking: true }, max_tokens: 64 } },
  { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", body: { chat_template_kwargs: { enable_thinking: true, medium_effort: true }, max_tokens: 64 } },
  { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", body: { chat_template_kwargs: { enable_thinking: true, low_effort: true }, max_tokens: 64 } },
  { model: "stepfun-ai/step-5-preview", body: { reasoning_effort: "low", max_tokens: 64 } },
  { model: "stepfun-ai/step-5-preview", body: { reasoning_effort: "medium", max_tokens: 64 } },
  { model: "stepfun-ai/step-5-preview", body: { reasoning_effort: "high", max_tokens: 64 } },
  { model: "stepfun-ai/step-5-preview", body: { reasoning_effort: "none", max_tokens: 64 } },
  { model: "stepfun-ai/step-5-preview", body: { reasoning_effort: "minimal", max_tokens: 64 } },
];
// Потолок читаем из текста 400 («Max tokens must not exceed N»): одна
// заведомо-большая проба + подтверждение ровно N (2 запроса на модель).
const OVER_CAP = 20_000_000;
const CAP_RE = /exceed (\d+)/;

async function runSampling() {
  console.log("\n══ §1 sampling (приём сервером) ══");
  for (const p of samplingProbes) {
    if (!WANT(p.model)) continue;
    const r = await chat({ model: p.model, messages: PROMPT, stream: false, ...p.body });
    console.log(`${p.model}  ${JSON.stringify(p.body)}`);
    console.log(`  → ${r.status} ${r.ms}ms finish=${r.finish} usage=${r.usage ?? "-"}\n    ${r.preview ?? ""}`);
  }
}

// Одна проба max_tokens=n на разных выходах (из-за повисших маршрутов,
// исследование 10). Возвращает {status, via, err} или {hang: true}.
async function probeMaxTokens(model, n) {
  const attempts = [undefined];
  for (let i = 0; i < PROXY_TRIES && proxies.length > 0; i++) {
    attempts.push(proxies[proxyCursor++ % proxies.length]);
  }
  for (const rawProxy of attempts) {
    const d = rawProxy ? dispatcherFor(rawProxy) : undefined;
    if (rawProxy && !d) continue;
    const via = d ? d.mask : "direct";
    try {
      const t0 = Date.now();
      // stream:true: заголовки приходят сразу, потолок валидируется ДО
      // генерации; тело обрываем — токены не тратим.
      const res = await keyrotatingRequest(
        { model, messages: PROMPT, stream: true, max_tokens: n },
        { dispatcher: d && d.agent, timeoutMs: 25_000 },
      );
      const status = res.statusCode;
      const err = status === 200 ? undefined : (await res.body.text()).slice(0, 300).replace(/\s+/g, " ");
      if (status === 200) res.body.destroy();
      console.log(`${model} max_tokens=${n} [${via}] → ${status} ${Date.now() - t0}ms ${err ?? ""}`);
      return { status, via, err };
    } catch (e) {
      console.log(`${model} max_tokens=${n} [${via}] → HANG ${e.code ?? e.message}`);
    }
  }
  return { hang: true };
}

async function runMaxTokens() {
  console.log("\n══ §2 потолок max_tokens (400-оракул) ══");
  for (const model of maxTokensModels) {
    if (!WANT(model)) continue;
    const over = await probeMaxTokens(model, OVER_CAP);
    if (over.status === 400 && over.err) {
      const cap = CAP_RE.exec(over.err)?.[1];
      if (cap) {
        const exact = await probeMaxTokens(model, Number(cap));
        console.log(`  ⇒ ${model}: потолок = ${cap} (ровно принят: ${exact.status === 200 ? "да" : exact.status ?? "HANG"})`);
        continue;
      }
      console.log(`  ⇒ ${model}: 400 без лимита в тексте — ${over.err}`);
      continue;
    }
    if (over.status === 200) {
      console.log(`  ⇒ ${model}: потолок ≥ ${OVER_CAP} (без валидации max_tokens?)`);
      continue;
    }
    console.log(`  ⇒ ${model}: не удалось (hang или ${over.status})`);
  }
}

async function runThinking() {
  console.log("\n══ §6 управление мышлением (новые модели) ══");
  for (const p of thinkingProbes) {
    if (!WANT(p.model)) continue;
    const r = await chat({ model: p.model, messages: PROMPT, stream: false, ...p.body });
    const { max_tokens: _drop, ...shown } = p.body; // max_tokens — только бюджет, не предмет пробы
    console.log(`${p.model}  ${JSON.stringify(shown)}`);
    console.log(`  → ${r.status} ${r.ms}ms finish=${r.finish} usage=${r.usage ?? "-"}\n    ${r.preview ?? ""}`);
  }
}

if (ONLY !== "maxtokens" && ONLY !== "thinking") await runSampling();
if (ONLY !== "sampling" && ONLY !== "thinking") await runMaxTokens();
if (ONLY !== "maxtokens" && ONLY !== "sampling") await runThinking();
console.log("\nГотово. Свидетельства оформляются в research/11 — значения в overrides только из этого прогона + карточки NIM.");
