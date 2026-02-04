type JoseModule = typeof import("jose");

let joseModulePromise: Promise<JoseModule> | null = null;

/**
 * Lazily load the ESM-only `jose` package so the CommonJS build can call it via dynamic import.
 */
export function loadJose(): Promise<JoseModule> {
  if (!joseModulePromise) {
    joseModulePromise = import("jose");
  }
  return joseModulePromise;
}
