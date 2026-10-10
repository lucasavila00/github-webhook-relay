# Cloudflare Access setup

For the complete two-Worker setup, follow [Deployment](deployment.md). To
connect GitHub and the local client after deployment, follow
[Getting started](getting-started.md).

Cloudflare Access protects only the relay hostname. The public ingress
hostname has no Access application or bypass policy. Do not add Worker-level
Access. The hostname-scoped relay application supports protected HTTP and
WebSocket requests.

## Access application

Create one hostname Access application for the exact relay hostname. Add an
Allow policy for the exact email `lucaxx@gmail.com`. Use the one-time PIN
identity provider. Add a Service Auth policy for one `gh-watch` service token.

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
