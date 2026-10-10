import process from "node:process";

import { Parsers, type Event, type LiveE2eReport } from "@github-webhook-relay/core";

import { verifyDeniedAccess } from "./access.ts";
import { createAdapters } from "./adapters.ts";
import { readConfig } from "./config.ts";
import {
  createGitHubEvents,
  createLiveIssueComment,
  redeliverIssueEvent,
} from "./github.ts";
import { readAllEvents, waitForEvent, waitForEvents } from "./relay.ts";

const config = readConfig(process.env);
const capabilities = createAdapters(config);

await verifyDeniedAccess(capabilities, config);
const created = await createGitHubEvents(capabilities, config);
const events = await waitForEvents(capabilities, config, created.marker);
await capabilities.browser.verify(
  config.relayUrl,
  config.githubRepository,
  events,
  async () => {
    const marker = await createLiveIssueComment(
      capabilities,
      config,
      created.issue,
    );
    return waitForEvent(capabilities, config, marker);
  },
);

const issueDelivery = events.find(({ type }) => type === "issues");
if (issueDelivery === undefined) throw new Error("The issue event is missing.");
const deliveryId = await redeliverIssueEvent(
  capabilities,
  config,
  issueDelivery.deliveryId,
);
const afterRedelivery = await readAllEvents(capabilities, config);
if (afterRedelivery.filter((event) => event.deliveryId === deliveryId).length !== 1) {
  throw new Error("The repeated GitHub delivery was not stored exactly once.");
}

await verifyToolReplay(capabilities, config.stateDirectory, events);
await verifyIndependentConsumers(capabilities, config.stateDirectory, events);

const report: LiveE2eReport = Parsers.LiveE2eReport.parse({
  testedCommit: config.testedCommit,
  actionsRunUrl: config.actionsRunUrl,
  repository: config.githubRepository,
  dependencyCommits: [
    "relay:bc7bce049b44f9d5f741d84ef00eeb427e47ce60",
    "access:20e04f4587d5cbad19b710d9ad226e3583a92b6b",
    "history:f0cc5ec93f7b61ea9a0f649fde3e212dee553954",
    "stream:19e653cd3a440d8a817b4038fb284b3ddb07ce9e",
    "local:e1eb4027f32129c4e874b836370cc79df31e1fa0",
    "core:5bdaec7455115d1af4ed739b91b8538831e07e7b",
    "codex-tool:f1526416d4f396fe295bba9df14a20ab391bbbe9",
    "webapp:582c199c1561bde26a9757b109ea6ad8d9f9a44b",
  ],
  eventTypes: [
    "issues",
    "issue_comment",
    "pull_request_review_comment",
    "pull_request",
  ],
  browserVerified: true,
  duplicateVerified: true,
  offlineReplayVerified: true,
  independentConsumersVerified: true,
});
capabilities.output.write(JSON.stringify(report));

async function verifyToolReplay(
  toolCapabilities: ReturnType<typeof createAdapters>,
  stateDirectory: string,
  expected: ReadonlyArray<Event>,
): Promise<void> {
  const consumer = `live-e2e-offline-${toolCapabilities.clock.now().getTime()}`;
  let session = await toolCapabilities.tool.open(consumer, stateDirectory);
  const expectedIds = new Set(expected.map(({ id }) => id));
  const found = new Set<string>();
  let replayed = false;
  while (found.size < expectedIds.size) {
    const batch = await session.watch();
    if (batch.type !== "batch") throw new Error("The watch tool timed out.");
    const containsTarget = batch.events.some(({ id }) => expectedIds.has(id));
    if (containsTarget && !replayed) {
      await session.close();
      session = await toolCapabilities.tool.open(consumer, stateDirectory);
      const repeated = await session.watch();
      requireSameBatch(batch, repeated);
      collectExpected(repeated, expectedIds, found);
      await session.acknowledge(repeated);
      replayed = true;
    } else {
      collectExpected(batch, expectedIds, found);
      await session.acknowledge(batch);
    }
  }
  await session.close();
  if (!replayed) throw new Error("No target batch was replayed.");
}

async function verifyIndependentConsumers(
  toolCapabilities: ReturnType<typeof createAdapters>,
  stateDirectory: string,
  expected: ReadonlyArray<Event>,
): Promise<void> {
  const suffix = toolCapabilities.clock.now().getTime();
  const first = await toolCapabilities.tool.open(`live-e2e-a-${suffix}`, stateDirectory);
  const second = await toolCapabilities.tool.open(`live-e2e-b-${suffix}`, stateDirectory);
  try {
    await Promise.all([
      scanExpected(first, expected),
      scanExpected(second, expected),
    ]);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}

async function scanExpected(
  session: Awaited<ReturnType<ReturnType<typeof createAdapters>["tool"]["open"]>>,
  expected: ReadonlyArray<Event>,
): Promise<void> {
  const expectedIds = new Set(expected.map(({ id }) => id));
  const found = new Set<string>();
  while (found.size < expectedIds.size) {
    const batch = await session.watch();
    if (batch.type !== "batch") throw new Error("The watch tool timed out.");
    collectExpected(batch, expectedIds, found);
    await session.acknowledge(batch);
  }
}

function collectExpected(
  result: unknown,
  expectedIds: ReadonlySet<string>,
  found: Set<string>,
): void {
  const parsed = Parsers.WatchResult.parse(result);
  if (parsed.type !== "batch") throw new Error("The watch tool timed out.");
  for (const event of parsed.events) {
    if (expectedIds.has(event.id)) found.add(event.id);
  }
}

function requireSameBatch(first: unknown, second: unknown): void {
  const a = Parsers.WatchResult.parse(first);
  const b = Parsers.WatchResult.parse(second);
  if (a.type !== "batch" || b.type !== "batch") {
    throw new Error("The offline watch did not return a batch.");
  }
  if (JSON.stringify(a.events) !== JSON.stringify(b.events)) {
    throw new Error("The unacknowledged batch did not repeat.");
  }
}
