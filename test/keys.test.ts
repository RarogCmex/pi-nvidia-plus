/**
 * Тесты шва пула ключей и ротации (тикет 15): загрузка пула (файл, $ENV_VAR,
 * NVIDIA_NIM_KEYS[_FILE], mtime-перезагрузка, битый JSON → старый пул),
 * выбор ключа (липкость, кулдаун по retry-after, круговой обход, 2 круга),
 * мёртвые 401/403, маскировка.
 * Запуск: node test/keys.test.ts
 * Все файловые пробы — во временном каталоге; реальный ~/.pi не трогается.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeyPool,
  KeyRotator,
  interpolateEnvValue,
  maskKey,
  parseInlineKeys,
  parseKeysFileContent,
  DEFAULT_KEYS_FILE_NAME,
  type RotationPick,
} from "../extensions/keys.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-keys-"));

function freshDir(label: string): string {
  const d = join(dir, label);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

function writeKeysFile(path: string, keys: string[], mtimeOffsetMs = 0): void {
  writeFileSync(path, `${JSON.stringify({ keys }, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
  if (mtimeOffsetMs !== 0) {
    const t = new Date(Date.now() + mtimeOffsetMs);
    utimesSync(path, t, t);
  }
}

// 1. maskKey: только суффикс, полный ключ никогда не возвращается.
{
  assert.equal(maskKey("nvapi-abcd1234"), "…1234");
  assert.equal(maskKey("nvapi-x"), "…pi-x"); // короткие — суффикс до 4 символов
  assert.equal(maskKey(""), "…");
  const full = "nvapi-verysecretkey-ef98";
  const masked = maskKey(full);
  assert.ok(!masked.includes("verysecret"), masked);
  assert.ok(masked.startsWith("…"), masked);
}

// 2. interpolateEnvValue — стиль пи: $VAR, ${VAR}, $$ → $; пропавшая переменная → undefined.
{
  const env = { MY_KEY: "nvapi-secret", PART: "abc" };
  assert.equal(interpolateEnvValue("$MY_KEY", env), "nvapi-secret");
  assert.equal(interpolateEnvValue("${MY_KEY}", env), "nvapi-secret");
  assert.equal(interpolateEnvValue("pre-${PART}-post", env), "pre-abc-post");
  assert.equal(interpolateEnvValue("nvapi-literal", env), "nvapi-literal");
  assert.equal(interpolateEnvValue("cost$$100", env), "cost$100"); // $$ → $
  assert.equal(interpolateEnvValue("$NO_SUCH_VAR", env), undefined);
  assert.equal(interpolateEnvValue("${NO_SUCH_VAR}", env), undefined);
  assert.equal(interpolateEnvValue("x$NO_SUCH_VAR", env), undefined, "частично неразрешимое — неразрешимо");
  // Имя переменной: жадное до не-именного символа, как в пи ($FOO_BAR = FOO_BAR).
  assert.equal(interpolateEnvValue("$PART-tail", { PART: "abc" }), "abc-tail");
}

// 3. parseKeysFileContent — плоский массив строк в {"keys": [...]}, мусор отклоняется.
{
  assert.deepEqual(parseKeysFileContent('{"keys": ["a", "b"]}'), { keys: ["a", "b"] });
  assert.deepEqual(parseKeysFileContent('{"keys": []}'), { keys: [] });
  for (const bad of [
    "не json",
    '{"keys": "a"}', // не массив
    '["a"]', // не объект
    '{"keys": ["a", 5]}', // не-строка
    '{"keys": ["a", "  "]}', // пустая после trim
    '{"other": 1}', // нет keys
  ]) {
    const res = parseKeysFileContent(bad);
    assert.equal(res.keys, undefined, bad);
    assert.ok(typeof res.error === "string" && res.error.length > 0, bad);
  }
  // пробелы по краям ключей обрезаются
  assert.deepEqual(parseKeysFileContent('{"keys": [" a ", "b"]}'), { keys: ["a", "b"] });
}

// 4. parseInlineKeys — список через запятую, пустые элементы отбрасываются.
{
  assert.deepEqual(parseInlineKeys("a, b ,, c"), ["a", "b", "c"]);
  assert.deepEqual(parseInlineKeys("  "), []);
  assert.deepEqual(parseInlineKeys(undefined), []);
}

// 5. KeyPool: файл по умолчанию, права 600, без предупреждений.
{
  const d = freshDir("default-file");
  const file = join(d, DEFAULT_KEYS_FILE_NAME);
  writeKeysFile(file, ["nvapi-one", "nvapi-two"]);
  const warnings: string[] = [];
  const pool = new KeyPool({ defaultPath: file, env: {}, onWarn: (m) => warnings.push(m) });
  assert.equal(pool.hasSource(), true);
  assert.deepEqual(pool.refresh(), ["nvapi-one", "nvapi-two"]);
  assert.deepEqual(warnings, []);
  assert.ok(pool.describe().includes(DEFAULT_KEYS_FILE_NAME), pool.describe());
}

// 6. KeyPool: NVIDIA_NIM_KEYS (инлайн) имеет приоритет над файлом.
{
  const d = freshDir("inline-priority");
  const file = join(d, DEFAULT_KEYS_FILE_NAME);
  writeKeysFile(file, ["nvapi-file"]);
  const pool = new KeyPool({ defaultPath: file, env: { NVIDIA_NIM_KEYS: "nvapi-a, nvapi-b" }, onWarn: () => {} });
  assert.deepEqual(pool.refresh(), ["nvapi-a", "nvapi-b"]);
  assert.ok(pool.describe().includes("NVIDIA_NIM_KEYS"), pool.describe());
}

// 7. KeyPool: NVIDIA_NIM_KEYS_FILE имеет приоритет над путём по умолчанию.
{
  const d = freshDir("file-override");
  const def = join(d, DEFAULT_KEYS_FILE_NAME);
  const custom = join(d, "custom-keys.json");
  writeKeysFile(def, ["nvapi-default"]);
  writeKeysFile(custom, ["nvapi-custom"]);
  const pool = new KeyPool({ defaultPath: def, env: { NVIDIA_NIM_KEYS_FILE: custom }, onWarn: () => {} });
  assert.deepEqual(pool.refresh(), ["nvapi-custom"]);
  assert.ok(pool.describe().includes("custom-keys.json"), pool.describe());
}

// 8. KeyPool: $ENV_VAR-интерполяция значений файла; неразрешимые ключи отбрасываются с предупреждением.
{
  const d = freshDir("env-interpolation");
  const file = join(d, DEFAULT_KEYS_FILE_NAME);
  writeKeysFile(file, ["$CORP_KEY_1", "${CORP_KEY_2}", "$NO_SUCH_KEY", "nvapi-literal"]);
  const warnings: string[] = [];
  const pool = new KeyPool({
    defaultPath: file,
    env: { CORP_KEY_1: "nvapi-env1", CORP_KEY_2: "nvapi-env2" },
    onWarn: (m) => warnings.push(m),
  });
  assert.deepEqual(pool.refresh(), ["nvapi-env1", "nvapi-env2", "nvapi-literal"]);
  assert.equal(warnings.length, 1, "одно предупреждение о неразрешимом ключе");
  assert.ok(warnings[0].includes("NO_SUCH_KEY"), warnings[0]);
}

// 9. KeyPool: mtime-перезагрузка — изменение файла подхватывается (один stat на вызов).
{
  const d = freshDir("mtime");
  const file = join(d, DEFAULT_KEYS_FILE_NAME);
  writeKeysFile(file, ["nvapi-v1"], -10_000); // заведомо в прошлом
  const pool = new KeyPool({ defaultPath: file, env: {}, onWarn: () => {} });
  assert.deepEqual(pool.refresh(), ["nvapi-v1"]);
  // mtime не менялся — тот же пул
  assert.deepEqual(pool.refresh(), ["nvapi-v1"]);
  writeKeysFile(file, ["nvapi-v2", "nvapi-v3"], 10_000); // заведомо новее
  assert.deepEqual(pool.refresh(), ["nvapi-v2", "nvapi-v3"]);
}

// 10. KeyPool: битый JSON → старый пул + одно предупреждение.
{
  const d = freshDir("corrupt");
  const file = join(d, DEFAULT_KEYS_FILE_NAME);
  writeKeysFile(file, ["nvapi-good"], -10_000);
  const warnings: string[] = [];
  const pool = new KeyPool({ defaultPath: file, env: {}, onWarn: (m) => warnings.push(m) });
  assert.deepEqual(pool.refresh(), ["nvapi-good"]);
  writeFileSync(file, "{битый json", "utf8");
  const t = new Date(Date.now() + 10_000);
  utimesSync(file, t, t);
  assert.deepEqual(pool.refresh(), ["nvapi-good"], "битый JSON — держим старый пул");
  assert.equal(warnings.length, 1);
  // повторное чтение того же битого файла — без нового предупреждения
  writeFileSync(file, "{снова битый", "utf8");
  const t2 = new Date(Date.now() + 20_000);
  utimesSync(file, t2, t2);
  assert.deepEqual(pool.refresh(), ["nvapi-good"]);
  assert.equal(warnings.length, 1, "предупреждаем один раз");
}

// 11. KeyPool: права ≠ 600 → одно предупреждение, не блокирует.
{
  if (process.platform !== "win32") {
    const d = freshDir("perms");
    const file = join(d, DEFAULT_KEYS_FILE_NAME);
    writeKeysFile(file, ["nvapi-open"]);
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    const pool = new KeyPool({ defaultPath: file, env: {}, onWarn: (m) => warnings.push(m) });
    assert.deepEqual(pool.refresh(), ["nvapi-open"], "чтение не блокируется");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("600"), warnings[0]);
    // повтор — без нового предупреждения
    assert.deepEqual(pool.refresh(), ["nvapi-open"]);
    assert.equal(warnings.length, 1);
    // починили права — предупреждение не повторяется и не жалуемся
    chmodSync(file, 0o600);
    const t = new Date(Date.now() + 10_000);
    utimesSync(file, t, t);
    assert.deepEqual(pool.refresh(), ["nvapi-open"]);
    assert.equal(warnings.length, 1);
  }
}

// 12. KeyPool: файла нет → пул пуст, без предупреждений; источник не задан.
{
  const d = freshDir("absent");
  const pool = new KeyPool({ defaultPath: join(d, DEFAULT_KEYS_FILE_NAME), env: {}, onWarn: (m) => assert.fail(m) });
  assert.equal(pool.hasSource(), false);
  assert.deepEqual(pool.refresh(), []);
}

// ── KeyRotator: выбор ключа ─────────────────────────────────────────────────

function keys(pick: RotationPick): string | undefined {
  return pick.kind === "key" ? pick.key : undefined;
}

// 13. Кольцо запроса: ключ пи первый, дубликаты убираются; липкий старт.
{
  const r = new KeyRotator();
  r.setPool(["nvapi-pi", "nvapi-b", "nvapi-c"]); // nvapi-pi дублирует ключ пи
  const req = r.beginRequest("nvapi-pi", 0);
  assert.deepEqual(
    req.report(0).map((k) => k.masked),
    [maskKey("nvapi-pi"), maskKey("nvapi-b"), maskKey("nvapi-c")],
    "дубликат ключа пи не повторяется",
  );
  assert.equal(keys(req.pick(0)), "nvapi-pi", "первый в пуле — ключ пи");
}

// 14. Липкость: успешный ключ остаётся активным между запросами.
{
  const r = new KeyRotator();
  r.setPool(["nvapi-b", "nvapi-c"]);
  let req = r.beginRequest("nvapi-pi", 0);
  assert.equal(keys(req.pick(0)), "nvapi-pi");
  r.markRateLimited("nvapi-pi", 60_000, 0);
  assert.equal(keys(req.pick(0)), "nvapi-b", "429 → следующий ключ");
  r.markDelivered("nvapi-b");
  // новый запрос: липкий ключ — уже не ключ пи; состояние запроса своё, кулдауны — сессии
  req = r.beginRequest("nvapi-pi", 1_000);
  assert.equal(keys(req.pick(1_000)), "nvapi-b", "липкий активный ключ");
}

// 15. Кулдаун по retry-after: ключ недоступен до отката, потом снова в деле.
{
  const r = new KeyRotator();
  r.setPool(["nvapi-b"]);
  let req = r.beginRequest("nvapi-pi", 0);
  assert.equal(keys(req.pick(0)), "nvapi-pi");
  r.markRateLimited("nvapi-pi", 30_000, 0);
  assert.equal(keys(req.pick(0)), "nvapi-b", "429 → пи-ключ в кулдауне, берём следующий");
  // b тоже в кулдауне → ждём ближайший откат (b откатится раньше)
  r.markRateLimited("nvapi-b", 5_000, 10_000);
  const wait = req.pick(10_000);
  assert.equal(wait.kind, "wait");
  assert.equal(wait.kind === "wait" ? wait.ms : -1, 5_000, "ближайший откат — через 5 с");
  // после всех откатов первый готовый в кольце — снова ключ пи
  req = r.beginRequest("nvapi-pi", 31_000);
  assert.equal(keys(req.pick(31_000)), "nvapi-pi", "кулдаун истёк — ключ снова выбран");
}

// 16. Круговой обход: порядок кольца [ключ пи, ...пул], пропуск в кулдауне.
{
  const r = new KeyRotator();
  r.setPool(["nvapi-b", "nvapi-c"]);
  const req = r.beginRequest("nvapi-pi", 0);
  assert.equal(keys(req.pick(0)), "nvapi-pi");
  r.markRateLimited("nvapi-pi", 60_000, 0);
  assert.equal(keys(req.pick(0)), "nvapi-b");
  r.markRateLimited("nvapi-b", 60_000, 0);
  assert.equal(keys(req.pick(0)), "nvapi-c");
  r.markRateLimited("nvapi-c", 60_000, 0);
  const wait = req.pick(0);
  assert.equal(wait.kind, "wait", "все в кулдауне — ждать");
}

// 17. Мёртвые 401/403: ключ исключается до конца сессии, не считается в кольце.
{
  const r = new KeyRotator();
  r.setPool(["nvapi-b", "nvapi-c"]);
  let req = r.beginRequest("nvapi-pi", 0);
  assert.equal(keys(req.pick(0)), "nvapi-pi");
  r.markDead("nvapi-pi");
  assert.equal(keys(req.pick(0)), "nvapi-b", "мёртвый пропускается");
  r.markDelivered("nvapi-b");
  // новый запрос: мёртвый ключ пи не предлагается
  req = r.beginRequest("nvapi-pi", 1_000);
  assert.equal(keys(req.pick(1_000)), "nvapi-b");
  const statuses = req.report(1_000);
  assert.equal(statuses[0].state, "dead");
  assert.equal(statuses[0].masked, maskKey("nvapi-pi"));
}

// 18. Два круга: после 2×живых попыток — исчерпание (счётчик — на запрос, не на сессию).
{
  const r = new KeyRotator();
  r.setPool(["nvapi-b"]);
  const req = r.beginRequest("nvapi-pi", 0); // живых: 2 → потолок 4 попытки
  const seen: string[] = [];
  let t = 0;
  for (;;) {
    const pick = req.pick(t);
    if (pick.kind === "exhausted") break;
    if (pick.kind === "wait") {
      t += pick.ms + 1; // мотаем время за откат
      continue;
    }
    seen.push(pick.key);
    r.markRateLimited(pick.key, 1_000, t);
  }
  assert.deepEqual(seen, ["nvapi-pi", "nvapi-b", "nvapi-pi", "nvapi-b"], "два полных круга");
}

// 19. Все мёртвые → сразу исчерпание; ротация с одним живым ключом — не крутится.
{
  const r = new KeyRotator();
  r.setPool(["nvapi-b"]);
  r.beginRequest("nvapi-pi", 0);
  r.markDead("nvapi-pi");
  r.markDead("nvapi-b");
  const reqDead = r.beginRequest("nvapi-pi", 1_000);
  assert.equal(reqDead.pick(1_000).kind, "exhausted");
  assert.equal(reqDead.isUseful(), false, "все мертвы — вращаться нечего");

  const r2 = new KeyRotator();
  r2.setPool([]); // пул пуст — только ключ пи
  assert.equal(r2.beginRequest("nvapi-pi", 0).isUseful(), false, "пул из одного ключа — ротация no-op");

  const r3 = new KeyRotator();
  r3.setPool(["nvapi-b"]);
  assert.equal(r3.beginRequest("nvapi-pi", 0).isUseful(), true);

  // ключ пи мёртв, но есть живой ключ пула — ротация всё ещё полезна
  r3.markDead("nvapi-pi");
  assert.equal(r3.beginRequest("nvapi-pi", 1_000).isUseful(), true, "один живой в пуле при мёртвом ключе пи");
}

// 20. Отчёт: маскированные суффиксы, остаток кулдауна, активный ключ.
{
  const r = new KeyRotator();
  r.setPool(["nvapi-b"]);
  const req = r.beginRequest("nvapi-pi", 100);
  req.pick(100); // nvapi-pi
  r.markRateLimited("nvapi-pi", 30_000, 100);
  const b = keys(req.pick(100));
  assert.equal(b, "nvapi-b");
  r.markDelivered("nvapi-b");
  const report = req.report(1100);
  assert.deepEqual(report, [
    { masked: maskKey("nvapi-pi"), state: "cooldown", cooldownLeftMs: 29_000, active: false },
    { masked: maskKey("nvapi-b"), state: "ready", cooldownLeftMs: 0, active: true },
  ]);
  // в отчёте нет полных ключей
  for (const row of report) assert.ok(!row.masked.includes("nvapi-"), row.masked);
}

// 21. Мёртвый посреди запроса ключ не раздувает круги: потолок — две попытки на живой ключ.
{
  const r = new KeyRotator();
  r.setPool(["nvapi-b", "nvapi-c"]);
  const req = r.beginRequest("nvapi-pi", 0);
  assert.equal(keys(req.pick(0)), "nvapi-pi");
  r.markDead("nvapi-pi"); // ключ пи умер на первой попытке
  const seen: string[] = [];
  let t = 0;
  for (;;) {
    const pick = req.pick(t);
    if (pick.kind === "exhausted") break;
    if (pick.kind === "wait") {
      t += pick.ms + 1;
      continue;
    }
    seen.push(pick.key);
    r.markRateLimited(pick.key, 1_000, t);
  }
  assert.deepEqual(seen, ["nvapi-b", "nvapi-c", "nvapi-b", "nvapi-c"], "два круга по живым, без лишних попыток");
}

console.log("keys: все проверки прошли");
