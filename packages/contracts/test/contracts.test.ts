import { describe, expect, it } from "vitest";

import {
  DEFAULT_EVENT_LIMIT,
  Parsers,
  createEventPage,
  normalizeEventQuery,
  type Cursor,
  type Event,
  type EventLimit,
} from "../src/index.ts";

const eventValue = {
  id: "event-1",
  deliveryId: "delivery-1",
  type: "issues",
  repository: "owner/repository",
  receivedAt: "2026-10-10T13:00:00Z",
  payload: { action: "opened", issue: { number: 8 } },
};

describe("wire validators", () => {
  it("accepts each supported GitHub event type", () => {
    for (const type of [
      "issues",
      "issue_comment",
      "pull_request",
      "pull_request_review_comment",
    ]) {
      expect(Parsers.Event.safeParse({ ...eventValue, type }).success).toBe(true);
    }
  });

  it("preserves arbitrary nested GitHub payload fields", () => {
    const result = Parsers.Event.safeParse(eventValue);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual(eventValue.payload);
    }
  });

  it.each([
    [{ ...eventValue, id: "" }],
    [{ ...eventValue, type: "push" }],
    [{ ...eventValue, payload: null }],
    [{ ...eventValue, payload: [] }],
    [
      {
        id: "event-1",
        deliveryId: "delivery-1",
        type: "issues",
        repository: "owner/repository",
        receivedAt: "2026-10-10T13:00:00Z",
      },
    ],
    [
      {
        id: "event-1",
        type: "issues",
        repository: "owner/repository",
        receivedAt: "2026-10-10T13:00:00Z",
        payload: {},
      },
    ],
  ])("rejects an invalid event value", (value) => {
    expect(Parsers.Event.safeParse(value).success).toBe(false);
  });

  it.each([
    [{ limit: 1 }],
    [{ limit: 1_000 }],
    [{ type: "pull_request_review_comment" }],
    [{ after: "initial", repository: "owner/repository" }],
  ])("accepts a valid event query", (value) => {
    expect(Parsers.EventQuery.safeParse(value).success).toBe(true);
  });

  it.each([
    [{ after: "" }],
    [{ limit: 0 }],
    [{ limit: 1_001 }],
    [{ limit: 1.5 }],
    [{ limit: "100" }],
    [{ type: "push" }],
  ])("rejects an invalid event query", (value) => {
    expect(Parsers.EventQuery.safeParse(value).success).toBe(false);
  });

  it("accepts a valid history page", () => {
    expect(
      Parsers.EventPage.safeParse({
        events: [eventValue],
        cursor: "cursor-1",
        hasMore: false,
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ events: [], cursor: "", hasMore: false }],
    [{ events: [], cursor: "cursor-1", hasMore: "false" }],
  ])("rejects an invalid history page", (value) => {
    expect(Parsers.EventPage.safeParse(value).success).toBe(false);
  });

  it.each([
    [{ type: "subscribe" }],
    [
      {
        type: "subscribe",
        after: "cursor-1",
        filters: { repository: "owner/repository", type: "issues" },
      },
    ],
  ])("accepts a valid subscription", (value) => {
    expect(Parsers.Subscribe.safeParse(value).success).toBe(true);
  });

  it.each([
    [{ type: "subscribe", after: "" }],
    [{ type: "subscribe", filters: { type: "push" } }],
    [{ type: "event" }],
  ])("rejects an invalid subscription", (value) => {
    expect(Parsers.Subscribe.safeParse(value).success).toBe(false);
  });

  it.each([
    [{ type: "event", event: eventValue }],
    [{ type: "checkpoint", cursor: "cursor-1" }],
    [
      {
        type: "error",
        error: { code: "invalid_cursor", message: "Unknown cursor." },
      },
    ],
  ])("accepts a valid stream message", (value) => {
    expect(Parsers.StreamMessage.safeParse(value).success).toBe(true);
  });

  it("accepts a valid HTTP error", () => {
    expect(
      Parsers.HttpError.safeParse({
        error: { code: "invalid_request", message: "Invalid limit." },
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ type: "checkpoint", cursor: "" }],
    [{ type: "error", error: { code: "unknown", message: "Failure." } }],
    [{ error: { code: "invalid_request" } }],
  ])("rejects an invalid transport error or message", (value) => {
    expect(Parsers.StreamMessage.safeParse(value).success).toBe(false);
    expect(Parsers.HttpError.safeParse(value).success).toBe(false);
  });
});

describe("event queries", () => {
  it("adds the default limit and collects filters", () => {
    const query = Parsers.EventQuery.parse({
      after: "cursor-1",
      repository: "owner/repository",
      type: "issues",
    });

    expect(normalizeEventQuery(query)).toEqual({
      after: "cursor-1",
      filters: { repository: "owner/repository", type: "issues" },
      limit: DEFAULT_EVENT_LIMIT,
    });
  });
});

describe("cursor semantics", () => {
  it("advances across excluded events", () => {
    const page = createEventPage(
      [
        positioned("1", event("event-1", "other/repository")),
        positioned("2", event("event-2", "owner/repository")),
        positioned("3", event("event-3", "other/repository")),
      ],
      cursor("initial"),
      { repository: "owner/repository" },
      limit(100),
    );

    expect(page.events.map(({ id }) => id)).toEqual(["event-2"]);
    expect(page.cursor).toBe("3");
    expect(page.hasMore).toBe(false);
  });

  it("uses matching look-ahead without skipping the next match", () => {
    const page = createEventPage(
      [
        positioned("1", event("event-1", "owner/repository")),
        positioned("2", event("event-2", "other/repository")),
        positioned("3", event("event-3", "owner/repository")),
      ],
      cursor("initial"),
      { repository: "owner/repository" },
      limit(1),
    );

    expect(page.events.map(({ id }) => id)).toEqual(["event-1"]);
    expect(page.cursor).toBe("2");
    expect(page.hasMore).toBe(true);
  });

  it("returns the initial position when it scans no events", () => {
    expect(
      createEventPage([], cursor("initial"), {}, limit(100)),
    ).toEqual({ events: [], cursor: "initial", hasMore: false });
  });
});

function cursor(value: string): Cursor {
  return Parsers.Cursor.parse(value);
}

function limit(value: number): EventLimit {
  return Parsers.EventLimit.parse(value);
}

function event(id: string, repository: string): Event {
  return Parsers.Event.parse({ ...eventValue, id, repository });
}

function positioned(position: string, value: Event) {
  return { cursor: cursor(position), event: value };
}
