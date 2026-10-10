import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");
const tempRoot = join(repoRoot, ".tmp");
const tempDirs: Array<string> = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function lint(source: string): Promise<number> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "relay-nullish-"));
  tempDirs.push(directory);
  const path = join(directory, "input.ts");
  await writeFile(path, source);
  try {
    await execFileAsync(oxlintBin, [path, "--config", ".oxlintrc.json", "--threads=1"], {
      cwd: repoRoot,
    });
    return 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") {
      return error.code;
    }
    throw error;
  }
}

describe("nullish type rules", () => {
  const invalid = [
    "type T = string | null;",
    "type T = string | undefined;",
    "type T = null;",
    "type T = undefined;",
    "type T = { value?: string | null | undefined };",
    "function read(value?: string | null | undefined) { return value; }",
    "type T = { read?(): void };",
    "type T = [value?: string | null | undefined];",
    "type T = [(string | null | undefined)?];",
  ];

  for (const source of invalid) {
    it(`rejects ${source}`, async () => expect(await lint(source)).not.toBe(0), 30_000);
  }

  const valid = [
    "type T = string | null | undefined;",
    "type T = { value: string | null | undefined };",
    "function read(value: string | null | undefined) { return value; }",
    "type T = { read: (() => void) | null | undefined };",
    "type T = [value: string | null | undefined];",
  ];

  for (const source of valid) {
    it(`allows ${source}`, async () => expect(await lint(source)).toBe(0), 30_000);
  }
});
