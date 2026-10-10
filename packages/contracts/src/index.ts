export { Parsers } from "./parser.ts";

export type AccessJwtHeader = Readonly<{
  alg: "RS256";
  kid: string;
}>;

export type AccessJwtPayload = Readonly<{
  aud: string | ReadonlyArray<string>;
  common_name?: string;
  email?: string;
  exp: number;
  iss: string;
  sub: string;
}>;

export type AccessKeySet = Readonly<{
  keys: ReadonlyArray<
    Readonly<{
      alg: "RS256";
      e: string;
      kid: string;
      kty: "RSA";
      n: string;
      use: "sig";
    }>
  >;
}>;
