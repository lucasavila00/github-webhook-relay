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
type Acknowledgement = Readonly<{ value: string }>;
type WatchResult =
  | Readonly<{ type: "batch"; events: ReadonlyArray<Event>;
      acknowledgement: Acknowledgement }>
  | Readonly<{ type: "timeout" }>;
watchEvents(capabilities, request): Promise<WatchResult>;
acknowledgeEvents(capabilities, acknowledgement): Promise<void>;
```

`watchEvents` loads the cursor for the consumer and normalized filters, opens
an outbound WebSocket, and sends the shared subscription. It returns messages
through the next checkpoint as one batch. An empty checkpoint gives an empty
batch for scan progress. Timeout gives no acknowledgement; cancellation fails.

Before return, `watchEvents` atomically saves an opaque token bound to the state
key, base cursor, and returned checkpoint as pending. The caller acknowledges
after it handles the batch. Receipt and return do not move saved progress.

The state key is the consumer name plus a canonical tuple of the optional
`repository` and `type` filters. One file stores this validated record:

```json
{"consumer":"review","filters":{"repository":"owner/repo"},
 "acknowledged":"cursor_42","pending":{"token":"ack_7",
 "base":"cursor_42","checkpoint":"cursor_43"}}
```

`acknowledgeEvents` compares the token with the current pending token. A match
saves its checkpoint as acknowledged and clears pending. Stale, repeated, or
unseen tokens fail. The client does not compare opaque cursors. A new watch
resumes acknowledged progress and replaces pending only after an atomic save.
Thus, old events repeat and their old acknowledgement becomes stale.

The storage adapter writes a temporary file in the state directory and renames
it over the key file. A Linux `flock` child process holds an advisory lock for
the full watch or acknowledgement call. An overlapping call for the same key
returns `in_use`; different keys can run concurrently. The operating system
releases the lock after cancellation, failure, or process death. There is no
persistent lock file state or manual stale-lock cleanup.

The client reconnects from the last acknowledged cursor after a connection
failure or a relay `1013` close, while time remains in the original bounded
wait. It stops on cancellation, timeout, authentication rejection, invalid
cursor or relay data, or local storage failure. Errors identify these causes.

Configuration contains the relay URL, state directory, and Cloudflare Access
client ID and secret. The network adapter sends the service-token headers on
HTTP and WebSocket upgrades. Credentials do not enter state or errors.

DIY injects fetch, clock, network, and storage capabilities. Beff validates
external data. Vitest uses real HTTP endpoints, sockets, temporary storage,
adapters, and child locks. Tests cover restart replay, stale and unseen tokens,
independent keys, reconnect, timeout, cancellation, and errors.

## Consequences

- Removing a state file starts that consumer and filter set from history.
- Repeat delivery uses stable event IDs; exactly-once work is not claimed.
- A new name gives independent progress; the client controls no session.
