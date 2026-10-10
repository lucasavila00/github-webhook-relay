import { spawn } from "node:child_process";

import type { ProcessService } from "./capabilities.ts";
import { localError } from "./types.ts";

export function createProcessService(): ProcessService {
  return { withFileLock };
}

async function withFileLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const child = spawn(
    "flock",
    ["--exclusive", "--nonblock", path, "sh", "-c", "printf 'ready\\n'; read _"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  let releasing = false;
  const exited = new Promise<never>((_resolve, reject) => {
    child.once("exit", (code) => {
      if (releasing) return;
      reject(
        code === 1
          ? localError("in_use", "Consumer state is in use.")
          : localError("storage", "Consumer state lock ended unexpectedly."),
      );
    });
  });
  await Promise.race([waitForLock(child), exited]);
  try {
    return await Promise.race([action(), exited]);
  } finally {
    releasing = true;
    child.stdin.end("\n");
    await closed;
  }
}

async function waitForLock(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    let output = "";
    child.once("error", () =>
      reject(localError("storage", "Cannot start the consumer state lock.")),
    );
    child.stdout?.on("data", (value: Buffer) => {
      output += value.toString("utf8");
      if (output.includes("ready\n")) resolve();
    });
  });
}
