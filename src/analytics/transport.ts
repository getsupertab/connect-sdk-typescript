import { ExecutionContext, FASTLY_BACKEND, FetchOptions } from "../types";
import { SDK_USER_AGENT } from "../version";
import { AnalyticsEvent, AnalyticsTransport } from "./types";

export const DEFAULT_ANALYTICS_ENDPOINT =
  "https://api.europe-west2.gcp.tinybird.co/v0/events?name=bot_events_raw";

export class NoopAnalyticsTransport implements AnalyticsTransport {
  emit(_event: AnalyticsEvent, _ctx?: ExecutionContext): void {
    // intentional no-op
  }
}

export class HttpAnalyticsTransport implements AnalyticsTransport {
  private readonly url: string;
  private readonly token: string;
  private readonly debug: boolean;

  constructor(opts: { url: string; token: string; debug?: boolean }) {
    this.url = opts.url;
    this.token = opts.token;
    this.debug = opts.debug ?? false;
  }

  emit(event: AnalyticsEvent, ctx?: ExecutionContext): void {
    const body = JSON.stringify(event) + "\n";
    let options: FetchOptions = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/x-ndjson",
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
