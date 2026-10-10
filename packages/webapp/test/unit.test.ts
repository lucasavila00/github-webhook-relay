import { Parsers, type Event, type EventPage } from "@github-webhook-relay/contracts";
import { describe, expect, it } from "vitest";

import {
  currentPage,
  initialView,
  laterAction,
  reduceView,
  selectedEvent,
} from "../src/state.ts";

const first = event("event_1", "issues");
const second = event("event_2", "issue_comment");
const firstPage = page([first], "cursor_1", true);
const secondPage = page([second], "cursor_2", false);

describe("event inspector state", () => {
  it("loads later pages and retains older pages", () => {
    const loaded = reduceView(initialView(), { type: "loaded", page: firstPage });
    expect(loaded.state).toBe("ready");
    if (loaded.state !== "ready") return;

    const later = laterAction(loaded.value);
    expect(later).toEqual({
      type: "load",
      load: { filters: {}, after: "cursor_1", kind: "later" },
    });
    if (later === undefined) return;
    const loading = reduceView(loaded, later);
    const atSecond = reduceView(loading, { type: "loaded", page: secondPage });
    expect(atSecond.state).toBe("ready");
    if (atSecond.state !== "ready") return;
    expect(currentPage(atSecond.value).events).toEqual([second]);

    const atFirst = reduceView(atSecond, { type: "older" });
    expect(atFirst.state).toBe("ready");
    if (atFirst.state !== "ready") return;
    expect(currentPage(atFirst.value).events).toEqual([first]);
    const retained = laterAction(atFirst.value);
    expect(retained).toMatchObject({ type: "load", load: { kind: "retained" } });
  });

  it("keeps history through loading and error states", () => {
    const ready = reduceView(initialView(), { type: "loaded", page: secondPage });
    const loading = reduceView(ready, {
      type: "load",
      load: { filters: { type: "issues" }, kind: "reset" },
    });
    expect(loading).toMatchObject({ state: "loading", previous: { pages: [secondPage] } });
    const failed = reduceView(loading, { type: "failed", message: "Unavailable." });
    expect(failed).toMatchObject({
      state: "error",
      message: "Unavailable.",
      previous: { pages: [secondPage] },
    });

    const selected = reduceView(failed, { type: "select", id: second.id });
    expect(selected).toMatchObject({
      state: "error",
      message: "Unavailable.",
      previous: { selectedEventId: second.id },
    });
  });

  it("adds live events once and saves checkpoints after them", () => {
    let view = reduceView(initialView(), { type: "loaded", page: secondPage });
    view = reduceView(view, { type: "stream", message: { type: "event", event: first } });
    view = reduceView(view, { type: "stream", message: { type: "event", event: first } });
    view = reduceView(view, {
      type: "stream",
      message: { type: "checkpoint", cursor: Parsers.Cursor.parse("cursor_3") },
    });
    expect(view.state).toBe("ready");
    if (view.state !== "ready") return;
    expect(currentPage(view.value).events).toEqual([second, first]);
    expect(view.value.checkpoint).toBe("cursor_3");
  });

  it("selects an event without changing its original payload", () => {
    const loaded = reduceView(initialView(), { type: "loaded", page: firstPage });
    const selected = reduceView(loaded, { type: "select", id: first.id });
    expect(selected.state).toBe("ready");
    if (selected.state !== "ready") return;
    expect(selectedEvent(selected.value)?.payload).toBe(first.payload);
  });
});

function event(id: string, type: Event["type"]): Event {
  return Parsers.Event.parse({
    id,
    deliveryId: `delivery-${id}`,
    type,
    repository: "owner/repository",
    receivedAt: "2026-10-10T13:00:00Z",
    payload: { action: "created", nested: { value: id } },
  });
}

function page(
  events: ReadonlyArray<Event>,
  cursor: string,
  hasMore: boolean,
): EventPage {
  return { events, cursor: Parsers.Cursor.parse(cursor), hasMore };
}
