/**
 * Интеграционные тесты ротации ключей (тикет 15, критерий 2): локальный
 * мок-сервер + настоящий ундичи пи (повторитель, протокол ферря). Сценарии:
 *  - 429 (ключ 1, бюджет повторов исчерпан) → переключение на ключ 2 → 200
 *    (тело запроса цело на каждой попытке, Authorization переписан);
 *  - устойчивый 429 на всех ключах → пи получает настоящий 429 после 2 кругов;
 *  - 401 выводит ключ из ротации до конца сессии;
 *  - аборт (сигнал ферря) прерывает ротационное ожидание.
 * Запуск: node test/rotation-http.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { KeyRotator } from "../extensions/keys.ts";
import { withKeyRotation, withTransparentRetry, buildRetryAgentOptions, type DispatchTarget } from "../extensions/proxy.ts";

// Ундичи берём из поставки пи — тот самый, что будет в бою. Типов у него тут нет — утиный интерфейс.
interface UndiciLike {
  Agent: new () => DispatchTarget & { close(): Promise<void> };
  RetryAgent: new (agent: unknown, options: Record<string, unknown>) => DispatchTarget;
  fetch: (url: string, init?: unknown) => Promise<{ status: number; text(): Promise<string> }>;
}
const piRequire = createRequire(join(realpathSync(join("node_modules", "@earendil-works", "pi-coding-agent")), "index.js"));
const undici = piRequire("undici") as UndiciLike;

interface ServerAction {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

interface ServerLogEntry {
  auth: string | undefined;
  body: string;
  path: string | undefined;
}

function startServer(decide: (auth: string | undefined, body: string, attempt: number) => ServerAction): Promise<{
  url: string;
  log: ServerLogEntry[];
  close: () => Promise<void>;
}> {
  const log: ServerLogEntry[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      log.push({ auth: req.headers.authorization, body, path: req.url });
      const action = decide(req.headers.authorization, body, log.length);
      res.writeHead(action.status, action.headers ?? {});
      res.end(action.body ?? "");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("нет адреса сервера");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        log,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Боевая композиция: ротация поверх прозрачного повтора поверх агента. */
function makeStack(agent: unknown, poolKeys: string[], events: RotationEvents = {}) {
  const rotator = new KeyRotator();
  const retryTarget = withTransparentRetry(agent as { dispatch(opts: unknown, handler: unknown): boolean }, RETRY_CFG, {
    createRetryAgent: (a, o) => new undici.RetryAgent(a as never, o),
  });
  const rotation = withKeyRotation(retryTarget, {
    rotator,
    getPoolKeys: () => poolKeys,
    enabled: () => true,
    ...events,
  });
  return { rotator, rotation };
}

interface RotationEvents {
  onSwitch?: (info: { from: string; to: string; status: number }) => void;
  onDeadKey?: (key: string, status: number) => void;
  onExhausted?: (info: { attempts: number; status: number }) => void;
  onCooldownWait?: (ms: number) => void;
}

const RETRY_CFG = { maxRetries: 3, minDelayMs: 5, maxDelayMs: 50 };
const REQUEST_BODY = '{"model":"nvidia/test","messages":[{"role":"user","content":"привет"}]}';

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("условие не выполнено за отведённое время");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* ── Сценарий 1: 429 на ключе пи (бюджет исчерпан) → ключ 2 → 200 ───────── */
{
  const server = await startServer((auth): ServerAction =>
    auth?.includes("nvapi-key2")
      ? { status: 200, headers: { "content-type": "application/json" }, body: '{"ответ":"ок"}' }
      : { status: 429, headers: { "retry-after-ms": "5" }, body: '{"error":"rate limit"}' },
  );
  try {
    const agent = new undici.Agent();
    const switches: Array<{ from: string; to: string; status: number }> = [];
    const { rotation } = makeStack(agent, ["nvapi-key2"], {
      onSwitch: (info) => switches.push(info),
    });

    const res = await undici.fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer nvapi-key1", "content-type": "application/json" },
      body: REQUEST_BODY,
      dispatcher: rotation as never,
    });
    assert.equal(res.status, 200, "пи видит 200 — ротация прозрачна");
    assert.equal(await res.text(), '{"ответ":"ок"}');

    // 4 попытки на ключе 1 (исходная + 3 повтора), затем одна на ключе 2.
    assert.equal(server.log.length, 5, "бюджет повторов исчерпан на ключе 1, затем переключение");
    for (let i = 0; i < 4; i++) assert.equal(server.log[i].auth, "Bearer nvapi-key1", `попытка ${i + 1} — ключ 1`);
    assert.equal(server.log[4].auth, "Bearer nvapi-key2", "пятая попытка — ключ 2");
    // Тело запроса цело на каждой попытке.
    for (const entry of server.log) assert.equal(entry.body, REQUEST_BODY, "тело не искажается");
    assert.deepEqual(switches, [{ from: "nvapi-key1", to: "nvapi-key2", status: 429 }]);
    await agent.close();
  } finally {
    await server.close();
  }
}

/* ── Сценарий 2: устойчивый 429 на всех ключах → настоящий 429 после 2 кругов ─ */
{
  // 500 мс кулдаун больше бюджета повторов одного ключа (~150 мс) — круги реально ждут.
  const server = await startServer(() => ({ status: 429, headers: { "retry-after-ms": "500" }, body: '{"error":"всё плохо"}' }));
  try {
    const agent = new undici.Agent();
    const exhausted: Array<{ attempts: number; status: number }> = [];
    const waits: number[] = [];
    const { rotation } = makeStack(agent, ["nvapi-key2"], {
      onExhausted: (info) => exhausted.push(info),
      onCooldownWait: (ms) => waits.push(ms),
    });

    const res = await undici.fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer nvapi-key1" },
      body: REQUEST_BODY,
      dispatcher: rotation as never,
    });
    assert.equal(res.status, 429, "пи получает настоящий 429");
    assert.equal(await res.text(), '{"error":"всё плохо"}', "тело последнего 429 дошло");
    // 2 круга × 2 ключа × 4 попытки повтора = 16 запросов на сервере.
    assert.equal(server.log.length, 16, "два полных круга с бюджетами повторов");
    const order = server.log.map((e) => e.auth);
    assert.deepEqual([...new Set(order)], ["Bearer nvapi-key1", "Bearer nvapi-key2"]);
    assert.deepEqual(exhausted, [{ attempts: 4, status: 429 }], "4 ротационные попытки (2 круга × 2 ключа)");
    assert.ok(waits.length >= 1, "было ожидание кулдауна между кругами");
    await agent.close();
  } finally {
    await server.close();
  }
}

/* ── Сценарий 3: 401 выводит ключ из ротации до конца сессии ────────────── */
{
  const server = await startServer((auth): ServerAction =>
    auth?.includes("nvapi-key1") ? { status: 401, body: '{"error":"invalid key"}' } : { status: 200, body: '{"ok":true}' },
  );
  try {
    const agent = new undici.Agent();
    const deadKeys: Array<{ key: string; status: number }> = [];
    const { rotator, rotation } = makeStack(agent, ["nvapi-key2"], {
      onDeadKey: (key, status) => deadKeys.push({ key, status }),
    });

    const res = await undici.fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer nvapi-key1" },
      body: REQUEST_BODY,
      dispatcher: rotation as never,
    });
    assert.equal(res.status, 200, "после смерти ключа пи запрос ушёл ключом 2");
    assert.equal(server.log.length, 2);
    assert.equal(server.log[0].auth, "Bearer nvapi-key1");
    assert.equal(server.log[1].auth, "Bearer nvapi-key2");
    assert.deepEqual(deadKeys, [{ key: "nvapi-key1", status: 401 }]);
    assert.equal(rotator.isDead("nvapi-key1"), true);

    // Второй запрос: мёртвый ключ не пробуется вовсе.
    const res2 = await undici.fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer nvapi-key1" },
      body: REQUEST_BODY,
      dispatcher: rotation as never,
    });
    assert.equal(res2.status, 200);
    assert.equal(server.log.length, 3, "ровно одна новая попытка");
    assert.equal(server.log[2].auth, "Bearer nvapi-key2", "сразу живой ключ");
    await agent.close();
  } finally {
    await server.close();
  }
}

/* ── Сценарий 4: аборт прерывает ротационное ожидание ───────────────────── */
{
  // Большие кулдауны: после двух ключей ротация встаёт в долгое ожидание.
  const server = await startServer(() => ({ status: 429, headers: { "retry-after": "3600" }, body: "{}" }));
  try {
    const agent = new undici.Agent();
    const { rotation } = makeStack(agent, ["nvapi-key2"]);
    const controller = new AbortController();

    const fetchPromise = undici.fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer nvapi-key1" },
      body: REQUEST_BODY,
      dispatcher: rotation as never,
      signal: controller.signal,
    });
    // Ждём, пока оба ключа исчерпают бюджеты и ротация встанет в ожидание кулдауна.
    await until(() => server.log.length === 8);
    const attemptsBeforeAbort = server.log.length;
    controller.abort();

    await assert.rejects(fetchPromise, (err: unknown) => err instanceof Error && err.name === "AbortError", "феррь отклонён аборт-сигналом");
    // Даём фону шанс (не) сделать лишние попытки.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(server.log.length, attemptsBeforeAbort, "после аборта новых запросов нет");
    await agent.close();
  } finally {
    await server.close();
  }
}

console.log("rotation-http: все проверки прошли");
