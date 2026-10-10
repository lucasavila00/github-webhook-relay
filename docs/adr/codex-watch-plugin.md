# Package the local watch client as a Codex plugin

Issue: [#14](https://github.com/lucasavila00/github-webhook-relay/issues/14)

## Context

An existing Codex session needs to call the local client from issue 13. The
integration must keep credentials in a local process and must not acknowledge
events before Codex handles them.

## Decision

Add a `gh-watch` Codex plugin at `plugins/gh-watch`. Its
`.codex-plugin/plugin.json`, `.mcp.json`, and `skills/gh-watch/SKILL.md` use the
Codex compatibility layout. A repo marketplace at
`.agents/plugins/marketplace.json` exposes the plugin. The package does not
need hooks, an app, or a UI.

The plugin starts one bundled Node.js stdio MCP server. Esbuild includes the
local client, official MCP TypeScript SDK, and all non-built-in dependencies.
The MCP manifest runs `node ./dist/server.mjs` from the plugin root and passes
the four named configuration variables from the Codex environment. The
portable format cannot pass these host variables in Codex 0.162.1. The
installed plugin has no checkout or workspace dependency. It exposes only:

```ts
watch(input: Readonly<{
  consumer: string;
  filters: Readonly<{ repository?: string; type?: EventType }>;
  waitMilliseconds: number;
}>): Promise<WatchResult>;
acknowledge(input: Readonly<{
  acknowledgement: Readonly<{ value: string }>;
}>): Promise<Readonly<{ type: "acknowledged" }>>;
```

`watch` delegates to `watchEvents`. It returns either a batch with events and
the opaque acknowledgement value or `{ "type": "timeout" }`. `acknowledge`
delegates to `acknowledgeEvents`. Codex calls it only after it handles every
event in that batch. A timeout has no acknowledgement. An unacknowledged batch
repeats on a later watch as defined by the local client contract.

Beff validates tool input before application code receives it. The server maps
local client errors to MCP tool errors with the stable local error code and a
safe message. It does not include credentials or local state in tool output.

The MCP process reads the relay URL, state directory, Cloudflare Access client
ID, and Cloudflare Access client secret from its local environment. The plugin
manifest contains no credential values. DIY injects the local client, clock,
stdio, and process environment capabilities into free functions.

The skill tells Codex to use a stable consumer name and exact repository and
event type filters, call `watch` again after a timeout, handle a complete batch,
and then pass its returned value to `acknowledge`. It does not select or control
sessions, wake Codex, inject turns, or authorize code changes and merges.

For a local checkout, installation and invocation are:

```sh
codex plugin marketplace add /absolute/path/to/github-webhook-relay
codex plugin add gh-watch@github-webhook-relay
codex
```

The user then asks the session to use `$gh-watch` with a consumer and filters.
The same marketplace command accepts `lucasavila00/github-webhook-relay` for a
Git-backed installation after the implementation is on the selected ref.

Tests start the compiled stdio server as a real child process and use an MCP
client over real pipes. They connect through the real local client to a real
relay process and cover batch, timeout, explicit acknowledgement, replay of an
unacknowledged batch, filters, invalid input, and errors. A final smoke test
installs the plugin with Codex, starts a new Codex session, watches a delivered
event, handles it, acknowledges it, and verifies that the next watch advances.
No provider response or tool call is mocked or canned.

## Consequences

- Codex must call `watch` again after each timeout or handled batch.
- The MCP process lifetime does not change durable consumer progress rules.
- Installation needs Linux, `flock`, Node.js, and the four environment values.
