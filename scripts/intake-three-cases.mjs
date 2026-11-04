import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import pg from "pg";
import { buildManifest, runIntake, IntakeConflict } from "./lib/three-case-intake.mjs";

const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !["--check-hosted", "--apply", "--session-pooler"].includes(flag)) || (flags.has("--apply") && flags.has("--check-hosted"))) {
  throw new Error("Use no flags to validate, or --check-hosted / --apply; optional --session-pooler");
}
const manifest = buildManifest();
console.log(JSON.stringify({ manifest: "valid", intended: { cases: 3, sources: 6, evidence: 14, triggers: 9 }, status: "emerging", humanReview: false }));
if (flags.has("--check-hosted") || flags.has("--apply")) {
  const require = createRequire(import.meta.url);
  require("@next/env").loadEnvConfig(process.cwd());
  let client;
  try {
    // Privileged credentials are used only in this trusted CLI, never exported.
    const url = new URL(process.env.DATABASE_MIGRATION_URL);
    const runtime = new URL(process.env.DATABASE_URL);
    const project = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !project ||
      !decodeURIComponent(runtime.username).endsWith(`.${project}`) || url.pathname !== runtime.pathname ||
      !runtime.hostname.endsWith(".pooler.supabase.com") || runtime.port !== "6543" ||
      decodeURIComponent(url.username) !== "postgres" || !url.password) throw new Error("Unexpected project configuration");
    if (url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "verify-full") throw new Error("Verified TLS required");
    for (const key of url.searchParams.keys()) if (key !== "sslmode") throw new Error("Unexpected connection option");
    url.searchParams.delete("sslmode");
    if (flags.has("--session-pooler")) {
      // Same project, migration username/password only; no runtime credentials.
      url.hostname = runtime.hostname; url.port = "5432"; url.username = `postgres.${project}`;
    }
    client = new pg.Client({
      connectionString: url.toString(), ssl: { rejectUnauthorized: true,
        ...(process.env.DATABASE_CA_CERT_PATH ? { ca: readFileSync(process.env.DATABASE_CA_CERT_PATH, "utf8") } : {}) },
      connectionTimeoutMillis: 10_000, application_name: "narak-trusted-three-case-intake",
    });
    await client.connect();
    const identity = (await client.query("SELECT current_user = $1 AS expected_role, current_database() = $2 AS expected_database", ["postgres", decodeURIComponent(url.pathname.slice(1))])).rows[0];
    if (!identity.expected_role || !identity.expected_database || !client.connection.stream.authorized) throw new Error("Unexpected database identity or TLS");
    console.log(JSON.stringify({ projectMatches: true, migrationRole: true, verifiedTls: true, route: flags.has("--session-pooler") ? "session-pooler" : "direct" }));
    console.log(JSON.stringify(await runIntake(client, { apply: flags.has("--apply"), manifest })));
  } catch (error) {
    // Driver errors may contain connection details or assertion text. Never log them.
    console.error(JSON.stringify({ result: "stopped", reason: error instanceof IntakeConflict ? error.message : "Configuration, connection, schema or intake check failed", sqlState: /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : undefined }));
    process.exitCode = 1;
  } finally { if (client) await client.end(); }
}
