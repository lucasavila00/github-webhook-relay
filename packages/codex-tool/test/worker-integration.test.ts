import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, request, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Capabilities } from "@beff/diy/capabilities";
import {
  acknowledgeEvents,
  createNodeCapabilities,
  watchEvents,
} from "@github-webhook-relay/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createSocketService } from "../../local/src/adapters.ts";
import type { LocalCapabilities } from "../../local/src/capabilities.ts";
import type { LocalClientCapability } from "../src/capabilities.ts";
import { createServer } from "../src/server.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("MCP tools with the relay Worker", () => {
  it(
    "repeats, acknowledges, and advances an actual relay batch",
    async () => {
      const keys = await createSigningKeys();
      const keyServer = await startKeyServer(keys.publicJwk);
      const token = await signAccessToken(keys, {
        aud: "test-audience",
        exp: Math.floor(Date.now() / 1_000) + 60,
        iss: keyServer.url,
        sub: "codex-tool-test",
      });
      const worker = await startWorker(keyServer.url);
      const stateDirectory = await temporaryDirectory("gh-watch-tool-state-");
      const base = createNodeCapabilities({
        relayUrl: `http://127.0.0.1:${worker.port}`,
        stateDirectory,
        accessClientId: "service-id",
        accessClientSecret: "service-secret",
      });
      const local = Capabilities.create<LocalCapabilities>({
        clock: base.clock,
        config: base.config,
        http: base.http,
        network: createSocketService({ "Cf-Access-Jwt-Assertion": token }),
        process: base.process,
        storage: base.storage,
      });
      const toolCapabilities = Capabilities.create<LocalClientCapability>({
        localClient: {
          watch: (input) => watchEvents(local, input),
          acknowledge: (value) => acknowledgeEvents(local, value),
        },
      });
      const client = new Client({ name: "worker-test", version: "1.0.0" });
      const server = createServer(toolCapabilities);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      cleanups.push(async () => client.close());
      cleanups.push(async () => server.close());

      const body = JSON.stringify({
        action: "opened",
        repository: { full_name: "owner/repository" },
        issue: { number: 1 },
      });
      expect(await sendWebhook(worker.port, token, body)).toBe(202);

      const watchArguments = {
        consumer: "codex-tool-worker",
        filters: { repository: "owner/repository", type: "issues" },
        waitMilliseconds: 5_000,
      };
      const first = await client.callTool({
        name: "watch",
        arguments: watchArguments,
      });
      expect(first).toMatchObject({
        structuredContent: {
          type: "batch",
          events: [{ deliveryId: "tool-delivery", payload: { action: "opened" } }],
        },
      });

      const second = await client.callTool({
        name: "watch",
        arguments: watchArguments,
      });
      expect(second.structuredContent).toMatchObject({
        type: "batch",
        events: [{ deliveryId: "tool-delivery" }],
      });
      const content = second.structuredContent;
      if (
        content === undefined ||
        content === null ||
        typeof content !== "object" ||
        !("acknowledgement" in content) ||
        typeof content.acknowledgement !== "object" ||
        content.acknowledgement === null
      ) {
        throw new Error("Watch did not return an acknowledgement.");
      }
      const acknowledgement = content.acknowledgement;
      expect(acknowledgement).toEqual(expect.objectContaining({ value: expect.any(String) }));

      const acknowledged = await client.callTool({
        name: "acknowledge",
        arguments: { acknowledgement },
      });
      expect(acknowledged.structuredContent).toEqual({ type: "acknowledged" });

      const next = await client.callTool({
        name: "watch",
        arguments: { ...watchArguments, waitMilliseconds: 100 },
      });
      expect(next.structuredContent).toEqual({ type: "timeout" });
    },
    30_000,
  );
});

async function startWorker(teamDomain: string): Promise<Readonly<{ port: number }>> {
  const port = await unusedPort();
  const persist = await temporaryDirectory("gh-watch-tool-worker-");
  const relayDirectory = join(process.cwd(), "../relay");
  const wrangler = join(relayDirectory, "node_modules/.bin/wrangler");
  const child = spawn(
    wrangler,
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persist,
      "--var",
      "ACCESS_AUD:test-audience",
      "--var",
      `ACCESS_TEAM_DOMAIN:${teamDomain}`,
      "--var",
      "RELAY_HOSTNAME:relay.example.com",
      "--var",
      "WEBHOOK_SECRET:test-secret",
    ],
    {
      cwd: relayDirectory,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForWorker(child, port);
  cleanups.push(async () => stopChild(child));
  return { port };
}

async function waitForWorker(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler stopped before startup with status ${child.exitCode}.`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Wrangler did not start in 10 seconds.");
}

async function startKeyServer(
  publicJwk: Readonly<Record<string, string>>,
): Promise<Readonly<{ url: string }>> {
  const server = createHttpServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  const port = await listen(server);
  cleanups.push(async () => closeServer(server));
  return { url: `http://127.0.0.1:${port}` };
}

async function sendWebhook(port: number, token: string, body: string): Promise<number> {
  const signature = createHmac("sha256", "test-secret").update(body).digest("hex");
  return await new Promise<number>((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/webhooks/github",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Cf-Access-Jwt-Assertion": token,
          "x-github-delivery": "tool-delivery",
          "x-github-event": "issues",
          "x-hub-signature-256": `sha256=${signature}`,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

type SigningKeys = Readonly<{
  privateKey: CryptoKey;
  publicJwk: Readonly<Record<string, string>>;
}>;

async function createSigningKeys(): Promise<SigningKeys> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (jwk.e === undefined || jwk.n === undefined) {
    throw new Error("Generated key is not RSA.");
  }
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      alg: "RS256",
      e: jwk.e,
      kid: "codex-tool-test-key",
      kty: "RSA",
      n: jwk.n,
      use: "sig",
    },
  };
}

async function signAccessToken(
  keys: SigningKeys,
  claims: Readonly<Record<string, unknown>>,
): Promise<string> {
  const header = encodePart({ alg: "RS256", kid: keys.publicJwk.kid });
  const payload = encodePart(claims);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function encodePart(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function unusedPort(): Promise<number> {
  const server = createHttpServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function listen(server: HttpServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server did not bind to TCP.");
  }
  return address.port;
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await closed;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}
