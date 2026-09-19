/**
 * Интеграция входной точки с фейковым пи (spec proxy-pool, тикеты 01–03):
 * `/nvidia-plus proxy` — панель настроек (display identity, источник, count,
 * pin, «расширение не пишет файл»), `pin`/`on`/`off`, отказ `check` без
 * nvidia-модели, сводка `check` на недостижимом пуле (pin не меняется),
 * заголовок `status` c pin+count, интро только на nvidia-модели,
 * автодополнение второго/третьего уровня. Креденшелы не покидают шов.
 *
 * Модуль расширения — синглтон: конфигурация задаётся окружением ДО
 * динамического импорта; HOME подменён на временный каталог, реальный
 * ~/.pi не трогается. Сеть — только локальные закрытые порты (ECONNREFUSED).
 * Запуск: node test/entry-proxy.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-entry-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows
process.env.PI_NVIDIA_PLUS_LANG = "en";
process.env.NVIDIA_NIM_PROXIES = "http://user:secret@127.0.0.1:1/,http://127.0.0.1:2/";
delete process.env.NVIDIA_NIM_PROXIES_FILE;
delete process.env.NVIDIA_NIM_PROXY;

const ext = (await import("../extensions/pi-nvidia-plus.ts")).default;

/* ── Фейковый пи ───────────────────────────────────────────────────────── */

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers: Record<string, Handler[]> = {};
interface RegisteredCommand {
  description: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: never) => Promise<void>;
}
const commands: Record<string, RegisteredCommand> = {};
const fakePi = {
  on(event: string, handler: Handler) {
    (handlers[event] ??= []).push(handler);
  },
  registerCommand(name: string, options: RegisteredCommand) {
    commands[name] = options;
  },
};

const notified: Array<{ message: string; type?: string }> = [];
function makeCtx(model: { provider: string; id: string } | undefined) {
  return {
    hasUI: true,
    model,
    thinkingLevel: undefined,
    ui: {
      notify: (message: string, type?: string) => notified.push({ message, type }),
      setStatus: () => {},
      addAutocompleteProvider: () => {},
    },
    modelRegistry: {
      getApiKeyForProvider: async () => undefined,
      getAll: () => [],
      refresh: async () => {},
    },
  };
}
const nvidiaModel = { provider: "nvidia", id: "moonshotai/kimi-k3" };
const otherModel = { provider: "anthropic", id: "claude-x" };

async function run(args: string, ctx: ReturnType<typeof makeCtx>): Promise<Array<{ message: string; type?: string }>> {
  const before = notified.length;
  await commands["nvidia-plus"].handler(args, ctx as never);
  return notified.slice(before);
}

ext(fakePi as never);
assert.ok(commands["nvidia-plus"], "команда зарегистрирована");
assert.ok(handlers["session_start"]?.length, "session_start подписан");

/* ── 1. session_start на nvidia-модели: интро кольца + префлайт pin ────── */
{
  const ctx = makeCtx(nvidiaModel);
  await handlers["session_start"][0]({}, ctx);
  const intro = notified.find((n) => n.message.includes("NIM proxy ring"));
  assert.ok(intro, `интро кольца показано: ${JSON.stringify(notified.map((n) => n.message))}`);
  assert.ok(intro.message.includes("pool NVIDIA_NIM_PROXIES: 2"), intro.message);
  assert.ok(intro.message.includes("pin 127.0.0.1:1"), intro.message);
  // Префлайт бьёт только pin (первый) и падает в ECONNREFUSED — ошибка называет display.
  // Даём фону завершиться.
  await new Promise((r) => setTimeout(r, 300));
  const preflight = notified.find((n) => n.message.includes("unreachable"));
  assert.ok(preflight, "префлайт сообщил о недоступности pin");
  assert.ok(preflight!.message.includes("127.0.0.1:1"), preflight!.message);
  // Креденшелы нигде не светятся.
  for (const n of notified) assert.ok(!n.message.includes("secret"), n.message);
}

/* ── 2. session_start на не-nvidia модели: молчит (тикет 16) ───────────── */
{
  const before = notified.length;
  const ctx = makeCtx(otherModel);
  await handlers["model_select"][0]({ model: otherModel }, ctx);
  const fresh = notified.slice(before);
  assert.equal(
    fresh.some((n) => n.message.toLowerCase().includes("proxy")),
    false,
    `на не-nvidia сессии прокси не упоминается: ${JSON.stringify(fresh)}`,
  );
}

/* ── 3. Панель `/nvidia-plus proxy` (пустые аргументы) ─────────────────── */
{
  const ctx = makeCtx(nvidiaModel);
  const out = await run("proxy", ctx);
  assert.equal(out.length, 1, "одно уведомление");
  const panel = out[0].message;
  assert.ok(panel.includes("proxy ring on"), panel);
  assert.ok(panel.includes("pool NVIDIA_NIM_PROXIES (2)"), panel);
  assert.ok(panel.includes("127.0.0.1:1"), panel);
  assert.ok(panel.includes("127.0.0.1:2"), panel);
  assert.ok(panel.includes("never writes the pool file"), panel);
  assert.ok(!panel.includes("secret"), "креденшелы не в панели");
}

/* ── 4. Неизвестный аргумент — список глаголов, не панель (story 20) ───── */
{
  const ctx = makeCtx(nvidiaModel);
  const out = await run("proxy bogus", ctx);
  assert.ok(out[0].message.includes("unknown argument \u201Cbogus\u201D"), out[0].message);
  assert.ok(out[0].message.includes("check"), out[0].message);
  assert.ok(out[0].message.includes("pin"), out[0].message);
}

/* ── 5. pin: без id — usage+список; неизвестный id — список; известный — ставит ── */
{
  const ctx = makeCtx(nvidiaModel);
  const usage = await run("proxy pin", ctx);
  assert.ok(usage[0].message.includes("proxy pin <host:port>"), usage[0].message);
  assert.ok(usage[0].message.includes("127.0.0.1:1"), usage[0].message);
  assert.ok(usage[0].message.includes("127.0.0.1:2"), usage[0].message);

  const unknown = await run("proxy pin 9.9.9.9:1", ctx);
  assert.ok(unknown[0].message.includes("unknown proxy id \u201C9.9.9.9:1\u201D"), unknown[0].message);

  const ok = await run("proxy pin 127.0.0.1:2", ctx);
  assert.ok(ok[0].message.includes("pin set to 127.0.0.1:2"), ok[0].message);

  // Панель и status отражают новый pin.
  const panel = (await run("proxy", ctx))[0].message;
  assert.ok(panel.includes("pin 127.0.0.1:2"), panel);
  const status = (await run("status", ctx))[0].message;
  assert.ok(status.includes("proxy ring: on"), status);
  assert.ok(status.includes("(2)"), status);
  assert.ok(status.includes("pin 127.0.0.1:2"), `заголовок status называет pin: ${status}`);
  assert.ok(!status.includes("127.0.0.1:1 — "), "полное кольцо — только панель");
}

/* ── 6. on/off: off держит pin (не сбрасывает на первую строку файла) ──── */
{
  const ctx = makeCtx(nvidiaModel);
  const off = await run("proxy off", ctx);
  assert.ok(off[0].message.includes("proxy ring disabled — current pin locked"), off[0].message);
  // pin при выключенном кольце допустим и работает (story 17/54).
  const pin = await run("proxy pin 127.0.0.1:1", ctx);
  assert.ok(pin[0].message.includes("pin set to 127.0.0.1:1"), pin[0].message);
  const panel = (await run("proxy", ctx))[0].message;
  assert.ok(panel.includes("proxy ring off"), panel);
  assert.ok(panel.includes("pin 127.0.0.1:1"), panel);
  const on = await run("proxy on", ctx);
  assert.ok(on[0].message.includes("proxy ring enabled"), on[0].message);
}

/* ── 7. check: отказ без nvidia-модели (story 15) ──────────────────────── */
{
  const ctx = makeCtx(otherModel);
  const out = await run("proxy check", ctx);
  assert.equal(out[0].type, "warning");
  assert.ok(out[0].message.includes("proxy check needs a selected nvidia model"), out[0].message);
}

/* ── 8. check на недостижимом пуле: сводка, ноль ok → pin не меняется ──── */
{
  const ctx = makeCtx(nvidiaModel);
  await run("proxy pin 127.0.0.1:2", ctx); // фиксируем pin до прогона
  const out = await run("proxy check", ctx);
  const start = out.find((n) => n.message.includes("probing 2 proxy endpoints"));
  assert.ok(start, `стартовое уведомление с count: ${JSON.stringify(out.map((n) => n.message))}`);
  const summary = out.find((n) => n.message.includes("proxy check in"));
  assert.ok(summary, `сводка: ${JSON.stringify(out.map((n) => n.message))}`);
  assert.ok(summary!.message.includes("ok: 0"), summary!.message);
  assert.ok(summary!.message.includes("unreachable: 2"), summary!.message);
  assert.ok(summary!.message.includes("no reachable endpoint — pin unchanged (127.0.0.1:2)"), summary!.message);
  assert.equal(summary!.type, "warning", "ноль ok — warning");
  assert.ok(!out.some((n) => n.message.includes("secret")), "креденшелы не в сводке");

  // Исходы проб стали состоянием: панель показывает cooldown обоих выходов.
  const panel = (await run("proxy", ctx))[0].message;
  assert.ok(panel.includes("cooldown"), `карантин после check виден в панели: ${panel}`);
}

/* ── 9. Автодополнение: второй уровень и третий (id пула) ──────────────── */
{
  const completions = commands["nvidia-plus"].getArgumentCompletions!;
  const root = completions("") as Array<{ value: string; label: string }>;
  assert.deepEqual(
    root.map((i) => i.value),
    ["apply ", "rollback ", "status ", "keys ", "proxy ", "discover "],
  );
  assert.equal(root.find((i) => i.value === "proxy ")?.label, "proxy [check|pin|on|off]");

  const second = completions("proxy ") as Array<{ value: string }>;
  assert.deepEqual(second.map((i) => i.value), ["proxy check", "proxy pin ", "proxy on", "proxy off"]);

  const third = completions("proxy pin ") as Array<{ value: string; label: string; description: string }>;
  assert.deepEqual(third.map((i) => i.value), ["proxy pin 127.0.0.1:1", "proxy pin 127.0.0.1:2"]);
  assert.deepEqual(third.map((i) => i.label), ["127.0.0.1:1", "127.0.0.1:2"]);
  assert.ok(third[0].description.length > 0, "состояние выхода в описании");

  const filtered = completions("proxy pin 127.0.0.1:2") as Array<{ value: string }>;
  assert.deepEqual(filtered.map((i) => i.value), ["proxy pin 127.0.0.1:2"]);
}

rmSync(home, { recursive: true, force: true });
console.log("entry-proxy: все проверки прошли");
