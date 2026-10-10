/**
 * Приёмка выходов в пул — чистый шов (без pi, без сети, без файловой системы).
 *
 * Зачем отдельный модуль: правила «что считать рабочим выходом» и «в какой форме
 * выход хранится в пуле» проверяются офлайн-тестом (`test/proxy-intake.test.ts`),
 * а сеть и файлы остаются на стороне ops-скрипта `scripts/proxy-pool-audit.mjs`.
 * Шов получает РЕЗУЛЬТАТЫ проб и выносит вердикт; сам он ничего не запрашивает.
 *
 * Правила приёмки (свидетельства — research/ и Wiki-разбор 2026-10-10):
 *   1. выход обязан пройти ВСЕ раунды серии: ретрай внутри раунда запрещён,
 *      потому что он маскирует тормоз, а один удачный ответ из трёх
 *      стабильностью не является;
 *   2. «тормоз» — только если ВСЕ раунды медленнее порога: NIM сам бывает
 *      вязким, единичный всплеск не бракует выход;
 *   3. ответ обязан быть JSON-ом NIM: HTTP-статус без JSON — это стена
 *      авторизации прокси (407) или вендорская заглушка, а не NIM;
 *   4. в пуле лежит каноническая форма, и `host:port` обязан быть уникальным.
 *      Пункт 4 — не косметика: ротатор хранит состояние по href, но pin и
 *      разделяемый файл карантина работают через display identity
 *      (`hrefForDisplay` возвращает ПЕРВЫЙ href с таким display, кулдауны
 *      пишутся по display). Два выхода с одинаковым `host:port` и разными
 *      кредами неразличимы для pin/карантина/панели, поэтому второй не
 *      добавляется молча — он попадает в `displayConflicts` и требует явного
 *      решения заменить первый.
 */
import { maskProxy, parseProxyEndpoint, redactProxyCredentials } from "./proxy-pool.ts";

/* ------------------------------------------------------------------ */
/* Проба и вердикт                                                     */
/* ------------------------------------------------------------------ */

/** Один раунд пробы. `status` + `bodyOk` — ответ получен; `error` — срыв. */
export interface IntakeSample {
  round: number;
  ms: number;
  status?: number;
  /** Тело соответствует ожиданию цели (для NIM — JSON каталога). */
  bodyOk?: boolean;
  /** Статус входит в список ожидаемых для цели (см. `targetAcceptsStatus`). */
  statusOk?: boolean;
  contentType?: string;
  error?: string;
}

/**
 * Что считать «сервис ответил». `json` — тело обязано быть JSON-объектом
 * (так работает keyless-проба каталога: 401/403 с JSON означают, что туннель
 * дошёл до API, а не до вендорской заглушки прокси). `any` — достаточно любого
 * HTTP-ответа (для целей, которые на keyless-запрос отдают HTML).
 */
export type BodyExpectation = "json" | "any";

/**
 * Цель пробы: провайдер и его keyless-эндпоинт. Данные — на стороне вызывающего
 * (`PROBE_TARGETS` в `scripts/proxy-pool-audit.mjs`), шов только применяет их.
 */
export interface ProbeTarget {
  id: string;
  label: string;
  url: string;
  expectation: BodyExpectation;
  /**
   * Статусы, которыми цель отвечает на keyless-запрос (401/403 — «сервис
   * ответил, туннель жив»). Без списка засчитывается любой статус — как в
   * штатном `proxy check`, где провайдера нет вовсе и важен сам факт ответа.
   */
  okStatuses?: number[];
}

/** Подходит ли статус под ожидание цели. 404 при живом туннеле — устаревший URL, а не выход. */
export function targetAcceptsStatus(target: Pick<ProbeTarget, "okStatuses">, status: number): boolean {
  return target.okStatuses ? target.okStatuses.includes(status) : true;
}

/** Соответствует ли тело ожиданию цели. Чистая функция — тестируется офлайн. */
export function bodyMatchesExpectation(body: string, expectation: BodyExpectation): boolean {
  if (expectation === "any") return true;
  try {
    const parsed = JSON.parse(body);
    return !!parsed && typeof parsed === "object";
  } catch {
    return false;
  }
}

export type IntakeVerdict = "ok" | "hang" | "slow" | "hijack" | "mismatch" | "unknown";

export interface IntakeVerdictResult {
  verdict: IntakeVerdict;
  /** Машинная строка (как `reason` конфликтов в merge-models.ts) — не i18n. */
  reason: string;
  /** Сколько раундов ответили JSON-ом NIM. */
  passed: number;
  /** Задержки успешных раундов, мс. */
  latencies: number[];
}

/** Раунд засчитан: есть HTTP-статус, тело и статус соответствуют ожиданию цели. */
export function samplePassed(sample: IntakeSample): boolean {
  return sample.status !== undefined && sample.bodyOk === true && sample.statusOk !== false;
}

/**
 * Вердикт по серии проб. `samples` короче `rounds` — это тоже срыв
 * (серию прервали), поэтому недобор трактуется как hang, а не как unknown.
 */
export function strictVerdict(
  samples: readonly IntakeSample[],
  options: { rounds: number; slowMs: number; timeoutMs?: number },
): IntakeVerdictResult {
  const rounds = Math.max(1, options.rounds);
  const passedSamples = samples.filter(samplePassed);
  const latencies = passedSamples.map((s) => s.ms);
  const timeoutMs = options.timeoutMs;
  const within = timeoutMs ? `${timeoutMs}ms` : "the timeout";

  const hijacked = samples.find((s) => s.status !== undefined && s.bodyOk === false);
  if (hijacked) {
    return {
      verdict: "hijack",
      reason: `HTTP ${hijacked.status} body is not the expected payload (content-type ${hijacked.contentType ?? "?"}) — proxy auth wall or vendor interstitial`,
      passed: passedSamples.length,
      latencies,
    };
  }
  // Тело то, а статус нет: обычно значит, что URL цели устарел (404/405),
  // а не что выход плохой — поэтому отдельный вердикт, а не hijack.
  const mismatched = samples.find((s) => s.status !== undefined && s.statusOk === false);
  if (mismatched) {
    return {
      verdict: "mismatch",
      reason: `HTTP ${mismatched.status} is not an expected status for this target — stale probe URL?`,
      passed: passedSamples.length,
      latencies,
    };
  }
  if (samples.length < rounds || passedSamples.length !== samples.length || passedSamples.length !== rounds) {
    const shape = samples.map((s) => (samplePassed(s) ? `${s.ms}` : "T/O")).join("/");
    return {
      verdict: "hang",
      reason: `${passedSamples.length}/${rounds} probes answered within ${within} [${shape}]`,
      passed: passedSamples.length,
      latencies,
    };
  }
  if (latencies.length > 0 && latencies.every((ms) => ms > options.slowMs)) {
    return {
      verdict: "slow",
      reason: `all ${rounds} probes slower than ${options.slowMs}ms [${latencies.join("/")}]`,
      passed: passedSamples.length,
      latencies,
    };
  }
  return {
    verdict: "ok",
    reason: `${rounds}/${rounds} probes ok, max ${Math.max(...latencies, 0)}ms [${latencies.join("/")}]`,
    passed: passedSamples.length,
    latencies,
  };
}

/* ------------------------------------------------------------------ */
/* Вердикт по нескольким провайдерам                                    */
/* ------------------------------------------------------------------ */

export interface CombinedVerdict {
  /** Вердикт ОБЯЗАТЕЛЬНОГО провайдера: по нему принимается решение о пуле. */
  verdict: IntakeVerdict;
  reason: string;
  /** Остальные провайдеры — справка: их провал не бракует выход для пула NIM. */
  notes: string[];
  perTarget: Record<string, IntakeVerdictResult>;
}

/**
 * Свести вердикты нескольких целей в один. Решение всегда принимает
 * `requireId` (для пула `nvidia-proxies.json` это NIM): остальные провайдеры
 * дают справку «годится ли этот выход и для них», но не бракуют выход.
 * Иначе один недоступный из-за гео-блока провайдер выкинул бы рабочий выход.
 */
export function combineVerdicts(
  perTarget: Record<string, IntakeVerdictResult>,
  requireId: string,
): CombinedVerdict {
  const required = perTarget[requireId];
  const notes: string[] = [];
  for (const [id, result] of Object.entries(perTarget)) {
    if (id === requireId) continue;
    if (result.verdict !== "ok") notes.push(`${id}: ${result.verdict} (${result.reason})`);
  }
  if (!required) {
    return {
      verdict: "unknown",
      reason: `required target "${requireId}" was not probed`,
      notes,
      perTarget,
    };
  }
  return { verdict: required.verdict, reason: required.reason, notes, perTarget };
}

/* ------------------------------------------------------------------ */
/* Форма записи: нормализация и канон                                   */
/* ------------------------------------------------------------------ */

export interface NormalizedEntry {
  url: string;
  /** true, если запись пришла в форме `host:port:user:pass` и была собрана в URL. */
  normalized: boolean;
}

/**
 * `host:port:user:pass` (ровно четыре поля, второе числовое, нет `//`) —
 * частый вид в дампах резидентских прокси — собирается в `http://user:pass@host:port`.
 * Порядок user:pass в таких дампах стандартный, но не гарантирован:
 * `swapAuth` меняет их местами (при auth-провале это первый кандидат на проверку).
 * Двоеточие внутри логина или пароля форма не переживает — на четырёх полях
 * граница неоднозначна, поэтому не угадываем.
 */
export function normalizeProxyEntry(raw: string, options: { swapAuth?: boolean } = {}): NormalizedEntry {
  const value = raw.trim();
  const parts = value.split(":");
  if (parts.length === 4 && !/^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && !value.includes("//")) {
    const [host, port, first, second] = parts;
    const user = options.swapAuth ? second : first;
    const pass = options.swapAuth ? first : second;
    return {
      url: `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
      normalized: true,
    };
  }
  return { url: value, normalized: false };
}

export type CanonicalEntry =
  | { url: string; display: string; error?: undefined }
  | { error: string; display: string; url?: undefined };

/**
 * Каноническая форма записи пула: `scheme://user:pass@host:port` без хвостового
 * `/` (его добавляет `URL.toString()`) и без дефолтного порта схемы (`URL.host`
 * его и так опускает). `socks5h` нормализован в `socks5` ещё в `parseProxyEndpoint`.
 */
export function canonicalProxyEntry(entry: string): CanonicalEntry {
  const parsed = parseProxyEndpoint(entry);
  // `parseProxyEndpoint` возвращает все поля опциональными: display страхуем
  // маскировкой исходной строки, ошибку — машинной причиной (не i18n-строкой,
  // чтобы шов не зависел от локали).
  const display = parsed.display ?? maskProxy(entry);
  if (!parsed.href) return { error: parsed.error ?? "proxy endpoint did not parse", display };
  let url = parsed.href;
  if (url.endsWith("/")) {
    const asUrl = new URL(url);
    if (asUrl.pathname === "/" && !asUrl.search && !asUrl.hash) url = url.slice(0, -1);
  }
  return { url, display };
}

/** Список кандидатов из файла: JSON `{proxies:[…]}` / JSON-массив / строки (`#` — комментарий). */
export function parseCandidateList(text: string): { entries: string[]; error?: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return { entries: [], error: `candidates file is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.proxies;
    if (!Array.isArray(list)) return { entries: [], error: "candidates file has no `proxies` array" };
    const entries: string[] = [];
    for (const item of list) {
      if (typeof item !== "string") return { entries: [], error: "candidates file entries must be strings" };
      const value = item.trim();
      if (value) entries.push(value);
    }
    return { entries };
  }
  return {
    entries: trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  };
}

/* ------------------------------------------------------------------ */
/* План приёмки                                                         */
/* ------------------------------------------------------------------ */

export interface IntakeCandidate {
  /** Канонический URL — именно он попадёт в пул. */
  url: string;
  display: string;
  normalized: boolean;
  /** Тот же `host:port` уже в пуле, но с другими кредами: неразличимо для pin/карантина. */
  displayConflict: boolean;
  /** Исходная строка с вычищенными кредами — для отчёта. */
  sourceMasked: string;
}

export interface IntakePlan {
  toProbe: IntakeCandidate[];
  alreadyInPool: Array<{ display: string; sameCreds: boolean }>;
  duplicatesInList: string[];
  invalid: Array<{ display: string; error: string }>;
  /** Пул после канонизации и дедупа — то, к чему добавляются принятые выходы. */
  canonicalPool: string[];
  poolCanonicalized: Array<{ display: string; changed: boolean }>;
  poolDropped: Array<{ display: string; reason: string }>;
}

/**
 * Разобрать список кандидатов против текущего пула: что пробовать, что уже
 * лежит, что дублируется, что не разобралось и с чем конфликтует по display.
 * Побочно канонизирует пул (`canonicalPool`) — в пул всегда пишется канон.
 */
export function planIntake(options: {
  pool: readonly string[];
  candidates: readonly string[];
  swapAuth?: boolean;
}): IntakePlan {
  const canonicalPool: string[] = [];
  const poolDropped: IntakePlan["poolDropped"] = [];
  const poolCanonicalized: IntakePlan["poolCanonicalized"] = [];
  const poolByUrl = new Map<string, string>(); // canonical url → display
  const poolByDisplay = new Map<string, string>(); // display → canonical url

  for (const entry of options.pool) {
    const canon = canonicalProxyEntry(entry);
    // Локальная константа: сужение `string | undefined` → `string` живёт в ней,
    // а не в поле union-типа.
    const canonUrl = canon.url;
    if (!canonUrl) {
      poolDropped.push({ display: canon.display, reason: canon.error ?? "proxy endpoint did not parse" });
      continue;
    }
    if (poolByDisplay.has(canon.display)) {
      const kept = poolByDisplay.get(canon.display) as string;
      poolDropped.push({
        display: canon.display,
        reason: kept === canonUrl ? "duplicate host:port" : "duplicate host:port with different credentials",
      });
      continue;
    }
    poolByDisplay.set(canon.display, canonUrl);
    poolByUrl.set(canonUrl, canon.display);
    poolCanonicalized.push({ display: canon.display, changed: canonUrl !== entry });
    canonicalPool.push(canonUrl);
  }

  const toProbe: IntakeCandidate[] = [];
  const alreadyInPool: IntakePlan["alreadyInPool"] = [];
  const invalid: IntakePlan["invalid"] = [];
  const seenDisplays = new Set<string>();
  const duplicatesInList: string[] = [];

  for (const entry of options.candidates) {
    const norm = normalizeProxyEntry(entry, { swapAuth: options.swapAuth });
    const canon = canonicalProxyEntry(norm.url);
    const canonUrl = canon.url;
    if (!canonUrl) {
      invalid.push({ display: canon.display, error: canon.error ?? "proxy endpoint did not parse" });
      continue;
    }
    if (seenDisplays.has(canon.display)) {
      if (!duplicatesInList.includes(canon.display)) duplicatesInList.push(canon.display);
      continue;
    }
    seenDisplays.add(canon.display);
    const existing = poolByDisplay.get(canon.display);
    if (existing !== undefined) {
      const sameCreds = existing === canonUrl;
      if (sameCreds) {
        alreadyInPool.push({ display: canon.display, sameCreds: true });
        continue;
      }
      // Тот же host:port, другие креды: для расширения это ОДИН выход
      // (display identity), поэтому молча добавлять нельзя.
      alreadyInPool.push({ display: canon.display, sameCreds: false });
      toProbe.push({
        url: canonUrl,
        display: canon.display,
        normalized: norm.normalized,
        displayConflict: true,
        sourceMasked: redactProxyCredentials(norm.url),
      });
      continue;
    }
    if (poolByUrl.has(canonUrl)) {
      alreadyInPool.push({ display: canon.display, sameCreds: true });
      continue;
    }
    toProbe.push({
      url: canonUrl,
      display: canon.display,
      normalized: norm.normalized,
      displayConflict: false,
      sourceMasked: redactProxyCredentials(norm.url),
    });
  }

  return { toProbe, alreadyInPool, duplicatesInList, invalid, canonicalPool, poolCanonicalized, poolDropped };
}

/* ------------------------------------------------------------------ */
/* Слияние принятых выходов в пул                                      */
/* ------------------------------------------------------------------ */

export interface MergeResult {
  entries: string[];
  added: string[];
  replaced: Array<{ display: string; reason: string }>;
  refused: Array<{ display: string; reason: string }>;
}

/**
 * Влить принятые выходы в канонический пул. Конфликт по display без явного
 * `replaceConflicting` — отказ (см. правило 4 в шапке модуля). Пустой пул
 * результатом не бывает: если принимать нечего, возвращается исходный.
 */
export function mergeAccepted(options: {
  canonicalPool: readonly string[];
  accepted: readonly IntakeCandidate[];
  replaceConflicting?: boolean;
}): MergeResult {
  const entries = [...options.canonicalPool];
  const byDisplay = new Map(entries.map((url) => [canonicalProxyEntry(url).display, url]));
  const added: string[] = [];
  const replaced: MergeResult["replaced"] = [];
  const refused: MergeResult["refused"] = [];

  for (const candidate of options.accepted) {
    const existing = byDisplay.get(candidate.display);
    if (existing === undefined) {
      entries.push(candidate.url);
      byDisplay.set(candidate.display, candidate.url);
      added.push(candidate.display);
      continue;
    }
    if (existing === candidate.url) continue; // тот же выход, нечего делать
    if (!options.replaceConflicting) {
      refused.push({
        display: candidate.display,
        reason: "same host:port already in the pool with different credentials; pass --replace-display to swap it",
      });
      continue;
    }
    const index = entries.indexOf(existing);
    entries[index] = candidate.url;
    byDisplay.set(candidate.display, candidate.url);
    replaced.push({ display: candidate.display, reason: "replaced credentials of the existing host:port" });
  }

  return { entries, added, replaced, refused };
}

/**
 * Вычеркнуть выходы из пула по display identity. Защита от полной зачистки:
 * если после удаления пул пуст, а исходный пуст не был, возвращается исходный
 * и причина — решение «выкинуть всё» должно быть явным, а не побочным.
 */
export function pruneByDisplay(options: {
  canonicalPool: readonly string[];
  drop: readonly string[];
}): { entries: string[]; dropped: string[]; unknown: string[]; refused?: string } {
  const wanted = new Set(options.drop.map((d) => d.trim()).filter(Boolean));
  const entries: string[] = [];
  const dropped: string[] = [];
  for (const url of options.canonicalPool) {
    const display = canonicalProxyEntry(url).display;
    if (wanted.has(display)) {      dropped.push(display);
      continue;
    }
    entries.push(url);
  }
  const unknown = [...wanted].filter((display) => !dropped.includes(display));
  if (entries.length === 0 && options.canonicalPool.length > 0) {
    return { entries: [...options.canonicalPool], dropped: [], unknown, refused: "pruning would empty the pool" };
  }
  return { entries, dropped, unknown };
}
