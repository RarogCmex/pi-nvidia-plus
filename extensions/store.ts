/**
 * Файловый слой применения оверрайдов (чистая логика — в `merge-models.ts`).
 *
 * Пути (директива пользователя, тикет 05):
 *  - желаемые оверрайды: `overrides/models.json` в пакете;
 *  - цель применения: `~/.pi/agent/models.json` (единственный путь, который
 *    читает пи для метаданных);
 *  - леджер владения: `~/.pi/agent/nvidia-plus-models.json` — отдельный файл,
 *    чтобы не смешивать наши записи с пользовательскими;
 *  - перед каждой записью `models.json` создаётся бэкап `*.bak-pi-nvidia-plus`.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOverrides,
  mergeOwnedStates,
  rollbackOverrides,
  validateOverrides,
  type Conflict,
  type MergeSummary,
  type ModelsJson,
  type OwnedState,
} from "./merge-models.ts";

export const PROVIDER = "nvidia";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
export const OVERRIDES_FILE = join(EXT_DIR, "..", "overrides", "models.json");
export const MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");
export const STATE_FILE = join(homedir(), ".pi", "agent", "nvidia-plus-models.json");
export const BACKUP_FILE = `${MODELS_JSON}.bak-pi-nvidia-plus`;

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function backupModelsJson(): void {
  if (existsSync(MODELS_JSON)) copyFileSync(MODELS_JSON, BACKUP_FILE);
}

export function loadOverrides(): ModelsJson {
  const parsed = readJson(OVERRIDES_FILE);
  validateOverrides(parsed);
  const foreign = Object.keys(parsed.providers ?? {}).filter((p) => p !== PROVIDER);
  if (foreign.length > 0) {
    throw new Error(`overrides file contains foreign providers: ${foreign.join(", ")}`);
  }
  return parsed;
}

export function loadState(): OwnedState | undefined {
  const parsed = readJson(STATE_FILE);
  if (!parsed || typeof parsed !== "object") return undefined;
  const state = parsed as OwnedState;
  if (state.version !== 1 || !state.providers) return undefined;
  return state;
}

export interface ApplyFilesResult {
  changed: boolean;
  conflicts: Conflict[];
  summary: MergeSummary;
}

/**
 * Применить оверрайды к `models.json` и обновить леджер. Идемпотентно.
 * `overwrite: false` (автоприменение) — конфликтные записи пропускаются;
 * `overwrite: true` (явная команда с `force`) — перезаписываются.
 */
export function applyFiles(overwrite: boolean): ApplyFilesResult {
  const desired = loadOverrides();
  const target = (readJson(MODELS_JSON) ?? {}) as ModelsJson;
  const ledger = loadState();

  const outcome = applyOverrides(target, desired, ledger, overwrite);
  if (outcome.changed) {
    backupModelsJson();
    writeJson(MODELS_JSON, outcome.merged);
  }
  writeJson(STATE_FILE, mergeOwnedStates(ledger, outcome.state));
  return { changed: outcome.changed, conflicts: outcome.conflicts, summary: outcome.summary };
}

export interface RollbackFilesResult {
  changed: boolean;
  removed: string[];
  kept: Array<{ providerId: string; kind: "modelOverride" | "model"; modelId: string }>;
  hadState: boolean;
}

/** Откатить наши записи из `models.json` по леджеру. */
export function rollbackFiles(): RollbackFilesResult {
  const ledger = loadState();
  if (!ledger) return { changed: false, removed: [], kept: [], hadState: false };

  const target = (readJson(MODELS_JSON) ?? {}) as ModelsJson;
  const outcome = rollbackOverrides(target, ledger);
  if (outcome.changed) {
    backupModelsJson();
    writeJson(MODELS_JSON, outcome.merged);
  }
  // Откат гасит автоприменение: леджер сохраняется с `enabled: false`,
  // чтобы следующий `session_start` не вернул записи молча.
  writeJson(STATE_FILE, outcome.remainingState
    ? { ...outcome.remainingState, enabled: false }
    : { version: 1, appliedAt: new Date().toISOString(), enabled: false, providers: {} });

  return { changed: outcome.changed, removed: outcome.removed, kept: outcome.kept, hadState: true };
}
