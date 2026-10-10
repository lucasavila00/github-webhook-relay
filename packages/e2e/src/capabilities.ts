import type { Capability } from "@beff/diy/capabilities";
import type { Event, WatchResult } from "@github-webhook-relay/core";

export type HttpCapability = Capability<
  "http",
  Readonly<{ fetch: typeof globalThis.fetch }>
>;
export type ClockCapability = Capability<
  "clock",
  Readonly<{
    now: () => Date;
    sleep: (milliseconds: number) => Promise<void>;
  }>
>;
export type BrowserCapability = Capability<
  "browser",
  Readonly<{
    verify: (
      relayUrl: string,
      repository: string,
      expected: ReadonlyArray<Event>,
      triggerLiveEvent: () => Promise<Event>,
    ) => Promise<void>;
  }>
>;
export type ToolSession = Readonly<{
  watch: () => Promise<WatchResult>;
  acknowledge: (result: WatchResult) => Promise<void>;
  close: () => Promise<void>;
}>;
export type ToolCapability = Capability<
  "tool",
  Readonly<{
    open: (consumer: string, stateDirectory: string) => Promise<ToolSession>;
  }>
>;
export type OutputCapability = Capability<
  "output",
  Readonly<{ write: (value: string) => void }>
>;
