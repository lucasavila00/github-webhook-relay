import type { NumberFormat, StringFormat } from "@beff/client";

export type AccessJwtHeader = Readonly<{
  alg: "RS256";
  kid: string;
}>;
export type AccessJwtPayload = Readonly<{
  aud: string | ReadonlyArray<string>;
  common_name?: string;
  email?: string;
  exp: number;
  iss: string;
  sub: string;
}>;
export type AccessKeySet = Readonly<{
  keys: ReadonlyArray<
    Readonly<{
      alg: "RS256";
      e: string;
      kid: string;
      kty: "RSA";
      n: string;
      use: "sig";
    }>
  >;
}>;

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
