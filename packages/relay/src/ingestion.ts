import type { Capability, Capabilities } from "@beff/diy/capabilities";
import type {
  ErrorCode,
  EventType,
  HttpError,
  StoredDelivery,
} from "@github-webhook-relay/core";
import { Parsers } from "@github-webhook-relay/core";

export type { StoredDelivery } from "@github-webhook-relay/core";

type Cryptography = Readonly<{
  verify: (body: ArrayBuffer, signature: Uint8Array<ArrayBuffer>) => Promise<boolean>;
}>;

export type AppendResult = Readonly<{
  inserted: boolean;
  position: string;
}>;

export type EventStore = Readonly<{
  append: (delivery: StoredDelivery) => AppendResult;
  hasPosition: (position: string) => boolean;
}>;

type EventPublisher = Readonly<{
  publish: (position: string) => void;
}>;

type Clock = Readonly<{
  now: () => string;
}>;

export type CryptographyCapability = Capability<"cryptography", Cryptography>;
export type EventStoreCapability = Capability<"eventStore", EventStore>;
export type EventPublisherCapability = Capability<"eventPublisher", EventPublisher>;
export type ClockCapability = Capability<"clock", Clock>;
type IngestionCapabilities =
  | CryptographyCapability
  | EventStoreCapability
  | EventPublisherCapability
  | ClockCapability;

type SelectedPayload = Readonly<{
  type: EventType;
  repository: string;
}>;

type Selection =
  | Readonly<{ kind: "ignored" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "selected"; value: SelectedPayload }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function ingestGitHubWebhook(
  capabilities: Capabilities<IngestionCapabilities>,
  request: Request,
): Promise<Response> {
  const body = await request.arrayBuffer();
  const signature = parseSignature(request.headers.get("x-hub-signature-256"));
  if (signature == null) {
    return errorResponse(401, "unauthorized", "Unauthorized.");
  }

  if (!(await capabilities.cryptography.verify(body, signature))) {
    return errorResponse(401, "unauthorized", "Unauthorized.");
  }

  const payload = parseJsonObject(body);
  if (payload == null) {
    return errorResponse(400, "invalid_request", "Invalid request.");
  }

  const deliveryId = request.headers.get("x-github-delivery");
  const githubEvent = request.headers.get("x-github-event");
  if (deliveryId == null || deliveryId.length === 0 || githubEvent == null || githubEvent.length === 0) {
    return errorResponse(400, "invalid_request", "Invalid request.");
  }

  const selection = selectGitHubEvent(githubEvent, payload);
  if (selection.kind === "ignored") {
    return new Response(null, { status: 204 });
  }
  if (selection.kind === "invalid") {
    return errorResponse(400, "invalid_request", "Invalid request.");
  }

  try {
    const result = capabilities.eventStore.append({
      deliveryId,
      eventType: selection.value.type,
      repository: selection.value.repository,
      receivedAt: capabilities.clock.now(),
      payload: body,
    });
    if (result.inserted) capabilities.eventPublisher.publish(result.position);
    return new Response(null, { status: 202 });
  } catch {
    return errorResponse(500, "internal_error", "Internal error.");
  }
}

function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
): Response {
  const body: HttpError = { error: { code, message } };
  return Response.json(body, { status });
}

export function selectGitHubEvent(
  githubEvent: string,
  payload: Readonly<Record<string, unknown>>,
): Selection {
  const actionResult = Parsers.GitHubActionPayload.safeParse(payload);
  if (!actionResult.success) {
    return { kind: "ignored" };
  }

  const type = selectedType(githubEvent, actionResult.data.action);
  if (type == null) {
    return { kind: "ignored" };
  }

  if (type === "pull_request") {
    const selectionResult = Parsers.GitHubPullRequestSelection.safeParse(payload);
    if (!selectionResult.success || !selectionResult.data.pull_request.merged) {
      return { kind: "ignored" };
    }
    const result = Parsers.GitHubPullRequestPayload.safeParse(payload);
    return result.success
      ? selected(type, result.data.repository.full_name)
      : { kind: "invalid" };
  }

  const result = Parsers.GitHubRepositoryPayload.safeParse(payload);
  return result.success
    ? selected(type, result.data.repository.full_name)
    : { kind: "invalid" };
}

export function eventId(position: string): string {
  return `event_${position}`;
}

export function cursor(position: string): string {
  return `cursor_${position}`;
}

export function validateCursor(
  capabilities: Capabilities<EventStoreCapability>,
  value: string,
): boolean {
  const match = /^cursor_(0|[1-9][0-9]*)$/.exec(value);
  if (match == null) {
    return false;
  }
  const position = match[1];
  return position === "0" ||
    (position != null && capabilities.eventStore.hasPosition(position));
}

export function createCryptography(secret: string): Cryptography {
  return {
    verify: async (body, signature) => {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify("HMAC", key, signature, body);
    },
  };
}

function parseSignature(value: string | null | undefined): Uint8Array<ArrayBuffer> | null | undefined {
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(value ?? "");
  if (match == null) {
    return undefined;
  }
  const hex = match[1];
  if (hex == null) {
    return undefined;
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parseJsonObject(
  body: ArrayBuffer,
): Readonly<Record<string, unknown>> | null | undefined {
  try {
    const value: unknown = JSON.parse(decoder.decode(body));
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function selectedType(githubEvent: string, action: string): EventType | null | undefined {
  if (githubEvent === "issues" && action === "opened") return "issues";
  if (githubEvent === "issue_comment" && action === "created") return "issue_comment";
  if (githubEvent === "pull_request_review_comment" && action === "created") {
    return "pull_request_review_comment";
  }
  if (githubEvent === "pull_request" && action === "closed") return "pull_request";
  return undefined;
}

function selected(
  type: EventType,
  repository: string,
): Selection {
  return { kind: "selected", value: { type, repository } };
}
