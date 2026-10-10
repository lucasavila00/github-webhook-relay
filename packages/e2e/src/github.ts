import type { Capabilities } from "@beff/diy/capabilities";
import {
  Parsers,
  type GitHubE2eDelivery,
  type LiveE2eConfig,
} from "@github-webhook-relay/core";

import type { ClockCapability, HttpCapability } from "./capabilities.ts";

type GitHubCapabilities = ClockCapability | HttpCapability;
type CreatedEvents = Readonly<{
  issue: number;
  pullRequest: number;
  marker: string;
}>;

export async function createGitHubEvents(
  capabilities: Capabilities<GitHubCapabilities>,
  config: LiveE2eConfig,
): Promise<CreatedEvents> {
  const marker = `relay-e2e-${capabilities.clock.now().toISOString()}`;
  const repository = await githubJson(
    capabilities,
    config,
    "",
    { method: "GET" },
    Parsers.GitHubE2eRepository.parse,
  );
  const issue = await githubJson(
    capabilities,
    config,
    "/issues",
    jsonRequest({ title: marker, body: marker }),
    Parsers.GitHubE2eIssue.parse,
  );
  await github(capabilities, config, `/issues/${issue.number}/comments`,
    jsonRequest({ body: marker }));

  const base = await githubJson(
    capabilities,
    config,
    `/git/ref/heads/${encodeURIComponent(repository.default_branch)}`,
    { method: "GET" },
    Parsers.GitHubE2eReference.parse,
  );
  const branch = `relay-e2e-${capabilities.clock.now().getTime()}`;
  await github(capabilities, config, "/git/refs", jsonRequest({
    ref: `refs/heads/${branch}`,
    sha: base.object.sha,
  }));
  const path = `.github-webhook-relay-e2e/${branch}.txt`;
  await github(capabilities, config, `/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: marker,
      content: Buffer.from(`${marker}\n`).toString("base64"),
      branch,
    }),
  });
  const pull = await githubJson(
    capabilities,
    config,
    "/pulls",
    jsonRequest({
      title: marker,
      body: marker,
      head: branch,
      base: repository.default_branch,
    }),
    Parsers.GitHubE2ePullRequest.parse,
  );
  await github(capabilities, config, `/pulls/${pull.number}/comments`,
    jsonRequest({
      body: marker,
      commit_id: pull.head.sha,
      path,
      line: 1,
      side: "RIGHT",
    }));
  await github(capabilities, config, `/pulls/${pull.number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ commit_title: marker, merge_method: "merge" }),
  });
  return { issue: issue.number, pullRequest: pull.number, marker };
}

export async function redeliverIssueEvent(
  capabilities: Capabilities<GitHubCapabilities>,
  config: LiveE2eConfig,
  deliveryId: string,
): Promise<string> {
  const deliveries = await readDeliveries(capabilities, config);
  const delivery = deliveries.find(({ guid }) => guid === deliveryId);
  if (delivery == null) throw new Error("No issue delivery is available.");
  await github(
    capabilities,
    config,
    `/hooks/${config.githubHookId}/deliveries/${delivery.id}/attempts`,
    { method: "POST" },
  );
  const deadline = capabilities.clock.now().getTime() + 60_000;
  while (capabilities.clock.now().getTime() < deadline) {
    const current = (await readDeliveries(capabilities, config))
      .find(({ guid }) => guid === delivery.guid);
    if (
      current?.redelivery === true &&
      current.delivered_at !== delivery.delivered_at &&
      current.status_code === 202
    ) {
      return delivery.guid;
    }
    await capabilities.clock.sleep(2_000);
  }
  throw new Error("GitHub did not complete the repeated delivery in one minute.");
}

export async function createLiveIssueComment(
  capabilities: Capabilities<GitHubCapabilities>,
  config: LiveE2eConfig,
  issue: number,
): Promise<string> {
  const marker = `relay-e2e-live-${capabilities.clock.now().toISOString()}`;
  await github(
    capabilities,
    config,
    `/issues/${issue}/comments`,
    jsonRequest({ body: marker }),
  );
  return marker;
}

async function readDeliveries(
  capabilities: Capabilities<HttpCapability>,
  config: LiveE2eConfig,
): Promise<ReadonlyArray<GitHubE2eDelivery>> {
  const response = await github(
    capabilities,
    config,
    `/hooks/${config.githubHookId}/deliveries?per_page=100`,
    { method: "GET" },
  );
  const input: unknown = await response.json();
  if (!Array.isArray(input)) throw new Error("GitHub deliveries are invalid.");
  return input.map((value) => Parsers.GitHubE2eDelivery.parse(value));
}

async function githubJson<T>(
  capabilities: Capabilities<HttpCapability>,
  config: LiveE2eConfig,
  path: string,
  init: RequestInit,
  parse: (input: unknown) => T,
): Promise<T> {
  return parse(await (await github(capabilities, config, path, init)).json());
}

async function github(
  capabilities: Capabilities<HttpCapability>,
  config: LiveE2eConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const response = await capabilities.http.fetch(
    `https://api.github.com/repos/${config.githubRepository}${path}`,
    {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${config.githubToken}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub request ${path} failed with ${response.status}.`);
  }
  return response;
}

function jsonRequest(value: Readonly<Record<string, unknown>>): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}
