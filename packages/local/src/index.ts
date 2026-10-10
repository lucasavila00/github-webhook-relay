export { createNodeCapabilities } from "./adapters.ts";
export { acknowledgeEvents, watchEvents } from "./client.ts";
export type { LocalConfig } from "@github-webhook-relay/core";
export type {
  Acknowledgement,
  WatchRequest,
  WatchResult,
} from "@github-webhook-relay/core";
export {
  type LocalClientError,
  type LocalErrorCode,
} from "./types.ts";
