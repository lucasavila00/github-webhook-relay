# Workspace

The repository is a pnpm workspace with five packages:

| Path | Package | Owner |
| --- | --- | --- |
| `packages/core` | `@github-webhook-relay/core` | Shared types, logic, and Beff validators |
| `packages/relay` | `@github-webhook-relay/relay` | Relay Worker and Durable Object |
| `packages/webapp` | `@github-webhook-relay/webapp` | Browser code and webapp Worker |
| `packages/local` | `@github-webhook-relay/local` | Local Node.js integration |
| `packages/codex-tool` | `@github-webhook-relay/codex-tool` | Codex MCP server bundle |

The core package has no browser, Cloudflare, or Node.js dependency. The other
packages can depend on core. Cloudflare bindings stay in the
package that deploys them.

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
