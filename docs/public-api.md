# Public API

The relay keeps GitHub events in one ordered log. It retains the original
GitHub payload and delivers stored events in log order.

## Events

An event has this JSON shape:

```json
{
  "id": "42",
  "deliveryId": "github-delivery-id",
  "type": "issues",
  "repository": "owner/repository",
  "receivedAt": "2026-10-10T13:00:00Z",
  "payload": {}
}
```

`id` is a non-empty opaque string. `payload` is the original GitHub JSON
object. The shared validator requires the object but does not inspect its
fields. Consumers must validate the payload fields that they use.

The `type` value is one of:

- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review_comment`

## Event history

`GET /api/events` accepts these optional query parameters:

| Parameter | Value |
| --- | --- |
| `after` | A non-empty opaque cursor |
| `repository` | A repository name for exact equality filtering |
| `type` | One supported event type for exact equality filtering |
| `limit` | An integer from 1 through 1,000 |

The default limit is 100. The HTTP adapter converts the query text to the
shared typed query. It rejects an unknown event type, a non-numeric or
non-integer limit, and a limit outside the supported range.

The response has this shape:

```json
{
  "events": [],
  "cursor": "42",
  "hasMore": false
}
```

The server scans after the input cursor and returns at most `limit` matching
events. The response cursor is the last scanned log position. It can advance
across events that filters exclude. `hasMore` is true only when a later
matching event exists when the server makes the response.

The server can look ahead to find a later matching event. The response cursor
can include excluded events from this look-ahead. It does not include a
matching event that the response does not return.

A cursor is a durable scan position in the log. An omitted cursor starts
before the first event. A valid cursor refers to the initial position or to a
retained log position. The server returns the initial-position cursor when it
scans no events. Clients do not create cursor values.

## Event stream

`GET /api/events/stream` upgrades to a WebSocket connection. The client sends
one subscription message:

```json
{
  "type": "subscribe",
  "after": "42",
  "filters": {
    "repository": "owner/repository",
    "type": "issues"
  }
}
```

`after` and `filters` are optional. The server replays stored events after the
cursor and then sends live events without a gap. It sends matching events in
stored order. Event messages have this shape:

```json
{
  "type": "event",
  "event": {
    "id": "43",
    "deliveryId": "delivery-id",
    "type": "issues",
    "repository": "owner/repository",
    "receivedAt": "2026-10-10T13:00:00Z",
    "payload": {}
  }
}
```

The server sends a checkpoint after all event messages that it covers:

```json
{"type":"checkpoint","cursor":"43"}
```

It also sends a checkpoint when only excluded events move the scan position.
A client saves a checkpoint after it processes all earlier event messages.
Each client stores its own cursor. A reconnect can repeat events, so clients
use event IDs to remove duplicates.

## Errors

A public error has a message and one of these codes:

- `invalid_request`
- `invalid_cursor`
- `unauthorized`
- `forbidden`
- `internal_error`

An HTTP error response has the shape `{ "error": PublicError }`. Invalid HTTP
input uses status 400. When a request reaches the application, missing or
rejected credentials use status 401 or 403. Cloudflare Access can reject a
request before it reaches the application. Unexpected failures use status
500.

An invalid stream message or cursor produces an error message before the
server closes the connection:

```json
{
  "type": "error",
  "error": {"code": "invalid_cursor", "message": "Unknown cursor."}
}
```

Unexpected stream failures use the `internal_error` code.

## Shared package

`@github-webhook-relay/contracts` exports immutable TypeScript types, Beff
parsers, query defaults, query normalization, and a pure cursor pagination
helper. Run `pnpm generate` before type checking or bundling code that imports
the generated validators.
