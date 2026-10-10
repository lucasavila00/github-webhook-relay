import type { Capabilities, Capability } from "@beff/diy/capabilities";
import {
  Parsers,
  type RawEventQuery,
  normalizeEventQuery,
  type Cursor,
  type Event,
  type EventFilters,
  type EventLimit,
  type EventPage,
  type EventType,
} from "@github-webhook-relay/core";

import { cursor, eventId } from "./ingestion.ts";

type HistoryQuery = Readonly<{
  after: Cursor;
  filters: EventFilters;
  limit: EventLimit;
}>;

type HistoryResult =
  | Readonly<{ kind: "invalid_cursor" }>
  | Readonly<{ kind: "page"; page: EventPage }>;

export type EventHistoryStore = Readonly<{
  read: (query: HistoryQuery) => HistoryResult;
}>;

export type EventHistoryStoreCapability = Capability<
  "eventHistoryStore",
  EventHistoryStore
>;

type QueryResult =
  | Readonly<{ kind: "invalid_request" }>
  | Readonly<{ kind: "query"; query: HistoryQuery }>;

const invalidRequest = (): Response =>
  Response.json(
    { error: { code: "invalid_request", message: "Invalid event query." } },
    { status: 400 },
  );

const invalidCursor = (): Response =>
  Response.json(
    { error: { code: "invalid_cursor", message: "Unknown cursor." } },
    { status: 400 },
  );

const internalError = (): Response =>
  Response.json(
    { error: { code: "internal_error", message: "Internal server error." } },
    { status: 500 },
  );

export function parseEventHistoryQuery(url: URL): QueryResult {
  const value = rawEventQuery(url.searchParams);
  const rawResult = Parsers.RawEventQuery.safeParse(value);
  if (!rawResult.success) return { kind: "invalid_request" };

  const raw = rawResult.data;
  const limit = raw.limit == null ? undefined : Number(raw.limit);
  const result = Parsers.EventQuery.safeParse({
    after: raw.after,
    repository: raw.repository,
    type: raw.type,
    limit,
  });
  if (!result.success) return { kind: "invalid_request" };

  const normalized = normalizeEventQuery(result.data);
  return {
    kind: "query",
    query: {
      after: normalized.after ?? Parsers.Cursor.parse(cursor("0")),
      filters: normalized.filters,
      limit: normalized.limit,
    },
  };
}

export function getEventHistory(
  capabilities: Capabilities<EventHistoryStoreCapability>,
  request: Request,
): Response {
  const parsed = parseEventHistoryQuery(new URL(request.url));
  if (parsed.kind === "invalid_request") return invalidRequest();

  try {
    const result = capabilities.eventHistoryStore.read(parsed.query);
    return result.kind === "invalid_cursor"
      ? invalidCursor()
      : Response.json(result.page);
  } catch {
    return internalError();
  }
}

export type StoredEventRow = Readonly<{
  deliveryId: string;
  eventType: EventType;
  payload: ArrayBuffer;
  position: string;
  receivedAt: string;
  repository: string;
}>;

export function createEventHistoryStore(
  storage: DurableObjectStorage,
): EventHistoryStore {
  return {
    read: (query) => storage.transactionSync(() => readHistory(storage, query)),
  };
}

function readHistory(
  storage: DurableObjectStorage,
  query: HistoryQuery,
): HistoryResult {
  const after = parseCursorPosition(query.after);
  if (after == null || !hasPosition(storage, after)) {
    return { kind: "invalid_cursor" };
  }

  const rows = selectRows(storage, after, query.filters, query.limit + 1);
  const lookahead = rows[query.limit];
  const cursorPosition = lookahead == null
    ? lastPosition(storage) ?? after
    : lastPositionBefore(storage, lookahead.position) ?? after;
  const events = rows.slice(0, query.limit).map(toEvent);
  return {
    kind: "page",
    page: {
      events,
      cursor: Parsers.Cursor.parse(cursor(cursorPosition)),
      hasMore: lookahead != null,
    },
  };
}

function rawEventQuery(parameters: URLSearchParams): RawEventQuery {
  const after = parameters.get("after");
  const limit = parameters.get("limit");
  const repository = parameters.get("repository");
  const type = parameters.get("type");
  return {
    after,
    limit,
    repository,
    type,
  };
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

function selectRows(
  storage: DurableObjectStorage,
  after: string,
  filters: EventFilters,
  limit: number,
): ReadonlyArray<StoredEventRow> {
  const repositoryClause = filters.repository == null
    ? ""
    : " AND repository = ?";
  const typeClause = filters.type == null ? "" : " AND event_type = ?";
  const parameters = [
    after,
    ...(filters.repository == null ? [] : [filters.repository]),
    ...(filters.type == null ? [] : [filters.type]),
    limit,
  ];
  return storage.sql.exec<StoredEventRow>(
    `SELECT CAST(position AS TEXT) AS position,
            delivery_id AS deliveryId,
            event_type AS eventType,
            repository,
            received_at AS receivedAt,
            payload
     FROM events
     WHERE position > ?${repositoryClause}${typeClause}
     ORDER BY events.position
     LIMIT ?`,
    ...parameters,
  ).toArray();
}

function lastPosition(storage: DurableObjectStorage): string | null | undefined {
  // oxlint-disable-next-line local/no-incomplete-nullish-types -- Durable Object SQL values cannot be undefined.
  return storage.sql.exec<{ position: string | null }>(
    "SELECT CAST(MAX(position) AS TEXT) AS position FROM events",
  ).one().position;
}

function lastPositionBefore(
  storage: DurableObjectStorage,
  before: string,
): string | null | undefined {
  // oxlint-disable-next-line local/no-incomplete-nullish-types -- Durable Object SQL values cannot be undefined.
  return storage.sql.exec<{ position: string | null }>(
    `SELECT CAST(MAX(position) AS TEXT) AS position
     FROM events
     WHERE position < ?`,
    before,
  ).one().position;
}

export function toEvent(row: StoredEventRow): Event {
  const payload: unknown = JSON.parse(new TextDecoder().decode(row.payload));
  return Parsers.Event.parse({
    id: eventId(row.position),
    deliveryId: row.deliveryId,
    type: row.eventType,
    repository: row.repository,
    receivedAt: row.receivedAt,
    payload,
  });
}
