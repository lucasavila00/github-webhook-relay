import { Capabilities } from "@beff/diy/capabilities";
import type { StoredDelivery } from "@github-webhook-relay/core";
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
} from "./ingestion.ts";

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
  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    initializeEventStore(ctx.storage);
  }

  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      const capabilities = Capabilities.create<
        CryptographyCapability | EventStoreCapability | ClockCapability
      >({
        cryptography: createCryptography(this.env.WEBHOOK_SECRET),
        eventStore: createEventStore(this.ctx.storage),
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
    return Promise.resolve(new Response(null, { status: 404 }));
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
    append: (delivery: StoredDelivery): string =>
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
        const row = storage.sql.exec<{ position: string }>(
          `SELECT CAST(position AS TEXT) AS position
           FROM events
           WHERE delivery_id = ?`,
          delivery.deliveryId,
        ).one();
        return row.position;
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
