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
 * Референс: `.scratch/pi-nvidia-plus/issues/04-proxy-mechanics.md` (вариант A).
 */

export const NVIDIA_ORIGIN = "https://integrate.api.nvidia.com";

export interface ParsedProxy {
  url?: URL;
  error?: string;
}

/** Разбор `NVIDIA_NIM_PROXY`. Без схемы подразумевается `http://`. */
export function parseProxyUrl(raw: string | undefined): ParsedProxy {
  const value = raw?.trim();
  if (!value) return {};
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    return { url: new URL(candidate) };
  } catch {
    return { error: `не удалось разобрать NVIDIA_NIM_PROXY: ${value}` };
  }
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

/** Заголовки из плоского массива undici `[k1, v1, k2, v2]` или объекта; ключи в нижний регистр. */
export function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      const key = headers[i];
      const value = headers[i + 1];
      if (typeof key === "string" && typeof value === "string") out[key.toLowerCase()] = value;
    }
  } else if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === "string") out[key.toLowerCase()] = value;
    }
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
  const retry = d.retryAfterMs !== undefined ? `, повтор через ${Math.max(1, Math.round(d.retryAfterMs / 1000))} с` : "";
  const id = d.requestId ? `, запрос ${d.requestId}` : "";
  if (d.status === 429) return `NIM 429: ограничение частоты${retry}${id}`;
  return `NIM ${d.status}: ошибка сервера${retry}${id}`;
}

const PROXY_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isProxyConnectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && PROXY_CONNECT_CODES.has(code);
}

/** Понятная ошибка при недоступном прокси. */
export function describeProxyFailure(proxyUrl: string, cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const detail = code ?? (cause instanceof Error ? cause.message : String(cause));
  return `прокси NIM ${proxyUrl} недоступен (${detail}) — проверьте переменную NVIDIA_NIM_PROXY`;
}

export interface DispatchTarget {
  dispatch(opts: unknown, handler: unknown): boolean;
}

export interface SelectiveDispatcherOptions {
  /** Куда идут запросы к NIM (обычно `undici.ProxyAgent`). */
  nvidia: DispatchTarget;
  /** Прежний глобальный диспетчер — для всего остального трафика. */
  fallback: DispatchTarget;
  /** Адрес прокси — для понятных сообщений об ошибках. */
  proxyUrl: string;
  /** Вызывается на каждый ответ NIM (после парсинга заголовков). */
  onObserved?: (status: number, headers: Record<string, string>) => void;
  /** Вызывается для ответов 429/5xx. */
  onDiagnostic?: (diagnostic: NimDiagnostic) => void;
}

const OUR_DISPATCHER_MARK = "__piNvidiaPlusSelectiveDispatcher";

export function isOurDispatcher(dispatcher: unknown): boolean {
  return !!dispatcher && (dispatcher as Record<string, unknown>)[OUR_DISPATCHER_MARK] === true;
}

/**
 * Обёртка-диспетчер (утиная типизация: наследование от класса undici
 * добавляет входная точка, если нужно). Наблюдает ответы и ошибки соединения
 * на nvidia-маршруте, остальное делегирует как есть.
 */
export function createSelectiveDispatcher(options: SelectiveDispatcherOptions): DispatchTarget & Record<string, unknown> {
  const { nvidia, fallback, proxyUrl, onObserved, onDiagnostic } = options;

  function wrapHandler(handler: unknown): unknown {
    const target = (handler ?? {}) as Record<string, unknown>;
    return new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === "onResponse") {
          return (statusCode: number, headers: unknown) => {
            try {
              const record = headersToRecord(headers);
              onObserved?.(statusCode, record);
              const diagnostic = extractDiagnostics(statusCode, record);
              if (diagnostic) onDiagnostic?.(diagnostic);
            } catch {
              // наблюдение не должно ломать запрос
            }
            const original = obj.onResponse;
            return typeof original === "function" ? original.call(obj, statusCode, headers) : true;
          };
        }
        if (prop === "onError") {
          return (err: unknown) => {
            let reported: unknown = err;
            if (isProxyConnectError(err)) {
              const wrapped = new Error(describeProxyFailure(proxyUrl, err));
              wrapped.cause = err;
              (wrapped as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException).code;
              reported = wrapped;
            }
            const original = obj.onError;
            return typeof original === "function" ? original.call(obj, reported) : true;
          };
        }
        return Reflect.get(obj, prop, receiver);
      },
    });
  }

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
        return nvidia.dispatch(opts, wrapHandler(handler));
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
}

export interface InstallOptions {
  proxyUrl: URL;
  onObserved?: (status: number, headers: Record<string, string>) => void;
  onDiagnostic?: (diagnostic: NimDiagnostic) => void;
}

export interface InstallResult {
  installed: boolean;
  already: boolean;
  dispatcher?: unknown;
}

/**
 * Идемпотентная установка: оборачивает текущий глобальный диспетчер один раз.
 * Если пи пересоздаст диспетчер (`/reload`, смена настроек), повторный вызов
 * оберкнёт новый.
 */
export function ensureDispatcherInstalled(deps: DispatcherDeps, options: InstallOptions): InstallResult {
  const current = deps.getGlobalDispatcher();
  if (isOurDispatcher(current)) return { installed: false, already: true, dispatcher: current };
  const proxyAgent = deps.createProxyAgent(options.proxyUrl);
  const dispatcher = createSelectiveDispatcher({
    nvidia: proxyAgent,
    fallback: current as DispatchTarget,
    proxyUrl: options.proxyUrl.toString(),
    onObserved: options.onObserved,
    onDiagnostic: options.onDiagnostic,
  });
  deps.setGlobalDispatcher(dispatcher);
  return { installed: true, already: false, dispatcher };
}
