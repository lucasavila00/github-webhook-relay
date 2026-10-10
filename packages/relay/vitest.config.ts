import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACCESS_AUD: "test-audience",
          ACCESS_TEAM_DOMAIN: "https://access.test",
          WEBHOOK_SECRET: "test-secret",
        },
      },
    }),
  ],
});
