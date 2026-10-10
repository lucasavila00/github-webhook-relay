import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("webapp runtime", () => {
  it("loads the Worker", async () => {
    const response = await SELF.fetch("https://webapp.test/");

    expect(response.status).toBe(501);
  });
});
