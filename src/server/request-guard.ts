import "server-only";
import type { ReviewIssue } from "@/lib/review-contract";

// Bounds repeated paid requests. Each review and variant spends Meta credits, and the
// routes are public. This guard lives in one server instance, so it bounds a client per
// instance only. A platform rate limit rule, such as the Vercel Firewall, is the control
// that holds across instances, and the workspace owner configures it.
export const LIMITS = {
  review: { max: 10, windowMs: 10 * 60_000 },
  variant: { max: 5, windowMs: 10 * 60_000 },
} as const;
export const MAX_IN_FLIGHT = 8;
const MAX_TRACKED_CLIENTS = 5_000;

type Kind = keyof typeof LIMITS;

// Vercel overwrites x-forwarded-for with the client's public address and forwards no
// external value (https://vercel.com/docs/headers/request-headers), so it cannot be forged
// there. Elsewhere it can be, which only lets a caller pick a bucket. The in-flight cap still
// applies. One IPv6 host usually controls a whole /64 and can rotate addresses inside it, so
// IPv6 clients share one bucket per /64. IPv4-mapped IPv6 addresses count as IPv4.
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  const value = (forwarded || real || "local").slice(0, 64);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return mapped[1]!;
  return value.includes(":") ? ipv6Prefix(value) ?? value : value;
}

// The first four 16-bit groups of an IPv6 address, written in full, or null when the value
// is not a plain IPv6 address.
function ipv6Prefix(value: string): string | null {
  const address = value.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(address) || (address.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = address.includes("::") ? address.split("::") as [string, string] : [address, null];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return `${groups.slice(0, 4).map((group) => group.padStart(4, "0")).join(":")}::/64`;
}

export function createRequestGuard(now: () => number = Date.now) {
  const recent = new Map<string, number[]>();
  let inFlight = 0;

  function prune(key: string, kind: Kind, at: number) {
    const kept = (recent.get(key) ?? []).filter((time) => at - time < LIMITS[kind].windowMs);
    if (kept.length) recent.set(key, kept); else recent.delete(key);
    return kept;
  }

  return {
    // Returns a release function, or an issue explaining why the request was refused.
    admit(kind: Kind, client: string): { release: () => void } | { issue: ReviewIssue } {
      const at = now();
      const key = `${kind}:${client}`;
      const times = prune(key, kind, at);
      if (times.length >= LIMITS[kind].max) {
        const waitMinutes = Math.max(1, Math.ceil((LIMITS[kind].windowMs - (at - times[0]!)) / 60_000));
        return { issue: { code: "rate_limit", retryable: true,
          message: `This connection has started ${LIMITS[kind].max} ${kind === "review" ? "reviews" : "variants"} in the last ${LIMITS[kind].windowMs / 60_000} minutes. Please wait about ${waitMinutes} ${waitMinutes === 1 ? "minute" : "minutes"} and try again.` } };
      }
      if (inFlight >= MAX_IN_FLIGHT) {
        return { issue: { code: "rate_limit", retryable: true, message: "The review service is busy with other requests. Please wait a minute and try again." } };
      }
      if (!recent.has(key) && recent.size >= MAX_TRACKED_CLIENTS) {
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) recent.delete(oldest);
      }
      recent.set(key, [...times, at]);
      inFlight += 1;
      let released = false;
      return { release: () => { if (!released) { released = true; inFlight -= 1; } } };
    },
    get inFlight() { return inFlight; },
    get trackedClients() { return recent.size; },
  };
}

export const requestGuard = createRequestGuard();
