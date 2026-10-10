/**
 * Тесты шва приёмки выходов (`extensions/proxy-intake.ts`): нормализация формы
 * `host:port:user:pass`, канонизация записи пула, разбор списка кандидатов,
 * строгий вердикт по серии проб (hang / slow / hijack), план приёмки
 * (дубли, уже-в-пуле, конфликт display), слияние и вычёркивание.
 * Строго офлайн: шов не ходит в сеть и не трогает файловую систему, поэтому
 * здесь нет ни сокетов, ни временных каталогов.
 * Все фикстуры синтетические (RFC 5737 / example.*), креденшелы — фейковые, и
 * отдельная проверка утверждает, что они не покидают шов в отчётных строках.
 * Запуск: node test/proxy-intake.test.ts
 */
import assert from "node:assert/strict";
import {
  bodyMatchesExpectation,
  canonicalProxyEntry,
  combineVerdicts,
  mergeAccepted,
  normalizeProxyEntry,
  parseCandidateList,
  planIntake,
  pruneByDisplay,
  samplePassed,
  strictVerdict,
  targetAcceptsStatus,
  type IntakeCandidate,
  type IntakeSample,
  type IntakeVerdictResult,
} from "../extensions/proxy-intake.ts";

const PASS = "s3cr3tPASS";
const fourField = `203.0.113.10:3128:pooluser:${PASS}`;
const httpUrl = `http://pooluser:${PASS}@203.0.113.10:3128`;

/* ------------------------------------------------------------------ */
/* Нормализация формы host:port:user:pass                              */
/* ------------------------------------------------------------------ */

{
  const made = normalizeProxyEntry(fourField);
  assert.equal(made.normalized, true);
  assert.equal(made.url, `http://pooluser:${encodeURIComponent(PASS)}@203.0.113.10:3128`);

  // --swap-auth: порядок user:pass в дампах не гарантирован.
  const swapped = normalizeProxyEntry(fourField, { swapAuth: true });
  assert.equal(swapped.url, `http://${PASS}:pooluser@203.0.113.10:3128`);

  // Готовый URL не трогается (иначе `//` приняли бы за четвёртое поле).
  const asIs = normalizeProxyEntry(httpUrl);
  assert.equal(asIs.normalized, false);
  assert.equal(asIs.url, httpUrl);

  // `host:port` — две поля, не наша форма: parseProxyEndpoint сам добавит http://.
  const bare = normalizeProxyEntry("203.0.113.11:8080");
  assert.equal(bare.normalized, false);
  assert.equal(bare.url, "203.0.113.11:8080");

  // Второе поле не числовое — не форма `host:port:user:pass`.
  const notOurs = normalizeProxyEntry("203.0.113.12:port:user:pass");
  assert.equal(notOurs.normalized, false);

  // Пробелы по краям съедаются.
  assert.equal(normalizeProxyEntry(`  ${fourField}  `).url, normalizeProxyEntry(fourField).url);
}

/* ------------------------------------------------------------------ */
/* Каноническая форма записи                                           */
/* ------------------------------------------------------------------ */

{
  // Дефолтный порт схемы и хвостовой `/` от URL.toString() убираются.
  const withDefaults = canonicalProxyEntry(`http://pooluser:${PASS}@p.exit.example:80`);
  assert.equal(withDefaults.error, undefined);
  assert.equal(withDefaults.url, `http://pooluser:${PASS}@p.exit.example`);
  assert.equal(withDefaults.display, "p.exit.example");

  // socks5h нормализуется в socks5 (нативный клиент всегда отдаёт hostname прокси).
  const socks5h = canonicalProxyEntry(`socks5h://pooluser:${PASS}@203.0.113.13:1080`);
  assert.ok(socks5h.url?.startsWith("socks5://"));
  assert.equal(socks5h.display, "203.0.113.13:1080");

  // Неподдерживаемая схема — ошибка, но display остаётся без кредов.
  const socks4 = canonicalProxyEntry(`socks4://pooluser:${PASS}@203.0.113.14:1080`);
  assert.ok(socks4.error);
  assert.equal(socks4.display, "203.0.113.14:1080");
  assert.equal(String(socks4.error).includes(PASS), false);

  // Мусор на входе: ошибка есть, креды не наружу.
  const garbage = canonicalProxyEntry(`http://pooluser:${PASS}@`);
  assert.ok(garbage.error);
  assert.equal(JSON.stringify(garbage).includes(PASS), false);
}

/* ------------------------------------------------------------------ */
/* Разбор списка кандидатов                                            */
/* ------------------------------------------------------------------ */

{
  const fromObject = parseCandidateList(`{"proxies":["${httpUrl}","socks5://u:p@203.0.113.15:1080"]}`);
  assert.equal(fromObject.error, undefined);
  assert.deepEqual(fromObject.entries, [httpUrl, "socks5://u:p@203.0.113.15:1080"]);

  const fromArray = parseCandidateList(`["${httpUrl}"]`);
  assert.deepEqual(fromArray.entries, [httpUrl]);

  const fromLines = parseCandidateList(`# комментарий\n${httpUrl}\n\n  socks5://u:p@203.0.113.16:1080  \n`);
  assert.deepEqual(fromLines.entries, [httpUrl, "socks5://u:p@203.0.113.16:1080"]);

  assert.ok(parseCandidateList("{ не json").error);
  assert.ok(parseCandidateList('{"proxies":"строка вместо массива"}').error);
  assert.ok(parseCandidateList('{"proxies":[123]}').error);
  assert.deepEqual(parseCandidateList('{"proxies":[]}').entries, []);
  assert.equal(parseCandidateList('{"proxies":[]}').error, undefined);
}

/* ------------------------------------------------------------------ */
/* Строгий вердикт по серии проб                                       */
/* ------------------------------------------------------------------ */

const sample = (round: number, ms: number, extra: Partial<IntakeSample> = {}): IntakeSample => ({
  round,
  ms,
  status: 401,
  bodyOk: true,
  contentType: "application/json",
  ...extra,
});
const criteria = { rounds: 3, slowMs: 12_000, timeoutMs: 20_000 };

{
  const allOk = strictVerdict([sample(1, 600), sample(2, 150), sample(3, 160)], criteria);
  assert.equal(allOk.verdict, "ok");
  assert.equal(allOk.passed, 3);
  assert.deepEqual(allOk.latencies, [600, 150, 160]);
  assert.equal(samplePassed(sample(1, 600)), true);

  // Один срыв из трёх — это hang: ретраи тормоз не маскируют.
  const oneHang = strictVerdict([sample(1, 600), sample(2, 20_001, { status: undefined, bodyOk: undefined, error: "timeout" }), sample(3, 150)], criteria);
  assert.equal(oneHang.verdict, "hang");
  assert.equal(oneHang.passed, 2);
  assert.match(oneHang.reason, /2\/3 probes answered within 20000ms/);

  // Серию прервали (образцов меньше, чем раундов) — тоже hang, а не unknown.
  const short = strictVerdict([sample(1, 600)], criteria);
  assert.equal(short.verdict, "hang");
  assert.equal(short.passed, 1);

  // Все раунды медленнее порога — slow.
  const slow = strictVerdict([sample(1, 13_000), sample(2, 14_000), sample(3, 12_500)], criteria);
  assert.equal(slow.verdict, "slow");
  assert.match(slow.reason, /all 3 probes slower than 12000ms/);

  // Единичный всплеск не бракует выход: NIM сам бывает вязким.
  const oneSpike = strictVerdict([sample(1, 19_000), sample(2, 150), sample(3, 160)], criteria);
  assert.equal(oneSpike.verdict, "ok");

  // HTTP пришёл, но тело не то — стена авторизации прокси (407), а не сервис.
  const hijack = strictVerdict([sample(1, 300, { status: 407, bodyOk: false, contentType: "text/html" })], criteria);
  assert.equal(hijack.verdict, "hijack");
  assert.equal(hijack.passed, 0);
  assert.match(hijack.reason, /HTTP 407 body is not the expected payload/);
  assert.match(hijack.reason, /text\/html/);

  // Пустая серия — hang (нечем подтвердить жизнь).
  assert.equal(strictVerdict([], criteria).verdict, "hang");
}

/* ------------------------------------------------------------------ */
/* Несколько провайдеров: ожидание тела и сводный вердикт                 */
/* ------------------------------------------------------------------ */

{
  assert.equal(bodyMatchesExpectation('{"data":[]}', "json"), true);
  assert.equal(bodyMatchesExpectation("[1,2]", "json"), true);
  assert.equal(bodyMatchesExpectation("<html>407 Proxy Authentication Required</html>", "json"), false);
  assert.equal(bodyMatchesExpectation("", "json"), false);
  // `any` — достаточно того, что HTTP-ответ вообще пришёл.
  assert.equal(bodyMatchesExpectation("<html>ok</html>", "any"), true);
  assert.equal(bodyMatchesExpectation("", "any"), true);

  // Ожидание статусов: 401 — «сервис ответил», 404 — URL цели устарел.
  assert.equal(targetAcceptsStatus({ okStatuses: [401, 403] }, 401), true);
  assert.equal(targetAcceptsStatus({ okStatuses: [401, 403] }, 404), false);
  // Без списка засчитывается любой статус (поведение штатного `proxy check`).
  assert.equal(targetAcceptsStatus({}, 404), true);

  // Тело подходящее, статус нет — это mismatch, а не hijack.
  const stale = strictVerdict([sample(1, 300, { status: 404, statusOk: false })], criteria);
  assert.equal(stale.verdict, "mismatch");
  assert.match(stale.reason, /not an expected status for this target/);
  assert.equal(stale.passed, 0);
  assert.equal(samplePassed(sample(1, 300, { statusOk: false })), false);
}

{
  const ok: IntakeVerdictResult = { verdict: "ok", reason: "3/3 probes ok", passed: 3, latencies: [100, 100, 100] };
  const hang: IntakeVerdictResult = { verdict: "hang", reason: "0/3 probes answered", passed: 0, latencies: [] };

  // Обязательный провайдер решает; провал дополнительного — только справка.
  const withNote = combineVerdicts({ nvidia: ok, openrouter: hang }, "nvidia");
  assert.equal(withNote.verdict, "ok");
  assert.equal(withNote.notes.length, 1);
  assert.match(withNote.notes[0], /^openrouter: hang/);

  // Провал обязательного бракует выход, даже если остальные прошли.
  const requiredFailed = combineVerdicts({ nvidia: hang, openrouter: ok }, "nvidia");
  assert.equal(requiredFailed.verdict, "hang");
  assert.deepEqual(requiredFailed.notes, []);

  // Обязательный вообще не мерили — вердикта нет.
  assert.equal(combineVerdicts({ openrouter: ok }, "nvidia").verdict, "unknown");
}

/* ------------------------------------------------------------------ */
/* План приёмки                                                        */
/* ------------------------------------------------------------------ */

{
  const pool = [
    "http://pooluser:otherPASS@203.0.113.20:8080", // canonical, останется как есть
    `http://pooluser:${PASS}@203.0.113.21:80`, // → канон без :80
    "socks4://u:p@203.0.113.22:1080", // не разбирается → poolDropped
    "http://pooluser:otherPASS@203.0.113.20:8080", // дубль → poolDropped
  ];
  const candidates = [
    "http://newuser:newPASS@203.0.113.30:9000", // новый → в пробу
    "http://pooluser:otherPASS@203.0.113.20:8080", // тот же выход → уже в пуле
    "http://another:newPASS@203.0.113.21:80", // тот же display, другие креды → конфликт
    "http://newuser:newPASS@203.0.113.30:9000", // дубль внутри списка
    "socks4://u:p@203.0.113.31:1080", // не разбирается
    fourField, // нормализуется из host:port:user:pass
  ];
  const plan = planIntake({ pool, candidates });

  // Пул канонизирован: :80 ушёл, дубль и socks4 вычеркнуты.
  assert.deepEqual(plan.canonicalPool, [
    "http://pooluser:otherPASS@203.0.113.20:8080",
    `http://pooluser:${PASS}@203.0.113.21`,
  ]);
  assert.equal(plan.poolDropped.length, 2);
  const droppedByDisplay = new Map(plan.poolDropped.map((d) => [d.display, d.reason]));
  assert.ok(droppedByDisplay.get("203.0.113.22:1080")); // socks4 не разбирается
  assert.match(droppedByDisplay.get("203.0.113.20:8080") ?? "", /duplicate host:port/);
  assert.equal(plan.poolCanonicalized.find((c) => c.display === "203.0.113.21")?.changed, true);
  assert.equal(plan.poolCanonicalized.find((c) => c.display === "203.0.113.20:8080")?.changed, false);

  // В пробу: новый, конфликтный и нормализованный. Display — канонический:
  // дефолтный порт схемы в него не входит (URL.host), как и в maskProxy расширения.
  assert.deepEqual(
    plan.toProbe.map((c) => c.display).sort(),
    ["203.0.113.10:3128", "203.0.113.21", "203.0.113.30:9000"].sort(),
  );
  assert.equal(plan.toProbe.find((c) => c.display === "203.0.113.10:3128")?.normalized, true);
  assert.equal(plan.toProbe.find((c) => c.display === "203.0.113.21")?.displayConflict, true);
  assert.equal(plan.toProbe.find((c) => c.display === "203.0.113.30:9000")?.displayConflict, false);

  // Уже в пуле: точное совпадение (sameCreds) и конфликт (не sameCreds).
  assert.deepEqual(plan.alreadyInPool.find((a) => a.display === "203.0.113.20:8080"), { display: "203.0.113.20:8080", sameCreds: true });
  assert.deepEqual(plan.alreadyInPool.find((a) => a.display === "203.0.113.21"), { display: "203.0.113.21", sameCreds: false });

  assert.deepEqual(plan.duplicatesInList, ["203.0.113.30:9000"]);
  assert.deepEqual(plan.invalid.map((i) => i.display), ["203.0.113.31:1080"]);

  // Креды не покидают шов: sourceMasked и весь план — только маски.
  const serialized = JSON.stringify(maskPlanForTest(plan));
  assert.equal(serialized.includes(PASS), false);
  assert.equal(serialized.includes("newPASS"), false);
  assert.equal(serialized.includes("otherPASS"), false);
}

/**
 * Отчётная проекция плана — то, что ops-скрипт кладёт в JSON-отчёт: только
 * display-маски, без url с кредами. Держим здесь, чтобы тест утверждал именно
 * отсутствие утечки в отчёте, а не в самих данных плана (в `canonicalPool`
 * креденшелы обязаны оставаться — это содержимое пул-файла).
 */
function maskPlanForTest(plan: ReturnType<typeof planIntake>) {
  return {
    toProbe: plan.toProbe.map((c) => ({ display: c.display, normalized: c.normalized, displayConflict: c.displayConflict, sourceMasked: c.sourceMasked })),
    alreadyInPool: plan.alreadyInPool,
    duplicatesInList: plan.duplicatesInList,
    invalid: plan.invalid,
    poolCanonicalized: plan.poolCanonicalized,
    poolDropped: plan.poolDropped,
  };
}

/* ------------------------------------------------------------------ */
/* Слияние принятых и вычёркивание                                     */
/* ------------------------------------------------------------------ */

{
  const canonicalPool = ["http://pooluser:otherPASS@203.0.113.20:8080"];
  const fresh: IntakeCandidate = {
    url: "http://newuser:newPASS@203.0.113.30:9000",
    display: "203.0.113.30:9000",
    normalized: false,
    displayConflict: false,
    sourceMasked: "http://@203.0.113.30:9000",
  };
  const conflicting: IntakeCandidate = { ...fresh, url: "http://another:newPASS@203.0.113.20:8080", display: "203.0.113.20:8080", displayConflict: true };

  const added = mergeAccepted({ canonicalPool, accepted: [fresh] });
  assert.deepEqual(added.added, ["203.0.113.30:9000"]);
  assert.equal(added.entries.length, 2);

  // Конфликт display без явного флага — отказ, пул не испорчен.
  const refused = mergeAccepted({ canonicalPool, accepted: [conflicting] });
  assert.deepEqual(refused.added, []);
  assert.equal(refused.refused.length, 1);
  assert.match(refused.refused[0].reason, /--replace-display/);
  assert.deepEqual(refused.entries, canonicalPool);

  // С флагом — замена кредов того же host:port, размер пула не растёт.
  const replaced = mergeAccepted({ canonicalPool, accepted: [conflicting], replaceConflicting: true });
  assert.equal(replaced.replaced.length, 1);
  assert.equal(replaced.entries.length, 1);
  assert.equal(replaced.entries[0], conflicting.url);

  // Тот же выход повторно — ни добавления, ни отказа.
  const noop = mergeAccepted({ canonicalPool, accepted: [{ ...fresh, url: canonicalPool[0], display: "203.0.113.20:8080" }] });
  assert.deepEqual(noop.added, []);
  assert.deepEqual(noop.refused, []);
  assert.equal(noop.entries.length, 1);

  // Нечего принимать — пул возвращается как есть.
  assert.deepEqual(mergeAccepted({ canonicalPool, accepted: [] }).entries, canonicalPool);
}

{
  const canonicalPool = ["http://u:p@203.0.113.40:1080", "socks5://u:p@203.0.113.41:1080"];
  const pruned = pruneByDisplay({ canonicalPool, drop: ["203.0.113.40:1080", "203.0.113.99:1"] });
  assert.deepEqual(pruned.dropped, ["203.0.113.40:1080"]);
  assert.deepEqual(pruned.unknown, ["203.0.113.99:1"]);
  assert.deepEqual(pruned.entries, ["socks5://u:p@203.0.113.41:1080"]);

  // Защита от полной зачистки: пустой пул результатом не бывает.
  const wipe = pruneByDisplay({ canonicalPool, drop: ["203.0.113.40:1080", "203.0.113.41:1080"] });
  assert.equal(wipe.refused, "pruning would empty the pool");
  assert.deepEqual(wipe.entries, canonicalPool);
  assert.deepEqual(wipe.dropped, []);

  // Пустой пул и нечего терять — не «отказ», а пустой результат.
  assert.deepEqual(pruneByDisplay({ canonicalPool: [], drop: ["203.0.113.40:1080"] }).entries, []);
}

console.log("proxy-intake: все проверки прошли");
