// Per-subpath lazy loaders for jose — each caches its own promise to avoid redundant imports.

let jwtVerifyPromise: Promise<typeof import("jose/jwt/verify")> | null = null;
let decodeJwtPromise: Promise<typeof import("jose/jwt/decode")> | null = null;
let decodeProtectedHeaderPromise: Promise<typeof import("jose/decode/protected_header")> | null = null;
let keyImportPromise: Promise<typeof import("jose/key/import")> | null = null;
let jwtSignPromise: Promise<typeof import("jose/jwt/sign")> | null = null;

/** Verification: jwtVerify (used by license.ts) */
export function loadJwtVerify() {
  if (!jwtVerifyPromise) {
    jwtVerifyPromise = import("jose/jwt/verify");
  }
  return jwtVerifyPromise;
}

/** Decode JWT payload without verification (used by license.ts) */
export function loadDecodeJwt() {
  if (!decodeJwtPromise) {
    decodeJwtPromise = import("jose/jwt/decode");
  }
  return decodeJwtPromise;
}

/** Decode protected header (used by license.ts) */
export function loadDecodeProtectedHeader() {
  if (!decodeProtectedHeaderPromise) {
    decodeProtectedHeaderPromise = import("jose/decode/protected_header");
  }
  return decodeProtectedHeaderPromise;
}

/** Key import: importPKCS8 (used by customer.ts) */
export function loadKeyImport() {
  if (!keyImportPromise) {
    keyImportPromise = import("jose/key/import");
  }
  return keyImportPromise;
}

/** JWT signing: SignJWT (used by customer.ts) */
export function loadJwtSign() {
  if (!jwtSignPromise) {
    jwtSignPromise = import("jose/jwt/sign");
  }
  return jwtSignPromise;
}
