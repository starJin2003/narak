import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { checkServerIdentity } from "node:tls";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseTlsOptions } from "@/server/knowledge/tls";
import { createKnowledgeRepository } from "@/server/knowledge/repository";

// Explicit opt-in, read-only hosted verification. No Meta imports or calls.
describe.skipIf(process.env.NARAK_VERIFY_DEPLOYMENT_TLS !== "1")("deployment CA environment with hosted read-only access", () => {
  let client, url;
  beforeAll(async () => {
    const local = parseEnv(readFileSync(".env.local", "utf8"));
    url = new URL(local.DATABASE_URL);
    if (!decodeURIComponent(url.username).startsWith("narak_runtime_reader.") || url.port !== "6543" || url.searchParams.get("sslmode") !== "verify-full") throw new Error("Expected verified runtime connection");
    vi.stubEnv("DATABASE_URL", local.DATABASE_URL);
    vi.stubEnv("DATABASE_CA_CERT", readFileSync(local.DATABASE_CA_CERT_PATH, "utf8"));
    vi.stubEnv("DATABASE_CA_CERT_PATH", "");
    vi.stubEnv("DATABASE_MIGRATION_URL", ""); vi.stubEnv("MODEL_API_KEY", "");
    url.searchParams.delete("sslmode");
    client = new pg.Client({ connectionString: url.toString(), ssl: databaseTlsOptions(), connectionTimeoutMillis: 10000 });
    await client.connect();
  });
  afterAll(async () => { if (client) await client.end(); vi.unstubAllEnvs(); });
  it("validates the real certificate chain and hostname and rejects a mismatched hostname", async () => {
    expect(client.connection.stream.authorized).toBe(true);
    const peer = client.connection.stream.getPeerCertificate();
    expect(checkServerIdentity(url.hostname, peer)).toBeUndefined();
    expect(checkServerIdentity("narak-wrong-host.invalid", peer)?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect((await client.query("SELECT current_user AS role, current_setting('transaction_read_only') AS readonly")).rows[0]).toEqual({ role: "narak_runtime_reader", readonly: "on" });
  });
  it("uses the actual application repository without a CA file or privileged migration credentials", async () => {
    expect(process.env.DATABASE_MIGRATION_URL).toBe(""); expect(process.env.DATABASE_CA_CERT_PATH).toBe("");
    const repository = createKnowledgeRepository();
    const cases = await repository.listEmergingCases();
    expect(cases.state).toBe("available"); expect(cases.data).toHaveLength(3);
    expect(cases.data.every((row) => row.status === "emerging")).toBe(true);
    expect(await repository.listVerifiedCases()).toEqual({ state: "available", data: [] });
  });
});
