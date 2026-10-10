import { resolve } from "node:path";

import { Capabilities } from "@beff/diy/capabilities";
import {
  Parsers,
  type Event,
  type WatchResult,
} from "@github-webhook-relay/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import WebSocket from "ws";

import type {
  BrowserCapability,
  ClockCapability,
  HttpCapability,
  OutputCapability,
  SocketProbeCapability,
  ToolCapability,
  ToolSession,
} from "./capabilities.ts";

type AdapterCapabilities =
  | BrowserCapability
  | ClockCapability
  | HttpCapability
  | OutputCapability
  | SocketProbeCapability
  | ToolCapability;

export function createAdapters(
  config: Readonly<{
    accessClientId: string;
    accessClientSecret: string;
    relayUrl: string;
  }>,
): Capabilities<AdapterCapabilities> {
  const accessHeaders = {
    "CF-Access-Client-Id": config.accessClientId,
    "CF-Access-Client-Secret": config.accessClientSecret,
  };
  return Capabilities.create<AdapterCapabilities>({
    http: { fetch: globalThis.fetch.bind(globalThis) },
    socketProbe: { deniedStatus: probeDeniedSocket },
    clock: {
      now: () => new Date(),
      sleep: (milliseconds) =>
        new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
    },
    browser: {
      verify: (relayUrl, repository, expected, triggerLiveEvent) =>
        verifyBrowser(
          accessHeaders,
          relayUrl,
          repository,
          expected,
          triggerLiveEvent,
        ),
    },
    tool: {
      open: (consumer, stateDirectory) =>
        openTool(config, consumer, stateDirectory),
    },
    output: { write: (value) => process.stdout.write(`${value}\n`) },
  });
}

async function probeDeniedSocket(
  relayUrl: string,
  headers: Readonly<Record<string, string>>,
): Promise<
  Readonly<{ status: number; location: string | null | undefined }>
> {
  const url = new URL("/api/events/stream", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return await new Promise<
    Readonly<{ status: number; location: string | null | undefined }>
  >(
    (resolveStatus, reject) => {
      const socket = new WebSocket(url, { headers });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        const location = response.headers.location;
        resolveStatus({
          status: response.statusCode ?? 0,
          location,
        });
      });
      socket.once("open", () => {
        socket.close();
        reject(new Error("Denied WebSocket opened."));
      });
      socket.once("error", reject);
    },
  );
}

async function verifyBrowser(
  headers: Readonly<Record<string, string>>,
  relayUrl: string,
  repository: string,
  expected: ReadonlyArray<Event>,
  triggerLiveEvent: () => Promise<Event>,
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ extraHTTPHeaders: headers });
    const page = await context.newPage();
    await page.goto(relayUrl);
    for (const event of expected) {
      await page.getByLabel("Repository").fill(repository);
      await page.getByLabel("Event type").selectOption(event.type);
      const initial = page.waitForResponse((response) =>
        response.url().includes("/api/events?") && response.request().resourceType() === "fetch");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await initial;
      const later = page.getByRole("button", { name: "Later" });
      while (await later.isEnabled()) {
        const loaded = page.waitForResponse((response) =>
          response.url().includes("/api/events?") &&
          response.request().resourceType() === "fetch");
        await later.click();
        await loaded;
      }
      await page.getByText("Live events connected.").waitFor();
      await page.getByText(event.type, { exact: true }).last().click();
      const payload = await page.getByLabel("Event payload").textContent();
      const marker = JSON.stringify(event.payload).match(/relay-e2e-[^"\\]+/u)?.[0];
      if (marker == null || !payload?.includes(marker)) {
        throw new Error(`Chromium did not display event ${event.id}.`);
      }
    }
    await page.getByLabel("Event type").selectOption("issue_comment");
    const loaded = page.waitForResponse((response) =>
      response.url().includes("/api/events?") &&
      response.request().resourceType() === "fetch");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await loaded;
    while (await page.getByRole("button", { name: "Later" }).isEnabled()) {
      const laterPage = page.waitForResponse((response) =>
        response.url().includes("/api/events?") &&
        response.request().resourceType() === "fetch");
      await page.getByRole("button", { name: "Later" }).click();
      await laterPage;
    }
    await page.getByText("Live events connected.").waitFor();
    const comments = page.getByText("issue_comment", { exact: true });
    const priorCommentCount = await comments.count();
    const live = await triggerLiveEvent();
    await comments.nth(priorCommentCount).waitFor();
    await comments.nth(priorCommentCount).click();
    const livePayload = await page.getByLabel("Event payload").textContent();
    const liveMarker = JSON.stringify(live.payload).match(/relay-e2e-[^"\\]+/u)?.[0];
    if (liveMarker == null || !livePayload?.includes(liveMarker)) {
      throw new Error(`Chromium did not display live event ${live.id}.`);
    }
  } finally {
    await browser.close();
  }
}

async function openTool(
  config: Readonly<{
    accessClientId: string;
    accessClientSecret: string;
    relayUrl: string;
  }>,
  consumer: string,
  stateDirectory: string,
): Promise<ToolSession> {
  const client = new Client({ name: `live-e2e-${consumer}`, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("../..", "plugins/gh-watch/dist/server.mjs")],
    cwd: resolve("../.."),
    env: {
      ...getDefaultEnvironment(),
      GH_WATCH_RELAY_URL: config.relayUrl,
      GH_WATCH_STATE_DIRECTORY: stateDirectory,
      CF_ACCESS_CLIENT_ID: config.accessClientId,
      CF_ACCESS_CLIENT_SECRET: config.accessClientSecret,
    },
    stderr: "inherit",
  });
  await client.connect(transport);
  return {
    watch: async () => {
      const result = await client.callTool({
        name: "watch",
        arguments: {
          consumer,
          filters: {},
          waitMilliseconds: 55_000,
        },
      });
      return parseWatchResult(result.structuredContent);
    },
    acknowledge: async (result) => {
      if (result.type !== "batch") return;
      const response = await client.callTool({
        name: "acknowledge",
        arguments: { acknowledgement: result.acknowledgement },
      });
      if (response.isError === true) throw new Error("Acknowledgement failed.");
    },
    close: () => client.close(),
  };
}

function parseWatchResult(input: unknown): WatchResult {
  if (typeof input !== "object" || input == null || !("type" in input)) {
    throw new Error("The watch tool returned an invalid result.");
  }
  if (input.type === "timeout") return { type: "timeout" };
  if (
    input.type !== "batch" ||
    !("events" in input) ||
    !Array.isArray(input.events) ||
    !("acknowledgement" in input)
  ) {
    throw new Error("The watch tool returned an invalid result.");
  }
  const { acknowledgement } = Parsers.AcknowledgeToolInput.parse({
    acknowledgement: input.acknowledgement,
  });
  return {
    type: "batch",
    events: input.events.map((event) => Parsers.Event.parse(event)),
    acknowledgement,
  };
}
