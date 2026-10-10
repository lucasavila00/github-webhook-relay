import { Capabilities } from "@beff/diy/capabilities";
import { render } from "preact";

import { App } from "./app.tsx";
import type { ClockCapability, HttpCapability, SocketCapability } from "./client.ts";
import "./style.css";

const capabilities = Capabilities.create<
  HttpCapability | ClockCapability | SocketCapability
>({
  http: { fetch: globalThis.fetch.bind(globalThis) },
  clock: {
    delay: (milliseconds) =>
      new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
  },
  socket: {
    open: (path) => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(`${protocol}//${location.host}${path}`);
    },
  },
});

const root = document.getElementById("app");
if (root === null) throw new Error("The app root is missing.");
render(<App capabilities={capabilities} />, root);
