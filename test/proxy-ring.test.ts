/**
 * Тесты диспетчерного шва кольца прокси (`.scratch/proxy-pool/spec.md`,
 * «Dispatcher / pin invariant»): пул из двух href — два агента, один dispatch
 * липнет к одному; прозрачные ретраи и круг ключей одного dispatch не меняют
 * выход; CONNECT-ошибка карантинит и следующий pick идёт в соседа; 429/5xx
 * прокси не трогают; выбывший href закрывает агент; пустой пул — прежний
 * глобальный диспетчер; `getNvidiaDirectDispatcher` — агент текущего pin.
 * Цели и хендлеры — фейки (без ундичи и сети).
 * Запуск: node test/proxy-ring.test.ts
 */
import assert from "node:assert/strict";
import {
  ensureDispatcherInstalled,
  getNvidiaDirectDispatcher,
  getProxyEndpointAgent,
  withKeyRotation,
  withProxyRing,
  type DispatchTarget,
} from "../extensions/proxy.ts";
import { ProxyRotator, PROXY_QUARANTINE_MS } from "../extensions/proxy-pool.ts";
import { KeyRotator } from "../extensions/keys.ts";

/* ── Фейки протокола ундичи (как в rotation.test.ts) ───────────────────── */

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

function makeReceiver() {
  const rec = {
    status: undefined as number | undefined,
    chunks: [] as Uint8Array[],
    ended: false,
    error: undefined as unknown,
  };
  const handler = {
    rec,
    onRequestStart() {},
    onResponseStart(_c: unknown, status: number) {
      rec.status = status;
    },
    onResponseData(_c: unknown, chunk: Uint8Array) {
      rec.chunks.push(chunk);
    },
    onResponseEnd() {
      rec.ended = true;
    },
    onResponseError(_c: unknown, err: unknown) {
      rec.error = err;
    },
  };
  return handler;
}

type Responder = (href: string, attempt: number) => { status: number; body?: string } | { error: unknown };

interface AttemptLog {
  attempts: Array<{ href: string; opts: Record<string, unknown> }>;
}

/** Цель-диспетчер одного «агента»: помнит свой href и пишет попытки в общий журнал. */
function makeAgentTarget(href: string, respond: Responder, state: AttemptLog) {
  const target = {
    href,
    destroyed: 0,
    closed: 0,
    dispatch(opts: unknown, handler: unknown): boolean {
      state.attempts.push({ href, opts: opts as Record<string, unknown> });
      const h = handler as Record<string, (...args: unknown[]) => void>;
      const controller = makeController();
      const attempt = state.attempts.filter((a) => a.href === href).length;
      setTimeout(() => {
        h.onRequestStart?.(controller);
        const response = respond(href, attempt);
        if ("error" in response) {
          h.onResponseError?.(controller, response.error);
          return;
        }
        h.onResponseStart?.(controller, response.status, {}, "");
        if (response.body !== undefined) h.onResponseData?.(controller, Buffer.from(response.body));
        h.onResponseEnd?.(controller, {});
      }, 1);
      return true;
    },
    close() {
      target.closed += 1;
      return Promise.resolve();
    },
    destroy() {
      target.destroyed += 1;
      return Promise.resolve();
    },
  };
  return target;
}

function flush(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type AgentTarget = ReturnType<typeof makeAgentTarget>;

interface RingHarness {
  rotator: ProxyRotator;
  ring: DispatchTarget;
  agents: Map<string, AgentTarget>;
  attempts: Array<{ href: string; opts: Record<string, unknown> }>;
  switches: Array<{ from?: string; to: string }>;
  quarantined: string[];
  directFallbackCalls: Array<{ allowed: boolean }>;
  base: { calls: number };
  setPool(hrefs: string[]): void;
}

function makeRing(opts: {
  respond: Responder;
  rotationEnabled?: boolean;
  directFallback?: boolean;
  stack?: (bare: DispatchTarget) => DispatchTarget;
  createAgent?: (href: string) => DispatchTarget | undefined;
  now?: () => number;
}): RingHarness {
  const rotator = new ProxyRotator({ random: () => 0, quarantineMs: PROXY_QUARANTINE_MS });
  const agents = new Map<string, AgentTarget>();
  const attempts: Array<{ href: string; opts: Record<string, unknown> }> = [];
  const state: AttemptLog = { attempts };
  const harness: RingHarness = {
    rotator,
    ring: undefined as unknown as DispatchTarget,
    agents,
    attempts,
    switches: [],
    quarantined: [],
    directFallbackCalls: [],
    base: { calls: 0 },
    setPool(hrefs: string[]) {
      pool = hrefs;
      rotator.setPool(hrefs);
    },
  };
  let pool: string[] = [];
  const baseTarget: DispatchTarget = {
    dispatch() {
      harness.base.calls += 1;
      return true;
    },
  };
  harness.ring = withProxyRing(baseTarget,
    {
      rotator,
      getPoolHrefs: () => pool,
      rotationEnabled: () => opts.rotationEnabled ?? true,
      directFallbackEnabled: () => opts.directFallback ?? false,
      createBareAgent: (href) => {
        const custom = opts.createAgent?.(href);
        if (custom) {
          agents.set(href, custom as unknown as AgentTarget);
          return custom;
        }
        const agent = makeAgentTarget(href, opts.respond, state);
        agents.set(href, agent);
        return agent;
      },
      stackInnerLayers: opts.stack ?? ((bare) => bare),
      closeAgent: (_href, agent) => {
        void (agent as AgentTarget).destroy();
      },
      onPinSwitch: (info) => harness.switches.push(info),
      onQuarantine: (info) => harness.quarantined.push(info.display),
      onDirectFallback: (allowed) => harness.directFallbackCalls.push({ allowed }),
      now: opts.now,
    },
  );
  return harness;
}

/* ── 1. Пул из двух: pick один на dispatch, агент создаётся один раз ───── */
{
  const h = makeRing({ respond: () => ({ status: 200, body: "ок" }) });
  h.setPool(["http://a:1/", "http://b:2/"]);
  const r1 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com", body: "{}" }, r1);
  await flush();
  assert.equal(r1.rec.status, 200);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].href, "http://a:1/", "первый вход кольца (random 0)");

  // Повторный dispatch — тот же pin, новый агент не создан.
  const r2 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com", body: "{}" }, r2);
  await flush();
  assert.equal(h.attempts.length, 2);
  assert.equal(h.attempts[1].href, "http://a:1/", "pin липкий между dispatch");
  assert.equal(h.agents.size, 1, "агент b не создавался, агент a переиспользован");
  assert.equal(h.switches.length, 0, "pin не менялся — счётчик молчит");
}

/* ── 2. CONNECT-ошибка: карантин, сообщение с display identity, следующий pick — сосед;
 *      429/5xx/in-band прокси не трогают ──────────────────────────────── */
{
  const h = makeRing({
    respond: (href) =>
      href === "http://u:p@a:1/"
        ? { error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }
        : { status: 200, body: "ок" },
  });
  h.setPool(["http://u:p@a:1/", "http://b:2/"]);
  const r1 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com", body: "{}" }, r1);
  await flush();
  assert.ok(r1.rec.error instanceof Error, "ошибка дошла до пи");
  const msg = (r1.rec.error as Error).message;
  assert.ok(msg.includes("a:1"), `сообщение называет display identity: ${msg}`);
  assert.ok(!msg.includes("u:p"), "userinfo не утёк");
  assert.equal((r1.rec.error as NodeJS.ErrnoException).code, "ECONNREFUSED", "код сохранён");
  assert.deepEqual(h.quarantined, ["a:1"]);
  assert.ok(h.rotator.cooldownLeft("http://u:p@a:1/", Date.now()) > 0, "карантин поставлен");

  // Следующий dispatch (ротация включена) — готовый сосед.
  const r2 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com", body: "{}" }, r2);
  await flush();
  assert.equal(r2.rec.status, 200);
  assert.equal(h.attempts[h.attempts.length - 1].href, "http://b:2/");
  assert.deepEqual(h.switches.map((s) => s.to), ["b:2"], "смена pin — метрика (display identity)");
}

// 2b. 429/5xx НЕ карантинят прокси и не меняют pin.
{
  const h = makeRing({ respond: () => ({ status: 503, body: "шлюз" }) });
  h.setPool(["http://a:1/", "http://b:2/"]);
  const r3 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com", body: "{}" }, r3);
  await flush();
  assert.equal(r3.rec.status, 503);
  assert.deepEqual(h.quarantined, [], "5xx — бакет транспорта, не прокси");
  assert.equal(h.rotator.cooldownLeft("http://a:1/", Date.now()), 0);
  const r4 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com", body: "{}" }, r4);
  await flush();
  assert.equal(h.attempts[1].href, "http://a:1/", "5xx не меняет pin");
  assert.deepEqual(h.switches, []);

  // 429 — бакет ключа: прокси тоже не трогается.
  const h2 = makeRing({ respond: () => ({ status: 429, body: '{"error":"rate"}' }) });
  h2.setPool(["http://a:1/", "http://b:2/"]);
  const r5 = makeReceiver();
  h2.ring.dispatch({ origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer k" }, body: "{}" }, r5);
  await flush();
  assert.deepEqual(h2.quarantined, [], "429 — бакет ключа, не прокси");
  assert.deepEqual(h2.switches, []);
}

/* ── 3. Успешный ответ: markOk снимает карантин и пишет латентность ────── */
{
  const h = makeRing({ respond: () => ({ status: 200 }) });
  h.setPool(["http://a:1/"]);
  h.rotator.markConnectFailed("http://a:1/", Date.now() - 1_000);
  const r = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com", body: "{}" }, r);
  await flush();
  assert.equal(h.rotator.cooldownLeft("http://a:1/", Date.now()), 0, "доставленный ответ гасит карантин");
  const status = h.rotator.statusFor(Date.now());
  assert.ok((status[0].lastLatencyMs ?? -1) >= 0, "латентность записана");
}

/* ── 4. Внутренний круг ключей одного dispatch не меняет выход ─────────── */
{
  // stack: bare → ротация ключей (429 на ключе пи → ключ b), всё на ОДНОМ href.
  const keyRotator = new KeyRotator({ random: () => 0 });
  const h = makeRing({
    respond: (_href, attempt) => (attempt === 1 ? { status: 429, body: '{"error":"rate"}' } : { status: 200, body: "ок" }),
    stack: (bare) =>
      withKeyRotation(bare, {
        rotator: keyRotator,
        getPoolKeys: () => ["nvapi-b"],
        enabled: () => true,
      }),
  });
  h.setPool(["http://a:1/", "http://b:2/"]);
  const r = makeReceiver();
  h.ring.dispatch(
    { origin: "https://integrate.api.nvidia.com", headers: { authorization: "Bearer nvapi-pi" }, body: '{"model":"m"}' },
    r,
  );
  await flush(60);
  assert.equal(r.rec.status, 200, "пи видит успех после смены ключа");
  assert.equal(h.attempts.length, 2, "две попытки (429 → 200)");
  assert.deepEqual(
    h.attempts.map((a) => a.href),
    ["http://a:1/", "http://a:1/"],
    "обе попытки — один выход (pin-инвариант)",
  );
  const auths = h.attempts.map((a) => (a.opts.headers as Record<string, string>).authorization);
  assert.deepEqual(auths, ["Bearer nvapi-pi", "Bearer nvapi-b"], "ключ сменился внутри того же агента");
  assert.equal(h.agents.size, 1, "второй прокси-агент не создавался");
}

/* ── 5. Выбывший из пула href закрывает агент ──────────────────────────── */
{
  const h = makeRing({ respond: () => ({ status: 200 }) });
  h.setPool(["http://a:1/", "http://b:2/"]);
  const r1 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, r1);
  await flush();
  const agentA = h.agents.get("http://a:1/");
  assert.ok(agentA);
  h.setPool(["http://b:2/"]); // a выбыл
  const r2 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, r2);
  await flush();
  assert.ok(agentA.destroyed >= 1 || agentA.closed >= 1, "агент выбывшего закрыт");
  assert.equal(h.attempts[h.attempts.length - 1].href, "http://b:2/", "pin упал на оставшийся");
}

/* ── 6. Пустой пул: без флага — понятная ошибка (origin IP не светим);
 *      с флагом — прежний глобальный диспетчер (story 35/36) ────────────── */
{
  const h = makeRing({ respond: () => ({ status: 200 }) });
  h.setPool([]);
  const r = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, r);
  await flush();
  assert.equal(h.base.calls, 0, "без флага direct запрещён");
  assert.equal(h.attempts.length, 0);
  assert.ok(r.rec.error instanceof Error, "запрос остановлен понятной ошибкой");
  assert.ok((r.rec.error as Error).message.includes("NVIDIA_NIM_PROXY_FALLBACK_DIRECT"), (r.rec.error as Error).message);
  assert.deepEqual(h.directFallbackCalls, [{ allowed: false }]);

  const h2 = makeRing({ respond: () => ({ status: 200 }), directFallback: true });
  h2.setPool([]);
  const r2 = makeReceiver();
  h2.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, r2);
  await flush();
  assert.equal(h2.base.calls, 1, "с флагом запрос ушёл прежнему глобальному диспетчеру");
  assert.deepEqual(h2.directFallbackCalls, [{ allowed: true }]);
}

/* ── 7. Выключенная ротация: pin держится, сосед не подбирается ────────── */
{
  const h = makeRing({
    respond: (href) =>
      href === "http://a:1/"
        ? { error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }
        : { status: 200 },
    rotationEnabled: false,
  });
  h.setPool(["http://a:1/", "http://b:2/"]);
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, makeReceiver());
  await flush();
  // rot off: карантин не влияет на выбор — снова a (off = lock this exit).
  const r2 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, r2);
  await flush();
  assert.equal(h.attempts[1].href, "http://a:1/", "off держит pin даже в карантине");
}

/* ── 7b. createBareAgent бросает (старый ундичи без Socks5ProxyAgent):
 *      понятная ошибка, карантин, следующий dispatch — другой выход ──────── */
{
  const h = makeRing({
    respond: () => ({ status: 200 }),
    createAgent: (href) => {
      if (href.startsWith("socks5:")) throw new Error("pi-nvidia-plus: SOCKS5 not supported by this undici");
      return undefined; // дефолтный фейк-агент
    },
  });
  h.setPool(["socks5://u:p@a:1080/", "http://b:2/"]);
  const r1 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, r1);
  await flush();
  assert.ok(r1.rec.error instanceof Error, "ошибка дошла до пи, dispatch не упал синхронно");
  assert.ok((r1.rec.error as Error).message.includes("SOCKS5"), (r1.rec.error as Error).message);
  assert.deepEqual(h.quarantined, ["a:1080"], "негодный выход карантинится");
  const r2 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, r2);
  await flush();
  assert.equal(r2.rec.status, 200, "следующий dispatch ушёл в рабочий выход");
  assert.equal(h.attempts[h.attempts.length - 1].href, "http://b:2/");
}

/* ── 7b. createBareAgent бросает (старый ундичи без Socks5ProxyAgent):
 *      понятная ошибка, карантин, следующий dispatch — другой выход ──────── */
{
  const h = makeRing({
    respond: () => ({ status: 200, body: "ок" }),
    createAgent: (href) => {
      // Имитация ундичи < 8 на socks-href.
      if (href.startsWith("socks5:")) throw new Error("SOCKS5 not supported by this undici");
      return undefined; // http-href — штатный фейк-агент
    },
  });
  h.setPool(["socks5://u:p@a:1080", "http://b:2/"]);
  const r1 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, r1);
  await flush();
  assert.ok(r1.rec.error instanceof Error, "ошибка дошла до хендлера, dispatch не упал синхронно");
  assert.ok((r1.rec.error as Error).message.includes("SOCKS5"), (r1.rec.error as Error).message);
  assert.deepEqual(h.quarantined, ["a:1080"], "негодный socks-выход карантинится");
  assert.ok(h.rotator.cooldownLeft("socks5://u:p@a:1080", Date.now()) > 0);
  // Следующий dispatch: socks в карантине, ротация берёт http-выход.
  const r2 = makeReceiver();
  h.ring.dispatch({ origin: "https://integrate.api.nvidia.com" }, r2);
  await flush();
  assert.equal(r2.rec.status, 200, "рабочий выход обслуживает запрос");
  assert.equal(h.attempts[h.attempts.length - 1].href, "http://b:2/");
}

/* ── 8. ensureDispatcherInstalled с пулом: ленивые агенты, pin-агент для keys check ─ */
{
  const prevGlobal = { calls: 0, dispatch() { prevGlobal.calls += 1; return true; } };
  let current: unknown = prevGlobal;
  const created: string[] = [];
  const rotator = new ProxyRotator({ random: () => 0 });
  const pool = ["http://a:1/", "http://b:2/"];
  rotator.setPool(pool);
  const result = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => {
        current = d;
      },
      createProxyAgent: (url: URL) => {
        created.push(url.toString());
        return { dispatch: () => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() };
      },
    },
    {
      proxyPool: {
        rotator,
        getPoolHrefs: () => pool,
        rotationEnabled: () => true,
        directFallbackEnabled: () => false,
      },
    },
  );
  assert.equal(result.installed, true, "пул ставит обёртку");
  assert.equal(created.length, 0, "агенты создаются лениво (не все сразу на входе)");

  // getNvidiaDirectDispatcher — агент текущего pin (эффективный pin = первый).
  const pinAgent = getNvidiaDirectDispatcher();
  assert.ok(pinAgent, "pin-агент создан по запросу");
  assert.equal(created[0], "http://a:1/", "создан агент эффективного pin");
  assert.strictEqual(getProxyEndpointAgent("http://a:1/"), pinAgent, "тот же объект (keep-alive)");
  assert.strictEqual(getNvidiaDirectDispatcher(), pinAgent, "повторный запрос не создаёт второй пул");

  // Pin переставлен — direct dispatcher следует за pin (агент b создаётся).
  rotator.pin("http://b:2/");
  const bAgent = getNvidiaDirectDispatcher();
  assert.notStrictEqual(bAgent, pinAgent);
  assert.equal(created.includes("http://b:2/"), true);

  // Повторная установка идемпотентна.
  const again = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => {
        current = d;
      },
      createProxyAgent: () => {
        throw new Error("не должен создаваться");
      },
    },
    { proxyPool: { rotator, getPoolHrefs: () => pool, rotationEnabled: () => true, directFallbackEnabled: () => false } },
  );
  assert.equal(again.already, true);
}

/* ── 9. Регрессия: легаси-одиночка (proxyUrl) — как сегодня, без пула ──── */
{
  const prevGlobal = { calls: 0, dispatch() { prevGlobal.calls += 1; return true; } };
  let current: unknown = prevGlobal;
  const proxyAgent = { dispatch: () => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() };
  const result = ensureDispatcherInstalled(
    {
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (d) => {
        current = d;
      },
      createProxyAgent: () => proxyAgent,
    },
    { proxyUrl: new URL("http://legacy:8870/") },
  );
  assert.equal(result.installed, true);
  assert.strictEqual(result.nvidiaDirect, proxyAgent, "nvidiaDirect — единственный ProxyAgent (как сегодня)");
  assert.strictEqual(getNvidiaDirectDispatcher(), proxyAgent, "keys check идёт через тот же keep-alive агент");
}

console.log("proxy-ring: все проверки прошли");
