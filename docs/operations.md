# Production operations

This guide deploys and proves the one-user GitHub webhook relay. The real
provider proof is incomplete until the pre-merge procedure below passes or the
protected workflows pass after they reach the default branch.

## Cloudflare setup

Use [Getting started](getting-started.md) for the first local client and
[Deployment](deployment.md) for the complete Cloudflare and GitHub setup. The
deployment uses two role-specific Workers and two custom hostnames. The small
ingress Worker accepts only `POST /webhooks/github` and sends the request to
the existing `EventRelay` Durable Object in the relay Worker. The relay Worker
serves the browser, history API, and WebSocket API behind Cloudflare Access.
Do not put the webhook hostname in the Access application and do not add an
Access bypass path. Workers.dev and preview URLs stay disabled for both
Workers.

Create the GitHub `production` environment. Configure its deployment
protection rules to require Lucas as a reviewer. Keep self-review enabled
because Lucas is the only user. Thus, each `Deploy` and `Live E2E` run pauses
for explicit production approval. Add these secrets:

```text
CLOUDFLARE_API_TOKEN  CLOUDFLARE_ACCOUNT_ID  GITHUB_WEBHOOK_SECRET
GITHUB_E2E_TOKEN      CF_ACCESS_CLIENT_ID     CF_ACCESS_CLIENT_SECRET
```

The Cloudflare token needs Worker, route, Durable Object, and Access read
permissions. The GitHub E2E token needs issue, content, pull request, and
repository-hook delivery access in the test repository.

Add these environment variables:

```text
ACCESS_AUD  ACCESS_TEAM_DOMAIN  WEBHOOK_HOSTNAME  WEBHOOK_URL
RELAY_HOSTNAME  RELAY_URL
GITHUB_E2E_REPOSITORY  GITHUB_E2E_HOOK_ID
```

`WEBHOOK_URL` is `https://<webhook-host>/webhooks/github`. `RELAY_URL` is
`https://<relay-host>`. The two hostnames must differ. Keep credentials out of
repository variables, source files, workflow artifacts, and logs.

## Pre-merge deployment and proof

GitHub permits `workflow_dispatch` only when the workflow file exists on the
default branch. Thus, a new deployment workflow cannot prove its own pull
request before merge. GitHub documents this requirement here:

https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow

Use this operator procedure for the first pre-merge proof. Check out the
reviewed issue 16 branch and confirm that its hosted CI run passed. Record the
tested commit as ordinary evidence. Set the Cloudflare and GitHub values from
the preceding section only in the local operator environment. Lucas runs the
following commands to deploy:

```sh
pnpm install --frozen-lockfile
pnpm --filter @github-webhook-relay/webapp exec playwright install --with-deps chromium
pnpm generate
cd packages/relay
pnpm exec wrangler secret put WEBHOOK_SECRET
pnpm exec wrangler deploy \
  --config wrangler.jsonc \
  --var "ACCESS_AUD:$ACCESS_AUD" \
  --var "ACCESS_TEAM_DOMAIN:$ACCESS_TEAM_DOMAIN" \
  --domain "$RELAY_HOSTNAME"
pnpm exec wrangler deploy \
  --config wrangler.ingress.jsonc \
  --domain "$WEBHOOK_HOSTNAME"
```

Enter `GITHUB_WEBHOOK_SECRET` only at the Wrangler secret prompt. These are the
same build, secret, variable, and ordered deploy operations as the
reviewed `Deploy` workflow. They preserve the `github-webhook-relay` Worker,
`EVENT_RELAY` binding, `EventRelay` class, `v1` SQLite migration, and existing
Durable Object namespace. The `github-webhook-relay-ingress` Worker uses an
external `EVENT_RELAY` binding to that owner. It does not create a second
Durable Object namespace or a second webapp Worker.

Return to the repository root. Set `ACTIONS_RUN_URL` to the successful hosted
CI run. Configure the repository webhook as described in the next section.
Then run the same built entry points as the reviewed `Live E2E` workflow:

```sh
export TESTED_COMMIT="$(git rev-parse HEAD)"
export GH_WATCH_STATE_DIRECTORY="$(mktemp -d)"
pnpm --silent --filter @github-webhook-relay/e2e run full \
  > live-e2e-report.json
pnpm --silent --filter @github-webhook-relay/e2e run revocation \
  > live-e2e-revocation-report.json
```

Before the revocation command, delete or rotate the tested Access service
token and keep its old values in the local environment. After the command
passes, replace the local values with the new token. Complete the private
browser, denied identity, and installed Codex checks in the Live proof section.
Keep both reports with the hosted CI URL and manual results.

This pre-merge procedure has not run because the provider configuration and
credentials are not available. Local runtime tests do not satisfy this proof.
After these workflow files merge to the default branch, use the protected
`Deploy` and `Live E2E` workflows for later releases.

## GitHub webhook

Create one repository webhook at:

```text
https://<webhook-host>/webhooks/github
```

Use `application/json` and the same value as `GITHUB_WEBHOOK_SECRET`. Subscribe
to issues, issue comments, pull request review comments, and pull requests.
The relay stores only opened issues, created issue comments, created inline
review comments, and merged pull requests.

## Plugin installation

Set the four local values in the environment that starts Codex:

```sh
export GH_WATCH_RELAY_URL=https://<relay-host>
export GH_WATCH_STATE_DIRECTORY=/absolute/private/state/directory
export CF_ACCESS_CLIENT_ID=<service-token-id>
export CF_ACCESS_CLIENT_SECRET=<service-token-secret>
```

Install the plugin and start a new Codex session:

```sh
codex plugin marketplace add lucasavila00/github-webhook-relay
codex plugin add gh-watch@github-webhook-relay
codex
```

Use a stable consumer name and filters for each independent work stream. Each
consumer and filter tuple owns one cursor. A second consumer does not advance
the first cursor. If a process stops before `acknowledge`, its next `watch`
returns the unacknowledged batch again. Remove one local state file only when
you intentionally want that consumer to replay retained history from the
start.

## Live proof

Run `Live E2E` in `full` mode on the deployed commit. This workflow completes
the automated part of the proof with real GitHub and Cloudflare resources. It
creates one event of each supported type, waits for storage, and verifies
service-authenticated history, WebSockets, real Chromium display, GitHub
redelivery deduplication, offline replay, and two independent MCP consumers.
It requires missing and invalid credentials to fail on the relay hostname. It
also requires unsigned and incorrectly signed webhook requests to return 401
without an Access redirect. Authenticated history and WebSocket requests on
the webhook hostname must return 404, and an authenticated webhook request on
the relay hostname must return 404. These checks prove that the two hostnames
have different boundaries. The artifact records the tested commit and Actions
run URL.

Use a private browser to sign in as the configured operator through the real
identity provider. Confirm that all four E2E events appear. Use another email
and confirm that Access denies it. Record both results with the workflow
artifact. Service-authenticated Chromium does not prove either identity rule.

In an existing Codex session with the installed plugin, use `$gh-watch` with
the E2E repository and a new consumer. Confirm that all four created events
arrive. Handle the complete batch, call `acknowledge`, and record this operator
result with the workflow artifact. The workflow's bundled MCP check does not
prove the installed plugin or an existing session. The automated run, browser
identity checks, and this Codex check together form the complete live proof.

For revocation, delete or rotate the Access service token. Keep its old values
in the protected environment only long enough to run `Live E2E` in
`revocation` mode. The run must deny new HTTP and WebSocket connections. Then
replace the protected secrets with the new token before normal use resumes.

## Recovery and capacity

Cloudflare Durable Object storage is the event record. Redeploy the same
Worker and namespace after a failed release. Use Cloudflare point-in-time
recovery for storage damage. Restore a local consumer by keeping its state file
or by using its backup. Loss of that file starts replay at retained history.

Event rows have no TTL, cleanup job, or automatic expiration. On 2026-10-10,
the official Durable Objects limits page listed 1 GB per SQLite object on
Free, 10 GB per object on Paid, 5 GB total on
Free, a soft 1,000 requests per second for one object, 32 MiB received
WebSocket messages, and 30 seconds of CPU per request by default. The Paid
SQLite account total is unlimited, but one object is not. Check the linked
page and the deployed plan before each release. Monitor namespace storage. A
full object stops new writes with `SQLITE_FULL`; this product does not delete
old events to recover capacity.

https://developers.cloudflare.com/durable-objects/platform/limits/

## Evidence

Record the source commits for core, relay, stream, local client, plugin,
webapp, and this integration branch. Record the normal CI, Deploy, full Live
E2E, revocation Live E2E, and existing Codex session results with their Actions
URLs. A local Worker result is useful diagnostic evidence but is not a real
provider result.
