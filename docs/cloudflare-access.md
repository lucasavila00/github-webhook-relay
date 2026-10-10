# Cloudflare Access setup

The deployment uses two Workers on two custom hostnames. The
`github-webhook-relay` Worker serves the browser, event history API, and event
stream on `relay.example.com`. The `github-webhook-relay-ingress` Worker
receives GitHub webhooks on `hooks.example.com`.

Cloudflare Access protects only the relay hostname. The ingress hostname does
not use Access. It accepts only `POST /webhooks/github` and forwards the
request to the `EventRelay` Durable Object in `github-webhook-relay`. The
Durable Object verifies the GitHub HMAC before it accepts a delivery.

The repository has these Wrangler configurations:

- `packages/relay/wrangler.jsonc` configures `github-webhook-relay`. This
  Worker owns the `EVENT_RELAY` namespace and its SQLite data.
- `packages/relay/wrangler.ingress.jsonc` configures
  `github-webhook-relay-ingress`. Its external `EVENT_RELAY` binding uses
  `script_name: "github-webhook-relay"`.

Both configurations disable `workers.dev` and preview URLs. Do not add an
Access bypass policy, a Worker-level Access application, or another public
route to either Worker.

## Access application

Create one hostname Access application for the exact relay hostname. Add an
Allow policy for the exact email `lucaxx@gmail.com`. Use the one-time PIN
identity provider. Add a Service Auth policy for one `gh-watch` service token.

Record these values:

- Access team domain, such as `https://team.cloudflareaccess.com`
- Relay hostname
- Ingress webhook URL, such as
  `https://hooks.example.com/webhooks/github`
- Access application audience
- Access service-token client ID and secret
- GitHub webhook secret

The relay Worker validates each Access JWT signature, issuer, audience, and
expiry. It reads `Cf-Access-Jwt-Assertion` first. If that header is absent, it
reads the `CF_Authorization` browser cookie. An invalid assertion header cannot
fall back to a valid cookie.

The browser opens the relay hostname and completes the one-time PIN login. The
local client sends these headers on each HTTP request and on the first
WebSocket upgrade request:

```text
CF-Access-Client-Id: <client-id>
CF-Access-Client-Secret: <client-secret>
```

Keep both values in local configuration. Do not put them in source control,
browser code, or logs.

Delete or rotate the service token to block new local client requests and
connections. This action does not promise that Cloudflare closes an open
WebSocket. Remove the email Allow policy to block new browser sessions.

## Real provider check

This repository tests JWT verification and request routing in the local
Cloudflare runtime. Those tests do not prove the Cloudflare Access policy,
custom domains, external Durable Object binding, or deployed secrets.

After both Workers are deployed, set these environment variables:

```sh
export RELAY_URL=https://relay.example.com
export WEBHOOK_URL=https://hooks.example.com/webhooks/github
export ACCESS_CLIENT_ID=...
export ACCESS_CLIENT_SECRET=...
export GITHUB_WEBHOOK_SECRET=...
```

Run the provider smoke check:

```sh
pnpm --filter @github-webhook-relay/relay smoke:access
```

The check requires `200` for authenticated event history and `101` for an
authenticated WebSocket on the relay hostname. Invalid service credentials
must return `403` for both requests. The ingress webhook URL must return `204`
for a correctly signed `ping` delivery and `401` for an invalid signature.

Use a private browser session to confirm that `lucaxx@gmail.com` can sign in
and another email cannot sign in. Repeat the service checks after token
deletion or rotation. Use the deleted or old token values and run only the
revocation checks:

```sh
ACCESS_SMOKE_MODE=revocation pnpm --filter @github-webhook-relay/relay smoke:access
```

Revocation mode requires `403` for a new history request and a new WebSocket
connection. It does not first require the old token to be valid. Keep the pull
request in draft until this provider proof is recorded.
