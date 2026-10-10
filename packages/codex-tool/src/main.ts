import process from "node:process";

import { runServer } from "./server.ts";

await runServer(process.env);
