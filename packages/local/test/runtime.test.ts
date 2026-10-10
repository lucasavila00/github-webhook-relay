import { Parsers } from "@github-webhook-relay/contracts";
import { describe, expect, it } from "vitest";

describe("local runtime", () => {
  it("validates the shared Access token contract", () => {
    const payload = {
      aud: "access-audience",
      exp: 1_800_000_000,
      iss: "https://team.cloudflareaccess.com",
      sub: "identity-subject",
    };

    expect(Parsers.AccessJwtPayload.safeParse(payload).success).toBe(true);
    expect(
      Parsers.AccessJwtPayload.safeParse({ ...payload, exp: "invalid" }).success,
    ).toBe(false);
  });
});
