# Build one same-origin Preact event inspector

Issue: [#15](https://github.com/lucasavila00/github-webhook-relay/issues/15)

## Context

Lucas needs a small browser app for the ordered history and live stream. The
app must use the agreed Cloudflare Access boundary and recover from a stream
interruption without a second session or a gap in displayed history.

## Decision

Use Preact 11 function components with TypeScript and Vite. Do not add a UI
kit, router, state library, or client-side auth library. One page contains the
filters, ordered event list, page controls, connection status, and a payload
detail panel.

Deploy the Vite output and server as one Worker with Wrangler static assets.
The existing relay custom hostname remains the only supported origin. Set the
asset binding to run the Worker first for every request. The server applies the
agreed Cloudflare Access JWT check, routes `/api/*` and `/webhooks/github` to
the relay handlers, and serves other requests from the asset binding. Thus,
the browser uses its Access cookie with same-origin HTTP and WebSocket calls.

The browser uses the shared event, query, page, and stream types and Beff
parsers. It models application data as read-only discriminated unions:

```ts
type View =
  | Readonly<{ state: "loading"; previous?: Ready }>
  | Readonly<{ state: "ready"; value: Ready }>
  | Readonly<{ state: "error"; message: string; previous?: Ready }>;
type Connection = "connecting" | "live" | "disconnected";
```

`Ready` contains the active exact repository and event-type filters, immutable
pages, the current page index, selected event ID, stream checkpoint, and
connection state. An empty current page renders a specific empty message. A
loading or error state keeps prior data visible when it exists. A disconnected
state keeps history visible and reports that reconnection is in progress.

The first history request omits `after`. `Later` requests the returned cursor
and appends one immutable page. `Older` selects the preceding retained page.
Changing a filter closes the stream and starts again at the first page. The
list keeps stored order. Selecting an event renders its original payload as
formatted JSON without changing it.

Open the stream only when the current HTTP page has `hasMore: false`. Subscribe
after that page's cursor with the same filters. Apply event and checkpoint
messages in order. Append an event only when its ID is absent, and save a
checkpoint only after all earlier events are in state. On close, reconnect
after the saved checkpoint. Repeated events are removed by ID, so reconnects
cannot lose history or show duplicates.

Free reducer and transition functions return new values. Effect functions use
DIY capabilities for fetch, clock, and socket creation. The browser entry point
provides the real browser resources. No function reads these globals directly.

Vitest covers pure transitions and parsing. Cloudflare runtime tests use the
real Worker, asset binding, Durable Object, SQLite, HTTP, and WebSockets.
Vitest Browser Mode runs the built app in a real browser and verifies filters,
older and later pages, payload inspection, live delivery, disconnect recovery,
and empty, loading, disconnected, and error messages. Tests do not use mocks,
patched globals, or DOM emulation.

Do not add multi-user management, session control, or event cleanup. Move this
contract to maintained webapp documentation and delete this proposal in the
implementation pull request.

## Consequences

- Access protects assets and APIs through the same custom hostname and Worker.
- The live stream starts at the tail of the pages that the user has loaded.
- The first release has one event-list route and no deep links.

## Alternatives

Vanilla DOM code removes Preact, but it needs manual render and event lifecycle
code for the same state transitions. A larger framework adds routing and server
rendering features that this single authenticated inspector does not need.
