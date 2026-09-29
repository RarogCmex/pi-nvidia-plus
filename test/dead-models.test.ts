/**
 * Значения `DEAD_MODELS` — это не внутренние метки, а текст, который видит
 * пользователь: они подставляются в `{reason}` трёх уведомлений (`i18n.ts`:
 * `deadOnSelect`, `deadObservedMarked`, `respDeadNote`). Тест страхует, что в
 * таблицу не вернутся внутренние идентификаторы и дневниковые подробности.
 *
 * Модуль расширения — синглтон, поэтому HOME подменён до импорта и сеть не
 * трогается (сам список мёртвых моделей — данные, они ничем не отвечают).
 * Запуск: node test/dead-models.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-dead-"));
process.env.HOME = home;

const { DEAD_MODELS } = await import("../extensions/pi-nvidia-plus.ts");

// ── Внутренние идентификаторы не должны доезжать до пользователя ────────────
//
// Каждый шаблон снабжён заведомо грязной строкой: ниже проверяется, что он на
// ней срабатывает. Без этого список легко превращается в украшение — и тут так
// чуть не вышло дважды:
//   1. шаблон «audit» сначала ловил легальную дату в «catalog audit 2026-08-26»,
//      то есть отличал правильный текст от неправильного наоборот;
//   2. `\bтикет` и `\bлог` не матчили ничего и никогда: `\b` в JS — граница
//      между `\w` и не-`\w`, а `\w` это `[A-Za-z0-9_]` даже с флагом `u`, так
//      что кириллица для `\b` — не-словесный символ и границы перед ней нет.
const INTERNAL: [RegExp, string][] = [
  [/\bticket\b/i, "re-check ticket 08"],
  [/тикет/i, "см. тикет 15"],
  [/\bStory\s+\d+/i, "Story 23"],
  // Номер внутреннего отчёта, но НЕ дата: `\d{1,3}\b` не матчит «2026-08-26»,
  // потому что после «202»/«20»/«2» нет границы слова.
  [/\baudit\s+\d{1,3}\b/i, "404 in all probes (audit 02)"],
  [/лог\s+[0-9a-f]{6,}/i, "обрыв потока (лог 01a0ceb8)"],
  [/\bre-check\b/i, "404 in all probes (re-check)"],
  [/\.scratch\b/i, "см. .scratch/issues/08.md"],
];

for (const [re, dirty] of INTERNAL) {
  assert.equal(
    re.test(dirty),
    true,
    `шаблон ${re} не ловит «${dirty}» — защита вырождена, чините шаблон`,
  );
}
// И обратная сторона: легальная дата не должна считаться внутренним номером.
for (const [re] of INTERNAL) {
  assert.equal(
    re.test("404 in every probe (catalog audit 2026-08-26)"),
    false,
    `шаблон ${re} ловит легальную дату — он слишком широкий`,
  );
}

for (const [id, reason] of Object.entries(DEAD_MODELS)) {
  assert.equal(typeof reason, "string", `${id}: причина должна быть строкой`);
  assert.ok(reason.trim().length > 0, `${id}: пустая причина`);
  for (const [re] of INTERNAL) {
    assert.equal(
      re.test(reason),
      false,
      `${id}: причина «${reason}» содержит внутренний идентификатор (${re})`,
    );
  }
  // Вложенные скобки в коротком уведомлении читаются как обрыв текста.
  assert.equal(
    /\([^()]*\(/.test(reason),
    false,
    `${id}: вложенные скобки в «${reason}»`,
  );
  // Уведомление — одна строка; перевод строки сломает вёрстку TUI.
  assert.equal(
    /[\r\n]/.test(reason),
    false,
    `${id}: перевод строки в «${reason}»`,
  );
}

// ── Словарь причин закрыт: новое значение должно быть осознанным ────────────
// Каждая причина — либо 410 (надёжный признак EOL), либо 404 (по пробам, поэтому
// с датой), либо явное объявление вендора. Дата обязательна там, где признак
// получен пробой: 404 бывает транзитным, и читателю нужно знать, когда мерили.
const ALLOWED = [
  /^410 EOL$/,
  /^410 EOL \(probed \d{4}-\d{2}-\d{2}\)$/,
  /^410 EOL \(catalog audit \d{4}-\d{2}-\d{2}\)$/,
  /^404 in every probe$/,
  /^404 in every probe \(catalog audit \d{4}-\d{2}-\d{2}\)$/,
  /^404 on probe \d{4}-\d{2}-\d{2} \(answered before that\)$/,
  /^end of life after \d{4}-\d{2}-\d{2}, announced by NVIDIA \(chat probes hung on \d{4}-\d{2}-\d{2}\)$/,
];

const offenders = Object.entries(DEAD_MODELS).filter(
  ([, reason]) => !ALLOWED.some((re) => re.test(reason)),
);
assert.deepEqual(
  offenders.map(([id, reason]) => `${id}: ${reason}`),
  [],
  "причина вне словаря — добавьте её в ALLOWED осознанно, а не молча",
);

// ── Таблица не пуста и не выродилась ────────────────────────────────────────
const reasons = Object.values(DEAD_MODELS);
assert.ok(reasons.length >= 30, `ожидался десятки мёртвых id, получено ${reasons.length}`);
assert.ok(
  reasons.some((r) => r.startsWith("410")),
  "нет ни одной 410 — признак EOL должен присутствовать",
);
assert.ok(
  reasons.some((r) => r.startsWith("404")),
  "нет ни одной 404 — аудит по пробам должен присутствовать",
);

rmSync(home, { recursive: true, force: true });
console.log("dead-models: все проверки прошли");
