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

/**
 * Emits events to a Fastly named logging endpoint (`fastly:logger`) → S3 → Tinybird,
 * instead of the HTTP relay (keeps the firehose off the backend). Stamps
 * `merchant_system_urn` from config — the relay derives it server-side, but here there's
 * no backend to do so.
 */
export class FastlyLogTransport implements AnalyticsTransport {
  private readonly endpoint: string;
  private readonly merchantSystemUrn: string;
  private readonly debug: boolean;
  private logger?: { log(message: string): void };

  constructor(opts: { endpoint: string; merchantSystemUrn: string; debug?: boolean }) {
    this.endpoint = opts.endpoint;
    this.merchantSystemUrn = opts.merchantSystemUrn;
    this.debug = opts.debug ?? false;
  }

  emit(event: AnalyticsEvent, ctx?: ExecutionContext): void {
    // One JSON object per line (Fastly batches them into NDJSON for S3).
    const line = JSON.stringify({ merchant_system_urn: this.merchantSystemUrn, ...event });

    // Steady state: Logger cached → synchronous, no import/alloc per event.
    if (this.logger) {
      try {
        this.logger.log(line);
      } catch (err) {
        if (this.debug) console.error("[SupertabConnect] fastly log emit error:", err);
      }
      return;
    }

    // First event: load the built-in once, cache the Logger, then log.
    const promise = (async () => {
      try {
        const { Logger } = await import("fastly:logger");
        this.logger ??= new Logger(this.endpoint);
        this.logger.log(line);
      } catch (err) {
        if (this.debug) console.error("[SupertabConnect] fastly log emit error:", err);
      }
    })();

    if (ctx?.waitUntil) {
      ctx.waitUntil(promise);
    }
    // Otherwise detached — .log() buffers off the request path.
  }
}

/**
 * Fastly-only transport selection, owned by the Fastly handler (not the platform-agnostic
 * SupertabConnect constructor). Returns a FastlyLogTransport when the merchant opted into
 * native bot-events logging (`logEndpoint` set) and identity can be stamped (`merchantSystemUrn`);
 * otherwise `undefined`, leaving the constructor to pick the HTTP relay / no-op.
 */
export function selectFastlyAnalyticsTransport(opts: {
  analyticsEnabled?: boolean;
  logEndpoint?: string;
  merchantSystemUrn?: string;
  debug?: boolean;
}): AnalyticsTransport | undefined {
  if (opts.analyticsEnabled && opts.logEndpoint && opts.merchantSystemUrn) {
    return new FastlyLogTransport({
      endpoint: opts.logEndpoint,
      merchantSystemUrn: opts.merchantSystemUrn,
      debug: opts.debug ?? false,
    });
  }
  return undefined;
}
