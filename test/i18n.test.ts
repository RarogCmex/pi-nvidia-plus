// Тесты i18n-слоя (тикет 17): выбор локали, интерполяция, полнота каталога.
import assert from "node:assert";
import {
  MESSAGES,
  detectLocale,
  getLocale,
  setLocale,
  t,
  tIn,
} from "../extensions/i18n.ts";
import { formatDiagnostic, parseProxyUrl, describeProxyFailure } from "../extensions/proxy.ts";
import { parseKeysFileContent } from "../extensions/keys.ts";

// 1. detectLocale: явная переменная имеет приоритет.
{
  assert.equal(detectLocale({ PI_NVIDIA_PLUS_LANG: "ru" }), "ru");
  assert.equal(detectLocale({ PI_NVIDIA_PLUS_LANG: "RU" }), "ru");
  assert.equal(detectLocale({ PI_NVIDIA_PLUS_LANG: "en", LANG: "ru_RU.UTF-8" }), "en");
  assert.equal(detectLocale({ PI_NVIDIA_PLUS_LANG: "ru", LANG: "en_US.UTF-8" }), "ru");
  // Нераспознанное явное значение — проваливаемся к окружению.
  assert.equal(detectLocale({ PI_NVIDIA_PLUS_LANG: "fr", LANG: "ru_RU.UTF-8" }), "ru");
}

// 2. detectLocale: LC_ALL > LC_MESSAGES > LANG; C/POSIX пропускаются; дефолт en.
{
  assert.equal(detectLocale({ LC_ALL: "ru_RU.UTF-8", LANG: "en_US.UTF-8" }), "ru");
  assert.equal(detectLocale({ LC_ALL: "en_US.UTF-8", LANG: "ru_RU.UTF-8" }), "en");
  assert.equal(detectLocale({ LC_MESSAGES: "ru_RU.UTF-8", LANG: "en_US.UTF-8" }), "ru");
  assert.equal(detectLocale({ LANG: "ru_RU.UTF-8" }), "ru");
  assert.equal(detectLocale({ LANG: "en_US.UTF-8" }), "en");
  assert.equal(detectLocale({ LC_ALL: "C", LANG: "ru_RU.UTF-8" }), "ru", "C считается незаданным");
  assert.equal(detectLocale({ LC_ALL: "POSIX", LANG: "ru_RU.UTF-8" }), "ru", "POSIX считается незаданным");
  assert.equal(detectLocale({}), "en", "ничего не задано — английский");
  assert.equal(detectLocale({ LANG: "fr_FR.UTF-8" }), "en", "не-ru — английский");
}

// 3. setLocale: переопределение и возврат к автоопределению.
{
  setLocale("ru");
  assert.equal(getLocale(), "ru");
  setLocale("en");
  assert.equal(getLocale(), "en");
  setLocale(undefined);
  assert.ok(["en", "ru"].includes(getLocale()), "автоопределение возвращает одну из двух локалей");
}

// 4. Интерполяция в обеих локалях.
{
  assert.equal(
    tIn("en", "diagRateLimit", { retry: ", retry in 32s", request: ", request r1" }),
    "NIM 429: rate limit, retry in 32s, request r1",
  );
  assert.equal(
    tIn("ru", "diagRateLimit", { retry: ", повтор через 32 с", request: ", запрос r1" }),
    "NIM 429: ограничение частоты, повтор через 32 с, запрос r1",
  );
  assert.equal(tIn("en", "proxyIntro", { url: "http://p:8870" }), "pi-nvidia-plus: NIM requests go through proxy http://p:8870");
  // Незаполненная подстановка остаётся видимой (не молча пустой).
  assert.equal(tIn("en", "proxyIntro", {}), "pi-nvidia-plus: NIM requests go through proxy {url}");
  // Числа приводятся к строке.
  assert.ok(tIn("ru", "rotationExhausted", { status: 429, attempts: 6 }).includes("(6 попыток)"));
}

// 5. Полнота каталога: обе локали непустые, наборы подстановок совпадают.
{
  const placeholders = (s: string): string[] =>
    [...s.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]).sort();
  for (const [key, pair] of Object.entries(MESSAGES)) {
    assert.ok(typeof pair.en === "string" && pair.en.trim().length > 0, `${key}: en пуст`);
    assert.ok(typeof pair.ru === "string" && pair.ru.trim().length > 0, `${key}: ru пуст`);
    assert.deepEqual(placeholders(pair.en), placeholders(pair.ru), `${key}: подстановки не совпадают`);
  }
}

// 6. Интеграция: чистые модули говорят через каталог.
{
  setLocale("en");
  assert.ok(formatDiagnostic({ status: 429, retryAfterMs: 32000, requestId: "r1", observedAt: 0 }).startsWith("NIM 429: rate limit"));
  assert.ok(parseProxyUrl("ht tp://bad").error?.startsWith("could not parse NVIDIA_NIM_PROXY"));
  assert.ok(describeProxyFailure("http://p:1/", Object.assign(new Error("x"), { code: "ECONNREFUSED" })).includes("unreachable"));
  assert.ok(parseKeysFileContent("не json").error?.startsWith("keys file is not JSON"));

  setLocale("ru");
  assert.ok(formatDiagnostic({ status: 429, retryAfterMs: 32000, requestId: "r1", observedAt: 0 }).startsWith("NIM 429: ограничение частоты"));
  assert.ok(parseProxyUrl("ht tp://bad").error?.startsWith("не удалось разобрать NVIDIA_NIM_PROXY"));
  assert.ok(describeProxyFailure("http://p:1/", Object.assign(new Error("x"), { code: "ECONNREFUSED" })).includes("недоступен"));
  assert.ok(parseKeysFileContent("не json").error?.startsWith("файл ключей — не JSON"));
  setLocale(undefined);
}

// 7. t() уважает переопределение локали.
{
  setLocale("ru");
  assert.equal(t("statusAutoOn"), "автоприменение вкл");
  setLocale("en");
  assert.equal(t("statusAutoOn"), "auto-apply on");
  setLocale(undefined);
}

console.log("i18n.test.ts: ok");
