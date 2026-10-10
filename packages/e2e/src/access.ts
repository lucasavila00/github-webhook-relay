import type { Capabilities } from "@beff/diy/capabilities";
import type { LiveE2eConfig } from "@github-webhook-relay/core";
import WebSocket from "ws";

import type { HttpCapability } from "./capabilities.ts";
import { accessHeaders } from "./relay.ts";

export async function verifyDeniedAccess(
  capabilities: Capabilities<HttpCapability>,
  config: LiveE2eConfig,
): Promise<void> {
  await expectHttpDenied(capabilities, config.relayUrl, {});
  await expectHttpDenied(capabilities, config.relayUrl, {
    "CF-Access-Client-Id": "invalid",
    "CF-Access-Client-Secret": "invalid",
  });
  await expectSocketDenied(config.relayUrl, {});
  await expectSocketDenied(config.relayUrl, {
    "CF-Access-Client-Id": "invalid",
    "CF-Access-Client-Secret": "invalid",
  });
  await expectHttpDenied(capabilities, config.alternateRelayUrl, {});
  await expectSocketDenied(
    config.alternateRelayUrl,
    accessHeaders(config),
  );
}

export async function verifyRevokedAccess(
  capabilities: Capabilities<HttpCapability>,
  config: LiveE2eConfig,
): Promise<void> {
  const headers = accessHeaders(config);
  await expectHttpDenied(capabilities, config.relayUrl, headers);
  await expectSocketDenied(config.relayUrl, headers);
}

async function expectHttpDenied(
  capabilities: Capabilities<HttpCapability>,
  relayUrl: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const response = await capabilities.http.fetch(new URL("/api/events", relayUrl), {
    headers,
    redirect: "manual",
  });
  if (response.status < 400) {
    throw new Error(`Denied HTTP request returned ${response.status}.`);
  }
}

async function expectSocketDenied(
  relayUrl: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const url = new URL("/api/events/stream", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      if ((response.statusCode ?? 0) < 400) {
        reject(new Error(`Denied WebSocket returned ${response.statusCode}.`));
      } else {
        resolve();
      }
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("Denied WebSocket opened."));
    });
    socket.once("error", reject);
  });
}
