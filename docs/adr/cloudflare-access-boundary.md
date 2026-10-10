# Put Cloudflare Access at the Worker boundary

Issue: [#10](https://github.com/lucasavila00/github-webhook-relay/issues/10)

## Context

The browser and local client need revocable access to event data. GitHub must
send webhooks without an interactive login, and every other Worker URL must
remain protected.

## Decision

Attach one Cloudflare Access application to the relay Worker. This application
protects the Worker on its custom domain, routes, `workers.dev` hostname, and
preview URLs. Give it these policies:

- An Allow policy with an exact email selector for Lucas. Use the Cloudflare
  one-time PIN identity provider for browser login.
- A Service Auth policy with one service token for the local `gh-watch` client.

The browser uses the Access session cookie. The local client sends
`CF-Access-Client-Id` and `CF-Access-Client-Secret` on HTTP requests and on the
initial WebSocket upgrade request. The credentials stay in local
configuration. They do not enter browser code, logs, or source control.

Create a second Access application for this exact hostname and path:

```text
https://<relay-host>/webhooks/github
```

Give this application a Bypass policy that includes Everyone. Cloudflare gives
the more specific hostname-and-path application precedence over Worker-level
Access. The relay still requires a valid GitHub webhook signature. No other
path has a Bypass policy, and the `workers.dev` and preview URLs do not have a
webhook exception. The relay accepts only signed POST requests on this path.

Access gates each read request and WebSocket upgrade. The relay then validates
the signature, issuer, audience, and expiry of the
`Cf-Access-Jwt-Assertion` token before it serves event data or upgrades the
connection. It obtains the signing keys from the account's Access certificate
endpoint. Application handlers do not implement a second login system.

## Consequences

- Deleting or rotating the service token revokes local client access.
- Removing the email Allow policy revokes browser access.
- The webhook exception has no Access request log. Relay delivery logs remain
  available after signature verification.
- Real provider tests must use a deployed Worker and Access applications. They
  must cover an allowed and denied browser, a valid and invalid service token,
  an HTTP read, a WebSocket upgrade, the signed webhook exception, and an
  alternate Worker URL.
- Later setup needs the Cloudflare account and zone, a custom relay hostname,
  the Worker name, Lucas's allowed email address, a GitHub webhook secret, a
  Cloudflare deployment API token, and the local service token credentials.
  Hosted tests also need their test identities and secrets. These secrets are
  not available in GitHub Actions now.

## Alternatives

A hostname-only Access application would leave `workers.dev` or a preview URL
outside the policy. Disabling those URLs reduces exposure, but it does not keep
new Worker routes protected by construction.

The relay could trust the Access gate without validating its application token.
Cloudflare requires origins without a Tunnel to validate the token, so this
would not enforce authentication at the relay boundary.
