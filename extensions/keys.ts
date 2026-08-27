/**
 * Пул ключей NIM и выбор ключа для ротации (тикет 15). Модуль чистый:
 * транспорт (ундичи) ничего о нём не знает — входная точка передаёт пул и
 * ротатор в обёртку-диспетчер, а команды/уведомления читают отчёт.
 *
 * Источники пула (по приоритету):
 *  1. `NVIDIA_NIM_KEYS` — список через запятую (одноразовые прогоны);
 *  2. `NVIDIA_NIM_KEYS_FILE` — произвольный путь к файлу;
 *  3. `~/.pi/agent/nvidia-keys.json` — файл по умолчанию.
 * Формат файла: `{"keys": ["nvapi-…", …]}`; значения поддерживают
 * `$ENV_VAR`/`${ENV_VAR}`-интерполяцию в стиле пи. Ключ пи всегда первый в
 * кольце запроса (его подставляет сам пи в `Authorization`).
 *
 * Расширение файл только читает; запись — всегда вручную. Ключи никогда не
 * попадают в отчёты целиком — только маскированные суффиксы (`maskKey`).
 */
import { readFileSync, statSync } from "node:fs";

export const DEFAULT_KEYS_FILE_NAME = "nvidia-keys.json";

/* ------------------------------------------------------------------ */
/* Маскировка                                                          */
/* ------------------------------------------------------------------ */

/** Маскированный суффикс ключа для уведомлений/статусов/логов: `…abcd`. */
export function maskKey(key: string): string {
  if (!key) return "…";
  return `…${key.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* Интерполяция в стиле пи (`$ENV_VAR`, `${ENV_VAR}`, `$$` → `$`)       */
/* ------------------------------------------------------------------ */

const ENV_NAME = /[A-Za-z_][A-Za-z0-9_]*/y;

/**
 * Интерполяция значения в стиле пи: `$VAR` и `${VAR}` подставляются из
 * окружения, `$$` — литерал `$`. Если переменная не задана — значение
 * неразрешимо (`undefined`), как в пи.
 */
export function interpolateEnvValue(raw: string, env: Record<string, string | undefined>): string | undefined {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    const next = raw[i + 1];
    if (next === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (next === "{") {
      const end = raw.indexOf("}", i + 2);
      if (end < 0) return undefined;
      const name = raw.slice(i + 2, end);
      const value = env[name];
      if (value === undefined) return undefined;
      out += value;
      i = end + 1;
      continue;
    }
    ENV_NAME.lastIndex = i + 1;
    const match = ENV_NAME.exec(raw);
    if (!match || match.index !== i + 1) return undefined;
    const value = env[match[0]];
    if (value === undefined) return undefined;
    out += value;
    i += 1 + match[0].length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Разбор источников пула                                              */
/* ------------------------------------------------------------------ */

export interface KeysFileContent {
  keys?: string[];
  error?: string;
}

/** Проверка формы файла ключей: объект с плоским массивом непустых строк. */
export function parseKeysFileContent(raw: string): KeysFileContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `файл ключей — не JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: 'файл ключей: ожидается объект {"keys": [...]}' };
  }
  const keys = (parsed as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) return { error: 'файл ключей: нет массива "keys"' };
  const out: string[] = [];
  for (const entry of keys) {
    if (typeof entry !== "string") return { error: "файл ключей: в \"keys\" только строки" };
    const trimmed = entry.trim();
    if (!trimmed) return { error: "файл ключей: пустая строка в \"keys\"" };
    out.push(trimmed);
  }
  return { keys: out };
}

/** Список ключей через запятую (`NVIDIA_NIM_KEYS`); пустые элементы отбрасываются. */
export function parseInlineKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* ------------------------------------------------------------------ */
/* Пул ключей: источник + горячая перезагрузка                          */
/* ------------------------------------------------------------------ */

export interface KeyPoolOptions {
  /** Путь по умолчанию (`~/.pi/agent/nvidia-keys.json`). */
  defaultPath: string;
  /** Окружение: `NVIDIA_NIM_KEYS`, `NVIDIA_NIM_KEYS_FILE` и переменные для интерполяции. */
  env: Record<string, string | undefined>;
  /** Одно предупреждение на событие (битый JSON, права, неразрешимый ключ…). */
  onWarn?: (message: string) => void;
}

interface LoadedPool {
  keys: string[];
  mtimeMs: number | undefined;
}

/**
 * Пул ключей с горячей перезагрузкой: один `stat` на обращение; при изменении
 * `mtime` файл перечитывается. Битый файл/пропавший файл — держим старый пул
 * и предупреждаем один раз. Права ≠ 600 — предупреждение, не блокировка.
 */
export class KeyPool {
  private readonly opts: KeyPoolOptions;
  private loaded: LoadedPool | undefined;
  private loadedFrom: string | undefined;
  private warnedParse = false;
  private warnedPerms = false;
  private warnedUnresolved = new Set<string>();

  constructor(opts: KeyPoolOptions) {
    this.opts = opts;
  }

  private inline(): string[] {
    return parseInlineKeys(this.opts.env.NVIDIA_NIM_KEYS);
  }

  private filePath(): string | undefined {
    const override = this.opts.env.NVIDIA_NIM_KEYS_FILE?.trim();
    return override ? override : this.opts.defaultPath;
  }

  /** Задан ли какой-либо источник пула (инлайн, переопределённый или существующий файл). */
  hasSource(): boolean {
    if (this.inline().length > 0) return true;
    const path = this.filePath();
    if (!path) return false;
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Описание источника для статуса/уведомлений. */
  describe(): string {
    if (this.inline().length > 0) return "NVIDIA_NIM_KEYS";
    if (this.opts.env.NVIDIA_NIM_KEYS_FILE?.trim()) return `NVIDIA_NIM_KEYS_FILE (${this.opts.env.NVIDIA_NIM_KEYS_FILE.trim()})`;
    return this.opts.defaultPath.endsWith(DEFAULT_KEYS_FILE_NAME) ? DEFAULT_KEYS_FILE_NAME : this.opts.defaultPath;
  }

  /** Актуальный пул: инлайн перечитывается всегда, файл — при смене `mtime`. */
  refresh(): string[] {
    const inline = this.inline();
    if (inline.length > 0) return this.resolveKeys(inline, "NVIDIA_NIM_KEYS");

    const path = this.filePath();
    if (!path) return this.loaded?.keys ?? [];

    let mtimeMs: number | undefined;
    let mode: number | undefined;
    try {
      const st = statSync(path);
      mtimeMs = st.mtimeMs;
      mode = st.mode;
    } catch {
      // Файл пропал: держим старый пул, предупреждаем один раз.
      if (this.loaded && this.loadedFrom === path) {
        this.warnOnce("vanished", `файл ключей ${path} пропал — использую прежний пул (${this.loaded.keys.length} кл.)`);
        return this.loaded.keys;
      }
      return [];
    }

    if (this.loaded && this.loadedFrom === path && this.loaded.mtimeMs === mtimeMs) {
      return this.loaded.keys;
    }

    if (mode !== undefined && (mode & 0o777) !== 0o600 && process.platform !== "win32") {
      if (!this.warnedPerms) {
        this.warnedPerms = true;
        this.opts.onWarn?.(`файл ключей ${path} имеет права ${(mode & 0o777).toString(8)} — рекомендуется 600 (ключи читаются, но лучше ограничить)`);
      }
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      this.keepOldPool(path, `файл ключей ${path} не читается (${e instanceof Error ? e.message : String(e)})`);
      return this.loaded?.keys ?? [];
    }
    const parsed = parseKeysFileContent(raw);
    if (!parsed.keys) {
      this.keepOldPool(path, `файл ключей ${path}: ${parsed.error}`);
      return this.loaded?.keys ?? [];
    }
    const keys = this.resolveKeys(parsed.keys, path);
    this.loaded = { keys, mtimeMs };
    this.loadedFrom = path;
    return keys;
  }

  private keepOldPool(path: string, message: string): void {
    // Держим старый пул (если был) и предупреждаем один раз — разбор не удался.
    this.warnOnce("parse", message);
  }

  private resolveKeys(keys: string[], source: string): string[] {
    const out: string[] = [];
    for (const key of keys) {
      const resolved = interpolateEnvValue(key, this.opts.env);
      if (resolved === undefined || !resolved.trim()) {
        this.warnOnce(`unresolved:${key}`, `ключ из ${source} не разрешился (нет переменной в ${key}) — пропущен`);
        continue;
      }
      out.push(resolved.trim());
    }
    return out;
  }

  private warnOnce(id: string, message: string): void {
    if (id === "parse") {
      if (this.warnedParse) return;
      this.warnedParse = true;
    } else {
      if (this.warnedUnresolved.has(id)) return;
      this.warnedUnresolved.add(id);
    }
    this.opts.onWarn?.(`пи-нвидиа-плюс: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Выбор ключа: липкость, кулдауны, мёртвые, два круга                  */
/* ------------------------------------------------------------------ */

export type RotationPick =
  | { kind: "key"; key: string }
  | { kind: "wait"; ms: number }
  | { kind: "exhausted" };

export interface RotationKeyStatus {
  masked: string;
  state: "ready" | "cooldown" | "dead";
  cooldownLeftMs: number;
  active: boolean;
}

/**
 * Запрос-в-ротации: кольцо (`ключ пи, ...пул`), счётчик попыток и потолок —
 * своё на каждый запрос, чтобы параллельные запросы не топтали чужие круги.
 * Сессионное состояние (кулдауны, мёртвые, липкий ключ) — в ротаторе.
 */
export class RotationRequest {
  private readonly attemptsByKey = new Map<string, number>();
  private readonly rotator: KeyRotator;
  private readonly ring: string[];

  constructor(rotator: KeyRotator, ring: string[], _maxAttempts?: number) {
    this.rotator = rotator;
    this.ring = ring;
  }

  /** Есть ли смысл вращаться: ≥2 живых ключа, либо ≥1 живой при мёртвом ключе пи. */
  isUseful(): boolean {
    const alive = this.ring.filter((k) => !this.rotator.isDead(k));
    if (alive.length >= 2) return true;
    return alive.length === 1 && this.ring.length > 0 && this.rotator.isDead(this.ring[0]);
  }

  /**
   * Следующий ключ: липкий активный, дальше по кольцу; готовые предпочитются
   * ожидающим. Каждый живой ключ — не больше двух попыток на запрос (два полных
   * круга по живым; мёртвый посреди запроса ключ круги не раздувает). Все живые
   * с попытками в кулдауне — ждать ближайший откат; попыток не осталось — исчерпание.
   */
  pick(now: number): RotationPick {
    const ready = (k: string): boolean => !this.rotator.isDead(k) && this.rotator.cooldownLeft(k, now) === 0;
    const hasAttempts = (k: string): boolean => (this.attemptsByKey.get(k) ?? 0) < 2;

    const remaining = this.ring.filter((k) => !this.rotator.isDead(k) && hasAttempts(k));
    if (remaining.length === 0) return { kind: "exhausted" };

    const readyKeys = remaining.filter(ready);
    const active = this.rotator.activeKey();
    let chosen: string | undefined;
    if (active && readyKeys.includes(active)) {
      chosen = active; // липкость
    } else if (readyKeys.length > 0) {
      chosen = readyKeys[0]; // круговой обход от начала кольца
    }
    if (chosen !== undefined) {
      this.attemptsByKey.set(chosen, (this.attemptsByKey.get(chosen) ?? 0) + 1);
      return { kind: "key", key: chosen };
    }

    const nearest = Math.min(...remaining.map((k) => this.rotator.cooldownLeft(k, now)));
    return { kind: "wait", ms: Math.max(0, nearest) };
  }

  /** Статус кольца этого запроса (только маскированные ключи). */
  report(now: number): RotationKeyStatus[] {
    return this.rotator.statusFor(this.ring, now);
  }
}

export interface KeyRotatorOptions {
  /** Источник псевдослучайности в [0,1) — для тестов; по умолчанию `Math.random`. */
  random?: () => number;
}

/**
 * Состояние ротации на сессию: пул, кулдауны, мёртвые, липкий ключ.
 * `beginRequest` заводит кольцо на запрос: ключ пи первый, хвост пула
 * развёрнут псевдослучайным циклическим сдвигом (см. `beginRequest`).
 */
export class KeyRotator {
  private pool: string[] = [];
  private cooldownUntil = new Map<string, number>();
  private dead = new Set<string>();
  private active: string | undefined;
  private readonly random: () => number;

  constructor(opts?: KeyRotatorOptions) {
    this.random = opts?.random ?? Math.random;
  }

  /** Пул из файла/окружения (без ключа пи). Дубликаты убираются, порядок сохраняется. */
  setPool(keys: string[]): void {
    this.pool = [...new Set(keys)];
  }

  poolKeys(): string[] {
    return [...this.pool];
  }

  isDead(key: string): boolean {
    return this.dead.has(key);
  }

  activeKey(): string | undefined {
    return this.active;
  }

  /** Остаток кулдауна ключа в мс (0 — готов). */
  cooldownLeft(key: string, now: number): number {
    return Math.max(0, (this.cooldownUntil.get(key) ?? 0) - now);
  }

  /**
   * Новое кольцо запроса: ключ пи первым, дубликаты с пулом убираются.
   * Хвост кольца (пул) разворачивается псевдослучайным циклическим сдвигом,
   * чтобы параллельные агенты входили в круг с разных ключей и не бились
   * друг с другом за один и тот же первый живой ключ (меньше коллизий и 429).
   * Порядок внутри круга и липкость активного ключа не меняются.
   */
  beginRequest(requestKey: string | undefined, _now: number): RotationRequest {
    const ring: string[] = [];
    if (requestKey) ring.push(requestKey);
    for (const key of this.pool) if (!ring.includes(key)) ring.push(key);
    return new RotationRequest(this, this.circularShift(ring, requestKey));
  }

  /**
   * Циклический псевдослучайный сдвиг хвоста кольца: ключ пи (якорь) остаётся
   * первым, а пул разворачивается на случайное смещение — круг обходится по
   * порядку, но вход в него случайный. Пул из 0–1 ключа сдвигать нечего.
   */
  private circularShift(ring: string[], anchor: string | undefined): string[] {
    const anchored = anchor !== undefined && ring.length > 0 && ring[0] === anchor;
    const start = anchored ? 1 : 0;
    const tail = ring.slice(start);
    if (tail.length < 2) return ring;
    const offset = Math.floor(this.random() * tail.length);
    if (offset === 0) return ring;
    const rotated = tail.slice(offset).concat(tail.slice(0, offset));
    return anchored ? [ring[0], ...rotated] : rotated;
  }

  /** 429: ключ в кулдауне на время из `retry-after` (транспорт уже посчитал мс). */
  markRateLimited(key: string, cooldownMs: number, now: number): void {
    this.cooldownUntil.set(key, now + Math.max(0, cooldownMs));
  }

  /** 401/403: ключ мёртв до конца сессии. */
  markDead(key: string): void {
    this.dead.add(key);
    this.cooldownUntil.delete(key);
  }

  /** Ответ ушёл в пи: ключ становится липким активным. */
  markDelivered(key: string): void {
    this.active = key;
    this.cooldownUntil.delete(key);
  }

  /** Статус заданных ключей (для команды); только маскированные ключи. */
  statusFor(keys: string[], now: number): RotationKeyStatus[] {
    return keys.map((key) => {
      const dead = this.dead.has(key);
      const cooldownLeftMs = dead ? 0 : this.cooldownLeft(key, now);
      return {
        masked: maskKey(key),
        state: dead ? "dead" : cooldownLeftMs > 0 ? "cooldown" : "ready",
        cooldownLeftMs,
        active: this.active === key,
      };
    });
  }
}
