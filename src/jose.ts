// Per-subpath lazy loaders for jose — each caches its own promise to avoid redundant imports.

function lazyImport<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      cached = load();
    }
    return cached;
  };
}

export const loadJwtVerify = lazyImport(() => import("jose/jwt/verify"));
export const loadDecodeJwt = lazyImport(() => import("jose/jwt/decode"));
export const loadDecodeProtectedHeader = lazyImport(() => import("jose/decode/protected_header"));
export const loadKeyImport = lazyImport(() => import("jose/key/import"));
export const loadJwtSign = lazyImport(() => import("jose/jwt/sign"));
