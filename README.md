# GitHub webhook relay

The shared event and transport contract is implemented. See the
[public API reference](docs/public-api.md) for its complete behavior.

To run your own relay, follow [Getting started](docs/getting-started.md). See
[Deployment](docs/deployment.md) for the Cloudflare configuration and deploy
commands.

## Purpose

Keep a persistent GitHub event history and deliver events to a webapp and a
local Codex integration. A local client can disconnect and then replay events
from its last processed position. Reading an event does not delete it.

## Components

The pnpm workspace contains five packages:

- A core package owns shared data types and validators.
- A relay package owns two Cloudflare Workers and one SQLite-backed Durable
  Object. The public Worker accepts signed webhooks. The Access-protected
  Worker serves event history, live subscriptions, and the webapp.
- A webapp package owns the browser and asset server functions.
- A local package connects outbound to the relay and saves consumer cursors.
- A Codex tool package exposes the local client through the `gh-watch` plugin.

See the [workspace guide](docs/workspace.md) for component ownership and the
[deployment guide](docs/deployment.md) for production setup.

## Public API

### Receive GitHub events

`POST /webhooks/github` receives GitHub webhook deliveries. It verifies the
GitHub signature and stores the original payload before acknowledging receipt.
Repeated delivery IDs refer to the same stored event.

GitHub uses its webhook secret. Client credentials cannot submit webhook
payloads through the read API.

### Read event history

`GET /api/events?after=<cursor>&limit=<count>` returns events in stored order.
Optional `repository=owner/name` and `type=issues` filters select events.
Omitting `after` starts at the beginning of stored history.

Example response:

```json
{
  "events": [
    {
      "id": "event_42",
      "deliveryId": "github-delivery-id",
      "type": "issues",
      "repository": "owner/repo",
      "receivedAt": "2026-10-10T13:00:00Z",
      "payload": {}
    }
  ],
  "cursor": "cursor_42",
  "hasMore": false
}
```

IDs and cursors are non-empty opaque strings. The cursor identifies how far
the server has scanned, including events excluded by filters. Clients use the
returned cursor for the next page. GitHub payloads retain their original
shape.

### Subscribe and resume

`GET /api/events/stream` upgrades to a WebSocket connection. A client sends:

```json
{
  "type": "subscribe",
  "after": "cursor_42",
  "filters": {"repository": "owner/repo", "type": "issues"}
}
```

The server replays matching events after the cursor, then sends live events
on the same connection. Omitting `after` requests stored history first.

Event and checkpoint message shapes are in the
[public API reference](docs/public-api.md#event-stream).

A checkpoint follows the events it covers. Clients save it after processing
those events and send it on reconnect. Replay and live delivery must have no
gap. Reconnects can repeat events; clients use event IDs to avoid duplicate
work. Each consumer keeps its own cursor.

### Authentication and errors

Event history and subscriptions require Cloudflare Access authentication. The
Worker verifies the Access JWT signature, issuer, audience, and expiry before
it forwards a request to the event relay. It accepts an identity principal or
a service-token principal.

HTTP errors use a JSON body with `error.code` and `error.message`. Invalid
input uses status 400. Application authentication failures use status 401 or
403. Unexpected failures use status 500. WebSocket credentials must work for
both browser and local clients.

## Local Codex integration

The local client connects outbound; it does not need a public listening port.
It saves independent consumer cursors and resumes after a restart. See the
[local client guide](docs/local-client.md) for its watch and acknowledgement
contract. Receiving an event alone does not authorize a code change or merge.
