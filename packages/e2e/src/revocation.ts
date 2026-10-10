import process from "node:process";

import { verifyRevokedAccess } from "./access.ts";
import { createAdapters } from "./adapters.ts";
import { readConfig } from "./config.ts";

const config = readConfig(process.env);
const capabilities = createAdapters(config);
await verifyRevokedAccess(capabilities, config);
capabilities.output.write(JSON.stringify({
  testedCommit: config.testedCommit,
  actionsRunUrl: config.actionsRunUrl,
  revokedHttp: true,
  revokedWebSocket: true,
}));
