/**
 * Чистый мерж оверрайдов pi-nvidia-plus в пользовательский `models.json`.
 *
 * Владение: расширение владеет только записями по `id`, которые присутствуют
 * в его оверрайд-файле (`source`):
 *  - `modelOverrides[id]` — запись собственного `id` заменяется целиком;
 *  - `models[]` — апсерт по `id` (свой заменяется, новый добавляется).
 * Всё остальное в `target` (другие провайдеры, чужие `id`, провайдер-уровневые
 * поля вроде `baseUrl`/`apiKey`) не трогается. Мерж идемпотентен:
 * `merge(merge(t, s), s)` глубоко равен `merge(t, s)`.
 *
 * В расширение входит только эта функция — покрыта `test/merge-models.test.ts`.
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Базовая валидация формы оверрайд-файла (схема пи: `providers.<id>`). */
export function validateOverrides(source: unknown): asserts source is ModelsJson {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("оверрайд-файл: ожидается объект { providers: ... }");
  }
  const providers = (source as ModelsJson).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("оверрайд-файл: нет провайдеров (providers)");
  }
  for (const [providerId, entry] of Object.entries(providers)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`оверрайд-файл: providers.${providerId} — не объект`);
    }
    for (const model of entry.models ?? []) {
      if (!model || typeof model.id !== "string" || model.id.length === 0) {
        throw new Error(`оверрайд-файл: у модели без id нет поля id (providers.${providerId}.models)`);
      }
    }
  }
}

export interface MergeSummary {
  providerIds: string[];
  overrideIds: string[];
  modelIds: string[];
}

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
