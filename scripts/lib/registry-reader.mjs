import { readFileSync } from "node:fs";
import pg from "pg";

// A read-only registry connection for operator dry runs, through the runtime reader role.
// Remote hosts need verified TLS. The connection never writes; every query runs inside a
// read-only transaction opened by the caller.
export async function connectRegistryReader({ env = process.env, applicationName = "narak-case-review-reader" } = {}) {
  const url = new URL(env.DATABASE_URL ?? "");
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Unexpected database URL");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && url.searchParams.get("sslmode") !== "verify-full") throw new Error("Verified TLS required");
  for (const key of url.searchParams.keys()) if (key !== "sslmode") throw new Error("Unexpected connection option");
  url.searchParams.delete("sslmode");
  const inline = env.DATABASE_CA_CERT?.trim();
  const ca = inline ? inline.replace(/\\n/g, "\n") : env.DATABASE_CA_CERT_PATH ? readFileSync(env.DATABASE_CA_CERT_PATH, "utf8") : undefined;
  const client = new pg.Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: 10_000, application_name: applicationName });
  await client.connect();
  if (!local && !client.connection.stream.authorized) { await client.end(); throw new Error("Unverified TLS"); }
  return client;
}
