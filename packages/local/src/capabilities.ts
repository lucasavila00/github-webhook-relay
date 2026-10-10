import type { Capability } from "@beff/diy/capabilities";

import type { LocalConfig } from "./parser.ts";
import type { SocketService } from "./types.ts";

export type Clock = Readonly<{
  now: () => number;
  setTimer: (callback: () => void, milliseconds: number) => () => void;
}>;

export type FileStorage = Readonly<{
  ensureDirectory: (path: string) => Promise<void>;
  read: (path: string) => Promise<string | undefined>;
  writeAtomic: (path: string, value: string) => Promise<void>;
}>;

export type ProcessService = Readonly<{
  withFileLock: <T>(path: string, action: () => Promise<T>) => Promise<T>;
}>;

export type HttpClient = Readonly<{
  fetch: typeof globalThis.fetch;
}>;

export type ClockCapability = Capability<"clock", Clock>;
export type ConfigCapability = Capability<"config", LocalConfig>;
export type HttpCapability = Capability<"http", HttpClient>;
export type NetworkCapability = Capability<"network", SocketService>;
export type ProcessCapability = Capability<"process", ProcessService>;
export type StorageCapability = Capability<"storage", FileStorage>;

export type LocalCapabilities =
  | ClockCapability
  | ConfigCapability
  | HttpCapability
  | NetworkCapability
  | ProcessCapability
  | StorageCapability;

export type WatchCapability =
  | ClockCapability
  | ConfigCapability
  | NetworkCapability
  | ProcessCapability
  | StorageCapability;

export type AcknowledgeCapability =
  | ConfigCapability
  | ProcessCapability
  | StorageCapability;
