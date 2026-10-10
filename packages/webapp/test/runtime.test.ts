import { SELF } from "cloudflare:test";
import { Parsers } from "@github-webhook-relay/contracts";
import { describe, expect, it } from "vitest";

describe("webapp runtime", () => {
  it("loads the Worker", async () => {
    const response = await SELF.fetch("https://webapp.test/");

    expect(response.status).toBe(501);
    expect(Parsers.Cursor.parse("runtime-test")).toBe("runtime-test");
  });
});
