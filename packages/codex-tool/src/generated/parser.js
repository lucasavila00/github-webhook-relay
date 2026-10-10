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
const RequiredNumberFormats = ["waitMilliseconds"];
const direct_hoist_0 = new RefRuntype(undefined, "WatchToolInput");
const direct_hoist_1 = new RefRuntype(undefined, "AcknowledgeToolInput");
const direct_hoist_2 = new TypeofRuntype(undefined, "string");
const direct_hoist_3 = new RefRuntype(undefined, "EventType");
const direct_hoist_4 = new ObjectRuntype(undefined, {
    "repository": new OptionalFieldRuntype(direct_hoist_2),
    "type": new OptionalFieldRuntype(direct_hoist_3)
}, []);
const direct_hoist_5 = new AnyOfConstsRuntype(undefined, [
    "issue_comment",
    "issues",
    "pull_request",
    "pull_request_review_comment"
]);
const direct_hoist_6 = new RefRuntype(undefined, "NonEmptyString");
const direct_hoist_7 = new ObjectRuntype(undefined, {
    "value": direct_hoist_6
}, []);
const direct_hoist_8 = new ObjectRuntype(undefined, {
    "acknowledgement": direct_hoist_7
}, []);
const direct_hoist_9 = new StringWithFormatRuntype(undefined, [
    "nonEmpty"
]);
const direct_hoist_10 = new NumberWithFormatRuntype(undefined, [
    "waitMilliseconds"
]);
const direct_hoist_11 = new RefRuntype(undefined, "EventFilters");
const direct_hoist_12 = new RefRuntype(undefined, "WaitMilliseconds");
const direct_hoist_13 = new ObjectRuntype(undefined, {
    "consumer": direct_hoist_6,
    "filters": direct_hoist_11,
    "waitMilliseconds": direct_hoist_12
}, []);
const namedRuntypes = {
    "EventFilters": direct_hoist_4,
    "EventType": direct_hoist_5,
    "AcknowledgeToolInput": direct_hoist_8,
    "NonEmptyString": direct_hoist_9,
    "WaitMilliseconds": direct_hoist_10,
    "WatchToolInput": direct_hoist_13
};
const buildParsersInput = {
    "WatchToolInput": direct_hoist_0,
    "AcknowledgeToolInput": direct_hoist_1
};

export default { buildParsers };