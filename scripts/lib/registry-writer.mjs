import { readFileSync } from "node:fs";
import pg from "pg";

// The privileged registry connection for operator-run intake. It accepts only the
// Supabase project the runtime role already points at, the postgres role and verified
// TLS. The application never imports this module.
export async function connectRegistryWriter({ env = process.env, sessionPooler = false, applicationName } = {}) {
  const url = new URL(env.DATABASE_MIGRATION_URL ?? "");
  const runtime = new URL(env.DATABASE_URL ?? "");
  const project = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !project ||
    !decodeURIComponent(runtime.username).endsWith(`.${project}`) || url.pathname !== runtime.pathname ||
    !runtime.hostname.endsWith(".pooler.supabase.com") || runtime.port !== "6543" ||
    decodeURIComponent(url.username) !== "postgres" || !url.password) throw new Error("Unexpected project configuration");
  if (url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "verify-full") throw new Error("Verified TLS required");
  for (const key of url.searchParams.keys()) if (key !== "sslmode") throw new Error("Unexpected connection option");
  url.searchParams.delete("sslmode");
  if (sessionPooler) { url.hostname = runtime.hostname; url.port = "5432"; url.username = `postgres.${project}`; }
  const inline = env.DATABASE_CA_CERT?.trim();
  const ca = inline ? inline.replace(/\\n/g, "\n") : env.DATABASE_CA_CERT_PATH ? readFileSync(env.DATABASE_CA_CERT_PATH, "utf8") : undefined;
  const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, connectionTimeoutMillis: 10_000, application_name: applicationName });
  await client.connect();
  const identity = (await client.query("SELECT current_user = $1 AS expected_role, current_database() = $2 AS expected_database", ["postgres", decodeURIComponent(url.pathname.slice(1))])).rows[0];
  if (!identity.expected_role || !identity.expected_database || !client.connection.stream.authorized) {
    await client.end();
    throw new Error("Unexpected database identity or TLS");
  }
  return client;
}
