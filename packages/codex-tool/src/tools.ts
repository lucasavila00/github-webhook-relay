import type { Capabilities } from "@beff/diy/capabilities";
import { Parsers } from "@github-webhook-relay/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { LocalClientCapability } from "./capabilities.ts";
export const tools = [
  {
    name: "watch",
    description: "Wait for the next relay event batch for one consumer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["consumer", "filters", "waitMilliseconds"],
      properties: {
        consumer: { type: "string", minLength: 1 },
        filters: {
          type: "object",
          additionalProperties: false,
          properties: {
            repository: { type: "string" },
            type: {
              type: "string",
              enum: ["issues", "issue_comment", "pull_request_review_comment", "pull_request"],
            },
          },
        },
        waitMilliseconds: { type: "integer", minimum: 1, maximum: 55_000 },
      },
    },
  },
  {
    name: "acknowledge",
    description: "Advance progress after every event in a batch is handled.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["acknowledgement"],
      properties: {
        acknowledgement: {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "string", minLength: 1 } },
        },
      },
    },
  },
] as const;

export async function callTool(
  capabilities: Capabilities<LocalClientCapability>,
  name: string,
  input: unknown,
): Promise<CallToolResult> {
  if (name === "watch") {
    const parsed = Parsers.WatchToolInput.safeParse(input);
    if (!parsed.success) return toolError("invalid_request", "Invalid watch input.");
    try {
      return toolResult(await capabilities.localClient.watch({
        ...parsed.data,
        signal: undefined,
      }));
    } catch (error) {
      return localToolError(error);
    }
  }
  if (name === "acknowledge") {
    const parsed = Parsers.AcknowledgeToolInput.safeParse(input);
    if (!parsed.success) {
      return toolError("invalid_request", "Invalid acknowledgement input.");
    }
    try {
      await capabilities.localClient.acknowledge(parsed.data.acknowledgement);
      return toolResult({ type: "acknowledged" });
    } catch (error) {
      return localToolError(error);
    }
  }
  return toolError("unknown_tool", "Unknown tool.");
}

function toolResult(value: Readonly<Record<string, unknown>>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function localToolError(error: unknown): CallToolResult {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return toolError(error.code, error.message);
  }
  return toolError("internal", "The gh-watch tool failed.");
}

function toolError(code: string, message: string): CallToolResult {
  const value = { type: "error", error: { code, message } } as const;
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}
