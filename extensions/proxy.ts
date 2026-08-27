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
 * Задержка перед повтором: `retry-after-ms` (заголовок NIM) > `retry-after`
 * (секунды или HTTP-дата) > экспоненциальный откат; всегда в пределах `[0, maxDelayMs]`.
 */
export function resolveRetryDelayMs(
  headers: Record<string, string>,
  attempt: number,
  config: { minDelayMs: number; maxDelayMs: number },
  now: number = Date.now(),
): number {
  const clamp = (value: number): number => Math.max(0, Math.min(value, config.maxDelayMs));
  const ms = headers["retry-after-ms"];
  if (ms !== undefined) {
    const value = Number.parseFloat(ms);
    if (Number.isFinite(value)) return clamp(value);
  }
  const raw = headers["retry-after"];
  if (raw !== undefined) {
    const seconds = Number.parseFloat(raw);
    if (!Number.isNaN(seconds)) return clamp(seconds * 1000);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return clamp(date - now);
  }
  return clamp(config.minDelayMs * 2 ** Math.max(0, attempt - 1));
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
    close(): Promise<void> {
      return Promise.resolve((retryAgent as { close?: () => Promise<void> }).close?.());
    },
    destroy(): Promise<void> {
      return Promise.resolve((retryAgent as { destroy?: () => Promise<void> }).destroy?.());
    },
  };
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
  proxyUrl: string,
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

export interface InstallOptions {
  proxyUrl: URL;
  onObserved?: (status: number, headers: Record<string, string>) => void;
  onDiagnostic?: (diagnostic: NimDiagnostic) => void;
  onProxyError?: (message: string, cause: unknown) => void;
  /** Включает прозрачный транспортный повтор 429/5xx (нужен `deps.createRetryAgent`). */
  retry?: TransportRetryConfig;
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
  // Прозрачный повтор 429/5xx: наблюдатель выше повторителя и видит только конечный исход.
  const nvidiaTarget =
    options.retry && deps.createRetryAgent
      ? withTransparentRetry(proxyAgent, options.retry, { createRetryAgent: deps.createRetryAgent })
      : proxyAgent;
  const duck = createSelectiveDispatcher({
    nvidia: nvidiaTarget,
    fallback: current as DispatchTarget,
    proxyUrl: options.proxyUrl.toString(),
    onObserved: options.onObserved,
    onDiagnostic: options.onDiagnostic,
    onProxyError: options.onProxyError,
  });
  const dispatcher = deps.adapt ? deps.adapt(duck) : duck;
  deps.setGlobalDispatcher(dispatcher);
  return { installed: true, already: false, dispatcher };
}
