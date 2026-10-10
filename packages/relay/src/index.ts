import { Capabilities } from "@beff/diy/capabilities";
import { DurableObject } from "cloudflare:workers";

import {
  authenticateAccessRequest,
  type ClockCapability as AccessClockCapability,
  type CryptoCapability,
  type AccessKeyStoreCapability,
  type HttpCapability,
} from "./access.ts";
import {
  createEventHistoryStore,
  getEventHistory,
  type EventHistoryStoreCapability,
} from "./history.ts";
import {
  createCryptography,
  ingestGitHubWebhook,
  type ClockCapability,
  type CryptographyCapability,
  type EventStore,
  type EventStoreCapability,
  type EventPublisherCapability,
  type StoredDelivery,
} from "./ingestion.ts";
import {
  closePendingSubscription,
  closeStream,
  createStreamSockets,
  createStreamStore,
  failStream,
  initializeStreamStore,
  publishStoredEvent,
  subscribeToEvents,
  type StreamSocketsCapability,
  type StreamStoreCapability,
} from "./stream.ts";

type RelayEnv = Env & Readonly<{ WEBHOOK_SECRET: string }>;

type AccessCapability =
  | AccessClockCapability
  | CryptoCapability
  | AccessKeyStoreCapability
  | HttpCapability;

type RelayConfiguration = Readonly<{
  accessAudience: string;
  accessTeamDomain: string;
  relayHostname: string;
}>;

const objectName = "github-webhook-relay";

export class EventRelay extends DurableObject<RelayEnv> {
  readonly #subscriptionTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    initializeEventStore(ctx.storage);
    initializeStreamStore(ctx.storage);
  }

  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      const capabilities = Capabilities.create<
        | CryptographyCapability
        | EventStoreCapability
        | EventPublisherCapability
        | ClockCapability
      >({
        cryptography: createCryptography(this.env.WEBHOOK_SECRET),
        eventStore: createEventStore(this.ctx.storage),
        eventPublisher: {
          publish: (position) => publishStoredEvent(
            this.#streamCapabilities(),
            position,
          ),
        },
        clock: { now: () => new Date().toISOString() },
      });
      return ingestGitHubWebhook(capabilities, request);
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      const capabilities = Capabilities.create<EventHistoryStoreCapability>({
        eventHistoryStore: createEventHistoryStore(this.ctx.storage),
      });
      return Promise.resolve(getEventHistory(capabilities, request));
    }
    if (request.method === "GET" && url.pathname === "/api/events/stream") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Promise.resolve(Response.json(
          { error: { code: "invalid_request", message: "WebSocket required." } },
          { status: 400 },
        ));
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      const timer = setTimeout(() => {
        this.#subscriptionTimers.delete(server);
        closePendingSubscription(this.#streamCapabilities(), server);
      }, 10_000);
      this.#subscriptionTimers.set(server, timer);
      return Promise.resolve(new Response(null, { status: 101, webSocket: client }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const timer = this.#subscriptionTimers.get(socket);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#subscriptionTimers.delete(socket);
    }
    const connectionKey = crypto.randomUUID();
    try {
      subscribeToEvents(
        this.#streamCapabilities(),
        socket,
        connectionKey,
        message,
      );
    } catch {
      createStreamStore(this.ctx.storage).close(connectionKey);
      failStream(this.#streamCapabilities(), socket);
    }
  }

  override webSocketClose(socket: WebSocket): void {
    this.#clearTimer(socket);
    closeStream(
      Capabilities.create<StreamStoreCapability>({
        streamStore: createStreamStore(this.ctx.storage),
      }),
      socket.deserializeAttachment(),
    );
  }

  override webSocketError(socket: WebSocket): void {
    this.#clearTimer(socket);
    closeStream(
      Capabilities.create<StreamStoreCapability>({
        streamStore: createStreamStore(this.ctx.storage),
      }),
      socket.deserializeAttachment(),
    );
  }

  #streamCapabilities(): Capabilities<
    StreamStoreCapability | StreamSocketsCapability
  > {
    return Capabilities.create<StreamStoreCapability | StreamSocketsCapability>({
      streamStore: createStreamStore(this.ctx.storage),
      streamSockets: createStreamSockets(this.ctx),
    });
  }

  #clearTimer(socket: WebSocket): void {
    const timer = this.#subscriptionTimers.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    this.#subscriptionTimers.delete(socket);
  }
}

export function initializeEventStore(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      repository TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload BLOB NOT NULL
    )
  `);
}

export function createEventStore(storage: DurableObjectStorage): EventStore {
  return {
    append: (delivery: StoredDelivery) =>
      storage.transactionSync(() => {
        storage.sql.exec(
          `INSERT INTO events (
            delivery_id, event_type, repository, received_at, payload
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(delivery_id) DO NOTHING`,
          delivery.deliveryId,
          delivery.eventType,
          delivery.repository,
          delivery.receivedAt,
          delivery.payload,
        );
        const inserted = storage.sql.exec<{ changed: number }>(
          "SELECT changes() AS changed",
        ).one().changed === 1;
        const row = storage.sql.exec<{ position: string }>(
          `SELECT CAST(position AS TEXT) AS position
           FROM events
           WHERE delivery_id = ?`,
          delivery.deliveryId,
        ).one();
        return { inserted, position: row.position };
      }),
    hasPosition: (position: string): boolean =>
      storage.sql.exec<{ found: number }>(
        `SELECT EXISTS(
          SELECT 1 FROM events WHERE position = ?
        ) AS found`,
        position,
      ).one().found === 1,
  };
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRelayRequest(
      createAccessCapabilities(),
      {
        accessAudience: env.ACCESS_AUD,
        accessTeamDomain: env.ACCESS_TEAM_DOMAIN,
        relayHostname: env.RELAY_HOSTNAME,
      },
      env.EVENT_RELAY,
      request,
    );
  },
} satisfies ExportedHandler<RelayEnv>;

export async function handleRelayRequest(
  capabilities: Capabilities<AccessCapability>,
  configuration: RelayConfiguration,
  eventRelay: DurableObjectNamespace<EventRelay>,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const webhook = request.method === "POST" &&
    url.hostname === configuration.relayHostname &&
    url.pathname === "/webhooks/github";
  if (!webhook) {
    const principal = await authenticateAccessRequest(
      capabilities,
      {
        audience: configuration.accessAudience,
        teamDomain: configuration.accessTeamDomain,
      },
      request,
    );
    if (principal === undefined) {
      return Response.json(
        {
          error: {
            code: "unauthorized",
            message: "Authentication is required.",
          },
        },
        { status: 401 },
      );
    }
    if (
      request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
      url.hostname !== configuration.relayHostname
    ) {
      return Response.json(
        {
          error: {
            code: "forbidden",
            message: "This endpoint is not available.",
          },
        },
        { status: 403 },
      );
    }
  }
  return eventRelay.get(eventRelay.idFromName(objectName)).fetch(request);
}

function createAccessCapabilities(): Capabilities<AccessCapability> {
  return Capabilities.create<AccessCapability>({
    clock: { now: Date.now },
    crypto: {
      importKey: crypto.subtle.importKey.bind(crypto.subtle),
      verify: crypto.subtle.verify.bind(crypto.subtle),
    },
    accessKeyStore: {
      read: async (url: string): Promise<unknown | undefined> => {
        const cache = await caches.open("access-signing-keys");
        const response = await cache.match(new Request(url));
        return response === undefined ? undefined : response.json();
      },
      write: async (url: string, value: unknown): Promise<void> => {
        const cache = await caches.open("access-signing-keys");
        await cache.put(
          new Request(url),
          Response.json(value, { headers: { "Cache-Control": "max-age=300" } }),
        );
      },
    },
    http: { fetch: globalThis.fetch.bind(globalThis) },
  });
}
