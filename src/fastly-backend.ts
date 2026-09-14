import { FASTLY_BACKEND, FetchOptions } from "./types";

// Process-wide, mirroring SupertabConnect.baseUrl: the backend is a property of the Fastly
// service the SDK is deployed to, not of an individual request or instance.
let configuredBackend: string | undefined;

/**
 * Point the SDK's own Connect-API calls (license.xml, JWKS, events, analytics) at a
 * differently-named Fastly backend. Pass undefined to restore the default.
 */
export function setConnectBackend(name: string | undefined): void {
  configuredBackend = name?.trim() || undefined;
}

/** The configured Connect-API backend name, or the default when none was set. */
export function getConnectBackend(): string {
  return configuredBackend ?? FASTLY_BACKEND;
}

/**
 * The backend to route a Connect-API call through, or undefined off Fastly — every other
 * runtime resolves the host itself, and naming a backend there is meaningless.
 */
export function connectBackend(): string | undefined {
  return globalThis.fastly ? getConnectBackend() : undefined;
}

/** Adds the Connect-API backend to fetch options when running on Fastly. */
export function withFastlyBackend(options: FetchOptions): FetchOptions {
  const backend = connectBackend();
  return backend ? { ...options, backend } : options;
}
