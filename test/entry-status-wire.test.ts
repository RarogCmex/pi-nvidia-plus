/**
 * Интеграция входной точки: статус-строка и `/nvidia-plus status` показывают
 * РЕАЛЬНО уходящий в NIM thinking-параметр, а не только план хука (пункт 6
 * исследования 06, §5.4). Проверяет нативный путь пи на kimi-подобной модели:
 * `wirePlanFor` обязан вытащить `compat.supportsReasoningEffort` + `thinkingLevelMap`
 * из объекта модели и показать `reasoning_effort="none"` на уровне `off`.
 *
 * Модуль расширения — синглтон: HOME подменён до импорта; прокси/ключи не заданы.
 * Запуск: node test/entry-status-wire.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-wire-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows
process.env.PI_NVIDIA_PLUS_LANG = "en";
delete process.env.NVIDIA_NIM_PROXIES;
delete process.env.NVIDIA_NIM_PROXIES_FILE;
delete process.env.NVIDIA_NIM_PROXY;
delete process.env.NVIDIA_NIM_KEYS;
delete process.env.NVIDIA_NIM_KEYS_FILE;

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

const statuses: Array<string | undefined> = [];
const notified: string[] = [];

// Модель в форме, какую pi кладёт в ctx.model: reasoning + compat + thinkingLevelMap
// из применённого оверрайда (kimi-k3 после фикса off→"none").
const kimiModel = {
  provider: "nvidia",
  id: "moonshotai/kimi-k3",
  reasoning: true,
  compat: { supportsReasoningEffort: true },
  thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};

function makeCtx(model: unknown, thinkingLevel: string | undefined) {
  return {
    hasUI: true,
    model,
    thinkingLevel,
    ui: {
      notify: (message: string) => notified.push(message),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      addAutocompleteProvider: () => {},
    },
    modelRegistry: {
      getApiKeyForProvider: async () => undefined,
      getAll: () => [],
      refresh: async () => {},
    },
  };
}

async function fire(event: string, payload: unknown, ctx: unknown): Promise<void> {
  for (const handler of handlers[event] ?? []) await handler(payload, ctx);
}

ext(fakePi as never);
assert.ok(handlers["model_select"]?.length, "model_select подписан");

/* ── 1. Статус-строка на native-модели показывает reasoning_effort (off → none) ── */
{
  statuses.length = 0;
  await fire("model_select", { model: kimiModel }, makeCtx(kimiModel, "off"));
  const line = statuses[statuses.length - 1];
  assert.ok(line, "статус-строка установлена");
  assert.ok(line!.includes("thinking off"), `показан запрошенный уровень: ${line}`);
  assert.ok(line!.includes('reasoning_effort="none"'), `показан реальный wire для off: ${line}`);
  assert.ok(!line!.includes("no injection"), `native-путь не должен выглядеть как «нет инжекта»: ${line}`);
}

/* ── 2. Смена уровня обновляет wire-значение (low → low) ─────────────────── */
{
  statuses.length = 0;
  await fire("thinking_level_select", {}, makeCtx(kimiModel, "low"));
  const line = statuses[statuses.length - 1];
  assert.ok(line!.includes('reasoning_effort="low"'), `wire для low: ${line}`);
}

/* ── 3. `/nvidia-plus status` тоже показывает wire-значение ──────────────── */
{
  notified.length = 0;
  await commands["nvidia-plus"].handler("status", makeCtx(kimiModel, "off") as never);
  const text = notified.join("\n");
  assert.ok(text.includes('reasoning_effort="none"'), `status показывает wire: ${text}`);
}

/* ── 4. Семейство хука (nemotron) показывает план хука, не reasoning_effort ── */
{
  const nemotron = { provider: "nvidia", id: "nvidia/nemotron-3-super-120b-a12b", reasoning: true };
  statuses.length = 0;
  await fire("model_select", { model: nemotron }, makeCtx(nemotron, "off"));
  const line = statuses[statuses.length - 1];
  assert.ok(line!.includes("chat_template_kwargs.enable_thinking=false"), `план хука для nemotron: ${line}`);
}

/* ── 5. Модель без supportsReasoningEffort и вне хука — «нет инжекта» ─────── */
{
  const plain = { provider: "nvidia", id: "meta/llama-3.3-70b-instruct", reasoning: true };
  statuses.length = 0;
  await fire("model_select", { model: plain }, makeCtx(plain, "high"));
  const line = statuses[statuses.length - 1];
  assert.ok(line!.includes("no injection"), `без нативного пути и хука — нет инжекта: ${line}`);
}

rmSync(home, { recursive: true, force: true });
console.log("entry-status-wire: все проверки прошли");
