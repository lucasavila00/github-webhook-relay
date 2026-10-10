# Put Cloudflare Access at the relay hostname

Issue: [#10](https://github.com/lucasavila00/github-webhook-relay/issues/10)

## Context

The browser and local client need revocable access to event data. GitHub must
send webhooks without an interactive login, and every other Worker URL must
remain protected.

## Decision

Create a hostname-based Cloudflare Access application for the relay's exact
custom hostname. This application protects HTTP requests and WebSocket
upgrades. Give it these policies:

- An Allow policy with the exact email selector `lucaxx@gmail.com`. Use the
  Cloudflare one-time PIN identity provider for browser login.
- A Service Auth policy with one service token for the local `gh-watch` client.

The browser uses the Access session cookie. The local client sends
`CF-Access-Client-Id` and `CF-Access-Client-Secret` on HTTP requests and on the
initial WebSocket upgrade request. The credentials stay in local
configuration. They do not enter browser code, logs, or source control.

Create a second hostname-based Access application for this exact hostname and
path:

```text
https://<relay-host>/webhooks/github
```

Give this application a Bypass policy that includes Everyone. The narrower
path application takes precedence over the hostname application. The relay
still requires a valid GitHub webhook signature. No other path has a Bypass
policy, and the `workers.dev` and preview URLs do not have a webhook exception.
The relay accepts only signed POST requests on this path.

Also attach a Worker-level Access application to the relay Worker. Give it the
same Allow and Service Auth policies. It protects `workers.dev`, preview URLs,
and any other Worker URL that does not match a hostname-based application. The
hostname application takes precedence on the custom hostname, so the
Worker-level application's WebSocket limitation does not affect the supported
relay URL. WebSocket upgrades on fallback URLs return `403` and are not a
supported way to connect the local client.

Access gates each read request and WebSocket upgrade on the custom hostname.
Because the relay does not use a Cloudflare Tunnel, it then validates the
signature, issuer, applicable application audience, and expiry of the
`Cf-Access-Jwt-Assertion` token before it serves event data or upgrades the
connection. It obtains the signing keys from the account's Access certificate
endpoint. An identity JWT has an email and a nonempty `sub`. A service-token
JWT has the client ID in `common_name`, an empty `sub`, and no email. The relay
does not require an email claim after Access applies the Allow or Service Auth
policy. Application handlers do not implement a second login system.

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

A hostname application without the Worker-level fallback would leave
`workers.dev`, preview URLs, or a new Worker route outside the policy.

A Worker-level application alone would cover every Worker URL, but Cloudflare
returns `403` for WebSocket upgrades under Worker-level Access.

The relay could trust the Access gate without validating its application token.
Cloudflare requires origins without a Tunnel to validate the token, so this
would not enforce authentication at the relay boundary.
