import { env, SELF } from "cloudflare:test";
import { Parsers } from "@github-webhook-relay/contracts";
import { describe, expect, it } from "vitest";

describe("relay runtime", () => {
  it("loads the Worker and SQLite Durable Object binding", async () => {
    const workerResponse = await SELF.fetch("https://relay.test/");
    const id = env.EVENT_RELAY.idFromName("runtime-test");
    const objectResponse = await env.EVENT_RELAY.get(id).fetch(
      "https://relay.test/",
    );

    expect(workerResponse.status).toBe(501);
    expect(objectResponse.status).toBe(501);
    expect(Parsers.Cursor.parse("runtime-test")).toBe("runtime-test");
  });
});
