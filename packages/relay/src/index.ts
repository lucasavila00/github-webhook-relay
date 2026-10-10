import { Capabilities } from "@beff/diy/capabilities";
import type { StoredDelivery } from "@github-webhook-relay/core";
import { DurableObject } from "cloudflare:workers";

import {
  createCryptography,
  ingestGitHubWebhook,
  type ClockCapability,
  type CryptographyCapability,
  type EventStore,
  type EventStoreCapability,
} from "./ingestion.ts";

type RelayEnv = Env & Readonly<{ WEBHOOK_SECRET: string }>;

const objectName = "github-webhook-relay";

export class EventRelay extends DurableObject<RelayEnv> {
  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    initializeEventStore(ctx.storage);
  }

  override fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/webhooks/github"
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }

    const capabilities = Capabilities.create<
      CryptographyCapability | EventStoreCapability | ClockCapability
    >({
      cryptography: createCryptography(this.env.WEBHOOK_SECRET),
      eventStore: createEventStore(this.ctx.storage),
      clock: { now: () => new Date().toISOString() },
    });
    return ingestGitHubWebhook(capabilities, request);
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
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/webhooks/github"
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return env.EVENT_RELAY.get(env.EVENT_RELAY.idFromName(objectName)).fetch(request);
  },
} satisfies ExportedHandler<RelayEnv>;
