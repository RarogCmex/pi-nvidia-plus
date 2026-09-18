#!/usr/bin/env node
/**
 * Кроссплатформенный раннер тестов (замена sh-цикла `for f in test/*.test.ts`).
 * Работает на Linux, macOS и Windows (cmd/PowerShell).
 *
 * Использование: `node scripts/run-tests.mjs`
 */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "test");

const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join(testDir, f));

if (files.length === 0) {
  console.error("test: no test files found in test/");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  console.log(`── ${file.replace(`${root}/`, "").replace(`${root}\\`, "")}`);
  const result = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (result.status !== 0) {
    failed++;
    console.error(`✗ FAILED: ${file} (exit ${result.status})`);
    break; // как `|| exit 1` в sh-версии — стоп на первой ошибке
  }
}

if (failed > 0) {
  process.exit(1);
}
