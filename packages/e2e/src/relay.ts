import type { Capabilities } from "@beff/diy/capabilities";
import {
  Parsers,
  type Event,
  type EventPage,
  type LiveE2eConfig,
} from "@github-webhook-relay/core";

import type { ClockCapability, HttpCapability } from "./capabilities.ts";

type RelayCapabilities = ClockCapability | HttpCapability;

export async function waitForEvents(
  capabilities: Capabilities<RelayCapabilities>,
  config: LiveE2eConfig,
  marker: string,
): Promise<ReadonlyArray<Event>> {
  const deadline = capabilities.clock.now().getTime() + 120_000;
  while (capabilities.clock.now().getTime() < deadline) {
    const events = await readAllEvents(capabilities, config);
    const selected = events.filter(({ payload }) =>
      JSON.stringify(payload).includes(marker));
    if (new Set(selected.map(({ type }) => type)).size === 4) return selected;
    await capabilities.clock.sleep(2_000);
  }
  throw new Error("All four GitHub events did not reach the relay in two minutes.");
}

export async function waitForEvent(
  capabilities: Capabilities<RelayCapabilities>,
  config: LiveE2eConfig,
  marker: string,
): Promise<Event> {
  const deadline = capabilities.clock.now().getTime() + 120_000;
  while (capabilities.clock.now().getTime() < deadline) {
    const event = (await readAllEvents(capabilities, config))
      .find(({ payload }) => JSON.stringify(payload).includes(marker));
    if (event != null) return event;
    await capabilities.clock.sleep(2_000);
  }
  throw new Error("The live GitHub event did not reach the relay in two minutes.");
}

export async function readAllEvents(
  capabilities: Capabilities<HttpCapability>,
  config: LiveE2eConfig,
): Promise<ReadonlyArray<Event>> {
  let events: ReadonlyArray<Event> = [];
  let after: string | null | undefined;
  for (;;) {
    const url = new URL("/api/events", config.relayUrl);
    url.searchParams.set("repository", config.githubRepository);
    url.searchParams.set("limit", "1000");
    if (after != null) url.searchParams.set("after", after);
    const response = await capabilities.http.fetch(url, {
      headers: accessHeaders(config),
    });
    if (!response.ok) throw new Error(`Relay history failed with ${response.status}.`);
    const page: EventPage = Parsers.EventPage.parse(await response.json());
    events = [...events, ...page.events];
    if (!page.hasMore) return events;
    after = page.cursor;
  }
}

export function accessHeaders(
  config: LiveE2eConfig,
): Readonly<Record<string, string>> {
  return {
    "CF-Access-Client-Id": config.accessClientId,
    "CF-Access-Client-Secret": config.accessClientSecret,
  };
}
