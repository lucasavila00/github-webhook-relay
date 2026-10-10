import type { EventFilters } from "@github-webhook-relay/contracts";
import type { NumberFormat, StringFormat } from "@beff/client";

type NonEmptyString = StringFormat<"nonEmpty">;
type WaitMilliseconds = NumberFormat<"waitMilliseconds">;

export type WatchToolInput = Readonly<{
  consumer: NonEmptyString;
  filters: EventFilters;
  waitMilliseconds: WaitMilliseconds;
}>;

export type AcknowledgeToolInput = Readonly<{
  acknowledgement: Readonly<{ value: NonEmptyString }>;
}>;

import parse from "./generated/parser";

export const ToolParsers = parse.buildParsers<{
  WatchToolInput: WatchToolInput;
  AcknowledgeToolInput: AcknowledgeToolInput;
}>({
  stringFormats: {
    nonEmpty: (input: string): boolean => input.length > 0,
  },
  numberFormats: {
    waitMilliseconds: (input: number): boolean =>
      Number.isInteger(input) && input >= 1 && input <= 55_000,
  },
});
