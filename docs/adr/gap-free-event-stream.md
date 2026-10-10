# Deliver replay and live events without a gap

Issue: [#12](https://github.com/lucasavila00/github-webhook-relay/issues/12)

## Context

Each authenticated WebSocket consumer must replay its own position and then
receive new events without a gap. The Workers WebSocket API has no backpressure
signal, so one slow consumer must not create an unbounded send queue.

## Decision

`GET /api/events/stream` upgrades through the authenticated relay route. The
client must send the shared `subscribe` message in 10 seconds and must not send
another message. Beff validates the message before the relay uses its values.
At timeout, the relay sends `invalid_request` with `Subscription required.` and
closes with code `1008`. Invalid messages or cursors send the applicable public
error and the same close code. An unexpected failure sends `internal_error`
when possible, followed by close code `1011`.

The one SQLite Durable Object owns all ingestion and subscriptions. Its
WebSocket handler validates the cursor. One `transactionSync` call stores the
filters under a small connection key and reads the replay rows. The handler
then sends the replay and registers live delivery without an `await`.
An ingestion turn synchronously commits a new row and sends it to registered
subscriptions. Durable Object turns cannot interleave across this boundary, so
an event is in either the replay scan or a later live send.

For each scanned position, the relay first sends a matching event, if there is
one, and then sends this checkpoint:

```json
{"type":"checkpoint","cursor":"cursor_43"}
```

Thus, excluded events move a filtered consumer forward. The relay never sends
a checkpoint before a matching event at that position. Event IDs and cursors
come from the stored SQLite position, so a reconnect repeats the same IDs.

The relay uses the Durable Object WebSocket Hibernation API. A socket attachment
contains only its small connection key, last sent cursor, and delivery-budget
use. SQLite stores filters with repository values of at most 1,000,000 UTF-8
bytes. The event row stores the repository in its column and original payload,
so a longer value cannot fit in SQLite's 2 MB row limit and cannot match an
event. For a longer filter, the relay stores a compact cannot-match marker and
still scans all positions and sends checkpoints. After hibernation, the adapter
reads this metadata by connection key. It deletes the row on close or error.

The adapter updates the attachment after it sends the checkpoint. If a turn
fails between the send and the update, reconnect can repeat an event but cannot
skip it.

Each connection can scan at most 1,000 positions or send 8 MiB of serialized
messages. At a budget boundary, the relay finishes the current event and its
checkpoint, then closes with code `1013` and reason `Reconnect to continue.`
If the next event would exceed the byte budget, it closes after the preceding
checkpoint. A single event larger than the byte budget is sent once with its
checkpoint, because retained events must remain deliverable. Its maximum size
is still bounded by the ingress platform request limit.

These limits bound the application send queue even though the runtime does not
report client progress. The client reconnects with the latest processed
checkpoint. A close before the client saves a checkpoint causes replay, and
stable event IDs let the client remove duplicate work.

The Durable Object keeps no global consumer cursor and does not delete event
history. Each accepted socket has independent filters, cursor, and budget.
Closing or advancing one socket cannot affect another socket.

Free functions parse subscriptions, select matching rows, build ordered
messages, and calculate budget results with immutable values. The Durable
Object class is a thin adapter for SQLite and hibernating sockets. DIY supplies
the storage and socket capabilities. Real-runtime Vitest tests use actual
SQLite and WebSockets for replay/live races, filtered checkpoints, ordering,
budget closes, reconnect duplicates, and independent subscriptions.

## Consequences

- Active consumers reconnect periodically when they reach a delivery budget.
- A client can receive an event again after disconnect or runtime failure.
