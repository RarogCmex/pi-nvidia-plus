/**
 * Чистые функции владения оверрайдами pi-nvidia-plus.
 *
 * Модель владения (директива пользователя, тикет 05):
 *  - желаемое состояние оверрайдов живёт отдельным файлом (`overrides/models.json`
 *    в пакете) и никогда не смешивается с пользовательским `models.json`;
 *  - применение — апсерт только собственных `id` (см. `mergeModelsJson`);
 *  - леджер применённого (`OwnedState`, хранится в `nvidia-plus-models.json`)
 *    позволяет отличить «изменил пользователь» от «обновился оверрайд-файл»
 *    и выдать предупреждения о конфликтах;
 *  - откат удаляет только записи, совпадающие с леджером; изменённые
 *    пользователем записи не трогаются (пропускаются с отчётом).
 *
 * Всё покрыто `test/merge-models.test.ts`; файловый слой — в `store.ts`.
 */

export interface ModelOverrideEntry {
  [key: string]: unknown;
}

export interface ProviderEntry {
  modelOverrides?: Record<string, ModelOverrideEntry>;
  models?: Array<{ id: string } & Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
  [key: string]: unknown;
}

export interface Conflict {
  providerId: string;
  kind: "modelOverride" | "model";
  modelId: string;
  reason: string;
}

export interface OwnedProviderState {
  modelOverrides: Record<string, ModelOverrideEntry>;
  models: Record<string, Record<string, unknown>>;
}

export interface OwnedState {
  version: 1;
  appliedAt: string;
  providers: Record<string, OwnedProviderState>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Глубокое сравнение без учёта порядка ключей. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    return arrA.every((v, i) => deepEqual(v, arrB[i]));
  }
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  const keysA = Object.keys(recA);
  const keysB = Object.keys(recB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => deepEqual(recA[k], recB[k]));
}

/** Базовая валидация формы оверрайд-файла (схема пи: `providers.<id>`). */
export function validateOverrides(source: unknown): asserts source is ModelsJson {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("overrides file: expected an object { providers: ... }");
  }
  const providers = (source as ModelsJson).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("overrides file: no providers");
  }
  for (const [providerId, entry] of Object.entries(providers)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`overrides file: providers.${providerId} is not an object`);
    }
    for (const model of entry.models ?? []) {
      if (!model || typeof model.id !== "string" || model.id.length === 0) {
        throw new Error(`overrides file: model without id (providers.${providerId}.models)`);
      }
    }
  }
}

export interface MergeSummary {
  providerIds: string[];
  overrideIds: string[];
  modelIds: string[];
}

/** Идемпотентный апсерт записей `source` в `target` (владение только своими `id`). */
export function mergeModelsJson(target: ModelsJson, source: ModelsJson): { merged: ModelsJson; summary: MergeSummary } {
  validateOverrides(source);
  const out: ModelsJson = clone(target ?? {});
  out.providers = out.providers ?? {};

  const summary: MergeSummary = { providerIds: [], overrideIds: [], modelIds: [] };

  for (const [providerId, sourceProvider] of Object.entries(source.providers ?? {})) {
    const src = sourceProvider ?? {};
    const dst: ProviderEntry = out.providers[providerId] ? clone(out.providers[providerId]) : {};

    const overrides = src.modelOverrides ?? {};
    const overrideIds = Object.keys(overrides);
    if (overrideIds.length > 0) {
      dst.modelOverrides = { ...(dst.modelOverrides ?? {}) };
      for (const id of overrideIds) {
        dst.modelOverrides[id] = clone(overrides[id]); // свой id — запись целиком наша
      }
      summary.overrideIds.push(...overrideIds.map((id) => `${providerId}/${id}`));
    }

    const srcModels = src.models ?? [];
    if (srcModels.length > 0) {
      const dstModels = Array.isArray(dst.models) ? clone(dst.models) : [];
      for (const srcModel of srcModels) {
        const copy = clone(srcModel);
        const index = dstModels.findIndex((m) => m?.id === srcModel.id);
        if (index >= 0) dstModels[index] = copy;
        else dstModels.push(copy);
        summary.modelIds.push(`${providerId}/${srcModel.id}`);
      }
      dst.models = dstModels;
    }

    out.providers[providerId] = dst;
    summary.providerIds.push(providerId);
  }

  return { merged: out, summary };
}

export interface ApplyOutcome {
  merged: ModelsJson;
  changed: boolean;
  conflicts: Conflict[];
  summary: MergeSummary;
  state: OwnedState;
}

/**
 * Применение желаемых оверрайдов к целевому `models.json` с детекцией конфликтов.
 * Конфликты не блокируют применение (мы владеем своими `id`), но сообщают,
 * что перезаписана чужая/изменённая запись.
 */
export function applyOverrides(target: ModelsJson, desired: ModelsJson, ledger: OwnedState | undefined): ApplyOutcome {
  validateOverrides(desired);
  const { merged, summary } = mergeModelsJson(target, desired);

  const conflicts: Conflict[] = [];
  for (const [providerId, prov] of Object.entries(desired.providers ?? {})) {
    const currentProvider = target.providers?.[providerId];
    const appliedProvider = ledger?.providers?.[providerId];

    for (const [modelId, value] of Object.entries(prov.modelOverrides ?? {})) {
      const current = currentProvider?.modelOverrides?.[modelId];
      if (current === undefined || deepEqual(current, value)) continue;
      const appliedBefore = appliedProvider?.modelOverrides[modelId];
      if (appliedBefore === undefined) {
        conflicts.push({
          providerId,
          kind: "modelOverride",
          modelId,
          reason: "pre-existing entry differs; overwritten by pi-nvidia-plus",
        });
      } else if (!deepEqual(current, appliedBefore)) {
        conflicts.push({
          providerId,
          kind: "modelOverride",
          modelId,
          reason: "entry was edited after last apply; overwritten by pi-nvidia-plus",
        });
      }
    }

    for (const model of prov.models ?? []) {
      const current = (currentProvider?.models ?? []).find((m) => m.id === model.id);
      if (current === undefined || deepEqual(current, model)) continue;
      const appliedBefore = appliedProvider?.models[model.id];
      if (appliedBefore === undefined) {
        conflicts.push({
          providerId,
          kind: "model",
          modelId: model.id,
          reason: "pre-existing entry differs; overwritten by pi-nvidia-plus",
        });
      } else if (!deepEqual(current, appliedBefore)) {
        conflicts.push({
          providerId,
          kind: "model",
          modelId: model.id,
          reason: "entry was edited after last apply; overwritten by pi-nvidia-plus",
        });
      }
    }
  }

  const state = buildOwnedState(desired);
  return { merged, changed: !deepEqual(merged, target), conflicts, summary, state };
}

function buildOwnedState(desired: ModelsJson): OwnedState {
  const providers: Record<string, OwnedProviderState> = {};
  for (const [providerId, prov] of Object.entries(desired.providers ?? {})) {
    const entry: OwnedProviderState = { modelOverrides: {}, models: {} };
    for (const [id, value] of Object.entries(prov.modelOverrides ?? {})) {
      entry.modelOverrides[id] = clone(value);
    }
    for (const model of prov.models ?? []) {
      entry.models[model.id] = clone(model);
    }
    providers[providerId] = entry;
  }
  return { version: 1, appliedAt: new Date().toISOString(), providers };
}

export interface RollbackOutcome {
  merged: ModelsJson;
  changed: boolean;
  removed: string[];
  kept: Array<{ providerId: string; kind: "modelOverride" | "model"; modelId: string }>;
  remainingState: OwnedState | undefined;
}

/**
 * Откат: удаляет из `target` только записи, совпадающие с леджером.
 * Изменённые пользователем записи пропускаются (попадают в `kept`),
 * леджер сохраняет их как всё ещё наши.
 */
export function rollbackOverrides(target: ModelsJson, ledger: OwnedState): RollbackOutcome {
  const merged: ModelsJson = clone(target ?? {});
  const removed: string[] = [];
  const kept: RollbackOutcome["kept"] = [];
  const remainingProviders: Record<string, OwnedProviderState> = {};

  for (const [providerId, stateProvider] of Object.entries(ledger.providers ?? {})) {
    const dst = merged.providers?.[providerId];
    const remaining: OwnedProviderState = { modelOverrides: {}, models: {} };

    for (const [modelId, stateValue] of Object.entries(stateProvider.modelOverrides ?? {})) {
      const current = dst?.modelOverrides?.[modelId];
      if (current === undefined) continue; // уже удалена
      if (deepEqual(current, stateValue)) {
        delete dst!.modelOverrides![modelId];
        removed.push(`${providerId}/modelOverrides/${modelId}`);
      } else {
        kept.push({ providerId, kind: "modelOverride", modelId });
        remaining.modelOverrides[modelId] = clone(stateValue);
      }
    }
    if (dst?.modelOverrides && Object.keys(dst.modelOverrides).length === 0) delete dst.modelOverrides;

    for (const [modelId, stateValue] of Object.entries(stateProvider.models ?? {})) {
      const models = dst?.models;
      const index = Array.isArray(models) ? models.findIndex((m) => m.id === modelId) : -1;
      if (index < 0) continue; // уже удалена
      if (deepEqual(models![index], stateValue)) {
        models!.splice(index, 1);
        removed.push(`${providerId}/models/${modelId}`);
      } else {
        kept.push({ providerId, kind: "model", modelId });
        remaining.models[modelId] = clone(stateValue);
      }
    }
    if (dst?.models && dst.models.length === 0) delete dst.models;

    if (dst && Object.keys(dst).length === 0 && merged.providers) delete merged.providers[providerId];

    if (Object.keys(remaining.modelOverrides).length > 0 || Object.keys(remaining.models).length > 0) {
      remainingProviders[providerId] = remaining;
    }
  }

  const remainingState: OwnedState | undefined =
    Object.keys(remainingProviders).length > 0
      ? { version: 1, appliedAt: new Date().toISOString(), providers: remainingProviders }
      : undefined;

  return { merged, changed: !deepEqual(merged, target), removed, kept, remainingState };
}
