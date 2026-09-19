/**
 * Тесты нового шва пула прокси (`.scratch/proxy-pool/spec.md`): загрузка пула
 * (инлайн / явный файл / файл по умолчанию / легаси-одиночка — один источник
 * побеждает), разбор эндпоинтов (схемы http/https, socks отклоняется),
 * маскировка (userinfo никогда не покидает шов), ротатор (pin, карантин
 * CONNECT с TTL, least inFlight, сдвиг кольца, все в cooldown → ближайший
 * expiry, выключенная ротация держит pin), разделяемый TTL-файл между
 * процессами, классификация проб и планировщик `proxy check`
 * (параллельность, аборт, самый быстрый ok).
 * Запуск: node test/proxy-pool.test.ts
 * Все файловые пробы — во временном каталоге; реальный ~/.pi не трогается.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROXIES_FILE_NAME,
  PROXY_CHECK_CONCURRENCY,
  PROXY_QUARANTINE_MS,
  PROXY_PROBE_TIMEOUT_MS,
  ProxyPool,
  ProxyRotator,
  classifyProxyProbe,
  fastestOk,
  maskProxy,
  parseInlineProxies,
  parseProxiesFileContent,
  parseProxyEndpoint,
  redactProxyCredentials,
  runProxyProbes,
  type ProxyProbeResultRow,
} from "../extensions/proxy-pool.ts";
import { parseProxyUrl } from "../extensions/proxy.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-nvidia-plus-proxypool-"));

function freshDir(label: string): string {
  const d = join(dir, label);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

function writeProxiesFile(path: string, proxies: string[], mtimeOffsetMs = 0): void {
  writeFileSync(path, `${JSON.stringify({ proxies }, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
  if (mtimeOffsetMs !== 0) {
    const t = new Date(Date.now() + mtimeOffsetMs);
    utimesSync(path, t, t);
  }
}

/* ── 1. maskProxy: display identity — host:port, userinfo stripped ─────── */
{
  assert.equal(maskProxy("http://user:secret@1.2.3.4:8080"), "1.2.3.4:8080");
  assert.equal(maskProxy("https://user:p%40ssw0rd@proxy.example.com:10001/x?q=1#f"), "proxy.example.com:10001");
  assert.equal(maskProxy("http://1.2.3.4:8080/"), "1.2.3.4:8080");
  assert.equal(maskProxy(new URL("http://u:p@host.local:3128")), "host.local:3128");
  assert.equal(maskProxy("http://user:pass@localhost"), "localhost", "порт по умолчанию — просто host");
  // Мусор на входе не бросается и не раскрывает креденшелы.
  const masked = maskProxy("not a url u:p@1.2.3.4:80");
  assert.ok(!masked.includes("u:p"), masked);
  assert.ok(masked.length > 0);
  // Никогда не содержит userinfo.
  for (const value of ["http://a:b@h:1", "https://x%40y:z@h:443", "socks5://u:p@h:1080"]) {
    assert.ok(!maskProxy(value).includes("@"), value);
  }
}

/* ── 2. redactProxyCredentials: текст ошибок без паролей ───────────────── */
{
  assert.equal(
    redactProxyCredentials("connect ECONNREFUSED http://user:secret@1.2.3.4:8080"),
    "connect ECONNREFUSED http://1.2.3.4:8080",
  );
  const red = redactProxyCredentials("boom u:p@1.2.3.4:80 tail");
  assert.ok(!red.includes("u:p"), red);
  assert.equal(redactProxyCredentials("обычный текст"), "обычный текст");
}

/* ── 3. parseProxyEndpoint: http/https, без схемы → http, socks → ошибка ─ */
{
  const ok = parseProxyEndpoint("http://1.2.3.4:8080");
  assert.equal(ok.href, "http://1.2.3.4:8080/");
  assert.equal(ok.display, "1.2.3.4:8080");
  assert.equal(ok.error, undefined);

  const bare = parseProxyEndpoint("1.2.3.4:8080");
  assert.equal(bare.href, "http://1.2.3.4:8080/", "без схемы подразумевается http://");

  const creds = parseProxyEndpoint("https://user:pass@host.example:443");
  assert.equal(creds.href, "https://user:pass@host.example/", "креденшелы сохраняются во внутреннем href (дефолтный порт нормализуется)");
  assert.equal(creds.display, "host.example", "display — без userinfo; дефолтный порт нормализуется URL");

  for (const bad of ["socks5://u:p@1.2.3.4:1080", "socks5h://1.2.3.4:1080", "ftp://1.2.3.4:21"]) {
    const res = parseProxyEndpoint(bad);
    assert.equal(res.href, undefined, bad);
    assert.ok(res.error && res.error.length > 0, bad);
  }
  assert.ok(parseProxyEndpoint("socks5://u:p@h:1080").error?.includes("socks5"), "схема названа в ошибке");

  for (const bad of ["", "   ", "ht tp://некорректный", "http://"]) {
    assert.equal(parseProxyEndpoint(bad).href, undefined, bad);
    assert.ok(typeof parseProxyEndpoint(bad).error === "string", bad);
  }
}

/* ── 3b. Легаси parseProxyUrl тоже отклоняет не-http(s) схемы (story 40) ─ */
{
  assert.ok(parseProxyUrl("socks5://1.2.3.4:1080").error, "socks5 в NVIDIA_NIM_PROXY — ошибка разбора");
  assert.equal(parseProxyUrl("socks5://1.2.3.4:1080").url, undefined);
  assert.equal(parseProxyUrl("http://1.2.3.4:8080").url?.toString(), "http://1.2.3.4:8080/");
  assert.equal(parseProxyUrl("1.2.3.4:8080").url?.toString(), "http://1.2.3.4:8080/");
}

/* ── 4. parseInlineProxies / parseProxiesFileContent ───────────────────── */
{
  assert.deepEqual(parseInlineProxies("http://a:1, http://b:2 ,, http://c:3"), ["http://a:1", "http://b:2", "http://c:3"]);
  assert.deepEqual(parseInlineProxies("  "), []);
  assert.deepEqual(parseInlineProxies(undefined), []);

  assert.deepEqual(parseProxiesFileContent('{"proxies": ["http://a:1"]}'), { proxies: ["http://a:1"] });
  assert.deepEqual(parseProxiesFileContent('{"proxies": []}'), { proxies: [] });
  for (const bad of [
    "не json",
    '{"proxies": "a"}',
    '["a"]',
    '{"proxies": ["a", 5]}',
    '{"proxies": ["a", "  "]}',
    '{"other": 1}',
  ]) {
    const res = parseProxiesFileContent(bad);
    assert.equal(res.proxies, undefined, bad);
    assert.ok(typeof res.error === "string" && res.error.length > 0, bad);
  }
  assert.deepEqual(parseProxiesFileContent('{"proxies": [" http://a:1 "]}'), { proxies: ["http://a:1"] });
}

/* ── 5. classifyProxyProbe: любой HTTP-ответ — reachable ───────────────── */
{
  assert.equal(classifyProxyProbe({ status: 200 }), "ok");
  assert.equal(classifyProxyProbe({ status: 401 }), "ok", "401 на /v1/models — выход достижим, вопрос не про auth");
  assert.equal(classifyProxyProbe({ status: 429 }), "ok");
  assert.equal(classifyProxyProbe({ status: 503 }), "ok");

  const econn = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(classifyProxyProbe({ error: econn }), "unreachable");
  for (const code of [
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
  ]) {
    assert.equal(classifyProxyProbe({ error: Object.assign(new Error(code), { code }) }), "unreachable", code);
  }
  // Headers-timeout: CONNECT состоялся, медлит origin — unknown, не unreachable.
  assert.equal(
    classifyProxyProbe({ error: Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }) }),
    "unknown",
  );
  // Вложенная причина (fetch-обёртки) тоже распознаётся.
  assert.equal(classifyProxyProbe({ error: Object.assign(new Error("fetch failed"), { cause: econn }) }), "unreachable");
  // AggregateError (happy eyeballs).
  assert.equal(classifyProxyProbe({ error: Object.assign(new Error("agg"), { errors: [econn] }) }), "unreachable");

  assert.equal(classifyProxyProbe({ error: new Error("boom") }), "unknown");
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  assert.equal(classifyProxyProbe({ error: timeout }), "unknown", "таймаут пробы — не CONNECT-класс");
  assert.equal(classifyProxyProbe({}), "unknown");
}

/* ── 6. Приоритет источников: инлайн > явный файл > файл по умолчанию > легаси ─ */
{
  const d = freshDir("precedence");
  const def = join(d, DEFAULT_PROXIES_FILE_NAME);
  const custom = join(d, "custom-proxies.json");
  writeProxiesFile(def, ["http://default:1"]);
  writeProxiesFile(custom, ["http://custom:1"]);

  // winningSource называет победителя (входная точка различает legacy-single и пул).
  assert.equal(
    new ProxyPool({ defaultPath: def, env: { NVIDIA_NIM_PROXIES: "http://inline:1", NVIDIA_NIM_PROXY: "http://legacy:1" } })
      .winningSource()?.kind,
    "inline",
  );
  const w2 = new ProxyPool({ defaultPath: def, env: { NVIDIA_NIM_PROXIES_FILE: custom } });
  const w2src = w2.winningSource();
  assert.equal(w2src?.kind, "file");
  assert.equal(w2src && "path" in w2src ? w2src.path : "", custom);
  assert.equal(new ProxyPool({ defaultPath: def, env: {} }).winningSource()?.kind, "defaultFile");
  assert.equal(
    new ProxyPool({ defaultPath: join(d, "missing.json"), env: { NVIDIA_NIM_PROXY: "http://legacy:1" } }).winningSource()?.kind,
    "legacy",
  );
  assert.equal(new ProxyPool({ defaultPath: join(d, "missing.json"), env: {} }).winningSource(), undefined);

  // Инлайн побеждает всё.
  const p1 = new ProxyPool({
    defaultPath: def,
    env: {
      NVIDIA_NIM_PROXIES: "http://inline:1, http://inline:2",
      NVIDIA_NIM_PROXIES_FILE: custom,
      NVIDIA_NIM_PROXY: "http://legacy:1",
    },
  });
  assert.deepEqual(p1.refresh(), ["http://inline:1/", "http://inline:2/"]);
  assert.equal(p1.describe(), "NVIDIA_NIM_PROXIES");

  // Явный файл побеждает файл по умолчанию и легаси.
  const p2 = new ProxyPool({
    defaultPath: def,
    env: { NVIDIA_NIM_PROXIES_FILE: custom, NVIDIA_NIM_PROXY: "http://legacy:1" },
  });
  assert.deepEqual(p2.refresh(), ["http://custom:1/"]);
  assert.ok(p2.describe().includes("custom-proxies.json"), p2.describe());

  // Файл по умолчанию побеждает легаси.
  const p3 = new ProxyPool({ defaultPath: def, env: { NVIDIA_NIM_PROXY: "http://legacy:1" } });
  assert.deepEqual(p3.refresh(), ["http://default:1/"]);
  assert.equal(p3.describe(), DEFAULT_PROXIES_FILE_NAME);

  // Легаси-одиночка — пул из одного (поведение как сегодня).
  const p4 = new ProxyPool({ defaultPath: join(d, "missing.json"), env: { NVIDIA_NIM_PROXY: "http://legacy:1" } });
  assert.equal(p4.hasSource(), true);
  assert.deepEqual(p4.refresh(), ["http://legacy:1/"]);
  assert.equal(p4.describe(), "NVIDIA_NIM_PROXY");

  // Ничего не задано — расширения нет.
  const p5 = new ProxyPool({ defaultPath: join(d, "missing.json"), env: {} });
  assert.equal(p5.hasSource(), false);
  assert.deepEqual(p5.refresh(), []);

  // Ровно один источник побеждает: легаси не подмешивается к файлу (never merged).
  const merged = p3.refresh();
  assert.ok(!merged.some((h) => h.includes("legacy")), "легаси не мерджится с файлом");
}

/* ── 7. Инлайн: дубликаты схлопываются, порядок сохраняется, битые entries видны ─ */
{
  const p = new ProxyPool({
    defaultPath: join(freshDir("inline"), DEFAULT_PROXIES_FILE_NAME),
    env: { NVIDIA_NIM_PROXIES: "http://a:1, http://b:2, http://a:1, socks5://x:1080, http://c:3" },
  });
  assert.deepEqual(p.refresh(), ["http://a:1/", "http://b:2/", "http://c:3/"]);
  const errors = p.parseErrors();
  assert.equal(errors.length, 1, "socks-запись — ошибка разбора");
  assert.ok(errors[0].includes("socks5"), errors[0]);
}

/* ── 8. Файл: $ENV/${ENV}-интерполяция, неразрешимые пропускаются с предупреждением ─ */
{
  const d = freshDir("file-env");
  const file = join(d, DEFAULT_PROXIES_FILE_NAME);
  writeProxiesFile(file, ["http://$PROXY_USER:$PROXY_PASS@exit1.example:8080", "${PROXY_FULL}", "$NO_SUCH", "http://plain:1"]);
  const warnings: string[] = [];
  const p = new ProxyPool({
    defaultPath: file,
    env: { PROXY_USER: "u1", PROXY_PASS: "p1", PROXY_FULL: "http://full:2" },
    onWarn: (m) => warnings.push(m),
  });
  assert.deepEqual(p.refresh(), ["http://u1:p1@exit1.example:8080/", "http://full:2/", "http://plain:1/"]);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("NO_SUCH"), warnings[0]);
  // Пароль не светится в display identity.
  assert.equal(maskProxy(p.refresh()[0]), "exit1.example:8080");
}

/* ── 9. Файл: mtime-перезагрузка, битый JSON и пропавший файл держат старый пул ─ */
{
  const d = freshDir("file-reload");
  const file = join(d, DEFAULT_PROXIES_FILE_NAME);
  writeProxiesFile(file, ["http://v1:1"], -10_000);
  const warnings: string[] = [];
  const p = new ProxyPool({ defaultPath: file, env: {}, onWarn: (m) => warnings.push(m) });
  assert.deepEqual(p.refresh(), ["http://v1:1/"]);
  assert.deepEqual(p.refresh(), ["http://v1:1/"], "mtime не менялся — тот же пул");

  writeProxiesFile(file, ["http://v2:1", "http://v3:1"], 10_000);
  assert.deepEqual(p.refresh(), ["http://v2:1/", "http://v3:1/"], "горячая перезагрузка");

  // Битый JSON → старый пул + одно предупреждение.
  writeFileSync(file, "{битый json", "utf8");
  const t1 = new Date(Date.now() + 20_000);
  utimesSync(file, t1, t1);
  assert.deepEqual(p.refresh(), ["http://v2:1/", "http://v3:1/"], "битый JSON — держим старый пул");
  assert.equal(warnings.length, 1);
  writeFileSync(file, "{снова битый", "utf8");
  const t2 = new Date(Date.now() + 30_000);
  utimesSync(file, t2, t2);
  assert.deepEqual(p.refresh(), ["http://v2:1/", "http://v3:1/"]);
  assert.equal(warnings.length, 1, "предупреждаем один раз");

  // Пропавший файл → старый пул + одно предупреждение.
  rmSync(file);
  assert.deepEqual(p.refresh(), ["http://v2:1/", "http://v3:1/"], "пропавший файл — держим старый пул");
  assert.equal(warnings.length, 2);
  assert.ok(warnings[1].includes("vanished") || warnings[1].includes("пропал"), warnings[1]);
  assert.deepEqual(p.refresh(), ["http://v2:1/", "http://v3:1/"]);
  assert.equal(warnings.length, 2, "предупреждение одно");
  // Держимый пул — по-прежнему источник (панель не говорит «не настроен»).
  assert.equal(p.hasSource(), true);
}

/* ── 10. Файл: права ≠ 600 — одно предупреждение, не блок (POSIX) ──────── */
{
  if (process.platform !== "win32") {
    const d = freshDir("file-perms");
    const file = join(d, DEFAULT_PROXIES_FILE_NAME);
    writeProxiesFile(file, ["http://u:p@open:1"]);
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    const p = new ProxyPool({ defaultPath: file, env: {}, onWarn: (m) => warnings.push(m) });
    assert.deepEqual(p.refresh(), ["http://u:p@open:1/"], "чтение не блокируется");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("600"), warnings[0]);
    assert.deepEqual(p.refresh(), ["http://u:p@open:1/"]);
    assert.equal(warnings.length, 1, "один раз");
  }
}

/* ── 11. Легаси NVIDIA_NIM_PROXY: опечатка и socks видны как ошибка разбора ─ */
{
  const warnings: string[] = [];
  const p = new ProxyPool({
    defaultPath: join(freshDir("legacy-bad"), DEFAULT_PROXIES_FILE_NAME),
    env: { NVIDIA_NIM_PROXY: "socks5://1.2.3.4:1080" },
    onWarn: (m) => warnings.push(m),
  });
  assert.equal(p.hasSource(), true, "источник задан — расширение не молчит");
  assert.deepEqual(p.refresh(), []);
  assert.equal(p.parseErrors().length, 1);
  assert.ok(p.parseErrors()[0].includes("socks5"), p.parseErrors()[0]);
  assert.equal(warnings.length, 1);
  p.refresh();
  assert.equal(warnings.length, 1, "предупреждение одно");

  const p2 = new ProxyPool({
    defaultPath: join(freshDir("legacy-bad2"), DEFAULT_PROXIES_FILE_NAME),
    env: { NVIDIA_NIM_PROXY: "ht tp://опечатка" },
  });
  assert.deepEqual(p2.refresh(), []);
  assert.equal(p2.parseErrors().length, 1, "ошибка разбора видна в панели/интро, а не «не настроен»");
}

/* ── 12. Файл по умолчанию отсутствует — не источник, легаси работает ──── */
{
  const d = freshDir("default-missing");
  const p = new ProxyPool({ defaultPath: join(d, DEFAULT_PROXIES_FILE_NAME), env: { NVIDIA_NIM_PROXY: "1.2.3.4:8870" } });
  assert.deepEqual(p.refresh(), ["http://1.2.3.4:8870/"]);
  assert.equal(p.describe(), "NVIDIA_NIM_PROXY");
}

/* ── 13. ProxyRotator: пустой пул → direct; пул из одного → всегда он ──── */
{
  const r = new ProxyRotator({ random: () => 0 });
  r.setPool([]);
  assert.deepEqual(r.pick(0, { rotationEnabled: true }), { kind: "direct" });
  assert.deepEqual(r.pick(0, { rotationEnabled: false }), { kind: "direct" });

  r.setPool(["http://solo:1/"]);
  const p1 = r.pick(0, { rotationEnabled: true });
  assert.deepEqual(p1, { kind: "proxy", href: "http://solo:1/" });
  // Единственный эндпоинт в карантине — всё равно pick (ближайший expiry), не wait/direct.
  r.markConnectFailed("http://solo:1/", 0);
  const p2 = r.pick(1_000, { rotationEnabled: true });
  assert.deepEqual(p2, { kind: "proxy", href: "http://solo:1/" }, "фаза 1 не блокирует dispatch на таймере");
}

/* ── 14. Pin: липкий между запросами; pinByDisplay; неизвестный — false ── */
{
  const r = new ProxyRotator({ random: () => 0 });
  r.setPool(["http://a:1/", "http://b:2/"]);
  assert.equal(r.pin("http://b:2/"), true);
  assert.equal(r.pinnedHref(), "http://b:2/");
  assert.deepEqual(r.pick(0, { rotationEnabled: true }), { kind: "proxy", href: "http://b:2/" });
  assert.deepEqual(r.pick(1, { rotationEnabled: true }), { kind: "proxy", href: "http://b:2/" }, "липкий");

  assert.equal(r.pinByDisplay("a:1"), true, "pin по display identity");
  assert.equal(r.pinnedHref(), "http://a:1/");
  assert.equal(r.pinByDisplay("nope:1"), false);
  assert.equal(r.pin("http://not-in-pool:1/"), false);
  assert.equal(r.pinnedHref(), "http://a:1/", "неудачный pin не сбрасывает текущий");

  // Выбор обновляет pin (pin = «эндпоинт, выбранный для этого dispatch»).
  r.markConnectFailed("http://a:1/", 0);
  const p = r.pick(0, { rotationEnabled: true });
  assert.deepEqual(p, { kind: "proxy", href: "http://b:2/" }, "pin в карантине → готовый сосед");
  assert.equal(r.pinnedHref(), "http://b:2/");
}

/* ── 15. Выключенная ротация: pin держится, нет skip/сдвига/least-inFlight ─ */
{
  const r = new ProxyRotator({ random: () => 0.999 }); // сдвиг кольца на пуле [a,b,c] → offset 2
  r.setPool(["http://a:1/", "http://b:2/", "http://c:3/"]);
  // Без pin — первый эндпоинт ИСТОЧНИКА (не сдвинутого кольца).
  assert.deepEqual(r.pick(0, { rotationEnabled: false }), { kind: "proxy", href: "http://a:1/" });
  assert.equal(r.pinnedHref(), "http://a:1/", "первый становится pin");

  // Pin в карантине — ротация выключена, всё равно держим pin («off = lock this exit»).
  r.markConnectFailed("http://a:1/", 0);
  assert.deepEqual(r.pick(1, { rotationEnabled: false }), { kind: "proxy", href: "http://a:1/" });

  // Занятость не учитывается.
  r.noteInFlight("http://a:1/");
  r.noteInFlight("http://a:1/");
  assert.deepEqual(r.pick(2, { rotationEnabled: false }), { kind: "proxy", href: "http://a:1/" });

  // Явный pin от check/pin survives off.
  r.pin("http://c:3/");
  assert.deepEqual(r.pick(3, { rotationEnabled: false }), { kind: "proxy", href: "http://c:3/" });

  // `on` возвращает кольцо: готовый least-inFlight.
  assert.deepEqual(r.pick(4, { rotationEnabled: true }), { kind: "proxy", href: "http://c:3/" }, "pin готов → липкий");
}

/* ── 16. Least inFlight: параллельные dispatch расходятся; pin побеждает ничью ─ */
{
  const r = new ProxyRotator({ random: () => 0 });
  r.setPool(["http://a:1/", "http://b:2/"]);
  const first = r.pick(0, { rotationEnabled: true });
  assert.equal(first.kind, "proxy");
  const firstHref = first.kind === "proxy" ? first.href : "";
  r.noteInFlight(firstHref);
  const second = r.pick(0, { rotationEnabled: true });
  assert.equal(second.kind, "proxy");
  assert.notEqual(second.kind === "proxy" ? second.href : "", firstHref, "второй параллельный уходит на свободный");

  // Ничья по занятости — pin выигрывает.
  r.releaseInFlight(firstHref);
  r.pin("http://b:2/");
  r.noteInFlight("http://a:1/");
  r.noteInFlight("http://b:2/");
  assert.deepEqual(r.pick(0, { rotationEnabled: true }), { kind: "proxy", href: "http://b:2/" }, "при ничьей — pin");

  // releaseInFlight возвращает в свободные; лишний релиз не уводит в минус.
  r.releaseInFlight("http://a:1/");
  r.releaseInFlight("http://a:1/");
  assert.equal(r.inFlightCount("http://a:1/"), 0);
}

/* ── 17. Карантин: TTL 60 с, markOk гасит и пишет латентность ──────────── */
{
  assert.equal(PROXY_QUARANTINE_MS, 60_000, "константа TTL — 60 с (не env-ручка в фазе 1)");
  const r = new ProxyRotator({ random: () => 0 });
  r.setPool(["http://a:1/", "http://b:2/"]);
  r.pin("http://a:1/");
  r.markConnectFailed("http://a:1/", 1_000);
  assert.equal(r.cooldownLeft("http://a:1/", 1_000), PROXY_QUARANTINE_MS);
  assert.deepEqual(r.pick(2_000, { rotationEnabled: true }), { kind: "proxy", href: "http://b:2/" }, "карантин → готовый сосед");

  // TTL истекает — эндпоинт снова в деле.
  const after = r.pick(1_000 + PROXY_QUARANTINE_MS + 1, { rotationEnabled: true });
  assert.equal(after.kind, "proxy");
  // (pin теперь b; a снова ready — выбирается по кольцу/ничьей; главное — a не исключён навсегда)
  const rows = r.statusFor(1_000 + PROXY_QUARANTINE_MS + 1);
  assert.equal(rows.find((s) => s.display === "a:1")?.state, "ready", "после TTL снова ready — не вечный denylist");

  // markOk: латентность + снятие карантина.
  r.markConnectFailed("http://b:2/", 10_000);
  r.markOk("http://b:2/", 1234, 11_000);
  assert.equal(r.cooldownLeft("http://b:2/", 11_000), 0, "успех доказывает достижимость");
  const st = r.statusFor(11_000);
  assert.equal(st.find((s) => s.display === "b:2")?.lastLatencyMs, 1234);
}

/* ── 18. Все в cooldown → ближайший expiry (не wait, не direct) ────────── */
{
  const r = new ProxyRotator({ random: () => 0 });
  r.setPool(["http://a:1/", "http://b:2/"]);
  r.markConnectFailed("http://a:1/", 0); // expiry 60_000
  r.cooldownLeft("http://a:1/", 0);
  r.markConnectFailed("http://b:2/", 0);
  // b помечен позже? обе одинаково; сделаем a дальше:
  r.markConnectFailed("http://a:1/", 30_000); // expiry 90_000, b expiry 60_000
  const p = r.pick(31_000, { rotationEnabled: true });
  assert.deepEqual(p, { kind: "proxy", href: "http://b:2/" }, "ближайший expiry");
}

/* ── 19. Сдвиг кольца разводит веер процессов, липкость внутри процесса не ломается ─ */
{
  const pool = ["http://a:1/", "http://b:2/", "http://c:3/"];
  const r1 = new ProxyRotator({ random: () => 0 }); // offset 0 → вход a
  const r2 = new ProxyRotator({ random: () => 0.34 }); // offset 1 → вход b
  const r3 = new ProxyRotator({ random: () => 0.67 }); // offset 2 → вход c
  for (const [r, expected] of [[r1, "http://a:1/"], [r2, "http://b:2/"], [r3, "http://c:3/"]] as const) {
    r.setPool(pool);
    const p = r.pick(0, { rotationEnabled: true });
    assert.deepEqual(p, { kind: "proxy", href: expected });
  }
  // Внутри процесса липкость: повторный pick — тот же выход.
  assert.deepEqual(r2.pick(1, { rotationEnabled: true }), { kind: "proxy", href: "http://b:2/" });
}

/* ── 20. Выбывший из пула href: pin падает на первый оставшийся, кулдауны чистятся ─ */
{
  const r = new ProxyRotator({ random: () => 0 });
  r.setPool(["http://a:1/", "http://b:2/"]);
  r.pin("http://a:1/");
  r.markConnectFailed("http://a:1/", 0);
  r.noteInFlight("http://a:1/");
  r.markOk("http://a:1/", 55, 0);
  r.setPool(["http://b:2/"]);
  assert.equal(r.pinnedHref(), "http://b:2/", "pin на выбывшем → первый оставшийся");
  assert.equal(r.cooldownLeft("http://a:1/", 0), 0, "кулдаун выбывшего сброшен");
  assert.equal(r.inFlightCount("http://a:1/"), 0);
  assert.deepEqual(r.statusFor(0).map((s) => s.display), ["b:2"]);
  // Возврат в пул — состояние не воскресает.
  r.setPool(["http://a:1/", "http://b:2/"]);
  assert.equal(r.cooldownLeft("http://a:1/", 0), 0);
}

/* ── 21. statusFor: display identity, состояния, pinned, латентность ───── */
{
  const r = new ProxyRotator({ random: () => 0 });
  r.setPool(["http://u:p@a:1/", "http://b:2/"]);
  r.pin("http://u:p@a:1/");
  r.markConnectFailed("http://b:2/", 10_000);
  r.markOk("http://u:p@a:1/", 42, 0);
  const rows = r.statusFor(11_000);
  assert.deepEqual(
    rows.map((s) => [s.display, s.state, s.pinned, s.lastLatencyMs]),
    [
      ["a:1", "ready", true, 42],
      ["b:2", "cooldown", false, undefined],
    ],
  );
  assert.ok(rows[1].cooldownLeftMs > 0 && rows[1].cooldownLeftMs <= PROXY_QUARANTINE_MS);
  for (const row of rows) assert.ok(!row.display.includes("@"), "userinfo нет в отчёте");
  // effectivePin: без явного pin — первый; панель и интро с ним согласованы.
  const r2 = new ProxyRotator({ random: () => 0 });
  r2.setPool(["http://x:1/", "http://y:2/"]);
  assert.equal(r2.effectivePin(), "http://x:1/");
  assert.equal(r2.statusFor(0)[0].pinned, true);
}

/* ── 22. Разделяемый TTL-файл: карантин виден второму ротатору ─────────── */
{
  const d = freshDir("shared-1");
  const file = join(d, "nvidia-proxies-state.json");
  const a = new ProxyRotator({ random: () => 0 });
  const b = new ProxyRotator({ random: () => 0 });
  a.attachSharedState(file);
  b.attachSharedState(file);
  const pool = ["http://u:p@a:1/", "http://b:2/"];
  a.setPool(pool);
  b.setPool(pool);
  a.markConnectFailed("http://u:p@a:1/", Date.now());

  const p = b.pick(Date.now(), { rotationEnabled: true });
  assert.deepEqual(p, { kind: "proxy", href: "http://b:2/" }, "второй процесс не выбирает карантинный display id");

  // Ключи файла — display identity, не credentialed URL; права 600.
  const raw = JSON.parse(readFileSync(file, "utf8")) as { cooldownUntil: Record<string, number> };
  assert.deepEqual(Object.keys(raw.cooldownUntil), ["a:1"]);
  assert.ok(!file.includes("@") || !readFileSync(file, "utf8").includes("u:p"), "пароля нет в файле");
  assert.ok(!readFileSync(file, "utf8").includes("u:p"));
  if (process.platform !== "win32") {
    const mode = 0o777 & statSync(file).mode;
    assert.equal(mode, 0o600, `права файла ${mode.toString(8)}`);
  }
}

/* ── 23. Разделяемый файл: TTL отмирает при чтении; merge по max ───────── */
{
  const d = freshDir("shared-2");
  const file = join(d, "state.json");
  const now = Date.now();
  writeFileSync(file, JSON.stringify({ cooldownUntil: { "a:1": now - 1_000, "b:2": now + 60_000 } }), { mode: 0o600 });
  const r = new ProxyRotator({ random: () => 0 });
  r.attachSharedState(file);
  r.setPool(["http://a:1/", "http://b:2/"]);
  const rows = r.statusFor(now);
  assert.equal(rows.find((s) => s.display === "a:1")?.state, "ready", "просроченный TTL игнорируется");
  assert.equal(rows.find((s) => s.display === "b:2")?.state, "cooldown");

  // Merge по max: короткий свой кулдаун не укорачивает длинный чужой.
  const r2 = new ProxyRotator({ random: () => 0 });
  r2.attachSharedState(file);
  r2.setPool(["http://b:2/"]);
  r2.markConnectFailed("http://b:2/", now - 55_000); // свой expiry now+5s < чужой now+60s
  const r3 = new ProxyRotator({ random: () => 0 });
  r3.attachSharedState(file);
  r3.setPool(["http://b:2/"]);
  r3.statusFor(now); // merge
  assert.ok(r3.cooldownLeft("http://b:2/", now) > 50_000, "чужой длинный TTL не укорочен");
}

/* ── 24. markOk гасит чужой разделяемый карантин (успех доказывает живость) ── */
{
  const d = freshDir("shared-3");
  const file = join(d, "state.json");
  const now = Date.now();
  const a = new ProxyRotator({ random: () => 0 });
  a.attachSharedState(file);
  a.setPool(["http://a:1/"]);
  a.markConnectFailed("http://a:1/", now);
  a.markOk("http://a:1/", 100, now + 1_000);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { cooldownUntil: Record<string, number> };
  assert.equal(raw.cooldownUntil["a:1"], undefined, "снятый карантин не остаётся в файле");
  const b = new ProxyRotator({ random: () => 0 });
  b.attachSharedState(file);
  b.setPool(["http://a:1/"]);
  assert.equal(b.statusFor(now + 1_000)[0].state, "ready");
}

/* ── 25. Сверка с пулом: чужие display id выбрасываются из файла и памяти ─ */
{
  const d = freshDir("shared-4");
  const file = join(d, "state.json");
  const now = Date.now();
  writeFileSync(
    file,
    JSON.stringify({ cooldownUntil: { "gone:1": now + 60_000, "kept:2": now + 60_000, "old:3": now - 5 } }),
    { mode: 0o600 },
  );
  const r = new ProxyRotator({ random: () => 0 });
  r.attachSharedState(file);
  r.setPool(["http://kept:2/"]); // gone:1 и old:3 в пуле отсутствуют
  const raw = JSON.parse(readFileSync(file, "utf8")) as { cooldownUntil: Record<string, number> };
  assert.deepEqual(Object.keys(raw.cooldownUntil), ["kept:2"], "чужие и просроченные выброшены");
}

/* ── 26. Без attach / битый файл — ротатор живёт в памяти, pick не падает ─ */
{
  const d = freshDir("shared-5");
  const broken = join(d, "broken.json");
  writeFileSync(broken, "{не json", "utf8");
  const r = new ProxyRotator({ random: () => 0 });
  r.attachSharedState(broken);
  r.setPool(["http://a:1/", "http://b:2/"]);
  const p = r.pick(0, { rotationEnabled: true });
  assert.equal(p.kind, "proxy", "битый стейт-файл не ломает pick");

  const missing = join(d, "missing.json");
  const r2 = new ProxyRotator({ random: () => 0 });
  r2.attachSharedState(missing);
  r2.setPool(["http://a:1/"]);
  assert.equal(r2.pick(0, { rotationEnabled: true }).kind, "proxy");
  r2.markConnectFailed("http://a:1/", 0); // запись в несуществующий каталог? каталог есть — файл создастся
  assert.ok(readFileSync(missing, "utf8").includes("a:1"));

  const noAttach = new ProxyRotator({ random: () => 0 });
  noAttach.setPool(["http://a:1/"]);
  noAttach.markConnectFailed("http://a:1/", 0);
  assert.equal(noAttach.cooldownLeft("http://a:1/", 0), PROXY_QUARANTINE_MS, "память работает без файла");
}

/* ── 27. Двухпроцессная проба (не только юнит в одном процессе) ────────── */
{
  const d = freshDir("shared-procs");
  const file = join(d, "nvidia-proxies-state.json");
  const childScript = join("test", "fixtures", "proxy-shared-child.ts");
  const hrefA = "http://a:1/";
  const hrefB = "http://b:2/";

  const parent = new ProxyRotator({ random: () => 0 });
  parent.attachSharedState(file);
  parent.setPool([hrefA, hrefB]);
  parent.markConnectFailed(hrefA, Date.now());

  const attached = spawnSync(process.execPath, [childScript, file, hrefA, hrefB], { encoding: "utf8" });
  assert.equal(attached.status, 0, attached.stderr);
  const rows = JSON.parse(attached.stdout) as Array<{ display: string; state: string }>;
  assert.equal(rows.find((s) => s.display === "a:1")?.state, "cooldown", "карантин доехал до второго процесса");

  const detached = spawnSync(process.execPath, [childScript, file, hrefA, hrefB, "noattach"], { encoding: "utf8" });
  assert.equal(detached.status, 0, detached.stderr);
  const rows2 = JSON.parse(detached.stdout) as Array<{ display: string; state: string }>;
  assert.equal(rows2.find((s) => s.display === "a:1")?.state, "ready", "выключатель (без attach) гасит общий стейт");
}

/* ── 28. applyProbeResults: итоги check одной операцией шва ──────────── */
{
  const r = new ProxyRotator({ random: () => 0 });
  r.setPool(["http://a:1/", "http://b:2/", "http://c:3/"]);
  const now = 100_000;
  // a — медленный ok, b — быстрый ok, c — unreachable.
  const pinned = r.applyProbeResults(
    [
      { display: "a:1", outcome: "ok", latencyMs: 900 },
      { display: "b:2", outcome: "ok", latencyMs: 120 },
      { display: "c:3", outcome: "unreachable" },
    ],
    now,
  );
  assert.equal(pinned, "b:2", "pin — самый быстрый ok");
  assert.equal(r.pinnedHref(), "http://b:2/");
  assert.ok(r.cooldownLeft("http://c:3/", now) > 0, "unreachable карантинит");
  assert.equal(r.statusFor(now).find((s) => s.display === "b:2")?.lastLatencyMs, 120, "exit quality записана");

  // Ноль ok — pin не меняется, undefined.
  r.setPool(["http://a:1/", "http://b:2/"]);
  r.pin("http://a:1/");
  const none = r.applyProbeResults(
    [
      { display: "a:1", outcome: "unreachable" },
      { display: "b:2", outcome: "unknown" },
    ],
    now,
  );
  assert.equal(none, undefined);
  assert.equal(r.pinnedHref(), "http://a:1/", "pin не изменился");

  // hrefForDisplay — обратный поиск без утечки href наружу.
  r.setPool(["http://u:p@a:1/"]);
  assert.equal(r.hrefForDisplay("a:1"), "http://u:p@a:1/");
  assert.equal(r.hrefForDisplay("  a:1  "), "http://u:p@a:1/", "trim");
  assert.equal(r.hrefForDisplay("nope:1"), undefined);
}

/* ── 29. runProxyProbes: параллельность ≤ 2, порядок, abort, fastestOk ─── */
{
  assert.equal(PROXY_CHECK_CONCURRENCY, 2);
  assert.equal(PROXY_PROBE_TIMEOUT_MS, 10_000);
  const endpoints = [
    { href: "http://a:1/", display: "a:1" },
    { href: "http://b:2/", display: "b:2" },
    { href: "http://c:3/", display: "c:3" },
    { href: "http://d:4/", display: "d:4" },
  ];

  // Параллельность не больше 2; порядок строк — порядок пула.
  let active = 0;
  let maxActive = 0;
  const latencies: Record<string, number> = { "a:1": 30, "b:2": 10, "c:3": 20 };
  const run1 = await runProxyProbes(endpoints, async (ep) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, latencies[ep.display] ?? 5));
    active -= 1;
    if (ep.display === "c:3") return { status: 200 };
    if (ep.display === "d:4") return { error: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) };
    return { status: 200 };
  });
  assert.ok(maxActive <= 2, `параллельность ${maxActive} > 2`);
  assert.deepEqual(run1.rows.map((r) => r.display), ["a:1", "b:2", "c:3", "d:4"], "порядок пула");
  assert.equal(run1.aborted, false);
  assert.equal(run1.probed, 4);
  assert.equal(run1.skipped, 0);
  assert.equal(run1.rows[0].outcome, "ok");
  assert.ok((run1.rows[0].latencyMs ?? 0) >= 25, "латентность измерена");
  assert.equal(run1.rows[3].outcome, "unreachable");
  assert.equal(run1.rows[3].latencyMs, undefined);

  // fastestOk — минимальная латентность среди ok.
  const fastest = fastestOk(run1.rows);
  assert.equal(fastest?.display, "b:2");

  // Бросившаяся проба → unknown с redacted ошибкой.
  const run2 = await runProxyProbes([endpoints[0]], async () => {
    throw new Error("secret://u:p@h взрыв");
  });
  assert.equal(run2.rows[0].outcome, "unknown");
  assert.ok(!(run2.rows[0].error ?? "").includes("u:p"), run2.rows[0].error);

  // Аборт: оставшиеся пробы пропускаются, сводка по уже полученным.
  let probedCount = 0;
  const run3 = await runProxyProbes(endpoints, async () => {
    probedCount += 1;
    return { status: 200 };
  }, { concurrency: 2, isAborted: () => probedCount >= 2 });
  assert.equal(run3.aborted, true);
  assert.equal(run3.rows.length, 2);
  assert.equal(run3.skipped, 2);

  // Ноль ok → fastestOk undefined (pin не меняется — проверяет вызывающий).
  const run4 = await runProxyProbes(endpoints.slice(0, 2), async () => ({ error: new Error("x") }));
  assert.equal(fastestOk(run4.rows), undefined);
  assert.equal(run4.rows.every((r: ProxyProbeResultRow) => r.outcome === "unknown"), true);
}

console.log("proxy-pool: все проверки прошли");
