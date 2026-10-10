import { createHmac } from "node:crypto";
import "@vitest/browser-playwright";
import type { BrowserCommandContext } from "vitest/node";

export type BrowserFlowResult = Readonly<{
  title: string;
  firstPayload: string;
  olderCount: number;
  laterCount: number;
  filteredCount: number;
  liveCount: number;
  disconnected: string;
  empty: string;
  error: string;
}>;

export async function runRenderedFlow(
  context: BrowserCommandContext,
): Promise<BrowserFlowResult> {
  const relayUrl = required(process.env.RELAY_BROWSER_URL);
  const directUrl = required(process.env.RELAY_DIRECT_URL);
  await seedEvents(directUrl, 26);
  const token = required(process.env.RELAY_BROWSER_TOKEN);
  await context.context.addCookies([{
    name: "CF_Authorization",
    value: token,
    domain: "localhost",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  }]);
  const page = await context.context.newPage();
  page.setDefaultTimeout(4_000);
  const navigation = await page.goto(relayUrl);
  if (navigation?.status() !== 200) {
    throw new Error(`Browser navigation returned ${navigation?.status()}.`);
  }
  const title = await page.getByRole("heading", { level: 1 }).innerText();
  await page.getByRole("button", { name: /issues owner\/repository/u }).first().click();
  const firstPayload = await page.getByRole("complementary").innerText();
  const olderCount = await page.locator("ol li").count();

  await page.getByRole("button", { name: "Later" }).click();
  await page.getByText("Live events connected.").waitFor();
  const laterCount = await page.locator("ol li").count();
  await page.getByRole("button", { name: "Older" }).click();
  await page.getByRole("button", { name: "Later" }).click();

  await page.getByLabel("Event type").selectOption("issues");
  await page.getByRole("button", { name: "Apply filters" }).click();
  const loading = page.getByText("Loading events…");
  await loading.waitFor();
  await loading.waitFor({ state: "hidden" });
  await page.getByText("Live events connected.").waitFor();
  const filteredCount = await page.locator("ol li").count();

  const disconnectedMessage = page.getByText(/disconnected/u);
  const disconnectedResult = disconnectedMessage.innerText({ timeout: 30_000 });
  await seedExcludedEvents(directUrl);
  const disconnected = await disconnectedResult;
  await seedEvent(directUrl, "live-after-disconnect", 1_027, "issues");
  await page.getByText("Live events connected.").waitFor({ timeout: 15_000 });
  await page.locator("ol li").nth(13).waitFor({ timeout: 15_000 });
  await page.locator("ol li button").last().click();
  await page.getByRole("complementary").getByText(/"marker": 1027/u).waitFor();
  const liveCount = await page.locator("ol li").count();

  await page.getByLabel("Repository").fill("no/events");
  await page.getByRole("button", { name: "Apply filters" }).click();
  const empty = await page.getByText("No events match these filters.").innerText();

  await page.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": "invalid" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  const error = await page.getByRole("alert").innerText();
  await page.close();
  return {
    title,
    firstPayload,
    olderCount,
    laterCount,
    filteredCount,
    liveCount,
    disconnected,
    empty,
    error,
  };
}

async function seedEvents(relayUrl: string, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await seedEvent(
      relayUrl,
      `browser-${index}`,
      index,
      index % 2 === 0 ? "issue_comment" : "issues",
    );
  }
}

async function seedExcludedEvents(relayUrl: string): Promise<void> {
  for (let index = 27; index <= 1_026; index += 1) {
    await seedEvent(relayUrl, `budget-${index}`, index, "issue_comment");
  }
}

async function seedEvent(
  relayUrl: string,
  delivery: string,
  index: number,
  type: "issues" | "issue_comment",
): Promise<void> {
  const body = JSON.stringify({
    action: type === "issues" ? "opened" : "created",
    repository: { full_name: "owner/repository" },
    marker: index,
    ...(type === "issue_comment"
      ? { issue: { number: index }, comment: { id: index } }
      : {}),
  });
  const signature = createHmac("sha256", "test-secret").update(body).digest("hex");
  const response = await fetch(`${relayUrl}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": delivery,
      "x-github-event": type,
      "x-hub-signature-256": `sha256=${signature}`,
      "Cf-Access-Jwt-Assertion": required(process.env.RELAY_BROWSER_TOKEN),
    },
    body,
  });
  if (response.status !== 202) {
    throw new Error(
      `Webhook ${delivery} returned ${response.status}: ${await response.text()}`,
    );
  }
}

function required(value: string | undefined): string {
  if (value === undefined) throw new Error("The browser test is not configured.");
  return value;
}
