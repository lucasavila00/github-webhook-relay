# Define the event transport contract

Issue: [#8](https://github.com/lucasavila00/github-webhook-relay/issues/8)

## Context

The relay, webapp, and local client need one wire contract for stored events,
history pages, and replay. Filtered consumers must make progress without losing
their position when a stored event does not match their filters.

## Decision

The shared package will export these immutable TypeScript wire types and Beff
parsers for each external input:

```ts
type Cursor = string;
type EventType =
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review_comment";
type Event = Readonly<{
  id: string;
  deliveryId: string;
  type: EventType;
  repository: string;
  receivedAt: string;
  payload: unknown;
}>;
type EventFilters = Readonly<{
  repository?: string;
  type?: EventType;
}>;
type EventPage = Readonly<{
  events: ReadonlyArray<Event>;
  cursor: Cursor;
  hasMore: boolean;
}>;
type Subscribe = Readonly<{
  type: "subscribe";
  after?: Cursor;
  filters?: EventFilters;
}>;
type StreamMessage =
  | Readonly<{ type: "event"; event: Event }>
  | Readonly<{ type: "checkpoint"; cursor: Cursor }>
  | Readonly<{ type: "error"; error: PublicError }>;
type PublicError = Readonly<{ code: ErrorCode; message: string }>;
type ErrorCode = "invalid_request" | "invalid_cursor" | "unauthorized" |
  "forbidden" | "internal_error";
```

Event IDs and cursors are opaque, non-empty strings. A cursor is a durable scan
position in the one ordered event log. An omitted cursor starts before the
first event. A valid cursor remains valid while the log is retained. A cursor
must refer to the initial position or an existing retained log position. The
server returns a cursor for the initial position when it scans no events, so a
client never creates a cursor.

`GET /api/events` accepts `after`, `repository`, `type`, and `limit`. The
default limit is 100 events and the maximum is 1,000. A non-integer limit, or
a limit outside 1 through 1,000, is an `invalid_request` error. Filters use
exact string equality. The server scans after the input cursor, returns at most
`limit` matching events, and sets the output cursor to its last scanned
position. Thus, the cursor can advance across excluded events. `hasMore` is
true only when a later matching event exists at response time. The server can
look ahead to set `hasMore`, but the returned cursor does not advance past an
event that the page does not return.

The stream accepts one `Subscribe` message. It scans stored events after the
cursor and then continues with live events without a gap. It sends matching
events in stored order. It sends a checkpoint after all event messages that
the checkpoint covers. It also sends a checkpoint when only excluded events
advance the scan position. A client saves a checkpoint only after it processes
all prior event messages. Each client stores its own cursor. Reconnects can
repeat events, so clients use event IDs for deduplication.

Invalid HTTP input returns status 400 with `{ "error": PublicError }`. The
application uses 401 or 403 for missing or rejected credentials when the
Cloudflare Access gate forwards the request. Access can reject a request
before it reaches the application. An invalid stream message or cursor sends
a `StreamMessage` error and then closes the connection. Unexpected failures
use status 500 or a stream error with `internal_error`.

## Consequences

- Generated parsers validate the envelope and required fields. They keep the
  GitHub payload as `unknown`, so consumers validate only fields that they use.
- A filtered client does not repeatedly scan excluded events.
- Stream checkpoints use the same cursor semantics as history pages.
