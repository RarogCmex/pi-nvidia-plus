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
  const r = new KeyRotator({ random: () => 0 });
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
  const r = new KeyRotator({ random: () => 0 });
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
  const r = new KeyRotator({ random: () => 0 });
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

// 16b. Псевдослучайный вход в круг: ключ пи остаётся первым, пул развёрнут на случайное смещение; обход по-прежнему круговой.
{
  const r = new KeyRotator({ random: () => 0.999 }); // смещение 1 на пуле [b, c] → хвост [c, b]
  r.setPool(["nvapi-b", "nvapi-c"]);
  const req = r.beginRequest("nvapi-pi", 0);
  assert.deepEqual(
    req.report(0).map((k) => k.masked),
    [maskKey("nvapi-pi"), maskKey("nvapi-c"), maskKey("nvapi-b")],
    "пул развёрнут случайным сдвигом, ключ пи первый",
  );
  assert.equal(keys(req.pick(0)), "nvapi-pi", "первый по-прежнему ключ пи");
  r.markRateLimited("nvapi-pi", 60_000, 0);
  assert.equal(keys(req.pick(0)), "nvapi-c", "вход в круг со случайной позиции");
  r.markRateLimited("nvapi-c", 60_000, 0);
  assert.equal(keys(req.pick(0)), "nvapi-b", "далее по кругу без пропусков");
}

// 17. Мёртвые 401/403: ключ исключается до конца сессии, не считается в кольце.
{
  const r = new KeyRotator({ random: () => 0 });
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
  const r = new KeyRotator({ random: () => 0 });
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

// ── Тикет 22: кулдаун по паре (ключ, модель) ─────────────────────────────────

// 22.1. Кулдаун на модели A не блокирует ту же модель B/другую модель того же ключа.
{
  const r = new KeyRotator({ random: () => 0 });
  r.setPool(["nvapi-b"]);
  const MODEL_A = "moonshotai/kimi-k3";
  const MODEL_B = "minimaxai/minimax-m3";
  r.markRateLimited("nvapi-pi", 60_000, 0, MODEL_A);
  assert.equal(r.cooldownLeft("nvapi-pi", 1_000, MODEL_A), 59_000, "кулдаун на своей модели");
  assert.equal(r.cooldownLeft("nvapi-pi", 1_000, MODEL_B), 0, "другая модель готова");
  assert.equal(r.cooldownLeft("nvapi-pi", 1_000), 0, "запрос без модели тоже готов");
}

// 22.2. Глобальный кулдаун (без модели) действует на все модели.
{
  const r = new KeyRotator({ random: () => 0 });
  r.setPool(["nvapi-b"]);
  r.markRateLimited("nvapi-pi", 60_000, 0);
  assert.equal(r.cooldownLeft("nvapi-pi", 1_000, "moonshotai/kimi-k3"), 59_000, "глобальный бакет блокирует любую модель");
}

// 22.3. Выбор ключа учитывает модель запроса: кулдаун на своей модели → следующий ключ.
{
  const r = new KeyRotator({ random: () => 0 });
  r.setPool(["nvapi-b", "nvapi-c"]);
  r.markRateLimited("nvapi-pi", 60_000, 0, "moonshotai/kimi-k3");
  const reqA = r.beginRequest("nvapi-pi", 0, "moonshotai/kimi-k3");
  assert.equal(keys(reqA.pick(0)), "nvapi-b", "на киме ключ пи в кулдауне → следующий");
  const reqB = r.beginRequest("nvapi-pi", 0, "minimaxai/minimax-m3");
  assert.equal(keys(reqB.pick(0)), "nvapi-pi", "на m3 ключ пи готов");
}

// 22.4. Мёртвый ключ (401/403) мёртв для всех моделей; его кулдауны снимаются.
{
  const r = new KeyRotator({ random: () => 0 });
  r.setPool(["nvapi-b"]);
  r.markRateLimited("nvapi-pi", 60_000, 0, "moonshotai/kimi-k3");
  r.markDead("nvapi-pi");
  assert.ok(r.isDead("nvapi-pi"));
  assert.equal(r.cooldownLeft("nvapi-pi", 1_000, "moonshotai/kimi-k3"), 0, "кулдаун мёртвого снят");
  const req = r.beginRequest("nvapi-pi", 0, "moonshotai/kimi-k3");
  assert.equal(keys(req.pick(0)), "nvapi-b", "мёртвый пропускается и на своей модели");
}

// 22.5/25.  Доставленный ответ очищает глобальный бакет и бакет своей модели,
// но не чужие модельные бакеты (тикет 25: параллельные сабагенты).
{
  const r = new KeyRotator({ random: () => 0 });
  r.setPool(["nvapi-b"]);
  r.markRateLimited("nvapi-pi", 60_000, 0, "moonshotai/kimi-k3");
  r.markRateLimited("nvapi-pi", 60_000, 0);
  r.markRateLimited("nvapi-pi", 60_000, 0, "z-ai/glm-5");
  r.markDelivered("nvapi-pi", "moonshotai/kimi-k3");
  assert.equal(r.cooldownLeft("nvapi-pi", 1_000, "moonshotai/kimi-k3"), 0, "своя модель очищена");
  assert.equal(r.cooldownLeft("nvapi-pi", 1_000), 0, "глобальный очищен");
  assert.equal(r.cooldownLeft("nvapi-pi", 1_000, "z-ai/glm-5"), 59_000, "чужая модель не тронута");
}

// ── Тикет 25: выбор с учётом занятости (in-flight) ──────────────────────────

// 25.1. Параллельные запросы расходятся по разным ключам: занятый не берётся,
// липкий при веере проигрывает свободному.
{
  const r = new KeyRotator({ random: () => 0 });
  r.setPool(["nvapi-b", "nvapi-c"]);
  r.markDelivered("nvapi-pi"); // липкий ключ пи
  const req1 = r.beginRequest("nvapi-pi", 0);
  const picked1 = keys(req1.pick(0));
  assert.equal(picked1, "nvapi-pi", "первый запрос берёт липкий");
  r.noteInFlight("nvapi-pi");
  const req2 = r.beginRequest("nvapi-pi", 0);
  assert.equal(keys(req2.pick(0)), "nvapi-b", "параллельный запрос уходит на свободный, не на липкий");
}

// 25.2. Ничья по занятости — липкий сохраняется (поведение последовательного диалога).
{
  const r = new KeyRotator({ random: () => 0 });
  r.setPool(["nvapi-b", "nvapi-c"]);
  r.markDelivered("nvapi-pi");
  r.noteInFlight("nvapi-pi");
  r.noteInFlight("nvapi-b");
  r.noteInFlight("nvapi-c"); // заняты все поровну — решает липкость
  const req = r.beginRequest("nvapi-pi", 0);
  assert.equal(keys(req.pick(0)), "nvapi-pi", "при равной занятости липкий выигрывает");
}

// 25.3. releaseInFlight возвращает ключ в свободные.
{
  const r = new KeyRotator({ random: () => 0 });
  r.setPool(["nvapi-b"]);
  r.noteInFlight("nvapi-pi");
  assert.equal(r.inFlightCount("nvapi-pi"), 1);
  r.releaseInFlight("nvapi-pi");
  assert.equal(r.inFlightCount("nvapi-pi"), 0);
  r.releaseInFlight("nvapi-pi"); // лишний релиз не уводит в минус
  assert.equal(r.inFlightCount("nvapi-pi"), 0);
}

// ── Тикет 26: разделяемое состояние ротатора между процессами ───────────────

// 26.1. Мёртвый ключ одного процесса виден другому; без TTL (финал и между запусками).
{
  const d = freshDir("shared-1");
  const file = join(d, "state.json");
  const a = new KeyRotator({ random: () => 0 });
  const b = new KeyRotator({ random: () => 0 });
  a.attachSharedState(file);
  b.attachSharedState(file);
  a.markDead("nvapi-zombie");
  const req = b.beginRequest("nvapi-zombie", 0);
  assert.ok(b.isDead("nvapi-zombie"), "второй процесс увидел мёртвый ключ из файла");
  assert.deepEqual(req.report(0).map((s) => s.state), ["dead"]);
}

// 26.2. Кулдаун разделяется и имеет TTL: просроченный бакет ключа «оживает».
{
  const d = freshDir("shared-2");
  const file = join(d, "state.json");
  const a = new KeyRotator({ random: () => 0 });
  const b = new KeyRotator({ random: () => 0 });
  a.attachSharedState(file);
  b.attachSharedState(file);
  a.markRateLimited("nvapi-x", 5_000, 10_000, "moonshotai/kimi-k3");
  b.beginRequest("nvapi-x", 11_000);
  assert.equal(b.cooldownLeft("nvapi-x", 11_000, "moonshotai/kimi-k3"), 4_000, "кулдаун доехал в другой процесс");
  assert.equal(b.cooldownLeft("nvapi-x", 11_000, "minimaxai/minimax-m3"), 0, "модельный бакет соблюдён");
  b.beginRequest("nvapi-x", 16_001);
  assert.equal(b.cooldownLeft("nvapi-x", 16_001, "moonshotai/kimi-k3"), 0, "TTL истёк — ключ снова готов");
}

// 26.3. Merge по max: более поздний кулдаун побеждает, короткий своего не отбрасывает.
{
  const d = freshDir("shared-3");
  const file = join(d, "state.json");
  const a = new KeyRotator({ random: () => 0 });
  const b = new KeyRotator({ random: () => 0 });
  a.attachSharedState(file);
  b.attachSharedState(file);
  a.markRateLimited("nvapi-x", 60_000, 0);
  b.beginRequest("nvapi-x", 0);
  b.markRateLimited("nvapi-x", 10_000, 0); // более короткий — не должен укоротить 60 с
  a.beginRequest("nvapi-x", 0); // перечитает
  assert.equal(a.cooldownLeft("nvapi-x", 0), 60_000, "merge не укорачивает");
}

// 26.4. Без attach или без файла — ротатор живёт в памяти, как раньше.
{
  const r = new KeyRotator({ random: () => 0 });
  r.markDead("nvapi-x");
  assert.ok(r.isDead("nvapi-x"));
  const b = new KeyRotator({ random: () => 0 });
  b.attachSharedState(join(freshDir("shared-4"), "missing.json"));
  b.beginRequest("nvapi-x", 0); // файла нет — не падает
  assert.ok(!b.isDead("nvapi-x"));
}

console.log("keys: все проверки прошли");

// 22.6. statusFor с моделью показывает модельный бакет; без — как раньше.
{
  const r = new KeyRotator({ random: () => 0 });
  r.setPool(["nvapi-b"]);
  r.markRateLimited("nvapi-pi", 60_000, 0, "moonshotai/kimi-k3");
  assert.equal(r.statusFor(["nvapi-pi"], 1_000, "moonshotai/kimi-k3")[0].state, "cooldown");
  assert.equal(r.statusFor(["nvapi-pi"], 1_000, "minimaxai/minimax-m3")[0].state, "ready");
  assert.equal(r.statusFor(["nvapi-pi"], 1_000)[0].state, "ready", "без модели — готов");
}

