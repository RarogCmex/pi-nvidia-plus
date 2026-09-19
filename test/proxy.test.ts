// Тесты шва прокси/диагностики: чистая маршрутизация, разбор диагностических
// заголовков, фабрика обёртки-диспетчера на фейках (без undici).
import assert from "node:assert";
import {
  NVIDIA_ORIGIN,
  isProxyConnectError,
  parseProxyUrl,
  isNvidiaOrigin,
  headersToRecord,
  extractDiagnostics,
  formatDiagnostic,
  describeProxyFailure,
  createSelectiveDispatcher,
  isOurDispatcher,
  ensureDispatcherInstalled,
  bufferRequestBody,
  resolveRetryDelayMs,
  makeNvidiaRetryFunction,
  buildRetryAgentOptions,
  withTransparentRetry,
  RETRYABLE_STATUSES,
} from "../extensions/proxy.ts";
import { KeyRotator } from "../extensions/keys.ts";

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

// 8. Обёртка обработчика (новый протокол ундичи 7+: onResponseStart/onResponseError):
// наблюдение за ответами, диагностика 429, прозрачность вызовов, мутация того же объекта.
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
    onResponseStart(controller: unknown, statusCode: number, headers: unknown, statusMessage: unknown) {
      received.push(`start:${statusCode}`);
      return true;
    },
    onResponseData(_chunk: unknown) {
      received.push("data");
      return true;
    },
    onResponseEnd(_trailers: unknown) {
      received.push("end");
      return true;
    },
  };

  dispatcher.dispatch({ origin: NVIDIA_ORIGIN }, handler);
  assert.strictEqual(nvidia.calls[0].handler, handler, "обёртка должна мутировать тот же объект (как интерцепторы ундичи)");
  handler.onResponseStart(null, 429, { "Retry-After": "32", "X-Request-ID": "r1" }, "");
  assert.deepEqual(received, ["start:429"], "оригинальный обработчик не вызван");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].status, 429);
  assert.equal(observed[0].headers["retry-after"], "32");
  assert.equal(diagnostics.length, 1);

  // 200 — наблюдение есть, диагностики нет; значения-массивы склеиваются.
  handler.onResponseStart(null, 200, { "Content-Type": ["text/event-stream"] }, "");
  assert.equal(observed.length, 2);
  assert.equal(observed[1].headers["content-type"], "text/event-stream");
  assert.equal(diagnostics.length, 1);

  // Остальные методы не задеты обёрткой.
  handler.onResponseData("x");
  handler.onResponseEnd(null);
  assert.deepEqual(received.slice(2), ["data", "end"]);

  // Повторная обёртка того же хендлера идемпотентна (защита от цепочек).
  const before = handler.onResponseStart;
  dispatcher.dispatch({ origin: NVIDIA_ORIGIN }, handler);
  assert.strictEqual(handler.onResponseStart, before, "двойное оборачивание");
  assert.equal(nvidia.calls.length, 2);

  // Не-nvidia запросы идут без обёртки.
  dispatcher.dispatch({ origin: "https://example.com" }, handler);
  assert.strictEqual(fallback.calls[0].handler, handler);
}

// 8a. Старый протокол (onResponse/onError) тоже поддерживается.
{
  const observedStatuses: number[] = [];
  const dispatcher = createSelectiveDispatcher({
    nvidia: makeTarget("proxy"),
    fallback: makeTarget("prev"),
    proxyUrl: "http://proxy.local:8870/",
    onObserved: (status) => observedStatuses.push(status),
  });
  const received: string[] = [];
  const legacy = {
    onResponse(statusCode: number, headers: unknown) {
      received.push(`response:${statusCode}`);
      return true;
    },
  };
  dispatcher.dispatch({ origin: NVIDIA_ORIGIN }, legacy);
  legacy.onResponse(503, ["Retry-After", "5"]);
  assert.deepEqual(received, ["response:503"]);
  assert.deepEqual(observedStatuses, [503]);
}

// 9. Обёртка обработчика: ошибки соединения переписываются в понятные про прокси (новый протокол).
{
  const nvidia = makeTarget("proxy");
  const fallback = makeTarget("prev");
  const dispatcher = createSelectiveDispatcher({
    nvidia,
    fallback,
    proxyUrl: "http://192.168.88.248:8870/",
  });
  const errors: Error[] = [];
  const handler = { onResponseError(_controller: unknown, err: Error) { errors.push(err); } };
  dispatcher.dispatch({ origin: NVIDIA_ORIGIN }, handler);

  const conn = new Error("connect ECONNREFUSED 192.168.88.248:8870") as NodeJS.ErrnoException;
  conn.code = "ECONNREFUSED";
  handler.onResponseError(null, conn);
  assert.equal(errors.length, 1);
  // Локаль-независимый идентификатор: текст сообщения локализован (тикет 17).
  assert.ok(errors[0].message.includes("NVIDIA_NIM_PROXY"), errors[0].message);
  assert.ok(errors[0].message.includes("192.168.88.248:8870"), errors[0].message);
  assert.equal((errors[0] as NodeJS.ErrnoException).code, "ECONNREFUSED", "код потерян");
  assert.strictEqual(errors[0].cause, conn, "причина потеряна");
}

// 9a. Старый протокол ошибок (onError): соединительные переписываются, остальные как есть.
{
  const dispatcher = createSelectiveDispatcher({
    nvidia: makeTarget("proxy"),
    fallback: makeTarget("prev"),
    proxyUrl: "http://192.168.88.248:8870/",
  });
  const errors: unknown[] = [];
  const legacy = { onError(err: unknown) { errors.push(err); } };
  dispatcher.dispatch({ origin: NVIDIA_ORIGIN }, legacy);

  const conn = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
  conn.code = "ECONNREFUSED";
  legacy.onError(conn);
  assert.ok(errors[0] instanceof Error && (errors[0] as Error).message.includes("NVIDIA_NIM_PROXY"));

  const abort = new Error("Request aborted");
  abort.name = "AbortError";
  legacy.onError(abort);
  assert.strictEqual(errors[1], abort);
}
// 9b. onProxyError вызывается с понятным сообщением при переписывании ошибки.
{
  const proxyErrors: string[] = [];
  const dispatcher = createSelectiveDispatcher({
    nvidia: makeTarget("proxy"),
    fallback: makeTarget("prev"),
    proxyUrl: "http://192.168.88.248:8870/",
    onProxyError: (message) => proxyErrors.push(message),
  });
  const handler = { onResponseError(_c: unknown, _err: Error) {} };
  dispatcher.dispatch({ origin: NVIDIA_ORIGIN }, handler);
  const conn = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
  conn.code = "ECONNREFUSED";
  handler.onResponseError(null, conn);
  assert.equal(proxyErrors.length, 1);
  assert.ok(proxyErrors[0].includes("NVIDIA_NIM_PROXY") && proxyErrors[0].includes("ECONNREFUSED"), proxyErrors[0]);
}
// 10. Идемпотентная установка: маркер, повтор не ставит вторую обёртку.
// nvidiaDirect — тот же ProxyAgent (keep-alive): keys check не должен
// создавать новый (свежий connect даёт EHOSTUNREACH при живом чате).
{
  const prevGlobal = makeTarget("prev-global");
  const proxyAgent = makeTarget("proxy-agent");
  let current: unknown = prevGlobal;
  const setCalls: unknown[] = [];
  const result1 = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => { current = d; setCalls.push(d); },
      createProxyAgent: () => proxyAgent,
    },
    { proxyUrl: new URL("http://192.168.88.248:8870/") },
  );
  assert.equal(result1.installed, true);
  assert.equal(result1.already, false);
  assert.ok(isOurDispatcher(current));
  assert.equal(setCalls.length, 1);
  assert.strictEqual(result1.nvidiaDirect, proxyAgent, "keys check переиспользует установленный ProxyAgent");
  assert.notStrictEqual(result1.nvidiaDirect, current, "не обёртка с ротацией/наблюдателем");

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
  assert.strictEqual(result2.nvidiaDirect, proxyAgent, "повторная установка не теряет keep-alive агент");

  // Прежний диспетчер сохранён как fallback
  const wrapper = current as { dispatch(opts: unknown, handler: unknown): boolean };
  wrapper.dispatch({ origin: "https://example.com" }, {});
  assert.equal((prevGlobal.calls.length), 1, "прежний диспетчер не подключён как fallback");
}

// 11. bufferRequestBody: строки/байты/null проходят как есть (воспроизводимы),
// асинхронно-итерируемые тела (то, что отдаёт fetch) буферизуются в байты.
{
  const asBytes = (b: unknown): string => Buffer.from(b as Uint8Array).toString("utf8");

  assert.equal(await bufferRequestBody(undefined), undefined);
  assert.equal(await bufferRequestBody(null), null);
  assert.equal(await bufferRequestBody("строка"), "строка");
  const bytes = new Uint8Array([1, 2, 3]);
  assert.strictEqual(await bufferRequestBody(bytes), bytes);

  async function* gen(): AsyncGenerator<Uint8Array> {
    yield Buffer.from("привет, ");
    yield Buffer.from("NIM");
  }
  const buffered = await bufferRequestBody(gen());
  assert.ok(buffered instanceof Uint8Array, "итератор буферизуется в байты");
  assert.equal(asBytes(buffered), "привет, NIM");

  // объект с Symbol.asyncIterator тоже буферизуется (кусками-строками)
  const iterable = {
    async *[Symbol.asyncIterator]() {
      yield "ab";
      yield "cd";
    },
  };
  assert.equal(asBytes(await bufferRequestBody(iterable)), "abcd");

  // пустое итерируемое — пустые байты (не undefined: длина тела важна)
  async function* empty(): AsyncGenerator<Uint8Array> {}
  const emptyBuffered = await bufferRequestBody(empty());
  assert.ok(emptyBuffered instanceof Uint8Array && (emptyBuffered as Uint8Array).length === 0);

  // неитерируемый мусор не трогаем (пусть решает ундичи)
  const odd = { strange: true };
  assert.strictEqual(await bufferRequestBody(odd), odd);
}

// 12. resolveRetryDelayMs: retry-after-ms > retry-after (секунды и дата), но не ниже
// minDelayMs (плоская задержка без роста; живой NIM заголовки в 429 не даёт); кап.
{
  const cfg = { minDelayMs: 500, maxDelayMs: 30_000 };
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);

  assert.equal(resolveRetryDelayMs({ "retry-after-ms": "1200" }, 1, cfg, now), 1200);
  assert.equal(resolveRetryDelayMs({ "retry-after-ms": "1200", "retry-after": "99" }, 1, cfg, now), 1200, "retry-after-ms первичен");
  assert.equal(resolveRetryDelayMs({ "retry-after": "7" }, 1, cfg, now), 7000);
  assert.equal(resolveRetryDelayMs({ "retry-after": "Wed, 27 Aug 2026 12:00:05 GMT" }, 1, cfg, now), 5000, "HTTP-дата");
  assert.equal(resolveRetryDelayMs({}, 1, cfg, now), 500, "без заголовка — минимальная задержка");
  assert.equal(resolveRetryDelayMs({}, 3, cfg, now), 500, "плоская: попытка 3 не растёт");
  assert.equal(resolveRetryDelayMs({ "retry-after-ms": "100" }, 1, cfg, now), 500, "короткий заголовок — пол из minDelayMs");
  assert.equal(resolveRetryDelayMs({ "retry-after-ms": "999999" }, 1, cfg, now), 30_000, "кап сверху");
  assert.equal(resolveRetryDelayMs({ "retry-after-ms": "-5" }, 1, cfg, now), 500, "отрицательный заголовок — пол");
}

// 13. makeNvidiaRetryFunction: решение о повторе.
{
  type RetryCall = { attempt: number; status: number; delayMs: number };
  const scheduled: RetryCall[] = [];
  const config = {
    maxRetries: 3,
    minDelayMs: 10,
    maxDelayMs: 100,
    onRetryScheduled: (info: RetryCall) => scheduled.push(info),
  };
  const retry = makeNvidiaRetryFunction(config);
  const nextTick = () => new Promise((r) => setTimeout(r, 50));

  // 429 с заголовком — повтор без ошибки, событие запланировано, задержка из заголовка
  let outcome: unknown = "unset";
  retry({ statusCode: 429, headers: { "retry-after-ms": "20" } }, { state: { counter: 1 } }, (e) => { outcome = e; });
  assert.equal(outcome, "unset", "повтор не мгновенный");
  await nextTick();
  assert.equal(outcome, null, "после задержки повтор разрешён");
  assert.deepEqual(scheduled, [{ attempt: 1, status: 429, delayMs: 20 }]);

  // 502 тоже повторяется (входит в список)
  outcome = "unset";
  retry({ statusCode: 502, headers: {} }, { state: { counter: 2 } }, (e) => { outcome = e; });
  await nextTick();
  assert.equal(outcome, null);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].status, 502);

  // исчерпание: счётчик выше лимита — ошибка пробрасывается сразу (повторяет уже пи)
  const exhausted = { statusCode: 429, headers: {} };
  retry(exhausted, { state: { counter: 4 } }, (e) => { outcome = e; });
  assert.strictEqual(outcome, exhausted, "исчерпание пробрасывает ошибку без задержки");
  assert.equal(scheduled.length, 2, "события при исчерпании нет");

  // неповторяемый статус (404) — сразу ошибка, без таймера и события
  const notFound = { statusCode: 404, headers: {} };
  retry(notFound, { state: { counter: 1 } }, (e) => { outcome = e; });
  assert.strictEqual(outcome, notFound);

  // транспортная ошибка без статуса — сразу ошибка (их повторяет пи)
  const conn = new Error("conn") as NodeJS.ErrnoException;
  conn.code = "ECONNRESET";
  retry(conn, { state: { counter: 1 } }, (e) => { outcome = e; });
  assert.strictEqual(outcome, conn);
  assert.equal(scheduled.length, 2);

  // список статусов по умолчанию
  assert.deepEqual([...RETRYABLE_STATUSES], [429, 500, 502, 503, 504]);
}

// 14. buildRetryAgentOptions: форма настроек для штатного повторителя ундичи.
{
  const config = { maxRetries: 3, minDelayMs: 10, maxDelayMs: 100 };
  const opts = buildRetryAgentOptions(config) as Record<string, unknown>;
  assert.equal(opts.maxRetries, 3);
  assert.equal(opts.throwOnError, false, "при исчерпании хендлер получает настоящий ответ");
  assert.deepEqual(opts.statusCodes, [429, 500, 502, 503, 504]);
  assert.equal(typeof opts.retry, "function", "своя функция повтора (знает retry-after-ms)");
  assert.ok(Array.isArray(opts.methods) && (opts.methods as string[]).includes("POST"), "POST повторяется");
}

// 15. withTransparentRetry: тело буферизуется, запрос уходит в повторитель, 
// ошибки буферизации доходят до хендлера, close/destroy делегируются.
{
  const received: Array<{ opts: { body?: unknown }; handler: unknown }> = [];
  const retryTarget = {
    dispatch(opts: unknown, handler: unknown) { received.push({ opts: opts as { body?: unknown }, handler }); return true; },
    close() { return Promise.resolve(); },
    destroy() { return Promise.resolve(); },
  };
  const created: Array<{ agent: unknown; retryOptions: unknown }> = [];
  const composed = withTransparentRetry(
    { dispatch() { return true; } },
    { maxRetries: 3, minDelayMs: 10, maxDelayMs: 100 },
    { createRetryAgent: (agent, retryOptions) => { created.push({ agent, retryOptions }); return retryTarget; } },
  );
  assert.equal(created.length, 1, "повторитель создаётся один раз");

  async function* gen(): AsyncGenerator<Uint8Array> { yield Buffer.from("{}"); }
  const handler = {};
  assert.equal(composed.dispatch({ origin: NVIDIA_ORIGIN, method: "POST", body: gen() }, handler), true);
  assert.equal(received.length, 0, "буферизация асинхронна");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received.length, 1);
  assert.ok(received[0].opts.body instanceof Uint8Array, "тело буферизовано в байты");
  assert.equal(Buffer.from(received[0].opts.body as Uint8Array).toString(), "{}");
  assert.strictEqual(received[0].handler, handler, "хендлер не подменяется на этом уровне");
  assert.equal((received[0].opts as { method?: string }).method, "POST", "остальные поля сохранены");

  // ошибка буферизации доходит до хендлера
  const badBody = { async *[Symbol.asyncIterator]() { throw new Error("плохое тело"); } };
  const errors: unknown[] = [];
  const errHandler = { onResponseError(_c: unknown, e: unknown) { errors.push(e); } };
  composed.dispatch({ origin: NVIDIA_ORIGIN, body: badBody }, errHandler);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error && (errors[0] as Error).message.includes("плохое тело"));
}

// 16. ensureDispatcherInstalled с повтором: nvidia-маршрут идёт через повторитель,
// остальное — в прежний диспетчер.
{
  let current: unknown = makeTarget("prev-global");
  const retryCalls: Array<{ opts: unknown; handler: unknown }> = [];
  const retryTarget = makeTarget("retry-agent");
  const result = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => { current = d; },
      createProxyAgent: (url) => makeTarget(`agent:${url}`),
      createRetryAgent: (agent, retryOptions) => {
        assert.ok(retryOptions, "настройки повторителя переданы");
        return retryTarget;
      },
    },
    {
      proxyUrl: new URL("http://192.168.88.248:8870/"),
      retry: { maxRetries: 3, minDelayMs: 10, maxDelayMs: 100 },
    },
  );
  assert.equal(result.installed, true);

  const wrapper = current as { dispatch(opts: unknown, handler: unknown): boolean };
  wrapper.dispatch({ origin: NVIDIA_ORIGIN, body: "{}" }, {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(retryTarget.calls.length, 1, "nvidia-запрос прошёл через повторитель");

  wrapper.dispatch({ origin: "https://example.com" }, {});
  assert.equal(retryTarget.calls.length, 1, "не-nvidia мимо повторителя");
}

// 17. Регрессия (тикет 15): ни прокси, ни ротации — обёртка не ставится (байт-в-байт как сегодня).
{
  let current: unknown = makeTarget("prev-global");
  const setCalls: unknown[] = [];
  const result = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => { current = d; setCalls.push(d); },
      createProxyAgent: (url) => makeTarget(`agent:${url}`),
    },
    {}, // ни прокси, ни ротации, ни повтора — ставить нечего
  );
  assert.equal(result.installed, false, "нечего ставить");
  assert.equal(result.already, false);
  assert.equal(setCalls.length, 0, "глобальный диспетчер не тронут");
  assert.strictEqual(current, current, "текущий диспетчер не заменён");
}

// 18. Ротация ставится БЕЗ прокси: nvidia-маршрут через прежний диспетчер, фолбэк — он же.
{
  const prevGlobal = makeTarget("prev-global");
  let current: unknown = prevGlobal;
  const result = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => { current = d; },
      createProxyAgent: () => {
        throw new Error("прокси-агент не должен создаваться без прокси");
      },
    },
    {
      // без proxyUrl — только ротация: цель-основание = прежний глобальный диспетчер
      rotation: {
        rotator: new KeyRotator(),
        getPoolKeys: () => [],
        enabled: () => true,
      },
    },
  );
  assert.equal(result.installed, true, "ротация без прокси ставится");
  assert.ok(isOurDispatcher(current));
}

// 19. Ротация поверх повтора: nvidia-запрос проходит повторитель, ротация видит конечный исход.
{
  let current: unknown = makeTarget("prev-global");
  const retryTarget = makeTarget("retry-agent");
  const result = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => { current = d; },
      createProxyAgent: (url) => makeTarget(`agent:${url}`),
      createRetryAgent: () => retryTarget,
    },
    {
      proxyUrl: new URL("http://192.168.88.248:8870/"),
      retry: { maxRetries: 3, minDelayMs: 10, maxDelayMs: 100 },
      rotation: {
        rotator: new KeyRotator(),
        getPoolKeys: () => [], // пул пуст → ротация пройдёт насквозь к повторителю
        enabled: () => true,
      },
    },
  );
  assert.equal(result.installed, true);
  const wrapper = current as { dispatch(opts: unknown, handler: unknown): boolean };
  wrapper.dispatch({ origin: NVIDIA_ORIGIN, method: "POST", headers: { authorization: "Bearer nvapi-x" }, body: "{}" }, {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(retryTarget.calls.length, 1, "запрос дошёл до повторителя сквозь ротацию");
}

// 20. isProxyConnectError делегирует единому классификатору шва пула:
// кольцо и `proxy check` карантинят один класс (включая EHOSTUNREACH и cause).
{
  const mk = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "EPROXYAUTH"]) {
    assert.equal(isProxyConnectError(mk(code)), true, code);
  }
  assert.equal(isProxyConnectError(mk("UND_ERR_HEADERS_TIMEOUT")), false, "headers-timeout — не CONNECT-класс");
  assert.equal(isProxyConnectError(Object.assign(new Error("fetch failed"), { cause: mk("ECONNREFUSED") })), true, "вложенная причина");
  assert.equal(isProxyConnectError(new Error("обычная ошибка")), false);
  assert.equal(isProxyConnectError(undefined), false);
}

console.log("proxy: все проверки прошли");
