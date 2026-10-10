import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe.each(["full", "revocation"])("%s executable", (command) => {
  it("stops at configuration validation without provider values", async () => {
    const child = spawn(process.execPath, [resolve(`dist/${command}.js`)], {
      env: {},
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (value: string) => {
      error += value;
    });
    const [status] = await once(child, "exit");
    expect(status).not.toBe(0);
    expect(error).toContain("Failed to parse LiveE2eConfig");
    expect(error).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});
