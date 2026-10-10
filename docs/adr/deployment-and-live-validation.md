# Deploy and validate one production relay

Issue: [#16](https://github.com/lucasavila00/github-webhook-relay/issues/16)

## Context

Local runtime tests cannot prove GitHub webhook delivery, Cloudflare Access,
or the deployed browser and Codex tool. The project needs one repeatable path
from normal pull request checks to a recorded production proof without putting
provider credentials in pull request jobs.

## Decision

Keep one unprivileged `CI` job on GitHub's standard pull request merge ref and
on `main`. It installs the pnpm lockfile, runs `pnpm generate`, `pnpm check`,
and `pnpm test`. These commands generate Beff validators and Wrangler types,
run TypeScript and DIY checks, and run Vitest in Node.js, the local Workers
runtime, and real Chromium as each package requires. Do not add an exact-head
gate. Record the tested component commit SHAs and Actions run URLs as ordinary
release evidence.

Add protected, manual `deploy` and `live-e2e` GitHub Actions workflows. They
run only through `workflow_dispatch` in the `production` environment. The
deploy workflow runs the same validation and then the package-local Wrangler
deploy command. `packages/relay` remains the only deployed Worker. Preserve
the `github-webhook-relay` name, `EVENT_RELAY` binding, `EventRelay` class,
`v1` SQLite migration, and its existing Durable Object namespace.

The production environment supplies these secrets and variables:

```text
CLOUDFLARE_API_TOKEN  CLOUDFLARE_ACCOUNT_ID
GITHUB_E2E_TOKEN      GITHUB_E2E_REPOSITORY
CF_ACCESS_CLIENT_ID   CF_ACCESS_CLIENT_SECRET
RELAY_URL
```

Wrangler stores `GITHUB_WEBHOOK_SECRET`. The repository webhook uses the same
secret and subscribes to `issues`, `issue_comment`,
`pull_request_review_comment`, and `pull_request`. Cloudflare has one Access
application for the relay hostname, an exact `/webhooks/github` bypass, and
browser and service-token policies. Secrets never appear in artifacts, logs,
configuration files, or pull request jobs.

The full live mode creates an issue, an issue comment, an inline pull request
comment, and a merged pull request in the E2E repository. For each event, it
verifies storage and uses real service HTTP, WebSocket, and Chromium sessions
to verify history and live display. The operator uses the installed plugin
from an existing Codex session to verify that each event reaches `watch`.
This proof also covers acknowledge, offline replay, one repeated delivery,
and two independent consumers.

The same mode proves that missing and invalid Access credentials cannot use
HTTP or WebSocket endpoints, while GitHub can use only the exact webhook
bypass. For revocation, the operator deletes or rotates the service token and
runs `live-e2e` in `revocation` mode with the old masked credentials. That mode
must show denial for new HTTP and WebSocket connections. The operator then
supplies the replacement credentials before the next full run.

Provider proof is incomplete until these workflows run with the real
Cloudflare account, hostname, Access configuration, GitHub repository, and
credentials. Local resources or replacement providers cannot satisfy it.

Operator documentation gives the exact setup, deploy, plugin installation,
recovery, and proof steps. It records the deployed plan's current storage,
request-rate, message-size, and CPU limits with a retrieval date and the
official Cloudflare Durable Objects limits page. Event history has no TTL or
cleanup. A full database stops new writes, so the operator must monitor storage
and choose a later product change instead of claiming unlimited capacity.

## Consequences

- Pull requests get complete workspace checks without access to production.
- Deployment and live proof need manual approval and external credentials.
- A revocation proof interrupts the tested service token and needs replacement
  credentials before normal local-client use resumes.
- The implementation moves this contract to maintained operator documents and
  deletes this proposal.
