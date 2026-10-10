import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Capabilities } from "@beff/diy/capabilities";
import { afterEach, describe, expect, it } from "vitest";

import { createSocketService } from "../src/adapters.ts";
import type { LocalCapabilities } from "../src/capabilities.ts";
import {
  acknowledgeEvents,
  createNodeCapabilities,
  watchEvents,
} from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 20_000);

describe.sequential("local client with the relay Worker", () => {
  it("acknowledges a real batch with a long bounded wait", async () => {
    const fixture = await workerFixture();
    await fixture.send("long-wait", "owner/long-wait");

    const batch = await watchEvents(fixture.capabilities, {
      consumer: "long-wait",
      filters: { repository: "owner/long-wait", type: "issues" },
      waitMilliseconds: 2_147_483_648,
    });

    expect(batch).toMatchObject({
      type: "batch",
      events: [{ deliveryId: "long-wait", payload: { action: "opened" } }],
    });
    if (batch.type !== "batch") return;
    const pending = await readState(fixture.stateDirectory);
    expect(pending).not.toHaveProperty("acknowledged");
    expect(pending).toMatchObject({ pending: { checkpoint: "cursor_1" } });
    await acknowledgeEvents(fixture.capabilities, batch.acknowledgement);
    const acknowledged = await readState(fixture.stateDirectory);
    expect(acknowledged).toMatchObject({ acknowledged: "cursor_1" });
    expect(acknowledged).not.toHaveProperty("pending");
    await expect(watchEvents(fixture.capabilities, {
      consumer: "long-wait",
      filters: { repository: "owner/long-wait", type: "issues" },
      waitMilliseconds: 100,
    })).resolves.toEqual({ type: "timeout" });
  }, 30_000);

  it("repeats a real unacknowledged batch and rejects stale tokens", async () => {
    const fixture = await workerFixture();
    await fixture.send("repeat", "owner/repeat");
    const request = {
      consumer: "repeat",
      filters: { repository: "owner/repeat", type: "issues" as const },
      waitMilliseconds: 5_000,
    };

    const first = await watchEvents(fixture.capabilities, request);
    const restarted = fixture.restartClient();
    const second = await watchEvents(restarted, request);

    expect(first).toMatchObject({ type: "batch", events: [{ id: "event_1" }] });
    expect(second).toMatchObject({ type: "batch", events: [{ id: "event_1" }] });
    if (first.type !== "batch" || second.type !== "batch") return;
    await expect(
      acknowledgeEvents(restarted, first.acknowledgement),
    ).rejects.toMatchObject({ code: "stale_acknowledgement" });
    await acknowledgeEvents(restarted, second.acknowledgement);
    await expect(
      acknowledgeEvents(restarted, second.acknowledgement),
    ).rejects.toMatchObject({ code: "stale_acknowledgement" });
  }, 30_000);

  it("keeps real progress independent for named consumers", async () => {
    const fixture = await workerFixture();
    await fixture.send("independent-a", "owner/independent-a");
    await fixture.send("independent-b", "owner/independent-b");
    const firstA = await nextMatchingBatch(fixture.capabilities, {
      consumer: "first",
      filters: { repository: "owner/independent-a", type: "issues" },
      waitMilliseconds: 5_000,
    });
    const firstB = await nextMatchingBatch(fixture.capabilities, {
      consumer: "first",
      filters: { repository: "owner/independent-b", type: "issues" },
      waitMilliseconds: 5_000,
    });
    const secondA = await nextMatchingBatch(fixture.capabilities, {
      consumer: "second",
      filters: { repository: "owner/independent-a", type: "issues" },
      waitMilliseconds: 5_000,
    });

    expect(firstA.events).toMatchObject([{ deliveryId: "independent-a" }]);
    expect(firstB.events).toMatchObject([{ deliveryId: "independent-b" }]);
    expect(secondA.events).toMatchObject([{ deliveryId: "independent-a" }]);
    const files = (await readdir(fixture.stateDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(files).toHaveLength(3);
  }, 30_000);

  it("times out, cancels, and releases its real consumer lock", async () => {
    const fixture = await workerFixture();
    await expect(watchEvents(fixture.capabilities, {
      consumer: "timeout",
      filters: {},
      waitMilliseconds: 50,
    })).resolves.toEqual({ type: "timeout" });
    const controller = new AbortController();
    const request = {
      consumer: "cancelled",
      filters: {},
      waitMilliseconds: 5_000,
    };
    const active = watchEvents(fixture.capabilities, {
      ...request,
      signal: controller.signal,
    });
    await delay(100);
    await expect(
      watchEvents(fixture.capabilities, request),
    ).rejects.toMatchObject({ code: "in_use" });
    controller.abort();
    await expect(active).rejects.toMatchObject({ code: "cancelled" });
    await expect(watchEvents(fixture.capabilities, {
      ...request,
      waitMilliseconds: 50,
    })).resolves.toEqual({ type: "timeout" });
  }, 30_000);

  it("reconnects after the actual Worker process restarts", async () => {
    const fixture = await workerFixture();
    const pending = watchEvents(fixture.capabilities, {
      consumer: "reconnect",
      filters: { repository: "owner/reconnect", type: "issues" },
      waitMilliseconds: 10_000,
    });
    await delay(300);
    await stopChild(fixture.worker.child);
    const worker = await startWorker(fixture.teamDomain, {
      port: fixture.worker.port,
      persist: fixture.worker.persist,
    });
    expect(await sendWebhook(
      worker.port,
      fixture.token,
      "reconnect",
      "owner/reconnect",
    )).toBe(202);

    await expect(pending).resolves.toMatchObject({
      type: "batch",
      events: [{ deliveryId: "reconnect" }],
    });
  }, 30_000);

  it("reports a real Worker authentication rejection", async () => {
    const fixture = await workerFixture(false);

    const error = await watchEvents(fixture.capabilities, {
      consumer: "authentication",
      filters: {},
      waitMilliseconds: 2_000,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "unauthorized" });
    expect(String((error as Error).message)).not.toContain("service-secret");
  }, 30_000);
});

type WorkerRuntime = Readonly<{
  child: ChildProcess;
  port: number;
  persist: string;
}>;

type WorkerFixture = Readonly<{
  capabilities: ReturnType<typeof createNodeCapabilities>;
  restartClient: () => ReturnType<typeof createNodeCapabilities>;
  send: (delivery: string, repository: string) => Promise<void>;
  stateDirectory: string;
  teamDomain: string;
  token: string;
  worker: WorkerRuntime;
}>;

async function workerFixture(withIdentity = true): Promise<WorkerFixture> {
  const keys = await createSigningKeys();
  const keyServer = await startKeyServer(keys.publicJwk);
  const token = await signAccessToken(keys, {
    aud: "test-audience",
    exp: Math.floor(Date.now() / 1_000) + 60,
    iss: keyServer.url,
    sub: "local-client-test",
  });
  const worker = await startWorker(keyServer.url);
  const stateDirectory = await temporaryDirectory("gh-watch-worker-state-");
  const config = {
    relayUrl: `http://127.0.0.1:${worker.port}`,
    stateDirectory,
    accessClientId: "service-id",
    accessClientSecret: "service-secret",
  };
  const createClient = (): ReturnType<typeof createNodeCapabilities> => {
    const base = createNodeCapabilities(config);
    if (!withIdentity) return base;
    return Capabilities.create<LocalCapabilities>({
      clock: base.clock,
      config: base.config,
      http: base.http,
      network: createSocketService({ "Cf-Access-Jwt-Assertion": token }),
      process: base.process,
      storage: base.storage,
    });
  };
  return {
    capabilities: createClient(),
    restartClient: createClient,
    send: async (delivery, repository) => {
      expect(await sendWebhook(
        worker.port,
        token,
        delivery,
        repository,
      )).toBe(202);
    },
    stateDirectory,
    teamDomain: keyServer.url,
    token,
    worker,
  };
}

async function startWorker(
  teamDomain: string,
  existing?: Readonly<{ port: number; persist: string }>,
): Promise<WorkerRuntime> {
  const port = existing?.port ?? await unusedPort();
  const persist = existing?.persist ?? await temporaryDirectory("gh-watch-worker-");
  const directory = join(process.cwd(), "../relay");
  const child = spawn(
    join(directory, "node_modules/.bin/wrangler"),
    [
      "dev", "--ip", "127.0.0.1", "--port", String(port),
      "--persist-to", persist,
      "--var", "ACCESS_AUD:test-audience",
      "--var", `ACCESS_TEAM_DOMAIN:${teamDomain}`,
      "--var", "RELAY_HOSTNAME:relay.example.com",
      "--var", "WEBHOOK_SECRET:test-secret",
    ],
    {
      cwd: directory,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForWorker(child);
  cleanups.push(async () => stopChild(child));
  return { child, port, persist };
}

async function waitForWorker(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const receive = (value: Buffer): void => {
      output += value.toString("utf8");
      if (output.includes("Ready on http://")) resolve();
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.once("exit", (code) =>
      reject(new Error(`Wrangler stopped before startup with status ${code}.`)),
    );
    child.once("error", () => reject(new Error("Wrangler did not start.")));
  });
}

async function startKeyServer(
  publicJwk: Readonly<Record<string, string>>,
): Promise<Readonly<{ url: string }>> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  const port = await listen(server);
  cleanups.push(async () => closeServer(server));
  return { url: `http://127.0.0.1:${port}` };
}

async function sendWebhook(
  port: number,
  token: string,
  delivery: string,
  repository: string,
): Promise<number> {
  const body = JSON.stringify({
    action: "opened",
    repository: { full_name: repository },
    issue: { number: 1 },
  });
  const signature = createHmac("sha256", "test-secret").update(body).digest("hex");
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/webhooks/github",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Cf-Access-Jwt-Assertion": token,
          "x-github-delivery": delivery,
          "x-github-event": "issues",
          "x-hub-signature-256": `sha256=${signature}`,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end(body);
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
      alg: "RS256", e: jwk.e, kid: "local-client-test-key",
      kty: "RSA", n: jwk.n, use: "sig",
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
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server did not bind to TCP.");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function nextMatchingBatch(
  capabilities: ReturnType<typeof createNodeCapabilities>,
  request: Parameters<typeof watchEvents>[1],
) {
  while (true) {
    const result = await watchEvents(capabilities, request);
    if (result.type !== "batch") throw new Error("Event wait timed out.");
    if (result.events.length > 0) return result;
    await acknowledgeEvents(capabilities, result.acknowledgement);
  }
}

async function readState(directory: string): Promise<Record<string, unknown>> {
  const file = (await readdir(directory)).find((name) => name.endsWith(".json"));
  if (file === undefined) throw new Error("State file was not written.");
  return JSON.parse(await readFile(join(directory, file), "utf8")) as Record<
    string,
    unknown
  >;
}
