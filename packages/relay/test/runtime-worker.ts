import ingress from "../src/ingress.ts";
import relay, { EventRelay } from "../src/index.ts";

export { EventRelay };

type TestEnv = Env & Readonly<{ WEBHOOK_SECRET: string }>;

export default {
  fetch(request: Request, env: TestEnv): Promise<Response> {
    return new URL(request.url).hostname === "127.0.0.1"
      ? ingress.fetch(request, env)
      : relay.fetch(request, env);
  },
} satisfies ExportedHandler<TestEnv>;
