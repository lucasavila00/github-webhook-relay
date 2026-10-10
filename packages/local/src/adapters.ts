import { open, mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { Capabilities } from "@beff/diy/capabilities";
import WebSocket from "ws";

import type {
  FileStorage,
  LocalCapabilities,
} from "./capabilities.ts";
import { createProcessService } from "./lock.ts";
import { LocalParsers, type LocalConfig } from "./parser.ts";
import {
  localError,
  type RelaySocket,
  type SocketInput,
  type SocketService,
} from "./types.ts";

export function createNodeCapabilities(
  value: unknown,
): Capabilities<LocalCapabilities> {
  const result = LocalParsers.LocalConfig.safeParse(value);
  if (!result.success || !validConfig(result.data)) {
    throw localError("configuration", "Invalid local client configuration.");
  }
  return Capabilities.create<LocalCapabilities>({
    clock: {
      now: () => Date.now(),
      setTimer: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      },
    },
    config: result.data,
    http: { fetch: globalThis.fetch.bind(globalThis) },
    network: createSocketService(),
    process: createProcessService(),
    storage: createFileStorage(),
  });
}

function validConfig(config: LocalConfig): boolean {
  try {
    const url = new URL(config.relayUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      config.stateDirectory.length > 0 &&
      config.accessClientId.length > 0 &&
      config.accessClientSecret.length > 0
    );
  } catch {
    return false;
  }
}

export function createFileStorage(): FileStorage {
  return {
    ensureDirectory: async (path) => {
      await mkdir(path, { recursive: true });
    },
    read: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    writeAtomic: async (path, value) => {
      const temporaryPath = `${path}.tmp`;
      const file = await open(temporaryPath, "w");
      try {
        await file.writeFile(value, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
  };
}

export function createSocketService(
  headers: Readonly<Record<string, string>> = {},
): SocketService {
  return {
    connect: (url, credentials, signal) =>
      connectSocket(url, credentials, signal, headers),
  };
}

async function connectSocket(
  url: string,
  credentials: Readonly<{ clientId: string; clientSecret: string }>,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>>,
): Promise<RelaySocket> {
  if (signal.aborted) throw localError("cancelled", "Watch was cancelled.");
  const socket = new WebSocket(url, {
    headers: {
      "CF-Access-Client-Id": credentials.clientId,
      "CF-Access-Client-Secret": credentials.clientSecret,
      ...headers,
    },
  });
  await waitForOpen(socket, signal);
  return socketAdapter(socket);
}

async function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("unexpected-response", onResponse);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      socket.once("error", () => undefined);
      reject(localError("connection", "Cannot connect to the relay."));
    };
    const onAbort = (): void => {
      cleanup();
      socket.once("error", () => undefined);
      socket.terminate();
      reject(localError("cancelled", "Watch was cancelled."));
    };
    const onResponse = (_request: unknown, response: { statusCode?: number; resume: () => void }): void => {
      const code = response.statusCode;
      response.resume();
      cleanup();
      socket.once("error", () => undefined);
      socket.terminate();
      reject(
        code === 401
          ? localError("unauthorized", "Relay authentication failed.")
          : code === 403
            ? localError("forbidden", "Relay access was forbidden.")
            : localError("connection", "Relay upgrade failed."),
      );
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onResponse);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function socketAdapter(socket: WebSocket): RelaySocket {
  let queued: ReadonlyArray<SocketInput> = [];
  let receiver: ((input: SocketInput) => void) | undefined;
  const deliver = (input: SocketInput): void => {
    if (receiver === undefined) {
      queued = [...queued, input];
      return;
    }
    const current = receiver;
    receiver = undefined;
    current(input);
  };
  socket.on("message", (data) => {
    try {
      deliver({ type: "data", value: JSON.parse(data.toString()) as unknown });
    } catch {
      deliver({ type: "data", value: undefined });
    }
  });
  socket.on("close", (code, reason) =>
    deliver({ type: "close", close: { code, reason: reason.toString("utf8") } }),
  );
  socket.on("error", () =>
    deliver({ type: "close", close: { code: 1006, reason: "" } }),
  );
  return {
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    receive: async (signal) => {
      const first = queued[0];
      if (first !== undefined) {
        queued = queued.slice(1);
        return first;
      }
      return await new Promise<SocketInput>((resolve, reject) => {
        const onAbort = (): void => {
          receiver = undefined;
          reject(localError("cancelled", "Watch was cancelled."));
        };
        receiver = (input) => {
          signal.removeEventListener("abort", onAbort);
          resolve(input);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
