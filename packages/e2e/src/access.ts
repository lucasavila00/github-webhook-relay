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
  verifyEndpointConfiguration(config);
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
  await expectInvalidWebhookSignature(capabilities, config.webhookUrl, {});
  await expectInvalidWebhookSignature(capabilities, config.webhookUrl, {
    "x-hub-signature-256": "sha256=00",
  });
  const webhookOrigin = new URL(config.webhookUrl).origin;
  await expectNotFound(
    capabilities,
    new URL("/api/events", webhookOrigin),
    accessHeaders(config),
    "GET",
  );
  await expectSocketNotFound(
    capabilities,
    webhookOrigin,
    accessHeaders(config),
  );
  await expectNotFound(
    capabilities,
    new URL("/webhooks/github", config.relayUrl),
    accessHeaders(config),
    "POST",
  );
}

function verifyEndpointConfiguration(config: LiveE2eConfig): void {
  const webhook = new URL(config.webhookUrl);
  const relay = new URL(config.relayUrl);
  if (
    webhook.protocol !== "https:" ||
    webhook.hostname !== config.webhookHostname ||
    webhook.pathname !== "/webhooks/github" ||
    webhook.search !== "" ||
    webhook.hash !== "" ||
    relay.protocol !== "https:" ||
    relay.pathname !== "/" ||
    relay.search !== "" ||
    relay.hash !== "" ||
    webhook.hostname === relay.hostname
  ) {
    throw new Error("The webhook and relay endpoints are invalid.");
  }
}

async function expectInvalidWebhookSignature(
  capabilities: Capabilities<HttpCapability>,
  webhookUrl: string,
  signatureHeaders: Readonly<Record<string, string>>,
): Promise<void> {
  const response = await capabilities.http.fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...signatureHeaders },
    body: "{}",
    redirect: "manual",
  });
  if (response.status !== 401 || response.headers.get("location") != null) {
    throw new Error(`Invalid webhook request returned ${response.status}.`);
  }
}

async function expectNotFound(
  capabilities: Capabilities<HttpCapability>,
  url: URL,
  headers: Readonly<Record<string, string>>,
  method: string,
): Promise<void> {
  const response = await capabilities.http.fetch(url, { headers, method });
  if (response.status !== 404) {
    throw new Error(`Hostname boundary request returned ${response.status}.`);
  }
}

async function expectSocketNotFound(
  capabilities: Capabilities<SocketProbeCapability>,
  relayUrl: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const response = await capabilities.socketProbe.deniedStatus(relayUrl, headers);
  if (response.status !== 404) {
    throw new Error(`Hostname boundary WebSocket returned ${response.status}.`);
  }
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
    location == null ||
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
    response.location == null ||
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
