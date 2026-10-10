import type { NumberFormat, StringFormat } from "@beff/client";

export type NonEmptyString = StringFormat<"nonEmpty">;
export type Cursor = NonEmptyString;
export type EventType =
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review_comment";
export type Event = Readonly<{
  id: NonEmptyString;
  deliveryId: string;
  type: EventType;
  repository: string;
  receivedAt: string;
  payload: Readonly<Record<string, unknown>>;
}>;
export type EventFilters = Readonly<{
  repository?: string;
  type?: EventType;
}>;
export type EventLimit = NumberFormat<"eventLimit">;
export type EventQuery = Readonly<{
  after?: Cursor;
  repository?: string;
  type?: EventType;
  limit?: EventLimit;
}>;
export type EventPage = Readonly<{
  events: ReadonlyArray<Event>;
  cursor: Cursor;
  hasMore: boolean;
}>;
export type Subscribe = Readonly<{
  type: "subscribe";
  after?: Cursor;
  filters?: EventFilters;
}>;
export type ErrorCode =
  | "invalid_request"
  | "invalid_cursor"
  | "unauthorized"
  | "forbidden"
  | "internal_error";
export type PublicError = Readonly<{
  code: ErrorCode;
  message: string;
}>;
export type HttpError = Readonly<{ error: PublicError }>;
export type StreamMessage =
  | Readonly<{ type: "event"; event: Event }>
  | Readonly<{ type: "checkpoint"; cursor: Cursor }>
  | Readonly<{ type: "error"; error: PublicError }>;

import parse from "./generated/parser";
import type { AccessJwtHeader, AccessJwtPayload, AccessKeySet } from "./index.ts";

export const Parsers = parse.buildParsers<{
  AccessJwtHeader: AccessJwtHeader;
  AccessJwtPayload: AccessJwtPayload;
  AccessKeySet: AccessKeySet;
  Cursor: Cursor;
  Event: Event;
  EventFilters: EventFilters;
  EventLimit: EventLimit;
  EventQuery: EventQuery;
  EventPage: EventPage;
  Subscribe: Subscribe;
  PublicError: PublicError;
  HttpError: HttpError;
  StreamMessage: StreamMessage;
}>({
  stringFormats: {
    nonEmpty: (input: string): boolean => input.length > 0,
  },
  numberFormats: {
    eventLimit: (input: number): boolean =>
      Number.isInteger(input) && input >= 1 && input <= 1_000,
  },
});
