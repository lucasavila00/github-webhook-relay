import type { NumberFormat, StringFormat } from "@beff/client";

export type AccessJwtHeader = Readonly<{
  alg: "RS256";
  kid: string;
}>;
export type AccessJwtPayload = Readonly<{
  aud: string | ReadonlyArray<string>;
  common_name: string | null | undefined;
  email: string | null | undefined;
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
  repository: string | null | undefined;
  type: EventType | null | undefined;
}>;
export type EventLimit = NumberFormat<"eventLimit">;
export type EventQuery = Readonly<{
  after: Cursor | null | undefined;
  repository: string | null | undefined;
  type: EventType | null | undefined;
  limit: EventLimit | null | undefined;
}>;
export type EventPage = Readonly<{
  events: ReadonlyArray<Event>;
  cursor: Cursor;
  hasMore: boolean;
}>;
export type Subscribe = Readonly<{
  type: "subscribe";
  after: Cursor | null | undefined;
  filters: EventFilters | null | undefined;
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

export type LocalConfig = Readonly<{
  relayUrl: string;
  stateDirectory: string;
  accessClientId: string;
  accessClientSecret: string;
}>;
export type PendingBatch = Readonly<{
  token: string;
  base: Cursor | null | undefined;
  checkpoint: Cursor;
}>;
export type ConsumerState = Readonly<{
  version: 1;
  consumer: string;
  filters: EventFilters;
  acknowledged: Cursor | null | undefined;
  generation: number;
  pending: PendingBatch | null | undefined;
}>;
export type WaitMilliseconds = NumberFormat<"waitMilliseconds">;
export type WatchToolInput = Readonly<{
  consumer: NonEmptyString;
  filters: EventFilters;
  waitMilliseconds: WaitMilliseconds;
}>;
export type AcknowledgeToolInput = Readonly<{
  acknowledgement: Readonly<{ value: NonEmptyString }>;
}>;

export type GitHubActionPayload = Readonly<{
  action: string;
}>;
export type GitHubRepositoryPayload = Readonly<{
  repository: Readonly<{ full_name: string }>;
}>;
export type GitHubPullRequestPayload = Readonly<{
  action: "closed";
  pull_request: Readonly<{ merged: true }>;
  repository: Readonly<{ full_name: string }>;
}>;
export type GitHubPullRequestSelection = Readonly<{
  pull_request: Readonly<{ merged: boolean }>;
}>;
export type RawEventQuery = Readonly<{
  after: string | null | undefined;
  repository: string | null | undefined;
  type: string | null | undefined;
  limit: string | null | undefined;
}>;
export type StreamAttachmentData = Readonly<{
  bytes: number;
  connectionKey: string;
  cursor: string;
  positions: number;
}>;

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
  LocalConfig: LocalConfig;
  ConsumerState: ConsumerState;
  WatchToolInput: WatchToolInput;
  AcknowledgeToolInput: AcknowledgeToolInput;
  GitHubActionPayload: GitHubActionPayload;
  GitHubRepositoryPayload: GitHubRepositoryPayload;
  GitHubPullRequestPayload: GitHubPullRequestPayload;
  GitHubPullRequestSelection: GitHubPullRequestSelection;
  RawEventQuery: RawEventQuery;
  StreamAttachmentData: StreamAttachmentData;
}>({
  stringFormats: {
    nonEmpty: (input: string): boolean => input.length > 0,
  },
  numberFormats: {
    eventLimit: (input: number): boolean =>
      Number.isInteger(input) && input >= 1 && input <= 1_000,
    waitMilliseconds: (input: number): boolean =>
      Number.isInteger(input) && input >= 1 && input <= 55_000,
  },
});
