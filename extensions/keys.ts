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
import { copyFileSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { t } from "./i18n.ts";

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
    return { error: t("keysFileNotJson", { error: e instanceof Error ? e.message : String(e) }) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: t("keysFileShape") };
  }
  const keys = (parsed as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) return { error: t("keysFileNoArray") };
  const out: string[] = [];
  for (const entry of keys) {
    if (typeof entry !== "string") return { error: t("keysFileNotStrings") };
    const trimmed = entry.trim();
    if (!trimmed) return { error: t("keysFileEmptyString") };
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
        this.warnOnce("vanished", t("keysFileVanished", { path, count: this.loaded.keys.length }));
        return this.loaded.keys;
      }
      return [];
    }

    if (this.loaded && this.loadedFrom === path && this.loaded.mtimeMs === mtimeMs) {
      return this.loaded.keys;
    }

    // 0o600 — POSIX-only: на Windows chmod-маски не действуют, защита файла
    // разделяемого состояния и пула опирается на NTFS-ACL каталога пользователя.
    if (mode !== undefined && (mode & 0o777) !== 0o600 && process.platform !== "win32") {
      if (!this.warnedPerms) {
        this.warnedPerms = true;
        this.opts.onWarn?.(`pi-nvidia-plus: ${t("keysFilePerms", { path, mode: (mode & 0o777).toString(8) })}`);
      }
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      this.keepOldPool(path, t("keysFileUnreadable", { path, error: e instanceof Error ? e.message : String(e) }));
      return this.loaded?.keys ?? [];
    }
    const parsed = parseKeysFileContent(raw);
    if (!parsed.keys) {
      this.keepOldPool(path, t("keysFileParse", { path, error: parsed.error ?? "?" }));
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
        this.warnOnce(`unresolved:${key}`, t("keysUnresolved", { source, key }));
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
    this.opts.onWarn?.(`pi-nvidia-plus: ${message}`);
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
  /** Модель запроса (тикет 22): кулдауны считаются по паре (ключ, модель). */
  readonly model: string | undefined;

  constructor(rotator: KeyRotator, ring: string[], model?: string) {
    this.rotator = rotator;
    this.ring = ring;
    this.model = model;
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
    const ready = (k: string): boolean =>
      !this.rotator.isDead(k) && this.rotator.cooldownLeft(k, now, this.model) === 0;
    const hasAttempts = (k: string): boolean => (this.attemptsByKey.get(k) ?? 0) < 2;

    const remaining = this.ring.filter((k) => !this.rotator.isDead(k) && hasAttempts(k));
    if (remaining.length === 0) return { kind: "exhausted" };

    const readyKeys = remaining.filter(ready);
    const active = this.rotator.activeKey();
    let chosen: string | undefined;
    if (readyKeys.length > 0) {
      // Тикет 25: среди готовых — наименее занятый; липкий выигрывает только
      // при ничьей (последовательный диалог: inFlight везде 0 — липкость
      // неизменна; веер сабагентов расходится по разным ключам).
      let minInFlight = Infinity;
      for (const k of readyKeys) minInFlight = Math.min(minInFlight, this.rotator.inFlightCount(k));
      const freest = readyKeys.filter((k) => this.rotator.inFlightCount(k) === minInFlight);
      chosen = active && freest.includes(active) ? active : freest[0];
    }
    if (chosen !== undefined) {
      this.attemptsByKey.set(chosen, (this.attemptsByKey.get(chosen) ?? 0) + 1);
      return { kind: "key", key: chosen };
    }

    const nearest = Math.min(...remaining.map((k) => this.rotator.cooldownLeft(k, now, this.model)));
    return { kind: "wait", ms: Math.max(0, nearest) };
  }

  /** Статус кольца этого запроса (только маскированные ключи). */
  report(now: number): RotationKeyStatus[] {
    return this.rotator.statusFor(this.ring, now, this.model);
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
interface SharedStateFile {
  /** Мёртвые ключи — постоянные (401/403 финальны и между запусками; тикет 26). */
  dead?: string[];
  /** Кулдауны — TTL-ные: значение это абсолютный дедлайн, просроченные отмирают. */
  cooldownUntil?: Record<string, number>;
}

/**
 * Замена файла через rename. На Windows `renameSync` поверх файла, который
 * кто-то держит открытым (антивирус, индексатор, другой процесс пи), бросает
 * EPERM/EEXIST — fallback: копирование + удаление. Атомарность теряется, но
 * разделяемое состояние и так best effort.
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

export class KeyRotator {
  private pool: string[] = [];
  // Кулдауны (тикет 22): бакет на пару (ключ, модель) — рейт-лимит NIM так
  // устроен (тикет 21); глобальный бакет (просто ключ) остаётся для запросов
  // без известной модели. Мёртвые (401/403) — по ключу целиком: это
  // аккаунтный уровень, не модельный.
  private cooldownUntil = new Map<string, number>();
  private dead = new Set<string>();
  // Занятость ключей параллельными запросами: несколько одновременно запущенных
  // процессов pi (например, веер дочерних агентов расширения pi-subagents) не
  // должны валиться на один ключ лишь потому, что он липкий.
  private inFlight = new Map<string, number>();
  // Разделяемое между процессами состояние: дочерние процессы pi — это отдельные
  // процессы со своими KeyRotator; файл даёт общую память о мёртвых ключах и
  // кулдаунах. Все записи TTL-ные; формат описан интерфейсом `SharedStateFile`
  // выше в этом файле.
  private sharedPath: string | undefined;
  private sharedStamp = ""; // mtime:size последней прочитанной/записанной версии


  /** Подключить разделяемый файл состояния (тикет 26). Идемпотентно. */
  attachSharedState(path: string): void {
    this.sharedPath = path;
  }

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
    let parsed: SharedStateFile;
    try {
      parsed = JSON.parse(readFileSync(this.sharedPath, "utf8")) as SharedStateFile;
    } catch {
      return; // битый файл — игнорим, при записи перезапишем
    }
    for (const key of parsed.dead ?? []) {
      if (typeof key === "string" && key) this.dead.add(key);
    }
    for (const [bucket, until] of Object.entries(parsed.cooldownUntil ?? {})) {
      if (typeof until !== "number" || until <= now) continue;
      const existing = this.cooldownUntil.get(bucket) ?? 0;
      if (until > existing) this.cooldownUntil.set(bucket, until); // merge по max
    }
  }

  /**
   * Выгрузить своё состояние в файл: dead с TTL 24 ч, кулдауны — со своими
   * дедлайнами. Мержится с текущим содержимым (max/union), просроченное
   * выбрасывается. Троттлинг 300 мс; недописанное допишет следующая пометка.
   */
  private persistShared(now: number): void {
    // Тикет 26: запись сквозная, без троттлинга — короткоживущие дети
    // pi-subagents (pi -p) могут завершиться до срабатывания отложенной
    // записи, и последняя пометка потеряется (живое воспроизведение в
    // тикете). Пометки редки (одна на отказ ключа), файл мал — пишем всегда.
    if (!this.sharedPath) return;
    let existing: SharedStateFile = {};
    try {
      existing = JSON.parse(readFileSync(this.sharedPath, "utf8")) as SharedStateFile;
    } catch {
      // нет/битый — начинаем с пустого
    }
    const dead = new Set<string>((existing.dead ?? []).filter((k) => typeof k === "string" && k));
    const cooldowns: Record<string, number> = {};
    for (const [bucket, until] of Object.entries(existing.cooldownUntil ?? {})) {
      if (typeof until === "number" && until > now) cooldowns[bucket] = until;
    }
    for (const key of this.dead) dead.add(key);
    for (const [bucket, until] of this.cooldownUntil) {
      if (until > now) cooldowns[bucket] = Math.max(cooldowns[bucket] ?? 0, until);
    }
    const tmp = `${this.sharedPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ dead: [...dead], cooldownUntil: cooldowns }), { mode: 0o600 });
      renamePortable(tmp, this.sharedPath);
      try {
        const st = statSync(this.sharedPath);
        this.sharedStamp = `${st.mtimeMs}:${st.size}`; // своя запись — не перечитывать
      } catch {
        // ок
      }
    } catch {
      // разделяемое состояние — best effort: писать не смогли, живём в памяти
    }
  }
  private active: string | undefined;
  private readonly random: () => number;

  constructor(opts?: KeyRotatorOptions) {
    this.random = opts?.random ?? Math.random;
  }

  /**
   * Пул из файла/окружения (без ключа пи). Дубликаты убираются, порядок
   * сохраняется. Тикет 26 (дополнение): при смене состава пула разделяемое
   * состояние сверяется с ним — записи о ключах, которых в пуле больше нет,
   * выбрасываются из файла и памяти. Это же «оживление» мёртвых: ключ
   * перезавели и обновили файл пула — забытая смерть не тянется за ним.
   */
  setPool(keys: string[]): void {
    const next = [...new Set(keys)];
    const changed = next.length !== this.pool.length || next.some((k, i) => k !== this.pool[i]);
    this.pool = next;
    if (changed) this.reconcileSharedWithPool();
  }

  /** Ключ из бакета кулдауна: `модель\nключ` или просто ключ. */
  private static keyOfBucket(bucket: string): string {
    const nl = bucket.indexOf("\n");
    return nl < 0 ? bucket : bucket.slice(nl + 1);
  }

  /** Выбросить из разделяемого состояния (и памяти) ключи, выбывшие из пула. */
  private reconcileSharedWithPool(): void {
    const poolSet = new Set(this.pool);
    // Память чистим всегда (дёшево), файл — только при наличии стирки.
    let memoryChanged = false;
    for (const key of [...this.dead]) {
      if (!poolSet.has(key)) {
        this.dead.delete(key);
        memoryChanged = true;
      }
    }
    for (const bucket of [...this.cooldownUntil.keys()]) {
      if (!poolSet.has(KeyRotator.keyOfBucket(bucket))) {
        this.cooldownUntil.delete(bucket);
        memoryChanged = true;
      }
    }
    if (!this.sharedPath) return;
    // Файл: перечитать свежую версию (чужие записи тоже сверяем — отсюда и
    // консистентная чистка для всех процессов) и переписать, если нашли
    // записи о выбывших ключах.
    let existing: SharedStateFile;
    try {
      existing = JSON.parse(readFileSync(this.sharedPath, "utf8")) as SharedStateFile;
    } catch {
      if (memoryChanged) return; // файла нет — чистить нечего
      return;
    }
    const dead = (existing.dead ?? []).filter((k) => typeof k === "string" && poolSet.has(k));
    const cooldownUntil: Record<string, number> = {};
    const now = Date.now();
    let changed = false;
    for (const [bucket, until] of Object.entries(existing.cooldownUntil ?? {})) {
      if (typeof until !== "number" || until <= now) {
        changed = true; // заодно выбрасываем просроченные
        continue;
      }
      if (!poolSet.has(KeyRotator.keyOfBucket(bucket))) {
        changed = true;
        continue;
      }
      cooldownUntil[bucket] = until;
    }
    if (dead.length !== (existing.dead ?? []).length) changed = true;
    if (!changed) return;
    const tmp = `${this.sharedPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ dead, cooldownUntil }), { mode: 0o600 });
      renamePortable(tmp, this.sharedPath);
      // Содержимое мы только что записали сами — сольём оставленное в память,
      // иначе обновлённый штамп заставит mergeShared пропустить чтение.
      for (const key of dead) this.dead.add(key);
      for (const [bucket, until] of Object.entries(cooldownUntil)) {
        const existingUntil = this.cooldownUntil.get(bucket) ?? 0;
        if (until > existingUntil) this.cooldownUntil.set(bucket, until);
      }
      try {
        const st = statSync(this.sharedPath);
        this.sharedStamp = `${st.mtimeMs}:${st.size}`;
      } catch {
        // ок
      }
    } catch {
      // best effort: сможем при следующей сверке
    }
  }

  poolKeys(): string[] {
    return [...this.pool];
  }

  isDead(key: string): boolean {
    return this.dead.has(key);
  }

  /** Попытка попросила ключ в работу (тикет 25). */
  noteInFlight(key: string): void {
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
  }

  /** Попытка закончилась (доставка, статус, ошибка — без разницы). */
  releaseInFlight(key: string): void {
    const left = (this.inFlight.get(key) ?? 0) - 1;
    if (left <= 0) this.inFlight.delete(key);
    else this.inFlight.set(key, left);
  }

  /** Сколько запросов прямо сейчас работают с ключом. */
  inFlightCount(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }

  activeKey(): string | undefined {
    return this.active;
  }

  /** Бакет кулдауна: `модель\nключ`, без модели — просто ключ. */
  private bucket(key: string, model?: string): string {
    return model ? `${model}\n${key}` : key;
  }

  /**
   * Остаток кулдауна ключа в мс (0 — готов). Смотрит и модельный, и
   * глобальный бакет: кулдаун без модели (тело не распарсилось) действует
   * на все модели ключа, модельный — только на свою (тикет 22).
   */
  cooldownLeft(key: string, now: number, model?: string): number {
    const left = Math.max(0, (this.cooldownUntil.get(key) ?? 0) - now);
    if (!model) return left;
    const scoped = Math.max(0, (this.cooldownUntil.get(this.bucket(key, model)) ?? 0) - now);
    return Math.max(left, scoped);
  }

  /**
   * Новое кольцо запроса: ключ пи первым, дубликаты с пулом убираются.
   * Хвост кольца (пул) разворачивается псевдослучайным циклическим сдвигом,
   * чтобы параллельные агенты входили в круг с разных ключей и не бились
   * друг с другом за один и тот же первый живой ключ (меньше коллизий и 429).
   * Порядок внутри круга и липкость активного ключа не меняются.
   */
  beginRequest(requestKey: string | undefined, _now: number, model?: string): RotationRequest {
    this.mergeShared(_now); // тикет 26: свежие чужие dead/кулдауны до выбора ключа
    const ring: string[] = [];
    if (requestKey) ring.push(requestKey);
    for (const key of this.pool) if (!ring.includes(key)) ring.push(key);
    return new RotationRequest(this, this.circularShift(ring, requestKey), model);
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

  /**
   * 429: ключ в кулдауне на время из `retry-after` (транспорт уже посчитал мс).
   * Если модель известна — кулдаун только на пару (ключ, модель), другие
   * модели этого ключа остаются готовыми (тикет 22, анатомия — тикет 21).
   */
  markRateLimited(key: string, cooldownMs: number, now: number, model?: string): void {
    // Просроченный кулдаун не считается свежим: повторный 429 продлевает бакет
    // от текущего момента; ключ, отлежавший лимит, вновь активен (тикет 26).
    this.cooldownUntil.set(this.bucket(key, model), now + Math.max(0, cooldownMs));
    this.persistShared(now);
  }

  /** 401/403: ключ мёртв до конца сессии (для всех моделей — аккаунтный уровень). */
  // `now` опционален для обратной совместимости (тесты, старые вызовы).
  markDead(key: string, now: number = Date.now()): void {
    this.dead.add(key);
    for (const bucketName of [...this.cooldownUntil.keys()]) {
      if (bucketName === key || bucketName.endsWith(`\n${key}`)) this.cooldownUntil.delete(bucketName);
    }
    this.persistShared(now); // тикет 26: смерть ключа узнают и другие процессы
  }

  /**
   * Ответ ушёл в пи: ключ становится липким активным. Тикет 25: доставка
   * доказывает работоспособность только на своей модели и «глобально» —
   * чужие модельные бакеты ключа сохраняются (параллельный сабагент на
   * другой модели не должен сбивать кулдаун этого ключа на kimi-k3).
   */
  markDelivered(key: string, model?: string): void {
    this.active = key;
    this.cooldownUntil.delete(key);
    if (model) this.cooldownUntil.delete(this.bucket(key, model));
  }

  /** Статус заданных ключей (для команды); только маскированные ключи. */
  statusFor(keys: string[], now: number, model?: string): RotationKeyStatus[] {
    return keys.map((key) => {
      const dead = this.dead.has(key);
      const cooldownLeftMs = dead ? 0 : this.cooldownLeft(key, now, model);
      return {
        masked: maskKey(key),
        state: dead ? "dead" : cooldownLeftMs > 0 ? "cooldown" : "ready",
        cooldownLeftMs,
        active: this.active === key,
      };
    });
  }
}
