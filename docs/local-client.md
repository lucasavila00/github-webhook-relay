# Local event client

The `@github-webhook-relay/local` package lets an existing Codex session wait
for relay events. It does not find, start, resume, wake, steer, or control a
Codex session.

## Configuration

Create Node capabilities with the relay URL, a local state directory, and a
Cloudflare Access service token:

```ts
const capabilities = createNodeCapabilities({
  relayUrl: "https://relay.example.com",
  stateDirectory: "/home/user/.local/state/gh-watch",
  accessClientId: process.env.CF_ACCESS_CLIENT_ID,
  accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
});
```

The client sends the service-token headers on the outbound WebSocket upgrade.
It does not write credentials to cursor files or error messages. The Node
adapter requires Linux and the `flock` command.

## Watch and acknowledge

Each watch has a consumer name and normalized repository and event type
filters. This tuple identifies one independent cursor:

```ts
const result = await watchEvents(capabilities, {
  consumer: "review-session",
  filters: { repository: "owner/repository", type: "issues" },
  waitMilliseconds: 30_000,
  signal,
});

if (result.type === "batch") {
  await handleEvents(result.events);
  await acknowledgeEvents(capabilities, result.acknowledgement);
}
```

The wait returns either a batch or a timeout. A batch can be empty when a
checkpoint advances across filtered events. Cancellation throws a `cancelled`
`LocalClientError`.

Before it returns a batch, the client saves an opaque acknowledgement token,
the prior acknowledged cursor, and the returned checkpoint. It advances the
cursor only when `acknowledgeEvents` receives the current pending token. It
rejects stale, repeated, and unknown tokens.

If a process fails before acknowledgement, the next watch resumes from the
acknowledged cursor. The relay can send an event again. Event IDs are stable so
the caller can identify repeated delivery. The client does not provide
exactly-once work.

The client reconnects after connection failures and relay close code `1013`
while time remains in the original wait. Authentication, cursor, relay data,
storage, and connection failures have separate error codes.

## Concurrency and storage

Different consumer and filter keys can run at the same time. A Linux advisory
lock covers a full watch or acknowledgement call for one key. Another call for
that key fails with `in_use`. The operating system releases the lock when its
holder exits, including after a process failure.

Each key has one validated JSON state file. Updates use a synced temporary file
and an atomic rename. Removing a state file starts that consumer and filter set
from the beginning of retained history.
