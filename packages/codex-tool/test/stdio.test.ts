import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const clients: Array<Client> = [];
const directories: Array<string> = [];

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("compiled stdio server", () => {
  it("lists its tools and validates input through real child pipes", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "gh-watch-stdio-"));
    directories.push(stateDirectory);
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["./dist/server.mjs"],
      cwd: resolve("../../plugins/gh-watch"),
      env: {
        ...getDefaultEnvironment(),
        GH_WATCH_RELAY_URL: "http://127.0.0.1:1",
        GH_WATCH_STATE_DIRECTORY: stateDirectory,
        CF_ACCESS_CLIENT_ID: "test-client",
        CF_ACCESS_CLIENT_SECRET: "test-secret",
      },
      stderr: "pipe",
    });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "watch",
      "acknowledge",
    ]);

    const result = await client.callTool({
      name: "watch",
      arguments: { consumer: "review", filters: {}, waitMilliseconds: 0 },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        type: "error",
        error: { code: "invalid_request", message: "Invalid watch input." },
      },
    });
  });
});
