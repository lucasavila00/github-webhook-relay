import { server } from "vitest/browser";
import { describe, expect, it } from "vitest";

import type { BrowserFlowResult } from "./browser-command.ts";

declare module "vitest/browser" {
  interface BrowserCommands {
    runRenderedFlow: () => Promise<BrowserFlowResult>;
  }
}

describe("rendered event inspector", () => {
  it("uses real history, assets, and WebSockets", async () => {
    const result = await server.commands.runRenderedFlow();
    expect(result.title).toBe("GitHub event history");
    expect(result.firstPayload).toContain('"marker": 1');
    expect(result.olderCount).toBe(25);
    expect(result.laterCount).toBe(1);
    expect(result.filteredCount).toBe(13);
    expect(result.liveCount).toBe(14);
    expect(result.disconnected).toContain("disconnected");
    expect(result.empty).toBe("No events match these filters.");
    expect(result.error.length).toBeGreaterThan(0);
  }, 45_000);
});
