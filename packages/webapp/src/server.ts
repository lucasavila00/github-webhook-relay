import type { Capabilities, Capability } from "@beff/diy/capabilities";

export type AssetCapability = Capability<
  "assets",
  Readonly<{ fetch: (request: Request) => Promise<Response> }>
>;

export function serveBrowserAsset(
  capabilities: Capabilities<AssetCapability>,
  request: Request,
): Promise<Response> {
  return capabilities.assets.fetch(request);
}
