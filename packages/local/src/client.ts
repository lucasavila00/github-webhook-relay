import { createHash } from "node:crypto";
import { join } from "node:path";

import type { Capabilities } from "@beff/diy/capabilities";
import {
  Parsers,
  type Cursor,
  type Event,
  type EventFilters,
  type StreamMessage,
} from "@github-webhook-relay/contracts";

import type {
  AcknowledgeCapability,
  ClockCapability,
  Clock,
  ConfigCapability,
  NetworkCapability,
  StorageCapability,
  WatchCapability,
} from "./capabilities.ts";
import { LocalParsers, type ConsumerState } from "./parser.ts";
import {
  localError,
  relayError,
  type Acknowledgement,
  type LocalClientError,
  type WatchRequest,
  type WatchResult,
} from "./types.ts";

export async function watchEvents(
  capabilities: Capabilities<WatchCapability>,
  request: WatchRequest,
): Promise<WatchResult> {
  const normalized = normalizeRequest(request);
  const key = stateKey(normalized.consumer, normalized.filters);
  const statePath = join(capabilities.config.stateDirectory, `${key}.json`);
  await storageCall(() =>
    capabilities.storage.ensureDirectory(capabilities.config.stateDirectory),
  );
  const deadline: Deadline = {
    startedAt: capabilities.clock.now(),
    waitMilliseconds: normalized.waitMilliseconds,
  };
  return await capabilities.process.withFileLock(`${statePath}.lock`, async () => {
    const state = await loadState(capabilities, statePath, normalized, key);
    return await watchLocked(capabilities, normalized, key, statePath, state, deadline);
  });
}

export async function acknowledgeEvents(
  capabilities: Capabilities<AcknowledgeCapability>,
  acknowledgement: Acknowledgement,
): Promise<void> {
  const parsed = parseAcknowledgement(acknowledgement);
  await storageCall(() =>
    capabilities.storage.ensureDirectory(capabilities.config.stateDirectory),
  );
  const statePath = join(
    capabilities.config.stateDirectory,
    `${parsed.key}.json`,
  );
  await capabilities.process.withFileLock(`${statePath}.lock`, async () => {
    const state = await loadStateByKey(capabilities, statePath, parsed.key);
    if (state === undefined) {
      throw localError(
        "stale_acknowledgement",
        "Acknowledgement is stale or unknown.",
      );
    }
    if (state.pending?.token !== parsed.token) {
      throw localError(
        "stale_acknowledgement",
        "Acknowledgement is stale or unknown.",
      );
    }
    const { pending: _pending, ...rest } = state;
    await saveState(capabilities, statePath, {
      ...rest,
      acknowledged: state.pending.checkpoint,
    });
  });
}

async function watchLocked(
  capabilities: Capabilities<
    ClockCapability | ConfigCapability | NetworkCapability | StorageCapability
  >,
  request: Required<Omit<WatchRequest, "signal">> &
    Readonly<{ signal?: AbortSignal }>,
  key: string,
  statePath: string,
  state: ConsumerState,
  deadline: Deadline,
): Promise<WatchResult> {
  while (remainingWait(capabilities.clock, deadline) > 0) {
    const timed = timedSignal(
      capabilities.clock,
      deadline,
      request.signal,
    );
    try {
      const result = await receiveBatch(capabilities, request, state, timed.signal);
      if (result.type === "retry") {
        await waitForRetry(capabilities.clock, timed.signal);
        continue;
      }
      const generation = state.generation + 1;
      const token = `ack_${generation}`;
      await saveState(capabilities, statePath, {
        version: 1,
        consumer: request.consumer,
        filters: request.filters,
        ...(state.acknowledged === undefined
          ? {}
          : { acknowledged: state.acknowledged }),
        generation,
        pending: {
          token,
          ...(state.acknowledged === undefined
            ? {}
            : { base: state.acknowledged }),
          checkpoint: result.checkpoint,
        },
      });
      return {
        type: "batch",
        events: result.events,
        acknowledgement: { value: `${key}.${token}` },
      };
    } catch (error) {
      if (timed.didTimeOut()) return { type: "timeout" };
      if (request.signal?.aborted === true) {
        throw localError("cancelled", "Watch was cancelled.");
      }
      if (isLocalError(error) && error.code === "connection") {
        await waitForRetry(capabilities.clock, timed.signal);
        continue;
      }
      throw error;
    } finally {
      timed.dispose();
    }
  }
  return { type: "timeout" };
}

type BatchResult =
  | Readonly<{
      type: "batch";
      events: ReadonlyArray<Event>;
      checkpoint: Cursor;
    }>
  | Readonly<{ type: "retry" }>;

async function receiveBatch(
  capabilities: Capabilities<ConfigCapability | NetworkCapability>,
  request: WatchRequest,
  state: ConsumerState,
  signal: AbortSignal,
): Promise<BatchResult> {
  const socket = await capabilities.network.connect(
    streamUrl(capabilities.config.relayUrl),
    {
      clientId: capabilities.config.accessClientId,
      clientSecret: capabilities.config.accessClientSecret,
    },
    signal,
  );
  try {
    socket.send({
      type: "subscribe",
      ...(state.acknowledged === undefined ? {} : { after: state.acknowledged }),
      ...(Object.keys(request.filters).length === 0
        ? {}
        : { filters: request.filters }),
    });
    let events: ReadonlyArray<Event> = [];
    while (true) {
      const input = await socket.receive(signal);
      if (input.type === "close") {
        if (input.close.code === 1008) {
          throw localError("invalid_relay_data", "Relay rejected the subscription.");
        }
        return { type: "retry" };
      }
      const result = Parsers.StreamMessage.safeParse(input.value);
      if (!result.success) {
        throw localError("invalid_relay_data", "Relay sent invalid event data.");
      }
      const message: StreamMessage = result.data;
      if (message.type === "error") throw relayError(message.error);
      if (message.type === "event") {
        events = [...events, message.event];
        continue;
      }
      return { type: "batch", events, checkpoint: message.cursor };
    }
  } finally {
    socket.close();
  }
}

function normalizeRequest(
  request: WatchRequest,
): Required<Omit<WatchRequest, "signal">> & Readonly<{ signal?: AbortSignal }> {
  const filterResult = Parsers.EventFilters.safeParse(request.filters);
  if (
    request.consumer.length === 0 ||
    !Number.isFinite(request.waitMilliseconds) ||
    request.waitMilliseconds <= 0 ||
    !filterResult.success
  ) {
    throw localError("configuration", "Invalid watch request.");
  }
  return {
    consumer: request.consumer,
    filters: canonicalFilters(filterResult.data),
    waitMilliseconds: request.waitMilliseconds,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function canonicalFilters(filters: EventFilters): EventFilters {
  return {
    ...(filters.repository === undefined
      ? {}
      : { repository: filters.repository }),
    ...(filters.type === undefined ? {} : { type: filters.type }),
  };
}

function stateKey(consumer: string, filters: EventFilters): string {
  return createHash("sha256")
    .update(JSON.stringify([consumer, filters.repository ?? null, filters.type ?? null]))
    .digest("hex");
}

async function loadState(
  capabilities: Capabilities<StorageCapability>,
  path: string,
  request: WatchRequest,
  key: string,
): Promise<ConsumerState> {
  const state = await loadStateByKey(capabilities, path, key);
  if (state === undefined) {
    return {
      version: 1,
      consumer: request.consumer,
      filters: request.filters,
      generation: 0,
    };
  }
  if (
    state.consumer !== request.consumer ||
    JSON.stringify(state.filters) !== JSON.stringify(request.filters)
  ) {
    throw localError("storage", "Consumer state does not match its key.");
  }
  return state;
}

async function loadStateByKey(
  capabilities: Capabilities<StorageCapability>,
  path: string,
  key: string,
): Promise<ConsumerState | undefined> {
  const value = await storageCall(() => capabilities.storage.read(path));
  if (value === undefined) return undefined;
  try {
    const parsed = LocalParsers.ConsumerState.parse(JSON.parse(value) as unknown);
    if (
      !validState(parsed) ||
      stateKey(parsed.consumer, canonicalFilters(parsed.filters)) !== key
    ) {
      throw localError("storage", "Consumer state does not match its key.");
    }
    return parsed;
  } catch (error) {
    if (isLocalError(error)) throw error;
    throw localError("storage", "Consumer state is invalid.");
  }
}

async function saveState(
  capabilities: Capabilities<StorageCapability>,
  path: string,
  state: ConsumerState,
): Promise<void> {
  await storageCall(() =>
    capabilities.storage.writeAtomic(path, `${JSON.stringify(state)}\n`),
  );
}

function parseAcknowledgement(
  acknowledgement: Acknowledgement,
): Readonly<{ key: string; token: string }> {
  if (
    typeof acknowledgement !== "object" ||
    acknowledgement === null ||
    typeof acknowledgement.value !== "string"
  ) {
    throw localError(
      "stale_acknowledgement",
      "Acknowledgement is stale or unknown.",
    );
  }
  const match = /^([a-f0-9]{64})\.(ack_[1-9][0-9]*)$/.exec(
    acknowledgement.value,
  );
  if (match?.[1] === undefined || match[2] === undefined) {
    throw localError(
      "stale_acknowledgement",
      "Acknowledgement is stale or unknown.",
    );
  }
  return { key: match[1], token: match[2] };
}

function validState(state: ConsumerState): boolean {
  if (!Number.isSafeInteger(state.generation) || state.generation < 0) {
    return false;
  }
  if (state.pending === undefined) return true;
  return (
    state.pending.token === `ack_${state.generation}` &&
    state.pending.base === state.acknowledged
  );
}

function streamUrl(relayUrl: string): string {
  const url = new URL("/api/events/stream", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function timedSignal(
  clock: Clock,
  deadline: Deadline,
  parent?: AbortSignal,
): Readonly<{
  signal: AbortSignal;
  didTimeOut: () => boolean;
  dispose: () => void;
}> {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = (): void => controller.abort();
  parent?.addEventListener("abort", onAbort, { once: true });
  let cancelTimer = (): void => undefined;
  const schedule = (): void => {
    const remaining = remainingWait(clock, deadline);
    if (remaining <= 0) {
      timeout = true;
      controller.abort();
      return;
    }
    cancelTimer = clock.setTimer(
      schedule,
      Math.min(remaining, 2_147_483_647),
    );
  };
  schedule();
  if (parent?.aborted === true) controller.abort();
  return {
    signal: controller.signal,
    didTimeOut: () => timeout,
    dispose: () => {
      cancelTimer();
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

type Deadline = Readonly<{
  startedAt: number;
  waitMilliseconds: number;
}>;

function remainingWait(clock: Clock, deadline: Deadline): number {
  return Math.max(
    0,
    deadline.waitMilliseconds - (clock.now() - deadline.startedAt),
  );
}

async function waitForRetry(clock: Clock, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      cancelTimer();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const cancelTimer = clock.setTimer(done, 100);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function storageCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isLocalError(error)) throw error;
    throw localError("storage", "Local consumer storage failed.");
  }
}

function isLocalError(error: unknown): error is LocalClientError {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as Readonly<{ code?: unknown }>).code === "string"
  );
}
