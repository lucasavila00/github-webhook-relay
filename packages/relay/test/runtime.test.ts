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
} from "@github-webhook-relay/core";
import { afterEach, describe, expect, it } from "vitest";

import { createEventStore, type EventRelay } from "../src/index.ts";
import {
  cursor,
  eventId,
  validateCursor,
  type EventStoreCapability,
} from "../src/ingestion.ts";

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

    const rejected = await SELF.fetch("https://relay.test/webhooks/github", {
      method: "POST",
      headers: headers("issues", "signature-1", signature),
      body,
    });
    await expectError(rejected, 401, "unauthorized");

    const invalidJson = await SELF.fetch("https://relay.test/webhooks/github", {
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

      const response = await SELF.fetch("https://relay.test/webhooks/github", {
        method: "POST",
        headers: requestHeaders,
        body,
      });
      await expectError(response, 401, "unauthorized");
    },
  );

  it("returns 400 for missing headers or invalid selected fields", async () => {
    const body = payload({ action: "opened" });
    const missingDelivery = await SELF.fetch("https://relay.test/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": await sign(body),
      },
      body,
    });
    await expectError(missingDelivery, 400, "invalid_request");

    const missingEvent = await SELF.fetch("https://relay.test/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": "missing-event-1",
        "x-hub-signature-256": await sign(body),
      },
      body,
    });
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
  return SELF.fetch("https://relay.test/webhooks/github", {
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
