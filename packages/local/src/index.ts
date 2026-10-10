export { createNodeCapabilities } from "./adapters.ts";
export { acknowledgeEvents, watchEvents } from "./client.ts";
export type { LocalConfig } from "./parser.ts";
export {
  type Acknowledgement,
  type LocalClientError,
  type LocalErrorCode,
  type WatchRequest,
  type WatchResult,
} from "./types.ts";
