import type { Capabilities, Capability } from "@beff/diy";

type CryptoService = Readonly<{
  importKey: SubtleCrypto["importKey"];
  verify: SubtleCrypto["verify"];
}>;

export type WebhookCryptoCapability = Capability<"crypto", CryptoService>;

const decodeHex = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[0-9a-f]{64}$/u.test(value)) return undefined;
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
};

export async function hasValidWebhookSignature(
  capabilities: Capabilities<WebhookCryptoCapability>,
  secret: string,
  request: Request,
): Promise<boolean> {
  const header = request.headers.get("X-Hub-Signature-256");
  if (header === null || !header.startsWith("sha256=")) return false;
  const signature = decodeHex(header.slice("sha256=".length));
  if (signature === undefined) return false;

  const key = await capabilities.crypto.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return capabilities.crypto.verify("HMAC", key, signature, await request.arrayBuffer());
}
