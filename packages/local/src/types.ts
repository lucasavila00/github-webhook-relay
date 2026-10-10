import type {
  Acknowledgement,
  PublicError,
  Subscribe,
  WatchRequest,
  WatchResult,
} from "@github-webhook-relay/core";

export type { Acknowledgement, WatchRequest, WatchResult };

export type LocalErrorCode =
  | "cancelled"
  | "configuration"
  | "connection"
  | "forbidden"
  | "in_use"
  | "invalid_cursor"
  | "invalid_relay_data"
  | "relay"
  | "stale_acknowledgement"
  | "storage"
  | "unauthorized";

export type LocalClientError = Error & Readonly<{ code: LocalErrorCode }>;

export function localError(
  code: LocalErrorCode,
  message: string,
): LocalClientError {
  return Object.assign(new Error(message), { name: "LocalClientError", code });
}

export type SocketClose = Readonly<{ code: number; reason: string }>;
export type SocketInput =
  | Readonly<{ type: "data"; value: unknown }>
  | Readonly<{ type: "close"; close: SocketClose }>;

export type RelaySocket = Readonly<{
  send: (message: Subscribe) => void;
  close: () => void;
  receive: (signal: AbortSignal) => Promise<SocketInput>;
}>;

export type SocketCredentials = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

export type SocketService = Readonly<{
  connect: (
    url: string,
    credentials: SocketCredentials,
    signal: AbortSignal,
  ) => Promise<RelaySocket>;
}>;

export function relayError(error: PublicError): LocalClientError {
  const code =
    error.code === "unauthorized" ||
    error.code === "forbidden" ||
    error.code === "invalid_cursor"
      ? error.code
      : error.code === "internal_error"
        ? "relay"
        : "invalid_relay_data";
  return localError(code, error.message);
}
