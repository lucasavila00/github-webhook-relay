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

## Codex plugin

The repo marketplace packages the local client as the `gh-watch` plugin. Set
the client configuration in the environment that starts Codex:

```sh
export GH_WATCH_RELAY_URL=https://relay.example.com
export GH_WATCH_STATE_DIRECTORY=/home/user/.local/state/gh-watch
export CF_ACCESS_CLIENT_ID=service-token-id
export CF_ACCESS_CLIENT_SECRET=service-token-secret
```

Install the plugin from a local checkout:

```sh
codex plugin marketplace add /absolute/path/to/github-webhook-relay
codex plugin add gh-watch@github-webhook-relay
codex
```

For a Git source, replace the absolute path with
`lucasavila00/github-webhook-relay` and select a ref that contains the plugin.
In the new session, ask Codex to use `$gh-watch` with a stable consumer name and
the required repository and event type filters. Codex calls `watch` again after
a timeout and calls `acknowledge` only after it handles the returned batch.

The installed plugin contains its server and runtime dependencies. It does not
use files from the source checkout. Plugin changes apply to new sessions after
Codex refreshes the installed plugin.

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

## Validation boundary

Local integration tests use a real Worker, Durable Object, WebSocket, and
generated Access JWT. A separate real socket test verifies the service-token
headers from the production adapter. Hosted end-to-end validation must verify
the actual Cloudflare Access service-token exchange.

An optional Codex smoke test installs the plugin in an isolated `CODEX_HOME`.
It uses the installed manifest and skill, Codex tool discovery, the production
MCP handlers, and a real local Worker. A test entry injects the generated
origin JWT into the production socket capability. The test verifies repeated
delivery, explicit acknowledgement, a later timeout, and the saved
`cursor_1` checkpoint. It does not replace or test the Cloudflare Access edge.

Run it with an existing Codex login file:

```sh
RUN_CODEX_PLUGIN_SMOKE=1 \
CODEX_AUTH_FILE="$CODEX_HOME/auth.json" \
pnpm --filter @github-webhook-relay/codex-tool exec vitest run \
  test/worker-integration.test.ts -t 'installed Codex'
```
