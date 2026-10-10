# Store verified GitHub deliveries in one event log

Issue: [#9](https://github.com/lucasavila00/github-webhook-relay/issues/9)

## Context

The relay must verify, select, order, and store GitHub deliveries before it
acknowledges them. The shared event contract needs one durable scan position
for history and live replay.

## Decision

One deployment-wide SQLite Durable Object owns `POST /webhooks/github` and the
event log. It reads the body once as bytes and verifies
`X-Hub-Signature-256` over those exact bytes. An injected cryptography
capability uses `crypto.subtle.verify` with HMAC SHA-256. JSON parsing starts
only after successful verification.

The relay stores only these event and action combinations:

| GitHub event | Required action and field | Stored type |
| --- | --- | --- |
| `issues` | `opened` | `issues` |
| `issue_comment` | `created` | `issue_comment` |
| `pull_request_review_comment` | `created` | `pull_request_review_comment` |
| `pull_request` | `closed` and `pull_request.merged: true` | `pull_request` |

For `issue_comment`, the presence of `issue.pull_request` distinguishes a pull
request conversation comment from an issue comment. Both use the shared
`issue_comment` type. Comment edits and deletions are outside this decision.
The repository value is `repository.full_name`.

The object uses this append-only table:

```sql
CREATE TABLE events (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  repository TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload BLOB NOT NULL
);
```

`payload` contains the original request bytes. Reads parse those bytes to the
shared event `payload: unknown`. Beff validators parse only fields required to
select and index a delivery.

A storage capability runs one `DurableObjectStorage.transactionSync` call.
Within it, `INSERT ... ON CONFLICT(delivery_id) DO NOTHING` deduplicates the
delivery and assigns its position. Thus, concurrent redeliveries produce one
stored event, and the object stores a selected event before it returns 202.

Event IDs are `event_<position>`, and cursors are `cursor_<position>`, with
canonical decimal positions. `cursor_0` is the non-empty initial cursor. A
nonzero cursor is valid only when its position exists in the retained log.
These strings are opaque to clients. The log has no deletion or cleanup path.

The endpoint returns these results:

- 202 for a newly stored selected delivery or its duplicate.
- 204 for a verified event or action that is not selected.
- 400 for a missing delivery or event header, invalid JSON, or invalid fields
  in a selected event.
- 401 for a missing, malformed, or incorrect signature.
- 500 when storage fails.

Free functions own verification, selection, parsing, ID and cursor conversion,
and transaction flow. Their immutable capability inputs expose cryptography,
storage, and clock operations. The required Durable Object class only creates
those capabilities and delegates the request.

## Consequences

- A delivery can consume a SQLite sequence value during a deduplication race,
  so positions are ordered but do not have to be consecutive.
- History remains in the one Durable Object for the deployment indefinitely.
