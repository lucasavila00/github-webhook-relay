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
import { afterEach, describe, expect, it } from "vitest";

import {
  createEventStore,
  handleRelayRequest,
  type EventRelay,
} from "../src/index.ts";
import type {
  ClockCapability as AccessClockCapability,
  CryptoCapability,
  AccessKeyStoreCapability,
  HttpCapability,
} from "../src/access.ts";
import {
  cursor,
  eventId,
  validateCursor,
  type EventStoreCapability,
} from "../src/ingestion.ts";
import {
  createStreamSockets,
  createStreamStore,
  joinRepositoryFilter,
  publishStoredEvent,
  subscribeToEvents,
  type StreamSocketsCapability,
  type StreamStoreCapability,
} from "../src/stream.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const secret = "test-secret";
const objectName = "github-webhook-relay";

const accessCapabilities = Capabilities.create<
  | AccessClockCapability
  | CryptoCapability
  | AccessKeyStoreCapability
  | HttpCapability
>({
  clock: { now: Date.now },
  crypto: {
    importKey: crypto.subtle.importKey.bind(crypto.subtle),
    verify: crypto.subtle.verify.bind(crypto.subtle),
  },
  accessKeyStore: {
    read: (url: string): Promise<unknown | undefined> =>
      runInDurableObject<EventRelay, unknown | undefined>(
        accessKeyStoreStub(),
        (_instance, state) => state.storage.get(url),
      ),
    write: (url: string, value: unknown): Promise<void> =>
      runInDurableObject<EventRelay, void>(
        accessKeyStoreStub(),
        async (_instance, state) => state.storage.put(url, value),
      ),
  },
  http: { fetch: globalThis.fetch.bind(globalThis) },
});

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

describe.sequential("authenticated event history", () => {
  afterEach(async () => {
    await reset();
  });

  it("requires an authenticated request", async () => {
    const response = await SELF.fetch("https://relay.test/api/events");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
      },
    });
  });

  it("returns stored events in pages and keeps them after reads", async () => {
    await send("issues", "history-1", payload({ action: "opened" }));
    await send(
      "issue_comment",
      "history-2",
      payload({ action: "created", comment: { id: 2 }, issue: { number: 1 } }),
    );
    const access = await createAccessSession();

    const first = await readHistory(access, "?limit=1");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      events: [{
        id: "event_1",
        deliveryId: "history-1",
        type: "issues",
        repository: "owner/repository",
        receivedAt: expect.any(String),
        payload: {
          action: "opened",
          repository: { full_name: "owner/repository" },
        },
      }],
      cursor: "cursor_1",
      hasMore: true,
    });

    const second = await readHistory(access, "?after=cursor_1&limit=1");
    expect(await second.json()).toMatchObject({
      events: [{ id: "event_2", deliveryId: "history-2" }],
      cursor: "cursor_2",
      hasMore: false,
    });

    const repeated = await readHistory(access, "?limit=2");
    expect((await repeated.json() as { events: ReadonlyArray<unknown> }).events)
      .toHaveLength(2);
    expect(await readRows()).toHaveLength(2);
  });

  it("combines filters and does not lose the lookahead event", async () => {
    await send(
      "issues",
      "excluded-repository",
      payload({ action: "opened" }, "other/repository"),
    );
    await send("issues", "matching-1", payload({ action: "opened" }));
    await send(
      "issue_comment",
      "excluded-type",
      payload({ action: "created", comment: { id: 3 }, issue: { number: 1 } }),
    );
    await send("issues", "matching-2", payload({ action: "opened" }));
    const access = await createAccessSession();

    const first = await readHistory(
      access,
      "?repository=owner%2Frepository&type=issues&limit=1",
    );
    expect(await first.json()).toMatchObject({
      events: [{ id: "event_2", deliveryId: "matching-1" }],
      cursor: "cursor_3",
      hasMore: true,
    });

    const second = await readHistory(
      access,
      "?after=cursor_3&repository=owner%2Frepository&type=issues&limit=1",
    );
    expect(await second.json()).toMatchObject({
      events: [{ id: "event_4", deliveryId: "matching-2" }],
      cursor: "cursor_4",
      hasMore: false,
    });
  });

  it("advances an empty filtered page to the end of history", async () => {
    await send("issues", "excluded-1", payload({ action: "opened" }));
    await send("issues", "excluded-2", payload({ action: "opened" }));
    const access = await createAccessSession();

    const response = await readHistory(access, "?repository=other%2Frepository");
    expect(await response.json()).toEqual({
      events: [],
      cursor: "cursor_2",
      hasMore: false,
    });
  });

  it("orders positions numerically after the log reaches two digits", async () => {
    await insertEventFixtures(13);
    const access = await createAccessSession();
    const response = await readHistory(access, "?limit=13");
    const page = await response.json() as {
      events: ReadonlyArray<{ id: string }>;
    };
    expect(page.events.map(({ id }) => id)).toEqual(
      Array.from({ length: 13 }, (_, index) => `event_${index + 1}`),
    );
  });

  it.each([
    ["?limit=0", "invalid_request"],
    ["?limit=1001", "invalid_request"],
    ["?limit=1.5", "invalid_request"],
    ["?limit=value", "invalid_request"],
    ["?type=push", "invalid_request"],
    ["?after=cursor_01", "invalid_cursor"],
    ["?after=cursor_9", "invalid_cursor"],
  ])("rejects invalid input %s", async (query, code) => {
    const access = await createAccessSession();
    const response = await readHistory(access, query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it("keeps consumer cursors independent after stored history survives eviction", async () => {
    await send("issues", "persistent-history-1", payload({ action: "opened" }));
    await evictDurableObject(eventRelayStub());
    const access = await createAccessSession();

    const firstConsumer = await readHistory(access, "?limit=1");
    const secondConsumer = await readHistory(access, "?limit=1");
    expect(await firstConsumer.json()).toMatchObject({ cursor: "cursor_1" });
    expect(await secondConsumer.json()).toMatchObject({ cursor: "cursor_1" });
  });

  it("returns the public error when SQLite fails", async () => {
    await send("issues", "before-history-failure", payload({ action: "opened" }));
    await runInDurableObject<EventRelay, void>(
      eventRelayStub(),
      (_instance, state) => {
        state.storage.sql.exec("DROP TABLE events");
      },
    );
    const access = await createAccessSession();

    const response = await readHistory(access, "");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  });
});

describe.sequential("authenticated event stream", () => {
  afterEach(async () => {
    await reset();
  });

  it("requires authentication before the WebSocket upgrade", async () => {
    const response = await SELF.fetch("https://relay.test/api/events/stream", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("replays filtered history and continues live without a gap", async () => {
    await send(
      "issue_comment",
      "stream-excluded",
      payload({ action: "created", comment: { id: 1 }, issue: { number: 1 } }),
    );
    await send("issues", "stream-replay", payload({ action: "opened" }));
    const socket = await openStream(await createAccessSession());
    const replay = nextMessages(socket, 3);
    socket.send(JSON.stringify({ type: "subscribe", filters: { type: "issues" } }));
    expect(await replay).toMatchObject([
      { type: "checkpoint", cursor: "cursor_1" },
      { type: "event", event: { id: "event_2", deliveryId: "stream-replay" } },
      { type: "checkpoint", cursor: "cursor_2" },
    ]);

    const live = nextMessages(socket, 2);
    await send("issues", "stream-live", payload({ action: "opened" }));
    expect(await live).toMatchObject([
      { type: "event", event: { id: "event_3", deliveryId: "stream-live" } },
      { type: "checkpoint", cursor: "cursor_3" },
    ]);

    const reconnect = await openStream(await createAccessSession());
    const repeated = nextMessages(reconnect, 2);
    reconnect.send(JSON.stringify({ type: "subscribe", after: "cursor_2" }));
    expect(await repeated).toMatchObject([
      { type: "event", event: { id: "event_3", deliveryId: "stream-live" } },
      { type: "checkpoint", cursor: "cursor_3" },
    ]);
    socket.close(1000, "Done.");
    reconnect.close(1000, "Done.");
  });

  it("does not lose an event that arrives while replay starts", async () => {
    await insertEventFixtures(100);
    const socket = await openStream(await createAccessSession());
    const messages = nextMessages(socket, 101);
    socket.send(JSON.stringify({
      type: "subscribe",
      filters: { repository: "no-match" },
    }));
    const delivery = send("issues", "replay-race", payload({ action: "opened" }));
    expect((await delivery).status).toBe(202);
    expect(await messages).toEqual(
      Array.from({ length: 101 }, (_, index) => ({
        type: "checkpoint",
        cursor: `cursor_${index + 1}`,
      })),
    );
    socket.close(1000, "Done.");
  });

  it("keeps simultaneous subscription filters and cursors independent", async () => {
    const access = await createAccessSession();
    const issues = await openStream(access);
    const comments = await openStream(access);
    issues.send(JSON.stringify({ type: "subscribe", filters: { type: "issues" } }));
    comments.send(JSON.stringify({
      type: "subscribe",
      filters: { type: "issue_comment" },
    }));

    const issueMessages = nextMessages(issues, 3);
    const commentMessages = nextMessages(comments, 3);
    await send("issues", "independent-issue", payload({ action: "opened" }));
    await send(
      "issue_comment",
      "independent-comment",
      payload({ action: "created", comment: { id: 2 }, issue: { number: 1 } }),
    );
    expect(await issueMessages).toMatchObject([
      { type: "event", event: { deliveryId: "independent-issue" } },
      { type: "checkpoint", cursor: "cursor_1" },
      { type: "checkpoint", cursor: "cursor_2" },
    ]);
    expect(await commentMessages).toMatchObject([
      { type: "checkpoint", cursor: "cursor_1" },
      { type: "event", event: { deliveryId: "independent-comment" } },
      { type: "checkpoint", cursor: "cursor_2" },
    ]);
    issues.close(1000, "Done.");
    comments.close(1000, "Done.");
    await waitForSubscriptionCount(0);
  });

  it.each([
    [JSON.stringify({ type: "other" }), "invalid_request"],
    [JSON.stringify({ type: "subscribe", after: "cursor_9" }), "invalid_cursor"],
  ])("sends a public error and closes invalid subscription input", async (input, code) => {
    const socket = await openStream(await createAccessSession());
    const message = nextMessages(socket, 1);
    const closed = nextClose(socket);
    socket.send(input);
    expect(await message).toMatchObject([{ type: "error", error: { code } }]);
    expect(await closed).toMatchObject({ code: 1008 });
  });

  it("rejects a second subscription message", async () => {
    const socket = await openStream(await createAccessSession());
    const message = nextMessages(socket, 1);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "subscribe" }));
    socket.send(JSON.stringify({ type: "subscribe" }));
    expect(await message).toEqual([{
      type: "error",
      error: {
        code: "invalid_request",
        message: "Only one subscription is allowed.",
      },
    }]);
    expect(await closed).toMatchObject({ code: 1008 });
    await waitForSubscriptionCount(0);
  });

  it("closes a socket that does not subscribe in ten seconds", async () => {
    const socket = await openStream(await createAccessSession());
    const message = nextMessages(socket, 1, 12_000);
    const closed = nextClose(socket, 12_000);
    expect(await message).toEqual([{
      type: "error",
      error: { code: "invalid_request", message: "Subscription required." },
    }]);
    expect(await closed).toMatchObject({ code: 1008 });
  }, 15_000);

  it("stores and reconstructs every repository filter code unit", async () => {
    const repository = `${"a".repeat(15_999)}😀${"b".repeat(16_000)}\ud800`;
    const socket = await openStream(await createAccessSession());
    socket.send(JSON.stringify({ type: "subscribe", filters: { repository } }));
    const checkpoint = nextMessages(socket, 1);
    await send("issues", "chunk-progress", payload({ action: "opened" }));
    expect(await checkpoint).toEqual([
      { type: "checkpoint", cursor: "cursor_1" },
    ]);
    const chunks = await subscriptionChunks();
    expect(chunks.length).toBeGreaterThan(1);
    expect(joinRepositoryFilter(chunks)).toBe(repository);
    socket.close(1000, "Done.");
  });

  it("continues live delivery after hibernation eviction", async () => {
    const socket = await openStream(await createAccessSession());
    socket.send(JSON.stringify({ type: "subscribe" }));
    const beforeEviction = nextMessages(socket, 2);
    await send("issues", "before-eviction", payload({ action: "opened" }));
    expect(await beforeEviction).toMatchObject([
      { type: "event", event: { id: "event_1" } },
      { type: "checkpoint", cursor: "cursor_1" },
    ]);

    await evictDurableObject(eventRelayStub());
    const afterEviction = nextMessages(socket, 2);
    await send("issues", "after-eviction", payload({ action: "opened" }));
    expect(await afterEviction).toMatchObject([
      { type: "event", event: { id: "event_2" } },
      { type: "checkpoint", cursor: "cursor_2" },
    ]);
    socket.close(1000, "Done.");
  });

  it("streams retained rows larger than the Durable Object memory limit", async () => {
    await insertLargeEventFixtures(65, 2 * 1024 * 1024);
    const socket = await openStream(await createAccessSession());
    const checkpoints = nextMessages(socket, 65, 20_000);
    socket.send(JSON.stringify({
      type: "subscribe",
      filters: { repository: "no-match" },
    }));
    const received = await checkpoints;
    expect(received[64]).toEqual({
      type: "checkpoint",
      cursor: "cursor_65",
    });
    socket.close(1000, "Done.");
  }, 30_000);

  it("closes before a large event that would exceed the byte budget", async () => {
    await insertLargeEventFixtures(2, 5 * 1024 * 1024);
    const socket = await openStream(await createAccessSession());
    const first = nextMessages(socket, 2, 15_000);
    const closed = nextClose(socket, 15_000);
    socket.send(JSON.stringify({ type: "subscribe" }));
    expect(await first).toMatchObject([
      { type: "event", event: { id: "event_1" } },
      { type: "checkpoint", cursor: "cursor_1" },
    ]);
    expect(await closed).toMatchObject({ code: 1013 });

    const reconnect = await openStream(await createAccessSession());
    const replay = nextMessages(reconnect, 2, 15_000);
    reconnect.send(JSON.stringify({ type: "subscribe", after: "cursor_1" }));
    expect(await replay).toMatchObject([
      { type: "event", event: { id: "event_2" } },
      { type: "checkpoint", cursor: "cursor_2" },
    ]);
  }, 30_000);

  it("checkpoints a filtered event before it defers an oversized event", async () => {
    await send(
      "issues",
      "filtered-before-large",
      payload({ action: "opened" }, "other/repository"),
    );
    await insertLargeEventFixtures(1, 8 * 1024 * 1024 - 128, "r");
    const socket = await openStream(await createAccessSession());
    const checkpoint = nextMessages(socket, 1, 20_000);
    const closed = nextClose(socket, 20_000);
    socket.send(JSON.stringify({
      type: "subscribe",
      filters: { repository: "r" },
    }));
    expect(await checkpoint).toEqual([
      { type: "checkpoint", cursor: "cursor_1" },
    ]);
    expect(await closed).toMatchObject({ code: 1013 });

    const reconnect = await openStream(await createAccessSession());
    const replay = nextMessages(reconnect, 2, 20_000);
    reconnect.send(JSON.stringify({
      type: "subscribe",
      after: "cursor_1",
      filters: { repository: "r" },
    }));
    expect(await replay).toMatchObject([
      { type: "event", event: { id: "event_2" } },
      { type: "checkpoint", cursor: "cursor_2" },
    ]);
  }, 30_000);

  it("delivers one retained event larger than the byte budget", async () => {
    await insertLargeEventFixtures(1, 8 * 1024 * 1024 - 128, "r");
    const socket = await openStream(await createAccessSession());
    const messages = nextMessages(socket, 2, 20_000);
    const closed = nextClose(socket, 20_000);
    socket.send(JSON.stringify({ type: "subscribe" }));
    expect(await messages).toMatchObject([
      { type: "event", event: { id: "event_1" } },
      { type: "checkpoint", cursor: "cursor_1" },
    ]);
    expect(await closed).toMatchObject({ code: 1013 });
  }, 30_000);

  it("keeps a healthy consumer live when another socket fails", async () => {
    const access = await createAccessSession();
    const failed = await openStream(access);
    const healthy = await openStream(access);
    failed.send(JSON.stringify({ type: "subscribe" }));
    healthy.send(JSON.stringify({ type: "subscribe" }));

    const failedReady = nextMessages(failed, 2);
    const healthyReady = nextMessages(healthy, 2);
    expect((await send(
      "issues",
      "before-socket-failure",
      payload({ action: "opened" }),
    )).status).toBe(202);
    await Promise.all([failedReady, healthyReady]);

    failed.close(1000, "Disconnect.");
    const delivered = nextMessages(healthy, 2);
    expect((await send(
      "issues",
      "after-socket-failure",
      payload({ action: "opened" }),
    )).status).toBe(202);
    expect(await delivered).toMatchObject([
      { type: "event", event: { deliveryId: "after-socket-failure" } },
      { type: "checkpoint", cursor: "cursor_2" },
    ]);
    expect((await readRows()).map(({ delivery_id }) => delivery_id)).toEqual([
      "before-socket-failure",
      "after-socket-failure",
    ]);
    await waitForSubscriptionCount(1);
    healthy.close(1000, "Done.");
    await waitForSubscriptionCount(0);
  });

  it("contains a real failed socket before it sends to the next socket", async () => {
    const messages = await runInDurableObject<EventRelay, ReadonlyArray<unknown>>(
      eventRelayStub(),
      async (_instance, state) => {
        const failedPair = new WebSocketPair();
        const healthyPair = new WebSocketPair();
        const failedClient = failedPair[0];
        const failedServer = failedPair[1];
        const healthyClient = healthyPair[0];
        const healthyServer = healthyPair[1];
        state.acceptWebSocket(failedServer);
        state.acceptWebSocket(healthyServer);
        failedClient.accept();
        healthyClient.accept();

        const actualSockets = createStreamSockets(state);
        const capabilities = Capabilities.create<
          StreamStoreCapability | StreamSocketsCapability
        >({
          streamStore: createStreamStore(state.storage),
          streamSockets: {
            ...actualSockets,
            list: () => [failedServer, healthyServer],
          },
        });
        subscribeToEvents(
          capabilities,
          failedServer,
          "failed-connection",
          JSON.stringify({ type: "subscribe" }),
        );
        subscribeToEvents(
          capabilities,
          healthyServer,
          "healthy-connection",
          JSON.stringify({ type: "subscribe" }),
        );

        const received = nextMessages(healthyClient, 2);
        failedServer.close(1000, "Failed.");
        const result = createEventStore(state.storage).append({
          deliveryId: "isolated-socket-failure",
          eventType: "issues",
          repository: "owner/repository",
          receivedAt: "2026-10-10T13:00:00Z",
          payload: encoder.encode(payload({ action: "opened" })).buffer,
        });
        publishStoredEvent(capabilities, result.position);
        return received;
      },
    );
    expect(messages).toMatchObject([
      { type: "event", event: { deliveryId: "isolated-socket-failure" } },
      { type: "checkpoint", cursor: "cursor_1" },
    ]);
  });

  it("closes at the position budget and replays the next position", async () => {
    await insertEventFixtures(1_001);
    const socket = await openStream(await createAccessSession());
    const messages = nextMessages(socket, 1_000, 15_000);
    const closed = nextClose(socket, 15_000);
    socket.send(JSON.stringify({
      type: "subscribe",
      filters: { repository: "no-match" },
    }));
    const received = await messages;
    expect(received[999]).toEqual({
      type: "checkpoint",
      cursor: "cursor_1000",
    });
    expect(await closed).toMatchObject({ code: 1013 });

    const reconnect = await openStream(await createAccessSession());
    const resumed = nextMessages(reconnect, 1);
    reconnect.send(JSON.stringify({
      type: "subscribe",
      after: "cursor_1000",
      filters: { repository: "no-match" },
    }));
    expect(await resumed).toEqual([
      { type: "checkpoint", cursor: "cursor_1001" },
    ]);
    reconnect.close(1000, "Done.");
  }, 20_000);
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

function accessKeyStoreStub(): DurableObjectStub<EventRelay> {
  return env.EVENT_RELAY.get(env.EVENT_RELAY.idFromName("access-key-store"));
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

function payload(
  fields: Readonly<Record<string, unknown>>,
  repository = "owner/repository",
): string {
  return JSON.stringify({
    ...fields,
    repository: { full_name: repository },
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

type AccessSession = Readonly<{ token: string }>;

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

async function createAccessSession(): Promise<AccessSession> {
  const keys = await createSigningKeys();
  const keyUrl = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  await accessCapabilities.accessKeyStore.write(keyUrl, {
    keys: [keys.publicJwk],
  });
  return {
    token: await signAccessToken(keys, {
      aud: env.ACCESS_AUD,
      email: "lucaxx@gmail.com",
      exp: Math.floor(Date.now() / 1_000) + 60,
      iss: env.ACCESS_TEAM_DOMAIN,
      sub: "history-test-user",
    }),
  };
}

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
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported.e === undefined || exported.n === undefined) {
    throw new Error("The generated test key is not an RSA key.");
  }
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      alg: "RS256",
      e: exported.e,
      kid: "history-test-key",
      kty: "RSA",
      n: exported.n,
      use: "sig",
    },
  };
}

async function signAccessToken(
  keys: SigningKeys,
  claims: Readonly<Record<string, unknown>>,
): Promise<string> {
  const header = encodeAccessPart({
    alg: "RS256",
    kid: keys.publicJwk.kid,
    typ: "JWT",
  });
  const payloadPart = encodeAccessPart(claims);
  const data = new TextEncoder().encode(`${header}.${payloadPart}`);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    data,
  );
  return `${header}.${payloadPart}.${base64Url(signature)}`;
}

function encodeAccessPart(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(value: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function readHistory(access: AccessSession, query: string): Promise<Response> {
  return handleRelayRequest(
    accessCapabilities,
    {
      accessAudience: env.ACCESS_AUD,
      accessTeamDomain: env.ACCESS_TEAM_DOMAIN,
      relayHostname: env.RELAY_HOSTNAME,
    },
    env.EVENT_RELAY,
    new Request(`https://relay.test/api/events${query}`, {
      headers: { "Cf-Access-Jwt-Assertion": access.token },
    }),
  );
}

async function openStream(access: AccessSession): Promise<WebSocket> {
  const response = await handleRelayRequest(
    accessCapabilities,
    {
      accessAudience: env.ACCESS_AUD,
      accessTeamDomain: env.ACCESS_TEAM_DOMAIN,
      relayHostname: env.RELAY_HOSTNAME,
    },
    env.EVENT_RELAY,
    new Request("https://relay.test/api/events/stream", {
      headers: {
        "Cf-Access-Jwt-Assertion": access.token,
        Upgrade: "websocket",
      },
    }),
  );
  if (response.status !== 101 || response.webSocket === null) {
    throw new Error(`WebSocket upgrade failed with status ${response.status}.`);
  }
  response.webSocket.accept();
  return response.webSocket;
}

function nextMessages(
  socket: WebSocket,
  count: number,
  timeout = 5_000,
): Promise<ReadonlyArray<unknown>> {
  return new Promise((resolve, reject) => {
    let messages: ReadonlyArray<unknown> = [];
    const timer = setTimeout(() => {
      socket.removeEventListener("message", receive);
      reject(new Error(`Received ${messages.length} of ${count} messages.`));
    }, timeout);
    const receive = (event: MessageEvent): void => {
      if (typeof event.data !== "string") {
        clearTimeout(timer);
        reject(new Error("The stream message was not text."));
        return;
      }
      messages = [...messages, JSON.parse(event.data) as unknown];
      if (messages.length === count) {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        resolve(messages);
      }
    };
    socket.addEventListener("message", receive);
  });
}

function nextClose(socket: WebSocket, timeout = 5_000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The stream did not close.")),
      timeout,
    );
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(event);
    }, { once: true });
  });
}

async function subscriptionCount(): Promise<number> {
  return runInDurableObject<EventRelay, number>(
    eventRelayStub(),
    (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM subscriptions",
    ).one().count,
  );
}

async function waitForSubscriptionCount(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await subscriptionCount() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Subscription count did not become ${expected}.`);
}

async function subscriptionChunks(): Promise<ReadonlyArray<string>> {
  return runInDurableObject<EventRelay, ReadonlyArray<string>>(
    eventRelayStub(),
    (_instance, state) => state.storage.sql.exec<{ value: string }>(
      `SELECT value FROM subscription_repository_chunks
       ORDER BY sequence`,
    ).toArray().map(({ value }) => value),
  );
}

async function insertEventFixtures(count: number): Promise<void> {
  await runInDurableObject<EventRelay, void>(
    eventRelayStub(),
    (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let position = 1; position <= count; position += 1) {
          state.storage.sql.exec(
            `INSERT INTO events (
              delivery_id, event_type, repository, received_at, payload
            ) VALUES (?, ?, ?, ?, ?)`,
            `fixture-${position}`,
            "issues",
            "owner/repository",
            "2026-10-10T13:00:00Z",
            encoder.encode(payload({ action: "opened" })).buffer,
          );
        }
      });
    },
  );
}

async function insertLargeEventFixtures(
  count: number,
  payloadBytes: number,
  repository = "owner/repository",
): Promise<void> {
  const padding = "x".repeat(payloadBytes - 14);
  const body = encoder.encode(JSON.stringify({ padding })).buffer;
  await runInDurableObject<EventRelay, void>(
    eventRelayStub(),
    (_instance, state) => {
      for (let position = 1; position <= count; position += 1) {
        state.storage.sql.exec(
          `INSERT INTO events (
            delivery_id, event_type, repository, received_at, payload
          ) VALUES (?, ?, ?, ?, ?)`,
          `large-fixture-${position}`,
          "issues",
          repository,
          "2026-10-10T13:00:00Z",
          body,
        );
      }
    },
  );
}
