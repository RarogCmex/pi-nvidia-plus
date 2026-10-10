#!/usr/bin/env node
/**
 * Аудит пула ключей NIM (`~/.pi/agent/nvidia-keys.json`): проверка живости
 * БЕЗ генерации и чистка мёртвых. Ops-скрипт — вне `npm run check` (бьёт живую
 * сеть), но решения вынесены в чистый шов `extensions/key-check.ts`
 * (`classifyKeyAuthProbe`, `planKeyCleanup`) и покрыты офлайн-тестом
 * `test/key-check.test.ts`. Свидетельство оракула — research/09.
 *
 * Оракул: авторизация в NIM идёт раньше резолва chat-функции под аккаунт,
 * поэтому `POST /v1/chat/completions` с моделью из ЖИВОГО каталога и телом без
 * `messages` до генерации не доходит ни на одном ключе:
 *   401/403 → мёртв (кредиты отвергнуты; подтверждается второй пробой);
 *   404 → жив («Function not found for account»: auth пройден, аккаунт назван);
 *   400/422 → жив (валидация тела после auth); 429 → жив (рейт-лимит).
 * Модель пробы не угадывается: несуществующий id резолвится ДО авторизации
 * (research/06) и делает все ключи «живыми» — поэтому она берётся keyless-ом
 * из живого каталога на каждом запуске.
 *
 * `auth-check` (по умолчанию) — только отчёт. `--write` — чистка мёртвых:
 * резерв `.bak-<ts>` рядом, права 0600, env-ссылки `$VAR` не трогаются.
 * Гварды шва: `too-many-dead` (мёртвых больше половины на пуле ≥ 10 — вероятнее
 * сломался оракул; override `--force`) и `empty-result` (чистка опустошила бы
 * пул; не перезаписывается ничем).
 *
 * Секреты: ключи печатаются только масками `…XXXX` (`maskKey`), тела ответов
 * не выводятся и не пишутся в отчёт (в 404 NIM называет id аккаунта).
 *
 * Запуск:
 *   npm run keys:auth-check                     # отчёт, файл не трогается
 *   npm run keys:cleanup-dead                    # чистка мёртвых (--write)
 *   node scripts/keys-audit.mjs [--write] [--force] [--concurrency N]
 *       [--keys FILE] [--out FILE] [--force-model MODEL]
 */
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KEYS_FILE_NAME, interpolateEnvValue, maskKey, parseKeysFileContent } from "../extensions/keys.ts";
import { classifyKeyAuthProbe, planKeyCleanup } from "../extensions/key-check.ts";
import { isChatModel } from "../extensions/discovery.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const NVIDIA_ORIGIN = "https://integrate.api.nvidia.com";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const num = (name, fallback) => {
  const value = Number(opt(name, undefined));
  return Number.isFinite(value) ? value : fallback;
};
const WRITE = flag("--write");
const FORCE = flag("--force");
const CONCURRENCY = Math.max(1, Math.min(8, num("--concurrency", 4)));
const KEYS_FILE = (() => {
  const custom = opt("--keys", undefined);
  const base = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  if (custom === undefined) return join(base, DEFAULT_KEYS_FILE_NAME);
  return isAbsolute(custom) ? custom : resolve(repoRoot, custom);
})();
const OUT = String(opt("--out", join(repoRoot, "test-results", `keys-audit-${Date.now()}.json`)));

const undici = createRequire(join(realpathSync(join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent")), "index.js"))("undici");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Модель пробы: первая чат-модель живого keyless-каталога. `--force-model` — явный override. */
async function pickProbeModel() {
  const forced = opt("--force-model", undefined);
  if (forced) return forced;
  const res = await undici.request(`${NVIDIA_ORIGIN}/v1/models`, {
    method: "GET",
    headersTimeout: 20_000,
    bodyTimeout: 20_000,
    signal: AbortSignal.timeout(22_000),
  });
  const body = JSON.parse(await res.body.text());
  const ids = (body.data ?? body.models ?? []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
  return ids.find((id) => isChatModel(id)) ?? ids[0];
}

/**
 * Одна проба. Тело читаем для освобождения сокета, но не возвращаем и не
 * логируем: в 404-ответе NIM называет id аккаунта — он не для логов.
 */
async function probeKey(key, model) {
  try {
    const res = await undici.request(`${NVIDIA_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
      signal: AbortSignal.timeout(17_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model }),
    });
    await res.body.text();
    return { status: res.statusCode };
  } catch (e) {
    return { error: String(e.message ?? e).slice(0, 60) };
  }
}

async function main() {
  if (!existsSync(KEYS_FILE)) {
    console.error(`✗ файл ключей не найден: ${KEYS_FILE}`);
    process.exit(1);
  }
  const parsed = parseKeysFileContent(readFileSync(KEYS_FILE, "utf8"));
  if (!parsed.keys) {
    console.error(`✗ ${KEYS_FILE}: ${parsed.error}`);
    process.exit(1);
  }

  // Резолвим $VAR; нерезолвящиеся записи не пробуем и не удаляем (их слой — окружение).
  const entries = [];
  const envRefs = [];
  for (const raw of parsed.keys) {
    const resolved = raw.startsWith("nvapi-") ? raw : interpolateEnvValue(raw, process.env);
    if (resolved) entries.push({ raw, probeKey: resolved });
    else envRefs.push(raw);
  }
  const probeKeys = entries.map((e) => e.probeKey);

  const model = await pickProbeModel();
  console.log(`Файл: ${KEYS_FILE}`);
  console.log(`Ключей: ${probeKeys.length} (env-ссылок не трогаем: ${envRefs.length})`);
  console.log(`Проба: POST /v1/chat/completions, модель ${model}, тело без messages — до генерации не доходит, квота не тратится`);
  console.log(`Оракул: 401/403 = мёртв (подтверждается повтором); 404/400/422/429/200/202 = жив; остальное — не определено`);
  console.log(`Параллельность: ${CONCURRENCY}\n`);

  const verdicts = new Map(); // probeKey → { outcome, status }
  let cursor = 0;
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= probeKeys.length) return;
      const key = probeKeys[index];
      let probe = await probeKey(key, model);
      let status = probe.status;
      let outcome = probe.status === undefined ? "unknown" : classifyKeyAuthProbe(probe.status);
      if (outcome === "dead") {
        await sleep(300);
        probe = await probeKey(key, model);
        status = probe.status;
        outcome = probe.status === undefined ? "unknown" : classifyKeyAuthProbe(probe.status);
      }
      verdicts.set(key, { outcome, status });
      done++;
      if (done % 50 === 0) console.log(`  …${done}/${probeKeys.length}`);
      await sleep(80); // мягкий пейсинг, чтобы не ловить 429 вместо ответа
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, probeKeys.length) }, worker));
  const elapsedSec = Math.round((Date.now() - started) / 1000);

  for (const entry of entries) entry.outcome = verdicts.get(entry.probeKey)?.outcome;
  const byVerdict = { alive: 0, dead: 0, unknown: 0 };
  const byStatus = {};
  for (const v of verdicts.values()) {
    byVerdict[v.outcome] += 1;
    byStatus[String(v.status)] = (byStatus[String(v.status)] ?? 0) + 1;
  }
  console.log(`\nСтатусы: ${Object.entries(byStatus).map(([s, n]) => `${s}×${n}`).join(", ")}`);
  console.log(`Итог: живых ${byVerdict.alive}, мёртвых ${byVerdict.dead}, неопределённых ${byVerdict.unknown} · ${elapsedSec} с`);
  const deads = [...verdicts.entries()].filter(([, v]) => v.outcome === "dead");
  if (deads.length > 0) {
    console.log("\n— мёртвые (401/403 подтверждён дважды) —");
    for (const [key] of deads.slice(0, 60)) console.log(`  ✗ ${maskKey(key).padEnd(12)}`);
    if (deads.length > 60) console.log(`  … и ещё ${deads.length - 60}`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        keysFile: KEYS_FILE,
        probeModel: model,
        byVerdict,
        byStatus,
        elapsedSec,
        // Только маски и статусы: тела ответов не для логов, креды не для отчётов.
        results: Object.fromEntries([...verdicts.entries()].map(([key, v]) => [maskKey(key), v])),
        written: false,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Отчёт: ${OUT}`);

  if (!WRITE) {
    if (deads.length > 0) console.log("\n(dry-run: пул ключей не изменён; чистка — npm run keys:cleanup-dead)");
    else console.log("\n(мёртвых нет — чистить нечего)");
    process.exit(0);
  }

  const plan = planKeyCleanup(entries);
  if (plan.refusal === "too-many-dead" && FORCE) {
    console.log(`\n! --force: игнорирую отказ «мёртвых слишком много» (${plan.droppedCount}/${plan.probedCount})`);
  } else if (plan.refusal) {
    console.error(
      plan.refusal === "too-many-dead"
        ? `\n✗ мёртвых больше половины (${plan.droppedCount}/${plan.probedCount}) — вероятнее сломался оракул, чем пул. Не пишу (override: --force)`
        : `\n✗ чистка опустошила бы пул — не пишу`,
    );
    process.exit(1);
  }
  if (plan.droppedCount === 0) {
    console.log("\nмёртвых нет — писать нечего");
    process.exit(0);
  }

  const keep = [...plan.keep, ...envRefs];
  const backup = `${KEYS_FILE}.bak-${Date.now()}`;
  copyFileSync(KEYS_FILE, backup);
  chmodSync(backup, 0o600);
  writeFileSync(KEYS_FILE, `${JSON.stringify({ keys: keep }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(KEYS_FILE, 0o600);
  console.log(`\n✓ пул ключей: ${parsed.keys.length} → ${keep.length} (−${plan.droppedCount})`);
  console.log(`  резерв: ${backup}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("fatal:", String(e.message ?? e).slice(0, 200));
  process.exit(1);
});
