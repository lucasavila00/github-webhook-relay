import type { Capabilities } from "@beff/diy/capabilities";
import type { EventFilters, EventType } from "@github-webhook-relay/core";
import { useEffect, useReducer, useState } from "preact/hooks";

import {
  loadEventPage,
  openEventStream,
  waitToReconnect,
  type ClockCapability,
  type HttpCapability,
  type SocketCapability,
} from "./client.ts";
import {
  currentPage,
  initialView,
  laterAction,
  reduceView,
  selectedEvent,
  type Action,
  type Ready,
} from "./state.ts";

type BrowserCapability = HttpCapability | ClockCapability | SocketCapability;
const eventTypes: ReadonlyArray<EventType> = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review_comment",
];

export function App(
  { capabilities }: Readonly<{ capabilities: Capabilities<BrowserCapability> }>,
) {
  const [view, dispatch] = useReducer(reduceView, undefined, () => initialView());
  const ready = view.state === "ready" ? view.value : view.previous;
  const [repository, setRepository] = useState("");
  const [type, setType] = useState<EventType | "">("");

  useEffect(() => {
    if (view.state !== "loading") return;
    let active = true;
    void loadEventPage(capabilities, view.load.filters, view.load.after)
      .then((page) => active && dispatch({ type: "loaded", page }))
      .catch((error: unknown) => {
        if (active) {
          dispatch({
            type: "failed",
            message: error instanceof Error ? error.message : "Request failed.",
          });
        }
      });
    return (): void => {
      active = false;
    };
  }, [capabilities, view.state === "loading" ? view.load : undefined]);

  useEffect(() => {
    if (view.state !== "ready") return;
    const value = view.value;
    const page = currentPage(value);
    if (page.hasMore || value.pageIndex !== value.pages.length - 1) return;
    if (value.connection === "disconnected") {
      let active = true;
      void waitToReconnect(capabilities).then(() => {
        if (active) dispatch({ type: "connection", value: "connecting" });
      });
      return (): void => {
        active = false;
      };
    }
    if (value.connection !== "connecting") return;
    return openEventStream(
      capabilities,
      value.filters,
      value.checkpoint ?? page.cursor,
      {
        opened: () => dispatch({ type: "connection", value: "live" }),
        message: (message) => dispatch({ type: "stream", message }),
        closed: () => dispatch({ type: "connection", value: "disconnected" }),
      },
    );
  }, [capabilities, streamEffectKey(view)]);

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const filters: EventFilters = {
      repository: repository === "" ? undefined : repository,
      type: type === "" ? undefined : type,
    };
    dispatch({
      type: "load",
      load: { after: undefined, filters, kind: "reset", pageIndex: undefined },
    });
  };

  return (
    <main>
      <h1>GitHub event history</h1>
      <form onSubmit={submit} aria-label="Event filters">
        <label>
          Repository
          <input
            value={repository}
            onInput={(event) => setRepository(event.currentTarget.value)}
            placeholder="owner/repository"
          />
        </label>
        <label>
          Event type
          <select
            value={type}
            onChange={(event) =>
              setType(event.currentTarget.value as EventType | "")}
          >
            <option value="">All types</option>
            {eventTypes.map((value) => <option value={value}>{value}</option>)}
          </select>
        </label>
        <button type="submit">Apply filters</button>
      </form>
      {view.state === "loading" && <p role="status">Loading events…</p>}
      {view.state === "error" && <p role="alert">{view.message}</p>}
      {ready != null && <EventView ready={ready} dispatch={dispatch} />}
    </main>
  );
}

function EventView(
  { ready, dispatch }: Readonly<{
    ready: Ready;
    dispatch: (action: Action) => void;
  }>,
) {
  const page = currentPage(ready);
  const selected = selectedEvent(ready);
  const later = laterAction(ready);
  return (
    <section>
      <p data-testid="connection">
        {page.hasMore
          ? "Load later pages to reach live events."
          : connectionMessage(ready.connection)}
      </p>
      {page.events.length === 0
        ? <p>No events match these filters.</p>
        : <ol>{page.events.map((event) => <li key={event.id}>
          <button
            type="button"
            onClick={() => dispatch({ type: "select", id: event.id })}
          >
            <strong>{event.type}</strong> {event.repository}{" "}
            <time>{event.receivedAt}</time>
          </button>
        </li>)}</ol>}
      <nav aria-label="History pages">
        <button
          type="button"
          disabled={ready.pageIndex === 0}
          onClick={() => dispatch({ type: "older" })}
        >Older</button>
        <button
          type="button"
          disabled={later == null}
          onClick={() => later != null && dispatch(later)}
        >Later</button>
      </nav>
      {selected != null && <aside aria-label="Event payload">
        <h2>Original payload</h2>
        <pre>{JSON.stringify(selected.payload, null, 2)}</pre>
      </aside>}
    </section>
  );
}

function connectionMessage(connection: Ready["connection"]): string {
  if (connection === "live") return "Live events connected.";
  if (connection === "connecting") return "Connecting to live events…";
  return "Live events disconnected. Reconnecting…";
}

function streamEffectKey(view: ReturnType<typeof initialView>): string {
  if (view.state !== "ready") return view.state;
  const ready = view.value;
  const page = currentPage(ready);
  return JSON.stringify([
    ready.filters,
    ready.connection === "disconnected" ? "disconnected" : "active",
    page.hasMore,
    ready.pageIndex,
    ready.pages.length,
  ]);
}
