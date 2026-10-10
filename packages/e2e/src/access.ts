import type { Capabilities } from "@beff/diy/capabilities";
import type { LiveE2eConfig } from "@github-webhook-relay/core";

import type {
  HttpCapability,
  SocketProbeCapability,
} from "./capabilities.ts";
import { accessHeaders } from "./relay.ts";

type AccessCapabilities = HttpCapability | SocketProbeCapability;

export async function verifyDeniedAccess(
  capabilities: Capabilities<AccessCapabilities>,
  config: LiveE2eConfig,
): Promise<void> {
  await expectLoginRedirect(capabilities, config.relayUrl);
  await expectHttpForbidden(capabilities, config.relayUrl, {
    "CF-Access-Client-Id": "invalid",
    "CF-Access-Client-Secret": "invalid",
  });
  await expectSocketLoginRedirect(capabilities, config.relayUrl);
  await expectSocketForbidden(capabilities, config.relayUrl, {
    "CF-Access-Client-Id": "invalid",
    "CF-Access-Client-Secret": "invalid",
  });
  await expectHttpForbidden(capabilities, config.alternateRelayUrl, {});
  await expectSocketForbidden(
    capabilities,
    config.alternateRelayUrl,
    accessHeaders(config),
  );
}

export async function verifyRevokedAccess(
  capabilities: Capabilities<AccessCapabilities>,
  config: LiveE2eConfig,
): Promise<void> {
  const headers = accessHeaders(config);
  await expectHttpForbidden(capabilities, config.relayUrl, headers);
  await expectSocketForbidden(capabilities, config.relayUrl, headers);
}

async function expectLoginRedirect(
  capabilities: Capabilities<HttpCapability>,
  relayUrl: string,
): Promise<void> {
  const response = await capabilities.http.fetch(new URL("/api/events", relayUrl), {
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (
    response.status !== 302 ||
    location === null ||
    !new URL(location).pathname.includes("/cdn-cgi/access/login")
  ) {
    throw new Error(`Access login request returned ${response.status}.`);
  }
}

async function expectHttpForbidden(
  capabilities: Capabilities<HttpCapability>,
  relayUrl: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const response = await capabilities.http.fetch(new URL("/api/events", relayUrl), {
    headers,
    redirect: "manual",
  });
  if (response.status !== 403) {
    throw new Error(`Forbidden HTTP request returned ${response.status}.`);
  }
}

async function expectSocketLoginRedirect(
  capabilities: Capabilities<SocketProbeCapability>,
  relayUrl: string,
): Promise<void> {
  const response = await capabilities.socketProbe.deniedStatus(relayUrl, {});
  if (
    response.status !== 302 ||
    response.location === undefined ||
    !new URL(response.location).pathname.includes("/cdn-cgi/access/login")
  ) {
    throw new Error(`Access WebSocket login returned ${response.status}.`);
  }
}

async function expectSocketForbidden(
  capabilities: Capabilities<SocketProbeCapability>,
  relayUrl: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const response = await capabilities.socketProbe.deniedStatus(relayUrl, headers);
  if (response.status !== 403) {
    throw new Error(`Forbidden WebSocket returned ${response.status}.`);
  }
}
