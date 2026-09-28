#!/usr/bin/env node
/**
 * A/B тест прокси для pi-nvidia-plus
 * 
 * Проверяет гипотезу о том, что rate-limits зависят от IP-адреса.
 * Запускает тесты ключей через разные прокси и проверяет работу Kimi K3.
 * 
 * Использование:
 *   node scripts/test-proxies.mjs
 * 
 * Переменные окружения:
 *   NVIDIA_API_KEY - основной ключ (обязателен)
 *   NVIDIA_NIM_KEYS_FILE - путь к файлу с дополнительными ключами (опционально)
 *   TEST_MODEL - модель для тестирования (по умолчанию: moonshotai/kimi-k2.6)
 */

import { fetch, ProxyAgent } from "undici";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Список выходов для A/B. Живые креденшелы НИКОГДА не хардкодим: прокси
 * задаются в окружении (PROXY_AB_LIST — JSON-массив [{name,url,type,country,asn}])
 * или в gitignored-файле test-results/ab-proxies.json. Форма записи url —
 * как в NVIDIA_NIM_PROXIES (http(s) с userinfo; socks в результатах тикета 30
 * присутствовали исторически — этот скрипт их просто пробует через ProxyAgent).
 */
import { existsSync, readFileSync } from "node:fs";
function loadProxies() {
  const fromEnv = process.env.PROXY_AB_LIST;
  if (fromEnv) return JSON.parse(fromEnv);
  const file = new URL("../test-results/ab-proxies.json", import.meta.url).pathname;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  // Синтетический пример формы (не живые выходы).
  return [
    { name: "EXAMPLE-HTTP", url: "http://user:pass@203.0.113.10:8080", type: "residential", country: "US", asn: "AS0000" },
    { name: "EXAMPLE-DEAD", url: "http://127.0.0.1:1", type: "residential", country: "-", asn: "-" },
  ];
}
const PROXIES = loadProxies();

const NVIDIA_ORIGIN = "https://integrate.api.nvidia.com";
const TEST_MODEL = process.env.TEST_MODEL || "moonshotai/kimi-k3";
const TIMEOUT_MS = 30000;

async function testProxy(proxy, apiKey, testModel = TEST_MODEL) {
  const results = {
    proxy: proxy.name,
    type: proxy.type,
    country: proxy.country,
    asn: proxy.asn,
    url: proxy.url.replace(/\/\/[^:]+:[^@]+@/, "//***:***@"), // маскируем credentials
    tests: [],
  };

  // Тест 1: Проверка доступности прокси (health check)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${NVIDIA_ORIGIN}/v1/models`, {
      dispatcher: createProxyDispatcher(proxy.url),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    results.tests.push({
      name: "health_check",
      status: res.status,
      ok: res.ok,
    });
    console.log(`  ✓ Health check: ${res.status} ${res.statusText}`);
  } catch (e) {
    results.tests.push({
      name: "health_check",
      error: String(e).slice(0, 200),
      ok: false,
    });
    console.log(`  ✗ Health check failed: ${e.message?.slice(0, 100) || e}`);
    return results; // если health check не прошёл, дальше нет смысла
  }

  // Тест 2: Проверка ключа (auth check)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(`${NVIDIA_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      dispatcher: createProxyDispatcher(proxy.url),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 8,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    results.tests.push({
      name: "auth_check",
      status: res.status,
      ok: res.status === 200 || res.status === 202,
      response: text.slice(0, 100),
    });
    console.log(`  ✓ Auth check: ${res.status} ${res.statusText}`);
    if (res.status === 429) {
      console.log(`    ⚠ Rate limited! retry-after: ${res.headers.get("retry-after") || "none"}`);
    }
  } catch (e) {
    results.tests.push({
      name: "auth_check",
      error: String(e).slice(0, 200),
      ok: false,
    });
    console.log(`  ✗ Auth check failed: ${e.message?.slice(0, 100) || e}`);
  }

  // Тест 3: Несколько запросов подряд для проверки rate limits
  console.log(`  📊 Rate limit test (5 requests)...`);
  const rateLimitResults = [];
  for (let i = 0; i < 5; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const start = Date.now();
      const res = await fetch(`${NVIDIA_ORIGIN}/v1/chat/completions`, {
        method: "POST",
        dispatcher: createProxyDispatcher(proxy.url),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: "user", content: `Test ${i + 1}` }],
          max_tokens: 16,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const latency = Date.now() - start;
      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = res.headers.get("retry-after-ms");
      const requestId = res.headers.get("x-request-id") || res.headers.get("x-nvidia-request-id");
      
      rateLimitResults.push({
        attempt: i + 1,
        status: res.status,
        latency,
        retryAfter,
        retryAfterMs,
        requestId,
        ok: res.status === 200 || res.status === 202,
      });
      
      if (res.status === 429) {
        console.log(`    Attempt ${i + 1}: 429 Rate Limited (latency: ${latency}ms, retry-after: ${retryAfter || retryAfterMs || "none"})`);
      } else if (res.ok) {
        console.log(`    Attempt ${i + 1}: ${res.status} OK (${latency}ms)`);
      } else {
        console.log(`    Attempt ${i + 1}: ${res.status} ${res.statusText} (${latency}ms)`);
      }
      
      // Небольшая пауза между запросами
      if (i < 4) await sleep(1000);
    } catch (e) {
      rateLimitResults.push({
        attempt: i + 1,
        error: String(e).slice(0, 200),
        ok: false,
      });
      console.log(`    Attempt ${i + 1}: ERROR - ${e.message?.slice(0, 100) || e}`);
    }
  }
  results.tests.push({
    name: "rate_limit_test",
    attempts: rateLimitResults,
  });

  // Тест 4: Проверка Kimi K3 (если тестируем эту модель)
  if (testModel.includes("kimi")) {
    console.log(`  🤖 Kimi-specific test...`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(`${NVIDIA_ORIGIN}/v1/chat/completions`, {
        method: "POST",
        dispatcher: createProxyDispatcher(proxy.url),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: "user", content: "Say hello in Russian" }],
          max_tokens: 50,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      results.tests.push({
        name: "kimi_test",
        status: res.status,
        ok: res.ok,
        response: text.slice(0, 200),
      });
      console.log(`    Kimi test: ${res.status} ${res.ok ? "OK" : "FAILED"}`);
      if (res.ok) {
        console.log(`    Response: ${text.slice(0, 150)}`);
      }
    } catch (e) {
      results.tests.push({
        name: "kimi_test",
        error: String(e).slice(0, 200),
        ok: false,
      });
      console.log(`    Kimi test failed: ${e.message?.slice(0, 100) || e}`);
    }
  }

  return results;
}

function createProxyDispatcher(proxyUrl) {
  // undici не поддерживает socks5h напрямую, нужно преобразовать
  let url = proxyUrl;
  if (url.startsWith("socks5h://")) {
    url = "socks5://" + url.slice(10);
  }
  return new ProxyAgent(url);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maskKey(key) {
  if (!key) return "undefined";
  return `…${key.slice(-4)}`;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  pi-nvidia-plus Proxy A/B Test                                  ║");
  console.log("║  Testing rate limits dependence on IP address via proxies       ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    console.error("❌ NVIDIA_API_KEY не установлен!");
    process.exit(1);
  }
  console.log(`🔑 Using API key: ${maskKey(apiKey)}`);
  console.log(`🤖 Testing model: ${TEST_MODEL}`);
  console.log(`🌐 Proxies to test: ${PROXIES.length}\n`);

  const allResults = [];

  for (const proxy of PROXIES) {
    console.log(`\n🔍 Testing ${proxy.name} (${proxy.type}, ${proxy.country}, ${proxy.asn})`);
    console.log(`   ${proxy.url.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);
    
    const result = await testProxy(proxy, apiKey);
    allResults.push(result);
    
    // Пауза между прокси чтобы не перегрузить
    await sleep(2000);
  }

  // Сводка
  console.log("\n\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  SUMMARY                                                        ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  console.log(`Model tested: ${TEST_MODEL}`);
  console.log(`API Key: ${maskKey(apiKey)}\n`);

  // Группируем по типу
  const byType = {};
  for (const r of allResults) {
    if (!byType[r.type]) byType[r.type] = [];
    byType[r.type].push(r);
  }

  for (const [type, results] of Object.entries(byType)) {
    console.log(`\n📦 ${type.toUpperCase()} proxies (${results.length}):`);
    for (const r of results) {
      const health = r.tests.find(t => t.name === "health_check");
      const auth = r.tests.find(t => t.name === "auth_check");
      const rateLimit = r.tests.find(t => t.name === "rate_limit_test");
      const kimi = r.tests.find(t => t.name === "kimi_test");
      
      const healthStatus = health?.ok ? "✓" : "✗";
      const authStatus = auth?.ok ? "✓" : "✗";
      
      let rateLimitInfo = "";
      if (rateLimit?.attempts) {
        const rateLimited = rateLimit.attempts.filter(a => a.status === 429).length;
        const ok = rateLimit.attempts.filter(a => a.ok).length;
        rateLimitInfo = ` | RL: ${rateLimited}/5 | OK: ${ok}/5`;
      }
      
      let kimiInfo = "";
      if (kimi) {
        kimiInfo = kimi.ok ? " | Kimi: ✓" : " | Kimi: ✗";
      }
      
      console.log(`  ${healthStatus} ${authStatus} ${r.name} (${r.country}, ${r.asn})${rateLimitInfo}${kimiInfo}`);
    }
  }

  // Детальный отчёт по rate limits
  console.log("\n\n📈 DETAILED RATE LIMIT ANALYSIS:");
  for (const r of allResults) {
    const rateLimit = r.tests.find(t => t.name === "rate_limit_test");
    if (!rateLimit?.attempts) continue;
    
    const attempts = rateLimit.attempts;
    const rateLimited = attempts.filter(a => a.status === 429);
    const ok = attempts.filter(a => a.ok);
    const errors = attempts.filter(a => a.error);
    
    console.log(`\n${r.name} (${r.type}, ${r.country}):`);
    console.log(`  OK: ${ok.length}/5 | Rate Limited: ${rateLimited.length}/5 | Errors: ${errors.length}/5`);
    
    if (rateLimited.length > 0) {
      console.log(`  Rate limit details:`);
      for (const a of rateLimited) {
        console.log(`    Attempt ${a.attempt}: retry-after=${a.retryAfter || "none"}, retry-after-ms=${a.retryAfterMs || "none"}`);
      }
    }
    
    const latencies = attempts.filter(a => a.latency).map(a => a.latency);
    if (latencies.length > 0) {
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const min = Math.min(...latencies);
      const max = Math.max(...latencies);
      console.log(`  Latency: avg=${Math.round(avg)}ms min=${min}ms max=${max}ms`);
    }
  }

  // Сохраняем результаты в JSON
  const outDir = new URL("../test-results/", import.meta.url).pathname;
  const outputPath = outDir + "proxy-ab-test-" + Date.now() + ".json";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    model: TEST_MODEL,
    apiKey: maskKey(apiKey),
    results: allResults,
  }, null, 2));
  console.log(`\n💾 Results saved to: ${outputPath}`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});