/**
 * Тесты надзора таймаутов живого пути `withRequestTimeouts` (исследование 10, §3).
 *
 * Часть 1 — чистая классификация (без сети): `isRequestTimeoutError` узнаёт
 * коды ундичи и обе текстовые формы (request() и fetch), разворачивает cause.
 * Часть 2 — интеграция на локальном сервере с настоящим ундичи пи:
 *  - сервер молчит с заголовками → fetch отваливается по headers-таймауту
 *    с синтетической ошибкой (код UND_ERR_HEADERS_TIMEOUT), не виснет 300 с;
 *  - сервер отдал заголовки и чанк и замолчал → body-таймаут бездействия;
 *  - нормальный поток проходит насквозь, таймеры не срабатывают;
 *  - стрим с редкими чанками (внутри body-таймаута) проходит целиком.
 * Запуск: node test/request-timeouts-http.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isRequestTimeoutError } from "../extensions/proxy-pool.ts";
import { withRequestTimeouts } from "../extensions/proxy.ts";

const undici = createRequire(
  join(realpathSync(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent")), "index.js"),
)("undici");

/* ═══════════════ Часть 1: чистая классификация ═══════════════ */

{
  // Коды ундичи (нативные пулы) и собственные коды watchdog-слоя.
  assert.ok(isRequestTimeoutError(Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" })));
  assert.ok(isRequestTimeoutError(Object.assign(new Error("x"), { code: "UND_ERR_BODY_TIMEOUT" })));
  assert.ok(isRequestTimeoutError(Object.assign(new Error("x"), { code: "PI_NVIDIA_PLUS_HEADERS_TIMEOUT" })));
  assert.ok(isRequestTimeoutError(Object.assign(new Error("x"), { code: "PI_NVIDIA_PLUS_BODY_TIMEOUT" })));
  // Текстовые формы: request() и fetch формулируют одну ошибку по-разному;
  // синтетика watchdog-слоя — тем же кодом.
  assert.ok(isRequestTimeoutError(new Error("Headers Timeout Error")));
  assert.ok(isRequestTimeoutError(Object.assign(new Error("Headers timeout after 60000 ms (NVIDIA_NIM_HEADERS_TIMEOUT_MS)"), { code: "PI_NVIDIA_PLUS_HEADERS_TIMEOUT" })));
  assert.ok(isRequestTimeoutError(new Error("Body Timeout Error")));
  assert.ok(isRequestTimeoutError(new Error('HTTP/2: "headers timeout after 45000"')));
  assert.ok(isRequestTimeoutError(new Error("Headers timeout after 60000 ms (NVIDIA_NIM_HEADERS_TIMEOUT_MS)")));
  // cause разворачивается.
  assert.ok(isRequestTimeoutError(new Error("fetch failed", { cause: Object.assign(new Error("y"), { code: "UND_ERR_HEADERS_TIMEOUT" }) })));
  // Не таймауты.
  assert.ok(!isRequestTimeoutError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
  assert.ok(!isRequestTimeoutError(new Error("socket disconnected")));
  assert.ok(!isRequestTimeoutError(null));
  assert.ok(!isRequestTimeoutError("string"));
}

/* ═══════════════ Часть 2: локальный сервер ═══════════════ */

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/** Сервер-сценарий: сам решает, писать ли заголовки/чанки и когда замолчать. */
function startServer(
  scenario: (res: http.ServerResponse, req: http.IncomingMessage, attempt: { n: number }) => void,
): Promise<TestServer> {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      n++;
      scenario(res, req, { n });
    });
  });
  server.keepAliveTimeout = 500;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("нет адреса сервера");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function fetchVia(dispatcher: unknown, url: string): Promise<{ ok: boolean; status?: number; text?: string; error?: unknown }> {
  undici.setGlobalDispatcher(dispatcher);
  try {
    const res = await undici.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nvapi-test" },
      body: JSON.stringify({ model: "nvidia/test", messages: [{ role: "user", content: "hi" }] }),
    });
    return { ok: true, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/** Ищет код ошибки по цепочке cause (fetch заворачивает ошибки ундичи). */
function codeInChain(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function messageInChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) parts.push(msg);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

// 1. Сервер молчит вовсе: headers-таймаут срабатывает, fetch не виснет.
{
  const server = await startServer((_res, _req) => {
    /* намеренно молчим: ни заголовков, ни конца */
  });
  try {
    const agent = new undici.Agent();
    const layer = withRequestTimeouts(agent, { headersTimeoutMs: 150, bodyTimeoutMs: 5_000 });
    const t0 = Date.now();
    const res = await fetchVia(layer, server.url);
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false, "fetch должен упасть, а не ждать");
    assert.ok(elapsed < 3_000, `таймаут сработал быстро (${elapsed} мс), а не дефолтные 300 с`);
    assert.equal(codeInChain(res.error), "PI_NVIDIA_PLUS_HEADERS_TIMEOUT", `код синтетики в цепочке: ${messageInChain(res.error)}`);
    assert.match(messageInChain(res.error), /Headers timeout after 150 ms/, messageInChain(res.error));
    undici.setGlobalDispatcher(new undici.Agent());
    await agent.close();
  } finally {
    await server.close();
  }
}

// 2. Заголовки и чанк пришли, потом стрим замолчал: body-таймаут бездействия.
{
  const server = await startServer((res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: chunk-1\n\n");
    /* молчим: ни данных, ни конца */
  });
  try {
    const agent = new undici.Agent();
    const layer = withRequestTimeouts(agent, { headersTimeoutMs: 5_000, bodyTimeoutMs: 150 });
    const t0 = Date.now();
    const res = await fetchVia(layer, server.url);
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false, "замолчавший стрим должен упасть по бездействию");
    assert.ok(elapsed < 3_000, `body-таймаут сработал быстро (${elapsed} мс)`);
    assert.equal(codeInChain(res.error), "PI_NVIDIA_PLUS_BODY_TIMEOUT", `код синтетики в цепочке: ${messageInChain(res.error)}`);
    undici.setGlobalDispatcher(new undici.Agent());
    await agent.close();
  } finally {
    await server.close();
  }
}

// 3. Нормальный ответ проходит насквозь: таймеры сняты, тело байт-в-байт.
{
  const server = await startServer((res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: hello\n\n");
    res.write("data: world\n\n");
    res.end();
  });
  try {
    const agent = new undici.Agent();
    const layer = withRequestTimeouts(agent, { headersTimeoutMs: 5_000, bodyTimeoutMs: 5_000 });
    const res = await fetchVia(layer, server.url);
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.ok(res.text?.includes("hello"), res.text ?? "");
    assert.ok(res.text?.includes("world"), res.text ?? "");
    undici.setGlobalDispatcher(new undici.Agent());
    await agent.close();
  } finally {
    await server.close();
  }
}

// 4. Стрим с редкими чанками (пауза меньше body-таймаута) доходит целиком:
// таймер бездействия сбрасывается каждым чанком.
{
  const server = await startServer((res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const timer = setInterval(() => {
      i++;
      res.write(`data: tick-${i}\n\n`);
      if (i >= 3) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
    res.on("close", () => clearInterval(timer));
  });
  try {
    const agent = new undici.Agent();
    const layer = withRequestTimeouts(agent, { headersTimeoutMs: 5_000, bodyTimeoutMs: 400 });
    const res = await fetchVia(layer, server.url);
    assert.equal(res.ok, true, "редкие чанки внутри body-таймаута не должны рвать стрим");
    assert.ok(res.text?.includes("tick-3"), res.text ?? "");
    undici.setGlobalDispatcher(new undici.Agent());
    await agent.close();
  } finally {
    await server.close();
  }
}

console.log("request-timeouts-http: все проверки прошли");
