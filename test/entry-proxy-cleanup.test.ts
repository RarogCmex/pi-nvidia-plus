/**
 * Интеграция `proxy cleanup-dead` с фейковым пи: команда вызывается как
 * `/nvidia-plus proxy cleanup-dead`, а не отдельной корневой подкомандой.
 *
 * Сценарии (все офлайн, локальные закрытые порты):
 *  1. инлайн-источник (`NVIDIA_NIM_PROXIES`) — отказ: переписывать нечего;
 *  2. файловый пул, все выходы недоступны дважды — отказ «опустошить пул»,
 *     файл не тронут, резерв не создан;
 *  3. неизвестный глагол proxy — в списке есть `cleanup-dead`.
 *
 * Путь «удалить мёртвый, оставить живого» требует живого CONNECT-туннеля к
 * NIM (сеть), поэтому он покрыт чистым швом в test/proxy-pool.test.ts
 * (`planProxyCleanup`), а не этим интеграционным тестом.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-cleanup-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows
process.env.PI_NVIDIA_PLUS_LANG = "en";

// Источник по умолчанию — файл; инлайн задаём только на время сценария 1.
delete process.env.NVIDIA_NIM_PROXIES_FILE;
delete process.env.NVIDIA_NIM_PROXY;

const ext = (await import("../extensions/pi-nvidia-plus.ts")).default;

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
function makeCtx() {
  return {
    hasUI: true,
    model: { provider: "nvidia", id: "nvidia/nemotron-3.5-lightning-30b-a3b" },
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
async function run(args: string): Promise<Array<{ message: string; type?: string }>> {
  const before = notified.length;
  await commands["nvidia-plus"].handler(args, makeCtx() as never);
  return notified.slice(before);
}

ext(fakePi as never);
assert.ok(commands["nvidia-plus"], "команда зарегистрирована");

/* ── 1. Инлайн-источник: чистка невозможна ─────────────────────────────── */
{
  process.env.NVIDIA_NIM_PROXIES = "http://127.0.0.1:1";
  const out = await run("proxy cleanup-dead");
  assert.equal(out.length, 1, "одно уведомление");
  assert.ok(out[0].message.includes("needs a FILE pool source"), out[0].message);
  assert.equal(out[0].type, "error", "отказ — ошибка");
  delete process.env.NVIDIA_NIM_PROXIES;
}

/* ── 2. Файловый пул: все выходы мёртвы — отказ, файл не тронут ────────── */
{
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const poolFile = join(agentDir, "nvidia-proxies.json");
  const before = JSON.stringify({ proxies: ["http://127.0.0.1:1", "http://127.0.0.1:2"] });
  writeFileSync(poolFile, before);
  const out = await run("proxy cleanup-dead");
  assert.equal(out.length, 2, `старт пробы + отказ: ${JSON.stringify(out)}`);
  assert.ok(out[0].message.includes("probing 2 proxy endpoints"), out[0].message);
  assert.ok(out[1].message.includes("would empty the proxy pool"), out[1].message);
  assert.equal(out[1].type, "error", "отказ — ошибка");
  assert.equal(readFileSync(poolFile, "utf8"), before, "файл пула не тронут");
  assert.deepEqual(
    readdirSync(agentDir).filter((f) => f.includes(".bak-")),
    [],
    "резерв не создаётся, если чистка не состоялась",
  );
}

/* ── 3. Неизвестный глагол: в списке есть cleanup-dead ─────────────────── */
{
  const out = await run("proxy bogus");
  assert.ok(out[0].message.includes("unknown argument \u201Cbogus\u201D"), out[0].message);
  assert.ok(out[0].message.includes("cleanup-dead"), out[0].message);
}

rmSync(home, { recursive: true, force: true });
console.log("entry-proxy-cleanup: все проверки прошли");
