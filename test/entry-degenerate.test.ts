/**
 * Интеграция входной точки с фейковым пи: дегенеративный вывод при HTTP 200
 * (исследование 06, §3–4). Проверяет: `message_end` на nvidia-модели ловит
 * коллапс, утечку токена и пустой ответ при `stop`; даёт одно дросселированное
 * уведомление на модель в минуту; различает пустой `stop` (повторить) и пустой
 * `length` (поднять max_tokens); на не-nvidia модели, нормальном тексте и
 * tool-calls молчит; счётчик виден в `/nvidia-plus status`.
 *
 * Модуль расширения — синглтон: HOME подменён на временный каталог до
 * динамического импорта; конфигурация прокси/ключей не задаётся.
 * Запуск: node test/entry-degenerate.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-degen-"));
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
const kimi = { provider: "nvidia", id: "moonshotai/kimi-k3" };
const nemotron = { provider: "nvidia", id: "nvidia/nemotron-3-super-120b-a12b" };
const otherModel = { provider: "anthropic", id: "claude-x" };

function assistant(content: unknown[], stopReason = "stop") {
  return { type: "message_end", message: { role: "assistant", stopReason, content } };
}
const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking", thinking: t });

async function fire(event: string, payload: unknown, ctx: unknown): Promise<Array<{ message: string; type?: string }>> {
  const before = notified.length;
  for (const handler of handlers[event] ?? []) await handler(payload, ctx);
  return notified.slice(before);
}

ext(fakePi as never);
assert.ok(handlers["message_end"]?.length, "message_end подписан");

/* ── 1. Нормальный ответ: молчит ───────────────────────────────────────── */
{
  const out = await fire("message_end", assistant([text("Вот ваш ответ: 42 файла обработаны.")]), makeCtx(kimi));
  assert.equal(out.length, 0, `норма не уведомляет: ${JSON.stringify(out)}`);
}

/* ── 2. Коллапс в content: предупреждение ──────────────────────────────── */
{
  const out = await fire("message_end", assistant([text("42".repeat(2000))], "length"), makeCtx(nemotron));
  assert.equal(out.length, 1, `одно уведомление: ${JSON.stringify(out)}`);
  assert.equal(out[0].type, "warning");
  assert.ok(out[0].message.includes(nemotron.id), out[0].message);
  assert.ok(out[0].message.includes("max_tokens will not help"), out[0].message);
}

/* ── 3. Дроссель: повтор той же модели в том же окне молчит, счётчик растёт ─ */
{
  const out = await fire("message_end", assistant([text("!".repeat(3000))], "stop"), makeCtx(nemotron));
  assert.equal(out.length, 0, `дроссель не пускает второе уведомление: ${JSON.stringify(out)}`);
}

/* ── 4. Утечка special-токена (kimi, tool_choice) ──────────────────────── */
{
  const out = await fire("message_end", assistant([text("<|close|>!!!!!!!!")]), makeCtx(kimi));
  assert.equal(out.length, 1, `одно уведомление: ${JSON.stringify(out)}`);
  assert.equal(out[0].type, "warning");
  assert.ok(out[0].message.includes("<|close|>"), out[0].message);
}

/* ── 5. Пустой ответ при stop: дегенерация, «повторите» (kimi, другой дроссель-ключ — уже был шаг 4… окно то же) */
{
  const out = await fire("message_end", assistant([], "stop"), makeCtx(kimi));
  assert.equal(out.length, 0, "kimi в дроссельном окне — уведомление подавлено");
}
{
  // Другая модель — своё дроссельное окно.
  const luna = { provider: "nvidia", id: "nvidia/llama-3.3-nemotron-super-49b-v1.5" };
  const out = await fire("message_end", assistant([], "stop"), makeCtx(luna));
  assert.equal(out.length, 1, `одно уведомление: ${JSON.stringify(out)}`);
  assert.equal(out[0].type, "warning");
  assert.ok(out[0].message.includes("finish_reason: stop"), out[0].message);
  assert.ok(out[0].message.includes("Repeat the request"), out[0].message);
}

/* ── 6. Пустой ответ при length: подсказка про бюджет, тип info ────────── */
{
  // Рассуждение связное (не коллапс), видимый текст пустой, finish_reason: length
  // — бюджет честно съеден мыслями.
  const deep = { provider: "nvidia", id: "deepseek-ai/deepseek-v4-pro" };
  const out = await fire(
    "message_end",
    assistant([thinking("Сначала проверю границы ввода, затем пройду по списку и сверю итоги.")], "length"),
    makeCtx(deep),
  );
  assert.equal(out.length, 1, `одно уведомление: ${JSON.stringify(out)}`);
  assert.equal(out[0].type, "info");
  assert.ok(out[0].message.includes("Raise max_tokens"), out[0].message);
}

/* ── 7. Коллапс в reasoning при пустом content ─────────────────────────── */
{
  const ultra = { provider: "nvidia", id: "nvidia/nemotron-3-ultra-550b-a55b" };
  const out = await fire("message_end", assistant([thinking("User!".repeat(600))], "stop"), makeCtx(ultra));
  assert.equal(out.length, 1, `одно уведомление: ${JSON.stringify(out)}`);
  assert.equal(out[0].type, "warning");
  assert.ok(out[0].message.includes("reasoning channel"), out[0].message);
}

/* ── 8. Tool-calls без текста: молчит ──────────────────────────────────── */
{
  const out = await fire(
    "message_end",
    assistant([{ type: "toolCall", id: "c1", name: "read", arguments: {} }], "toolUse"),
    makeCtx({ provider: "nvidia", id: "nvidia/other-model" }),
  );
  assert.equal(out.length, 0, `tool-calls — норма: ${JSON.stringify(out)}`);
}

/* ── 9. Не-nvidia модель: молчит ───────────────────────────────────────── */
{
  const out = await fire("message_end", assistant([text("42".repeat(2000))], "length"), makeCtx(otherModel));
  assert.equal(out.length, 0, `на не-nvidia модели молчит: ${JSON.stringify(out)}`);
}

/* ── 10. Обрыв потока по-прежнему уходит в stream-errors, не в детектор ── */
{
  const out = await fire(
    "message_end",
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "Stream ended without finish_reason", content: [] },
    },
    makeCtx({ provider: "nvidia", id: "nvidia/trunc-model" }),
  );
  assert.equal(out.length, 1);
  assert.ok(out[0].message.includes("without finish_reason"), out[0].message);
}

/* ── 11. Счётчик виден в `/nvidia-plus status` ─────────────────────────── */
{
  const before = notified.length;
  await commands["nvidia-plus"].handler("status", makeCtx(nemotron) as never);
  const status = notified.slice(before).map((n) => n.message).join("\n");
  // Дегенеративных: коллапс nemotron (шаг 2), подавленный дросселем коллапс
  // (шаг 3 — уведомление suppressed, счётчик растёт), kimi утечка (шаг 4),
  // подавленный kimi empty-stop (шаг 5), luna empty-stop (5b), deep
  // empty-length (шаг 6), ultra коллапс reasoning (шаг 7) = 7 вердиктов;
  // обрыв (шаг 10) в этот счётчик не входит.
  assert.ok(status.includes("degenerate responses: 7"), `сводка содержит счётчик: ${status}`);
  assert.ok(status.includes("truncated streams: 1"), `обрыв учтён отдельно: ${status}`);
}

rmSync(home, { recursive: true, force: true });
console.log("entry-degenerate: все проверки прошли");
