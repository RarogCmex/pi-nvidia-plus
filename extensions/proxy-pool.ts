/**
 * Пул прокси-эндпоинтов NIM и кольцевой выбор выхода (`.scratch/proxy-pool/spec.md`).
 * Аналог пула ключей (`keys.ts`): один шов для загрузки, выбора, карантина,
 * маскировки и планирования проб — без пи и без сети. Транспорт (ундичи) о нём
 * не знает: входная точка передаёт пул и ротатор в обёртку-диспетчер, а команды
 * читают отчёт.
 *
 * Источники пула (ровно один побеждает, никогда не мерджатся):
 *  1. `NVIDIA_NIM_PROXIES` — список URL через запятую (одноразовые прогоны);
 *  2. `NVIDIA_NIM_PROXIES_FILE` — произвольный путь к файлу;
 *  3. `~/.pi/agent/nvidia-proxies.json` — файл по умолчанию, ЕСЛИ существует;
 *  4. легаси `NVIDIA_NIM_PROXY` — пул из одного (поведение как сегодня).
 * Формат файла: `{"proxies": ["http://…", …]}`; значения поддерживают
 * `$ENV_VAR`/`${ENV_VAR}`-интерполяцию в стиле пи. Без схемы подразумевается
 * `http://`; допустимые схемы после разбора — только `http` и `https`
 * (ProxyAgent ундичи умеет HTTP CONNECT; `socks://` — ошибка разбора).
 *
 * Расширение файл никогда не пишет. Внутренняя идентичность эндпоинта —
 * нормализованный href с креденшелами (из него строится агент); внешняя
 * (уведомления, статус, логи, разделяемый стейт) — только `maskProxy`
 * (`host:port`, userinfo снят).
 *
 * Состояния эндпоинта: `ready | cooldown` (карантин CONNECT с TTL, по
 * умолчанию 60 с). Вечного denylist нет: 429/401/403/5xx/in-band перегрузка
 * прокси НЕ трогают — это бакеты ключа и транспорта (тикет 21: RPM-бакет —
 * пара (ключ, модель); тикет 30: IP важен только для достижимости/латентности).
 */
import { copyFileSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { t } from "./i18n.ts";
import { interpolateEnvValue } from "./keys.ts";

export const DEFAULT_PROXIES_FILE_NAME = "nvidia-proxies.json";

/** TTL карантина CONNECT: константа фазы 1 (не env-ручка), порядок ключей. */
export const PROXY_QUARANTINE_MS = 60_000;

/** Пробы `proxy check` / префлайт: потолок одной пробы и параллельность. */
export const PROXY_PROBE_TIMEOUT_MS = 10_000;
export const PROXY_CHECK_CONCURRENCY = 2;

/* ------------------------------------------------------------------ */
/* Маскировка и разбор эндпоинта                                       */
/* ------------------------------------------------------------------ */

/**
 * Display identity эндпоинта: `host:port` без userinfo, поиска и хэша;
 * порт по умолчанию схемы опускается. Нераспознанное значение возвращается
 * с вычищенными креденшелами (best effort) — маскировка не должна бросаться.
 */
export function maskProxy(href: string | URL): string {
  try {
    const url = typeof href === "string" ? new URL(href) : href;
    // `URL.host` — hostname плюс порт, когда он не дефолтный для схемы;
    // userinfo в него не входит по определению WHATWG URL.
    return url.host;
  } catch {
    // Мусор на входе: best effort — вычистить userinfo-подобные токены.
    return String(href)
      .replace(/\/\/[^@/]*@/, "//")
      .replace(/[^\s/@]+@/, "");
  }
}

/**
 * Вычистить userinfo из URL-ов в произвольном тексте (сообщения ошибок):
 * `//user:pass@` → `//` и отдельно стоящие `user:pass@`-токены.
 */
export function redactProxyCredentials(text: string): string {
  return text.replace(/\/\/[^@/\s]*@/g, "//").replace(/(^|[\s"'(])[A-Za-z0-9._%+-]+:[^\s@]+@/g, "$1");
}

export interface ParsedProxyEndpoint {
  /** Нормализованный href с креденшелами — внутренняя идентичность (агент). */
  href?: string;
  /** `host:port` без userinfo — внешняя идентичность. */
  display?: string;
  /** Текст ошибки разбора (локализован, значение может содержать креденшелы — redact на вызывающей стороне). */
  error?: string;
}

/**
 * Схемы, которые ProxyAgent ундичи обслуживает нативно: http/https (HTTP
 * CONNECT) и socks5/socks (Socks5ProxyAgent, experimental, в поставке пи с
 * undici 8.9 — тикет 05). `socks5h` нормализуется в `socks5`: нативный клиент
 * всегда отправляет hostname как ATYP DOMAIN (DNS резолвит прокси) — различие
 * `h` для hostname-целей вырождено.
 */
const ALLOWED_PROXY_SCHEMES = new Set(["http:", "https:", "socks5:", "socks:"]);

/**
 * Разбор одного прокси-эндпоинта. Без схемы подразумевается `http://`;
 * неподдержанные схемы (socks4, ftp, …) отклоняются понятной ошибкой.
 */
export function parseProxyEndpoint(raw: string | undefined): ParsedProxyEndpoint {
  const value = raw?.trim();
  if (!value) return { error: t("proxyEndpointEmpty") };
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: t("proxyEndpointParseError", { value: redactProxyCredentials(value) }) };
  }
  if (url.protocol === "socks5h:") url.protocol = "socks5:";
  if (!ALLOWED_PROXY_SCHEMES.has(url.protocol)) {
    return { error: t("proxyEndpointSchemeError", { scheme: url.protocol.replace(/:$/, ""), value: redactProxyCredentials(value) }) };
  }
  if (!url.hostname) {
    return { error: t("proxyEndpointParseError", { value: redactProxyCredentials(value) }) };
  }
  return { href: url.toString(), display: maskProxy(url) };
}

/* ------------------------------------------------------------------ */
/* Разбор источников пула                                              */
/* ------------------------------------------------------------------ */

export interface ProxiesFileContent {
  proxies?: string[];
  error?: string;
}

/** Проверка формы файла прокси: объект с плоским массивом непустых строк. */
export function parseProxiesFileContent(raw: string): ProxiesFileContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: t("proxiesFileNotJson", { error: e instanceof Error ? e.message : String(e) }) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: t("proxiesFileShape") };
  }
  const proxies = (parsed as Record<string, unknown>).proxies;
  if (!Array.isArray(proxies)) return { error: t("proxiesFileNoArray") };
  const out: string[] = [];
  for (const entry of proxies) {
    if (typeof entry !== "string") return { error: t("proxiesFileNotStrings") };
    const trimmed = entry.trim();
    if (!trimmed) return { error: t("proxiesFileEmptyString") };
    out.push(trimmed);
  }
  return { proxies: out };
}

/** Список прокси через запятую (`NVIDIA_NIM_PROXIES`); пустые элементы отбрасываются. */
export function parseInlineProxies(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* ------------------------------------------------------------------ */
/* Пул прокси: источник + горячая перезагрузка                          */
/* ------------------------------------------------------------------ */

export interface ProxyPoolOptions {
  /** Путь по умолчанию (`~/.pi/agent/nvidia-proxies.json`). */
  defaultPath: string;
  /** Окружение: `NVIDIA_NIM_PROXIES[_FILE]`, `NVIDIA_NIM_PROXY` и переменные интерполяции. */
  env: Record<string, string | undefined>;
  /** Одно предупреждение на событие (битый JSON, права, неразрешимое значение…). */
  onWarn?: (message: string) => void;
}

interface LoadedPool {
  hrefs: string[];
  parseErrors: string[];
  mtimeMs: number | undefined;
}

/**
 * Пул прокси с горячей перезагрузкой: один `stat` на обращение; при изменении
 * `mtime` файл перечитывается. Битый/пропавший файл — держим старый пул и
 * предупреждаем один раз (середина правки не должна ронять сессию в direct).
 * Права ≠ 600 — предупреждение, не блокировка. Расширение файл не пишет.
 */
export class ProxyPool {
  private readonly opts: ProxyPoolOptions;
  private loaded: LoadedPool | undefined;
  private loadedFrom: string | undefined;
  private lastParseErrors: string[] = [];
  private warnedParse = false;
  private warnedVanished = false;
  private warnedPerms = false;
  private warnedUnresolved = new Set<string>();
  private warnedEntry = new Set<string>();

  constructor(opts: ProxyPoolOptions) {
    this.opts = opts;
  }

  private inline(): string[] {
    return parseInlineProxies(this.opts.env.NVIDIA_NIM_PROXIES);
  }

  private legacy(): string | undefined {
    const value = this.opts.env.NVIDIA_NIM_PROXY?.trim();
    return value ? value : undefined;
  }

  /**
   * Явный файл или (если существует) файл по умолчанию. Дефолтный файл, из
   * которого мы уже грузились, возвращается и после пропажи — чтобы уход файла
   * mid-session предупреждал (warnVanished), а не молча ронял пул в direct.
   */
  private filePath(): string | undefined {
    const override = this.opts.env.NVIDIA_NIM_PROXIES_FILE?.trim();
    if (override) return override;
    try {
      statSync(this.opts.defaultPath);
      return this.opts.defaultPath;
    } catch {
      if (this.loadedFrom === this.opts.defaultPath) return this.opts.defaultPath;
      return undefined; // файла по умолчанию нет и не было — не источник, не ошибка
    }
  }

  /** Задан ли какой-либо источник пула (инлайн, файл, существующий дефолт, легаси). */
  hasSource(): boolean {
    return this.winningSource() !== undefined;
  }

  /**
   * Победивший источник (ровно один, никогда не мерджатся). Входная точка
   * различает `legacy` (NVIDIA_NIM_PROXY — установка байт-в-байт как сегодня,
   * пул из одного) и пул (инлайн/файл — ставится кольцо).
   */
  winningSource():
    | { kind: "inline" }
    | { kind: "file"; path: string }
    | { kind: "defaultFile"; path: string }
    | { kind: "legacy" }
    | undefined {
    if (this.inline().length > 0) return { kind: "inline" };
    const override = this.opts.env.NVIDIA_NIM_PROXIES_FILE?.trim();
    if (override) return { kind: "file", path: override };
    try {
      statSync(this.opts.defaultPath);
      return { kind: "defaultFile", path: this.opts.defaultPath };
    } catch {
      if (this.loadedFrom === this.opts.defaultPath) {
        return { kind: "defaultFile", path: this.opts.defaultPath };
      }
    }
    if (this.legacy()) return { kind: "legacy" };
    return undefined;
  }

  /** Описание победившего источника для статуса/уведомлений. */
  describe(): string {
    if (this.inline().length > 0) return "NVIDIA_NIM_PROXIES";
    const override = this.opts.env.NVIDIA_NIM_PROXIES_FILE?.trim();
    if (override) return `NVIDIA_NIM_PROXIES_FILE (${override})`;
    const path = this.filePath();
    if (path) {
      return path.endsWith(DEFAULT_PROXIES_FILE_NAME) ? DEFAULT_PROXIES_FILE_NAME : path;
    }
    if (this.legacy()) return "NVIDIA_NIM_PROXY";
    return "—";
  }

  /** Ошибки разбора последнего refresh (панель/интро показывают их вместо «не настроен»). */
  parseErrors(): string[] {
    return [...this.lastParseErrors];
  }

  /**
   * Актуальный пул нормализованных href: инлайн и легаси перечитываются
   * всегда, файл — при смене `mtime`. Дубликаты схлопываются, порядок
   * сохраняется.
   */
  refresh(): string[] {
    const inline = this.inline();
    if (inline.length > 0) return this.resolveEndpoints(inline, "NVIDIA_NIM_PROXIES");

    const path = this.filePath();
    if (!path) {
      const legacy = this.legacy();
      if (legacy) return this.resolveEndpoints([legacy], "NVIDIA_NIM_PROXY");
      // Источника нет вовсе: держим прежний пул, если файл пропал mid-session.
      if (this.loaded) return this.loaded.hrefs;
      this.lastParseErrors = [];
      return [];
    }

    let mtimeMs: number | undefined;
    let mode: number | undefined;
    try {
      const st = statSync(path);
      mtimeMs = st.mtimeMs;
      mode = st.mode;
    } catch {
      // Файл пропал: держим старый пул, предупреждаем один раз.
      if (this.loaded && this.loadedFrom === path) {
        this.warnVanished(path);
        this.lastParseErrors = this.loaded.parseErrors;
        return this.loaded.hrefs;
      }
      this.lastParseErrors = [];
      return [];
    }

    if (this.loaded && this.loadedFrom === path && this.loaded.mtimeMs === mtimeMs) {
      this.lastParseErrors = this.loaded.parseErrors;
      return this.loaded.hrefs;
    }

    // 0o600 — POSIX-only: на Windows chmod-маски не действуют, защита файла
    // опирается на NTFS-ACL каталога пользователя.
    if (mode !== undefined && (mode & 0o777) !== 0o600 && process.platform !== "win32") {
      if (!this.warnedPerms) {
        this.warnedPerms = true;
        this.opts.onWarn?.(`pi-nvidia-plus: ${t("proxiesFilePerms", { path, mode: (mode & 0o777).toString(8) })}`);
      }
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      this.keepOldPool(t("proxiesFileUnreadable", { path, error: e instanceof Error ? e.message : String(e) }));
      this.lastParseErrors = this.loaded?.parseErrors ?? [];
      return this.loaded?.hrefs ?? [];
    }
    const parsed = parseProxiesFileContent(raw);
    if (!parsed.proxies) {
      this.keepOldPool(t("proxiesFileParse", { path, error: parsed.error ?? "?" }));
      this.lastParseErrors = this.loaded?.parseErrors ?? [];
      return this.loaded?.hrefs ?? [];
    }
    const resolved = this.resolveEntries(parsed.proxies, path);
    this.loaded = { hrefs: resolved.hrefs, parseErrors: resolved.parseErrors, mtimeMs };
    this.loadedFrom = path;
    this.lastParseErrors = resolved.parseErrors;
    return resolved.hrefs;
  }

  private keepOldPool(message: string): void {
    // Держим старый пул (если был) и предупреждаем один раз — разбор не удался.
    if (!this.warnedParse) {
      this.warnedParse = true;
      this.opts.onWarn?.(`pi-nvidia-plus: ${message}`);
    }
  }

  private warnVanished(path: string): void {
    if (this.warnedVanished) return;
    this.warnedVanished = true;
    this.opts.onWarn?.(
      `pi-nvidia-plus: ${t("proxiesFileVanished", { path, count: this.loaded?.hrefs.length ?? 0 })}`,
    );
  }

  /** Инлайн/легаси: разбор без кэша mtime (значения из окружения дёшевы). */
  private resolveEndpoints(values: string[], source: string): string[] {
    const resolved = this.resolveEntries(values, source);
    this.lastParseErrors = resolved.parseErrors;
    return resolved.hrefs;
  }

  private resolveEntries(values: string[], source: string): { hrefs: string[]; parseErrors: string[] } {
    const hrefs: string[] = [];
    const parseErrors: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const resolved = interpolateEnvValue(value, this.opts.env);
      if (resolved === undefined || !resolved.trim()) {
        this.warnOnceUnresolved(`unresolved:${value}`, t("proxiesUnresolved", { source, value: redactProxyCredentials(value) }));
        continue;
      }
      const parsed = parseProxyEndpoint(resolved);
      if (!parsed.href) {
        const error = parsed.error ?? t("proxyEndpointParseError", { value: redactProxyCredentials(resolved) });
        parseErrors.push(error);
        this.warnOnceUnresolved(`entry:${source}:${value}`, error);
        continue;
      }
      if (seen.has(parsed.href)) continue; // дубликаты схлопываются, порядок сохраняется
      seen.add(parsed.href);
      hrefs.push(parsed.href);
    }
    return { hrefs, parseErrors };
  }

  private warnOnceUnresolved(id: string, message: string): void {
    if (this.warnedEntry.has(id)) return;
    this.warnedEntry.add(id);
    this.opts.onWarn?.(`pi-nvidia-plus: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Классификация пробы `proxy check`                                    */
/* ------------------------------------------------------------------ */

export type ProxyProbeOutcome = "ok" | "unreachable" | "unknown";

/**
 * Классификация одной пробы (`GET /v1/models` через агент эндпоинта):
 * ЛЮБОЙ HTTP-ответ — выход достижим (`ok`), включая 401/429/5xx: вопрос
 * пробы — достижимость, не авторизация. CONNECT-класс ошибок — `unreachable`;
 * прочее (таймауты пробы, DNS-заглушки, неизвестное) — `unknown`.
 */
export function classifyProxyProbe(result: { status?: number; error?: unknown }): ProxyProbeOutcome {
  if (typeof result.status === "number") return "ok";
  if (isConnectClassError(result.error)) return "unreachable";
  return "unknown";
}

/**
 * Единый набор CONNECT-кодов для кольца и классификатора проб: `check` и
 * живой dispatch обязаны карантинить один и тот же класс ошибок (иначе
 * EHOSTUNREACH свежего коннекта — симптом из A/B тикета 30 — карантинился
 * бы пробой, но не кольцом).
 */
export const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "EPROXYAUTH",
  // UND_ERR_HEADERS_TIMEOUT намеренно НЕ здесь: CONNECT уже состоялся, медлит
  // origin — это «медленный выход» (unknown), а не недостижимый (спека:
  // unreachable — только CONNECT-класс; A/B: индонезийский таймаут ~140 с).
]);

export function isConnectClassError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 4) return false;
  const record = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof record.code === "string") {
    if (CONNECT_ERROR_CODES.has(record.code)) return true;
    // Тикет 05: класс ошибок нативного SOCKS5-клиента ундичи — UND_ERR_SOCKS5*,
    // включая динамические UND_ERR_SOCKS5_REPLY_<N> (host unreachable и т.п.).
    if (record.code.startsWith("UND_ERR_SOCKS5")) return true;
  }
  // Таймауты SOCKS-рукопожатия ундичи бросает без `code` (проверено на живой
  // 8.9.0: `new Error('SOCKS5 connection timeout')`) — узнаём по тексту.
  if (typeof record.message === "string" && /^SOCKS5 (?:connection|authentication) timeout$/.test(record.message)) return true;
  if (record.cause && isConnectClassError(record.cause, depth + 1)) return true;
  if (Array.isArray(record.errors) && record.errors.some((e) => isConnectClassError(e, depth + 1))) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Ротатор: pin, карантин, least inFlight, сдвиг кольца                 */
/* ------------------------------------------------------------------ */

export type ProxyPick = { kind: "proxy"; href: string } | { kind: "direct" };

export interface ProxyEndpointStatus {
  /** Display identity (`host:port`) — только она покидает шов. */
  display: string;
  state: "ready" | "cooldown";
  cooldownLeftMs: number;
  pinned: boolean;
  /** Последняя измеренная латентность успешной пробы/ответа (exit quality). */
  lastLatencyMs?: number;
  inFlight: number;
}

export interface ProxyRotatorOptions {
  /** Источник псевдослучайности в [0,1) — для тестов; по умолчанию `Math.random`. */
  random?: () => number;
  /** TTL карантина CONNECT (по умолчанию `PROXY_QUARANTINE_MS`). */
  quarantineMs?: number;
}

interface SharedProxyStateFile {
  /** Кулдауны по display identity: абсолютные дедлайны, просроченные отмирают. */
  cooldownUntil?: Record<string, number>;
}

/**
 * Замена файла через rename (как в keys.ts). На Windows `renameSync` поверх
 * занятого файла (антивирус, другой процесс пи) бросает EPERM/EEXIST —
 * fallback: копирование + удаление; разделяемое состояние и так best effort.
 */
function renamePortable(tmp: string, target: string): void {
  try {
    renameSync(tmp, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EEXIST" && code !== "EBUSY") throw err;
    copyFileSync(tmp, target);
    rmSync(tmp, { force: true });
  }
}

/**
 * Сессионное состояние выбора выхода: пул, pin, карантины (TTL), занятость.
 * Pick происходит ОДИН раз на входящий nvidia-`dispatch` и держится на весь
 * внутренний круг ключей и прозрачных повторов (pin-инвариант спеки);
 * внутризапросный CONNECT-failover — фаза 2, здесь его нет.
 *
 * Внутренний ключ состояния — href (с креденшелами); внешний — display.
 * Разделяемый файл keyed только по display identity.
 */
export class ProxyRotator {
  private pool: string[] = [];
  /** Пул в порядке обхода (псевдослучайный циклический сдвиг на входе). */
  private ring: string[] = [];
  private cooldownUntil = new Map<string, number>();
  private lastLatency = new Map<string, number>();
  private inFlight = new Map<string, number>();
  private pinned: string | undefined;
  private sharedPath: string | undefined;
  private sharedStamp = "";
  private readonly random: () => number;
  private readonly quarantineMs: number;

  constructor(opts?: ProxyRotatorOptions) {
    this.random = opts?.random ?? Math.random;
    this.quarantineMs = opts?.quarantineMs ?? PROXY_QUARANTINE_MS;
  }

  /** Подключить разделяемый файл состояния (тикеты 26/04). Идемпотентно. */
  attachSharedState(path: string): void {
    this.sharedPath = path;
  }

  /**
   * Пул нормализованных href. Дубликаты убираются, порядок сохраняется;
   * кольцо входа разворачивается псевдослучайным циклическим сдвигом, чтобы
   * веер процессов pi-subagents не входил в кольцо с одного выхода.
   * При смене состава: выбывшие href теряют pin/кулдауны/латентности/занятость,
   * разделяемый файл сверяется с пулом (чужие display id выбрасываются).
   */
  setPool(hrefs: string[]): void {
    const next = [...new Set(hrefs)];
    const changed = next.length !== this.pool.length || next.some((h, i) => h !== this.pool[i]);
    this.pool = next;
    this.ring = this.circularShift(next);
    if (!changed) return;
    const poolSet = new Set(next);
    if (this.pinned && !poolSet.has(this.pinned)) {
      // Pin на выбывшем href падает на первый оставшийся (спека: «falls back to
      // first remaining»), а не в «нет pin».
      this.pinned = next[0];
    }
    for (const href of [...this.cooldownUntil.keys()]) {
      if (!poolSet.has(href)) this.cooldownUntil.delete(href);
    }
    for (const href of [...this.lastLatency.keys()]) {
      if (!poolSet.has(href)) this.lastLatency.delete(href);
    }
    for (const href of [...this.inFlight.keys()]) {
      if (!poolSet.has(href)) this.inFlight.delete(href);
    }
    this.reconcileSharedWithPool();
  }

  /** Циклический псевдослучайный сдвиг кольца (идея из key-ротатора). */
  private circularShift(hrefs: string[]): string[] {
    if (hrefs.length < 2) return [...hrefs];
    const offset = Math.floor(this.random() * hrefs.length);
    if (offset === 0) return [...hrefs];
    return hrefs.slice(offset).concat(hrefs.slice(0, offset));
  }

  /** Явный pin по внутреннему href (check/диспетчер). False — href не в пуле. */
  pin(href: string): boolean {
    if (!this.pool.includes(href)) return false;
    this.pinned = href;
    return true;
  }

  /** Внутренний href по display identity (или undefined). */
  hrefForDisplay(display: string): string | undefined {
    const wanted = display.trim();
    return this.pool.find((h) => maskProxy(h) === wanted);
  }

  /** Явный pin по display identity (`/nvidia-plus proxy pin host:port`). */
  pinByDisplay(display: string): boolean {
    const href = this.hrefForDisplay(display);
    if (!href) return false;
    this.pinned = href;
    return true;
  }

  /**
   * Применить итоги `proxy check`: ok пишет exit quality и гасит карантин,
   * unreachable карантинит (TTL); pin переклеивается на самый быстрый ok
   * (ноль ok — pin не меняется, спека тикета 02). Возвращает display нового
   * pin или undefined.
   */
  applyProbeResults(rows: readonly ProxyProbeResultRow[], now: number = Date.now()): string | undefined {
    for (const row of rows) {
      const href = this.hrefForDisplay(row.display);
      if (!href) continue;
      if (row.outcome === "ok") this.markOk(href, row.latencyMs ?? 0, now);
      else if (row.outcome === "unreachable") this.markConnectFailed(href, now);
    }
    const fastest = fastestOk(rows);
    if (!fastest) return undefined;
    const href = this.hrefForDisplay(fastest.display);
    if (!href) return undefined;
    this.pin(href);
    return fastest.display;
  }

  /** Текущий явный pin (href) — для агента pin-эндпоинта (keys check, префлайт). */
  pinnedHref(): string | undefined {
    if (this.pinned && this.pool.includes(this.pinned)) return this.pinned;
    return undefined;
  }

  /**
   * Эффективный pin: явный, иначе первый эндпоинт победившего источника.
   * Панель/интро/префлайт и pick с выключенной ротацией согласованы с ним.
   */
  effectivePin(): string | undefined {
    return this.pinnedHref() ?? this.pool[0];
  }

  /** Остаток карантина в мс (0 — готов). */
  cooldownLeft(href: string, now: number): number {
    return Math.max(0, (this.cooldownUntil.get(href) ?? 0) - now);
  }

  /** Сколько dispatch прямо сейчас работают через выход. */
  inFlightCount(href: string): number {
    return this.inFlight.get(href) ?? 0;
  }

  noteInFlight(href: string): void {
    this.inFlight.set(href, (this.inFlight.get(href) ?? 0) + 1);
  }

  releaseInFlight(href: string): void {
    const left = (this.inFlight.get(href) ?? 0) - 1;
    if (left <= 0) this.inFlight.delete(href);
    else this.inFlight.set(href, left);
  }

  /**
   * Выбор выхода на ОДИН dispatch (порядок из спеки):
   *  1. ротация выключена → pin (или первый эндпоинт), без skip/сдвига/inFlight;
   *  2. pin, если в пуле и ready;
   *  3. среди ready — least inFlight, pin выигрывает ничью (порядок кольца
   *     разводит веер процессов);
   *  4. все в cooldown → ближайший expiry, dispatch не спит;
   *  5. пул пуст → direct (флаг opt-in fallback проверяет вызывающий —
   *     rotator про пул знает только то, что он пуст).
   */
  pick(now: number, options: { rotationEnabled: boolean }): ProxyPick {
    this.mergeShared(now);
    if (this.pool.length === 0) return { kind: "direct" };
    if (!options.rotationEnabled) {
      const locked = this.pinnedHref() ?? this.pool[0];
      this.pinned = locked;
      return { kind: "proxy", href: locked };
    }
    const pinned = this.pinnedHref();
    const ready = this.ring.filter((h) => this.cooldownLeft(h, now) === 0);
    if (ready.length > 0) {
      // Шаги 2–3 спеки одной строкой (как в `RotationRequest.pick` для ключей):
      // среди ready — наименее занятый, pin выигрывает ничью. Так липкий выход
      // удерживается в последовательном диалоге (inFlight везде 0), а веер
      // пи-сабагентов расходится по разным выходам (story 32), не толпясь на pin.
      let minInFlight = Infinity;
      for (const h of ready) minInFlight = Math.min(minInFlight, this.inFlightCount(h));
      const freest = ready.filter((h) => this.inFlightCount(h) === minInFlight);
      const chosen = pinned && freest.includes(pinned) ? pinned : freest[0];
      this.pinned = chosen;
      return { kind: "proxy", href: chosen };
    }
    // Все в карантине: ближайший expiry (фаза 1 никогда не блокирует dispatch).
    let nearest = this.ring[0];
    let nearestLeft = this.cooldownLeft(nearest, now);
    for (const h of this.ring) {
      const left = this.cooldownLeft(h, now);
      if (left < nearestLeft) {
        nearest = h;
        nearestLeft = left;
      }
    }
    this.pinned = nearest;
    return { kind: "proxy", href: nearest };
  }

  /** CONNECT-ошибка: карантин на TTL (не вечный denylist). */
  markConnectFailed(href: string, now: number = Date.now()): void {
    if (!this.pool.includes(href)) return;
    this.cooldownUntil.set(href, now + this.quarantineMs);
    this.persistShared(now);
  }

  /**
   * Успешный ответ/проба: записать exit quality и снять карантин — успех
   * доказывает достижимость (в том числе чужой разделяемый карантин).
   */
  markOk(href: string, latencyMs: number, now: number = Date.now()): void {
    if (!this.pool.includes(href)) return;
    this.lastLatency.set(href, latencyMs);
    const hadCooldown = (this.cooldownUntil.get(href) ?? 0) > 0;
    this.cooldownUntil.delete(href);
    // Успех доказывает достижимость — снимаем и чужой разделяемый карантин
    // (иначе merge-by-max воскресил бы запись, которую мы только что стёрли).
    if (hadCooldown) this.persistShared(now, new Set([maskProxy(href)]));
  }

  /** Статус пула для панели (только display identity). */
  statusFor(now: number): ProxyEndpointStatus[] {
    // Панель должна видеть разделяемые карантины без pick.
    this.mergeShared(now);
    const pinned = this.effectivePin();
    return this.pool.map((href) => {
      const cooldownLeftMs = this.cooldownLeft(href, now);
      return {
        display: maskProxy(href),
        state: cooldownLeftMs > 0 ? "cooldown" : "ready",
        cooldownLeftMs,
        pinned: href === pinned,
        lastLatencyMs: this.lastLatency.get(href),
        inFlight: this.inFlightCount(href),
      };
    });
  }

  /* ── Разделяемое состояние (тикет 04) ─────────────────────────────── */

  /** Подтянуть свежие записи из файла (просроченные TTL игнорируются). */
  private mergeShared(now: number): void {
    if (!this.sharedPath) return;
    let stamp: string;
    try {
      const st = statSync(this.sharedPath);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      return; // файла ещё нет — нормально
    }
    if (stamp === this.sharedStamp) return;
    this.sharedStamp = stamp;
    let parsed: SharedProxyStateFile;
    try {
      parsed = JSON.parse(readFileSync(this.sharedPath, "utf8")) as SharedProxyStateFile;
    } catch {
      return; // битый файл — игнорируем, pick живёт из памяти
    }
    const poolDisplays = new Set(this.pool.map((h) => maskProxy(h)));
    for (const [display, until] of Object.entries(parsed.cooldownUntil ?? {})) {
      if (typeof until !== "number" || until <= now) continue;
      if (!poolDisplays.has(display)) continue;
      for (const href of this.pool) {
        if (maskProxy(href) !== display) continue;
        const existing = this.cooldownUntil.get(href) ?? 0;
        if (until > existing) this.cooldownUntil.set(href, until); // merge по max
      }
    }
  }

  /**
   * Выгрузить кулдауны в файл: ключи — display identity (никогда
   * credentialed URL), merge по max, просроченное выбрасывается, tmp+rename,
   * права 600. Last-writer-wins допустим: данные монотонны (TTL).
   */
  private persistShared(now: number, cleared?: Set<string>): void {
    if (!this.sharedPath) return;
    let existing: SharedProxyStateFile = {};
    try {
      existing = JSON.parse(readFileSync(this.sharedPath, "utf8")) as SharedProxyStateFile;
    } catch {
      // нет/битый — начинаем с пустого
    }
    const poolDisplays = new Set(this.pool.map((h) => maskProxy(h)));
    const cooldowns: Record<string, number> = {};
    for (const [display, until] of Object.entries(existing.cooldownUntil ?? {})) {
      if (typeof until !== "number" || until <= now) continue;
      if (!poolDisplays.has(display)) continue; // чужие записи отбрасываются
      if (cleared?.has(display)) continue; // успех снял карантин
      cooldowns[display] = until;
    }
    for (const href of this.pool) {
      const until = this.cooldownUntil.get(href) ?? 0;
      if (until <= now) continue;
      const display = maskProxy(href);
      if (cleared?.has(display)) continue;
      cooldowns[display] = Math.max(cooldowns[display] ?? 0, until);
    }
    const tmp = `${this.sharedPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ cooldownUntil: cooldowns }), { mode: 0o600 });
      renamePortable(tmp, this.sharedPath);
      try {
        const st = statSync(this.sharedPath);
        this.sharedStamp = `${st.mtimeMs}:${st.size}`; // своя запись — не перечитывать
      } catch {
        // ок
      }
    } catch {
      // разделяемое состояние — best effort: жить в памяти
    }
  }

  /** Сверка файла с пулом: display id, которых в пуле больше нет, выбрасываются. */
  private reconcileSharedWithPool(): void {
    if (!this.sharedPath) return;
    let existing: SharedProxyStateFile;
    try {
      existing = JSON.parse(readFileSync(this.sharedPath, "utf8")) as SharedProxyStateFile;
    } catch {
      return; // файла нет — чистить нечего
    }
    const poolDisplays = new Set(this.pool.map((h) => maskProxy(h)));
    const now = Date.now();
    const cooldownUntil: Record<string, number> = {};
    let changed = false;
    for (const [display, until] of Object.entries(existing.cooldownUntil ?? {})) {
      if (typeof until !== "number" || until <= now) {
        changed = true; // заодно выбрасываем просроченные
        continue;
      }
      if (!poolDisplays.has(display)) {
        changed = true;
        continue;
      }
      cooldownUntil[display] = until;
    }
    if (!changed) return;
    const tmp = `${this.sharedPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ cooldownUntil }), { mode: 0o600 });
      renamePortable(tmp, this.sharedPath);
      // Содержимое только что переписано (чужие выжившие записи остались):
      // сбросим штамп, чтобы следующий mergeShared перечитал их в память.
      this.sharedStamp = "";
    } catch {
      // best effort: сможем при следующей сверке
    }
  }
}

/* ------------------------------------------------------------------ */
/* Планирование проб `proxy check` (чистая часть команды)                */
/* ------------------------------------------------------------------ */

export interface ProxyProbeEndpoint {
  href: string;
  display: string;
}

export interface ProxyProbeAttempt {
  status?: number;
  error?: unknown;
}

export interface ProxyProbeResultRow {
  display: string;
  outcome: ProxyProbeOutcome;
  latencyMs?: number;
  /** Redacted-текст ошибки (для unknown-примера в сводке). */
  error?: string;
}

export interface ProxyProbePlan {
  rows: ProxyProbeResultRow[];
  /** Esc прервал хвост: сводка по уже полученным. */
  aborted: boolean;
  /** Сколько эндпоинтов реально пробовалось. */
  probed: number;
  /** Сколько пропущено из-за аборта. */
  skipped: number;
}

/** Самый быстрый `ok` — будущий pin; `undefined`, если ok нет вовсе. */
export function fastestOk(rows: readonly ProxyProbeResultRow[]): ProxyProbeResultRow | undefined {
  let best: ProxyProbeResultRow | undefined;
  for (const row of rows) {
    if (row.outcome !== "ok" || row.latencyMs === undefined) continue;
    if (!best || row.latencyMs < (best.latencyMs ?? Infinity)) best = row;
  }
  return best;
}

/**
 * Прогнать пробы по пулу: параллельность (по умолчанию 2 — жилые провайдеры
 * не должны видеть веер CONNECT-ов), порядок строк = порядок пула, аборт
 * останавливает ХВОСТ (уже запущенные пробы завершаются). Транспорт инжектируется:
 * шов не знает про ундичи и сеть.
 */
export async function runProxyProbes(
  endpoints: readonly ProxyProbeEndpoint[],
  probe: (endpoint: ProxyProbeEndpoint) => Promise<ProxyProbeAttempt>,
  options: { concurrency?: number; isAborted?: () => boolean } = {},
): Promise<ProxyProbePlan> {
  const concurrency = Math.max(1, options.concurrency ?? PROXY_CHECK_CONCURRENCY);
  const isAborted = options.isAborted ?? (() => false);
  const rows: ProxyProbeResultRow[] = [];
  const order: ProxyProbeEndpoint[] = [...endpoints];
  let cursor = 0;
  let probed = 0;
  let skipped = 0;
  let aborted = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isAborted()) {
        aborted = true;
        break;
      }
      if (cursor >= order.length) break;
      const endpoint = order[cursor];
      const index = cursor;
      cursor += 1;
      const startedAt = Date.now();
      let attempt: ProxyProbeAttempt;
      try {
        attempt = await probe(endpoint);
      } catch (e) {
        attempt = { error: e };
      }
      probed += 1;
      const outcome = classifyProxyProbe(attempt);
      rows[index] = {
        display: endpoint.display,
        outcome,
        latencyMs: outcome === "ok" ? Date.now() - startedAt : undefined,
        error: attempt.error === undefined ? undefined : redactProxyCredentials(String(attempt.error)).slice(0, 120),
      };
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, order.length)) }, worker));
  // Хвост, не дошедший до пробы из-за аборта.
  for (let i = rows.length; i < order.length; i++) skipped += 1;
  const compact = rows.filter((r): r is ProxyProbeResultRow => !!r);
  return { rows: compact, aborted: aborted || skipped > 0, probed, skipped };
}
