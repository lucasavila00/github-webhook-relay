import type { Capabilities, Capability } from "@beff/diy/capabilities";
import {
  Parsers,
  type Cursor,
  type EventFilters,
  type StreamMessage,
  type Subscribe,
} from "@github-webhook-relay/core";

import { toEvent, type StoredEventRow } from "./history.ts";
import { cursor } from "./ingestion.ts";

const initialCursor = Parsers.Cursor.parse(cursor("0"));
const maxPositions = 1_000;
const maxBytes = 8 * 1024 * 1024;
const repositoryChunkLength = 16_000;

type StreamAttachment = Readonly<{
  bytes: number;
  connectionKey: string;
  cursor: Cursor;
  positions: number;
}>;

type OpenResult =
  | Readonly<{ kind: "invalid_cursor" }>
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "budget" }>;

export type StreamStore = Readonly<{
  close: (connectionKey: string) => void;
  open: (
    connectionKey: string,
    subscribe: Subscribe,
    visit: (row: StoredEventRow) => boolean,
  ) => OpenResult;
  readEvent: (position: string) => StoredEventRow | null | undefined;
  readFilters: (connectionKey: string) => EventFilters | null | undefined;
}>;

type StreamSockets = Readonly<{
  close: (socket: WebSocket, code: number, reason: string) => void;
  list: () => ReadonlyArray<WebSocket>;
  load: (socket: WebSocket) => unknown;
  save: (socket: WebSocket, attachment: StreamAttachment) => void;
  send: (socket: WebSocket, message: string) => void;
}>;

export type StreamStoreCapability = Capability<"streamStore", StreamStore>;
export type StreamSocketsCapability = Capability<"streamSockets", StreamSockets>;

type StreamCapabilities = StreamStoreCapability | StreamSocketsCapability;

type Delivery = Readonly<{
  attachment: StreamAttachment;
  messages: ReadonlyArray<string>;
  shouldClose: boolean;
}>;

type DeliveryResult =
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "delivery"; delivery: Delivery }>;

export function createStreamStore(
  storage: DurableObjectStorage,
): StreamStore {
  return {
    close: (connectionKey) => storage.transactionSync(() => {
      storage.sql.exec(
        "DELETE FROM subscription_repository_chunks WHERE connection_key = ?",
        connectionKey,
      );
      storage.sql.exec(
        "DELETE FROM subscriptions WHERE connection_key = ?",
        connectionKey,
      );
    }),
    open: (connectionKey, subscribe, visit) => storage.transactionSync(() => {
      const after = parseCursorPosition(subscribe.after ?? initialCursor);
      if (after == null || !hasPosition(storage, after)) {
        return { kind: "invalid_cursor" };
      }
      const filters = subscribe.filters ?? { repository: undefined, type: undefined };
      writeSubscription(storage, connectionKey, filters);
      for (const row of scanRows(storage, after)) {
        if (!visit(row)) return { kind: "budget" };
      }
      return { kind: "complete" };
    }),
    readEvent: (position) => readRows(storage, position, 1, true)[0],
    readFilters: (connectionKey) => readFilters(storage, connectionKey),
  };
}

export function createStreamSockets(
  state: DurableObjectState,
): StreamSockets {
  return {
    close: (socket, code, reason) => socket.close(code, reason),
    list: () => state.getWebSockets(),
    load: (socket) => socket.deserializeAttachment(),
    save: (socket, attachment) => socket.serializeAttachment(attachment),
    send: (socket, message) => socket.send(message),
  };
}

export function initializeStreamStore(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      connection_key TEXT PRIMARY KEY,
      event_type TEXT,
      has_repository INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscription_repository_chunks (
      connection_key TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (connection_key, sequence),
      FOREIGN KEY (connection_key) REFERENCES subscriptions(connection_key)
        ON DELETE CASCADE
    )
  `);
}

export function subscribeToEvents(
  capabilities: Capabilities<StreamCapabilities>,
  socket: WebSocket,
  connectionKey: string,
  message: string | ArrayBuffer,
): void {
  if (parseAttachment(capabilities.streamSockets.load(socket)) != null) {
    closeWithError(
      capabilities,
      socket,
      "invalid_request",
      "Only one subscription is allowed.",
      1008,
      undefined,
    );
    return;
  }
  const subscribe = parseSubscribe(message);
  if (subscribe == null) {
    closeWithError(
      capabilities,
      socket,
      "invalid_request",
      "Invalid subscription.",
      1008,
      undefined,
    );
    return;
  }

  const filters = subscribe.filters ?? { repository: undefined, type: undefined };
  let attachment: StreamAttachment = {
    bytes: 0,
    connectionKey,
    cursor: subscribe.after ?? initialCursor,
    positions: 0,
  };
  const result = capabilities.streamStore.open(connectionKey, subscribe, (row) => {
    const delivery = createDelivery(attachment, row, filters);
    if (delivery.kind === "blocked") return false;
    sendMessages(capabilities, socket, delivery.delivery);
    attachment = delivery.delivery.attachment;
    return !delivery.delivery.shouldClose;
  });
  if (result.kind === "invalid_cursor") {
    closeWithError(
      capabilities,
      socket,
      "invalid_cursor",
      "Unknown cursor.",
      1008,
      undefined,
    );
    return;
  }
  if (result.kind === "budget") {
    closeForReconnect(capabilities, socket, attachment.connectionKey);
    return;
  }
  capabilities.streamSockets.save(socket, attachment);
}

export function publishStoredEvent(
  capabilities: Capabilities<StreamCapabilities>,
  position: string,
): void {
  const row = capabilities.streamStore.readEvent(position);
  if (row == null) return;
  for (const socket of capabilities.streamSockets.list()) {
    let connectionKey: string | null | undefined;
    try {
      const attachment = parseAttachment(capabilities.streamSockets.load(socket));
      if (attachment == null) continue;
      connectionKey = attachment.connectionKey;
      const filters = capabilities.streamStore.readFilters(attachment.connectionKey);
      if (filters == null) {
        closeInternal(capabilities, socket, attachment.connectionKey);
        continue;
      }
      const result = createDelivery(attachment, row, filters);
      if (result.kind === "blocked") {
        closeForReconnect(capabilities, socket, attachment.connectionKey);
        continue;
      }
      sendDelivery(capabilities, socket, result.delivery);
    } catch {
      isolateFailedSocket(capabilities, socket, connectionKey);
    }
  }
}

export function closePendingSubscription(
  capabilities: Capabilities<StreamCapabilities>,
  socket: WebSocket,
): void {
  if (parseAttachment(capabilities.streamSockets.load(socket)) != null) return;
  closeWithError(
    capabilities,
    socket,
    "invalid_request",
    "Subscription required.",
    1008,
    undefined,
  );
}

export function closeStream(
  capabilities: Capabilities<StreamStoreCapability>,
  attachment: unknown,
): void {
  const parsed = parseAttachment(attachment);
  if (parsed != null) capabilities.streamStore.close(parsed.connectionKey);
}

export function failStream(
  capabilities: Capabilities<StreamCapabilities>,
  socket: WebSocket,
): void {
  const attachment = parseAttachment(capabilities.streamSockets.load(socket));
  closeInternal(capabilities, socket, attachment?.connectionKey);
}

export function chunkRepositoryFilter(value: string): ReadonlyArray<string> {
  return Array.from(
    { length: Math.ceil(value.length / repositoryChunkLength) },
    (_, index) => JSON.stringify(
      value.slice(index * repositoryChunkLength, (index + 1) * repositoryChunkLength),
    ),
  );
}

export function joinRepositoryFilter(chunks: ReadonlyArray<string>): string {
  return chunks.map((chunk) => {
    const value: unknown = JSON.parse(chunk);
    if (typeof value !== "string") throw new Error("Invalid repository chunk.");
    return value;
  }).join("");
}

function parseSubscribe(message: string | ArrayBuffer): Subscribe | null | undefined {
  try {
    const text = typeof message === "string"
      ? message
      : new TextDecoder().decode(message);
    const value: unknown = JSON.parse(text);
    const result = Parsers.Subscribe.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function parseAttachment(value: unknown): StreamAttachment | null | undefined {
  const result = Parsers.StreamAttachmentData.safeParse(value);
  if (!result.success) return undefined;
  const cursorResult = Parsers.Cursor.safeParse(result.data.cursor);
  return result.data.connectionKey.length > 0 &&
      Number.isInteger(result.data.bytes) && result.data.bytes >= 0 &&
      Number.isInteger(result.data.positions) && result.data.positions >= 0 &&
      cursorResult.success
    ? {
        bytes: result.data.bytes,
        connectionKey: result.data.connectionKey,
        cursor: cursorResult.data,
        positions: result.data.positions,
      }
    : undefined;
}

function createDelivery(
  attachment: StreamAttachment,
  row: StoredEventRow,
  filters: EventFilters,
): DeliveryResult {
  const matching = matchesFilters(row.repository, row.eventType, filters);
  const eventMessage = matching
    ? encodeMessage({ type: "event", event: toEvent(row) })
    : undefined;
  const checkpoint = Parsers.Cursor.parse(cursor(row.position));
  const checkpointMessage = encodeMessage({ type: "checkpoint", cursor: checkpoint });
  const addedBytes = byteLength(checkpointMessage) +
    (eventMessage == null ? 0 : byteLength(eventMessage));
  const oversizedFirstDelivery = eventMessage != null &&
    attachment.bytes === 0 && addedBytes > maxBytes;
  if (attachment.positions >= maxPositions ||
      (attachment.bytes + addedBytes > maxBytes && !oversizedFirstDelivery)) {
    return { kind: "blocked" };
  }
  const next: StreamAttachment = {
    ...attachment,
    bytes: attachment.bytes + addedBytes,
    cursor: checkpoint,
    positions: attachment.positions + 1,
  };
  return {
    kind: "delivery",
    delivery: {
      attachment: next,
      messages: [
        ...(eventMessage == null ? [] : [eventMessage]),
        checkpointMessage,
      ],
      shouldClose: next.positions >= maxPositions || next.bytes >= maxBytes ||
        oversizedFirstDelivery,
    },
  };
}

function sendDelivery(
  capabilities: Capabilities<StreamCapabilities>,
  socket: WebSocket,
  delivery: Delivery,
): void {
  sendMessages(capabilities, socket, delivery);
  if (delivery.shouldClose) {
    closeForReconnect(capabilities, socket, delivery.attachment.connectionKey);
  }
}

function sendMessages(
  capabilities: Capabilities<StreamSocketsCapability>,
  socket: WebSocket,
  delivery: Delivery,
): void {
  for (const message of delivery.messages) {
    capabilities.streamSockets.send(socket, message);
  }
  capabilities.streamSockets.save(socket, delivery.attachment);
}

function closeWithError(
  capabilities: Capabilities<StreamCapabilities>,
  socket: WebSocket,
  code: "invalid_request" | "invalid_cursor" | "internal_error",
  message: string,
  closeCode: number,
  connectionKey: string | null | undefined,
): void {
  capabilities.streamSockets.send(
    socket,
    encodeMessage({ type: "error", error: { code, message } }),
  );
  if (connectionKey != null) capabilities.streamStore.close(connectionKey);
  capabilities.streamSockets.close(socket, closeCode, message);
}

function closeInternal(
  capabilities: Capabilities<StreamCapabilities>,
  socket: WebSocket,
  connectionKey: string | null | undefined,
): void {
  closeWithError(
    capabilities,
    socket,
    "internal_error",
    "Internal server error.",
    1011,
    connectionKey,
  );
}

function isolateFailedSocket(
  capabilities: Capabilities<StreamCapabilities>,
  socket: WebSocket,
  connectionKey: string | null | undefined,
): void {
  if (connectionKey != null) {
    try {
      capabilities.streamStore.close(connectionKey);
    } catch {
      // The failed socket must not stop delivery to another consumer.
    }
  }
  try {
    capabilities.streamSockets.send(
      socket,
      encodeMessage({
        type: "error",
        error: { code: "internal_error", message: "Internal server error." },
      }),
    );
  } catch {
    // The socket can already reject writes.
  }
  try {
    capabilities.streamSockets.close(socket, 1011, "Internal server error.");
  } catch {
    // The socket can already be closed.
  }
}

function closeForReconnect(
  capabilities: Capabilities<StreamCapabilities>,
  socket: WebSocket,
  connectionKey: string,
): void {
  capabilities.streamStore.close(connectionKey);
  capabilities.streamSockets.close(socket, 1013, "Reconnect to continue.");
}

function encodeMessage(message: StreamMessage): string {
  return JSON.stringify(Parsers.StreamMessage.parse(message));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function matchesFilters(
  repository: string,
  type: string,
  filters: EventFilters,
): boolean {
  return (filters.repository == null || filters.repository === repository) &&
    (filters.type == null || filters.type === type);
}

function writeSubscription(
  storage: DurableObjectStorage,
  connectionKey: string,
  filters: EventFilters,
): void {
  const hasRepository = filters.repository == null ? 0 : 1;
  storage.sql.exec(
    `INSERT INTO subscriptions (connection_key, event_type, has_repository)
     VALUES (?, ?, ?)`,
    connectionKey,
    // oxlint-disable-next-line local/no-nullish-coalesce-noop -- Durable Object SQL bindings do not accept undefined.
    filters.type ?? null,
    hasRepository,
  );
  if (filters.repository == null) return;
  for (const [sequence, value] of chunkRepositoryFilter(filters.repository).entries()) {
    storage.sql.exec(
      `INSERT INTO subscription_repository_chunks
       (connection_key, sequence, value) VALUES (?, ?, ?)`,
      connectionKey,
      sequence,
      value,
    );
  }
}

function readFilters(
  storage: DurableObjectStorage,
  connectionKey: string,
): EventFilters | null | undefined {
  const metadata = storage.sql.exec<{
    // oxlint-disable-next-line local/no-incomplete-nullish-types -- D1 SQL result values cannot be undefined.
    eventType: string | null;
    hasRepository: number;
  }>(
    `SELECT event_type AS eventType, has_repository AS hasRepository
     FROM subscriptions WHERE connection_key = ?`,
    connectionKey,
  ).toArray()[0];
  if (metadata == null) return undefined;
  const chunks = storage.sql.exec<{ value: string }>(
    `SELECT value FROM subscription_repository_chunks
     WHERE connection_key = ? ORDER BY sequence`,
    connectionKey,
  ).toArray().map(({ value }) => value);
  return Parsers.EventFilters.parse({
    type: metadata.eventType,
    repository: metadata.hasRepository === 0
      ? undefined
      : joinRepositoryFilter(chunks),
  });
}

function readRows(
  storage: DurableObjectStorage,
  position: string,
  limit: number,
  exact = false,
): ReadonlyArray<StoredEventRow> {
  return storage.sql.exec<StoredEventRow>(
    `SELECT CAST(position AS TEXT) AS position,
            delivery_id AS deliveryId,
            event_type AS eventType,
            repository,
            received_at AS receivedAt,
            payload
     FROM events
     WHERE position ${exact ? "=" : ">"} ?
     ORDER BY events.position
     LIMIT ?`,
    position,
    limit,
  ).toArray();
}

function scanRows(
  storage: DurableObjectStorage,
  after: string,
): Iterable<StoredEventRow> {
  return storage.sql.exec<StoredEventRow>(
    `SELECT CAST(position AS TEXT) AS position,
            delivery_id AS deliveryId,
            event_type AS eventType,
            repository,
            received_at AS receivedAt,
            payload
     FROM events
     WHERE position > ?
     ORDER BY events.position`,
    after,
  );
}

function parseCursorPosition(value: string): string | null | undefined {
  return /^cursor_(0|[1-9][0-9]*)$/u.exec(value)?.[1];
}

function hasPosition(storage: DurableObjectStorage, position: string): boolean {
  if (position === "0") return true;
  return storage.sql.exec<{ found: number }>(
    "SELECT EXISTS(SELECT 1 FROM events WHERE position = ?) AS found",
    position,
  ).one().found === 1;
}
