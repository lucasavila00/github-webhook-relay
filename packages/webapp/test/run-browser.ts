import { spawn } from "node:child_process";

import setup from "./browser-setup.ts";

const teardown = await setup();
try {
  const result = await new Promise<number>((resolve, reject) => {
    const vitest = spawn(
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.browser.config.ts"],
      { cwd: new URL("..", import.meta.url), env: process.env, stdio: "inherit" },
    );
    vitest.once("error", reject);
    vitest.once("exit", (code) => resolve(code ?? 1));
  });
  if (result !== 0) process.exitCode = result;
} finally {
  await teardown();
}
