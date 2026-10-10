# GitHub webhook relay

The relay stores selected GitHub events, serves authenticated history and live
updates, and exposes a local Codex watch tool. See the
[public API reference](docs/public-api.md) and the
[production operations guide](docs/operations.md).

## Purpose

Keep a persistent GitHub event history and deliver events to a webapp and a
local Codex integration. A local client can disconnect and then replay events
from its last processed position. Reading an event does not delete it.

## Components

The pnpm workspace contains the shared core, relay, webapp, local client,
Codex tool, and real-resource E2E packages:

- A Cloudflare Worker and SQLite-backed Durable Object for webhook ingestion,
  persistent event storage, queries, replay, and live subscriptions.
- A browser app for authorized event browsing.
- A local Codex integration that consumes events and connects them to local
  agent work.
- A live harness for GitHub, Cloudflare Access, Chromium, and the MCP tool.

The relay Worker owns the only production deployment. It serves the browser
assets on the same authenticated hostname.

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
