# Code architecture and TypeScript style

Use TypeScript for the relay, webapp, server, and local Codex integration.
Use a pnpm workspace and standard Wrangler tooling for Cloudflare code.
This document defines the code style and component boundaries. The public
API is described in the [README](../README.md).

## Component boundaries

- The relay owns webhook ingestion, event history, queries, replay, and live
  delivery. Its Durable Object uses SQLite storage for the event log.
  [GitHub webhook ingestion](webhook-ingestion.md) defines the accepted events,
  storage schema, and response behavior.
- The ingress Worker accepts only GitHub webhook posts. It uses an external
  binding to call the `EventRelay` Durable Object in the relay Worker. The
  relay Worker owns storage and serves only the protected read surface.
- The webapp server owns sign-in and authorization for webapp access. The
  browser renders event data and uses the public contract.
- The local integration owns its consumer cursor and the connection to local
  Codex work. It consumes the relay API through an outbound connection.
- Shared core code owns application data types and all generated validators.
  It must not import browser, Cloudflare, or local process implementations.
  Keep runtime adapter types, DIY capability interfaces, and local function
  types with their implementations.

Keep dependencies explicit. Browser code must not import server secrets or
local process code. Relay code must not depend on the webapp or Codex client.
Share types and behavior that multiple components use; keep component details
with their owner. Package paths, UI framework, and auth provider remain open.

## Event history storage

The Durable Object reads history in one synchronous SQLite transaction. It
selects matching rows in ascending position order with `limit + 1`. The extra
matching row sets `hasMore` and is not returned. The response cursor is the
greatest stored position before that row. Without an extra matching row, it is
the greatest stored position in the log. Thus, filtered reads advance across
excluded rows without skipping an unreturned matching event.

History reads do not insert, update, or delete data. The server does not store
consumer progress. Each consumer supplies its own cursor.

## Free functions and immutable data

Write application behavior as free functions. Use plain records, arrays, and
literal unions for data. Model different states with discriminated unions.
Keep functions small and give each function one clear purpose.

Use `const` bindings, `readonly` properties, and `ReadonlyArray<T>`. Apply
read-only types to nested data too. Return new values for changes. Do not
change input objects, arrays, capability bags, or shared application data.
Do not use mutable application classes, inheritance, decorators, or a global
service registry.

TypeScript `readonly` and `const` do not freeze data at runtime. Keep the
immutability rule in function implementations as well as type declarations.
Avoid mutable collections as application data and avoid in-place operations
such as array `push`, `splice`, and `sort`.

Pure functions receive values and return values. Effectful functions perform
storage, network, time, or process operations through explicit capabilities.
Keep these effects at component boundaries. Persistent writes and socket
operations are effects; they do not justify mutable application records.

Cloudflare requires a Durable Object class as its runtime entry point. Keep
that class as a thin adapter with read-only runtime references. Its handlers
delegate to free functions. Runtime-owned storage and socket handles stay
inside adapters; domain behavior and data do not live in class instances.
Use function components if the selected UI framework supports them.

## TypeScript flavor

- Use ES modules and explicit named exports.
- Enable strict type checking. Use `unknown` for external data and narrow it
  before use. Do not use `any` or assertions to bypass validation.
- Use type aliases for data shapes and function capabilities. Use literal
  unions instead of runtime enums.
- Use `async` functions and `await` for asynchronous effects.
- Use explicit parameter types and return types on exported functions.
- Pass time and other nondeterministic inputs as values to pure functions.
  Obtain them through capabilities in effectful code.
- Do not perform I/O during module import or keep mutable module state.

## Dependency injection with DIY

Use [DIY](https://github.com/lucasavila00/diy) through `@beff/diy` and its
`@beff/diy-cli` analyzer. Functions declare the capabilities they need;
callers provide concrete implementations.

Accept a DIY `Capabilities<...>` value as the first parameter, named
`capabilities`. Declare the smallest concrete capability union the function
uses, including capabilities required by calls it forwards to.

Capability services are read-only records of functions. Construct capability
bags at runtime entry points with `Capabilities.create`, then pass them
explicitly. Providers connect platform bindings to free adapter functions.
Inject the HTTP client (`globalThis.fetch`), clock, storage, and process
operations through DIY. Bind the real global fetch at the entry point;
functions that make HTTP calls receive an HTTP capability. Read the clock
through a clock capability instead of calling `Date.now()` inside application
functions. Do not obtain services through hidden globals or inject business
objects.

```ts
import type { Capability, Capabilities } from "@beff/diy/capabilities";

type CursorStore = Readonly<{
  save: (cursor: string) => Promise<void>;
}>;
type CursorCapability = Capability<"cursorStore", CursorStore>;

export async function saveCheckpoint(
  capabilities: Capabilities<CursorCapability>,
  cursor: string,
): Promise<void> {
  await capabilities.cursorStore.save(cursor);
}
```

Run the DIY analyzer against handwritten TypeScript. Generated validators
and dependency output are outside that analysis. Dependency injection makes
effects explicit; it is not a reason to replace them with mocks in tests.

## Type validation with Beff

Use [Beff](https://github.com/lucasavila00/beff) with `@beff/cli` and
`@beff/client`. Define application data types in the core package and generate
their runtime validators from those types. Keep all parser declarations and
generated parser code in the core package.

Configure a `beff.json` parser entry and output directory. Run
`pnpm exec beff -p beff.json` in the owning package before type checking,
testing, or bundling code that imports the generated validators.
Do not edit generated code by hand.

Validate external inputs at their entry boundary: HTTP data, WebSocket
messages, configuration, and local persisted data. Use generated parsers to
turn `unknown` into typed values. Keep the original GitHub payload and validate
only the fields a function needs. Validation does not grant authorization.

Use `safeParse` where invalid input is an expected result. Map validation
failures to the public error contract at the transport boundary. Internal
functions receive typed, immutable data and do not repeat boundary parsing.

## Wrangler tooling

Keep Cloudflare bindings, compatibility settings, and Durable Object
migrations in Wrangler configuration. Use package-local Wrangler commands
through pnpm: `wrangler dev` for local execution, `wrangler types` for binding
types, and `wrangler deploy` for deployment. See the
[Wrangler](https://developers.cloudflare.com/workers/wrangler/).

Generate binding types from configuration instead of maintaining a parallel
handwritten environment definition. Use the standard Cloudflare runtime
for Worker and Durable Object development. Keep Node-only code in the local
integration. Do not build a custom replacement for Wrangler.

## Vitest tests without mocks

Use Vitest for tests across the workspace. For Worker and Durable Object
tests, use the official Cloudflare
[guide](https://developers.cloudflare.com/workers/testing/vitest-integration)
to run code in the local Workers runtime with configured bindings.

Build test capability bags with DIY, using real dependencies for that test
environment. Inject its real `globalThis.fetch` as the HTTP client, its real
clock, and adapters for isolated storage. Test code passes these bags through
the same function signatures as production code. Do not patch globals or
replace providers with canned responses. Use a real local HTTP endpoint when
a test needs controlled HTTP behavior. Pass fixed timestamps as input data
when testing a pure time-dependent decision.

Test pure functions with immutable inputs and assertions on returned values.
Test effectful code with its real adapters and real resources. Do not use
mocks, spies, stubs, fake service implementations, or patched platform APIs.

Run relay integration tests in Cloudflare's local runtime with actual Durable
Object and SQLite bindings. Exercise requests, subscriptions, replay, and
reconnects through the public API. Use isolated test storage and real sockets.
For local integration tests, use temporary directories and real child
processes. A test fixture is input data, not a replacement service.

Tests that need an external service must use an actual test environment and
its credentials. Do not claim an integration is tested when its provider was
replaced. Keep pure decisions separate so they can be tested without I/O.
Use hosted GitHub Actions for full validation and focused local checks for
the changed area.
