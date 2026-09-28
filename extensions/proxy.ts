/**
 * Выборочный диспетчер для провайдера `nvidia`: запросы к
 * `https://integrate.api.nvidia.com` идут через прокси (`NVIDIA_NIM_PROXY`),
 * весь остальной трафик делегируется прежнему глобальному диспетчеру пи.
 *
 * Модуль чистый: undici не импортируется — диспетчер-родитель, прокси-агент
 * и глобальный реестр инжектируются вызывающим кодом (входная точка берёт
 * экземпляр undici самого пи). Наблюдение за ответами в обёртке даёт
 * диагностику 429/5xx, которую не видно хуку `after_provider_response`
 * (он стреляет только после успешного ретрай-цикла).
 *
 * Референс: `research/04-proxy-mechanics.md` (вариант A).
 */
import { KeyRotator, maskKey, type RotationRequest } from "./keys.ts";
import { t } from "./i18n.ts";
import {
  PROXY_QUARANTINE_MS,
  isConnectClassError,
  maskProxy,
  redactProxyCredentials,
  type ProxyPick,
  type ProxyRotator,
} from "./proxy-pool.ts";

export const NVIDIA_ORIGIN = "https://integrate.api.nvidia.com";

export interface ParsedProxy {
  url?: URL;
  error?: string;
}

/**
 * Разбор `NVIDIA_NIM_PROXY` (легаси-одиночка). Без схемы подразумевается
 * `http://`; допустимые схемы — http/https (HTTP CONNECT) и socks5/socks5h/
 * socks (нативный Socks5ProxyAgent ундичи 8.9+, тикет 05); socks5h
 * нормализуется в socks5. Прочее — понятная ошибка разбора, называющая
 * переменную (тикет 18).
 */
export function parseProxyUrl(raw: string | undefined): ParsedProxy {
  const value = raw?.trim();
  if (!value) return {};
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  // Значение может нести userinfo (пароль прокси) — в сообщении об ошибке
  // показываем только redacted-форму (story 39: креденшелы не покидают шов).
  const shown = redactProxyCredentials(value);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: t("proxyParseError", { value: shown }) };
  }
  if (url.protocol === "socks5h:") url.protocol = "socks5:";
  const allowed = new Set(["http:", "https:", "socks5:", "socks:"]);
  if (!allowed.has(url.protocol)) {
    return { error: t("proxyLegacySchemeError", { scheme: url.protocol.replace(/:$/, ""), value: shown }) };
  }
  return { url };
}

/** Маршрутизация только точного начала `https://integrate.api.nvidia.com`. */
export function isNvidiaOrigin(origin: unknown): boolean {
  if (origin === undefined || origin === null) return false;
  try {
    return new URL(origin.toString()).origin === NVIDIA_ORIGIN;
  } catch {
    return false;
  }
}

/** Заголовки из плоского массива ундичи `[k1, v1, k2, v2]` или объекта (`parseHeaders`); ключи в нижний регистр, массивы значений склеиваются. */
export function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: unknown, value: unknown): void => {
    if (typeof key !== "string") return;
    if (typeof value === "string") {
      out[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      const parts = value.filter((v): v is string => typeof v === "string");
      if (parts.length > 0) out[key.toLowerCase()] = parts.join(", ");
    }
  };
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) put(headers[i], headers[i + 1]);
  } else if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) put(key, value);
  }
  return out;
}

export interface NimDiagnostic {
  status: number;
  retryAfterMs?: number;
  requestId?: string;
  observedAt: number;
}

const REQUEST_ID_HEADERS = ["x-request-id", "x-nvidia-request-id", "nv-api-request-id", "nvcf-request-id"];

function parseRetryAfterMs(headers: Record<string, string>, now: number): number | undefined {
  const ms = headers["retry-after-ms"];
  if (ms !== undefined) {
    const value = Number.parseFloat(ms);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const raw = headers["retry-after"];
  if (raw === undefined) return undefined;
  const seconds = Number.parseFloat(raw);
  if (!Number.isNaN(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function findRequestId(headers: Record<string, string>): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    if (headers[name]) return headers[name];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (/request-?id$/i.test(key)) return value;
  }
  return undefined;
}

/** Диагностика ответов 429 и 5xx: задержка повтора и идентификатор запроса. */
export function extractDiagnostics(status: number, headers: Record<string, string>, now = Date.now()): NimDiagnostic | undefined {
  if (status !== 429 && (status < 500 || status > 599)) return undefined;
  return {
    status,
    retryAfterMs: parseRetryAfterMs(headers, now),
    requestId: findRequestId(headers),
    observedAt: now,
  };
}

export function formatDiagnostic(d: NimDiagnostic): string {
  const retry = d.retryAfterMs !== undefined ? t("diagRetryIn", { seconds: Math.max(1, Math.round(d.retryAfterMs / 1000)) }) : "";
  const request = d.requestId ? t("diagRequestId", { id: d.requestId }) : "";
  if (d.status === 429) return t("diagRateLimit", { retry, request });
  return t("diagServerError", { status: d.status, retry, request });
}

/**
 * CONNECT-класс ошибок прокси. Делегирует единому классификатору шва пула
 * (включая EHOSTUNREACH/ENETUNREACH свежего коннекта — симптом из A/B
 * тикета 30 — и разворачивание `cause`/AggregateError): кольцо и `proxy
 * check` обязаны карантинить один и тот же класс, иначе проба наказывает
 * выход, который живой dispatch счёл бы рабочим (и наоборот).
 */
export function isProxyConnectError(err: unknown): boolean {
  return isConnectClassError(err);
}

/** Понятная ошибка при недоступном прокси. */
export function describeProxyFailure(proxyUrl: string, cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const detail = code ?? (cause instanceof Error ? cause.message : String(cause));
  return t("proxyUnreachable", { url: proxyUrl, detail });
}

/**
 * Понятная ошибка при недоступном эндпоинте пула: именует display identity
 * (`host:port`), никогда credentialed URL — иначе ротация пароля утекла бы в
 * уведомление/лог (story 39). `detail` — код соединения.
 */
export function describeEndpointFailure(display: string, cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const detail = code ?? (cause instanceof Error ? cause.message : String(cause));
  return t("proxyEndpointUnreachable", { url: display, detail });
}

export interface DispatchTarget {
  dispatch(opts: unknown, handler: unknown): boolean;
}

/* ------------------------------------------------------------------ */
/* Ротация ключей NIM (тикет 15)                                        */
/* ------------------------------------------------------------------ */

/** Кулдаун ключа без `retry-after`, потолок и пол (рейт-лимиты NIM плавают). */
export const DEFAULT_ROTATION_COOLDOWN_MS = 30_000;
export const MAX_ROTATION_COOLDOWN_MS = 300_000;
export const MIN_ROTATION_COOLDOWN_MS = 2_000;

/** Ключ из заголовка `Authorization: Bearer …` (форма пи). */
export function extractBearerKey(headers: unknown): string | undefined {
  const auth = headersToRecord(headers).authorization;
  if (!auth) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const key = match?.[1]?.trim();
  return key ? key : undefined;
}

/** Заменяет (или добавляет) `Authorization` на `Bearer <ключ>`; форма заголовков сохраняется. */
export function withAuthorization(headers: unknown, key: string): unknown {
  const value = `Bearer ${key}`;
  if (Array.isArray(headers)) {
    const out: unknown[] = [];
    let replaced = false;
    for (let i = 0; i + 1 < headers.length; i += 2) {
      const name = headers[i];
      if (typeof name === "string" && name.toLowerCase() === "authorization") {
        out.push(name, value);
        replaced = true;
      } else {
        out.push(name, headers[i + 1]);
      }
    }
    if (!replaced) out.push("authorization", value);
    return out;
  }
  if (headers && typeof headers === "object") {
    const out: Record<string, unknown> = {};
    let replaced = false;
    for (const [name, entry] of Object.entries(headers as Record<string, unknown>)) {
      if (name.toLowerCase() === "authorization") {
        out[name] = value;
        replaced = true;
      } else {
        out[name] = entry;
      }
    }
    if (!replaced) out.authorization = value;
    return out;
  }
  return { authorization: value };
}

/** Кулдаун ключа по заголовкам 429: `retry-after` есть — он (но не ниже пола), нет — дефолт; всегда под капом. */
export function resolveCooldownMs(
  headers: Record<string, string>,
  config: { defaultCooldownMs?: number; maxCooldownMs?: number; minCooldownMs?: number } = {},
  now: number = Date.now(),
): number {
  const retryAfterMs = extractDiagnostics(429, headers, now)?.retryAfterMs;
  const floor = config.minCooldownMs ?? MIN_ROTATION_COOLDOWN_MS;
  const base = retryAfterMs ?? config.defaultCooldownMs ?? DEFAULT_ROTATION_COOLDOWN_MS;
  const cap = config.maxCooldownMs ?? MAX_ROTATION_COOLDOWN_MS;
  return Math.max(floor, Math.min(base, cap));
}

/**
 * Стабильный контроллер запроса (приём из штатного повторителя ундичи): один на
 * все попытки ротации, пробрасывает паузу/резюм/аборт контроллеру текущего
 * соединения. Точка приёма аборта пользователя: феррь зовёт `abort` именно сюда.
 */
export class RotationController {
  target: {
    pause?: () => void;
    resume?: () => void;
    abort?: (reason?: unknown) => void;
    paused?: boolean;
    rawHeaders?: unknown;
  } | null = null;
  /** `onRequestStart` проброшен вниз один раз на запрос. */
  forwardedStart = false;
  private _aborted = false;
  private _reason: unknown = null;
  private abortListeners = new Set<() => void>();

  pause(): void {
    this.target?.pause?.();
  }
  resume(): void {
    this.target?.resume?.();
  }
  get paused(): boolean {
    return this.target?.paused ?? false;
  }
  get aborted(): boolean {
    return this._aborted;
  }
  get reason(): unknown {
    return this._reason;
  }
  get rawHeaders(): unknown {
    return this.target?.rawHeaders ?? null;
  }
  abort(reason?: unknown): void {
    if (this._aborted) return;
    this._aborted = true;
    this._reason = reason;
    for (const listener of [...this.abortListeners]) listener();
    this.abortListeners.clear();
    this.target?.abort?.(reason);
  }
  onAbortEvent(listener: () => void): () => void {
    if (this._aborted) {
      listener();
      return () => {};
    }
    this.abortListeners.add(listener);
    return () => this.abortListeners.delete(listener);
  }
}

export function interruptibleDelay(ms: number, controller: RotationController): Promise<boolean> {
  if (controller.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = controller.onAbortEvent(() => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    });
    timer = setTimeout(() => {
      off();
      resolve(false);
    }, ms);
  });
}

export interface BufferedRotationResponse {
  status: number;
  headers: Record<string, string>;
  statusMessage: unknown;
  chunks: Uint8Array[];
  trailers: unknown;
}

type RotationAttemptOutcome =
  | { type: "buffered"; response: BufferedRotationResponse }
  | { type: "delivered" }
  | { type: "error"; error: unknown };

/** Статусы, при которых ответ буферизуется и ключ может смениться. */
const ROTATABLE_STATUSES = new Set([429, 401, 403]);

/**
 * Хендлер одной попытки: ротируемые статусы буферизует (ответ небольшой),
 * остальное стримит в настоящий хендлер без задержки. Новый протокол ундичи 8 —
   другой в диспетчерах ундичи и не принимается.
 */
/** Позвать метод настоящего хендлера (если есть); `this` — сам хендлер. */
export function callHandlerMethod(real: Record<string, unknown> | null, name: string, ...args: unknown[]): unknown {
  const fn = real?.[name];
  if (typeof fn !== "function") return undefined;
  return (fn as (...a: unknown[]) => unknown).apply(real, args);
}

/** Делегирование close/destroy внутренней цели. */
function forwardLifecycle(target: DispatchTarget): Pick<SelectiveDispatcherHandle, "close" | "destroy"> {
  return {
    close(): Promise<void> {
      return Promise.resolve((target as { close?: () => Promise<void> }).close?.());
    },
    destroy(): Promise<void> {
      return Promise.resolve((target as { destroy?: () => Promise<void> }).destroy?.());
    },
  };
}

function makeRotationAttemptHandler(
  real: Record<string, unknown> | null,
  controller: RotationController,
  settle: (outcome: RotationAttemptOutcome) => void,
): Record<string, unknown> {
  let mode: "pending" | "buffering" | "streaming" = "pending";
  let buffered: BufferedRotationResponse | undefined;
  let settled = false;
  const finish = (outcome: RotationAttemptOutcome): void => {
    if (settled) return;
    settled = true;
    settle(outcome);
  };
  const call = (name: string, ...args: unknown[]): unknown => callHandlerMethod(real, name, ...args);
  return {
    onRequestStart(conn: unknown, context: unknown) {
      controller.target = conn as never;
      if (!controller.forwardedStart && typeof real?.onRequestStart === "function") {
        controller.forwardedStart = true;
        call("onRequestStart", controller, context);
      }
    },
    onResponseStarted() {
      if (mode === "streaming") call("onResponseStarted");
      // в буферизации не зовём: ответ может быть выброшен при смене ключа
    },
    onResponseStart(conn: unknown, status: number, headers: unknown, statusMessage: unknown) {
      controller.target = conn as never;
      if (ROTATABLE_STATUSES.has(status)) {
        mode = "buffering";
        buffered = { status, headers: headersToRecord(headers), statusMessage, chunks: [], trailers: undefined };
        return;
      }
      mode = "streaming";
      finish({ type: "delivered" });
      call("onResponseStart", controller, status, headers, statusMessage);
    },
    onResponseData(_conn: unknown, chunk: unknown) {
      if (mode === "streaming") return call("onResponseData", controller, chunk);
      if (mode === "buffering" && buffered) {
        buffered.chunks.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)));
      }
      return undefined;
    },
    onResponseEnd(trailers: unknown) {
      if (mode === "streaming") return call("onResponseEnd", controller, trailers);
      if (mode === "buffering" && buffered) {
        buffered.trailers = trailers;
        finish({ type: "buffered", response: buffered });
      }
      return undefined;
    },
    onResponseError(conn: unknown, err: unknown) {
      if (conn) controller.target = conn as never;
      if (mode === "streaming") {
        call("onResponseError", controller, err);
        return;
      }
      finish({ type: "error", error: err });
    },
    onRequestUpgrade(conn: unknown, status: number, headers: unknown, socket: unknown) {
      controller.target = conn as never;
      mode = "streaming";
      finish({ type: "delivered" });
      return call("onRequestUpgrade", controller, status, headers, socket);
    },
  };
}

function dispatchRotationAttempt(
  target: DispatchTarget,
  opts: Record<string, unknown>,
  controller: RotationController,
  real: Record<string, unknown> | null,
): Promise<RotationAttemptOutcome> {
  return new Promise((resolve) => {
    const handler = makeRotationAttemptHandler(real, controller, resolve);
    try {
      target.dispatch(opts, handler);
    } catch (err) {
      resolve({ type: "error", error: err });
    }
  });
}

function deliverBufferedResponse(real: Record<string, unknown> | null, controller: RotationController, response: BufferedRotationResponse): void {
  if (!real) return;
  try {
    callHandlerMethod(real, "onResponseStarted");
    callHandlerMethod(real, "onResponseStart", controller, response.status, response.headers, response.statusMessage);
    for (const chunk of response.chunks) callHandlerMethod(real, "onResponseData", controller, chunk);
    callHandlerMethod(real, "onResponseEnd", controller, response.trailers ?? {});
  } catch {
    // отдача не должна ронять цикл ротации
  }
}

function deliverHandlerError(real: Record<string, unknown> | null, controller: RotationController, err: unknown): void {
  if (!real) return;
  try {
    callHandlerMethod(real, "onResponseError", controller, err);
  } catch {
    // отдача не должна ронять цикл ротации
  }
}

export interface RotationLayerOptions {
  /** Сессионное состояние выбора ключей. */
  rotator: KeyRotator;
  /** Пул из файла/окружения (без ключа пи); зовётся на каждый запрос — горячая перезагрузка. */
  getPoolKeys(): string[];
  /** Аварийный выключатель (окружение + команда живой сессии). */
  enabled(): boolean;
  now?: () => number;
  defaultCooldownMs?: number;
  maxCooldownMs?: number;
  /** Ключ сменился (уведомление входной точки; маскировка — там). */
  onSwitch?: (info: { from: string; to: string; status: number }) => void;
  /** Ключ умер 401/403. */
  onDeadKey?: (key: string, status: number) => void;
  /** Два круга пройдены — отдаём пи настоящий 429. */
  onExhausted?: (info: { attempts: number; status: number }) => void;
  /** Все ключи в кулдауне — ждём ближайший откат. */
  onCooldownWait?: (ms: number) => void;
  /** Отладочный лог; вызывающий обязан маскировать ключи (см. вызовы ниже). */
  log?: (stage: string, label: string, payload: unknown) => void;
}

/**
 * Модель из тела запроса (тикет 22): fetch кладёт строку, иные формы тела
 * (итераторы) на этом этапе не распарсиваем — тогда кулдаун ведётся по
 * глобальному бакету ключа, как до тикета 22.
 */
function extractModelFromBody(body: unknown): string | undefined {
  let text: string | undefined;
  if (typeof body === "string") text = body;
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

async function runRotationLoop(
  target: DispatchTarget,
  opts: Record<string, unknown>,
  real: Record<string, unknown> | null,
  request: RotationRequest,
  options: RotationLayerOptions,
): Promise<void> {
  const now = (): number => (options.now ?? Date.now)();
  const controller = new RotationController();

  // Аборт запроса: сигнал в диспетчерских настройках (если транспорт его несёт) +
  // контроллер, который феррь зовёт при прерывании пользователем.
  const signal = opts.signal as { aborted?: unknown; addEventListener?: unknown; reason?: unknown; removeEventListener?: unknown } | undefined;
  let removeSignalListener: (() => void) | undefined;
  const hasSignal = !!signal && typeof signal.addEventListener === "function" && typeof signal.aborted === "boolean";
  if (hasSignal) {
    if (signal.aborted) controller.abort(signal.reason);
    else {
      const onAbort = () => controller.abort(signal.reason);
      (signal.addEventListener as (t: string, l: () => void, o?: unknown) => void)("abort", onAbort, { once: true });
      removeSignalListener = () => (signal.removeEventListener as (t: string, l: () => void) => void)("abort", onAbort);
    }
  }

  try {
    const body = await bufferRequestBody(opts.body);
    if (controller.aborted) return;

    let lastKey: string | undefined;
    let lastResponse: BufferedRotationResponse | undefined;
    let attempts = 0;

    for (;;) {
      if (controller.aborted) return;
      const pick = request.pick(now());
      if (pick.kind === "exhausted") {
        if (lastResponse) {
          options.onExhausted?.({ attempts, status: lastResponse.status });
          options.log?.("rotation-exhausted", `2 круга пройдены (${attempts} попыток) — отдаю ${lastResponse.status}`, {});
          deliverBufferedResponse(real, controller, lastResponse);
        } else {
          // Все ключи мертвы ещё до первой попытки: ведём себя как сегодня.
          target.dispatch({ ...opts, body }, real);
        }
        return;
      }
      if (pick.kind === "wait") {
        options.onCooldownWait?.(pick.ms);
        options.log?.("rotation-wait", `все ключи в кулдауне, жду ${pick.ms} мс`, {});
        const aborted = await interruptibleDelay(pick.ms, controller);
        if (aborted || controller.aborted) return;
        continue;
      }

      const key = pick.key;
      attempts += 1;
      if (lastKey !== undefined && lastKey !== key) {
        options.onSwitch?.({ from: lastKey, to: key, status: lastResponse?.status ?? 429 });
      }
      options.log?.("rotation-attempt", `попытка ${attempts}, ключ ${maskKey(key)}`, { ключ: maskKey(key) });
      const attemptOpts: Record<string, unknown> = {
        ...opts,
        headers: withAuthorization(opts.headers, key),
        body,
      };
      options.rotator.noteInFlight(key); // тикет 25: занятость для выбора соседних запросов
      const outcome = await dispatchRotationAttempt(target, attemptOpts, controller, real);
      options.rotator.releaseInFlight(key);
      if (controller.aborted) return;
      if (outcome.type === "delivered") {
        // Тикет 25: доставка гасит кулдаун только своей модели — чужие модельные
        // бакеты ключа, поставленные параллельными сабагентами, не трогаем.
        options.rotator.markDelivered(key, request.model);
        options.log?.("rotation-delivered", `ответ ушёл в пи, ключ ${maskKey(key)}`, {});
        return;
      }
      if (outcome.type === "error") {
        deliverHandlerError(real, controller, outcome.error);
        return;
      }
      lastResponse = outcome.response;
      lastKey = key;
      if (outcome.response.status === 401 || outcome.response.status === 403) {
        options.rotator.markDead(key);
        options.onDeadKey?.(key, outcome.response.status);
        options.log?.("rotation-dead", `ключ ${maskKey(key)} мёртв (${outcome.response.status})`, {});
        continue;
      }
      const cooldownMs = resolveCooldownMs(outcome.response.headers, options, now());
      options.rotator.markRateLimited(key, cooldownMs, now(), request.model);
      options.log?.("rotation-cooldown", `ключ ${maskKey(key)} в кулдауне ${cooldownMs} мс`, {});
    }
  } finally {
    removeSignalListener?.();
  }
}

/**
 * Цель-диспетчер с ротацией ключей: ставится НАД прозрачным повтором (на каждый
 * ключ сначала бюджет повторов тикета 14, потом смена ключа). Выключена/пул не
 * готов — запрос проходит в цель как есть (поведение как сегодня).
 */
export function withKeyRotation(target: DispatchTarget, options: RotationLayerOptions): SelectiveDispatcherHandle {
  return {
    dispatch(opts: unknown, handler: unknown): boolean {
      let passthrough = false;
      let request: RotationRequest | undefined;
      try {
        if (!options.enabled()) {
          passthrough = true;
        } else {
          const requestKey = extractBearerKey((opts as { headers?: unknown } | null)?.headers);
          options.rotator.setPool(options.getPoolKeys());
          const model = extractModelFromBody((opts as { body?: unknown } | null)?.body);
          request = options.rotator.beginRequest(requestKey, (options.now ?? Date.now)(), model);
          if (!request.isUseful()) passthrough = true;
        }
      } catch {
        passthrough = true; // подготовка не должна ломать запрос
      }
      if (passthrough || !request) return target.dispatch(opts, handler);
      const real = (handler && typeof handler === "object" ? handler : null) as Record<string, unknown> | null;
      void runRotationLoop(target, (opts ?? {}) as Record<string, unknown>, real, request, options).catch((err) => {
        deliverHandlerError(real, new RotationController(), err);
      });
      return true;
    },
    ...forwardLifecycle(target),
  };
}

/* ------------------------------------------------------------------ */
/* Прозрачный транспортный повтор 429/5xx (тикет 14)                     */
/* ------------------------------------------------------------------ */

/** Статусы, которые повторяем на транспортном уровне без изменения контекста. */
export const RETRYABLE_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

export interface TransportRetryConfig {
  /** Повторы сверх первой попытки. */
  maxRetries: number;
  /** Стартовая задержка экспоненциального отката, мс. */
  minDelayMs: number;
  /** Потолок задержки (в том числе для `retry-after`), мс. */
  maxDelayMs: number;
  /** Статусы для повтора (по умолчанию `RETRYABLE_STATUSES`). */
  statusCodes?: readonly number[];
  /** Вызывается при каждом запланированном повторе. */
  onRetryScheduled?: (info: { attempt: number; status: number; delayMs: number }) => void;
}

/**
 * Тело запроса в воспроизводимом виде. `fetch` передаёт одноразовый асинхронный
 * итератор; штатный повторитель ундичи не может его переиспользовать (помечает
 * «использованным» после первого прохода). Строки и байты воспроизводимы сами,
 * итераторы буферизуем в байты. Тела запросов NIM — небольшие JSON, буферизация
 * безвредна.
 */
export async function bufferRequestBody(body: unknown): Promise<unknown> {
  if (body === undefined || body === null) return body;
  if (typeof body === "string" || ArrayBuffer.isView(body)) return body;
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Задержка перед повтором: `retry-after-ms`/`retry-after` NIM уважается, но не ниже
 * `minDelayMs` (живой NIM заголовки в 429 не даёт вовсе, а рейт-лимит плавает —
 * слишком частые повторы только кормят ограничитель); потолок — `maxDelayMs`.
 * Без заголовка — плоская задержка `minDelayMs` на каждый повтор.
 */
export function resolveRetryDelayMs(
  headers: Record<string, string>,
  _attempt: number,
  config: { minDelayMs: number; maxDelayMs: number },
  now: number = Date.now(),
): number {
  let fromHeader: number | undefined;
  const ms = headers["retry-after-ms"];
  if (ms !== undefined) {
    const value = Number.parseFloat(ms);
    if (Number.isFinite(value)) fromHeader = value;
  }
  if (fromHeader === undefined) {
    const raw = headers["retry-after"];
    if (raw !== undefined) {
      const seconds = Number.parseFloat(raw);
      if (!Number.isNaN(seconds)) fromHeader = seconds * 1000;
      else {
        const date = Date.parse(raw);
        if (!Number.isNaN(date)) fromHeader = date - now;
      }
    }
  }
  const base = Math.max(fromHeader ?? config.minDelayMs, config.minDelayMs);
  return Math.min(base, config.maxDelayMs);
}

export interface RetryDecisionContext {
  state: { counter: number };
}

/**
 * Своя функция решения о повторе для штатного повторителя ундичи. Штатная не знает
 * `retry-after-ms` и по умолчанию не повторяет `POST`. Транспортные ошибки (без статуса)
 * не повторяем — их повторяет сам пи, а прокси-ошибки должны показываться сразу.
 */
export function makeNvidiaRetryFunction(
  config: TransportRetryConfig,
): (err: unknown, context: RetryDecisionContext, callback: (err?: unknown) => void) => void {
  const statuses = config.statusCodes ?? RETRYABLE_STATUSES;
  return function retry(err: unknown, context: RetryDecisionContext, callback: (err?: unknown) => void): void {
    const statusCode = (err as { statusCode?: unknown } | undefined)?.statusCode;
    const isRetryableStatus = typeof statusCode === "number" && statuses.includes(statusCode);
    if (!isRetryableStatus || context.state.counter > config.maxRetries) {
      callback(err);
      return;
    }
    const headers = headersToRecord((err as { headers?: unknown })?.headers);
    const delayMs = resolveRetryDelayMs(headers, context.state.counter, config);
    config.onRetryScheduled?.({ attempt: context.state.counter, status: statusCode, delayMs });
    setTimeout(() => callback(null), delayMs);
  };
}

/** Настройки для штатного повторителя ундичи (`RetryAgent`/`RetryHandler`). */
export function buildRetryAgentOptions(config: TransportRetryConfig): Record<string, unknown> {
  return {
    maxRetries: config.maxRetries,
    statusCodes: [...(config.statusCodes ?? RETRYABLE_STATUSES)],
    // При исчерпании повторов хендлер получает настоящий ответ (429/5xx),
    // а не синтетическую ошибку — поведение без повтора сохранено.
    throwOnError: false,
    // Штатный список не включает POST, а запросы NIM — это POST.
    methods: ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE", "QUERY", "POST"],
    retry: makeNvidiaRetryFunction(config),
  };
}

export interface RetryTargetDeps {
  /** Инжектируемый конструктор повторителя (входная точка передаёт `undici.RetryAgent`). */
  createRetryAgent(agent: DispatchTarget, retryOptions: Record<string, unknown>): DispatchTarget;
}

/**
 * Цель-диспетчер с прозрачным повтором: буферизует тело в воспроизводимый вид,
 * передаёт запрос повторителю, обёрнутому вокруг исходной цели. Наблюдатель
 * (`wrapHandler`) ставится выше — видит только конечный исход.
 */
export function withTransparentRetry(
  target: DispatchTarget,
  config: TransportRetryConfig,
  deps: RetryTargetDeps,
): SelectiveDispatcherHandle {
  const retryAgent = deps.createRetryAgent(target, buildRetryAgentOptions(config));
  return {
    dispatch(opts: unknown, handler: unknown): boolean {
      const body = (opts as { body?: unknown } | null)?.body;
      bufferRequestBody(body)
        .then((buffered) => {
          retryAgent.dispatch({ ...(opts as Record<string, unknown>), body: buffered }, handler);
        })
        .catch((err) => {
          (handler as { onResponseError?: (controller: unknown, err: unknown) => void })?.onResponseError?.(null, err);
        });
      return true;
    },
    ...forwardLifecycle(retryAgent),
  };
}

/* ------------------------------------------------------------------ */
/* Прозрачный повтор in-band ошибки перегрузки (тикет 29)                 */
/* ------------------------------------------------------------------ */

/**
 * NIM при перегрузке отдаёт **HTTP 200** с SSE-потоком, чьё первое событие —
 * `data: {"error":{"message":"Service temporarily overloaded", …}}`. Итератор
 * потока OpenAI SDK (`core/streaming.js`) видит `data.error` и бросает
 * `APIError(undefined, …)`; пи получает `stopReason:"error"` без HTTP-статуса.
 * Оба статус-ориентированных слоя — прозрачный повтор (`RetryAgent`, 429/5xx)
 * и ротация ключей (`ROTATABLE_STATUSES`) — такую ошибку пропускают, и она
 * доезжает до ретрай-пакетов, видимых моделью.
 *
 * Этот слой повторяет её на транспорте: первое полное событие SSE
 * классифицируется чистой функцией `classifyInBandStream`, ответ до
 * классификации не коммитится (приём `makeRotationAttemptHandler`).
 *
 * Гарантии:
 *  - sniffing только `2xx` + `text/event-stream`; всё остальное (JSON
 *    discovery, пробы keys-check, 4xx/5xx) стримит без задержки;
 *  - нормальный первый чанк коммитится в том же синхронном вызове — задержка
 *    первого токена не растёт;
 *  - при исчерпании бюджета пи получает **исходный** ответ байт-в-байт
 *    (та же ошибка, что и без слоя) — поведение не меняется;
 *  - аборт ферря прерывает ожидание через стабильный контроллер.
 */

/** Потолок буфера sniffing: события-ошибки NIM крошечные, кап защищает от потоков без разделителей. */
export const IN_BAND_SNIFF_MAX_BYTES = 8_192;

/**
 * Первая полная data-нагрузка SSE: события разделяются пустой строкой
 * (`\r\n\r\n`, `\n\n` и смешанные формы), data-строки события склеиваются
 * `\n`. Ведущие события без data (heartbeat-комментарии `: ping`, только
 * `event:`-строки) пропускаются — решение принимается по первому содержательному.
 */
export function firstSseDataPayload(buffer: Uint8Array): string | undefined {
  let offset = 0;
  for (;;) {
    const boundary = findEventBoundary(buffer, offset);
    if (!boundary) return undefined;
    const eventText = new TextDecoder().decode(buffer.subarray(offset, boundary.start));
    const dataLines: string[] = [];
    for (const line of eventText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
      dataLines.push(value);
    }
    if (dataLines.length > 0) return dataLines.join("\n");
    offset = boundary.end;
  }
}

/** Начало и конец первого разделителя событий (пустой строки) от `offset`. */
function findEventBoundary(buffer: Uint8Array, offset: number): { start: number; end: number } | undefined {
  for (let i = offset; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a && buffer[i] !== 0x0d) continue;
    // Позиция i — конец строки; за ним должна идти пустая строка.
    const after = i + (buffer[i] === 0x0d && buffer[i + 1] === 0x0a ? 2 : 1);
    if (after >= buffer.length) return undefined;
    if (buffer[after] === 0x0a) return { start: i, end: after + 1 };
    if (buffer[after] === 0x0d && buffer[after + 1] === 0x0a) return { start: i, end: after + 2 };
  }
  return undefined;
}

/**
 * Объект ошибки из полезной нагрузки. Формы NIM/OpenAI-совместимых шлюзов:
 * `{error:{message}}`, `{error:"строка"}`, плоская `{message|detail|title|status}`.
 * Обычный чанк генерации (`{id,object,created,model,choices,…}`) ошибкой не
 * считается — поэтому у плоской формы разрешены только «ошибочные» ключи.
 */
export function extractErrorObject(data: string): Record<string, unknown> | undefined {
  if (!data.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, unknown>;
  const nested = root.error;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  if (typeof nested === "string" && nested.trim().length > 0) return { message: nested };
  const ERROR_ONLY_KEYS = ["message", "detail", "error", "status", "title", "type", "code"];
  const keys = Object.keys(root);
  if (keys.length > 0 && keys.every((k) => ERROR_ONLY_KEYS.includes(k))) return root;
  return undefined;
}

/** Человекочитаемый текст ошибки: message → detail → error → title → JSON. */
export function inBandErrorMessage(errorObj: Record<string, unknown>): string {
  for (const key of ["message", "detail", "error", "title"]) {
    const value = errorObj[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  try {
    return JSON.stringify(errorObj);
  } catch {
    return String(errorObj);
  }
}

/**
 * Транзитные тексты — пересечение с ретрай-каталогом pi-ai (`overloaded`,
 * `rate limit`, 429/5xx, `ResourceExhausted`, …) плюс NIM-формулировки.
 * Нетранзитные проверяются ПЕРВЫМИ и всегда побеждают: `quota exceeded`
 * даёт 429, но повтор её не лечит (каталог NON_RETRYABLE pi-ai).
 */
const IN_BAND_NON_RETRYABLE_RE =
  /content.?filter|invalid|unauthoriz|forbidden|permission|denied|authenticat|api.?key|insufficient.?quota|out of budget|quota exceeded|billing|context.?(length|window)|exceeds.{0,20}context|too long|bad request|malformed|unsupported|not.?(found|supported)|deprecated|moderation/i;
const IN_BAND_RETRYABLE_RE =
  /overload|temporaril|rate.?limit|too many requests|retry|try again|try your request|later|unavailable|capacity|resource.?exhausted|server.?error|internal.?error|bad.?gateway|gateway.?time|timed?.?out|timeout|upstream|\b429\b|\b50[0234]\b|\b524\b/i;

export type InBandDecision =
  | { kind: "undecided" }
  | { kind: "retry"; reason: string }
  | { kind: "deliver"; reason: string };

/**
 * Классификация начала ответа. `undecided` — первое событие ещё не получено
 * целиком; переполнение капа → `deliver` (это не крошечное событие-ошибка,
 * ждать дальше бессмысленно). Чистая функция — ядро юнит-тестов.
 */
export function classifyInBandStream(
  status: number,
  contentType: string | undefined,
  buffer: Uint8Array,
  maxBytes: number = IN_BAND_SNIFF_MAX_BYTES,
): InBandDecision {
  if (status < 200 || status >= 300) return { kind: "deliver", reason: "status" };
  if (!/text\/event-stream/i.test(contentType ?? "")) return { kind: "deliver", reason: "not-sse" };
  if (buffer.length > maxBytes) return { kind: "deliver", reason: "buffer-cap" };
  const first = firstSseDataPayload(buffer);
  if (first === undefined) return { kind: "undecided" };
  if (first.startsWith("[DONE]")) return { kind: "deliver", reason: "done" };
  const errorObj = extractErrorObject(first);
  if (!errorObj) return { kind: "deliver", reason: "no-error" };
  const message = inBandErrorMessage(errorObj);
  if (IN_BAND_NON_RETRYABLE_RE.test(message)) return { kind: "deliver", reason: "non-retryable" };
  if (IN_BAND_RETRYABLE_RE.test(message)) return { kind: "retry", reason: message };
  // Нераспознанная форма ошибки — не маскируем: пи должен её увидеть.
  return { kind: "deliver", reason: "unclassified" };
}

/** Задержка повтора: плоский `minDelayMs` с удвоением на попытку, кап `maxDelayMs`. */
export function inBandRetryDelayMs(attempt: number, config: { minDelayMs: number; maxDelayMs: number }): number {
  const expo = config.minDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(expo, config.maxDelayMs);
}

/** Буферизованный ответ одной попытки: заголовки хранятся как пришли — отдаются без изменений. */
export interface BufferedInBandResponse {
  status: number;
  headers: unknown;
  contentType: string | undefined;
  statusMessage: unknown;
  chunks: Uint8Array[];
  trailers: unknown;
}

type InBandAttemptOutcome =
  | { type: "delivered" }
  | { type: "retry"; reason: string }
  | { type: "error"; error: unknown };

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Хендлер одной попытки: SSE-2xx не коммитится сразу — первое событие
 * буферизуется и классифицируется, остальное стримит в настоящий хендлер без
 * задержки. Поток на паузу не ставится: решение принимается по мере прихода
 * чанков, а отказ NIM после события-ошибки терминальный (приём тот же, что в
 * `makeRotationAttemptHandler`).
 *
 * Исчерпание бюджета — не отдельный исход: ответ коммитится как есть и
 * доходит до пи байт-в-байт вместе с естественным `onResponseEnd`, то есть
 * поведение совпадает с вариантом «слоя нет вовсе». Факт исчерпания уходит
 * наружу колбэком `onExhausted` — только для уведомления и метрик.
 */
function makeInBandAttemptHandler(
  real: Record<string, unknown> | null,
  controller: RotationController,
  settle: (outcome: InBandAttemptOutcome) => void,
  options: { canRetry: boolean; onExhausted?: (reason: string) => void },
): Record<string, unknown> {
  let mode: "pending" | "sniffing" | "streaming" = "pending";
  let buffered: BufferedInBandResponse | undefined;
  let settled = false;
  // `onResponseStarted` приходит до `onResponseStart` (тайминги ферря): держим
  // флаг, чтобы при отложенном коммите соблюсти порядок вызовов.
  let startedSeen = false;
  const finish = (outcome: InBandAttemptOutcome): void => {
    if (settled) return;
    settled = true;
    settle(outcome);
  };
  const call = (name: string, ...args: unknown[]): unknown => callHandlerMethod(real, name, ...args);

  /** Отдать всё накопленное настоящему хендлеру и перейти в сквозной стрим. */
  const commit = (): void => {
    if (!buffered) return;
    mode = "streaming";
    finish({ type: "delivered" });
    if (startedSeen) call("onResponseStarted");
    startedSeen = false;
    call("onResponseStart", controller, buffered.status, buffered.headers, buffered.statusMessage);
    for (const chunk of buffered.chunks) call("onResponseData", controller, chunk);
    buffered = undefined;
  };

  const decide = (final: boolean): boolean => {
    if (!buffered) return false;
    const joined = concatChunks(buffered.chunks);
    const decision = classifyInBandStream(buffered.status, buffered.contentType, joined);
    if (decision.kind === "undecided") {
      // Поток закончился раньше классификации — отдаём, что есть.
      if (final) return commit(), true;
      return false;
    }
    if (decision.kind === "retry" && options.canRetry) {
      // Ответ выброшен, настоящему хендлеру ничего не отдано — можно повторять.
      finish({ type: "retry", reason: decision.reason });
      mode = "pending";
      buffered = undefined; // хвостовые чанки покинутого ответа не собираем
      return false;
    }
    if (decision.kind === "retry") options.onExhausted?.(decision.reason);
    commit();
    return true;
  };

  return {
    onRequestStart(conn: unknown, context: unknown) {
      controller.target = conn as never;
      if (!controller.forwardedStart && typeof real?.onRequestStart === "function") {
        controller.forwardedStart = true;
        call("onRequestStart", controller, context);
      }
    },
    onResponseStarted() {
      startedSeen = true;
      if (mode === "streaming") {
        startedSeen = false;
        call("onResponseStarted");
      }
      // в sniffing не зовём: ответ может быть выброшен при повторе
    },
    onResponseStart(conn: unknown, status: number, headers: unknown, statusMessage: unknown) {
      controller.target = conn as never;
      const record = headersToRecord(headers);
      const contentType = record["content-type"];
      // Пустой буфер: `undecided` только для SSE-2xx, всё остальное — сразу стрим.
      if (classifyInBandStream(status, contentType, new Uint8Array(0)).kind === "deliver") {
        mode = "streaming";
        finish({ type: "delivered" });
        if (startedSeen) {
          startedSeen = false;
          call("onResponseStarted");
        }
        call("onResponseStart", controller, status, headers, statusMessage);
        return;
      }
      mode = "sniffing";
      buffered = { status, headers, contentType, statusMessage, chunks: [], trailers: undefined };
    },
    onResponseData(_conn: unknown, chunk: unknown) {
      if (mode === "streaming") return call("onResponseData", controller, chunk);
      if (mode === "sniffing" && buffered) {
        const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
        buffered.chunks.push(bytes);
        decide(false);
      }
      return undefined;
    },
    onResponseEnd(trailers: unknown) {
      if (mode === "streaming") return call("onResponseEnd", controller, trailers);
      if (mode === "sniffing" && buffered) {
        buffered.trailers = trailers;
        if (decide(true)) call("onResponseEnd", controller, trailers);
      }
      return undefined;
    },
    onResponseError(conn: unknown, err: unknown) {
      if (conn) controller.target = conn as never;
      if (mode === "streaming") {
        call("onResponseError", controller, err);
        return;
      }
      finish({ type: "error", error: err });
    },
    onRequestUpgrade(conn: unknown, status: number, headers: unknown, socket: unknown) {
      controller.target = conn as never;
      mode = "streaming";
      finish({ type: "delivered" });
      return call("onRequestUpgrade", controller, status, headers, socket);
    },
  };
}

export interface InBandRetryConfig {
  /** Повторы сверх первой попытки. */
  maxRetries: number;
  /** Стартовая задержка отката, мс (удваивается на попытку). */
  minDelayMs: number;
  /** Потолок задержки, мс. */
  maxDelayMs: number;
  /** Запланирован повтор (`attempt` — от 1, `reason` — текст ошибки NIM). */
  onRetryScheduled?: (info: { attempt: number; reason: string; delayMs: number }) => void;
  /** Бюджет исчерпан — пи получит исходную ошибку (уведомление/метрика). */
  onExhausted?: (info: { attempts: number; reason: string }) => void;
}

async function runInBandLoop(
  target: DispatchTarget,
  opts: Record<string, unknown>,
  body: unknown,
  real: Record<string, unknown> | null,
  config: InBandRetryConfig,
): Promise<void> {
  const controller = new RotationController();

  // Аборт ферря: тот же приём, что в ротации — сигнал + стабильный контроллер,
  // чтобы ожидание между попытками прерывалось по Esc.
  const signal = opts.signal as
    | { aborted?: unknown; addEventListener?: unknown; reason?: unknown; removeEventListener?: unknown }
    | undefined;
  let removeSignalListener: (() => void) | undefined;
  if (signal && typeof signal.addEventListener === "function" && typeof signal.aborted === "boolean") {
    if (signal.aborted) controller.abort(signal.reason);
    else {
      const onAbort = () => controller.abort(signal.reason);
      (signal.addEventListener as (t: string, l: () => void, o?: unknown) => void)("abort", onAbort, { once: true });
      removeSignalListener = () => (signal.removeEventListener as (t: string, l: () => void) => void)("abort", onAbort);
    }
  }

  try {
    for (let attempt = 0; ; attempt++) {
      if (controller.aborted) return;
      const canRetry = attempt < config.maxRetries;
      const outcome = await new Promise<InBandAttemptOutcome>((resolve) => {
        const handler = makeInBandAttemptHandler(real, controller, resolve, {
          canRetry,
          onExhausted: (reason) => config.onExhausted?.({ attempts: attempt + 1, reason }),
        });
        try {
          target.dispatch({ ...opts, body }, handler);
        } catch (err) {
          resolve({ type: "error", error: err });
        }
      });
      if (controller.aborted) return;
      if (outcome.type === "delivered") return;
      if (outcome.type === "error") {
        deliverHandlerError(real, controller, outcome.error);
        return;
      }
      const delayMs = inBandRetryDelayMs(attempt + 1, config);
      config.onRetryScheduled?.({ attempt: attempt + 1, reason: outcome.reason, delayMs });
      const aborted = await interruptibleDelay(delayMs, controller);
      if (aborted || controller.aborted) return;
    }
  } finally {
    removeSignalListener?.();
  }
}

/**
 * Цель-диспетчер с прозрачным повтором in-band перегрузки. Ставится самым
 * внутренним (над `base`): каждый повтор — свежий запрос в сеть, а статусные
 * слои выше видят один логический запрос и его конечный исход. Тело
 * буферизуется один раз и переиспользуется на всех попытках.
 */
export function withInBandOverloadRetry(target: DispatchTarget, config: InBandRetryConfig): SelectiveDispatcherHandle {
  return {
    dispatch(opts: unknown, handler: unknown): boolean {
      const real = (handler && typeof handler === "object" ? handler : null) as Record<string, unknown> | null;
      const record = (opts ?? {}) as Record<string, unknown>;
      bufferRequestBody(record.body)
        .then((body) => runInBandLoop(target, record, body, real, config))
        .catch((err) => {
          deliverHandlerError(real, new RotationController(), err);
        });
      return true;
    },
    ...forwardLifecycle(target),
  };
}

/* ------------------------------------------------------------------ */
/* Кольцо прокси: pin-инвариант (spec proxy-pool, фаза 1)                 */
/* ------------------------------------------------------------------ */

export interface ProxyRingOptions {
  /** Сессионное состояние выбора выхода. */
  rotator: ProxyRotator;
  /** Пул нормализованных href (без паролей в отчётах); зовётся на каждый dispatch — горячая перезагрузка. */
  getPoolHrefs(): string[];
  /** Аварийный выключатель кольца (окружение + команда живой сессии). */
  rotationEnabled(): boolean;
  /** Opt-in direct: пул ПУСТ (не «все в cooldown») и флаг on — маршрут без прокси. */
  directFallbackEnabled(): boolean;
  /** Создание bare-агента эндпоинта (входная точка передаёт `undici.ProxyAgent`). */
  createBareAgent(href: string): DispatchTarget;
  /** Сборка внутреннего лука поверх bare-агента (in-band → повтор → ротация ключей). */
  stackInnerLayers(bare: DispatchTarget): DispatchTarget;
  /** Закрытие агента выбывшего из пула href. */
  closeAgent?(href: string, agent: DispatchTarget): void;
  /** Pin сменился между dispatch (метрика сессии; display identity). */
  onPinSwitch?(info: { from?: string; to: string }): void;
  /** CONNECT-ошибка → карантин (уведомление; display identity + готовое сообщение). */
  onQuarantine?(info: { display: string; cooldownMs: number; detail: string; message: string }): void;
  /** Пустой пул: `allowed` — маршрут ушёл в direct (флаг on); иначе запрос остановлен (story 35: без флага origin IP не светим). */
  onDirectFallback?(allowed: boolean): void;
  now?: () => number;
}

interface RingEntry {
  bare: DispatchTarget;
  stacked: DispatchTarget;
}

/**
 * Цель-диспетчер с кольцом прокси: pick ОДИН раз на входящий dispatch и на
 * весь внутренний круг ключей/прозрачных повторов этого запроса (pin-
 * инвариант спеки). На каждый href лениво создаётся bare-агент и оборачивается
 * общим луком (все onion-ы разделяют ОДИН key-ротатор — его инжектирует
 * `stackInnerLayers`). Внутризапросный CONNECT-failover — фаза 2, здесь его
 * нет: начавшийся на pin запрос завершается на нём же, даже если CONNECT умирает.
 *
 * Пустой пул: с флагом `directFallbackEnabled` маршрут уходит прежнему
 * глобальному диспетчеру (осознанный «try anyway»); БЕЗ флага запрос
 * останавливается понятной ошибкой — молча светить origin IP на
 * ограниченной сети нельзя (story 35). Все эндпоинты в cooldown — НЕ повод
 * для direct: pick возвращает ближайший expiry (правило 4).
 */
export function withProxyRing(base: DispatchTarget, options: ProxyRingOptions): SelectiveDispatcherHandle {
  const entries = new Map<string, RingEntry>();
  let lastPinDisplay: string | undefined;

  const entryFor = (href: string): RingEntry => {
    let entry = entries.get(href);
    if (!entry) {
      const bare = options.createBareAgent(href);
      entry = { bare, stacked: options.stackInnerLayers(bare) };
      entries.set(href, entry);
    }
    return entry;
  };

  const reconcile = (pool: string[]): void => {
    if (entries.size === 0) return;
    const poolSet = new Set(pool);
    for (const [href, entry] of [...entries]) {
      if (poolSet.has(href)) continue;
      entries.delete(href);
      try {
        if (options.closeAgent) options.closeAgent(href, entry.bare);
        else void (entry.bare as { destroy?: () => Promise<void> }).destroy?.();
      } catch {
        // закрытие keep-alive пула — best effort
      }
    }
  };

  return {
    dispatch(opts: unknown, handler: unknown): boolean {
      let pick: ProxyPick;
      let href: string | undefined;
      try {
        const pool = options.getPoolHrefs();
        options.rotator.setPool(pool);
        reconcile(pool);
        pick = options.rotator.pick((options.now ?? Date.now)(), {
          rotationEnabled: options.rotationEnabled(),
        });
        if (pick.kind === "proxy") href = pick.href;
      } catch {
        pick = { kind: "direct" }; // подготовка не должна ломать запрос
      }
      if (pick.kind !== "proxy" || !href) {
        // Пустой пул: direct только с явным флагом; иначе — понятная ошибка
        // без обращения в сеть (origin IP не покидает машину).
        const allowed = options.directFallbackEnabled();
        options.onDirectFallback?.(allowed);
        if (allowed) return base.dispatch(opts, handler);
        deliverRingBlocked(handler);
        return true;
      }

      const display = maskProxy(href);
      if (lastPinDisplay !== undefined && lastPinDisplay !== display) {
        options.onPinSwitch?.({ from: lastPinDisplay, to: display });
      }
      lastPinDisplay = display;

      // Наблюдение исхода: CONNECT-класс → карантин + переписывание ошибки в
      // понятную (display identity); успех → markOk (снимает карантин, пишет
      // exit quality). 429/401/403/5xx/in-band — НЕ прокси: их обрабатывают
      // внутренние слои (ротация ключей, транспортный повтор). Abort (Esc) —
      // тоже исход: занятость освобождается, карантин не ставится.
      const startedAt = (options.now ?? Date.now)();
      let settled = false;
      let removeAbortListener: (() => void) | undefined;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        options.rotator.releaseInFlight(href!);
        removeAbortListener?.();
        return true;
      };

      // Создание агента — внутри try: конструктор может бросить (старый ундичи
      // без Socks5ProxyAgent на socks-href, битый URL) — тогда выход карантинится
      // и следующий dispatch берёт соседа, а fetch-вызывающий не падает.
      let entry: RingEntry;
      try {
        entry = entryFor(href);
      } catch (err) {
        options.rotator.markConnectFailed(href, startedAt);
        options.onQuarantine?.({
          display,
          cooldownMs: PROXY_QUARANTINE_MS,
          detail: err instanceof Error ? err.message : String(err),
          message: describeEndpointFailure(display, err),
        });
        deliverRingError(handler, href, display, err, options);
        return true;
      }

      const wrapped = wrapRingHandler(handler, href, display, options, startedAt, settle);
      options.rotator.noteInFlight(href);
      removeAbortListener = hookAbortRelease((opts as { signal?: unknown } | null)?.signal, settle);
      try {
        return entry.stacked.dispatch(opts, wrapped);
      } catch (err) {
        // Синхронный провал dispatch: отдаём ошибку хендлеру как CONNECT-исход.
        settle();
        deliverRingError(handler, href, display, err, options);
        return true;
      }
    },
    close(): Promise<void> {
      const jobs: Array<Promise<void> | undefined> = [Promise.resolve((base as { close?: () => Promise<void> }).close?.())];
      for (const entry of entries.values()) jobs.push(Promise.resolve((entry.bare as { close?: () => Promise<void> }).close?.()));
      return Promise.all(jobs).then(() => undefined);
    },
    destroy(): Promise<void> {
      const jobs: Array<Promise<void> | undefined> = [Promise.resolve((base as { destroy?: () => Promise<void> }).destroy?.())];
      for (const entry of entries.values()) jobs.push(Promise.resolve((entry.bare as { destroy?: () => Promise<void> }).destroy?.()));
      return Promise.all(jobs).then(() => undefined);
    },
    /** Агент эндпоинта (для `proxy check` и `getNvidiaDirectDispatcher`). */
    __ringAgentFor(href: string): DispatchTarget {
      return entryFor(href).bare;
    },
  } as SelectiveDispatcherHandle & { __ringAgentFor(href: string): DispatchTarget };
}

/**
 * Обёртка хендлера кольца: наблюдает конечный исход ОДНОЙ попытки на pin
 * (внутренние слои уже отработали свои повторы). Только новый протокол
 * (ундичи 7+) — его использует fetch пи; старый протокол проходит насквозь
 * (наблюдения не будет — как сегодня на редких транспортах).
 */
function wrapRingHandler(
  handler: unknown,
  href: string,
  display: string,
  options: ProxyRingOptions,
  startedAt: number,
  settle: () => boolean,
): unknown {
  if (!handler || typeof handler !== "object") return handler;
  const h = handler as Record<string, unknown>;
  if (typeof h.onResponseStart !== "function" && typeof h.onResponseError !== "function") return handler;
  if (ringWrappedHandlers.has(h)) return handler;

  if (typeof h.onResponseStart === "function") {
    const original = h.onResponseStart as (...args: unknown[]) => unknown;
    h.onResponseStart = function (controller: unknown, status: number, headers: unknown, statusMessage: unknown) {
      if (settle()) {
        // Любой HTTP-статус — выход достижим (exit quality); 429/5xx — бакеты
        // ключа/транспорта, прокси они не трогают.
        const latencyMs = Math.max(0, ((options.now ?? Date.now)()) - startedAt);
        options.rotator.markOk(href, latencyMs);
      }
      return original.call(this, controller, status, headers, statusMessage);
    };
  }
  if (typeof h.onResponseError === "function") {
    const original = h.onResponseError as (...args: unknown[]) => unknown;
    h.onResponseError = function (controller: unknown, err: unknown) {
      if (settle()) {
        const rewritten = noteRingError(href, display, err, options);
        return original.call(this, controller, rewritten);
      }
      return original.call(this, controller, err);
    };
  }
  ringWrappedHandlers.add(h);
  return h;
}

const ringWrappedHandlers = new WeakSet<object>();

/** Аборт ферря (Esc) — исход запроса: освобождаем занятость без карантина. */
function hookAbortRelease(signal: unknown, settle: () => boolean): (() => void) | undefined {
  const s = signal as { aborted?: unknown; addEventListener?: unknown; removeEventListener?: unknown } | undefined;
  if (!s || typeof s.addEventListener !== "function" || typeof s.aborted !== "boolean") return undefined;
  if (s.aborted) {
    settle();
    return undefined;
  }
  const onAbort = (): void => {
    settle();
  };
  (s.addEventListener as (t: string, l: () => void, o?: unknown) => void)("abort", onAbort, { once: true });
  return () => (s.removeEventListener as (t: string, l: () => void) => void)("abort", onAbort);
}

/** Пустой пул и direct-fallback выключен: понятная ошибка без обращения в сеть. */
function deliverRingBlocked(handler: unknown): void {
  const h = handler as Record<string, unknown> | null;
  if (typeof h?.onResponseError !== "function") return;
  const err = new Error(t("proxyPoolEmptyNoDirect"));
  (err as NodeJS.ErrnoException).code = "ENOPROXY";
  try {
    (h.onResponseError as (...a: unknown[]) => unknown).call(h, null, err);
  } catch {
    // отдача не должна ронять кольцо
  }
}

/** CONNECT-ошибка → карантин + понятное сообщение; прочее — как есть. */
function noteRingError(href: string, display: string, err: unknown, options: ProxyRingOptions): unknown {
  if (!isProxyConnectError(err)) return err;
  options.rotator.markConnectFailed(href);
  const message = describeEndpointFailure(display, err);
  options.onQuarantine?.({
    display,
    cooldownMs: PROXY_QUARANTINE_MS,
    detail: (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err)),
    message,
  });
  const wrapped = new Error(message);
  wrapped.cause = err;
  (wrapped as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException).code;
  return wrapped;
}

/** Синхронный провал dispatch: тот же путь, что onResponseError. */
function deliverRingError(handler: unknown, href: string, display: string, err: unknown, options: ProxyRingOptions): void {
  const rewritten = noteRingError(href, display, err, options);
  const h = handler as Record<string, unknown> | null;
  if (typeof h?.onResponseError === "function") {
    try {
      (h.onResponseError as (...a: unknown[]) => unknown).call(h, null, rewritten);
    } catch {
      // отдача не должна ронять кольцо
    }
  }
}

export interface SelectiveDispatcherOptions {
  /** Куда идут запросы к NIM (обычно `undici.ProxyAgent`). */
  nvidia: DispatchTarget;
  /** Прежний глобальный диспетчер — для всего остального трафика. */
  fallback: DispatchTarget;
  /** Адрес прокси — для понятных сообщений об ошибках; `undefined` — маршрут без прокси (ошибки соединения не переписываются). */
  proxyUrl?: string;
  /** Вызывается на каждый ответ NIM (после парсинга заголовков). */
  onObserved?: (status: number, headers: Record<string, string>) => void;
  /** Вызывается для ответов 429/5xx. */
  onDiagnostic?: (diagnostic: NimDiagnostic) => void;
  /** Вызывается при ошибках соединения на nvidia-маршруте (после переписывания в понятную). */
  onProxyError?: (message: string, cause: unknown) => void;
}

export const OUR_DISPATCHER_MARK = "__piNvidiaPlusSelectiveDispatcher";
const wrappedHandlers = new WeakSet<object>();

/**
 * Оборачивает колбэки ответа/ошибки хендлера напрямую (так же, как встроенные
 * интерцепторы ундичи — например, `ProxyAgent` сам подменяет `onResponseStart`).
 * Поддержаны оба протокола: новый (`onResponseStart`/`onResponseError`, ундичи 7+)
 * и старый (`onResponse`/`onError`). Идемпотентно по `WeakSet`.
 */
function wrapHandler(
  handler: unknown,
  proxyUrl: string | undefined,
  onObserved?: (status: number, headers: Record<string, string>) => void,
  onDiagnostic?: (diagnostic: NimDiagnostic) => void,
  onProxyError?: (message: string, cause: unknown) => void,
): unknown {
  if (!handler || typeof handler !== "object" || wrappedHandlers.has(handler as object)) return handler;
  const h = handler as Record<string, unknown>;

  const observe = (statusCode: number, headers: unknown): void => {
    try {
      const record = headersToRecord(headers);
      onObserved?.(statusCode, record);
      const diagnostic = extractDiagnostics(statusCode, record);
      if (diagnostic) onDiagnostic?.(diagnostic);
    } catch {
      // наблюдение не должно ломать запрос
    }
  };

  const rewriteError = (err: unknown): unknown => {
    // Без прокси ошибки соединения не переписываются: это обычный маршрут.
    if (!proxyUrl) return err;
    if (!isProxyConnectError(err)) return err;
    const message = describeProxyFailure(proxyUrl, err);
    const wrapped = new Error(message);
    wrapped.cause = err;
    (wrapped as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException).code;
    try {
      onProxyError?.(message, err);
    } catch {
      // наблюдение не должно ломать запрос
    }
    return wrapped;
  };

  // Новый протокол (ундичи 7+): именно его используют `ProxyAgent` и fetch пи.
  if (typeof h.onResponseStart === "function") {
    const original = h.onResponseStart as (...args: unknown[]) => unknown;
    h.onResponseStart = function (controller: unknown, statusCode: number, headers: unknown, statusMessage: unknown) {
      observe(statusCode, headers);
      return original.call(this, controller, statusCode, headers, statusMessage);
    };
  }
  if (typeof h.onResponseError === "function") {
    const original = h.onResponseError as (...args: unknown[]) => unknown;
    h.onResponseError = function (controller: unknown, err: unknown) {
      return original.call(this, controller, rewriteError(err));
    };
  }
  // Старый протокол — на случай другого транспорта.
  if (typeof h.onResponse === "function") {
    const original = h.onResponse as (...args: unknown[]) => unknown;
    h.onResponse = function (statusCode: number, headers: unknown) {
      observe(statusCode, headers);
      return original.call(this, statusCode, headers);
    };
  }
  if (typeof h.onError === "function") {
    const original = h.onError as (...args: unknown[]) => unknown;
    h.onError = function (err: unknown) {
      return original.call(this, rewriteError(err));
    };
  }

  wrappedHandlers.add(h as object);
  return h;
}

export function isOurDispatcher(dispatcher: unknown): boolean {
  return !!dispatcher && (dispatcher as Record<string, unknown>)[OUR_DISPATCHER_MARK] === true;
}

/** Помечает произвольный объект как нашу обёртку (для адаптеров-подклассов). */
export function markDispatcher(dispatcher: object): void {
  Object.defineProperty(dispatcher, OUR_DISPATCHER_MARK, { value: true, enumerable: false });
}

export interface SelectiveDispatcherHandle extends DispatchTarget {
  close(): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Обёртка-диспетчер (утиная типизация: наследование от класса undici
 * добавляет входная точка, если нужно). Наблюдает ответы и ошибки соединения
 * на nvidia-маршруте, остальное делегирует как есть.
 */
export function createSelectiveDispatcher(options: SelectiveDispatcherOptions): SelectiveDispatcherHandle & Record<string, unknown> {
  const { nvidia, fallback, proxyUrl, onObserved, onDiagnostic } = options;

  return {
    [OUR_DISPATCHER_MARK]: true,
    dispatch(opts: unknown, handler: unknown): boolean {
      let origin: unknown;
      try {
        origin = (opts as { origin?: unknown } | null)?.origin;
      } catch {
        origin = undefined;
      }
      if (isNvidiaOrigin(origin)) {
        return nvidia.dispatch(opts, wrapHandler(handler, proxyUrl, onObserved, onDiagnostic, options.onProxyError));
      }
      return fallback.dispatch(opts, handler);
    },
    close(): Promise<void> {
      return Promise.all([
        (nvidia as { close?: () => Promise<void> }).close?.(),
        (fallback as { close?: () => Promise<void> }).close?.(),
      ]).then(() => undefined);
    },
    destroy(): Promise<void> {
      return Promise.all([
        (nvidia as { destroy?: () => Promise<void> }).destroy?.(),
        (fallback as { destroy?: () => Promise<void> }).destroy?.(),
      ]).then(() => undefined);
    },
  };
}

export interface DispatcherDeps {
  getGlobalDispatcher(): unknown;
  setGlobalDispatcher(dispatcher: unknown): void;
  createProxyAgent(url: URL): DispatchTarget;
  /** Необязательный адаптер: превращает утиную обёртку в объект, который можно поставить глобальным диспетчером (например, подкласс реального `undici.Dispatcher`). Маркер должен сохраниться. */
  adapt?: (duck: SelectiveDispatcherHandle) => unknown;
  /** Конструктор штатного повторителя ундичи — для прозрачного повтора 429/5xx. */
  createRetryAgent?: (agent: DispatchTarget, retryOptions: Record<string, unknown>) => DispatchTarget;
}

/** Конфигурация кольца прокси для установки (без `createBareAgent`/`stackInnerLayers` — их собирает `ensureDispatcherInstalled`). */
export type ProxyPoolInstallConfig = Omit<ProxyRingOptions, "createBareAgent" | "stackInnerLayers" | "closeAgent">;

export interface InstallOptions {
  /** Легаси-прокси `NVIDIA_NIM_PROXY` (пул из одного). Без него (но при заданной ротации) nvidia-маршрут идёт через прежний глобальный диспетчер. */
  proxyUrl?: URL;
  /** Пул прокси (новая форма). Если задан — ставится кольцо, `proxyUrl` игнорируется. */
  proxyPool?: ProxyPoolInstallConfig;
  onObserved?: (status: number, headers: Record<string, string>) => void;
  onDiagnostic?: (diagnostic: NimDiagnostic) => void;
  onProxyError?: (message: string, cause: unknown) => void;
  /** Включает прозрачный транспортный повтор 429/5xx (нужен `deps.createRetryAgent`). */
  retry?: TransportRetryConfig;
  /** Прозрачный повтор in-band ошибки перегрузки (тикет 29): самый внутренний слой над `base`. */
  inBandRetry?: InBandRetryConfig;
  /** Включает ротацию ключей NIM (тикет 15); ставится поверх повтора. */
  rotation?: RotationLayerOptions;
}

export interface InstallResult {
  installed: boolean;
  already: boolean;
  dispatcher?: unknown;
  /** Внутренний nvidia-агент (ProxyAgent или прежний глобальный) — без ротации/повторов. Keys check берёт его, чтобы не открывать новое TCP к прокси. */
  nvidiaDirect?: DispatchTarget;
}

/** Внутренний nvidia-агент последней установки (легаси-одиночка) — keep-alive пул. */
let lastNvidiaDirect: DispatchTarget | undefined;
/** Установленное кольцо прокси (пул) и его ротатор — для pin-агента keys check. */
let lastRing: (SelectiveDispatcherHandle & { __ringAgentFor(href: string): DispatchTarget }) | undefined;
let lastRingRotator: ProxyRotator | undefined;

/**
 * Внутренний nvidia-агент без ротации/повторов: для пула — bare-агент текущего
 * pin (keep-alive, не новый TCP к другому выходу); для легаси-одиночки — тот же
 * ProxyAgent, что и раньше. Keys check и discovery ходят сюда.
 */
export function getNvidiaDirectDispatcher(): DispatchTarget | undefined {
  if (lastRing && lastRingRotator) {
    const pin = lastRingRotator.effectivePin();
    if (pin) return lastRing.__ringAgentFor(pin);
  }
  return lastNvidiaDirect;
}

/**
 * Bare-агент конкретного эндпоинта пула (создаётся лениво). `proxy check`
 * бьёт `GET /v1/models` через агент КАЖДОГО выхода, не только pin.
 */
export function getProxyEndpointAgent(href: string): DispatchTarget | undefined {
  return lastRing?.__ringAgentFor(href);
}

/**
 * Идемпотентная установка: оборачивает текущий глобальный диспетчер один раз.
 * Если пи пересоздаст диспетчер (`/reload`, смена настроек), повторный вызов
 * оберкнёт новый.
 */
export function ensureDispatcherInstalled(deps: DispatcherDeps, options: InstallOptions): InstallResult {
  const current = deps.getGlobalDispatcher();
  if (isOurDispatcher(current)) {
    // Для пула nvidiaDirect ленив: агента pin ещё может не быть — вызывающий
    // берёт его `getNvidiaDirectDispatcher()` когда понадобится (keys check).
    return { installed: false, already: true, dispatcher: current, nvidiaDirect: lastNvidiaDirect };
  }
  const hasPool = !!options.proxyPool;
  // Нечего ставить: ни прокси/пула, ни ротации — поведение как сегодня, обёртка не нужна.
  if (!hasPool && !options.proxyUrl && !options.rotation) return { installed: false, already: false };

  // Сборка внутреннего лука поверх bare-агента: in-band повтор → прозрачный
  // повтор 429/5xx → ротация ключей. Все per-href лук-и разделяют ОДИН
  // key-ротатор и пул ключей (их инжектирует вызывающая сторона в `rotation`).
  const stackInner = (bare: DispatchTarget): DispatchTarget => {
    const inBanded = options.inBandRetry ? withInBandOverloadRetry(bare, options.inBandRetry) : bare;
    const retried =
      options.retry && deps.createRetryAgent
        ? withTransparentRetry(inBanded, options.retry, { createRetryAgent: deps.createRetryAgent })
        : inBanded;
    return options.rotation ? withKeyRotation(retried, options.rotation) : retried;
  };

  // Основание nvidia-маршрута.
  let nvidiaTarget: DispatchTarget;
  let legacyBase: DispatchTarget | undefined;
  if (hasPool) {
    const pool = options.proxyPool as ProxyPoolInstallConfig;
    const ring = withProxyRing(current as DispatchTarget, {
      ...pool,
      createBareAgent: (href) => deps.createProxyAgent(new URL(href)),
      stackInnerLayers: (bare) => stackInner(bare),
    }) as SelectiveDispatcherHandle & { __ringAgentFor(href: string): DispatchTarget };
    lastRing = ring;
    lastRingRotator = pool.rotator;
    lastNvidiaDirect = undefined;
    nvidiaTarget = ring;
  } else {
    // Легаси-одиночка (или только ротация ключей): как сегодня.
    legacyBase = options.proxyUrl ? deps.createProxyAgent(options.proxyUrl) : (current as DispatchTarget);
    nvidiaTarget = stackInner(legacyBase);
    lastRing = undefined;
    lastRingRotator = undefined;
    lastNvidiaDirect = legacyBase;
  }

  const duck = createSelectiveDispatcher({
    nvidia: nvidiaTarget,
    fallback: current as DispatchTarget,
    proxyUrl: hasPool ? undefined : options.proxyUrl?.toString(),
    onObserved: options.onObserved,
    onDiagnostic: options.onDiagnostic,
    onProxyError: options.onProxyError,
  });
  const dispatcher = deps.adapt ? deps.adapt(duck) : duck;
  deps.setGlobalDispatcher(dispatcher);
  return { installed: true, already: false, dispatcher, nvidiaDirect: legacyBase };
}
