# Workspace

The repository is a pnpm workspace with five packages:

| Path | Package | Owner |
| --- | --- | --- |
| `packages/core` | `@github-webhook-relay/core` | Shared types, logic, and Beff validators |
| `packages/relay` | `@github-webhook-relay/relay` | Worker and Durable Object deployment |
| `packages/webapp` | `@github-webhook-relay/webapp` | Browser and asset server functions |
| `packages/local` | `@github-webhook-relay/local` | Local Node.js integration |
| `packages/codex-tool` | `@github-webhook-relay/codex-tool` | Codex MCP server bundle |

The core package has no browser, Cloudflare, or Node.js dependency. The other
packages can depend on core. Cloudflare bindings stay in the
package that deploys them.

The relay package owns the only production Wrangler deployment. Its build
includes the webapp Vite output as static assets. The relay Worker runs first,
applies Cloudflare Access authentication, routes relay API requests, and gives
browser requests to the webapp asset server. This keeps the existing Worker
name, `EventRelay` binding, SQLite migrations, and Durable Object namespace.

## Development commands

Use Node.js 22 or a later supported release. From a fresh checkout, run:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm generate
pnpm check
pnpm test
```

`pnpm generate` creates Beff validators and Wrangler binding types. Do not edit
generated files. `pnpm check` runs strict TypeScript checks and the DIY
analyzer. `pnpm test` runs Vitest in the package runtime. Relay and webapp
tests use the Cloudflare Workers runtime.

GitHub Actions runs these commands with the frozen lockfile. Later component
work must extend the package scripts when it adds new generated code or tests.
