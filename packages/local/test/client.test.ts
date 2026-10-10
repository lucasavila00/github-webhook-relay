import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Parsers, type Subscribe } from "@github-webhook-relay/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import {
  acknowledgeEvents,
  createNodeCapabilities,
  watchEvents,
  type Acknowledgement,
} from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("local event client", () => {
  it("persists a pending batch and advances only for its token", async () => {
    const endpoint = await startRelay((socket, request) => {
      expect(request.headers["cf-access-client-id"]).toBe("client-id");
      expect(request.headers["cf-access-client-secret"]).toBe("client-secret");
      socket.once("message", (value) => {
        const subscribe = JSON.parse(value.toString()) as Subscribe;
        expect(subscribe).toEqual({
          type: "subscribe",
          filters: { repository: "owner/repo" },
        });
        socket.send(JSON.stringify({ type: "event", event }));
        socket.send(JSON.stringify({ type: "checkpoint", cursor: "cursor_1" }));
      });
    });
    const fixture = await clientFixture(endpoint.url);

    const result = await watchEvents(fixture.capabilities, {
      consumer: "review",
      filters: { repository: "owner/repo" },
      waitMilliseconds: 2_000,
    });

    expect(result.type).toBe("batch");
    if (result.type !== "batch") return;
    expect(result.events).toEqual([event]);
    const pending = await readOnlyState(fixture.directory);
    expect(pending).toMatchObject({
      generation: 1,
      pending: { token: "ack_1", checkpoint: "cursor_1" },
    });
    expect(pending).not.toHaveProperty("acknowledged");

    await acknowledgeEvents(fixture.capabilities, result.acknowledgement);
    const acknowledged = await readOnlyState(fixture.directory);
    expect(acknowledged).toMatchObject({
      acknowledged: "cursor_1",
      generation: 1,
    });
    expect(acknowledged).not.toHaveProperty("pending");
    await expect(
      acknowledgeEvents(fixture.capabilities, result.acknowledgement),
    ).rejects.toMatchObject({ code: "stale_acknowledgement" });
  });

  it("repeats an unacknowledged batch and invalidates its old token", async () => {
    const subscriptions: Array<Subscribe> = [];
    const endpoint = await startRelay((socket) => {
      socket.once("message", (value) => {
        subscriptions.push(JSON.parse(value.toString()) as Subscribe);
        socket.send(JSON.stringify({ type: "event", event }));
        socket.send(JSON.stringify({ type: "checkpoint", cursor: "cursor_1" }));
      });
    });
    const fixture = await clientFixture(endpoint.url);
    const request = {
      consumer: "review",
      filters: {},
      waitMilliseconds: 2_000,
    } as const;

    const first = await watchEvents(fixture.capabilities, request);
    const secondCapabilities = createNodeCapabilities(fixture.config);
    const second = await watchEvents(secondCapabilities, request);

    expect(first.type).toBe("batch");
    expect(second.type).toBe("batch");
    expect(subscriptions).toEqual([
      { type: "subscribe" },
      { type: "subscribe" },
    ]);
    if (first.type !== "batch" || second.type !== "batch") return;
    expect(second.events[0]?.id).toBe(first.events[0]?.id);
    await expect(
      acknowledgeEvents(secondCapabilities, first.acknowledgement),
    ).rejects.toMatchObject({ code: "stale_acknowledgement" });
    await acknowledgeEvents(secondCapabilities, second.acknowledgement);
  });

  it("keeps different consumer and filter state independent", async () => {
    const endpoint = await startRelay((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "checkpoint", cursor: "cursor_3" }));
      });
    });
    const fixture = await clientFixture(endpoint.url);

    await watchEvents(fixture.capabilities, {
      consumer: "first",
      filters: { type: "issues" },
      waitMilliseconds: 2_000,
    });
    await watchEvents(fixture.capabilities, {
      consumer: "second",
      filters: { repository: "owner/repo" },
      waitMilliseconds: 2_000,
    });

    const files = (await readdir(fixture.directory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(files).toHaveLength(2);
  });

  it("reconnects after a 1013 close within the original wait", async () => {
    let connections = 0;
    const endpoint = await startRelay((socket) => {
      socket.once("message", () => {
        connections += 1;
        if (connections === 1) {
          socket.close(1013, "Reconnect to continue.");
          return;
        }
        socket.send(JSON.stringify({ type: "event", event }));
        socket.send(JSON.stringify({ type: "checkpoint", cursor: "cursor_1" }));
      });
    });
    const fixture = await clientFixture(endpoint.url);

    const result = await watchEvents(fixture.capabilities, {
      consumer: "review",
      filters: {},
      waitMilliseconds: 2_000,
    });

    expect(result).toMatchObject({ type: "batch", events: [event] });
    expect(connections).toBe(2);
  });

  it("rejects a concurrent call for the same state key", async () => {
    let connected: (() => void) | undefined;
    const connection = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const endpoint = await startRelay((socket) => {
      socket.once("message", () => connected?.());
    });
    const fixture = await clientFixture(endpoint.url);
    const controller = new AbortController();
    const request = {
      consumer: "review",
      filters: {},
      waitMilliseconds: 5_000,
    } as const;
    const first = watchEvents(fixture.capabilities, {
      ...request,
      signal: controller.signal,
    });
    await connection;

    await expect(watchEvents(fixture.capabilities, request)).rejects.toMatchObject({
      code: "in_use",
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
  });

  it("returns timeout and cancellation errors without credentials", async () => {
    const endpoint = await startRelay(() => undefined);
    const fixture = await clientFixture(endpoint.url);
    const timeout = await watchEvents(fixture.capabilities, {
      consumer: "timeout",
      filters: {},
      waitMilliseconds: 20,
    });
    expect(timeout).toEqual({ type: "timeout" });

    const controller = new AbortController();
    const cancelled = watchEvents(fixture.capabilities, {
      consumer: "cancelled",
      filters: {},
      waitMilliseconds: 2_000,
      signal: controller.signal,
    });
    controller.abort();
    const error = await cancelled.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(String((error as Error).message)).not.toContain("client-secret");
  });

  it("rejects unseen acknowledgement values", async () => {
    const fixture = await clientFixture("http://127.0.0.1:1");
    const unseen: Acknowledgement = {
      value: `${"0".repeat(64)}.ack_1`,
    };
    await expect(
      acknowledgeEvents(fixture.capabilities, unseen),
    ).rejects.toMatchObject({ code: "stale_acknowledgement" });
  });

  it("reports an authentication rejection without credentials", async () => {
    const url = await startRejectedRelay(401);
    const fixture = await clientFixture(url);

    const error = await watchEvents(fixture.capabilities, {
      consumer: "authentication",
      filters: {},
      waitMilliseconds: 2_000,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "unauthorized" });
    expect(String((error as Error).message)).not.toContain("client-secret");
  });
});

const event = Parsers.Event.parse({
  id: "event_1",
  deliveryId: "delivery-1",
  type: "issues",
  repository: "owner/repo",
  receivedAt: "2026-10-10T13:00:00Z",
  payload: { action: "opened" },
});

async function clientFixture(relayUrl: string): Promise<Readonly<{
  directory: string;
  config: Readonly<{
    relayUrl: string;
    stateDirectory: string;
    accessClientId: string;
    accessClientSecret: string;
  }>;
  capabilities: ReturnType<typeof createNodeCapabilities>;
}>> {
  const directory = await mkdtemp(join(tmpdir(), "gh-watch-client-"));
  cleanups.push(async () => rm(directory, { recursive: true, force: true }));
  const config = {
    relayUrl,
    stateDirectory: directory,
    accessClientId: "client-id",
    accessClientSecret: "client-secret",
  };
  return { directory, config, capabilities: createNodeCapabilities(config) };
}

async function readOnlyState(directory: string): Promise<Record<string, unknown>> {
  const file = (await readdir(directory)).find((name) => name.endsWith(".json"));
  if (file === undefined) throw new Error("State file was not written.");
  return JSON.parse(await readFile(join(directory, file), "utf8")) as Record<
    string,
    unknown
  >;
}

async function startRelay(
  onConnection: (
    socket: WebSocket,
    request: IncomingMessage,
  ) => void,
): Promise<Readonly<{ url: string }>> {
  const server = createServer();
  const sockets = new Set<WebSocket>();
  const webSockets = new WebSocketServer({ server });
  webSockets.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket, request);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to TCP.");
  }
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    webSockets.close();
    await closeServer(server);
  });
  return { url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function startRejectedRelay(status: number): Promise<string> {
  const server = createServer();
  server.on("upgrade", (_request, socket) => {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Test server did not bind to TCP.");
      }
      resolve(address.port);
    });
  });
  cleanups.push(async () => closeServer(server));
  return `http://127.0.0.1:${port}`;
}
