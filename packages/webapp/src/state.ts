import type { Cursor, Event, EventFilters, EventPage, StreamMessage } from "@github-webhook-relay/core";

export type Connection = "connecting" | "live" | "disconnected";
export type Ready = Readonly<{
  filters: EventFilters;
  pages: ReadonlyArray<EventPage>;
  pageIndex: number;
  selectedEventId: string | null | undefined;
  checkpoint: Cursor | null | undefined;
  connection: Connection;
}>;
type Load = Readonly<{
  filters: EventFilters;
  after: Cursor | null | undefined;
  kind: "reset" | "later" | "retained";
  pageIndex: number | null | undefined;
}>;
export type View =
  | Readonly<{ state: "loading"; load: Load; previous: Ready | null | undefined }>
  | Readonly<{ state: "ready"; value: Ready }>
  | Readonly<{ state: "error"; message: string; previous: Ready | null | undefined }>;
export type Action =
  | Readonly<{ type: "load"; load: Load }>
  | Readonly<{ type: "loaded"; page: EventPage }>
  | Readonly<{ type: "failed"; message: string }>
  | Readonly<{ type: "older" }>
  | Readonly<{ type: "select"; id: string }>
  | Readonly<{ type: "connection"; value: Connection }>
  | Readonly<{ type: "stream"; message: StreamMessage }>;

export const initialView = (
  filters: EventFilters = { repository: undefined, type: undefined },
): View => ({
  state: "loading",
  load: { after: undefined, filters, kind: "reset", pageIndex: undefined },
  previous: undefined,
});

export function reduceView(view: View, action: Action): View {
  if (action.type === "load") {
    const previous = readyValue(view);
    if (action.load.kind === "retained" && previous != null) {
      return readyView({ ...previous, pageIndex: action.load.pageIndex ?? 0 });
    }
    return {
      state: "loading",
      load: action.load,
      previous,
    };
  }
  if (action.type === "loaded" && view.state === "loading") {
    const pages = view.load.kind === "later" && view.previous != null
      ? [...view.previous.pages, action.page]
      : [action.page];
    return readyView({
      filters: view.load.filters,
      pages,
      pageIndex: pages.length - 1,
      selectedEventId: undefined,
      checkpoint: undefined,
      connection: action.page.hasMore ? "disconnected" : "connecting",
    });
  }
  if (action.type === "failed") {
    const previous = readyValue(view);
    return {
      state: "error",
      message: action.message,
      previous,
    };
  }
  const ready = readyValue(view);
  if (ready == null) return view;
  if (action.type === "older" && ready.pageIndex > 0) {
    return retainState(view, { ...ready, pageIndex: ready.pageIndex - 1 });
  }
  if (action.type === "select") {
    return retainState(view, { ...ready, selectedEventId: action.id });
  }
  if (view.state !== "ready") return view;
  if (action.type === "connection") {
    return readyView({ ...ready, connection: action.value });
  }
  if (action.type === "stream") return applyStreamMessage(ready, action.message);
  return view;
}

export function laterAction(ready: Ready): Action | null | undefined {
  const nextIndex = ready.pageIndex + 1;
  if (ready.pages[nextIndex] != null) {
    return {
      type: "load",
      load: { after: undefined, filters: ready.filters, kind: "retained", pageIndex: nextIndex },
    };
  }
  const page = currentPage(ready);
  if (!page.hasMore) return undefined;
  return {
    type: "load",
    load: { filters: ready.filters, after: page.cursor, kind: "later", pageIndex: undefined },
  };
}

export function currentPage(ready: Ready): EventPage {
  const page = ready.pages[ready.pageIndex];
  if (page == null) throw new Error("The current page does not exist.");
  return page;
}

export function selectedEvent(ready: Ready): Event | null | undefined {
  return ready.pages.flatMap(({ events }) => events)
    .find(({ id }) => id === ready.selectedEventId);
}

function applyStreamMessage(ready: Ready, message: StreamMessage): View {
  if (message.type === "error") {
    return { state: "error", message: message.error.message, previous: ready };
  }
  if (message.type === "checkpoint") {
    return readyView({ ...ready, checkpoint: message.cursor });
  }
  if (ready.pages.some(({ events }) => events.some(({ id }) => id === message.event.id))) {
    return readyView(ready);
  }
  const lastIndex = ready.pages.length - 1;
  const pages = ready.pages.map((page, index) => index === lastIndex
    ? { ...page, events: [...page.events, message.event] }
    : page);
  return readyView({ ...ready, pages, pageIndex: lastIndex });
}

function readyValue(view: View): Ready | null | undefined {
  return view.state === "ready" ? view.value : view.previous;
}

const readyView = (value: Ready): View => ({ state: "ready", value });

function retainState(view: View, value: Ready): View {
  if (view.state === "ready") return readyView(value);
  return { ...view, previous: value };
}
