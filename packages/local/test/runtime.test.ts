import { Parsers } from "@github-webhook-relay/contracts";
import { describe, expect, it } from "vitest";

describe("local runtime", () => {
  it("loads the generated shared contract", () => {
    expect(Parsers).toEqual({});
  });
});
