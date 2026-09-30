/**
 * Файловый слой применения оверрайдов (чистая логика — в `merge-models.ts`).
 *
 * Пути (директива пользователя, тикет 05):
 *  - желаемые оверрайды: `overrides/models.json` в пакете;
 *  - цель применения: `<agentDir>/models.json` (единственный путь, который
 *    читает пи для метаданных);
 *  - леджер владения: `<agentDir>/nvidia-plus-models.json` — отдельный файл,
 *    чтобы не смешивать наши записи с пользовательскими;
 *  - перед каждой записью `models.json` создаётся бэкап `*.bak-pi-nvidia-plus`.
 *
 * `agentDir` — каталог конфига пи (`getAgentDir()`): `~/.pi/agent` по умолчанию и
 * `$PI_CODING_AGENT_DIR`, если он задан. Так его резолвит сам пи (`getModelsPath()`
 * в его `config.ts`), поэтому зашитый `homedir() + ".pi/agent"` был ошибкой: при
 * нестандартном каталоге оверрайды ложились туда, куда запущенный пи не смотрит,
 * и задевали чужой дефолтный каталог. Измерено 2026-09-30: прогон с
 * `PI_CODING_AGENT_DIR=/tmp/…` не создал там `models.json`, а список моделей
 * `nvidia` не отличался от запуска без расширения.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  applyOverrides,
  mergeModelsJson,
  rollbackOverrides,
  validateOverrides,
  type Conflict,
  type MergeSummary,
  type ModelsJson,
  type OwnedState,
} from "./merge-models.ts";

export const PROVIDER = "nvidia";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OVERRIDES_FILE = join(EXT_DIR, "..", "overrides", "models.json");

/** Файл в каталоге конфига пи. Резолвится при каждом вызове, а не на импорте:
 *  `$PI_CODING_AGENT_DIR` может быть задан позже (тесты), а rebranded-дистрибуция
 *  меняет `CONFIG_DIR_NAME`. */
export function agentFile(name: string): string {
  return join(getAgentDir(), name);
}

/** Шов C: пути файлового слоя — параметром, дефолты для боевого запуска. */
export interface StorePaths {
  overridesFile: string;
  modelsJson: string;
  stateFile: string;
  backupFile: string;
  /** Файл живого обнаружения (тикет 12): найденные модели + отчёт. */
  discoveredFile: string;
}

export function storePaths(baseDir: string = getAgentDir(), overridesFile: string = DEFAULT_OVERRIDES_FILE): StorePaths {
  const modelsJson = join(baseDir, "models.json");
  return {
    overridesFile,
    modelsJson,
    stateFile: join(baseDir, "nvidia-plus-models.json"),
    backupFile: `${modelsJson}.bak-pi-nvidia-plus`,
    discoveredFile: join(baseDir, "nvidia-plus-discovered.json"),
  };
}

// Пути для сообщений пользователю — функциями, а не константами уровня модуля:
// сообщение обязано называть тот каталог, который читает ЗАПУЩЕННЫЙ пи, а не
// снимок, снятый на импорте.
export function modelsJsonPath(): string {
  return storePaths().modelsJson;
}
export function stateFilePath(): string {
  return storePaths().stateFile;
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function backupModelsJson(paths: StorePaths): void {
  if (existsSync(paths.modelsJson)) copyFileSync(paths.modelsJson, paths.backupFile);
}

export function loadOverrides(paths: StorePaths = storePaths()): ModelsJson {
  const parsed = readJson(paths.overridesFile);
  validateOverrides(parsed);
  const foreign = Object.keys(parsed.providers ?? {}).filter((p) => p !== PROVIDER);
  if (foreign.length > 0) {
    throw new Error(`overrides file contains foreign providers: ${foreign.join(", ")}`);
  }
  return parsed;
}

export function loadState(paths: StorePaths = storePaths()): OwnedState | undefined {
  const parsed = readJson(paths.stateFile);
  if (!parsed || typeof parsed !== "object") return undefined;
  const state = parsed as OwnedState;
  if (state.version !== 1 || !state.providers) return undefined;
  return state;
}

export interface ApplyFilesResult {
  changed: boolean;
  conflicts: Conflict[];
  summary: MergeSummary;
  /** Устаревшие записи, удалённые при применении (убраны из оверрайд-файла). */
  pruned: string[];
}

// ── Живое обнаружение (тикет 12) ──────────────────────────────────────────
export interface DiscoveryReport {
  discoveredAt: string;
  live: number;
  chat: string[];
  nonChat: string[];
  /** Известные модели, отсутствующие в живом списке и не помеченные мёртвыми. */
  missingKnown: string[];
}

export interface DiscoveredFile {
  /** Новые чат-модели, добавляемые в `models.json` тем же механизмом владения. */
  models?: Array<{ id: string; name?: string }>;
  report?: DiscoveryReport;
}

export function loadDiscovered(paths: StorePaths = storePaths()): { desired: ModelsJson; report?: DiscoveryReport } {
  const parsed = readJson(paths.discoveredFile) as DiscoveredFile | undefined;
  if (!parsed || typeof parsed !== "object") return { desired: {} };
  const models = Array.isArray(parsed.models)
    ? parsed.models.filter((m): m is { id: string; name?: string } => !!m && typeof m.id === "string" && m.id.length > 0)
    : [];
  const desired: ModelsJson = models.length > 0 ? { providers: { [PROVIDER]: { models } } } : {};
  return { desired, report: parsed.report };
}

export function writeDiscovered(file: DiscoveredFile, paths: StorePaths = storePaths()): void {
  writeJson(paths.discoveredFile, file);
}

export function loadDiscoveryReport(paths: StorePaths = storePaths()): DiscoveryReport | undefined {
  return loadDiscovered(paths).report;
}

/**
 * Применить оверрайды к `models.json` и обновить леджер. Идемпотентно.
 * Желаемое состояние — оверрайд-файл пакета плюс найденные живым обнаружением
 * модели; обе части под одним леджером владения.
 * `overwrite: false` (автоприменение) — конфликтные записи пропускаются;
 * `overwrite: true` (явная команда с `force`) — перезаписываются.
 */
export function applyFiles(overwrite: boolean, paths: StorePaths = storePaths()): ApplyFilesResult {
  const overrides = loadOverrides(paths);
  const discovered = loadDiscovered(paths).desired;
  const desired = discovered.providers ? mergeModelsJson(overrides, discovered).merged : overrides;
  const target = (readJson(paths.modelsJson) ?? {}) as ModelsJson;
  const ledger = loadState(paths);

  const outcome = applyOverrides(target, desired, ledger, overwrite);
  if (outcome.changed) {
    backupModelsJson(paths);
    writeJson(paths.modelsJson, outcome.merged);
  }
  writeJson(paths.stateFile, { ...outcome.state, enabled: true });
  return { changed: outcome.changed, conflicts: outcome.conflicts, summary: outcome.summary, pruned: outcome.pruned };
}

export interface RollbackFilesResult {
  changed: boolean;
  removed: string[];
  kept: Array<{ providerId: string; kind: "modelOverride" | "model"; modelId: string }>;
  hadState: boolean;
}

/** Откатить наши записи из `models.json` по леджеру. */
export function rollbackFiles(paths: StorePaths = storePaths()): RollbackFilesResult {
  const ledger = loadState(paths);
  if (!ledger) return { changed: false, removed: [], kept: [], hadState: false };

  const target = (readJson(paths.modelsJson) ?? {}) as ModelsJson;
  const outcome = rollbackOverrides(target, ledger);
  if (outcome.changed) {
    backupModelsJson(paths);
    writeJson(paths.modelsJson, outcome.merged);
  }
  // Откат гасит автоприменение: леджер сохраняется с `enabled: false`,
  // чтобы следующий `session_start` не вернул записи молча.
  writeJson(paths.stateFile, outcome.remainingState
    ? { ...outcome.remainingState, enabled: false }
    : { version: 1, appliedAt: new Date().toISOString(), enabled: false, providers: {} });

  return { changed: outcome.changed, removed: outcome.removed, kept: outcome.kept, hadState: true };
}
