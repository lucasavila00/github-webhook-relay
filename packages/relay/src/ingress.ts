import type { EventRelay } from "./index.ts";

type IngressEnv = Readonly<{
  EVENT_RELAY: DurableObjectNamespace<EventRelay>;
}>;

const objectName = "github-webhook-relay";

export default {
  fetch(request: Request, env: IngressEnv): Promise<Response> {
    return handleIngressRequest(env.EVENT_RELAY, request);
  },
} satisfies ExportedHandler<IngressEnv>;

export function handleIngressRequest(
  eventRelay: DurableObjectNamespace<EventRelay>,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  return eventRelay.get(eventRelay.idFromName(objectName)).fetch(request);
}
