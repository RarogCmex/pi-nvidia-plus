/**
 * Тесты шва дегенеративного вывода (extensions/degenerate.ts, исследование 06, §4).
 * Юнит-набор повторяет проверенный на живых корпусах эталон: коллапс в content,
 * коллапс в reasoning, период-2, период-3, утечка токена, проза, JSON, короткий
 * ответ, честная нехватка бюджета — плюс различение двух пустых ответов
 * (stop против length) и tool-calls как нормы пустого текста.
 *
 * Модуль чистый (без пи и сети), HOME не нужен.
 * Запуск: node test/degenerate.test.ts
 */
import assert from "node:assert/strict";
import {
  classifyDegenerate,
  findSpecialTokenLeak,
  isDegenerateVerdict,
  isRepetitionCollapse,
  toDegenerateSource,
  type DegenerateSource,
} from "../extensions/degenerate.ts";

function source(partial: Partial<DegenerateSource>): DegenerateSource {
  return { text: "", thinking: "", hasToolCalls: false, stopReason: "stop", ...partial };
}

/* ── 1. Коллапс в content: реальный ответ nemotron (`42` × 2000) ─────────── */
{
  const v = classifyDegenerate(source({ text: "42".repeat(2000), stopReason: "length" }));
  assert.deepEqual(v, { kind: "collapse", where: "text" });
  assert.ok(isDegenerateVerdict(v));
}

/* ── 2. Коллапс в reasoning: реальный ответ kimi (`User!…`, content пуст) ─── */
{
  const v = classifyDegenerate(source({ thinking: "User!".repeat(600), stopReason: "stop" }));
  assert.deepEqual(v, { kind: "collapse", where: "thinking" });
}

/* ── 3. Период-2 ──────────────────────────────────────────────────────────── */
{
  assert.equal(isRepetitionCollapse("ab".repeat(1000)), true);
  assert.deepEqual(classifyDegenerate(source({ text: "ab".repeat(1000) })), { kind: "collapse", where: "text" });
}

/* ── 4. Период-3 (эталонный корпус `abc` × 1500) ──────────────────────────── */
{
  assert.equal(isRepetitionCollapse("abc".repeat(1500)), true);
}

/* ── 5. Односимвольный коллапс короче порога сжимаемости (`The!!!!…`, 30) ─── */
{
  const short = "The" + "!".repeat(27);
  assert.equal(short.length, 30);
  assert.equal(isRepetitionCollapse(short), true, "доля одного символа ловит короткий коллапс");
}

/* ── 6. Утечка special-токена (`<|close|>!!!!!!!!`) ───────────────────────── */
{
  assert.equal(findSpecialTokenLeak("<|close|>!!!!!!!!"), "<|close|>");
  const v = classifyDegenerate(source({ text: "<|close|>!!!!!!!!" }));
  assert.deepEqual(v, { kind: "token-leak", where: "text", token: "<|close|>" });
  // Токен в reasoning тоже ловится.
  const r = classifyDegenerate(source({ text: "нормальный ответ", thinking: "думал <|fim_prefix|> думал" }));
  assert.equal(r.kind, "token-leak");
}

/* ── 7. Связная проза (~250 слов) пропускается ────────────────────────────── */
{
  const prose = [
    "Осенний вечер опускался на город незаметно, и только редкие прохожие, спешившие домой с поднятыми воротниками, напоминали о том, что ночь уже близка.",
    "Ветер гнал по мокрому асфальту жёлтые листья, и они прилипали к подошвам случайных пешеходов, словно пытаясь задержать их на этом последнем тёплом перекрёстке.",
    "В маленькой кофейне на углу горел свет; хозяин, пожилой армянин с седыми усами, неторопливо протирал чашки и поглядывал на улицу сквозь запотевшее стекло.",
    "Каждый вечер в одно и то же время к нему заходил студент-первокурсник, заказывал самый дешёвый эспрессо и садился у окна с толстой книгой по дифференциальным уравнениям.",
    "Хозяин никогда не торопил его и даже не намекал, что кофейня скоро закрывается: он сам когда-то был таким же студентом и помнил, как важна крыша над головой в конце трудного дня.",
    "Город жил своей обычной жизнью — где-то гудели машины, где-то спорили соседи, где-то плакал ребёнок, — и все эти звуки сливались в ровный спокойный гул, который жители давно перестали замечать.",
    "А над крышами, между тяжёлыми облаками, пробивалась тонкая полоска закатного неба, и она была того особенного розового цвета, который бывает только в конце октября.",
    "Студент закрыл книгу, допил остывший кофе и поблагодарил хозяина кивком; тот ответил таким же молчаливым кивком, и в этом коротком обмене было больше тепла, чем в иных долгих разговорах.",
    "Дверь тихонько звякнула, выпустив посетителя в сырую темноту, и кофейня снова осталась наедине со светом лампы, запахом зёрен и шорохом дождя по стеклу.",
    "Завтра всё повторится — и ветер, и листья, и студент со своей книгой, — но именно из таких незаметных повторов и складывается то, что люди называют родным городом.",
  ].join("\n");
  assert.ok(prose.length > 1000);
  assert.equal(isRepetitionCollapse(prose), false, "проза не должна ловиться");
  assert.deepEqual(classifyDegenerate(source({ text: prose })), { kind: "ok" });
}

/* ── 8. Сгенерированный JSON (20 объектов) пропускается ───────────────────── */
{
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    name: `item-${(i * 37) % 101}`,
    tags: [`t${i % 5}`, `x${(i * 7) % 13}`],
    score: Number(((i * 0.618) % 1).toFixed(4)),
    active: i % 3 !== 0,
  }));
  const json = JSON.stringify(rows, null, 2);
  assert.equal(isRepetitionCollapse(json), false, "легитимный JSON выше порога сжимаемости");
  assert.deepEqual(classifyDegenerate(source({ text: json })), { kind: "ok" });
}

/* ── 9. Короткий ответ — норма (пороги длины не дотягиваются) ─────────────── */
{
  assert.equal(isRepetitionCollapse("OK"), false);
  assert.deepEqual(classifyDegenerate(source({ text: "Готово. Файл сохранён." })), { kind: "ok" });
}

/* ── 10. Честная нехватка бюджета: пусто + length ─────────────────────────── */
{
  const v = classifyDegenerate(source({ text: "", stopReason: "length" }));
  assert.deepEqual(v, { kind: "empty-length" });
  assert.equal(isDegenerateVerdict(v), false, "нехватка бюджета — не брак");
}

/* ── 11. Дегенерация reasoning-канала: пусто + stop ───────────────────────── */
{
  const v = classifyDegenerate(source({ text: "", stopReason: "stop" }));
  assert.deepEqual(v, { kind: "empty-stop" });
  assert.ok(isDegenerateVerdict(v));
}

/* ── 12. Пустой текст при tool-calls — норма ──────────────────────────────── */
{
  const v = classifyDegenerate(source({ text: "", hasToolCalls: true, stopReason: "toolUse" }));
  assert.deepEqual(v, { kind: "ok" });
}

/* ── 13. toDegenerateSource: извлечение из блоков пи-формы ────────────────── */
{
  const msg = {
    role: "assistant",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "раз " },
      { type: "text", text: "привет " },
      { type: "thinking", thinking: "два" },
      { type: "text", text: "мир" },
    ],
  };
  const s = toDegenerateSource(msg);
  assert.ok(s);
  assert.equal(s.text, "привет \nмир");
  assert.equal(s.thinking, "раз \nдва");
  assert.equal(s.hasToolCalls, false);
  assert.equal(s.stopReason, "stop");

  const withTool = toDegenerateSource({ role: "assistant", content: [{ type: "toolCall", id: "x" } as never], stopReason: "toolUse" });
  assert.equal(withTool?.hasToolCalls, true);

  assert.equal(toDegenerateSource({ role: "user", content: [] }), undefined, "не-assistant не разбирается");
  assert.equal(toDegenerateSource(undefined), undefined);
  // Мусор в блоках не роняет извлечение.
  const junk = toDegenerateSource({ role: "assistant", content: [null, undefined, { type: "text" }, { type: "text", text: 42 }] as never });
  assert.equal(junk?.text, "");
}

/* ── 14. Порог сжимаемости: наивная «доля топ-биграммы» коллапс НЕ ловит ──── */
{
  // Документируем, почему детектор не построен на n-граммах: на `42` × 2000
  // биграммы делятся поровну между «42» и «24» — доля топ-биграммы ровно 0.50.
  const t = "42".repeat(2000);
  const counts = new Map<string, number>();
  for (let i = 0; i + 2 <= t.length; i++) {
    const g = t.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const total = t.length - 1;
  const topShare = Math.max(...counts.values()) / total;
  assert.ok(Math.abs(topShare - 0.5) < 0.01, `доля топ-биграммы ~0.50, получено ${topShare}`);
  // А zlib-признак тот же текст ловит.
  assert.equal(isRepetitionCollapse(t), true);
}

console.log("degenerate: все проверки прошли");
