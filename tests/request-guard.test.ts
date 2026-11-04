import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as reviewPost } from "@/app/api/review/route";
import { contentSecurityPolicy } from "@/proxy";
import { LIMITS, MAX_IN_FLIGHT, clientKey, createRequestGuard } from "@/server/request-guard";

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("request guard", () => {
  it("admits up to the window limit per client and says how long to wait", () => {
    let now = 0;
    const guard = createRequestGuard(() => now);
    for (let index = 0; index < LIMITS.review.max; index++) {
      const admitted = guard.admit("review", "203.0.113.5");
      if ("issue" in admitted) throw new Error("Expected admission");
      admitted.release();
    }
    const refused = guard.admit("review", "203.0.113.5");
    expect(refused).toMatchObject({ issue: { code: "rate_limit", retryable: true } });
    expect("issue" in refused && refused.issue.message).toContain("Please wait about 10 minutes");
    expect("release" in guard.admit("review", "198.51.100.7")).toBe(true);
    expect("release" in guard.admit("variant", "203.0.113.5")).toBe(true);
    now = LIMITS.review.windowMs + 1;
    expect("release" in guard.admit("review", "203.0.113.5")).toBe(true);
  });

  it("caps requests in flight and releases each slot once", () => {
    const guard = createRequestGuard(() => 0);
    const slots = Array.from({ length: MAX_IN_FLIGHT }, (_, index) => guard.admit("variant", `client-${index}`));
    expect(guard.inFlight).toBe(MAX_IN_FLIGHT);
    expect(guard.admit("variant", "client-extra")).toMatchObject({ issue: { message: expect.stringContaining("busy") } });
    const first = slots[0]!;
    if ("issue" in first) throw new Error("Expected admission");
    first.release(); first.release();
    expect(guard.inFlight).toBe(MAX_IN_FLIGHT - 1);
  });

  it("keeps its client table bounded", () => {
    const guard = createRequestGuard(() => 0);
    for (let index = 0; index < 5_100; index++) {
      const admitted = guard.admit("review", `client-${index}`);
      if ("release" in admitted) admitted.release();
    }
    expect(guard.trackedClients).toBeLessThanOrEqual(5_000);
  });

  it("reads the client address the hosting edge supplies", () => {
    const request = (headers: Record<string, string>) => new Request("http://localhost/api/review", { headers });
    expect(clientKey(request({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe("203.0.113.5");
    expect(clientKey(request({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientKey(request({}))).toBe("local");
  });

  it("gives every address inside one IPv6 /64 the same bucket, and maps IPv4 in IPv6 to IPv4", () => {
    const request = (ip: string) => new Request("http://localhost/api/review", { headers: { "x-forwarded-for": ip } });
    const prefix = "2001:0db8:0012:0034::/64";
    expect(clientKey(request("2001:db8:12:34::1"))).toBe(prefix);
    expect(clientKey(request("2001:db8:12:34:a1b2:c3d4:e5f6:789"))).toBe(prefix);
    expect(clientKey(request("[2001:DB8:12:34::ffff]"))).toBe(prefix);
    expect(clientKey(request("2001:db8:12:35::1"))).not.toBe(prefix);
    expect(clientKey(request("::ffff:203.0.113.5"))).toBe("203.0.113.5");
    expect(clientKey(request("not:an:address::zz"))).toBe("not:an:address::zz");
    // A rotating client inside one /64 now hits the window limit.
    const guard = createRequestGuard(() => 0);
    for (let index = 0; index < LIMITS.variant.max; index++) {
      const admitted = guard.admit("variant", clientKey(request(`2001:db8:12:34::${(index + 1).toString(16)}`)));
      if ("release" in admitted) admitted.release();
    }
    expect(guard.admit("variant", clientKey(request("2001:db8:12:34::beef")))).toMatchObject({ issue: { code: "rate_limit" } });
  });
});

describe("review route request bounds", () => {
  function request(client: string, copy = "An ordinary cup of tea.") {
    const form = new FormData();
    form.set("copy", copy);
    form.set("publicationDate", "2026-11-04");
    return new Request("http://localhost/api/review", { method: "POST", body: form, headers: { "x-forwarded-for": client } });
  }

  it("refuses requests past the limit before any Meta call, and never counts invalid input", async () => {
    vi.stubEnv("MODEL_API_KEY", "test-key");
    vi.stubEnv("DATABASE_URL", "");
    // Every admitted review reaches this stub, which answers like a rejected key.
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const client = "192.0.2.44";
    for (let index = 0; index < LIMITS.review.max + 2; index++) {
      expect((await reviewPost(request(client, ""))).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
    for (let index = 0; index < LIMITS.review.max; index++) {
      expect((await reviewPost(request(client))).status).toBe(503);
    }
    expect(fetcher).toHaveBeenCalledTimes(LIMITS.review.max);
    const refused = await reviewPost(request(client));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ state: "unavailable", issue: { code: "rate_limit" } });
    expect(fetcher).toHaveBeenCalledTimes(LIMITS.review.max);
  });

  it("does not count requests while Meta is not configured", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    for (let index = 0; index < LIMITS.review.max + 2; index++) {
      expect((await reviewPost(request("192.0.2.45"))).status).toBe(503);
    }
  });
});

describe("content security policy", () => {
  it("requires the request nonce for scripts and blocks framing, plugins and other origins", () => {
    const production = contentSecurityPolicy("abc123", { development: false, https: true });
    expect(production).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(production).not.toContain("unsafe-eval");
    for (const directive of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "upgrade-insecure-requests"]) {
      expect(production).toContain(directive);
    }
    const local = contentSecurityPolicy("abc123", { development: true, https: false });
    expect(local).toContain("'unsafe-eval'");
    expect(local).not.toContain("upgrade-insecure-requests");
  });
});
