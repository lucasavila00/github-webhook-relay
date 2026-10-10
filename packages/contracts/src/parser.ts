import parse from "./generated/parser";
import type { AccessJwtHeader, AccessJwtPayload, AccessKeySet } from "./index.ts";

export const Parsers = parse.buildParsers<{
  AccessJwtHeader: AccessJwtHeader;
  AccessJwtPayload: AccessJwtPayload;
  AccessKeySet: AccessKeySet;
}>();
