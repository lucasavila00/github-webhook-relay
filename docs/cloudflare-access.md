# Cloudflare Access setup

The relay uses Cloudflare Access for browser and local client access. The
supported URL is one custom hostname. The relay does not use a Cloudflare
Tunnel.

## Required values

Provisioning needs these values:

- Cloudflare account ID and zone ID
- Access team domain, such as `https://team.cloudflareaccess.com`
- Custom relay hostname
- Worker name
- Access application audience
- Cloudflare API token for deployment
- GitHub webhook secret
- Access service-token client ID and secret

GitHub Actions does not have these values. Therefore, hosted CI checks the
Worker in the local Cloudflare runtime but does not prove the provider setup.

## Access applications

Create a hostname Access application for the exact relay hostname. Add an
Allow policy for the exact email `lucaxx@gmail.com`. Use the one-time PIN
identity provider. Add a Service Auth policy for one `gh-watch` service token.

Create a second hostname application for this exact path:

```text
https://<relay-host>/webhooks/github
```

Add a Bypass policy that includes Everyone. Do not add another path to this
policy. GitHub can then send a webhook without an Access login. The Worker
accepts only a `POST` on this path and verifies `X-Hub-Signature-256` before
it gives the request to webhook processing.

Attach a Worker-level Access application to the relay Worker. Give it the
same Allow and Service Auth policies. This application protects `workers.dev`,
preview, and other Worker URLs. Worker-level Access returns `403` for a
WebSocket upgrade. Therefore, WebSocket clients must use the custom hostname.

## Worker configuration

Replace the example route and public values in
`packages/relay/wrangler.jsonc`:

```json
{
  "routes": [{ "pattern": "relay.example.com", "custom_domain": true }],
  "vars": {
    "ACCESS_AUD": "access-application-audience",
    "ACCESS_TEAM_DOMAIN": "https://team.cloudflareaccess.com",
    "RELAY_HOSTNAME": "relay.example.com"
  }
}
```

Store the webhook secret with Wrangler. Do not put it in the configuration
file:

```sh
pnpm --filter @github-webhook-relay/relay exec wrangler secret put GITHUB_WEBHOOK_SECRET
```

Deploy after the two hostname applications and the Worker-level application
exist. The Worker validates the JWT signature, issuer, audience, and expiry.
It downloads signing keys from the team certificate endpoint and caches them
for five minutes.

## Client use and revocation

The browser opens the custom relay hostname and completes the one-time PIN
login. Cloudflare sends the Access session cookie after login.

The local client sends these headers on each HTTP request and on the first
WebSocket upgrade request:

```text
CF-Access-Client-Id: <client-id>
CF-Access-Client-Secret: <client-secret>
```

Keep both values in local configuration. Do not put them in source control,
browser code, or logs.

Delete or rotate the service token to revoke local client access. This action
blocks new HTTP requests and new WebSocket connections. It does not promise
that Cloudflare closes a WebSocket that is already open. Remove the email
Allow policy to revoke browser access.

## Real provider check

Set these environment variables after deployment:

```sh
export RELAY_URL=https://relay.example.com
export ALTERNATE_RELAY_URL=https://github-webhook-relay.example.workers.dev
export ACCESS_CLIENT_ID=...
export ACCESS_CLIENT_SECRET=...
export GITHUB_WEBHOOK_SECRET=...
```

Run the provider smoke check:

```sh
pnpm --filter @github-webhook-relay/relay smoke:access
```

The check covers a valid and invalid service token, an HTTP request, the
custom-host WebSocket path, the signed webhook exception, and the alternate
Worker URL. Also use a private browser session to confirm that
`lucaxx@gmail.com` can sign in and another email cannot sign in. Repeat the
service checks after token deletion or rotation. Record this provider proof
before issue #10 is complete.
