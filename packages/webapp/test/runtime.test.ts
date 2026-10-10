import { SELF } from "cloudflare:test";
import { Parsers } from "@github-webhook-relay/contracts";
import { describe, expect, it } from "vitest";

describe("webapp runtime", () => {
  it("loads the Worker", async () => {
    const response = await SELF.fetch("https://webapp.test/");

    expect(response.status).toBe(501);
    expect(Parsers.Cursor.parse("runtime-test")).toBe("runtime-test");
  });

  it("validates the shared Access key contract", () => {
    const key = {
      alg: "RS256",
      e: "AQAB",
      kid: "key-id",
      kty: "RSA",
      n: "modulus",
      use: "sig",
    };

    expect(Parsers.AccessKeySet.safeParse({ keys: [key] }).success).toBe(true);
    expect(
      Parsers.AccessKeySet.safeParse({ keys: [{ ...key, use: "enc" }] }).success,
    ).toBe(false);
  });
});
