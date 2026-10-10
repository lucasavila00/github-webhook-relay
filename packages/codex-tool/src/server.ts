import process from "node:process";

import { Capabilities, type Capability } from "@beff/diy/capabilities";
import {
  acknowledgeEvents,
  createNodeCapabilities,
  watchEvents,
} from "@github-webhook-relay/local";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type {
  EnvironmentCapability,
  LocalClientCapability,
} from "./capabilities.ts";
import { callTool, tools } from "./tools.ts";

type ToolCapabilities = LocalClientCapability;

export function createToolCapabilities(
  capabilities: Capabilities<EnvironmentCapability>,
): Capabilities<ToolCapabilities> {
  const local = createNodeCapabilities({
    relayUrl: capabilities.environment.read("GH_WATCH_RELAY_URL"),
    stateDirectory: capabilities.environment.read("GH_WATCH_STATE_DIRECTORY"),
    accessClientId: capabilities.environment.read("CF_ACCESS_CLIENT_ID"),
    accessClientSecret: capabilities.environment.read("CF_ACCESS_CLIENT_SECRET"),
  });
  return Capabilities.create<ToolCapabilities>({
    localClient: {
      watch: (request) => watchEvents(local, request),
      acknowledge: (acknowledgement) =>
        acknowledgeEvents(local, acknowledgement),
    },
  });
}

export function createServer(
  capabilities: Capabilities<ToolCapabilities>,
): Server {
  const server = new Server(
    { name: "gh-watch", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools] }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callTool(capabilities, request.params.name, request.params.arguments),
  );
  return server;
}

export async function runServer(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const environmentCapabilities = Capabilities.create<EnvironmentCapability>({
    environment: { read: (name) => environment[name] },
  });
  const server = createServer(createToolCapabilities(environmentCapabilities));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) {
  await runServer(process.env);
}
