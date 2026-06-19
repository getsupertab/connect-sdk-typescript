import { ExecutionContext, FASTLY_BACKEND, FetchOptions } from "../types";
import { SDK_USER_AGENT } from "../version";
import { AnalyticsEvent, AnalyticsTransport } from "./types";

export const ANALYTICS_EVENTS_PATH = "/ingest/events";

export class NoopAnalyticsTransport implements AnalyticsTransport {
  emit(_event: AnalyticsEvent, _ctx?: ExecutionContext): void {
    // intentional no-op
  }
}

export class HttpAnalyticsTransport implements AnalyticsTransport {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly debug: boolean;

  constructor(opts: { url: string; apiKey: string; debug?: boolean }) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.debug = opts.debug ?? false;
  }

  emit(event: AnalyticsEvent, ctx?: ExecutionContext): void {
    const body = JSON.stringify(event);
    let options: FetchOptions = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": SDK_USER_AGENT,
      },
      body,
    };
    if (globalThis.fastly) {
      options = { ...options, backend: FASTLY_BACKEND };
    }

    const promise = (async () => {
      try {
        const response = await fetch(this.url, options);
        if (!response.ok && this.debug) {
          let detail = "";
          try {
            detail = await response.text();
          } catch {
            // ignore
          }
          console.error(
            `[SupertabConnect] analytics emit failed: ${response.status}${detail ? ` — ${detail}` : ""}`
          );
        }
      } catch (err) {
        if (this.debug) {
          console.error("[SupertabConnect] analytics emit error:", err);
        }
      }
    })();

    if (ctx?.waitUntil) {
      ctx.waitUntil(promise);
    }
    // Otherwise the promise runs in the background; the IIFE swallows errors so
    // there's nothing to await on the request path.
  }
}

// Ambient declaration for the Fastly Compute built-in logging module. @fastly/js-compute
// is not an SDK dependency (the module only exists in the Compute runtime), so we declare
// the minimal surface we use. The import below is dynamic + marked external in tsup, so it
// is never bundled and only evaluates inside Fastly.
declare module "fastly:logger" {
  export class Logger {
    constructor(endpoint: string);
    log(message: string): void;
  }
}

/** Default named Fastly logging endpoint analytics rows are written to. */
export const DEFAULT_FASTLY_LOG_ENDPOINT = "bot_events";

/**
 * Emits analytics events to a Fastly named logging endpoint (`fastly:logger`), which Fastly
 * ships off the request path to S3 for the Tinybird connector to import. Used instead of the
 * HTTP relay on Fastly to keep the request-layer firehose off the backend.
 *
 * Unlike the relay (where the backend stamps `merchant_system_urn` from the apiKey), this path
 * has no backend in the way, so the URN is stamped here from config.
 */
export class FastlyLogTransport implements AnalyticsTransport {
  private readonly endpoint: string;
  private readonly merchantSystemUrn: string;
  private readonly debug: boolean;

  constructor(opts: { endpoint?: string; merchantSystemUrn: string; debug?: boolean }) {
    this.endpoint = opts.endpoint ?? DEFAULT_FASTLY_LOG_ENDPOINT;
    this.merchantSystemUrn = opts.merchantSystemUrn;
    this.debug = opts.debug ?? false;
  }

  emit(event: AnalyticsEvent, ctx?: ExecutionContext): void {
    // One JSON object per line; Fastly batches lines into the NDJSON files the S3 connector
    // reads. merchant_system_urn is added here (the relay omits it — see class doc).
    const line = JSON.stringify({ merchant_system_urn: this.merchantSystemUrn, ...event });

    const promise = (async () => {
      try {
        const { Logger } = await import("fastly:logger");
        new Logger(this.endpoint).log(line);
      } catch (err) {
        if (this.debug) {
          console.error("[SupertabConnect] fastly log emit error:", err);
        }
      }
    })();

    if (ctx?.waitUntil) {
      ctx.waitUntil(promise);
    }
    // Otherwise detached; once .log() runs Fastly buffers the line off the request path.
  }
}
