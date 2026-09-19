/**
 * Тесты прозрачного повтора in-band ошибки перегрузки (тикет 29).
 *
 * Часть 1 — чистая классификация `classifyInBandStream`/`firstSseDataPayload`/
 * `extractErrorObject` (без сети).
 * Часть 2 — интеграция на локальном сервере с настоящим ундичи пи:
 *  - 200 + SSE `data:{"error":{"message":"Service temporarily overloaded"}}`
 *    → повтор → 200 с нормальным потоком: fetch получает успех;
 *  - постоянная перегрузка → после исчерпания бюджета fetch получает
 *    исходное тело ошибки (не зависает), onExhausted вызван;
 *  - нетранзитная ошибка в потоке (`Invalid request`) → отдаётся сразу, без повторов;
 *  - JSON-ответ (не SSE) стримит без буферизации;
 *  - полный стек (ротация + статусный повтор + in-band) не виснет.
 * Запуск: node test/inband-http.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  classifyInBandStream,
  firstSseDataPayload,
  extractErrorObject,
  inBandErrorMessage,
  inBandRetryDelayMs,
  withInBandOverloadRetry,
  withTransparentRetry,
  withKeyRotation,
  type DispatchTarget,
} from "../extensions/proxy.ts";
import { KeyRotator } from "../extensions/keys.ts";

/* ═══════════════ Часть 1: чистая классификация ═══════════════ */

const enc = new TextEncoder();
const SSE = "text/event-stream";

// 1. firstSseDataPayload: полное событие, разделение LF и CRLF, heartbeat пропускается.
{
  assert.equal(firstSseDataPayload(enc.encode("data: {\"a\":1}\n\n")), '{"a":1}');
  assert.equal(firstSseDataPayload(enc.encode("data: {\"a\":1}\r\n\r\n")), '{"a":1}');
  // Неполное событие — undefined (ждём продолжения).
  assert.equal(firstSseDataPayload(enc.encode('data: {"a":1}')), undefined);
  assert.equal(firstSseDataPayload(enc.encode("data: {\"a\":1}\n")), undefined);
  // Многострочная data склеивается \n.
  assert.equal(firstSseDataPayload(enc.encode("data: part1\ndata: part2\n\n")), "part1\npart2");
  // Ведущий heartbeat-комментарий пропускается, решение — по первому data.
  assert.equal(firstSseDataPayload(enc.encode(": ping\n\ndata: {\"a\":1}\n\n")), '{"a":1}');
  assert.equal(firstSseDataPayload(enc.encode(": ping\n\n")), undefined);
  // [DONE]
  assert.equal(firstSseDataPayload(enc.encode("data: [DONE]\n\n")), "[DONE]");
}

// 2. extractErrorObject: формы ошибок; нормальный чанк генерации ошибкой не считается.
{
  assert.deepEqual(extractErrorObject('{"error":{"message":"boom"}}'), { message: "boom" });
  assert.deepEqual(extractErrorObject('{"error":"plain string"}'), { message: "plain string" });
  assert.deepEqual(extractErrorObject('{"detail":"flat form"}'), { detail: "flat form" });
  // Обычный delta-чанк — не ошибка (ключи choices/model/object не входят в «ошибочные»).
  assert.equal(
    extractErrorObject('{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}'),
    undefined,
  );
  // Невалидный JSON / не-объект — не ошибка.
  assert.equal(extractErrorObject("{не json"), undefined);
  assert.equal(extractErrorObject("data: [DONE]"), undefined);
  assert.equal(inBandErrorMessage({ message: "m", detail: "d" }), "m");
  assert.equal(inBandErrorMessage({ detail: "d" }), "d");
  assert.equal(inBandErrorMessage({ code: 503 }), '{"code":503}');
}

// 3. classifyInBandStream: статус-гейт и content-type-гейт.
{
  const overload = enc.encode('data: {"error":{"message":"Service temporarily overloaded"}}\n\n');
  assert.equal(classifyInBandStream(503, SSE, overload).kind, "deliver", "не-2xx не буферизуем");
  assert.equal(classifyInBandStream(200, "application/json", overload).kind, "deliver", "не SSE не буферизуем");
  assert.equal(classifyInBandStream(200, undefined, overload).kind, "deliver");
  // Пустой буфер на SSE-2xx — undecided (ждё первый чанк).
  assert.equal(classifyInBandStream(200, SSE, new Uint8Array(0)).kind, "undecided");
  assert.equal(classifyInBandStream(200, "text/event-stream; charset=utf-8", new Uint8Array(0)).kind, "undecided");
}

// 4. Классификация содержимого: живая ошибка NIM, транзитные и нетранзитные тексты.
{
  const classify = (data: string) => classifyInBandStream(200, SSE, enc.encode(`data: ${data}\n\n`));
  // Живая форма из сессии 01a0b96c.
  const live = classify('{"error":{"message":"Service temporarily overloaded","type":"server_error"}}');
  assert.equal(live.kind, "retry");
  assert.equal((live as { reason: string }).reason, "Service temporarily overloaded");
  // Транзитные формулировки.
  for (const msg of [
    "Rate limit reached",
    "Too Many Requests",
    "resource exhausted: 429",
    "Service Unavailable",
    "upstream connect error or disconnect/reset before headers",
    "Internal server error",
    "please retry your request",
  ]) {
    assert.equal(classify(`{"error":{"message":"${msg}"}}`).kind, "retry", msg);
  }
  // Нетранзитные — не маскируем: пи должен их увидеть.
  for (const msg of [
    "Invalid request: messages are empty",
    "content_filter triggered",
    "Unauthorized: invalid API key",
    "insufficient_quota: out of budget",
    "This model's maximum context length is exceeded",
    "Function not found",
  ]) {
    assert.equal(classify(`{"error":{"message":"${msg}"}}`).kind, "deliver", msg);
  }
  // Нераспознанная форма ошибки — deliver (не повторяем вслепую).
  assert.equal(classify('{"error":{"message":"weird galaxy-brain failure"}}').kind, "deliver");
  // [DONE] и нормальный чанк — deliver.
  assert.equal(classify("[DONE]").kind, "deliver");
  assert.equal(classify('{"id":"x","choices":[{"delta":{"content":"hi"}}]}').kind, "deliver");
  // Недошедшее событие — undecided.
  assert.equal(classifyInBandStream(200, SSE, enc.encode('data: {"error":{"message":"Serv')).kind, "undecided");
  // Переполнение капа — deliver (поток без разделителей не ждём вечно).
  const big = enc.encode(`data: ${"x".repeat(9000)}`);
  assert.equal(classifyInBandStream(200, SSE, big).kind, "deliver");
}

// 5. inBandRetryDelayMs: удвоение от minDelayMs, кап maxDelayMs.
{
  const cfg = { minDelayMs: 1000, maxDelayMs: 5000 };
  assert.equal(inBandRetryDelayMs(1, cfg), 1000);
  assert.equal(inBandRetryDelayMs(2, cfg), 2000);
  assert.equal(inBandRetryDelayMs(3, cfg), 4000);
  assert.equal(inBandRetryDelayMs(4, cfg), 5000);
  assert.equal(inBandRetryDelayMs(10, cfg), 5000);
}

console.log("inband-http: чистая классификация ok");

/* ═══════════════ Часть 2: интеграция (настоящий ундичи пи) ═══════════════ */

interface UndiciLike {
  Agent: new () => DispatchTarget & { close(): Promise<void> };
  ProxyAgent?: unknown;
  RetryAgent: new (agent: unknown, options: Record<string, unknown>) => DispatchTarget;
  fetch: (url: string, init?: unknown) => Promise<{ status: number; text(): Promise<string> }>;
  setGlobalDispatcher(d: unknown): void;
}
const piRequire = createRequire(join(realpathSync(join("node_modules", "@earendil-works", "pi-coding-agent")), "index.js"));
const undici = piRequire("undici") as UndiciLike;

const SSE_HEADERS = { "content-type": "text/event-stream" } as const;
const OVERLOAD_EVENT = 'data: {"error":{"message":"Service temporarily overloaded","type":"server_error"}}\n\n';
const GOOD_STREAM =
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Привет"}}]}\n\n' +
  "data: [DONE]\n\n";

function startServer(
  decide: (attempt: number, auth: string | undefined) => { status: number; headers?: Record<string, string>; body: string; sse?: boolean },
): Promise<{ url: string; attempts: () => number; close: () => Promise<void> }> {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      attempts++;
      const action = decide(attempts, req.headers.authorization);
      const headers: Record<string, string> = action.sse === false
        ? { "content-type": "application/json", ...action.headers }
        : { ...SSE_HEADERS, ...action.headers };
      res.writeHead(action.status, headers);
      res.end(action.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("нет адреса сервера");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        attempts: () => attempts,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function fetchVia(dispatcher: unknown, url: string, body: unknown): Promise<{ status: number; text: string }> {
  undici.setGlobalDispatcher(dispatcher);
  const res = await undici.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer nvapi-pi-key" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const INBAND_CFG = { maxRetries: 2, minDelayMs: 10, maxDelayMs: 50 };
const REQUEST_BODY = { model: "nvidia/test", messages: [{ role: "user", content: "привет" }], stream: true };

// 6. Перегрузка → повтор → успех: fetch видит 200 с нормальным потоком.
{
  const server = await startServer((attempt) =>
    attempt === 1
      ? { status: 200, body: OVERLOAD_EVENT }
      : { status: 200, body: GOOD_STREAM },
  );
  try {
    const agent = new undici.Agent();
    const scheduled: Array<{ attempt: number; reason: string }> = [];
    const layer = withInBandOverloadRetry(agent, {
      ...INBAND_CFG,
      onRetryScheduled: (info) => scheduled.push({ attempt: info.attempt, reason: info.reason }),
    });
    const res = await fetchVia(layer, server.url, REQUEST_BODY);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Привет"), res.text);
    assert.equal(server.attempts(), 2);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].reason, "Service temporarily overloaded");
    await agent.close();
  } finally {
    await server.close();
  }
}

// 7. Постоянная перегрузка: после исчерпания бюджета пи получает исходную
// ошибку байт-в-байт; onExhausted вызван; fetch не виснет.
{
  const server = await startServer(() => ({ status: 200, body: OVERLOAD_EVENT }));
  try {
    const agent = new undici.Agent();
    const exhausted: Array<{ attempts: number; reason: string }> = [];
    let scheduledCount = 0;
    const layer = withInBandOverloadRetry(agent, {
      ...INBAND_CFG,
      onRetryScheduled: () => scheduledCount++,
      onExhausted: (info) => exhausted.push(info),
    });
    const res = await fetchVia(layer, server.url, REQUEST_BODY);
    assert.equal(res.status, 200);
    assert.equal(res.text, OVERLOAD_EVENT, "тело при исчерпании — байт-в-байт исходное");
    assert.equal(server.attempts(), 3, "1 первая + 2 повтора");
    assert.equal(scheduledCount, 2);
    assert.deepEqual(exhausted, [{ attempts: 3, reason: "Service temporarily overloaded" }]);
    await agent.close();
  } finally {
    await server.close();
  }
}

// 8. Нетранзитная ошибка в потоке — отдаётся сразу, без повторов.
{
  const invalidBody = 'data: {"error":{"message":"Invalid request: messages are empty"}}\n\n';
  const server = await startServer(() => ({ status: 200, body: invalidBody }));
  try {
    const agent = new undici.Agent();
    const layer = withInBandOverloadRetry(agent, INBAND_CFG);
    const res = await fetchVia(layer, server.url, REQUEST_BODY);
    assert.equal(res.text, invalidBody);
    assert.equal(server.attempts(), 1);
    await agent.close();
  } finally {
    await server.close();
  }
}

// 9. Не-SSE (JSON) ответ стримит без буферизации — discovery/keys-check не задеты.
{
  const jsonBody = '{"data":[{"id":"model/x"}]}';
  const server = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: jsonBody }));
  try {
    const agent = new undici.Agent();
    const layer = withInBandOverloadRetry(agent, INBAND_CFG);
    const res = await fetchVia(layer, server.url, {});
    assert.equal(res.status, 200);
    assert.equal(res.text, jsonBody);
    assert.equal(server.attempts(), 1);
    await agent.close();
  } finally {
    await server.close();
  }
}

// 10. Полный стек: in-band самый внутренний; статусный повтор и ротация выше —
// цепочка контроллеров не виснет, успех доходит до fetch.
{
  // Попытка 1: 200 + перегрузка (in-band повтор, тот же ключ) →
  // попытка 2: 429 (статусный RetryAgent ×3 → ротация на key2) →
  // попытка ≥5 на key2: 200 с нормальным потоком.
  const server = await startServer((attempt, auth) => {
    if (attempt === 1) return { status: 200, body: OVERLOAD_EVENT };
    if (!auth?.includes("nvapi-key2")) return { status: 429, headers: { "retry-after-ms": "5" }, body: '{"error":"rate limit"}' };
    return { status: 200, body: GOOD_STREAM };
  });
  try {
    const agent = new undici.Agent();
    const rotator = new KeyRotator();
    const inband = withInBandOverloadRetry(agent, INBAND_CFG);
    const retried = withTransparentRetry(inband as DispatchTarget, { maxRetries: 1, minDelayMs: 5, maxDelayMs: 20 }, {
      createRetryAgent: (a, o) => new undici.RetryAgent(a as never, o),
    });
    const stack = withKeyRotation(retried, {
      rotator,
      getPoolKeys: () => ["nvapi-key2"],
      enabled: () => true,
    });
    const res = await fetchVia(stack, server.url, REQUEST_BODY);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Привет"), res.text);
    await agent.close();
  } finally {
    await server.close();
  }
}

console.log("inband-http: интеграция ok");
