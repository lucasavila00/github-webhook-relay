# Query authenticated event history from SQLite

Issue: [#11](https://github.com/lucasavila00/github-webhook-relay/issues/11)

## Context

Authenticated clients need ordered SQLite event pages. A filtered scan must
advance across excluded events without skipping an unreturned matching event.

## Decision

The authenticated relay route handles this request:

```http
GET /api/events?after=cursor_41&repository=owner/repo&type=issues&limit=100
```

`after`, `repository`, `type`, and `limit` are optional. The default limit is
100, and the maximum is 1,000. Repository and event type filters use exact
string equality. Supported event types come from the shared contract.

The HTTP adapter builds an unknown record from the raw query values. Beff
parsers validate it before a pure function converts and normalizes the query.
Invalid values, including a limit that is not an integer from 1 through 1,000,
return this public error with status 400:

```json
{"error":{"code":"invalid_request","message":"Invalid event query."}}
```

The initial cursor is `cursor_0`. Other accepted cursors have the canonical
`cursor_<position>` form and refer to an existing SQLite position. An unknown
or noncanonical cursor returns status 400:

```json
{"error":{"code":"invalid_cursor","message":"Unknown cursor."}}
```

After authentication and validation, one injected history store capability
runs a synchronous SQLite read transaction. It selects matching rows where
`position` is greater than the input position, orders them by ascending
`position`, and uses `LIMIT <limit + 1>`. SQL applies both optional equality
filters. The extra matching row determines `hasMore` and is not returned.

When an extra matching row exists, a second query in the same transaction gets
the greatest stored position below that row. This is the response cursor. When
there is no extra matching row, it gets the greatest stored position in the
log. If neither query finds a later position, it keeps the input cursor. Thus,
the cursor includes excluded rows but never includes an unreturned matching
row. SQLite gaps do not create cursor values that refer to missing rows.

The adapter parses each returned payload BLOB as its stored JSON object and
uses the shared event and page contracts. For example:

```json
{
  "events": [{
    "id": "event_42", "deliveryId": "github-delivery-id",
    "type": "issues", "repository": "owner/repo",
    "receivedAt": "2026-10-10T13:00:00Z", "payload": {"action":"opened"}
  }],
  "cursor": "cursor_42",
  "hasMore": false
}
```

The read transaction does not insert, update, or delete data. The server does
not store consumer progress. Each consumer sends its own cursor, so one read
cannot change another consumer's position.

Free functions own parsing, normalization, and response construction. The
Durable Object adapter supplies immutable DIY capabilities. Tests use real
Durable Object SQLite and cover ordered paging, empty results,
combined filters, invalid input, independent cursors, retained history, scan
progress across excluded rows, and an unreturned lookahead event.

## Consequences

- A filtered query can scan to the end of history even when its page is empty.
- Authentication failures use 401 or 403; unexpected failures use 500.
