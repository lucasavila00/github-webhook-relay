import { env, SELF } from "cloudflare:test";
import { Capabilities } from "@beff/diy";
import { Parsers } from "@github-webhook-relay/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  type AccessKeyStoreCapability,
  type ClockCapability,
  type CryptoCapability,
  type HttpCapability,
  verifyAccessToken,
} from "../src/access.ts";
import { handleRelayRequest } from "../src/index.ts";

type SigningKeys = Readonly<{
  privateKey: CryptoKey;
  publicJwk: Readonly<{
    alg: "RS256";
    e: string;
    kid: string;
    kty: "RSA";
    n: string;
    use: "sig";
  }>;
}>;
const keyId = "test-key";
const keyUrl = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const configuration = {
  accessAudience: env.ACCESS_AUD,
  accessTeamDomain: env.ACCESS_TEAM_DOMAIN,
  githubWebhookSecret: "test-webhook-secret",
  relayHostname: env.RELAY_HOSTNAME,
} as const;

const capabilities = Capabilities.create<
  AccessKeyStoreCapability | ClockCapability | CryptoCapability | HttpCapability
>({
  accessKeyStore: {
    read: async (url: string): Promise<unknown | undefined> => {
      const cache = await caches.open("access-signing-keys");
      const response = await cache.match(url);
      return response === undefined ? undefined : response.json();
    },
    write: async (url: string, value: unknown): Promise<void> => {
      const cache = await caches.open("access-signing-keys");
      await cache.put(
        url,
        Response.json(value, { headers: { "Cache-Control": "max-age=300" } }),
      );
    },
  },
  clock: { now: Date.now },
  crypto: {
    importKey: crypto.subtle.importKey.bind(crypto.subtle),
    verify: crypto.subtle.verify.bind(crypto.subtle),
  },
  http: { fetch: globalThis.fetch.bind(globalThis) },
});

const base64Url = (value: ArrayBuffer | Uint8Array<ArrayBuffer>): string => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const encodeJson = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

const createSigningKeys = async (): Promise<SigningKeys> => {
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
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (
    exported.kty !== "RSA" ||
    exported.e === undefined ||
    exported.n === undefined
  ) {
    throw new Error("The generated test key is not an RSA key.");
  }
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      alg: "RS256",
      e: exported.e,
      kid: keyId,
      kty: "RSA",
      n: exported.n,
      use: "sig",
    },
  };
};

const installKey = async (keys: SigningKeys): Promise<void> => {
  await capabilities.accessKeyStore.write(keyUrl, { keys: [keys.publicJwk] });
};

const signToken = async (
  keys: SigningKeys,
  claims: Readonly<Record<string, unknown>>,
): Promise<string> => {
  const header = encodeJson({ alg: "RS256", kid: keyId, typ: "JWT" });
  const payload = encodeJson(claims);
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, data);
  return `${header}.${payload}.${base64Url(signature)}`;
};

const validClaims = (): Readonly<Record<string, unknown>> => ({
  aud: env.ACCESS_AUD,
  email: "lucaxx@gmail.com",
  exp: Math.floor(Date.now() / 1_000) + 60,
  iss: env.ACCESS_TEAM_DOMAIN,
  sub: "identity-subject",
});

const authenticatedRequest = (url: string, token: string, upgrade = false): Request =>
  new Request(url, {
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      ...(upgrade ? { Upgrade: "websocket" } : {}),
    },
  });

const webhookSignature = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `sha256=${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

beforeEach(async () => {
  const cache = await caches.open("access-signing-keys");
  await cache.delete(keyUrl);
});

describe("relay Access boundary", () => {
  it("rejects a request without an Access assertion", async () => {
    expect((await SELF.fetch("https://relay.example.com/api/events")).status).toBe(401);
  });

  it("accepts a signed identity token", async () => {
    const keys = await createSigningKeys();
    await installKey(keys);
    const token = await signToken(keys, validClaims());
    expect(await verifyAccessToken(capabilities, { audience: env.ACCESS_AUD, teamDomain: env.ACCESS_TEAM_DOMAIN }, [keys.publicJwk], token)).toEqual({ kind: "identity", subject: "identity-subject", email: "lucaxx@gmail.com" });
    expect(await capabilities.accessKeyStore.read(keyUrl)).toBeDefined();
    expect((await handleRelayRequest(capabilities, configuration, authenticatedRequest("https://relay.example.com/api/events", token))).status).toBe(501);
  });

  it("accepts an identity token without an email claim", async () => {
    const keys = await createSigningKeys();
    await installKey(keys);
    const { email: _, ...claims } = validClaims();
    const token = await signToken(keys, claims);
    expect((await handleRelayRequest(capabilities, configuration, authenticatedRequest("https://relay.example.com/api/events", token))).status).toBe(501);
  });

  it("accepts a signed service token without an email or subject", async () => {
    const keys = await createSigningKeys();
    await installKey(keys);
    const token = await signToken(keys, {
      aud: env.ACCESS_AUD,
      common_name: "service-token-client-id",
      exp: Math.floor(Date.now() / 1_000) + 60,
      iss: env.ACCESS_TEAM_DOMAIN,
      sub: "",
    });
    expect((await handleRelayRequest(capabilities, configuration, authenticatedRequest("https://relay.example.com/api/events", token))).status).toBe(501);
  });

  it("rejects a token with a wrong audience", async () => {
    const keys = await createSigningKeys();
    await installKey(keys);
    const token = await signToken(keys, { ...validClaims(), aud: "wrong-audience" });
    expect((await handleRelayRequest(capabilities, configuration, authenticatedRequest("https://relay.example.com/api/events", token))).status).toBe(401);
  });

  it("rejects a token with a wrong issuer or signature", async () => {
    const keys = await createSigningKeys();
    await installKey(keys);
    const wrongIssuer = await signToken(keys, {
      ...validClaims(),
      iss: "https://other-team.cloudflareaccess.com",
    });
    const signed = await signToken(keys, validClaims());
    const separator = signed.lastIndexOf(".");
    const firstSignatureCharacter = signed[separator + 1];
    const invalidSignature = `${signed.slice(0, separator + 1)}${
      firstSignatureCharacter === "A" ? "B" : "A"
    }${signed.slice(separator + 2)}`;

    expect(
      (
        await handleRelayRequest(
          capabilities,
          configuration,
          authenticatedRequest(
            "https://relay.example.com/api/events",
            wrongIssuer,
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleRelayRequest(
          capabilities,
          configuration,
          authenticatedRequest(
            "https://relay.example.com/api/events",
            invalidSignature,
          ),
        )
      ).status,
    ).toBe(401);
  });

  it("rejects an expired token", async () => {
    const keys = await createSigningKeys();
    await installKey(keys);
    const token = await signToken(keys, { ...validClaims(), exp: Math.floor(Date.now() / 1_000) - 1 });
    expect((await handleRelayRequest(capabilities, configuration, authenticatedRequest("https://relay.example.com/api/events", token))).status).toBe(401);
  });

  it("rejects WebSocket access through an alternate hostname", async () => {
    const keys = await createSigningKeys();
    await installKey(keys);
    const token = await signToken(keys, validClaims());
    expect((await handleRelayRequest(capabilities, configuration, authenticatedRequest("https://alternate.example.com/api/events/stream", token, true))).status).toBe(403);
    expect((await handleRelayRequest(capabilities, configuration, authenticatedRequest("https://relay.example.com/api/events/stream", token, true))).status).toBe(501);
  });

  it("exempts only a signed webhook POST on the relay hostname", async () => {
    const body = "{\"zen\":\"test\"}";
    const signature = await webhookSignature(body);
    const request = (url: string, method: string, signed: boolean): Request =>
      new Request(url, method === "POST"
        ? { method, body, ...(signed ? { headers: { "X-Hub-Signature-256": signature } } : {}) }
        : { method, ...(signed ? { headers: { "X-Hub-Signature-256": signature } } : {}) });

    expect((await handleRelayRequest(capabilities, configuration, request("https://relay.example.com/webhooks/github", "POST", true))).status).toBe(501);
    expect((await handleRelayRequest(capabilities, configuration, request("https://relay.example.com/webhooks/github", "POST", false))).status).toBe(401);
    expect((await handleRelayRequest(capabilities, configuration, request("https://alternate.example.com/webhooks/github", "POST", true))).status).toBe(401);
    expect((await handleRelayRequest(capabilities, configuration, request("https://relay.example.com/webhooks/github", "GET", true))).status).toBe(401);
  });

  it("loads the SQLite Durable Object binding", async () => {
    const id = env.EVENT_RELAY.idFromName("runtime-test");
    const response = await env.EVENT_RELAY.get(id).fetch("https://relay.example.com/");
    expect(response.status).toBe(501);
    expect(Parsers.Cursor.parse("runtime-test")).toBe("runtime-test");
  });
});
