import { createHmac, randomBytes } from "node:crypto";
import { request } from "node:https";

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const relayUrl = required("RELAY_URL");
const alternateRelayUrl = required("ALTERNATE_RELAY_URL");
const clientId = required("ACCESS_CLIENT_ID");
const clientSecret = required("ACCESS_CLIENT_SECRET");
const webhookSecret = required("GITHUB_WEBHOOK_SECRET");

const serviceHeaders = (secret) => ({
  "CF-Access-Client-Id": clientId,
  "CF-Access-Client-Secret": secret,
});

const expectStatus = (label, status, accepted) => {
  if (!accepted.includes(status)) {
    throw new Error(`${label} returned ${status}. Expected ${accepted.join(" or ")}.`);
  }
  process.stdout.write(`${label}: ${status}\n`);
};

const getUpgradeStatus = (baseUrl, headers) =>
  new Promise((resolve, reject) => {
    const url = new URL("/api/events/stream", baseUrl);
    const call = request(url, {
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    call.on("response", (response) => resolve(response.statusCode ?? 0));
    call.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 101);
    });
    call.on("error", reject);
    call.end();
  });

const validHttp = await fetch(new URL("/api/events", relayUrl), {
  headers: serviceHeaders(clientSecret),
});
expectStatus("valid service HTTP", validHttp.status, [501]);

const invalidHttp = await fetch(new URL("/api/events", relayUrl), {
  headers: serviceHeaders(`${clientSecret}-invalid`),
  redirect: "manual",
});
if (invalidHttp.status === 501) {
  throw new Error("invalid service HTTP reached the Worker.");
}
process.stdout.write(`invalid service HTTP: ${invalidHttp.status}\n`);

const customUpgrade = await getUpgradeStatus(relayUrl, serviceHeaders(clientSecret));
expectStatus("custom-host WebSocket", customUpgrade, [101, 501]);

const alternateUpgrade = await getUpgradeStatus(
  alternateRelayUrl,
  serviceHeaders(clientSecret),
);
expectStatus("alternate-host WebSocket", alternateUpgrade, [403]);

const webhookBody = JSON.stringify({ zen: "access-smoke" });
const webhookSignature = createHmac("sha256", webhookSecret)
  .update(webhookBody)
  .digest("hex");
const webhook = await fetch(new URL("/webhooks/github", relayUrl), {
  method: "POST",
  body: webhookBody,
  headers: { "X-Hub-Signature-256": `sha256=${webhookSignature}` },
});
expectStatus("signed webhook", webhook.status, [501]);

const invalidWebhook = await fetch(new URL("/webhooks/github", relayUrl), {
  method: "POST",
  body: webhookBody,
  headers: { "X-Hub-Signature-256": "sha256=invalid" },
});
expectStatus("invalid webhook", invalidWebhook.status, [401]);
