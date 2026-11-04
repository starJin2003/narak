import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootCertificates } from "node:tls";

const fake = vi.hoisted(() => ({ pool: vi.fn(), connect: vi.fn() }));
vi.mock("pg", () => ({ Pool: class {
  constructor(options: unknown) { fake.pool(options); }
  on() { return this; }
  connect() { return fake.connect(); }
} }));
const url = "postgresql://narak_runtime_reader:SYNTHETIC-PASSWORD@pooler.example.com:6543/postgres?sslmode=verify-full";

beforeEach(() => {
  vi.resetModules(); fake.pool.mockReset(); fake.connect.mockReset();
  vi.stubEnv("DATABASE_URL", url); vi.stubEnv("DATABASE_CA_CERT", rootCertificates[0]!); vi.stubEnv("DATABASE_CA_CERT_PATH", "");
  fake.connect.mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() });
});
afterEach(() => vi.unstubAllEnvs());

describe("registry invalid-configuration classification using synthetic settings only", () => {
  it("retains remote chain/hostname checks and read-only transactions with valid inline CA", async () => {
    vi.stubEnv("DATABASE_CA_CERT_PATH", "/missing/deployment-file.pem");
    const { withKnowledgeRead } = await import("@/server/knowledge/database");
    expect(await withKnowledgeRead(async () => [])).toEqual({ state: "available", data: [] });
    const options = fake.pool.mock.calls[0]![0];
    expect(options.connectionString).not.toContain("sslmode");
    expect(options.ssl).toEqual({ rejectUnauthorized: true, ca: rootCertificates[0] });
    expect(options.ssl).not.toHaveProperty("checkServerIdentity");
    const client = await fake.connect.mock.results[0]!.value;
    expect(client.query.mock.calls[0][0]).toContain("READ ONLY");
  });
  it.each([
    "not-a-url", "https://pooler.example.com/", url.replace("verify-full","require"),
    url.replace("verify-full","disable"), url + "&sslrootcert=local.pem", url + "&sslkey=private.pem",
    url + "&host=127.0.0.1", url + "&hostaddr=127.0.0.1",
  ])("rejects invalid/insecure URL configuration before connecting: %s", async (value) => {
    vi.stubEnv("DATABASE_URL", value);
    const { withKnowledgeRead } = await import("@/server/knowledge/database");
    const result = await withKnowledgeRead(async () => []);
    expect(result).toEqual({ state: "unavailable", code: "invalid_configuration" });
    expect(fake.pool).not.toHaveBeenCalled(); expect(fake.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|pooler\.example/);
  });
  it.each(["missing_file", "malformed_pem", "quoted_pem"])("classifies CA setup error %s before connecting", async (kind) => {
    vi.stubEnv("DATABASE_CA_CERT", kind === "missing_file" ? "" : kind === "quoted_pem" ? JSON.stringify(rootCertificates[0]) : "PRIVATE-INVALID-CA");
    vi.stubEnv("DATABASE_CA_CERT_PATH", "/nonexistent/local-only-root.pem");
    const { withKnowledgeRead } = await import("@/server/knowledge/database");
    const result = await withKnowledgeRead(async () => []);
    expect(result).toEqual({ state: "unavailable", code: "invalid_configuration" });
    expect(fake.connect).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("keeps handshake/authentication/network failures distinct from configuration validation", async () => {
    fake.connect.mockRejectedValue(new Error("PRIVATE-DRIVER-ERROR"));
    const { withKnowledgeRead } = await import("@/server/knowledge/database");
    expect(await withKnowledgeRead(async () => [])).toEqual({ state: "unavailable", code: "database_unavailable" });
  });
  it("requires a process restart for a changed cached URL and does not silently reuse the old pool", async () => {
    const { withKnowledgeRead } = await import("@/server/knowledge/database");
    await withKnowledgeRead(async () => []);
    vi.stubEnv("DATABASE_URL", url.replace("/postgres?", "/changed?"));
    expect(await withKnowledgeRead(async () => [])).toEqual({ state: "unavailable", code: "invalid_configuration" });
    expect(fake.pool).toHaveBeenCalledTimes(1);
  });
});
