import type { Capabilities, Capability } from "@beff/diy/capabilities";
import { Parsers, type AccessKeySet } from "@github-webhook-relay/core";

type HttpClient = Readonly<{ fetch: typeof fetch }>;
type Clock = Readonly<{ now: () => number }>;
type AccessKeyStore = Readonly<{
  read: (url: string) => Promise<unknown | undefined>;
  write: (url: string, value: unknown) => Promise<void>;
}>;
type CryptoService = Readonly<{
  importKey: SubtleCrypto["importKey"];
  verify: SubtleCrypto["verify"];
}>;

export type HttpCapability = Capability<"http", HttpClient>;
export type ClockCapability = Capability<"clock", Clock>;
export type AccessKeyStoreCapability = Capability<
  "accessKeyStore",
  AccessKeyStore
>;
export type CryptoCapability = Capability<"crypto", CryptoService>;

export type AccessConfiguration = Readonly<{
  audience: string;
  teamDomain: string;
}>;

export type AccessPrincipal =
  | Readonly<{ kind: "identity"; subject: string; email?: string }>
  | Readonly<{ kind: "service"; clientId: string }>;

type AccessKey = AccessKeySet["keys"][number];

type ParsedToken = Readonly<{
  encodedHeader: string;
  encodedPayload: string;
  header: Readonly<{ kid: string }>;
  payload: Readonly<{
    aud: string | ReadonlyArray<string>;
    commonName?: string;
    email?: string;
    exp: number;
    issuer: string;
    subject: string;
  }>;
  signature: Uint8Array<ArrayBuffer>;
}>;

const decodeBase64Url = (
  value: string,
): Uint8Array<ArrayBuffer> | undefined => {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
};

const decodeJson = (value: string): unknown => {
  const bytes = decodeBase64Url(value);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
};

const parseToken = (token: string): ParsedToken | undefined => {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) return undefined;

  const headerResult = Parsers.AccessJwtHeader.safeParse(decodeJson(encodedHeader));
  const payloadResult = Parsers.AccessJwtPayload.safeParse(
    decodeJson(encodedPayload),
  );
  const signature = decodeBase64Url(encodedSignature);
  if (!headerResult.success || !payloadResult.success || signature === undefined) {
    return undefined;
  }
  const payload = payloadResult.data;
  return {
    encodedHeader,
    encodedPayload,
    header: { kid: headerResult.data.kid },
    payload: {
      aud: payload.aud,
      exp: payload.exp,
      issuer: payload.iss,
      subject: payload.sub,
      ...(payload.common_name === undefined
        ? {}
        : { commonName: payload.common_name }),
      ...(payload.email === undefined ? {} : { email: payload.email }),
    },
    signature,
  };
};

const parseAccessKeys = (
  value: unknown,
): ReadonlyArray<AccessKey> | undefined => {
  const result = Parsers.AccessKeySet.safeParse(value);
  return result.success ? result.data.keys : undefined;
};

const normalizeTeamDomain = (teamDomain: string): string =>
  teamDomain.endsWith("/") ? teamDomain.slice(0, -1) : teamDomain;

const getPrincipal = (token: ParsedToken): AccessPrincipal | undefined => {
  if (token.payload.subject.length > 0) {
    return {
      kind: "identity",
      subject: token.payload.subject,
      ...(token.payload.email === undefined ? {} : { email: token.payload.email }),
    };
  }
  if (
    token.payload.subject === "" &&
    token.payload.email === undefined &&
    token.payload.commonName !== undefined &&
    token.payload.commonName.length > 0
  ) {
    return { kind: "service", clientId: token.payload.commonName };
  }
  return undefined;
};

const includesAudience = (
  audience: string | ReadonlyArray<string>,
  expected: string,
): boolean => typeof audience === "string"
  ? audience === expected
  : audience.includes(expected);

export async function verifyAccessToken(
  capabilities: Capabilities<ClockCapability | CryptoCapability>,
  configuration: AccessConfiguration,
  keys: ReadonlyArray<AccessKey>,
  token: string,
): Promise<AccessPrincipal | undefined> {
  const parsed = parseToken(token);
  if (parsed === undefined) return undefined;
  const issuer = normalizeTeamDomain(configuration.teamDomain);
  if (
    parsed.payload.issuer !== issuer ||
    !includesAudience(parsed.payload.aud, configuration.audience) ||
    parsed.payload.exp <= Math.floor(capabilities.clock.now() / 1_000)
  ) return undefined;

  const key = keys.find((candidate) => candidate.kid === parsed.header.kid);
  if (key === undefined) return undefined;

  try {
    const cryptoKey = await capabilities.crypto.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(
      `${parsed.encodedHeader}.${parsed.encodedPayload}`,
    );
    const valid = await capabilities.crypto.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      parsed.signature,
      data,
    );
    return valid ? getPrincipal(parsed) : undefined;
  } catch {
    return undefined;
  }
}

async function getAccessKeys(
  capabilities: Capabilities<HttpCapability | AccessKeyStoreCapability>,
  teamDomain: string,
): Promise<ReadonlyArray<AccessKey> | undefined> {
  const keyUrl = `${normalizeTeamDomain(teamDomain)}/cdn-cgi/access/certs`;
  const stored = await capabilities.accessKeyStore.read(keyUrl);
  const storedKeys = parseAccessKeys(stored);
  if (storedKeys !== undefined) return storedKeys;

  const response = await capabilities.http.fetch(keyUrl);
  if (!response.ok) return undefined;
  const value: unknown = await response.json();
  const keys = parseAccessKeys(value);
  if (keys === undefined) return undefined;
  await capabilities.accessKeyStore.write(keyUrl, value);
  return keys;
}

export async function authenticateAccessRequest(
  capabilities: Capabilities<
    | HttpCapability
    | ClockCapability
    | AccessKeyStoreCapability
    | CryptoCapability
  >,
  configuration: AccessConfiguration,
  request: Request,
): Promise<AccessPrincipal | undefined> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  const token = assertion ?? request.headers
    .get("Cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("CF_Authorization="))
    ?.slice("CF_Authorization=".length);
  if (token === undefined || token === null) return undefined;
  const keys = await getAccessKeys(capabilities, configuration.teamDomain);
  return keys === undefined
    ? undefined
    : verifyAccessToken(capabilities, configuration, keys, token);
}
