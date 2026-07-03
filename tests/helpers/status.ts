import { vi } from "vitest";
import { AnalyticsEvent, AnalyticsTransport } from "../../src/analytics/types";
import { CloudFrontHeaders, CloudFrontRequestEvent, ExecutionContext } from "../../src/types";

const STATUS_PATH = "/.well-known/supertab/status";

/** A minimal ExecutionContext stub that satisfies the interface. */
export function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn() };
}

/** Build a Request to the status endpoint, optionally with a Bearer challenge. */
export function makeStatusRequest(token?: string, origin = "https://acme.com"): Request {
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return new Request(`${origin}${STATUS_PATH}`, { method: "GET", headers });
}

/**
 * Build a CloudFront origin-request event for the status endpoint. The probe carries
 * Authorization: Bearer, NOT x-license-auth, so the wrapper's early "no x-license-auth →
 * pass to origin" short-circuit must let it through.
 */
export function makeCfStatusEvent(token?: string, host = "acme.com"): CloudFrontRequestEvent {
  const headers: CloudFrontHeaders = { host: [{ key: "Host", value: host }] };
  if (token) {
    headers["authorization"] = [{ key: "Authorization", value: `Bearer ${token}` }];
  }
  return {
    Records: [
      {
        cf: {
          config: { requestId: "req-1" },
          request: { uri: STATUS_PATH, method: "GET", querystring: "", headers, clientIp: "1.2.3.4" },
        },
      },
    ],
  };
}

/** Analytics transport that records every emitted event — used to assert none are emitted. */
export class RecordingTransport implements AnalyticsTransport {
  public events: AnalyticsEvent[] = [];
  emit(event: AnalyticsEvent, _ctx?: ExecutionContext): void {
    this.events.push(event);
  }
}
