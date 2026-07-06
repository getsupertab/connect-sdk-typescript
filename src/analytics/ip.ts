const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

const UNSPECIFIED = "::";

export function normalizeClientIp(raw: string | undefined | null): string {
  if (!raw) return UNSPECIFIED;
  const trimmed = raw.trim();
  if (!trimmed) return UNSPECIFIED;

  if (IPV4_RE.test(trimmed)) {
    return `::ffff:${trimmed}`;
  }
  if (IPV6_RE.test(trimmed) && trimmed.includes(":")) {
    return trimmed;
  }
  return UNSPECIFIED;
}
