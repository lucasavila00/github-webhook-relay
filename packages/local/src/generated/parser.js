//@ts-nocheck

"use strict";

import {
  TypeofRuntype,
  AnyRuntype,
  NullishRuntype,
  NeverRuntype,
  ConstRuntype,
  RegexRuntype,
  DateRuntype,
  BigIntRuntype,
  StringWithFormatRuntype,
  NumberWithFormatRuntype,
  AnyOfConstsRuntype,
  TupleRuntype,
  AllOfRuntype,
  AnyOfRuntype,
  ArrayRuntype,
  AnyOfDiscriminatedRuntype,
  ObjectRuntype,
  OptionalFieldRuntype,
  BaseRefRuntype,
  registerStringFormatter,
  registerNumberFormatter,
  buildParserFromRuntype,
  generateHashFromString,
  TypedArrayRuntype,
  MapRuntype,
  SetRuntype,
} from "@beff/client/codegen-v2";

class RefRuntype extends BaseRefRuntype  {
  getNamedRuntypes() {
    return namedRuntypes;
  }
}

const buildParsers = (args) => {
  const stringFormats = args?.stringFormats ?? {};
  for (const k of RequiredStringFormats) {
    if (stringFormats[k] == null) {
      throw new Error(`Missing custom format ${k}`);
    }
  }
  Object.keys(stringFormats).forEach((k) => {
    const v = stringFormats[k];
    registerStringFormatter(k, v);
  });
  const numberFormats = args?.numberFormats ?? {};
  for (const k of RequiredNumberFormats) {
    if (numberFormats[k] == null) {
      throw new Error(`Missing custom format ${k}`);
    }
  }
  Object.keys(numberFormats).forEach((k) => {
    const v = numberFormats[k];
    registerNumberFormatter(k, v);
  });
  let acc = {};
  for (const k of Object.keys(buildParsersInput)) {
    const it = buildParserFromRuntype(buildParsersInput[k], k, false);
    acc[k] = it;
  }
  return acc;
};

const RequiredStringFormats = ["nonEmpty"];
const RequiredNumberFormats = ["eventLimit"];
const direct_hoist_0 = new RefRuntype(undefined, "LocalConfig");
const direct_hoist_1 = new RefRuntype(undefined, "ConsumerState");
const direct_hoist_2 = new RefRuntype(undefined, "NonEmptyString");
const direct_hoist_3 = new TypeofRuntype(undefined, "string");
const direct_hoist_4 = new RefRuntype(undefined, "EventType");
const direct_hoist_5 = new ObjectRuntype(undefined, {
    "repository": new OptionalFieldRuntype(direct_hoist_3),
    "type": new OptionalFieldRuntype(direct_hoist_4)
}, []);
const direct_hoist_6 = new AnyOfConstsRuntype(undefined, [
    "issue_comment",
    "issues",
    "pull_request",
    "pull_request_review_comment"
]);
const direct_hoist_7 = new StringWithFormatRuntype(undefined, [
    "nonEmpty"
]);
const direct_hoist_8 = new RefRuntype(undefined, "Cursor");
const direct_hoist_9 = new RefRuntype(undefined, "EventFilters");
const direct_hoist_10 = new TypeofRuntype(undefined, "number");
const direct_hoist_11 = new RefRuntype(undefined, "PendingBatch");
const direct_hoist_12 = new ConstRuntype(undefined, 1);
const direct_hoist_13 = new ObjectRuntype(undefined, {
    "acknowledged": new OptionalFieldRuntype(direct_hoist_8),
    "consumer": direct_hoist_3,
    "filters": direct_hoist_9,
    "generation": direct_hoist_10,
    "pending": new OptionalFieldRuntype(direct_hoist_11),
    "version": direct_hoist_12
}, []);
const direct_hoist_14 = new ObjectRuntype(undefined, {
    "accessClientId": direct_hoist_3,
    "accessClientSecret": direct_hoist_3,
    "relayUrl": direct_hoist_3,
    "stateDirectory": direct_hoist_3
}, []);
const direct_hoist_15 = new ObjectRuntype(undefined, {
    "base": new OptionalFieldRuntype(direct_hoist_8),
    "checkpoint": direct_hoist_8,
    "token": direct_hoist_3
}, []);
const namedRuntypes = {
    "Cursor": direct_hoist_2,
    "EventFilters": direct_hoist_5,
    "EventType": direct_hoist_6,
    "NonEmptyString": direct_hoist_7,
    "ConsumerState": direct_hoist_13,
    "LocalConfig": direct_hoist_14,
    "PendingBatch": direct_hoist_15
};
const buildParsersInput = {
    "LocalConfig": direct_hoist_0,
    "ConsumerState": direct_hoist_1
};

export default { buildParsers };