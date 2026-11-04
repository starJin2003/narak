import "server-only";
import { Pool, type PoolClient } from "pg";
import { databaseTlsOptions } from "./tls";
import type { KnowledgeReader } from "./types";

let pool: Pool | undefined;
let poolConnectionString: string | undefined;

function getPool(connectionString: string): Pool {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid database URL");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // Connection-string SSL flags override pg's SSL object. Require verification
  // for remote hosts and remove those flags before handing configuration to pg.
  if (!local && url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Remote database connections require verified TLS");
  }
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"]) {
    if (name !== "sslmode" && url.searchParams.has(name)) throw new Error("Use the server TLS trust configuration");
    url.searchParams.delete(name);
  }
  // A URL query must not redirect a validated remote hostname to a local socket.
  if (url.searchParams.has("host") || url.searchParams.has("hostaddr")) throw new Error("Set the host in the database URL authority");
  if (pool && poolConnectionString !== url.toString()) throw new Error("Restart the server after changing the database URL");
  if (!pool) {
    pool = new Pool({
      connectionString: url.toString(),
      ssl: local ? false : databaseTlsOptions(),
      max: 3, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000,
      application_name: "narak-knowledge-reader",
    });
    // Never log connection details from idle-client error events.
    pool.on("error", () => undefined);
    poolConnectionString = url.toString();
  }
  return pool;
}

export const withKnowledgeRead: KnowledgeReader = async (operation) => {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return { state: "unavailable", code: "not_configured" };
  let selected: Pool;
  try { selected = getPool(url); }
  catch { return { state: "unavailable", code: "invalid_configuration" }; }
  let client: PoolClient | undefined;
  let destroy = false;
  try {
    client = await selected.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)", ["5000", "10000"]);
    const data = await operation(client);
    await client.query("COMMIT");
    return { state: "available", data };
  } catch {
    destroy = true;
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    // A missing migration, permissions problem, invalid row, or network failure
    // is unavailable evidence, never a successful empty knowledge base.
    return { state: "unavailable", code: "database_unavailable" };
  } finally {
    client?.release(destroy);
  }
};
