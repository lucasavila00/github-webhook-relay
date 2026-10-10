import { Capabilities } from "@beff/diy/capabilities";
import { DurableObject } from "cloudflare:workers";

import {
  authenticateAccessRequest,
  type AccessKeyStoreCapability,
  type ClockCapability as AccessClockCapability,
  type CryptoCapability,
  type HttpCapability,
} from "./access.ts";
import {
  createCryptography,
  ingestGitHubWebhook,
  type ClockCapability,
  type CryptographyCapability,
  type EventStore,
  type EventStoreCapability,
  type StoredDelivery,
} from "./ingestion.ts";

type RelayEnv = Env & Readonly<{ WEBHOOK_SECRET: string }>;

type RuntimeCapability =
  | HttpCapability
  | AccessClockCapability
  | AccessKeyStoreCapability
  | CryptoCapability;

type RelayConfiguration = Readonly<{
  accessAudience: string;
  accessTeamDomain: string;
  relayHostname: string;
}>;

type WebhookHandler = (request: Request) => Promise<Response>;

const objectName = "github-webhook-relay";
const notImplemented = (): Response => new Response(null, { status: 501 });

const unauthorized = (): Response =>
  Response.json(
    { error: { code: "unauthorized", message: "Authentication is required." } },
    { status: 401 },
  );

const forbidden = (): Response =>
  Response.json(
    { error: { code: "forbidden", message: "This endpoint is not available." } },
    { status: 403 },
  );

const isWebhookRequest = (
  request: Request,
  configuration: RelayConfiguration,
): boolean => {
  const url = new URL(request.url);
  return (
    request.method === "POST" &&
    url.hostname === configuration.relayHostname &&
    url.pathname === "/webhooks/github"
  );
};

const isWebSocketUpgrade = (request: Request): boolean =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";

export async function handleRelayRequest(
  capabilities: Capabilities<RuntimeCapability>,
  configuration: RelayConfiguration,
  request: Request,
  handleWebhook: WebhookHandler = async () => notImplemented(),
): Promise<Response> {
  if (isWebhookRequest(request, configuration)) {
    return handleWebhook(request);
  }

  const principal = await authenticateAccessRequest(
    capabilities,
    {
      audience: configuration.accessAudience,
      teamDomain: configuration.accessTeamDomain,
    },
    request,
  );
  if (principal === undefined) return unauthorized();
  if (
    isWebSocketUpgrade(request) &&
    new URL(request.url).hostname !== configuration.relayHostname
  ) {
    return forbidden();
  }
  return notImplemented();
}

const createRuntimeCapabilities = (): Capabilities<RuntimeCapability> =>
  Capabilities.create<RuntimeCapability>({
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
    const webhook = (webhookRequest: Request): Promise<Response> =>
      env.EVENT_RELAY.get(env.EVENT_RELAY.idFromName(objectName)).fetch(
        webhookRequest,
      );
    return handleRelayRequest(
      createRuntimeCapabilities(),
      {
        accessAudience: env.ACCESS_AUD,
        accessTeamDomain: env.ACCESS_TEAM_DOMAIN,
        relayHostname: env.RELAY_HOSTNAME,
      },
      request,
      webhook,
    );
  },
} satisfies ExportedHandler<RelayEnv>;
