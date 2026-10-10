import {
  env,
  evictDurableObject,
  reset,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { Capabilities } from "@beff/diy/capabilities";
import {
  Parsers,
  type ErrorCode,
} from "@github-webhook-relay/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AccessKeyStoreCapability,
  type ClockCapability,
  type CryptoCapability,
  type HttpCapability,
  verifyAccessToken,
} from "../src/access.ts";
import {
  createEventStore,
  handleRelayRequest,
  type EventRelay,
} from "../src/index.ts";
import {
  cursor,
  eventId,
  validateCursor,
  type EventStoreCapability,
} from "../src/ingestion.ts";

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

  it("routes only the exact webhook POST without Access", async () => {
    const body = "{\"zen\":\"test\"}";
    const request = (url: string, method: string): Request =>
      new Request(url, method === "POST"
        ? { method, body }
        : { method });

    expect((await handleRelayRequest(capabilities, configuration, request("https://relay.example.com/webhooks/github", "POST"))).status).toBe(501);
    expect((await handleRelayRequest(capabilities, configuration, request("https://alternate.example.com/webhooks/github", "POST"))).status).toBe(401);
    expect((await handleRelayRequest(capabilities, configuration, request("https://relay.example.com/webhooks/github", "GET"))).status).toBe(401);
  });

  it("loads the SQLite Durable Object binding", async () => {
    const id = env.EVENT_RELAY.idFromName("runtime-test");
    const response = await env.EVENT_RELAY.get(id).fetch("https://relay.example.com/");
    expect(response.status).toBe(404);
    expect(Parsers.Cursor.parse("runtime-test")).toBe("runtime-test");
  });
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const secret = "test-secret";
const objectName = "github-webhook-relay";

describe.sequential("GitHub webhook ingestion", () => {
  afterEach(async () => {
    await reset();
  });

  it("stores each selected event and ignores other actions", async () => {
    const selected = [
      ["issues", "issue-1", { action: "opened", issue: { number: 1 } }],
      [
        "issue_comment",
        "issue-comment-1",
        { action: "created", issue: { number: 1 }, comment: { id: 1 } },
      ],
      [
        "issue_comment",
        "conversation-comment-1",
        {
          action: "created",
          issue: { number: 2, pull_request: { url: "https://example.test" } },
          comment: { id: 2 },
        },
      ],
      [
        "pull_request_review_comment",
        "inline-comment-1",
        { action: "created", comment: { id: 3 } },
      ],
      [
        "pull_request",
        "pull-request-1",
        { action: "closed", pull_request: { merged: true } },
      ],
    ] as const;

    for (const [event, delivery, fields] of selected) {
      const response = await send(event, delivery, payload(fields));
      expect(response.status).toBe(202);
    }

    expect((await send("issues", "ignored-1", payload({ action: "edited" }))).status)
      .toBe(204);
    expect((await send(
      "pull_request",
      "ignored-2",
      payload({ action: "closed", pull_request: { merged: false } }),
    )).status).toBe(204);
    expect((await send("push", "ignored-3", payload({ action: "created" }))).status)
      .toBe(204);

    const rows = await readRows();
    expect(rows.map(({ event_type }) => event_type)).toEqual([
      "issues",
      "issue_comment",
      "issue_comment",
      "pull_request_review_comment",
      "pull_request",
    ]);
    expect(rows.map(({ position }) => position)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("verifies the exact body before JSON parsing", async () => {
    const body = payload({ action: "opened" });
    const signature = await sign(`${body} `);

    const rejected = await SELF.fetch("https://relay.example.com/webhooks/github", {
      method: "POST",
      headers: headers("issues", "signature-1", signature),
      body,
    });
    await expectError(rejected, 401, "unauthorized");

    const invalidJson = await SELF.fetch("https://relay.example.com/webhooks/github", {
      method: "POST",
      headers: headers("issues", "signature-2", await sign("not-json")),
      body: "not-json",
    });
    await expectError(invalidJson, 400, "invalid_request");
    expect(await readRows()).toEqual([]);
  });

  it.each([undefined, "sha256=bad", `sha256=${"0".repeat(64)}`])(
    "rejects a missing, malformed, or incorrect signature",
    async (signature) => {
      const body = payload({ action: "opened" });
      const requestHeaders = new Headers({
        "x-github-delivery": "unauthorized-1",
        "x-github-event": "issues",
      });
      if (signature !== undefined) requestHeaders.set("x-hub-signature-256", signature);

      const response = await SELF.fetch("https://relay.example.com/webhooks/github", {
        method: "POST",
        headers: requestHeaders,
        body,
      });
      await expectError(response, 401, "unauthorized");
    },
  );

  it("returns 400 for missing headers or invalid selected fields", async () => {
    const body = payload({ action: "opened" });
    const missingDelivery = await SELF.fetch(
      "https://relay.example.com/webhooks/github",
      {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-hub-signature-256": await sign(body),
        },
        body,
      },
    );
    await expectError(missingDelivery, 400, "invalid_request");

    const missingEvent = await SELF.fetch(
      "https://relay.example.com/webhooks/github",
      {
        method: "POST",
        headers: {
          "x-github-delivery": "missing-event-1",
          "x-hub-signature-256": await sign(body),
        },
        body,
      },
    );
    await expectError(missingEvent, 400, "invalid_request");

    const invalidFields = await send(
      "issues",
      "invalid-fields-1",
      JSON.stringify({ action: "opened", repository: {} }),
    );
    await expectError(invalidFields, 400, "invalid_request");
  });

  it("stores original bytes and deduplicates concurrent deliveries", async () => {
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/repository" },
      issue: { number: 9 },
    }, null, 2);

    const responses = await Promise.all(
      Array.from({ length: 12 }, () => send("issues", "duplicate-1", body)),
    );
    expect(responses.every(({ status }) => status === 202)).toBe(true);

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(decoder.decode(rows[0]?.payload)).toBe(body);
  });

  it("keeps events after the Durable Object is evicted", async () => {
    expect((await send("issues", "persistent-1", payload({ action: "opened" }))).status)
      .toBe(202);

    await evictDurableObject(eventRelayStub());

    const rows = await readRows();
    expect(rows.map(({ delivery_id }) => delivery_id)).toEqual(["persistent-1"]);
  });

  it("validates canonical cursors against persisted positions", async () => {
    await send("issues", "cursor-1", payload({ action: "opened" }));
    const results = await runInDurableObject<EventRelay, ReadonlyArray<boolean>>(
      eventRelayStub(),
      (_instance, state) => {
        const capabilities = Capabilities.create<EventStoreCapability>({
          eventStore: createEventStore(state.storage),
        });
        return [
          validateCursor(capabilities, "cursor_0"),
          validateCursor(capabilities, "cursor_1"),
          validateCursor(capabilities, "cursor_2"),
          validateCursor(capabilities, "cursor_01"),
          validateCursor(capabilities, "cursor_-1"),
        ];
      },
    );
    expect(results).toEqual([true, true, false, false, false]);
    expect(eventId("1")).toBe("event_1");
    expect(cursor("1")).toBe("cursor_1");
  });

  it("returns 500 when SQLite storage fails", async () => {
    await send("issues", "before-failure", payload({ action: "opened" }));
    await runInDurableObject<EventRelay, void>(
      eventRelayStub(),
      (_instance, state) => {
        state.storage.sql.exec("DROP TABLE events");
      },
    );

    const response = await send("issues", "storage-failure", payload({ action: "opened" }));
    await expectError(response, 500, "internal_error");
  });
});

type StoredRow = Readonly<{
  position: string;
  delivery_id: string;
  event_type: string;
  payload: ArrayBuffer;
}>;

function eventRelayStub(): DurableObjectStub<EventRelay> {
  return env.EVENT_RELAY.get(env.EVENT_RELAY.idFromName(objectName));
}

async function readRows(): Promise<ReadonlyArray<StoredRow>> {
  return runInDurableObject<EventRelay, ReadonlyArray<StoredRow>>(
    eventRelayStub(),
    (_instance, state) => state.storage.sql.exec<StoredRow>(
      `SELECT CAST(position AS TEXT) AS position,
              delivery_id, event_type, payload
       FROM events
       ORDER BY position`,
    ).toArray(),
  );
}

async function expectError(
  response: Response,
  status: number,
  code: ErrorCode,
): Promise<void> {
  expect(response.status).toBe(status);
  const body = Parsers.HttpError.parse(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
}

function payload(fields: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    ...fields,
    repository: { full_name: "owner/repository" },
  });
}

async function send(event: string, delivery: string, body: string): Promise<Response> {
  return SELF.fetch("https://relay.example.com/webhooks/github", {
    method: "POST",
    headers: headers(event, delivery, await sign(body)),
    body,
  });
}

function headers(event: string, delivery: string, signature: string): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-github-delivery": delivery,
    "x-github-event": event,
    "x-hub-signature-256": signature,
  });
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body)),
  );
  return `sha256=${Array.from(
    signature,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}
