/**
 * Интеграция входной точки с фейковым пи: обработка оборванного потока
 * («Stream ended without finish_reason», наблюдалось на nemotron-3-ultra).
 * Проверяет: `message_end` на nvidia-модели даёт одно дросселированное
 * предупреждение и счётчик в `/nvidia-plus status`; на не-nvidia модели и
 * на не-обрывных ошибках молчит.
 *
 * Модуль расширения — синглтон: HOME подменён на временный каталог до
 * динамического импорта; конфигурация прокси/ключей не задаётся.
 * Запуск: node test/entry-stream-truncated.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-trunc-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows
process.env.PI_NVIDIA_PLUS_LANG = "en";
delete process.env.NVIDIA_NIM_PROXIES;
delete process.env.NVIDIA_NIM_PROXIES_FILE;
delete process.env.NVIDIA_NIM_PROXY;
delete process.env.NVIDIA_NIM_KEYS;
delete process.env.NVIDIA_NIM_KEYS_FILE;

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
const nvidiaModel = { provider: "nvidia", id: "nvidia/nemotron-3-ultra-550b-a55b" };
const otherModel = { provider: "anthropic", id: "claude-x" };

function truncatedMessage(errorMessage = "Stream ended without finish_reason") {
  return {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage, content: [] },
  };
}

async function fire(event: string, payload: unknown, ctx: unknown): Promise<Array<{ message: string; type?: string }>> {
  const before = notified.length;
  for (const handler of handlers[event] ?? []) await handler(payload, ctx);
  return notified.slice(before);
}

ext(fakePi as never);
assert.ok(handlers["message_end"]?.length, "message_end подписан");

/* ── 1. Обрыв потока на nvidia-модели: предупреждение ─────────────────── */
{
  const out = await fire("message_end", truncatedMessage(), makeCtx(nvidiaModel));
  assert.equal(out.length, 1, `одно уведомление: ${JSON.stringify(out)}`);
  assert.equal(out[0].type, "warning");
  assert.ok(out[0].message.includes("without finish_reason"), out[0].message);
  assert.ok(out[0].message.includes(nvidiaModel.id), out[0].message);
}

/* ── 2. Дроссель: повтор в том же окне молчит ─────────────────────────── */
{
  const out = await fire("message_end", truncatedMessage(), makeCtx(nvidiaModel));
  assert.equal(out.length, 0, `дроссель не пускает второе уведомление: ${JSON.stringify(out)}`);
}

/* ── 3. Не-nvidia модель: молчит ──────────────────────────────────────── */
{
  const out = await fire("message_end", truncatedMessage(), makeCtx(otherModel));
  assert.equal(out.length, 0, `на не-nvidia модели молчит: ${JSON.stringify(out)}`);
}

/* ── 4. Не-обрывная ошибка: молчит ────────────────────────────────────── */
{
  const out = await fire(
    "message_end",
    truncatedMessage("Service temporarily overloaded"),
    makeCtx({ provider: "nvidia", id: "nvidia/other-model" }),
  );
  assert.equal(out.length, 0, `перегрузка — не обрыв потока: ${JSON.stringify(out)}`);
}

/* ── 5. Счётчик виден в `/nvidia-plus status` ─────────────────────────── */
{
  const before = notified.length;
  await commands["nvidia-plus"].handler("status", makeCtx(nvidiaModel) as never);
  const status = notified.slice(before).map((n) => n.message).join("\n");
  assert.ok(status.includes("truncated streams: 2"), `сводка содержит счётчик: ${status}`);
}

rmSync(home, { recursive: true, force: true });
console.log("entry-stream-truncated: все проверки прошли");
