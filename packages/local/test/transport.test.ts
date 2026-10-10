import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  acknowledgeEvents,
  createNodeCapabilities,
  type Acknowledgement,
} from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("local transport and acknowledgement input", () => {
  it("sends Access service-token headers on a real socket upgrade", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ server });
    const received = new Promise<void>((resolve) => {
      webSockets.once("connection", (socket, request) => {
        expect(request.headers["cf-access-client-id"]).toBe("client-id");
        expect(request.headers["cf-access-client-secret"]).toBe("client-secret");
        socket.close();
        resolve();
      });
    });
    const url = await listen(server);
    cleanups.push(async () => {
      webSockets.close();
      await closeServer(server);
    });
    const capabilities = await clientCapabilities(url);
    const socket = await capabilities.network.connect(
      `${url.replace("http:", "ws:")}/api/events/stream`,
      { clientId: "client-id", clientSecret: "client-secret" },
      new AbortController().signal,
    );

    await received;
    socket.close();
  });

  it("maps a real rejected upgrade without credential leakage", async () => {
    const server = createServer();
    server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 401 Rejected\r\nConnection: close\r\n\r\n");
    });
    const url = await listen(server);
    cleanups.push(async () => closeServer(server));
    const capabilities = await clientCapabilities(url);

    const error = await capabilities.network.connect(
      `${url.replace("http:", "ws:")}/api/events/stream`,
      { clientId: "client-id", clientSecret: "client-secret" },
      new AbortController().signal,
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "unauthorized" });
    expect(String((error as Error).message)).not.toContain("client-secret");
  });

  it("rejects an unseen acknowledgement from real local storage", async () => {
    const capabilities = await clientCapabilities("http://127.0.0.1:1");
    const unseen: Acknowledgement = {
      value: `${"0".repeat(64)}.ack_1`,
    };

    await expect(
      acknowledgeEvents(capabilities, unseen),
    ).rejects.toMatchObject({ code: "stale_acknowledgement" });
  });
});

async function clientCapabilities(relayUrl: string) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "gh-watch-transport-"));
  cleanups.push(async () => rm(stateDirectory, { recursive: true, force: true }));
  return createNodeCapabilities({
    relayUrl,
    stateDirectory,
    accessClientId: "client-id",
    accessClientSecret: "client-secret",
  });
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server did not bind to TCP.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}
