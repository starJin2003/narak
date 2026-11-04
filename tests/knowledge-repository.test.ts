import { afterEach, describe, expect, it, vi } from "vitest";
import { createKnowledgeRepository } from "@/server/knowledge/repository";
import { withKnowledgeRead } from "@/server/knowledge/database";
import type { KnowledgeReader } from "@/server/knowledge/types";

afterEach(() => vi.unstubAllEnvs());

describe("knowledge repository boundaries", () => {
  it("distinguishes empty results from unavailable storage and parameterizes filters", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const read: KnowledgeReader = async (operation) => ({ state: "available", data: await operation({ query }) });
    const repository = createKnowledgeRepository(read);
    expect(await repository.listVerifiedCases(10)).toEqual({ state: "available", data: [] });
    expect(query.mock.calls[0]?.[1]).toEqual(["KR", "verified", 10]);
    expect(query.mock.calls[0]?.[0]).toContain("c.status = $2");
    expect(await repository.listEmergingCases()).toEqual({ state: "available", data: [] });
    expect(query.mock.calls[1]?.[1]).toEqual(["KR", "emerging", 25]);
    expect(await repository.getCaseById("00000000-0000-4000-8000-000000000001")).toEqual({ state: "available", data: null });
    expect(query.mock.calls[2]?.[1]).toEqual(["00000000-0000-4000-8000-000000000001", "KR", "verified", "emerging"]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid IDs and unbounded limits before querying", () => {
    const attempted = vi.fn();
    const read: KnowledgeReader = async () => { attempted(); return { state: "unavailable", code: "database_unavailable" }; };
    const repository = createKnowledgeRepository(read);
    expect(() => repository.getCaseById("'; DROP TABLE narak.knowledge_cases; --")).toThrow();
    for (const limit of [0, 101, 1.5]) expect(() => repository.listVerifiedCases(limit)).toThrow();
    expect(attempted).not.toHaveBeenCalled();
  });

  it("returns not_configured without attempting a database connection", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(await createKnowledgeRepository().listEmergingCases()).toEqual({ state: "unavailable", code: "not_configured" });
  });

  it.each(["not-a-url", "https://example.com/", "postgresql://user:private-value@example.com/db?sslmode=disable", "postgresql://user:private-value@example.com/db?host=127.0.0.1"])("handles invalid or insecure configuration without exposing it", async (url) => {
    vi.stubEnv("DATABASE_URL", url);
    const result = await withKnowledgeRead(async () => []);
    expect(result).toEqual({ state: "unavailable", code: "invalid_configuration" });
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("fails closed when a configured remote CA file cannot be read", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:private-value@example.com/db");
    vi.stubEnv("DATABASE_CA_CERT_PATH", "/nonexistent/narak-test-ca.pem");
    expect(await createKnowledgeRepository().listVerifiedCases()).toEqual({ state: "unavailable", code: "invalid_configuration" });
  });

  it("rejects malformed inline CA trust without leaking configuration", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:private-value@example.com/db");
    vi.stubEnv("DATABASE_CA_CERT", "invalid-private-certificate-placeholder");
    const result = await createKnowledgeRepository().listVerifiedCases();
    expect(result).toEqual({ state: "unavailable", code: "invalid_configuration" });
    expect(JSON.stringify(result)).not.toMatch(/private-value|certificate-placeholder/);
  });

  it("reports an unreachable local database without leaking driver details", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:private-value@127.0.0.1:1/narak");
    const result = await createKnowledgeRepository().listVerifiedCases();
    expect(result).toEqual({ state: "unavailable", code: "database_unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/private-value|127\.0\.0\.1|ECONNREFUSED/);
  });
});
