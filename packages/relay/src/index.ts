import { Capabilities } from "@beff/diy";
import { DurableObject } from "cloudflare:workers";

import {
  authenticateAccessRequest,
  type AccessKeyStoreCapability,
  type ClockCapability,
  type CryptoCapability,
  type HttpCapability,
} from "./access.ts";
import { hasValidWebhookSignature } from "./webhook.ts";

declare global {
  interface Env {
    readonly GITHUB_WEBHOOK_SECRET: string;
  }
}

type RuntimeCapability =
  | HttpCapability
  | ClockCapability
  | AccessKeyStoreCapability
  | CryptoCapability;

type RelayConfiguration = Readonly<{
  accessAudience: string;
  accessTeamDomain: string;
  githubWebhookSecret: string;
  relayHostname: string;
}>;

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
): Promise<Response> {
  if (isWebhookRequest(request, configuration)) {
    return (await hasValidWebhookSignature(
      capabilities,
      configuration.githubWebhookSecret,
      request,
    ))
      ? notImplemented()
      : unauthorized();
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

export class EventRelay extends DurableObject<Env> {
  override fetch(): Response {
    return notImplemented();
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRelayRequest(
      createRuntimeCapabilities(),
      {
        accessAudience: env.ACCESS_AUD,
        accessTeamDomain: env.ACCESS_TEAM_DOMAIN,
        githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
        relayHostname: env.RELAY_HOSTNAME,
      },
      request,
    );
  },
} satisfies ExportedHandler<Env>;
