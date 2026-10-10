export { createNodeCapabilities } from "./adapters.ts";
export { acknowledgeEvents, watchEvents } from "./client.ts";
export type {
  Acknowledgement,
  LocalConfig,
  WatchRequest,
  WatchResult,
} from "@github-webhook-relay/core";
export {
  type LocalClientError,
  type LocalErrorCode,
} from "./types.ts";
