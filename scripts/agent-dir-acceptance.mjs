#!/usr/bin/env node
/**
 * Приёмка класса F2: расширение обязано писать в тот каталог конфига, куда
 * смотрит запущенный пи (`$PI_CODING_AGENT_DIR`), а не в зашитый `~/.pi/agent`.
 *
 * Зачем это отдельно от юнит-тестов. `test/store.test.ts` (блок 1b) подменяет
 * `$PI_CODING_AGENT_DIR` и проверяет, что `agentFile()`/`storePaths()` резолвят
 * пути от него — но он не запускает пи и ничего не пишет на диск. Реальный
 * дефект (до v0.2.2 здесь был `homedir() + ".pi/agent"`) выглядел иначе: пути в
 * юните резолвились правильно, а боевой прогон с нестандартным каталогом клал
 * оверрайды мимо изолированного пи **и задевал чужой дефолтный каталог**. Такой
 * класс ловится только запуском настоящего `pi` с настоящим хуком и проверкой
 * того, что появилось на диске.
 *
 * Что проверяется (четыре утверждения, все обязательны):
 *   1. контроль: прогон `pi` БЕЗ расширения не создаёт ни `models.json`, ни
 *      `nvidia-plus-models.json` — иначе утверждения 2–3 могли бы пройти «сами»;
 *   2. с расширением в `$PI_CODING_AGENT_DIR` появляется леджер владения
 *      (`enabled: true`, номер версии);
 *   3. там же появляется `models.json`, и число применённых оверрайдов равно
 *      числу оверрайдов в `overrides/models.json` репозитория (сверка с
 *      источником, а не захардкоженная константа: добавили оверрайд — приёмка
 *      по-прежнему проходит, потеряли при применении — покраснеет);
 *   4. дефолтный каталог (`$HOME/.pi/agent`) не изменился: ни новых файлов, ни
 *      изменённых (снимок имя+размер+mtime до и после).
 *
 * `--offline`: применение оверрайдов сети не требует. Измерено 2026-10-01 —
 * вывод `pi --list-models nvidia` с `--offline` и без него совпадает побайтово,
 * файлы те же (10 оверрайдов, `enabled: true`). Детерминированный шаг не зависит
 * от доступности шлюза с раннера и не тратит ключ.
 *
 * Использование (каталог — одноразовый, не настоящий `~/.pi/agent`):
 *   PI_CODING_AGENT_DIR=$(mktemp -d) node scripts/agent-dir-acceptance.mjs
 * В CI это `$RUNNER_TEMP/...`; шаг называется «Acceptance — agent dir».
 *
 * Защита от запуска на живом конфиге: если `$PI_CODING_AGENT_DIR` не задан или
 * совпадает/пересекается с дефолтным каталогом, скрипт отказывается стартовать
 * (иначе он сам перезаписал бы пользовательский `models.json`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = join(REPO, "extensions", "pi-nvidia-plus.ts");
const OVERRIDES_FILE = join(REPO, "overrides", "models.json");
const PI_BIN = process.env.PI_BIN ?? "pi";
const LEDGER = "nvidia-plus-models.json";
const MODELS_JSON = "models.json";

function fail(message) {
  console.error(`\n✗ agent-dir-acceptance: ${message}`);
  process.exit(1);
}

// --- 0. охрана: не запускать на настоящем каталоге пользователя ---------------

const agentDir = process.env.PI_CODING_AGENT_DIR;
const defaultDir = join(homedir(), ".pi", "agent");

if (!agentDir) {
  fail(
    "PI_CODING_AGENT_DIR не задан. Приёмка меряет именно нестандартный каталог —\n" +
      "  задайте одноразовый:  PI_CODING_AGENT_DIR=$(mktemp -d) node scripts/agent-dir-acceptance.mjs",
  );
}
const absAgent = resolve(agentDir);
const absDefault = resolve(defaultDir);
const overlaps =
  absAgent === absDefault ||
  absAgent.startsWith(absDefault + sep) ||
  absDefault.startsWith(absAgent + sep);
if (overlaps) {
  fail(
    `PI_CODING_AGENT_DIR (${absAgent}) пересекается с дефолтным каталогом (${absDefault}).\n` +
      "  Прогон перезаписал бы настоящий models.json — укажите одноразовый каталог.",
  );
}
if (!existsSync(EXTENSION)) fail(`не найден файл расширения: ${EXTENSION}`);

const controlDir = `${absAgent.replace(/\/+$/, "")}-control`;
mkdirSync(absAgent, { recursive: true });
mkdirSync(controlDir, { recursive: true });
mkdirSync(absDefault, { recursive: true });

console.log("=== 0. Что меряем ===");
console.log(`  расширение:      ${EXTENSION}`);
console.log(`  PI_CODING_AGENT_DIR: ${absAgent}`);
console.log(`  контроль (без расширения): ${controlDir}`);
console.log(`  дефолтный каталог: ${absDefault} (должен остаться нетронутым)`);
console.log(`  pi:              ${PI_BIN}`);

// --- снимок дефолтного каталога ----------------------------------------------

function snapshot(dir) {
  if (!existsSync(dir)) return new Map();
  const out = new Map();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const st = statSync(full);
    out.set(full.slice(dir.length), `${st.size}:${Math.floor(st.mtimeMs)}`);
  }
  return out;
}

const beforeDefault = snapshot(absDefault);

// --- запуск пи ---------------------------------------------------------------

function runPi(cwdAgentDir, withExtension) {
  const args = ["--offline", "-ne", "-ns", "-np", "-nc"];
  if (withExtension) args.push("-e", EXTENSION);
  args.push("--list-models", "nvidia");
  try {
    const stdout = execFileSync(PI_BIN, args, {
      cwd: REPO,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: cwdAgentDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      message: error.message,
    };
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}\n  ${String(detail).replace(/\n/g, "\n  ")}`);
}

console.log("\n=== 1. Контроль: пи без расширения ===");
const control = runPi(controlDir, false);
const controlFiles = existsSync(controlDir) ? readdirSync(controlDir).sort() : [];
check(
  "контрольный прогон не создаёт ни models.json, ни леджер",
  control.ok &&
    !controlFiles.includes(MODELS_JSON) &&
    !controlFiles.includes(LEDGER),
  `pi exit: ${control.ok ? 0 : "non-zero"}; файлы в каталоге: ${controlFiles.join(", ") || "(пусто)"}\n` +
    "(если здесь появился models.json — его пишет сам пи, и утверждения ниже ничего не доказывают)",
);

console.log("\n=== 2. Прогон с расширением ===");
const run = runPi(absAgent, true);
if (!run.ok) {
  console.error(run.stdout.slice(0, 2000));
  fail(
    `pi завершился ошибкой: ${run.message}\n` +
      "  Если пи перестал запускать session_start на --list-models, приёмку надо\n" +
      "  перевести на `pi -p` — но сначала убедитесь, что дело не в расширении.",
  );
}

const agentFiles = readdirSync(absAgent).sort();
const ledgerPath = join(absAgent, LEDGER);
const modelsPath = join(absAgent, MODELS_JSON);

let ledger = null;
try {
  ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
} catch {
  ledger = null;
}
check(
  "леджер владения появился в PI_CODING_AGENT_DIR",
  !!ledger && ledger.enabled === true && typeof ledger.version === "number",
  `файлы: ${agentFiles.join(", ")}\n` +
    (ledger ? `enabled: ${ledger.enabled}, version: ${ledger.version}` : `${LEDGER} отсутствует или не читается`),
);

const wantOverrides = (() => {
  try {
    const source = JSON.parse(readFileSync(OVERRIDES_FILE, "utf8"));
    return Object.keys(source?.providers?.nvidia?.modelOverrides ?? {}).length;
  } catch {
    return NaN;
  }
})();
const applied = (() => {
  try {
    const target = JSON.parse(readFileSync(modelsPath, "utf8"));
    return Object.keys(target?.providers?.nvidia?.modelOverrides ?? {}).length;
  } catch {
    return NaN;
  }
})();
check(
  "в models.json применены все оверрайды из overrides/models.json",
  Number.isFinite(wantOverrides) && wantOverrides > 0 && wantOverrides === applied,
  `в репозитории: ${wantOverrides}, применено: ${applied}\nпуть: ${modelsPath}`,
);

console.log("\n=== 3. Дефолтный каталог не тронут ===");
const afterDefault = snapshot(absDefault);
const created = [...afterDefault.keys()].filter((k) => !beforeDefault.has(k));
const changed = [...afterDefault.keys()].filter(
  (k) => beforeDefault.has(k) && beforeDefault.get(k) !== afterDefault.get(k),
);
check(
  "в ~/.pi/agent не появилось и не изменилось ни одного файла",
  created.length === 0 && changed.length === 0,
  `новых: ${created.length}${created.length ? ` (${created.join(", ")})` : ""}, ` +
    `изменённых: ${changed.length}${changed.length ? ` (${changed.join(", ")})` : ""}\n` +
    "(именно так выглядел дефект до v0.2.2: зашитый homedir() писал мимо изолированного пи)",
);

// --- итог --------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} утверждений пройдено.`);
if (failed.length > 0) {
  console.error(`\n✗ ${failed.length} FAILED: ${failed.map((f) => f.name).join("; ")}`);
  process.exit(1);
}
console.log("✓ приёмка F2 пройдена: расширение пишет только в каталог, который указал пи.");
