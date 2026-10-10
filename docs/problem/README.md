# The problem

## GitHub activity and local agent work

A developer needs local Codex work to respond to GitHub activity across their
repositories. Issues, comments, reviews, merges, and CI results can change
what needs attention. The developer needs one place to inspect these events
and a reliable way to deliver them to local tools.

Repeatedly checking GitHub for changes adds delay and repeated work. A live
connection alone is insufficient: the local machine can be offline, a process
can restart, or a connection can fail while new events arrive.

## History and continuity

Events must remain available after they are delivered. Reading an event must
not remove it from the history. The developer needs to search and filter past
events, and a consumer needs to replay them from a known position.

Each consumer has its own progress. A webapp and a local client can read the
same event without taking it away from each other. A reconnect must continue
from the last processed position, without losing events between stored history
and live delivery. Repeated GitHub deliveries and replayed events must not
cause duplicate work.

## Access from the browser and local machine

The webapp provides event browsing through a server with authentication. The
local Codex integration consumes the same event history and live stream.
Both need authorized access. Local credentials must be revocable.

The local machine connects outbound. It must not need a public listening port
or be online when GitHub sends a webhook. Event storage and delivery continue
while the local consumer is disconnected.

## Events and actions

The relay records and delivers GitHub events. The local integration connects
those events to local Codex work. Event receipt and permission to act are
separate: receiving a message alone does not authorize a code change or merge.

The intended automatic actions, the events that trigger them, and how they
connect to existing local work still need a product definition. The same is
true of whether access is limited to one developer or shared with other users,
and how long stored history must remain available.

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
