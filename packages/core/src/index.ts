export {
  Parsers,
  type AccessJwtHeader,
  type AccessJwtPayload,
  type AccessKeySet,
  type AcknowledgeToolInput,
  type ConsumerState,
  type Cursor,
  type ErrorCode,
  type Event,
  type EventFilters,
  type EventLimit,
  type EventPage,
  type EventQuery,
  type EventType,
  type GitHubActionPayload,
  type GitHubPullRequestPayload,
  type GitHubPullRequestSelection,
  type GitHubRepositoryPayload,
  type HttpError,
  type LocalConfig,
  type NonEmptyString,
  type PublicError,
  type RawEventQuery,
  type StreamAttachmentData,
  type StreamMessage,
  type Subscribe,
  type WatchToolInput,
  type WaitMilliseconds,
} from "./parser.ts";

import type {
  Cursor,
  Event,
  EventFilters,
  EventLimit,
  EventPage,
  EventQuery,
  EventType,
} from "./parser.ts";
import { Parsers } from "./parser.ts";

export type StoredDelivery = Readonly<{
  deliveryId: string;
  eventType: EventType;
  repository: string;
  receivedAt: string;
  payload: ArrayBuffer;
}>;

export type Acknowledgement = Readonly<{ value: string }>;

export type WatchRequest = Readonly<{
  consumer: string;
  filters: EventFilters;
  waitMilliseconds: number;
  signal: AbortSignal | null | undefined;
}>;

export type WatchResult =
  | Readonly<{
      type: "batch";
      events: ReadonlyArray<Event>;
      acknowledgement: Acknowledgement;
    }>
  | Readonly<{ type: "timeout" }>;

export const DEFAULT_EVENT_LIMIT = 100;
export const MAX_EVENT_LIMIT = 1_000;
const defaultEventLimit = Parsers.EventLimit.parse(DEFAULT_EVENT_LIMIT);

export type NormalizedEventQuery = Readonly<{
  after: Cursor | null | undefined;
  filters: EventFilters;
  limit: EventLimit;
}>;

export function normalizeEventQuery(query: EventQuery): NormalizedEventQuery {
  return {
    after: query.after,
    filters: {
      repository: query.repository,
      type: query.type,
    },
    limit: query.limit ?? defaultEventLimit,
  };
}

export type PositionedEvent = Readonly<{
  cursor: Cursor;
  event: Event;
}>;

export function createEventPage(
  entries: ReadonlyArray<PositionedEvent>,
  initialCursor: Cursor,
  filters: EventFilters,
  limit: EventLimit,
): EventPage {
  let events: ReadonlyArray<Event> = [];
  let cursor = initialCursor;

  for (const entry of entries) {
    if (matchesFilters(entry.event, filters)) {
      if (events.length === limit) {
        return { events, cursor, hasMore: true };
      }
      events = [...events, entry.event];
    }
    cursor = entry.cursor;
  }

  return { events, cursor, hasMore: false };
}

function matchesFilters(event: Event, filters: EventFilters): boolean {
  return (
    (filters.repository == null ||
      event.repository === filters.repository) &&
    (filters.type == null || event.type === filters.type)
  );
}
