/**
 * Интеграционные тесты кольца прокси (spec proxy-pool, «Existing seam
 * extensions»): локальные CONNECT-прокси + настоящий ундичи пи. Сценарии:
 *  - пул из двух href: dispatch липнет к pin; второй dispatch — тот же выход;
 *  - ключевые ротационные повторы одного dispatch идут через ТОТ ЖЕ прокси
 *    (pin-инвариант на живом транспорте);
 *  - мёртвый CONNECT → карантин, следующий dispatch идёт во второй выход;
 *  - креденшелы в URL доезжают до прокси (Proxy-Authorization), а в журнал
 *    наблюдателя попадает только display identity;
 *  - любой HTTP-ответ (даже 503) — выход достижим: карантина нет.
 * Запуск: node test/proxy-ring-http.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { withProxyRing, type DispatchTarget } from "../extensions/proxy.ts";
import { withKeyRotation } from "../extensions/proxy.ts";
import { ProxyRotator, maskProxy } from "../extensions/proxy-pool.ts";
import { KeyRotator } from "../extensions/keys.ts";

// Ундичи берём из поставки пи — тот самый, что будет в бою.
interface UndiciLike {
  Agent: new () => DispatchTarget & { close(): Promise<void> };
  ProxyAgent: new (url: string) => DispatchTarget & { close(): Promise<void> };
  fetch: (url: string, init?: unknown) => Promise<{ status: number; text(): Promise<string> }>;
}
const piRequire = createRequire(join(realpathSync(join("node_modules", "@earendil-works", "pi-coding-agent")), "index.js"));
const undici = piRequire("undici") as UndiciLike;

interface ProxyLogEntry {
  target: string;
  auth: string | undefined;
  /** `connect` — TLS-туннель (боевой путь NIM), `forward` — absolute-form (http-цель). */
  kind: "connect" | "forward";
}

/**
 * Минимальный прокси: CONNECT-туннель (боевой путь к `https://integrate.api.
 * nvidia.com`) И absolute-form переадресация — ундичи ProxyAgent для http-цели
 * шлёт обычный запрос с абсолютным URI, а TLS-сервер в тесте без сертификатов
 * не поднять (переносимость важнее буквального CONNECT).
 */
function startConnectProxy(options: { requireAuth?: string } = {}): Promise<{
  port: number;
  log: ProxyLogEntry[];
  connects: number;
  close: () => Promise<void>;
}> {
  const log: ProxyLogEntry[] = [];
  let connects = 0;
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (!/^https?:\/\//i.test(url)) {
      res.writeHead(400);
      res.end("absolute-form only");
      return;
    }
    const auth = req.headers["proxy-authorization"];
    log.push({ target: url, auth, kind: "forward" });
    if (options.requireAuth && auth !== options.requireAuth) {
      res.writeHead(407);
      res.end();
      return;
    }
    const target = new URL(url);
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("connect", (req, clientSocket, head) => {
    connects += 1;
    const auth = req.headers["proxy-authorization"];
    log.push({ target: req.url ?? "", auth, kind: "connect" });
    if (options.requireAuth && auth !== options.requireAuth) {
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      clientSocket.end();
      return;
    }
    const [host, portStr] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(portStr) || 80, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const destroy = (): void => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", destroy);
    clientSocket.on("error", destroy);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("нет адреса прокси");
      resolve({
        port: address.port,
        log,
        get connects() {
          return connects;
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
  });
}

/** Локальный origin-сервер (цель внутри туннеля). */
function startOrigin(decide: (auth: string | undefined, body: string, attempt: number) => { status: number; body?: string }): Promise<{
  url: string;
  log: Array<{ auth: string | undefined; body: string }>;
  close: () => Promise<void>;
}> {
  const log: Array<{ auth: string | undefined; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      log.push({ auth: req.headers.authorization, body });
      const action = decide(req.headers.authorization, body, log.length);
      res.writeHead(action.status, { "content-type": "application/json" });
      res.end(action.body ?? "");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("нет адреса origin");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        log,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
  });
}


/** Мини-SOCKS5 сервер (no-auth + user/pass, CONNECT, IPv4/domain ATYP). */
function startSocks5Proxy(options: { requireAuth?: { user: string; pass: string } } = {}): Promise<{
  port: number;
  log: Array<{ host: string; port: number; authed: boolean }>;
  close: () => Promise<void>;
}> {
  const log: Array<{ host: string; port: number; authed: boolean }> = [];
  const server = net.createServer((sock) => {
    let stage: "greeting" | "auth" | "request" | "done" = "greeting";
    let authed = false;
    const onData = (data: Buffer): void => {
      try {
        if (stage === "greeting") {
          const methods = [...data.subarray(2)];
          if (options.requireAuth && methods.includes(2)) {
            sock.write(Buffer.from([5, 2]));
            stage = "auth";
            return;
          }
          if (methods.includes(0)) {
            sock.write(Buffer.from([5, 0]));
            stage = "request";
            return;
          }
          sock.write(Buffer.from([5, 0xff]));
          sock.end();
          return;
        }
        if (stage === "auth") {
          const ulen = data[1];
          const user = data.subarray(2, 2 + ulen).toString();
          const plen = data[2 + ulen];
          const pass = data.subarray(3 + ulen, 3 + ulen + plen).toString();
          if (user === options.requireAuth!.user && pass === options.requireAuth!.pass) {
            authed = true;
            sock.write(Buffer.from([1, 0]));
            stage = "request";
          } else {
            sock.write(Buffer.from([1, 1]));
            sock.end();
          }
          return;
        }
        if (stage === "request") {
          const atyp = data[3];
          let host: string;
          let port: number;
          let offset: number;
          if (atyp === 1) {
            host = [...data.subarray(4, 8)].join(".");
            port = data.readUInt16BE(8);
            offset = 10;
          } else if (atyp === 3) {
            const len = data[4];
            host = data.subarray(5, 5 + len).toString();
            port = data.readUInt16BE(5 + len);
            offset = 7 + len;
          } else {
            sock.write(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
            sock.end();
            return;
          }
          log.push({ host, port, authed });
          dns.lookup(host, (err, address) => {
            if (err) {
              sock.write(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
              sock.end();
              return;
            }
            const up = net.connect(port, address, () => {
              const resp = Buffer.alloc(10);
              resp[0] = 5;
              resp[1] = 0;
              resp[3] = 1;
              resp.writeUInt16BE(port, 8);
              sock.write(resp);
              if (data.length > offset) up.write(data.subarray(offset));
              up.pipe(sock);
              sock.pipe(up);
            });
            up.on("error", () => sock.destroy());
          });
          stage = "done";
        }
      } catch {
        sock.destroy();
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("нет адреса socks");
      resolve({
        port: address.port,
        log,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
  });
}

/* ── Сценарий 1: липкость pin + креденшелы доезжают до прокси ─────────── */
{
  const proxyA = await startConnectProxy({ requireAuth: "Basic dXNlcjpwYXNz" }); // user:pass
  const origin = await startOrigin(() => ({ status: 200, body: '{"ok":true}' }));
  const rotator = new ProxyRotator({ random: () => 0 });
  const quarantined: string[] = [];
  const hrefA = "http://user:pass@127.0.0.1:" + proxyA.port + "/";
  const ring = withProxyRing(
    { dispatch: () => true },
    {
      rotator,
      getPoolHrefs: () => [hrefA],
      rotationEnabled: () => true,
      directFallbackEnabled: () => false,
      createBareAgent: (href) => new undici.ProxyAgent(href),
      stackInnerLayers: (bare) => bare,
      onQuarantine: (info) => quarantined.push(info.display),
    },
  );
  try {
    rotator.setPool([hrefA]);
    const res1 = await undici.fetch(`${origin.url}/v1/chat`, {
      method: "POST",
      headers: { authorization: "Bearer nvapi-x", "content-type": "application/json" },
      body: '{"m":1}',
      dispatcher: ring as never,
    });
    assert.equal(res1.status, 200);
    assert.equal(await res1.text(), '{"ok":true}');
    const res2 = await undici.fetch(`${origin.url}/v1/chat`, { dispatcher: ring as never });
    assert.equal(res2.status, 200);
    await res2.text();
    assert.equal(proxyA.log.length, 2, "оба запроса через прокси A");
    assert.equal(proxyA.log[0].auth, "Basic dXNlcjpwYXNz", "креденшелы из href дошли до прокси");
    assert.deepEqual(quarantined, []);
    // Display identity без пароля.
    assert.equal(maskProxy(hrefA), `127.0.0.1:${proxyA.port}`);
    const statuses = rotator.statusFor(Date.now());
    assert.equal(statuses[0].state, "ready");
    assert.ok((statuses[0].lastLatencyMs ?? -1) >= 0, "успех записал exit quality");
  } finally {
    await ring.close();
    await origin.close();
    await proxyA.close();
  }
}

/* ── Сценарий 2: мёртвый CONNECT → карантин → следующий dispatch в соседа ── */
{
  // Прокси A — закрытый порт (CONNECT гарантированно отказан).
  const dead = net.createServer();
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", () => resolve()));
  const deadPort = (dead.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => dead.close(() => resolve()));
  const proxyB = await startConnectProxy();
  const origin = await startOrigin(() => ({ status: 200, body: "ок" }));
  const rotator = new ProxyRotator({ random: () => 0 });
  const hrefDead = `http://127.0.0.1:${deadPort}/`;
  const hrefB = `http://127.0.0.1:${proxyB.port}/`;
  const quarantined: string[] = [];
  const ring = withProxyRing({ dispatch: () => true }, {
    rotator,
    getPoolHrefs: () => [hrefDead, hrefB],
    rotationEnabled: () => true,
    directFallbackEnabled: () => false,
    createBareAgent: (href) => new undici.ProxyAgent(href),
    stackInnerLayers: (bare) => bare,
    onQuarantine: (info) => quarantined.push(info.display),
  });
  try {
    rotator.setPool([hrefDead, hrefB]);
    // Первый dispatch: pin — мёртвый A → ошибка соединения (ECONNREFUSED).
    let caught: unknown;
    try {
      await undici.fetch(`${origin.url}/v1/chat`, { dispatcher: ring as never });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, "fetch отклонён");
    // Кольцо переписывает CONNECT-ошибку в понятную с display identity;
    // fetch ундичи заворачивает её в «fetch failed» с cause.
    const cause = (caught as { cause?: Error }).cause ?? caught;
    const message = cause.message;
    assert.ok(message.includes(`127.0.0.1:${deadPort}`), `сообщение называет выход: ${message}`);
    const code = (cause as NodeJS.ErrnoException).code;
    assert.equal(code, "ECONNREFUSED", `код соединения сохранён, а не ${String(code)}`);
    assert.deepEqual(quarantined, [`127.0.0.1:${deadPort}`], "карантин называет display identity");
    assert.ok(rotator.cooldownLeft(hrefDead, Date.now()) > 0, "кулдаун поставлен");

    // Второй dispatch: ротация включена, B ready → уходим в B.
    const res = await undici.fetch(`${origin.url}/v1/chat`, { dispatcher: ring as never });
    assert.equal(res.status, 200, "запрос дошёл через живой выход");
    await res.text();
    assert.equal(proxyB.log.length, 1, "B принял запрос");
  } finally {
    await ring.close();
    await origin.close();
    await proxyB.close();
  }
}

/* ── Сценарий 3: круг ключей одного dispatch не меняет выход (pin-инвариант) ── */
{
  const proxyA = await startConnectProxy();
  const proxyB = await startConnectProxy();
  const origin = await startOrigin((auth) =>
    auth?.includes("nvapi-key2")
      ? { status: 200, body: '{"ответ":"ок"}' }
      : { status: 429, headers: {}, body: '{"error":"rate"}' },
  );
  const rotator = new ProxyRotator({ random: () => 0 });
  const keyRotator = new KeyRotator({ random: () => 0 });
  const hrefA = `http://127.0.0.1:${proxyA.port}/`;
  const hrefB = `http://127.0.0.1:${proxyB.port}/`;
  const ring = withProxyRing({ dispatch: () => true }, {
    rotator,
    getPoolHrefs: () => [hrefA, hrefB],
    rotationEnabled: () => true,
    directFallbackEnabled: () => false,
    createBareAgent: (href) => new undici.ProxyAgent(href),
    // Внутренний лук: ротация ключей поверх bare-агента (как в бою).
    stackInnerLayers: (bare) =>
      withKeyRotation(bare, {
        rotator: keyRotator,
        getPoolKeys: () => ["nvapi-key2"],
        enabled: () => true,
      }),
  });
  try {
    rotator.setPool([hrefA, hrefB]);
    const res = await undici.fetch(`${origin.url}/v1/chat`, {
      method: "POST",
      headers: { authorization: "Bearer nvapi-key1", "content-type": "application/json" },
      body: '{"model":"m","messages":[]}',
      dispatcher: ring as never,
    });
    assert.equal(res.status, 200, "пи видит успех после смены ключа");
    assert.equal(await res.text(), '{"ответ":"ок"}');
    assert.equal(origin.log.length, 2, "две попытки (429 → 200)");
    assert.deepEqual(
      origin.log.map((e) => e.auth),
      ["Bearer nvapi-key1", "Bearer nvapi-key2"],
      "ключ сменился",
    );
    assert.equal(proxyA.log.length, 2, "обе попытки через прокси A (pin)");
    assert.equal(proxyB.log.length, 0, "прокси B не тронут внутри dispatch");
  } finally {
    await ring.close();
    await origin.close();
    await proxyA.close();
    await proxyB.close();
  }
}

/* ── Сценарий 4: 503 — выход достижим, карантина нет ───────────────────── */
{
  const proxyA = await startConnectProxy();
  const origin = await startOrigin(() => ({ status: 503, body: "шлюз" }));
  const rotator = new ProxyRotator({ random: () => 0 });
  const hrefA = `http://127.0.0.1:${proxyA.port}/`;
  const quarantined: string[] = [];
  const ring = withProxyRing({ dispatch: () => true }, {
    rotator,
    getPoolHrefs: () => [hrefA],
    rotationEnabled: () => true,
    directFallbackEnabled: () => false,
    createBareAgent: (href) => new undici.ProxyAgent(href),
    stackInnerLayers: (bare) => bare,
    onQuarantine: (info) => quarantined.push(info.display),
  });
  try {
    rotator.setPool([hrefA]);
    const res = await undici.fetch(`${origin.url}/v1/chat`, { dispatcher: ring as never });
    assert.equal(res.status, 503);
    await res.text();
    assert.deepEqual(quarantined, [], "5xx — бакет транспорта, прокси не карантинится");
    assert.equal(rotator.cooldownLeft(hrefA, Date.now()), 0);
    assert.ok((rotator.statusFor(Date.now())[0].lastLatencyMs ?? -1) >= 0, "503 — тоже exit quality");
  } finally {
    await ring.close();
    await origin.close();
    await proxyA.close();
  }
}

/* ── Сценарий 5 (тикет 05): socks5-выход — обычный член пула ───────────── */
{
  const socks = await startSocks5Proxy({ requireAuth: { user: "u1", pass: "p1" } });
  const origin = await startOrigin(() => ({ status: 200, body: '{"ok":"socks"}' }));
  const rotator = new ProxyRotator({ random: () => 0 });
  const hrefSocks = `socks5://u1:p1@127.0.0.1:${socks.port}`;
  const quarantined: string[] = [];
  const ring = withProxyRing({ dispatch: () => true }, {
    rotator,
    getPoolHrefs: () => [hrefSocks],
    rotationEnabled: () => true,
    directFallbackEnabled: () => false,
    createBareAgent: (href) => new undici.ProxyAgent(href), // делегирует в Socks5ProxyAgent
    stackInnerLayers: (bare) => bare,
    onQuarantine: (info) => quarantined.push(info.display),
  });
  try {
    rotator.setPool([hrefSocks]);
    const res = await undici.fetch(`${origin.url}/v1/chat`, { dispatcher: ring as never });
    assert.equal(res.status, 200, "запрос дошёл через SOCKS5-туннель");
    assert.equal(await res.text(), '{"ok":"socks"}');
    assert.equal(socks.log.length, 1, "SOCKS CONNECT ровно один");
    assert.equal(socks.log[0].authed, true, "user/pass из href дошли до SOCKS-рукопожатия");
    assert.deepEqual(quarantined, []);
    assert.equal(maskProxy(hrefSocks), `127.0.0.1:${socks.port}`);
    assert.ok((rotator.statusFor(Date.now())[0].lastLatencyMs ?? -1) >= 0, "exit quality записана");
  } finally {
    await ring.close();
    await origin.close();
    await socks.close();
  }
}

/* ── Сценарий 6 (тикет 05): неверный пароль socks — карантин, не unknown ─ */
{
  const socks = await startSocks5Proxy({ requireAuth: { user: "u1", pass: "p1" } });
  const origin = await startOrigin(() => ({ status: 200 }));
  const rotator = new ProxyRotator({ random: () => 0 });
  const bad = `socks5://u1:WRONG@127.0.0.1:${socks.port}`;
  const good = `socks5://u1:p1@127.0.0.1:${socks.port}`;
  const quarantined: string[] = [];
  const ring = withProxyRing({ dispatch: () => true }, {
    rotator,
    getPoolHrefs: () => [bad, good],
    rotationEnabled: () => true,
    directFallbackEnabled: () => false,
    createBareAgent: (href) => new undici.ProxyAgent(href),
    stackInnerLayers: (bare) => bare,
    onQuarantine: (info) => quarantined.push(info.display),
  });
  try {
    rotator.setPool([bad, good]);
    // Первый dispatch — pin на bad (первый в кольце при random 0): auth failed.
    let caught: unknown;
    try {
      await undici.fetch(`${origin.url}/v1/chat`, { dispatcher: ring as never });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, "fetch отклонён");
    assert.ok(
      rotator.cooldownLeft(bad, Date.now()) > 0,
      "UND_ERR_SOCKS5_AUTH_FAILED — CONNECT-класс: карантин поставлен",
    );
    assert.equal(quarantined.length, 1, `карантин уведомляет display identity: ${JSON.stringify(quarantined)}`);
    assert.ok(!quarantined[0].includes("WRONG"), "пароль не в уведомлении");

    // Второй dispatch — good ready: запрос проходит, pin сменился.
    const res = await undici.fetch(`${origin.url}/v1/chat`, { dispatcher: ring as never });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(socks.log.filter((e) => e.authed).length, 1, "успешное рукопожатие одно");
  } finally {
    await ring.close();
    await origin.close();
    await socks.close();
  }
}

console.log("proxy-ring-http: все проверки прошли");
