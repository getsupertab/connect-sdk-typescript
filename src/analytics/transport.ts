import { ExecutionContext, FetchOptions } from "../types";
import { withFastlyBackend } from "../fastly-backend";
import { SDK_USER_AGENT } from "../version";
import { AnalyticsEvent, AnalyticsTransport } from "./types";

export const ANALYTICS_EVENTS_PATH = "/ingest/events";

export class NoopAnalyticsTransport implements AnalyticsTransport {
  emit(_event: AnalyticsEvent, _ctx?: ExecutionContext): void {
    // intentional no-op
  }
}

/**
 * Emits analytics events to the HTTP ingest relay. Fire-and-forget by default; on runtimes
 * without `waitUntil` the caller is responsible for awaiting the emit before teardown.
 */
export class HttpAnalyticsTransport implements AnalyticsTransport {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly debug: boolean;

  /**
   * @param opts Transport configuration.
   * @param opts.url Full ingest endpoint URL to POST events to.
   * @param opts.apiKey Merchant API key sent as the bearer token.
   * @param opts.debug Log each emit's status, verdict and duration (default: false).
   */
  constructor(opts: { url: string; apiKey: string; debug?: boolean }) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.debug = opts.debug ?? false;
  }

  /**
   * Emit one analytics event. Never throws and never rejects — a failed emit is swallowed
   * (logged only under `debug`) so analytics can never alter request handling.
   * @param event The event to send.
   * @param ctx Execution context, when the runtime has one. Its `waitUntil` holds the
   *   runtime open for the emit, and its `signal` aborts the emit at a background-work
   *   deadline (CloudFront). Without it the emit is left detached.
   */
  emit(event: AnalyticsEvent, ctx?: ExecutionContext): void {
    const body = JSON.stringify(event);
    const options: FetchOptions = withFastlyBackend({
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": SDK_USER_AGENT,
      },
      body,
      // Runtimes with a background-work deadline (CloudFront) abort the emit through this;
      // undefined elsewhere.
      signal: ctx?.signal,
    });

    const requestId = event.request_id;
    const promise = (async () => {
      const startedAt = Date.now();
      try {
        const response = await fetch(this.url, options);
        // Always consume the body, debug or not: it releases the connection. It also carries
        // the relay's {accepted: true|false} verdict, since the relay answers 200 even for
        // events it ignores — a plain status check would call those a success.
        let text = "";
        try {
          text = await response.text();
        } catch {
          // body read failed; status alone still gets logged
        }
        if (this.debug) {
          const durationMs = Date.now() - startedAt;
          if (response.ok) {
            let accepted: boolean | undefined;
            try {
              accepted = JSON.parse(text)?.accepted;
            } catch {
              // non-JSON body; report the verdict as unknown
            }
            console.log(
              `[SupertabConnect] analytics emit: status=${response.status} accepted=${accepted} request_id=${requestId} duration=${durationMs}ms`
            );
          } else {
            const detail = text.slice(0, 200);
            console.error(
              `[SupertabConnect] analytics emit failed: status=${response.status} request_id=${requestId} duration=${durationMs}ms${detail ? ` — ${detail}` : ""}`
            );
          }
        }
      } catch (err) {
        if (this.debug) {
          console.error(
            `[SupertabConnect] analytics emit error: request_id=${requestId} duration=${Date.now() - startedAt}ms`,
            err
          );
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
 * @param opts Fastly handler options relevant to transport choice.
 * @param opts.analyticsEnabled Whether analytics emission is on at all.
 * @param opts.logEndpoint Named Fastly logging endpoint to emit bot events to.
 * @param opts.merchantSystemUrn Merchant system URN stamped onto emitted rows.
 * @returns A FastlyLogTransport, or `undefined` to defer the choice to the constructor.
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
