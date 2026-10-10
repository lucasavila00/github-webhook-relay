# GitHub webhook ingestion

The relay receives `POST /webhooks/github` in one deployment-wide SQLite
Durable Object. Configure `WEBHOOK_SECRET` as a Wrangler secret. The object
verifies `X-Hub-Signature-256` with HMAC SHA-256 over the exact request bytes
before it parses JSON.

The relay stores these GitHub deliveries:

| GitHub event | Required action and field | Stored type |
| --- | --- | --- |
| `issues` | `opened` | `issues` |
| `issue_comment` | `created` | `issue_comment` |
| `pull_request_review_comment` | `created` | `pull_request_review_comment` |
| `pull_request` | `closed` and `pull_request.merged: true` | `pull_request` |

An `issue_comment` can contain an issue comment or a pull request conversation
comment. Both cases use the `issue_comment` type. A
`pull_request_review_comment` is an inline pull request comment.

The object stores the original request bytes in this append-only table:

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

One synchronous storage transaction inserts a delivery and reads its position.
The unique delivery ID makes concurrent redeliveries one stored event. The log
has no deletion or retention process.

Event IDs use `event_<position>`. Cursors use `cursor_<position>` with canonical
decimal positions. `cursor_0` is the initial cursor. Each other valid cursor
refers to a position that exists in the log.

The endpoint returns 202 for a selected delivery, including a duplicate. It
returns 204 for a verified event or action that is not selected. It returns 400
for invalid JSON, a missing delivery or event header, or invalid fields in a
selected event. It returns 401 for a missing, malformed, or incorrect
signature. It returns 500 when storage fails.
