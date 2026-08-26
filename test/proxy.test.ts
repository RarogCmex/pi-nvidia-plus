// Тесты шва прокси/диагностики: чистая маршрутизация, разбор диагностических
// заголовков, фабрика обёртки-диспетчера на фейках (без undici).
import assert from "node:assert";
import {
  NVIDIA_ORIGIN,
  parseProxyUrl,
  isNvidiaOrigin,
  headersToRecord,
  extractDiagnostics,
  formatDiagnostic,
  describeProxyFailure,
  createSelectiveDispatcher,
  isOurDispatcher,
  ensureDispatcherInstalled,
} from "../extensions/proxy.ts";

// 1. parseProxyUrl
{
  assert.deepEqual(parseProxyUrl(undefined), {});
  assert.deepEqual(parseProxyUrl("   "), {});
  const ok = parseProxyUrl("http://192.168.88.248:8870");
  assert.equal(ok.url?.toString(), "http://192.168.88.248:8870/");
  assert.equal(ok.error, undefined);
  // Без схемы — подразумевается http
  const bare = parseProxyUrl("192.168.88.248:8870");
  assert.equal(bare.url?.toString(), "http://192.168.88.248:8870/");
  const bad = parseProxyUrl("ht tp://некорректный");
  assert.equal(bad.url, undefined);
  assert.ok(bad.error?.includes("NVIDIA_NIM_PROXY"), "ошибка не называет переменную");
}

// 2. isNvidiaOrigin
{
  assert.equal(isNvidiaOrigin(NVIDIA_ORIGIN), true);
  assert.equal(isNvidiaOrigin(new URL(NVIDIA_ORIGIN + "/v1/chat/completions").origin), true);
  assert.equal(isNvidiaOrigin("https://integrate.api.nvidia.com/"), true); // нормализация через URL.origin
  assert.equal(isNvidiaOrigin("https://integrate.api.nvidia.com/v1/x"), true);
  assert.equal(isNvidiaOrigin("http://integrate.api.nvidia.com"), false);
  assert.equal(isNvidiaOrigin("https://api.nvidia.com"), false);
  assert.equal(isNvidiaOrigin(undefined), false);
}

// 3. headersToRecord: плоский массив [k1, v1, k2, v2] и объект; ключи в нижний регистр
{
  assert.deepEqual(headersToRecord(["Content-Type", "application/json", "Retry-After", "32"]), {
    "content-type": "application/json",
    "retry-after": "32",
  });
  assert.deepEqual(headersToRecord({ "X-Request-ID": "abc" }), { "x-request-id": "abc" });
  assert.deepEqual(headersToRecord(null), {});
  assert.deepEqual(headersToRecord(undefined), {});
}

// 4. extractDiagnostics — только 429 и 5xx
{
  const now = Date.parse("2026-08-26T12:00:00Z");
  assert.equal(extractDiagnostics(200, {}, now), undefined);
  assert.equal(extractDiagnostics(404, { "retry-after": "99" }, now), undefined);

  const d1 = extractDiagnostics(429, { "retry-after": "32" }, now);
  assert.equal(d1?.status, 429);
  assert.equal(d1?.retryAfterMs, 32000);

  // retry-after-ms в приоритете
  const d2 = extractDiagnostics(429, { "retry-after": "32", "retry-after-ms": "1500" }, now);
  assert.equal(d2?.retryAfterMs, 1500);

  // HTTP-дата
  const d3 = extractDiagnostics(429, { "retry-after": "Wed, 26 Aug 2026 12:00:40 GMT" }, now);
  assert.equal(d3?.retryAfterMs, 40000);

  // 5xx без retry-after — просто статус
  const d4 = extractDiagnostics(503, {}, now);
  assert.equal(d4?.status, 503);
  assert.equal(d4?.retryAfterMs, undefined);

  // request ID: известные кандидаты, потом общий поиск по суффиксу request-id
  assert.equal(extractDiagnostics(429, { "x-request-id": "r1" }, now)?.requestId, "r1");
  assert.equal(extractDiagnostics(429, { "x-nvidia-request-id": "r2" }, now)?.requestId, "r2");
  assert.equal(extractDiagnostics(429, { "nvcf-request-id": "r3" }, now)?.requestId, "r3");
  assert.equal(extractDiagnostics(429, { "content-type": "x" }, now)?.requestId, undefined);
}

// 5. formatDiagnostic
{
  const msg = formatDiagnostic({ status: 429, retryAfterMs: 32000, requestId: "r1", observedAt: 0 });
  assert.ok(msg.includes("429") && msg.includes("32") && msg.includes("r1"), msg);
  const msg2 = formatDiagnostic({ status: 503, observedAt: 0 });
  assert.ok(msg2.includes("503"), msg2);
}

// 6. describeProxyFailure — понятная ошибка с адресом прокси
{
  const err = new Error("connect ECONNREFUSED 192.168.88.248:8870");
  (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
  const msg = describeProxyFailure("http://192.168.88.248:8870/", err);
  assert.ok(msg.includes("192.168.88.248:8870"), msg);
  assert.ok(msg.includes("ECONNREFUSED"), msg);
  assert.ok(msg.includes("NVIDIA_NIM_PROXY"), msg);
}

// Фейки для фабрики
function makeTarget(name: string) {
  const calls: Array<{ opts: unknown; handler: unknown }> = [];
  return {
    name,
    calls,
    dispatch(opts: unknown, handler: unknown) {
      calls.push({ opts, handler });
      return true;
    },
  };
}

// 7. Маршрутизация: nvidia-начало — через прокси, остальное — прежнему диспетчеру
{
  const nvidia = makeTarget("proxy");
  const fallback = makeTarget("prev");
  const dispatcher = createSelectiveDispatcher({
    nvidia,
    fallback,
    proxyUrl: "http://proxy.local:8870/",
  });

  dispatcher.dispatch({ origin: NVIDIA_ORIGIN }, {});
  assert.equal(nvidia.calls.length, 1);
  assert.equal(fallback.calls.length, 0);

  dispatcher.dispatch({ origin: "https://example.com" }, {});
  assert.equal(fallback.calls.length, 1);

  // origin может быть объектом URL
  dispatcher.dispatch({ origin: new URL(NVIDIA_ORIGIN) }, {});
  assert.equal(nvidia.calls.length, 2);
}

// 8. Обёртка обработчика: наблюдение за ответами, диагностика 429, прозрачность вызовов
{
  const nvidia = makeTarget("proxy");
  const fallback = makeTarget("prev");
  const observed: Array<{ status: number; headers: Record<string, string> }> = [];
  const diagnostics: unknown[] = [];
  const dispatcher = createSelectiveDispatcher({
    nvidia,
    fallback,
    proxyUrl: "http://proxy.local:8870/",
    onObserved: (status, headers) => observed.push({ status, headers }),
    onDiagnostic: (d) => diagnostics.push(d),
  });

  const received: string[] = [];
  const handler = {
    onResponse(statusCode: number, headers: unknown) {
      received.push(`response:${statusCode}`);
      return true;
    },
    onData(_chunk: unknown) {
      received.push("data");
      return true;
    },
    onComplete(_trailers: unknown) {
      received.push("complete");
      return true;
    },
  };

  dispatcher.dispatch({ origin: NVIDIA_ORIGIN }, handler);
  const wrapped = nvidia.calls[0].handler as typeof handler;
  // Плоские массивные заголовки, как отдаёт undici
  wrapped.onResponse(429, ["Retry-After", "32", "X-Request-ID", "r1"]);
  assert.deepEqual(received, ["response:429"], "оригинальный обработчик не вызван");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].status, 429);
  assert.equal(observed[0].headers["retry-after"], "32");
  assert.equal(diagnostics.length, 1);

  // 200 — наблюдение есть, диагностики нет
  wrapped.onResponse(200, ["Content-Type", "text/event-stream"]);
  assert.equal(observed.length, 2);
  assert.equal(diagnostics.length, 1);

  // Остальные методы пробрасываются
  wrapped.onData("x");
  wrapped.onComplete(null);
  assert.deepEqual(received.slice(2), ["data", "complete"]);

  // Не-nvidia запросы идут без обёртки
  dispatcher.dispatch({ origin: "https://example.com" }, handler);
  assert.strictEqual(fallback.calls[0].handler, handler);
}

// 9. Обёртка обработчика: ошибки соединения переписываются в понятные про прокси
{
  const nvidia = makeTarget("proxy");
  const fallback = makeTarget("prev");
  const dispatcher = createSelectiveDispatcher({
    nvidia,
    fallback,
    proxyUrl: "http://192.168.88.248:8870/",
  });
  const errors: Error[] = [];
  const handler = { onError(err: Error) { errors.push(err); } };
  dispatcher.dispatch({ origin: NVIDIA_ORIGIN }, handler);
  const wrapped = nvidia.calls[0].handler as typeof handler;

  const conn = new Error("connect ECONNREFUSED 192.168.88.248:8870") as NodeJS.ErrnoException;
  conn.code = "ECONNREFUSED";
  wrapped.onError(conn);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes("прокси"), errors[0].message);
  assert.ok(errors[0].message.includes("192.168.88.248:8870"), errors[0].message);
  assert.equal((errors[0] as NodeJS.ErrnoException).code, "ECONNREFUSED", "код потерян");

  // Не-соединительная ошибка проходит как есть
  const abort = new Error("Request aborted");
  abort.name = "AbortError";
  wrapped.onError(abort);
  assert.strictEqual(errors[1], abort);
}

// 10. Идемпотентная установка: маркер, повтор не ставит вторую обёртку
{
  const prevGlobal = makeTarget("prev-global");
  let current: unknown = prevGlobal;
  const setCalls: unknown[] = [];
  const result1 = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => { current = d; setCalls.push(d); },
      createProxyAgent: (url) => makeTarget(`agent:${url}`),
    },
    { proxyUrl: new URL("http://192.168.88.248:8870/") },
  );
  assert.equal(result1.installed, true);
  assert.equal(result1.already, false);
  assert.ok(isOurDispatcher(current));
  assert.equal(setCalls.length, 1);

  const result2 = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => { current = d; setCalls.push(d); },
      createProxyAgent: (url) => makeTarget(`agent:${url}`),
    },
    { proxyUrl: new URL("http://192.168.88.248:8870/") },
  );
  assert.equal(result2.already, true);
  assert.equal(result2.installed, false);
  assert.equal(setCalls.length, 1, "повторная установка");

  // Прежний диспетчер сохранён как fallback
  const wrapper = current as { dispatch(opts: unknown, handler: unknown): boolean };
  wrapper.dispatch({ origin: "https://example.com" }, {});
  assert.equal((prevGlobal.calls.length), 1, "прежний диспетчер не подключён как fallback");
}

console.log("proxy: все проверки прошли");
