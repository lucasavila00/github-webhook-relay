import type { Capabilities, Capability } from "@beff/diy/capabilities";
import { Parsers, type Cursor, type EventFilters, type EventPage, type StreamMessage, type Subscribe } from "@github-webhook-relay/core";

export type HttpCapability = Capability<"http", Readonly<{ fetch: typeof globalThis.fetch }>>;
export type ClockCapability = Capability<"clock", Readonly<{ delay: (milliseconds: number) => Promise<void> }>>;
type Socket = Readonly<{
  close: () => void;
  send: (value: string) => void;
  addEventListener: (type: "open" | "message" | "close" | "error", listener: (event: Event | MessageEvent) => void) => void;
}>;
export type SocketCapability = Capability<"socket", Readonly<{ open: (url: string) => Socket }>>;

export async function loadEventPage(
  capabilities: Capabilities<HttpCapability>,
  filters: EventFilters,
  after?: Cursor,
): Promise<EventPage> {
  const query = new URLSearchParams({ limit: "25" });
  if (after !== undefined) query.set("after", after);
  if (filters.repository !== undefined) query.set("repository", filters.repository);
  if (filters.type !== undefined) query.set("type", filters.type);
  const response = await capabilities.http.fetch(`/api/events?${query}`);
  const input: unknown = await response.json();
  if (!response.ok) {
    const error = Parsers.HttpError.safeParse(input);
    throw new Error(error.success ? error.data.error.message : "Request failed.");
  }
  const page = Parsers.EventPage.safeParse(input);
  if (!page.success) throw new Error("The server returned an invalid event page.");
  return page.data;
}

export function openEventStream(
  capabilities: Capabilities<SocketCapability>,
  filters: EventFilters,
  after: Cursor,
  handlers: Readonly<{
    opened: () => void;
    message: (message: StreamMessage) => void;
    closed: () => void;
  }>,
): () => void {
  const socket = capabilities.socket.open("/api/events/stream");
  socket.addEventListener("open", () => {
    const subscription: Subscribe = { type: "subscribe", after, filters };
    socket.send(JSON.stringify(subscription));
    handlers.opened();
  });
  socket.addEventListener("message", (event) => {
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
    const parsed = Parsers.StreamMessage.safeParse(JSON.parse(event.data) as unknown);
    if (parsed.success) handlers.message(parsed.data);
  });
  socket.addEventListener("close", handlers.closed);
  socket.addEventListener("error", handlers.closed);
  return (): void => socket.close();
}

export async function waitToReconnect(
  capabilities: Capabilities<ClockCapability>,
): Promise<void> {
  await capabilities.clock.delay(1_000);
}
