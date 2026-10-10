import { DurableObject } from "cloudflare:workers";

const notImplemented = (): Response => new Response(null, { status: 501 });

export class EventRelay extends DurableObject<Env> {
  override fetch(): Response {
    return notImplemented();
  }
}

export default {
  fetch(): Response {
    return notImplemented();
  },
} satisfies ExportedHandler<Env>;
