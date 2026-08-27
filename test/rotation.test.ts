/**
 * Тесты транспортного шва ротации ключей (тикет 15): переписывание
 * Authorization, переключение на 429 после исчерпания, мёртвые 401/403,
 * два круга → настоящий 429 пи, аборт в паузе, прозрачность для 5xx и
 * регрессия (выключено/нет пула — как сегодня).
 * Запуск: node test/rotation.test.ts
 * Цели и хендлеры — фейки (без ундичи): протокол новый (он в ундичи 8 обязателен).
 */
import assert from "node:assert/strict";
import {
  extractBearerKey,
  withAuthorization,
  resolveCooldownMs,
  withKeyRotation,
  DEFAULT_ROTATION_COOLDOWN_MS,
  MAX_ROTATION_COOLDOWN_MS,
} from "../extensions/proxy.ts";
import { KeyRotator, maskKey } from "../extensions/keys.ts";

/* ── Фейки протокола ундичи ─────────────────────────────────────────────── */

function makeController() {
  return {
    aborted: false,
    reason: null as unknown,
    paused: false,
    rawHeaders: null as unknown,
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    abort(reason: unknown) {
      this.aborted = true;
      this.reason = reason;
    },
  };
}

/** Хендлер-приёмник: записывает, что реально дошло до пи. */
function makeReceiver() {
  const rec = {
    requestStarts: 0,
    controller: undefined as ReturnType<typeof makeController> | undefined,
    status: undefined as number | undefined,
    headers: undefined as Record<string, string> | undefined,
    statusMessage: undefined as unknown,
    chunks: [] as Uint8Array[],
    ended: false,
    trailers: undefined as unknown,
    error: undefined as unknown,
  };
  const handler = {
    rec,
    onRequestStart(controller: unknown) {
      rec.requestStarts += 1;
      rec.controller = controller as never;
    },
    onResponseStart(_controller: unknown, status: number, headers: Record<string, string>, statusMessage: unknown) {
      rec.status = status;
      rec.headers = headers;
      rec.statusMessage = statusMessage;
    },
    onResponseData(_controller: unknown, chunk: Uint8Array) {
      rec.chunks.push(chunk);
    },
    onResponseEnd(_controller: unknown, trailers: unknown) {
      rec.ended = true;
      rec.trailers = trailers;
    },
    onResponseError(_controller: unknown, err: unknown) {
      rec.error = err;
    },
  };
  return handler;
}

type Responder = (key: string | undefined, opts: Record<string, unknown>, attempt: number) =>
  | { status: number; headers?: Record<string, string>; body?: string; statusMessage?: string }
  | { error: unknown };

/** Цель-диспетчер: отвечает по скрипту в зависимости от ключа в Authorization. */
function makeTarget(respond: Responder) {
  const target = {
    attempts: [] as Array<{ key: string | undefined; opts: Record<string, unknown> }>,
    dispatch(opts: unknown, handler: unknown): boolean {
      const record = { key: extractBearerKey((opts as { headers?: unknown }).headers), opts: opts as Record<string, unknown> };
      target.attempts.push(record);
      const h = handler as Record<string, (...args: unknown[]) => void>;
      const controller = makeController();
      setTimeout(() => {
        h.onRequestStart?.(controller);
        const response = respond(record.key, record.opts, target.attempts.length);
        if ("error" in response) {
          h.onResponseError?.(controller, response.error);
          return;
        }
        h.onResponseStart?.(controller, response.status, response.headers ?? {}, response.statusMessage ?? "");
        if (response.body !== undefined) h.onResponseData?.(controller, Buffer.from(response.body));
        h.onResponseEnd?.(controller, {});
      }, 1);
      return true;
    },
  };
  return target;
}

function flush(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeRotation(opts: {
  poolKeys?: string[];
  enabled?: boolean;
  respond: Responder;
  now?: () => number;
  onSwitch?: (info: { from: string; to: string; status: number }) => void;
  onDeadKey?: (key: string, status: number) => void;
  onExhausted?: (info: { attempts: number; status: number }) => void;
  onCooldownWait?: (ms: number) => void;
}) {
  const rotator = new KeyRotator();
  const target = makeTarget(opts.respond);
  const rotation = withKeyRotation(target, {
    rotator,
    getPoolKeys: () => opts.poolKeys ?? [],
    enabled: () => opts.enabled ?? true,
    now: opts.now,
    onSwitch: opts.onSwitch,
    onDeadKey: opts.onDeadKey,
    onExhausted: opts.onExhausted,
    onCooldownWait: opts.onCooldownWait,
  });
  return { rotator, target, rotation };
}

/* ── 1. Вспомогательные швы ─────────────────────────────────────────────── */

// 1.1 Извлечение ключа из Authorization.
{
  assert.equal(extractBearerKey({ authorization: "Bearer nvapi-secret" }), "nvapi-secret");
  assert.equal(extractBearerKey({ Authorization: "bearer nvapi-x" }), "nvapi-x");
  assert.equal(extractBearerKey(["Authorization", "Bearer nvapi-y"]), "nvapi-y");
  assert.equal(extractBearerKey({ authorization: "Basic abc" }), undefined);
  assert.equal(extractBearerKey({}), undefined);
  assert.equal(extractBearerKey(undefined), undefined);
}

// 1.2 Переписывание Authorization: форма сохраняется, прочие заголовки целы.
{
  // объект (форма, в которой приходит fetch)
  const obj = withAuthorization({ Authorization: "Bearer old", "content-type": "application/json" }, "nvapi-new");
  assert.deepEqual(obj, { Authorization: "Bearer nvapi-new", "content-type": "application/json" });
  // без Authorization — добавляется
  assert.deepEqual(withAuthorization({ "x-a": "1" }, "k"), { "x-a": "1", authorization: "Bearer k" });
  // плоский массив ундичи
  const arr = withAuthorization(["Authorization", "Bearer old", "X-B", "2"], "nvapi-new");
  assert.deepEqual(arr, ["Authorization", "Bearer nvapi-new", "X-B", "2"]);
  const arrNoAuth = withAuthorization(["X-B", "2"], "k");
  assert.deepEqual(arrNoAuth, ["X-B", "2", "authorization", "Bearer k"]);
  // ничего — объект с одним заголовком
  assert.deepEqual(withAuthorization(undefined, "k"), { authorization: "Bearer k" });
}

// 1.3 Кулдаун: retry-after > дефолт, кап сверху.
{
  assert.equal(resolveCooldownMs({ "retry-after-ms": "1200" }), 1200);
  assert.equal(resolveCooldownMs({ "retry-after": "7" }), 7000);
  assert.equal(resolveCooldownMs({}), DEFAULT_ROTATION_COOLDOWN_MS, "нет заголовка — дефолт");
  assert.equal(resolveCooldownMs({ "retry-after": "99999" }), MAX_ROTATION_COOLDOWN_MS, "кап");
  assert.equal(
    resolveCooldownMs({ "retry-after-ms": "500" }, { defaultCooldownMs: 100, maxCooldownMs: 400 }),
    400,
    "настройки переопределяются",
  );
}

/* ── 2. Прозрачность: выключено/нет пула — байт-в-байт как сегодня ───────── */

// 2.1 Ротация выключена — запрос проходит в цель как есть (тот же opts и handler).
{
  const { target, rotation } = makeRotation({ enabled: false, poolKeys: ["nvapi-b"], respond: () => ({ status: 200 }) });
  const handler = makeReceiver();
  const opts = { origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" };
  assert.equal(rotation.dispatch(opts, handler), true);
  await flush();
  assert.equal(target.attempts.length, 1);
  assert.strictEqual(target.attempts[0].opts, opts, "opts не подменяется");
  assert.equal(handler.rec.status, 200);
}

// 2.2 Пул пуст — как сегодня.
{
  const { target, rotation } = makeRotation({ poolKeys: [], respond: () => ({ status: 200 }) });
  const handler = makeReceiver();
  rotation.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" }, handler);
  await flush();
  assert.equal(target.attempts.length, 1);
  assert.equal(target.attempts[0].key, "nvapi-pi", "ключ не тронут");
  assert.equal(handler.rec.status, 200);
}

// 2.3 Пул — только дубликат ключа пи: ротация no-op.
{
  const { target, rotation } = makeRotation({ poolKeys: ["nvapi-pi"], respond: () => ({ status: 200 }) });
  const handler = makeReceiver();
  rotation.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" }, handler);
  await flush();
  assert.equal(target.attempts.length, 1);
  assert.equal(handler.rec.status, 200);
}

/* ── 3. Успех: стриминг без буферизации, липкий ключ ────────────────────── */

{
  const { rotator, target, rotation } = makeRotation({
    poolKeys: ["nvapi-b"],
    respond: (key) => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: "данные" }),
  });
  const handler = makeReceiver();
  rotation.dispatch(
    { origin: "https://integrate.api.nvidia.com", method: "POST", headers: { authorization: "Bearer nvapi-pi" }, body: '{"m":1}' },
    handler,
  );
  await flush();
  assert.equal(target.attempts.length, 1);
  assert.equal(target.attempts[0].key, "nvapi-pi", "первый в пуле — ключ пи");
  assert.equal(handler.rec.status, 200);
  assert.equal(handler.rec.headers?.["content-type"], "text/event-stream");
  assert.equal(Buffer.concat(handler.rec.chunks as Buffer[]).toString(), "данные");
  assert.equal(handler.rec.ended, true);
  assert.equal(handler.rec.requestStarts, 1, "onRequestStart один на запрос");
  assert.equal(rotator.activeKey(), "nvapi-pi", "успех делает ключ липким");
}

/* ── 4. 429 → кулдаун → переключение на следующий ключ → 200 ────────────── */

{
  const switches: Array<{ from: string; to: string; status: number }> = [];
  const { rotator, target, rotation } = makeRotation({
    poolKeys: ["nvapi-b"],
    respond: (key) =>
      key === "nvapi-pi"
        ? { status: 429, headers: { "retry-after-ms": "1500" }, body: '{"error":"rate"}' }
        : { status: 200, body: "ок" },
    onSwitch: (info) => switches.push(info),
  });
  const handler = makeReceiver();
  rotation.dispatch(
    { origin: "https://integrate.api.nvidia.com", method: "POST", headers: { authorization: "Bearer nvapi-pi" }, body: '{"x":1}' },
    handler,
  );
  await flush();
  assert.equal(target.attempts.length, 2, "две попытки: ключ пи и следующий");
  assert.equal(target.attempts[0].key, "nvapi-pi");
  assert.equal(target.attempts[1].key, "nvapi-b");
  // тело запроса на обеих попытках цело
  for (const attempt of target.attempts) {
    assert.equal(attempt.opts.body, '{"x":1}', "тело не искажается");
  }
  // переписанный заголовок у второй попытки
  assert.deepEqual(
    (target.attempts[1].opts.headers as Record<string, string>).authorization ??
      (target.attempts[1].opts.headers as Record<string, string>).Authorization,
    "Bearer nvapi-b",
  );
  assert.equal(handler.rec.status, 200, "пи видит 200 — ротация прозрачна");
  assert.equal(Buffer.concat(handler.rec.chunks as Buffer[]).toString(), "ок");
  assert.deepEqual(switches, [{ from: "nvapi-pi", to: "nvapi-b", status: 429 }]);
  assert.equal(rotator.activeKey(), "nvapi-b");
  // 429-ответ ключа пи не дошёл до приёмника (промежуточный)
  assert.notEqual(handler.rec.status, 429);
}

/* ── 5. 401 → ключ мёртв до конца сессии ────────────────────────────────── */

{
  const dead: Array<{ key: string; status: number }> = [];
  const { rotator, target, rotation } = makeRotation({
    poolKeys: ["nvapi-b"],
    respond: (key) => (key === "nvapi-pi" ? { status: 401, body: "нет" } : { status: 200, body: "ок" }),
    onDeadKey: (key, status) => dead.push({ key, status }),
  });
  const handler = makeReceiver();
  rotation.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" }, handler);
  await flush();
  assert.equal(handler.rec.status, 200);
  assert.equal(rotator.isDead("nvapi-pi"), true, "ключ пи мёртв");
  assert.deepEqual(dead, [{ key: "nvapi-pi", status: 401 }]);

  // следующий запрос: мёртвый ключ не пробуется вовсе
  const handler2 = makeReceiver();
  rotation.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" }, handler2);
  await flush();
  assert.equal(target.attempts.length, 3, "только одна новая попытка — сразу живой ключ");
  assert.equal(target.attempts[2].key, "nvapi-b");
  assert.equal(handler2.rec.status, 200);
}

/* ── 6. Устойчивый 429 на всех ключах → пи получает настоящий 429 после 2 кругов ─ */

{
  const exhausted: Array<{ attempts: number; status: number }> = [];
  const waits: number[] = [];
  let clock = 0;
  const { target, rotation } = makeRotation({
    poolKeys: ["nvapi-b"],
    respond: () => ({ status: 429, headers: { "retry-after-ms": "10" }, body: '{"error":"устойчивый 429"}' }),
    now: () => clock,
    onExhausted: (info) => exhausted.push(info),
    onCooldownWait: (ms) => waits.push(ms),
  });
  const handler = makeReceiver();
  rotation.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" }, handler);
  // два круга по два ключа с паузами на кулдауны
  for (let i = 0; i < 12 && !handler.rec.ended && handler.rec.error === undefined; i++) {
    await flush(20);
    clock += 50; // время идёт — кулдауны откачиваются
  }
  assert.equal(target.attempts.length, 4, "2 круга × 2 ключа");
  assert.deepEqual(target.attempts.map((a) => a.key), ["nvapi-pi", "nvapi-b", "nvapi-pi", "nvapi-b"]);
  assert.equal(handler.rec.status, 429, "пи получает настоящий 429");
  assert.equal(Buffer.concat(handler.rec.chunks as Buffer[]).toString(), '{"error":"устойчивый 429"}');
  assert.equal(handler.rec.ended, true);
  assert.deepEqual(exhausted, [{ attempts: 4, status: 429 }]);
  assert.ok(waits.length >= 1, "были ожидания кулдаунов");
}

/* ── 7. 5xx и прочие статусы — без смены ключа ──────────────────────────── */

{
  const { rotator, target, rotation } = makeRotation({
    poolKeys: ["nvapi-b"],
    respond: () => ({ status: 503, body: "шлюз" }),
  });
  const handler = makeReceiver();
  rotation.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" }, handler);
  await flush();
  assert.equal(target.attempts.length, 1, "5xx не ротируется");
  assert.equal(handler.rec.status, 503);
  assert.equal(rotator.activeKey(), "nvapi-pi", "ключ остаётся активным");

  // 404 тоже не ротируется (мёртвая модель — не повод менять ключ)
  const t404 = makeRotation({ poolKeys: ["nvapi-b"], respond: () => ({ status: 404, body: "нет модели" }) });
  const h404 = makeReceiver();
  t404.rotation.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" }, h404);
  await flush();
  assert.equal(t404.target.attempts.length, 1);
  assert.equal(h404.rec.status, 404);
}

/* ── 8. Транспортная ошибка — не ротируется, доходит до пи ──────────────── */

{
  const conn = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
  conn.code = "ECONNREFUSED";
  const { target, rotation } = makeRotation({ poolKeys: ["nvapi-b"], respond: () => ({ error: conn }) });
  const handler = makeReceiver();
  rotation.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" }, handler);
  await flush();
  assert.equal(target.attempts.length, 1);
  assert.strictEqual(handler.rec.error, conn);
}

/* ── 9. Аборт прерывает ротационное ожидание ────────────────────────────── */

{
  const { target, rotation } = makeRotation({
    poolKeys: ["nvapi-b"],
    respond: () => ({ status: 429, headers: { "retry-after": "9999" }, body: "{}" }), // кулдаун под капом 300 с
  });
  const handler = makeReceiver();
  rotation.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: "{}" }, handler);
  // обе попытки 429 → очередь в ожидание кулдауна
  await flush(20);
  assert.equal(target.attempts.length, 2, "до ожидания дошло");
  assert.equal(handler.rec.status, undefined, "ничего ещё не отдано пи");
  // пользователь жмёт Esc: феррь через контроллер вызывает аборт
  assert.ok(handler.rec.controller, "контроллер проброшен в хендлер");
  const reason = new Error("The operation was aborted.");
  reason.name = "AbortError";
  handler.rec.controller!.abort(reason);
  await flush(30);
  assert.equal(target.attempts.length, 2, "после аборта новых попыток нет");
  assert.equal(handler.rec.status, undefined, "ответ не отдаётся — феррь уже отклонён");
  assert.equal(handler.rec.error, undefined, "и синтетической ошибки нет — пи сам знает про аборт");
}

/* ── 10. Отчёт ротатора в уведомлениях — только маскированные суффиксы ──── */

{
  // проверяем, что маскировка доступна и не выдаёт ключ целиком
  const masked = maskKey("nvapi-secret-ABCD1234");
  assert.equal(masked, "…1234");
  assert.ok(!masked.includes("secret"));
}

console.log("rotation: все проверки прошли");
