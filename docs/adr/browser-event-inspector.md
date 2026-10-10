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

The existing `packages/relay` Wrangler deployment remains the only production
Worker. Preserve its `github-webhook-relay` name, `EventRelay` binding, SQLite
migrations, and Durable Object namespace. Its existing custom hostname remains
the only supported origin. Do not deploy `packages/webapp` as another Worker.

Build the Preact browser in `packages/webapp`. Export its server functions
through an explicit workspace export. The relay entry point imports those
functions, supplies explicit capabilities, and serves the Vite output through
the Wrangler asset binding. Set the binding to run the relay Worker first for
every request. The relay applies the agreed Cloudflare Access JWT check, routes
`/api/*` and `/webhooks/github` to its existing handlers, and gives other
requests to the asset server. The browser uses its Access cookie with
same-origin HTTP and WebSocket calls. One relay command builds and deploys the
Worker and browser assets together.

The browser uses the shared event, query, page, and stream types and Beff
parsers. It models the view as a read-only `loading | ready | error` union and
the connection as a `connecting | live | disconnected` union.

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
implementation pull request. At that time, update the workspace document and
remove the obsolete standalone webapp Wrangler deployment configuration.

## Consequences

- Access protects assets and APIs through the same custom hostname and Worker.
- Existing SQLite data stays in the relay Durable Object namespace.
- The live stream starts at the tail of the pages that the user has loaded.
- The first release has one event-list route and no deep links.
