# Webapp

The authenticated webapp displays stored GitHub events on the relay custom
hostname. Cloudflare Access protects the browser assets, HTTP history API, and
WebSocket stream. The browser does not implement another login or session.
The Worker prefers the `Cf-Access-Jwt-Assertion` header. If that header is
absent, it reads the same Access JWT from the `CF_Authorization` browser
cookie. Both transports use the same signature, issuer, audience, and expiry
checks. An invalid assertion header does not fall back to the cookie.

The page filters events by exact repository and event type. It reads pages in
stored order, retains loaded pages for older navigation, and loads later pages
with the returned cursor. Selecting an event shows its original JSON payload.

At the last history page, the browser subscribes after the page cursor. It
applies event and checkpoint messages in order. It reconnects after the last
processed checkpoint and removes repeated event IDs. Stored history stays
visible during loading, errors, and connection interruptions.

`packages/relay` owns deployment. It builds the Preact app with Vite, uploads
the output through Wrangler static assets, and serves it from the authenticated
relay Worker. `packages/webapp` has no separate production Worker.
