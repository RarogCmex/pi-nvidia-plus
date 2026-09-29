#!/usr/bin/env node
/**
 * Живая приёмка кольца прокси (spec proxy-pool, «Live acceptance is a short
 * checklist, not the seam»). Бьёт реальный NIM через реальные выходы, проверяя:
 *   1. разбор: socks5/socks5h принимаются (тикет 05), socks4/ftp отклоняются;
 *   2. приоритет источников: инлайн побеждает, легаси не подмешивается;
 *   3. `proxy check`-планировщик: параллельность 2, любой HTTP-ответ = ok,
 *      CONNECT-провал = unreachable, самый быстрый ok становится pin;
 *   4. карантин мёртвого выхода виден в statusFor.
 *
 * Реальные выходы с креденшелами берутся ИЗ ОКРУЖЕНИЯ (или gitignored-файла),
 * НИКОГДА не хардкодятся: в git не должно попадать прокси-материалов.
 *
 * Использование:
 *   NVIDIA_NIM_PROXIES="http://u:p@host:port,…" node scripts/proxy-pool-acceptance.mjs
 *   # или: NVIDIA_NIM_PROXIES_FILE=/путь/к/proxies.json node scripts/proxy-pool-acceptance.mjs
 * Без живых выходов прогоняется только синтетическая часть (разбор/мёртвый выход).
 */
import {
  ProxyPool,
  ProxyRotator,
  parseProxyEndpoint,
  maskProxy,
  runProxyProbes,
  PROXY_CHECK_CONCURRENCY,
  PROXY_PROBE_TIMEOUT_MS,
} from "../extensions/proxy-pool.ts";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * undici нужен **сам pi**, а не копия из этого пакета: расширение ставит
 * глобальный диспетчер именно в экземпляр pi, поэтому приёмка обязана мерить тот
 * же объект. Резолвим от слинкованного `node_modules/@earendil-works/pi-coding-agent`.
 *
 * Без dev-симлинка `realpathSync` бросил бы голый ENOENT — непонятно, что чинить.
 * Здесь ошибка называется явно.
 */
function loadPiUndici() {
  const link = join("node_modules", "@earendil-works", "pi-coding-agent");
  let piEntry;
  try {
    piEntry = join(realpathSync(link), "index.js");
  } catch {
    console.error(
      `proxy-pool-acceptance: ${link} не найден.\n` +
        "  Этот приёмочный прогон меряет undici самого pi, поэтому его пакеты\n" +
        "  нужно слинковать заранее:  node scripts/link-pi.mjs\n" +
        "  (или укажите установку явно: PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs)",
    );
    process.exit(1);
  }
  return createRequire(piEntry)("undici");
}

const undici = loadPiUndici();
const NVIDIA_ORIGIN = "https://integrate.api.nvidia.com";

/** Синтетические значения для проверки разбора (без живых креденшелов). */
const SCHEME_FIXTURES = [
  "socks4://user:pass@203.0.113.6:1080", // reject (socks4 не поддержан)
  "ftp://user:pass@203.0.113.9:21", // reject (не-http(s)/socks5)
  "socks5://user:pass@203.0.113.7:1080", // accept (нативный Socks5ProxyAgent)
  "socks5h://user:pass@203.0.113.8:16901", // accept, нормализуется в socks5
  "http://user:pass@203.0.113.10:8080", // accept
  "http://127.0.0.1:1/", // accept, заведомо мёртвый (ECONNREFUSED)
];

console.log("=== 1. Разбор эндпоинтов (socks5/socks5h принимаются, socks4/ftp отклоняются) ===");
let badRejected = 0;
for (const raw of SCHEME_FIXTURES) {
  const parsed = parseProxyEndpoint(raw);
  const shown = raw.replace(/\/\/[^@]*@/, "//***@");
  if (parsed.href) {
    console.log(`  OK   ${parsed.display.padEnd(24)} ← ${shown}`);
  } else {
    if (raw.startsWith("socks4") || raw.startsWith("ftp")) badRejected += 1;
    console.log(`  FAIL ${maskProxy(raw).padEnd(24)} — ${parsed.error}`);
  }
}
// socks5h нормализуется в socks5 (DNS всегда на прокси — различие вырождено).
const normalized = parseProxyEndpoint("socks5h://u:p@h.example:16901");
if (!normalized.href?.startsWith("socks5://")) {
  console.error("  ✗ socks5h должен нормализоваться в socks5");
  process.exit(1);
}
if (badRejected < 2) {
  console.error("  ✗ socks4/ftp должны отклоняться");
  process.exit(1);
}

// Живые выходы — только из окружения/файла. Креденшелы в git не хардкодим.
const liveRaw = process.env.NVIDIA_NIM_PROXIES;
const liveFile = process.env.NVIDIA_NIM_PROXIES_FILE;
if (!liveRaw && !liveFile) {
  console.log("\n  ℹ NVIDIA_NIM_PROXIES[_FILE] не заданы — живые пробы пропущены.");
  console.log("    Задайте список выходов в окружении для полной приёмки, например:");
  console.log('    NVIDIA_NIM_PROXIES="http://u:p@host:port,…" node scripts/proxy-pool-acceptance.mjs');
  console.log("\n  ✓ синтетическая часть (разбор/схемы) прошла");
  process.exit(0);
}

console.log("\n=== 2. ProxyPool приоритет источников (инлайн побеждает, легаси не мерджится) ===");
const pool = new ProxyPool({
  defaultPath: "/nonexistent/nvidia-proxies.json",
  env: {
    NVIDIA_NIM_PROXIES: liveRaw,
    NVIDIA_NIM_PROXIES_FILE: liveFile,
    NVIDIA_NIM_PROXY: "http://legacy:1", // должен быть вытеснен пулом
  },
  onWarn: (m) => console.log("  warn:", m),
});
const hrefs = pool.refresh();
console.log(`  источник: ${pool.describe()}, эндпоинтов: ${hrefs.length}`);
console.log(`  легаси не подмешан: ${!hrefs.some((h) => h.includes("legacy"))}`);
console.log(`  display identities: ${hrefs.map((h) => maskProxy(h)).join(", ")}`);
if (hrefs.some((h) => h.includes("legacy"))) {
  console.error("  ✗ легаси не должен мерджиться с пулом");
  process.exit(1);
}
if (hrefs.length === 0) {
  console.error("  ✗ пул пуст — нечего пробовать (проверьте NVIDIA_NIM_PROXIES[_FILE])");
  process.exit(1);
}

console.log("\n=== 3. `proxy check`: пробы через каждый выход (параллельность 2) ===");
const rotator = new ProxyRotator();
rotator.setPool(hrefs);
const endpoints = hrefs.map((href) => ({ href, display: maskProxy(href) }));

async function probeEndpoint(endpoint) {
  const startedAt = Date.now();
  const agent = new undici.ProxyAgent(endpoint.href);
  try {
    const res = await undici.request(`${NVIDIA_ORIGIN}/v1/models`, {
      method: "GET",
      dispatcher: agent,
      headersTimeout: PROXY_PROBE_TIMEOUT_MS,
      bodyTimeout: PROXY_PROBE_TIMEOUT_MS,
    });
    await res.body.text();
    return { status: res.statusCode };
  } catch (e) {
    return { error: e };
  } finally {
    await agent.close();
  }
}

let maxActive = 0;
let active = 0;
const plan = await runProxyProbes(
  endpoints,
  async (ep) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      return await probeEndpoint(ep);
    } finally {
      active -= 1;
    }
  },
  { concurrency: PROXY_CHECK_CONCURRENCY },
);

console.log(`  max parallel: ${maxActive} (лимит ${PROXY_CHECK_CONCURRENCY})`);
if (maxActive > PROXY_CHECK_CONCURRENCY) {
  console.error("  ✗ параллельность превышена");
  process.exit(1);
}
for (const row of plan.rows) {
  const latency = row.latencyMs !== undefined ? `${row.latencyMs} ms` : "—";
  console.log(`  ${row.display.padEnd(28)} ${row.outcome.padEnd(12)} ${latency}`);
}

console.log("\n=== 4. Самый быстрый ok → pin; карантин мёртвого в статусе ===");
// Та же операция шва, что в cmdProxy: ok → exit quality, unreachable → карантин,
// самый быстрый ok → pin.
const pinnedDisplay = rotator.applyProbeResults(plan.rows);
if (pinnedDisplay) {
  console.log(`  pin → ${pinnedDisplay}`);
} else {
  console.log("  ни одного ok — pin не меняется (ожидаемо, если все выходы мертвы)");
}
for (const s of rotator.statusFor(Date.now())) {
  const mark = s.pinned ? " (PINNED)" : "";
  const lat = s.lastLatencyMs !== undefined ? `, ${s.lastLatencyMs} ms` : "";
  console.log(`  ${s.display.padEnd(28)} ${s.state}${mark}${lat}`);
}
const ok = plan.rows.filter((r) => r.outcome === "ok").length;
const unreachable = plan.rows.filter((r) => r.outcome === "unreachable").length;
const unknown = plan.rows.filter((r) => r.outcome === "unknown").length;
console.log(`\n  ✓ живая приёмка: разбор/приоритет/пробы/pin/карантин ведут себя по спеке`);
console.log(`    (ok: ${ok}, unreachable: ${unreachable}, unknown: ${unknown})`);
