# The problem

## GitHub activity and local agent work

Lucas needs local Codex work to respond to GitHub activity across his
repositories. Issue creation, issue comments, pull request comments, and pull
request merges can change what needs attention. He needs one place to inspect
these events and a reliable way to deliver them to local tools.

Repeatedly checking GitHub for changes adds delay and repeated work. A live
connection alone is insufficient: the local machine can be offline, a process
can restart, or a connection can fail while new events arrive.

## History and continuity

Events must remain available after they are delivered. Reading an event must
not remove it from the history. Keep stored events indefinitely. Do not add
a retention limit, automatic expiration, or cleanup process. The developer
needs to search and filter past events, and a consumer needs to replay them
from a known position.

Each consumer has its own progress. A webapp and a local client can read the
same event without taking it away from each other. A reconnect must continue
from the last processed position, without losing events between stored history
and live delivery. Repeated GitHub deliveries and replayed events must not
cause duplicate work.

## Access from the browser and local machine

The product is for Lucas alone. Shared access and multiple user accounts are
outside its scope. Cloudflare Access protects browser access, and only Lucas
can use it. The local tool uses a revocable Cloudflare Access service token.
The public GitHub webhook hostname is separate from the protected relay
hostname. It does not serve the browser, history API, or event stream.

The local machine connects outbound. It must not need a public listening port
or a Cloudflare Tunnel, and it can be offline when GitHub sends a webhook.
Event storage and delivery continue while the local consumer is disconnected.

## Events and actions

The relay records and delivers GitHub events. The local integration connects
those events to local Codex work. Event receipt and permission to act are
separate: receiving a message alone does not authorize a code change or merge.

The events in scope are:

- Creation of an issue.
- Comments on issues.
- Comments on pull requests.
- Merging of a pull request.

These events must be available to the local Codex integration. The exact
integration is a local `gh-watch` tool that an existing Codex session calls.
The call waits for repository events, then returns the events and a cursor.
Each consumer keeps its own progress. The tool does not launch, wake, resume,
or control a Codex session, and it does not take an action automatically.

## Desired result

- GitHub events are stored before receipt is acknowledged.
- The developer can inspect and filter persistent event history in a webapp.
- Connected consumers receive new events without repeated history polling.
- Disconnected consumers can resume from their own saved progress.
- Multiple consumers can read the same history independently.
- Local Codex work can use the events without requiring an inbound endpoint.
- Authentication controls access to history and live subscriptions.

The [public API](../../README.md) describes the proposed interface. The
[code architecture](../code-architecture.md) describes the technical approach.
