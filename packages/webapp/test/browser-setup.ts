import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const relayUrl = "http://localhost:18791";
const accessUrl = "http://127.0.0.1:18792";

export default async function setup(): Promise<() => Promise<void>> {
  const keys = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const exported = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  const jwk = {
    alg: "RS256",
    e: required(exported.e),
    kid: "browser-test-key",
    kty: "RSA",
    n: required(exported.n),
    use: "sig",
  } as const;
  const certificates = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await listen(certificates, 18792);

  const token = await accessToken(keys.privateKey);
  process.env.RELAY_BROWSER_URL = relayUrl;
  process.env.RELAY_DIRECT_URL = relayUrl;
  process.env.RELAY_BROWSER_TOKEN = token;
  const persistence = await mkdtemp(join(tmpdir(), "relay-browser-"));
  const relay = startRelay(persistence);
  await waitForRelay(relay);
  const authenticated = await fetch(relayUrl, {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
  if (authenticated.status !== 200) {
    throw new Error(`The test Access token returned ${authenticated.status}.`);
  }
  return async (): Promise<void> => {
    relay.kill("SIGTERM");
    await new Promise<void>((resolve) => certificates.close(() => resolve()));
    await rm(persistence, { force: true, recursive: true });
  };
}

function startRelay(persistence: string): ChildProcess {
  return spawn(
    fileURLToPath(
      new URL("../../relay/node_modules/.bin/wrangler", import.meta.url),
    ),
    [
      "dev", "--config", "packages/relay/test/browser-wrangler.jsonc",
      "--local", "--port", "18791",
      "--persist-to", persistence,
    ],
    { cwd: new URL("../../..", import.meta.url), stdio: "ignore" },
  );
}

async function waitForRelay(relay: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (relay.exitCode != null) throw new Error("The test relay stopped.");
    try {
      const response = await fetch(relayUrl);
      if (response.status === 401) return;
    } catch {
      // The real server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  relay.kill("SIGTERM");
  throw new Error("The test relay did not start.");
}

async function accessToken(
  privateKey: Parameters<typeof webcrypto.subtle.sign>[1],
): Promise<string> {
  const header = encode({ alg: "RS256", kid: "browser-test-key" });
  const payload = encode({
    aud: "test-audience",
    email: "lucaxx@gmail.com",
    exp: Math.floor(Date.now() / 1_000) + 300,
    iss: accessUrl,
    sub: "browser-test-user",
  });
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    data,
  );
  return `${header}.${payload}.${base64Url(signature)}`;
}

function encode(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(value: ArrayBuffer | Uint8Array): string {
  return Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value)
    .toString("base64url");
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function required(value: string | null | undefined): string {
  if (value == null) throw new Error("The RSA key is incomplete.");
  return value;
}
