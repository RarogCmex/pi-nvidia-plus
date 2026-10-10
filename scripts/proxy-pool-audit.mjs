#!/usr/bin/env node
/**
 * Ревизия пула выходов `nvidia-proxies.json`: аудит, приёмка новых, чистка,
 * канонизация, проверка выходов против НЕСКОЛЬКИХ провайдеров. Ops-скрипт —
 * вне `npm run check` (бьёт живую сеть), но решения о приёмке вынесены в чистый
 * шов `extensions/proxy-intake.ts` и покрыты офлайн-тестом
 * `test/proxy-intake.test.ts`.
 *
 * Команды:
 *   audit                       строгая серия проб по пулу (или --only host:port[,…])
 *   add --candidates FILE       приёмка новых выходов в пул
 *   prune --drop host:port[,…]  вычеркнуть выходы из пула
 *   normalize                   канонизировать и дедуплицировать пул
 *   providers                   перемерить саму таблицу целей (без прокси или --via host:port)
 *
 * Провайдеры:
 *   --providers nvidia,openrouter,…   какие цели пробовать (по умолчанию nvidia)
 *   --require nvidia                  чей вердикт решает (по умолчанию первый из --providers)
 *   --target https://api.example/v1/models [--expect json|any]
 *                                     своя цель поверх таблицы (id `custom`)
 *   --list-providers                  напечатать таблицу и выйти
 * Решение о пуле всегда принимает `--require`: пул-файл принадлежит NIM, а
 * остальные провайдеры — справка «годится ли выход и для них». Иначе один
 * недоступный из-за гео-блока провайдер выбрасывал бы рабочий выход.
 *
 * Общие флаги:
 *   --rounds N          проб подряд на выход (3): все обязаны пройти, ретраев нет
 *   --timeout MS        таймаут пробы (20000) — бюджет реального пути запросов
 *   --slow-ms MS        порог «тормоза» (12000): брак только если ВСЕ раунды медленнее
 *   --concurrency N     параллельность проб (4)
 *   --only / --drop     список host:port через запятую
 *   --via host:port     для providers: мерить через выход из пула, а не напрямую
 *   --egress            дополнительно снять реальный IP выхода (api.ipify.org)
 *   --pool FILE         пул-файл (по умолчанию <agentDir>/nvidia-proxies.json)
 *   --out FILE          отчёт (по умолчанию test-results/proxy-audit-<cmd>-<ts>.json)
 *   --no-baseline       не мерить прямую базу (direct, без прокси)
 *   --fail-on-unstable  ненулевой код возврата, если хоть один выход не прошёл гейт
 *   --write             применить изменение файла (без него — dry-run)
 * Только для add:
 *   --candidates FILE   JSON {proxies:[…]} / JSON-массив / строки по одному (# — комментарий)
 *   --swap-auth         для формы host:port:user:pass поменять user и pass местами
 *   --replace-display   заменить выход с тем же host:port, но другими кредами
 *
 * Почему проба не тратит квоту: бьём keyless-эндпоинт каталога (`GET /v1/models`
 * и аналоги) БЕЗ ключа — меряем достижимость выхода, а не auth (тот же приём,
 * что в `/nvidia-plus proxy check`).
 * Почему таймаут 20 с, а не штатные 10: столько держит `headersTimeout`
 * реального пути запросов расширения; выход, не влезающий в собственный рабочий
 * бюджет, в пуле бесполезен.
 * Почему задержка пробы ≠ задержке чата: в `GET /v1/models` нет ни prefill, ни
 * generate (на чате NIM бывает тормозит 30 с на prefill и ещё 15–30 с на
 * generate), поэтому проба характеризует туннель, а не модель.
 *
 * Секреты: в выводе, отчётах и логах выход фигурирует только как `host:port`
 * (`maskProxy`), ошибки прогоняются через `redactProxyCredentials`. Файл пула
 * пишется с правами 0600, перед изменением создаётся резервная копия рядом.
 *
 * Пользовательские строки расширения обязаны идти через `extensions/i18n.ts`;
 * вывод этого скрипта — машинный ops-лог (прецедент: `scripts/proxy-pool-acceptance.mjs`),
 * поэтому он не переводится.
 *
 * Примеры:
 *   npm run proxies:audit -- --rounds 5 --only gate.nodemaven.com:8080
 *   npm run proxies:audit -- --providers nvidia,openrouter,groq --rounds 2
 *   npm run proxies:add -- --candidates /tmp/list.json --egress --write
 *   npm run proxies:providers -- --via 103.133.69.139:1080
 */
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bodyMatchesExpectation,
  canonicalProxyEntry,
  combineVerdicts,
  mergeAccepted,
  parseCandidateList,
  planIntake,
  pruneByDisplay,
  samplePassed,
  strictVerdict,
  targetAcceptsStatus,
} from "../extensions/proxy-intake.ts";
import {
  maskProxy,
  parseProxiesFileContent,
  redactProxyCredentials,
  runProxyProbes,
} from "../extensions/proxy-pool.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const EGRESS_URL = "https://api.ipify.org?format=json";
const REPORT_DIR = join(repoRoot, "test-results");

/**
 * Таблица keyless-целей: эндпоинт каталога провайдера, который отвечает БЕЗ
 * авторизации. 401/403 с телом ошибки — это «сервис ответил», туннель жив;
 * а вот 404 значит, что URL в таблице устарел (ровно так и нашелся
 * `fireworks`: `/v1/models` → 404 JSON «Path not found», рабочий путь —
 * `/inference/v1/models`). `okStatuses` отделяет одно от другого, и цель с
 * неожиданным статусом получает вердикт `mismatch`, а не `hijack`.
 *
 * `expectation: "any"` стоит там, где провайдер на keyless-запрос отвечает НЕ
 * JSON-ом: together (401 text/plain «Missing API key»), deepseek (401 без
 * content-type, «Authentication Fails (governor)»), cohere (403 text/html).
 * Это ослабляет распознавание вендорской заглушки прокси, поэтому статус там
 * зажат списком `okStatuses`. Тела и статусы замерены напрямую 2026-10-10;
 * перемерить таблицу на месте — `npm run proxies:providers`.
 */
const PROBE_TARGETS = [
  { id: "nvidia", label: "NVIDIA NIM", url: "https://integrate.api.nvidia.com/v1/models", expectation: "json", okStatuses: [200, 401] },
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1/models", expectation: "json", okStatuses: [401] },
  { id: "anthropic", label: "Anthropic", url: "https://api.anthropic.com/v1/models", expectation: "json", okStatuses: [401, 403] },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1/models", expectation: "json", okStatuses: [200, 401] },
  { id: "google", label: "Google Generative Language", url: "https://generativelanguage.googleapis.com/v1beta/models", expectation: "json", okStatuses: [200, 400, 403] },
  { id: "groq", label: "Groq", url: "https://api.groq.com/openai/v1/models", expectation: "json", okStatuses: [401] },
  { id: "deepinfra", label: "DeepInfra", url: "https://api.deepinfra.com/v1/openai/models", expectation: "json", okStatuses: [200, 401] },
  { id: "together", label: "Together AI", url: "https://api.together.xyz/v1/models", expectation: "any", okStatuses: [401] },
  { id: "mistral", label: "Mistral AI", url: "https://api.mistral.ai/v1/models", expectation: "json", okStatuses: [401] },
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/models", expectation: "any", okStatuses: [401] },
  { id: "xai", label: "xAI", url: "https://api.x.ai/v1/models", expectation: "json", okStatuses: [401] },
  { id: "cerebras", label: "Cerebras", url: "https://api.cerebras.ai/v1/models", expectation: "json", okStatuses: [401, 403] },
  { id: "sambanova", label: "SambaNova", url: "https://api.sambanova.ai/v1/models", expectation: "json", okStatuses: [200, 401] },
  { id: "cohere", label: "Cohere", url: "https://api.cohere.com/v1/models", expectation: "any", okStatuses: [401, 403] },
  { id: "fireworks", label: "Fireworks AI", url: "https://api.fireworks.ai/inference/v1/models", expectation: "json", okStatuses: [401] },
  { id: "huggingface", label: "Hugging Face Router", url: "https://router.huggingface.co/v1/models", expectation: "json", okStatuses: [200, 401] },
];

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("--")) ?? "audit";
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const num = (name, fallback) => {
  const raw = opt(name, undefined);
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const list = (name) => String(opt(name, "")).split(",").map((s) => s.trim()).filter(Boolean);

const ROUNDS = Math.max(1, num("--rounds", 3));
const TIMEOUT_MS = Math.max(1000, num("--timeout", 20_000));
const SLOW_MS = Math.max(500, num("--slow-ms", 12_000));
const CONCURRENCY = Math.max(1, num("--concurrency", 4));
const WRITE = flag("--write");
const EGRESS = flag("--egress");
const NO_BASELINE = flag("--no-baseline");
const FAIL_ON_UNSTABLE = flag("--fail-on-unstable");
const SWAP_AUTH = flag("--swap-auth");
const REPLACE_DISPLAY = flag("--replace-display");
const OUT = String(opt("--out", join(REPORT_DIR, `proxy-audit-${command}-${Date.now()}.json`)));

/** Цели этого прогона + чья из них решает (`--require`). */
function resolveTargets() {
  const requested = list("--providers");
  const ids = requested.length ? requested : ["nvidia"];
  const targets = [];
  const unknown = [];
  for (const id of ids) {
    const found = PROBE_TARGETS.find((t) => t.id === id);
    if (found) targets.push(found);
    else unknown.push(id);
  }
  const custom = opt("--target", undefined);
  if (custom !== undefined) {
    const expectation = String(opt("--expect", "json")) === "any" ? "any" : "json";
    targets.push({ id: "custom", label: custom, url: custom, expectation });
  }  if (targets.length === 0) {
    console.error(`✗ неизвестные провайдеры: ${unknown.join(", ")}`);
    console.error(`  доступны: ${PROBE_TARGETS.map((t) => t.id).join(", ")} (или --target URL)`);
    process.exit(1);
  }
  if (unknown.length) console.error(`! неизвестные провайдеры пропущены: ${unknown.join(", ")}`);
  const requireId = String(opt("--require", ids[0] ?? "custom"));
  if (!targets.some((t) => t.id === requireId)) {
    console.error(`✗ --require ${requireId} не входит в список целей (${targets.map((t) => t.id).join(", ")})`);
    process.exit(1);
  }
  return { targets, requireId, unknown };
}

/**
 * Каталог конфига пи: `PI_CODING_AGENT_DIR`, иначе `~/.pi/agent`. Хардкодить
 * `homedir() + ".pi/agent"` нельзя — при нестандартном каталоге скрипт читал бы
 * не тот пул, который видит расширение (см. AGENTS.md про `getAgentDir()`).
 */
function agentDir() {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), ".pi", "agent");
}
const POOL_FILE = (() => {
  const custom = opt("--pool", undefined);
  if (custom === undefined) return join(agentDir(), "nvidia-proxies.json");
  return isAbsolute(custom) ? custom : resolve(repoRoot, custom);
})();

/**
 * undici именно того pi, который ставит глобальный диспетчер: скрипт обязан
 * мерить тот же объект (как `scripts/proxy-pool-acceptance.mjs`).
 */
function loadPiUndici() {
  const link = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  let piEntry;
  try {
    // realpathSync бросает голый ENOENT; ниже он превращается в понятную инструкцию.
    piEntry = join(realpathSync(link), "index.js");
  } catch {
    console.error(
      `proxy-pool-audit: ${link} не найден.\n` +
        "  Скрипт меряет undici самого pi, поэтому пакеты нужно слинковать заранее:\n" +
        "    node scripts/link-pi.mjs\n" +
        "  (или явно: PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs)",
    );
    process.exit(1);
  }
  return createRequire(piEntry)("undici");
}

const undici = loadPiUndici();

/* ------------------------------------------------------------------ */
/* Пул-файл: чтение, резерв, запись 0600                                */
/* ------------------------------------------------------------------ */

function readPool() {
  if (!existsSync(POOL_FILE)) {
    console.error(`✗ пул-файл не найден: ${POOL_FILE}`);
    process.exit(1);
  }
  const parsed = parseProxiesFileContent(readFileSync(POOL_FILE, "utf8"));
  if (parsed.error) {
    console.error(`✗ ${POOL_FILE}: ${parsed.error}`);
    process.exit(1);
  }
  return parsed.proxies;
}

function backupAndWrite(entries) {
  const backup = `${POOL_FILE}.bak-${Date.now()}`;
  copyFileSync(POOL_FILE, backup);
  chmodSync(backup, 0o600);
  writeFileSync(POOL_FILE, `${JSON.stringify({ proxies: entries }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(POOL_FILE, 0o600);
  return backup;
}

/* ------------------------------------------------------------------ */
/* Пробы (сеть) — единственная нечистая часть скрипта                   */
/* ------------------------------------------------------------------ */

const agents = new Map();
/** `href === null` — напрямую (без прокси): для базы и для команды providers. */
function agentFor(href) {
  if (!href) return undefined;
  let agent = agents.get(href);
  if (agent) return agent;
  const url = new URL(href);
  if ((url.protocol === "socks5:" || url.protocol === "socks:") && !undici.Socks5ProxyAgent) {
    throw new Error("this undici has no Socks5ProxyAgent — socks5 exits cannot be probed");
  }
  agent = new undici.ProxyAgent(url.toString());
  agents.set(href, agent);
  return agent;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Один раунд пробы цели. Жёсткий `AbortSignal.timeout` обязателен — зависший
 * CONNECT держит процесс живым после конца работы.
 */
async function probeOnce(href, target, timeoutMs = TIMEOUT_MS) {
  const started = Date.now();
  try {
    const init = {
      method: "GET",
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs + 2000),
    };
    const dispatcher = agentFor(href);
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await undici.request(target.url, init);
    const text = await res.body.text();
    return {
      ms: Date.now() - started,
      status: res.statusCode,
      contentType: String(res.headers["content-type"] ?? "").slice(0, 40),
      bodyOk: bodyMatchesExpectation(text, target.expectation),
      statusOk: targetAcceptsStatus(target, res.statusCode),
    };
  } catch (e) {
    return { ms: Date.now() - started, error: redactProxyCredentials(String(e.message ?? e)).slice(0, 70) };
  }
}

/** Серия из `rounds` проб одной цели + вердикт чистого шва. */
async function strictSeries(href, target, { rounds = ROUNDS, timeoutMs = TIMEOUT_MS, slowMs = SLOW_MS } = {}) {
  const samples = [];
  for (let round = 1; round <= rounds; round++) {
    const one = await probeOnce(href, target, timeoutMs);
    samples.push({ round, ...one });
    if (one.status !== undefined && one.bodyOk === false) break; // hijack: повторять бессмысленно
    if (round < rounds) await sleep(250);
  }
  return { target: target.id, samples, ...strictVerdict(samples, { rounds, timeoutMs, slowMs }) };
}

/**
 * Матрица «выходы × цели»: для каждой цели отдельный проход штатного
 * планировщика `runProxyProbes` (параллельность внутри цели, цели — подряд,
 * чтобы не устраивать DDoS ни провайдеру, ни выходу).
 */
async function probeMatrix(endpoints, targets, seriesOptions) {
  const perEndpoint = new Map(endpoints.map((e) => [e.display, { ...e, series: {} }]));
  for (const target of targets) {
    const plan = await runProxyProbes(
      endpoints.map((e) => ({ href: e.href, display: `${e.display}|${target.id}` })),
      async (endpoint) => {
        const series = await strictSeries(endpoint.href, target, seriesOptions);
        perEndpoint.get(endpoint.display.split("|")[0]).series[target.id] = series;
        return series.verdict === "ok" ? { status: 200 } : { error: new Error(`${series.verdict}: ${series.reason}`) };
      },
      { concurrency: CONCURRENCY },
    );
    if (plan.aborted) console.error(`! планировщик прервался на цели ${target.id}`);
  }
  return [...perEndpoint.values()];
}

/** Реальный IP выхода (справка; на вердикт не влияет). */
async function egressIp(href) {
  try {
    const res = await undici.request(EGRESS_URL, {
      method: "GET",
      dispatcher: agentFor(href),
      headersTimeout: 12_000,
      bodyTimeout: 12_000,
      signal: AbortSignal.timeout(14_000),
    });
    const text = (await res.body.text()).trim();
    if (res.statusCode !== 200) return `err: HTTP ${res.statusCode}`;
    try {
      return String(JSON.parse(text).ip ?? text).slice(0, 45);
    } catch {
      return text.slice(0, 45);
    }
  } catch (e) {
    return `err: ${redactProxyCredentials(String(e.message ?? e)).slice(0, 60)}`;
  }
}

/** Прямая база обязательной цели: насколько вообще вязкий провайдер без прокси. */
async function baseline(target, rounds = 2) {
  const samples = [];
  for (let round = 1; round <= rounds; round++) {
    samples.push({ round, ...(await probeOnce(null, target)) });
  }
  return samples;
}

async function closeAgents() {
  for (const agent of agents.values()) {
    try {
      await Promise.race([agent.close(), sleep(1500)]);
    } catch {}
    agent.destroy?.();
  }
}

/* ------------------------------------------------------------------ */
/* Вывод и отчёт                                                        */
/* ------------------------------------------------------------------ */

const fmtLat = (series) => series.samples.map((s) => (samplePassed(s) ? `${s.ms}` : "T/O")).join("/");
const mark = (verdict) => (verdict === "ok" ? "✓" : "✗");

function writeReport(payload) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Отчёт: ${OUT}`);
}

function printCriteria(targets, requireId) {
  console.log(
    `Критерий: ${ROUNDS} проб(ы) подряд, все в ${TIMEOUT_MS / 1000} с, не все медленнее ${SLOW_MS / 1000} с; keyless-проба каталога (квота не тратится)\n` +
      `Цели: ${targets.map((t) => `${t.id}${t.id === requireId ? "*" : ""}`).join(", ")} (* — решает)`,
  );
}

/** Свести матрицу к строке: вердикт обязательной цели + справка по остальным. */
function rowVerdict(row, requireId) {
  return combineVerdicts(row.series, requireId);
}

/* ------------------------------------------------------------------ */
/* Команды                                                              */
/* ------------------------------------------------------------------ */

function poolEndpoints(entries, only) {
  const wanted = only.length ? new Set(only) : undefined;
  const endpoints = [];
  const skipped = [];
  for (const entry of entries) {
    const canon = canonicalProxyEntry(entry);
    const url = canon.url;
    if (!url) {
      skipped.push({ display: canon.display, reason: canon.error ?? "did not parse" });
      continue;
    }
    if (wanted && !wanted.has(canon.display)) continue;
    endpoints.push({ href: new URL(url).toString(), display: canon.display });
  }
  if (wanted) {
    for (const display of wanted) {
      if (!endpoints.some((e) => e.display === display)) skipped.push({ display, reason: "not in the pool" });
    }
  }
  return { endpoints, skipped };
}

async function cmdAudit() {
  const { targets, requireId } = resolveTargets();
  const pool = readPool();
  const only = list("--only");
  const { endpoints, skipped } = poolEndpoints(pool, only);
  console.log(`Пул: ${POOL_FILE} (${pool.length} записей) · к пробе: ${endpoints.length}`);
  printCriteria(targets, requireId);
  for (const s of skipped) console.log(`  ! ${s.display}: ${s.reason}`);

  const required = targets.find((t) => t.id === requireId);
  const base = NO_BASELINE ? [] : await baseline(required);
  if (base.length) {
    const ok = base.filter((s) => s.status !== undefined);
    console.log(
      `База direct (${requireId}): ${ok.length}/${base.length} ok` +
        (ok.length ? `, ${ok.map((s) => `${s.ms} мс`).join(", ")}` : ` — ${base[0]?.error ?? "недоступно"}`),
    );
  }

  const rows = await probeMatrix(endpoints, targets);
  if (EGRESS) {
    for (const row of rows.filter((r) => rowVerdict(r, requireId).verdict === "ok")) row.egress = await egressIp(row.href);
  }

  console.log("");
  const sorted = [...rows].sort((a, b) => {
    const va = rowVerdict(a, requireId).verdict;
    const vb = rowVerdict(b, requireId).verdict;
    return va.localeCompare(vb) || a.display.localeCompare(b.display);
  });
  const others = targets.filter((t) => t.id !== requireId);
  for (const row of sorted) {
    const combined = rowVerdict(row, requireId);
    const main = row.series[requireId] ?? { samples: [], verdict: "unknown", reason: "no series" };
    const extra = others.length
      ? `  | ${others.map((t) => `${t.id}:${row.series[t.id]?.verdict ?? "?"}`).join(" ")}`
      : "";
    console.log(
      `  ${mark(combined.verdict)} ${row.display.padEnd(28)} ${combined.verdict.padEnd(7)} [${fmtLat(main).padEnd(20)}] мс  ${combined.reason}${extra}` +
        (row.egress ? `  egress ${row.egress}` : ""),
    );
    for (const note of combined.notes) console.log(`      · ${note}`);
  }
  const unstable = sorted.filter((r) => rowVerdict(r, requireId).verdict !== "ok");
  console.log(
    `\nИтог: ${sorted.length - unstable.length} стабильных, ${unstable.length} спорных` +
      (unstable.length ? ` (${unstable.map((r) => r.display).join(", ")})` : ""),
  );

  writeReport({
    command: "audit",
    timestamp: new Date().toISOString(),
    poolFile: POOL_FILE,
    criteria: { rounds: ROUNDS, timeoutMs: TIMEOUT_MS, slowMs: SLOW_MS, concurrency: CONCURRENCY },
    targets: targets.map((t) => ({ id: t.id, url: t.url, expectation: t.expectation })),
    requireId,
    baselineDirect: base,
    results: sorted.map((r) => ({
      display: r.display,
      verdict: rowVerdict(r, requireId).verdict,
      reason: rowVerdict(r, requireId).reason,
      notes: rowVerdict(r, requireId).notes,
      egress: r.egress,
      perTarget: Object.fromEntries(
        Object.entries(r.series).map(([id, s]) => [id, { verdict: s.verdict, reason: s.reason, latencies: s.latencies, samples: s.samples }]),
      ),
    })),
    unstable: unstable.map((r) => r.display),
    skipped,
  });
  await closeAgents();
  if (FAIL_ON_UNSTABLE && unstable.length) process.exit(1);
  process.exit(0);
}

/** Отчёт без креденшелов: из плана берутся только display-маски. */
function maskPlan(plan) {
  return {
    toProbe: plan.toProbe.map((c) => ({ display: c.display, normalized: c.normalized, displayConflict: c.displayConflict, sourceMasked: c.sourceMasked })),
    alreadyInPool: plan.alreadyInPool,
    duplicatesInList: plan.duplicatesInList,
    invalid: plan.invalid,
    poolCanonicalized: plan.poolCanonicalized,
    poolDropped: plan.poolDropped,
  };
}

async function cmdAdd() {
  const { targets, requireId } = resolveTargets();
  const candidatesFile = opt("--candidates", undefined);
  if (candidatesFile === undefined) {
    console.error("✗ add: нужен --candidates FILE");
    process.exit(1);
  }
  const candidatesPath = isAbsolute(candidatesFile) ? candidatesFile : resolve(repoRoot, candidatesFile);
  const parsedList = parseCandidateList(readFileSync(candidatesPath, "utf8"));
  if (parsedList.error) {
    console.error(`✗ ${candidatesPath}: ${parsedList.error}`);
    process.exit(1);
  }

  const pool = readPool();
  const plan = planIntake({ pool, candidates: parsedList.entries, swapAuth: SWAP_AUTH });
  console.log(`Пул: ${POOL_FILE} (${pool.length} записей → канонических ${plan.canonicalPool.length})`);
  for (const drop of plan.poolDropped) console.log(`  - пул: ${drop.display} — ${drop.reason}`);
  for (const c of plan.poolCanonicalized.filter((x) => x.changed)) console.log(`  ~ пул: ${c.display} приведён к канонической форме`);
  console.log(`Кандидатов: ${parsedList.entries.length} · к пробе: ${plan.toProbe.length}`);
  if (plan.alreadyInPool.length) {
    console.log(`  уже в пуле: ${plan.alreadyInPool.map((a) => `${a.display}${a.sameCreds ? "" : " (другие креды!)"}`).join(", ")}`);
  }
  if (plan.duplicatesInList.length) console.log(`  дубли в списке: ${plan.duplicatesInList.join(", ")}`);
  for (const bad of plan.invalid) console.log(`  ! не разобралось: ${bad.display} — ${bad.error}`);
  const normalized = plan.toProbe.filter((c) => c.normalized);
  if (normalized.length) console.log(`  нормализовано из host:port:user:pass: ${normalized.map((c) => c.display).join(", ")}`);
  const conflicts = plan.toProbe.filter((c) => c.displayConflict);
  if (conflicts.length) {
    console.log(
      `  конфликт display (тот же host:port, другие креды): ${conflicts.map((c) => c.display).join(", ")} — ` +
        (REPLACE_DISPLAY ? "заменяю (--replace-display)" : "не добавляю без --replace-display"),
    );
  }
  printCriteria(targets, requireId);

  if (plan.toProbe.length === 0) {
    console.log("\nНовых выходов нет — пул не трогаю.");
    writeReport({ command: "add", timestamp: new Date().toISOString(), poolFile: POOL_FILE, candidatesFile: candidatesPath, plan: maskPlan(plan) });
    await closeAgents();
    process.exit(0);
  }

  const required = targets.find((t) => t.id === requireId);
  const base = NO_BASELINE ? [] : await baseline(required);
  if (base.length) {
    const ok = base.filter((s) => s.status !== undefined);
    console.log(`База direct (${requireId}): ${ok.length}/${base.length} ok${ok.length ? `, ${ok.map((s) => `${s.ms} мс`).join(", ")}` : ""}`);
  }

  const endpoints = plan.toProbe.map((c) => ({ href: new URL(c.url).toString(), display: c.display, candidate: c }));
  const started = Date.now();
  const rows = await probeMatrix(endpoints, targets);
  const elapsedMs = Date.now() - started;
  if (EGRESS) {
    for (const row of rows.filter((r) => rowVerdict(r, requireId).verdict === "ok")) row.egress = await egressIp(row.href);
  }
  for (const row of rows) row.combined = rowVerdict(row, requireId);

  const passed = rows.filter((r) => r.combined.verdict === "ok");
  const rejected = rows.filter((r) => r.combined.verdict !== "ok");
  const accepted = passed.map((r) => r.candidate);

  console.log("\n— прошли гейт —");
  for (const row of passed) {
    const extra = targets.filter((t) => t.id !== requireId).map((t) => `${t.id}:${row.series[t.id]?.verdict ?? "?"}`).join(" ");
    console.log(
      `  ✓ ${row.display.padEnd(28)} [${fmtLat(row.series[requireId] ?? { samples: [] }).padEnd(20)}] мс  ${row.combined.reason}${extra ? `  | ${extra}` : ""}` +
        (row.egress ? `  egress ${row.egress}` : "") +
        (row.candidate.displayConflict ? "  (конфликт display)" : ""),
    );
    for (const note of row.combined.notes) console.log(`      · ${note}`);
  }
  if (rejected.length) {
    console.log("\n— не прошли гейт —");
    for (const row of rejected) console.log(`  ✗ ${row.display.padEnd(28)} ${row.combined.verdict.padEnd(7)} ${row.combined.reason}`);
  }

  const merged = mergeAccepted({ canonicalPool: plan.canonicalPool, accepted, replaceConflicting: REPLACE_DISPLAY });
  for (const r of merged.refused) console.log(`  ! отказ: ${r.display} — ${r.reason}`);
  for (const r of merged.replaced) console.log(`  ~ заменён: ${r.display} — ${r.reason}`);
  console.log(`\nИтог: принято ${merged.added.length} из ${plan.toProbe.length}, замен ${merged.replaced.length}, отказов ${merged.refused.length} · ${Math.round(elapsedMs / 1000)} с`);

  if (WRITE) {
    if (merged.added.length === 0 && merged.replaced.length === 0) {
      console.error("✗ принимать нечего — пул не трогаю");
    } else {
      const backup = backupAndWrite(merged.entries);
      console.log(`✓ пул: ${plan.canonicalPool.length} → ${merged.entries.length} (+${merged.added.length})`);
      console.log(`  резерв: ${backup}`);
    }
  } else {
    console.log("\n(dry-run: пул не изменён, добавь --write)");
  }

  writeReport({
    command: "add",
    timestamp: new Date().toISOString(),
    poolFile: POOL_FILE,
    candidatesFile: candidatesPath,
    criteria: { rounds: ROUNDS, timeoutMs: TIMEOUT_MS, slowMs: SLOW_MS, concurrency: CONCURRENCY, swapAuth: SWAP_AUTH, replaceDisplay: REPLACE_DISPLAY },
    targets: targets.map((t) => ({ id: t.id, url: t.url, expectation: t.expectation })),
    requireId,
    baselineDirect: base,
    elapsedMs,
    plan: maskPlan(plan),
    accepted: passed.map((r) => ({ display: r.display, reason: r.combined.reason, latencies: (r.series[requireId] ?? { latencies: [] }).latencies, samples: (r.series[requireId] ?? { samples: [] }).samples, egress: r.egress, notes: r.combined.notes })),
    rejected: rejected.map((r) => ({ display: r.display, verdict: r.combined.verdict, reason: r.combined.reason, samples: (r.series[requireId] ?? { samples: [] }).samples })),
    perTarget: Object.fromEntries(
      rows.map((r) => [r.display, Object.fromEntries(Object.entries(r.series).map(([id, s]) => [id, s.verdict]))]),
    ),
    merged: { added: merged.added, replaced: merged.replaced, refused: merged.refused, total: merged.entries.length },
    written: WRITE,
  });
  await closeAgents();
  if (FAIL_ON_UNSTABLE && rejected.length) process.exit(1);
  process.exit(0);
}

function cmdPrune() {
  const drop = list("--drop");
  if (drop.length === 0) {
    console.error("✗ prune: нужен --drop host:port[,host:port…]");
    process.exit(1);
  }
  const pool = readPool();
  const plan = planIntake({ pool, candidates: [] });
  const result = pruneByDisplay({ canonicalPool: plan.canonicalPool, drop });
  console.log(`Пул: ${POOL_FILE} · было ${plan.canonicalPool.length}, к удалению ${drop.length}`);
  for (const d of result.dropped) console.log(`  - ${d}`);
  for (const u of result.unknown) console.log(`  ? ${u} — в пуле не найден`);
  if (result.refused) {
    console.error(`✗ ${result.refused}`);
    process.exit(1);
  }
  if (WRITE) {
    const backup = backupAndWrite(result.entries);
    console.log(`✓ пул: ${plan.canonicalPool.length} → ${result.entries.length}`);
    console.log(`  резерв: ${backup}`);
  } else {
    console.log(`\n(dry-run: останется ${result.entries.length}; добавь --write)`);
  }
  writeReport({ command: "prune", timestamp: new Date().toISOString(), poolFile: POOL_FILE, dropped: result.dropped, unknown: result.unknown, total: result.entries.length, written: WRITE });
  process.exit(0);
}

function cmdNormalize() {
  const pool = readPool();
  const plan = planIntake({ pool, candidates: [] });
  const changed = plan.poolCanonicalized.filter((c) => c.changed);
  console.log(`Пул: ${POOL_FILE} · записей ${pool.length} → канонических ${plan.canonicalPool.length}`);
  for (const c of changed) console.log(`  ~ ${c.display} приведён к канонической форме`);
  for (const d of plan.poolDropped) console.log(`  - ${d.display}: ${d.reason}`);
  if (!changed.length && !plan.poolDropped.length) {
    console.log("  пул уже в канонической форме — писать нечего");
  } else if (WRITE) {
    const backup = backupAndWrite(plan.canonicalPool);
    console.log(`✓ записано, резерв: ${backup}`);
  } else {
    console.log("\n(dry-run: добавь --write)");
  }
  writeReport({ command: "normalize", timestamp: new Date().toISOString(), poolFile: POOL_FILE, canonicalized: changed.map((c) => c.display), dropped: plan.poolDropped, total: plan.canonicalPool.length, written: WRITE });
  process.exit(0);
}

/**
 * Перемерить саму таблицу целей: статус, content-type, «тело — JSON», задержка.
 * Без `--via` — напрямую (проверка, что URL вообще живой), с `--via host:port` —
 * через конкретный выход из пула (проверка, что выход пускает к другим
 * провайдерам, а не только к NIM).
 */
async function cmdProviders() {
  const wanted = list("--providers");
  // Копия таблицы: ниже возможен push своей цели, а мутировать PROBE_TARGETS нельзя.
  const targets = wanted.length ? PROBE_TARGETS.filter((t) => wanted.includes(t.id)) : [...PROBE_TARGETS];
  if (targets.length === 0) {
    console.error(`✗ нет таких провайдеров: ${wanted.join(", ")}`);
    console.error(`  доступны: ${PROBE_TARGETS.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }
  let href = null;
  const via = opt("--via", undefined);
  if (via !== undefined) {
    const pool = readPool();
    const found = pool
      .map((entry) => canonicalProxyEntry(entry))
      .find((c) => c.url && c.display === via);
    if (!found?.url) {
      console.error(`✗ --via ${via}: такого выхода нет в пуле ${POOL_FILE}`);
      process.exit(1);
    }
    href = new URL(found.url).toString();
  }
  const custom = opt("--target", undefined);
  if (custom !== undefined) {
    targets.push({ id: "custom", label: custom, url: custom, expectation: String(opt("--expect", "json")) === "any" ? "any" : "json" });
  }

  console.log(`Целей: ${targets.length} · через: ${href ? maskProxy(href) : "direct (без прокси)"} · таймаут ${TIMEOUT_MS / 1000} с`);
  const rows = [];
  for (const target of targets) {
    const sample = await probeOnce(href, target);
    const verdict =
      sample.status === undefined ? "fail" : sample.bodyOk === false ? "body" : sample.statusOk === false ? "status" : "ok";
    rows.push({ id: target.id, url: target.url, expectation: target.expectation, okStatuses: target.okStatuses ?? null, ...sample, verdict });
    const icon = verdict === "ok" ? "✓" : verdict === "fail" ? "✗" : "~";
    console.log(
      `  ${icon} ${target.id.padEnd(12)} ${String(sample.status ?? "-").padEnd(4)} ${(sample.contentType ?? "-").padEnd(28)} ${String(sample.ms).padStart(6)} мс  ${target.url}` +
        (sample.error ? `  ${sample.error}` : verdict === "status" ? `  ← ожидается ${(target.okStatuses ?? []).join("/")}` : ""),
    );
  }
  const okCount = rows.filter((r) => r.verdict === "ok").length;
  console.log(`\nИтог: ${okCount}/${rows.length} целей отвечают ожидаемым телом`);
  writeReport({ command: "providers", timestamp: new Date().toISOString(), via: href ? maskProxy(href) : "direct", timeoutMs: TIMEOUT_MS, rows });
  await closeAgents();
  process.exit(0);
}

/* ------------------------------------------------------------------ */

function listProviders() {
  console.log("Провайдеры (keyless-проба каталога; ожидание тела / ожидаемые статусы):");
  for (const t of PROBE_TARGETS) {
    console.log(`  ${t.id.padEnd(12)} ${t.expectation.padEnd(5)} ${String((t.okStatuses ?? []).join("/") || "любой").padEnd(10)} ${t.label.padEnd(30)} ${t.url}`);
  }
  console.log("\nСвоя цель: --target https://api.example/v1/models [--expect json|any]");
  console.log("Перемерить таблицу: npm run proxies:providers [--via host:port]");
}

function usage() {
  console.error(
    [
      "Использование: node scripts/proxy-pool-audit.mjs <audit|add|prune|normalize|providers> [флаги]",
      "  audit      — строгая серия проб по пулу (--only host:port[,…] сужает набор)",
      "  add        — приёмка новых выходов (--candidates FILE обязателен)",
      "  prune      — вычеркнуть выходы (--drop host:port[,…] обязателен)",
      "  normalize  — канонизировать и дедуплицировать пул",
      "  providers  — перемерить таблицу целей (direct или --via host:port)",
      "Флаги: --rounds N --timeout MS --slow-ms MS --concurrency N --only … --drop …",
      "       --providers a,b --require a --target URL --expect json|any --list-providers",
      "       --via host:port --egress --write --pool FILE --out FILE --no-baseline",
      "       --fail-on-unstable --candidates FILE --swap-auth --replace-display",
      "Без --write изменение файла не применяется (dry-run).",
    ].join("\n"),
  );
}

if (flag("--list-providers")) {
  listProviders();
  process.exit(0);
}

switch (command) {
  case "audit":
    await cmdAudit();
    break;
  case "add":
    await cmdAdd();
    break;
  case "prune":
    cmdPrune();
    break;
  case "normalize":
    cmdNormalize();
    break;
  case "providers":
    await cmdProviders();
    break;
  case "--help":
  case "help":
    usage();
    listProviders();
    break;
  default:
    console.error(`✗ неизвестная команда: ${command} (доступны audit, add, prune, normalize, providers)`);
    usage();
    process.exit(1);
}
