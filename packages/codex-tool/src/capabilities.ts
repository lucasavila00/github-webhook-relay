import type { Capability } from "@beff/diy/capabilities";
import type {
  Acknowledgement,
  WatchRequest,
  WatchResult,
} from "@github-webhook-relay/local";

export type Environment = Readonly<{
  read: (name: string) => string | null | undefined;
}>;

export type LocalClient = Readonly<{
  watch: (request: WatchRequest) => Promise<WatchResult>;
  acknowledge: (acknowledgement: Acknowledgement) => Promise<void>;
}>;

export type EnvironmentCapability = Capability<"environment", Environment>;
export type LocalClientCapability = Capability<"localClient", LocalClient>;
