import type { Cursor, EventFilters } from "@github-webhook-relay/contracts";

export type LocalConfig = Readonly<{
  relayUrl: string;
  stateDirectory: string;
  accessClientId: string;
  accessClientSecret: string;
}>;

export type PendingBatch = Readonly<{
  token: string;
  base?: Cursor;
  checkpoint: Cursor;
}>;

export type ConsumerState = Readonly<{
  version: 1;
  consumer: string;
  filters: EventFilters;
  acknowledged?: Cursor;
  generation: number;
  pending?: PendingBatch;
}>;

import parse from "./generated/parser";

export const LocalParsers = parse.buildParsers<{
  LocalConfig: LocalConfig;
  ConsumerState: ConsumerState;
}>({
  stringFormats: {
    nonEmpty: (input: string): boolean => input.length > 0,
  },
  numberFormats: {
    eventLimit: (input: number): boolean =>
      Number.isInteger(input) && input >= 1 && input <= 1_000,
  },
});
