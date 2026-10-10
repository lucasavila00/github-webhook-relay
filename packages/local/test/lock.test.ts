import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createProcessService } from "../src/lock.ts";

const directories: Array<string> = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory != null) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("Linux consumer lock", () => {
  it("rejects overlap and releases after the holder completes", async () => {
    const lockPath = await temporaryLockPath();
    const service = createProcessService();
    let release: (() => void) | null | undefined;
    let acquired: (() => void) | null | undefined;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = service.withFileLock(lockPath, async () => {
      acquired?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;

    await expect(
      service.withFileLock(lockPath, async () => undefined),
    ).rejects.toMatchObject({ code: "in_use" });
    release?.();
    await held;
    await expect(
      service.withFileLock(lockPath, async () => "released"),
    ).resolves.toBe("released");
  });

  it("releases the child lock after its parent process dies", async () => {
    const lockPath = await temporaryLockPath();
    const fixture = fileURLToPath(
      new URL("./fixtures/lock-holder.ts", import.meta.url),
    );
    const holder = spawn(
      process.execPath,
      ["--experimental-strip-types", fixture, lockPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const [output] = (await once(holder.stdout, "data")) as [Buffer];
    expect(output.toString("utf8")).toContain("locked");

    holder.kill("SIGKILL");
    await once(holder, "close");
    await expect(
      createProcessService().withFileLock(lockPath, async () => "released"),
    ).resolves.toBe("released");
  });
});

async function temporaryLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gh-watch-lock-"));
  directories.push(directory);
  return join(directory, "consumer.lock");
}
