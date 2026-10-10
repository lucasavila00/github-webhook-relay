export {
  Parsers,
  type AccessJwtHeader,
  type AccessJwtPayload,
  type AccessKeySet,
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
  type NonEmptyString,
  type PublicError,
  type RawEventQuery,
  type StreamMessage,
  type Subscribe,
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

export const DEFAULT_EVENT_LIMIT = 100;
export const MAX_EVENT_LIMIT = 1_000;
const defaultEventLimit = Parsers.EventLimit.parse(DEFAULT_EVENT_LIMIT);

export type NormalizedEventQuery = Readonly<{
  after?: Cursor;
  filters: EventFilters;
  limit: EventLimit;
}>;

export function normalizeEventQuery(query: EventQuery): NormalizedEventQuery {
  return {
    ...(query.after === undefined ? {} : { after: query.after }),
    filters: {
      ...(query.repository === undefined
        ? {}
        : { repository: query.repository }),
      ...(query.type === undefined ? {} : { type: query.type }),
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
    (filters.repository === undefined ||
      event.repository === filters.repository) &&
    (filters.type === undefined || event.type === filters.type)
  );
}
