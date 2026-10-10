import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { runRenderedFlow } from "./test/browser-command.ts";

export default defineConfig({
  test: {
    include: ["test/browser.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright(),
      commands: { runRenderedFlow },
    },
  },
});
