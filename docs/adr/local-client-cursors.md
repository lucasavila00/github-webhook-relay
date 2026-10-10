# Keep local consumer progress after explicit acknowledgement

Issue: [#13](https://github.com/lucasavila00/github-webhook-relay/issues/13)

## Context

An existing Codex session needs to wait for relay events without losing work
after a disconnect or process failure. Separate sessions and subscriptions
must not take events from each other.

## Decision

The local package exports these free functions and immutable values:

```ts
type WatchRequest = Readonly<{
  consumer: string;
  filters: EventFilters;
  waitMilliseconds: number;
  signal?: AbortSignal;
}>;
type Acknowledgement = Readonly<{
  consumer: string;
  filters: EventFilters;
  cursor: Cursor;
}>;
type WatchResult =
  | Readonly<{ type: "batch"; events: ReadonlyArray<Event>;
      acknowledgement: Acknowledgement }>
  | Readonly<{ type: "timeout" }>;
watchEvents(capabilities, request): Promise<WatchResult>;
acknowledgeEvents(capabilities, acknowledgement): Promise<void>;
```

`watchEvents` loads the cursor for the consumer and normalized filters, opens
an outbound WebSocket, and sends the shared subscription. It collects messages
through the next checkpoint and returns them as one batch. A checkpoint with
no matching event returns an empty batch so the caller can acknowledge scan
progress. A timeout returns no acknowledgement. Cancellation rejects the call
with a cancellation error.

`acknowledgeEvents` saves only a checkpoint that `watchEvents` returned. The
caller calls it after it handles the batch. Socket receipt and batch return do
not save progress. A failure before the atomic save completes causes repeat
delivery. Stable event IDs identify repeats; there is no exactly-once claim.

The state key is the consumer name plus a canonical tuple of the optional
`repository` and `type` filters. One file stores this validated record:

```json
{"consumer":"review","filters":{"repository":"owner/repo"},
 "cursor":"cursor_43"}
```

The storage adapter writes a temporary file in the state directory and renames
it over the key file. Different keys can operate concurrently. The caller must
not overlap watch or acknowledgement calls for the same key; such calls return
an `in_use` error. This rule prevents an older batch from replacing newer
progress without a shared cursor service.

The client reconnects from the last acknowledged cursor after a connection
failure or a relay `1013` close, while time remains in the original bounded
wait. It stops on cancellation, timeout, authentication rejection, invalid
cursor, invalid relay data, or local storage failure. Errors identify these
causes and include a safe message.

Configuration contains the relay URL, state directory, and Cloudflare Access
client ID and secret. The network adapter sends the service-token headers on
HTTP and WebSocket upgrades. Credentials do not enter state or errors.

DIY injects fetch, clock, network, and storage capabilities. Beff validates
configuration, relay messages, and persisted records at their boundaries.
Vitest tests use actual local HTTP endpoints and sockets, a temporary directory,
and the real adapters. Tests cover acknowledgement timing, restart replay,
independent keys, reconnect, timeout, cancellation, and useful errors.

## Consequences

- Removing a state file starts that consumer and filter set from history.
- A new name gives independent progress; the client controls no session.
