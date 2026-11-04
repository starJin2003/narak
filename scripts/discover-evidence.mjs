import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { canonicalUrl, runDiscovery, topicSchema } from "./lib/evidence-discovery.mjs";

// Operator-run discovery. Usage:
//   npm run evidence:discover -- --query "<topic>" --before YYYY-MM-DD [--case <case-key>] [--check-registry]
// Results go to .agents/discovery, which Git ignores. This script never writes to the database.
const { values } = parseArgs({ options: {
  query: { type: "string" }, before: { type: "string" }, case: { type: "string" }, "check-registry": { type: "boolean", default: false },
}, strict: true });
const topic = topicSchema.parse({ query: values.query, before: values.before, caseKey: values.case ?? null });

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());
const key = process.env.MODEL_API_KEY?.trim();
if (!key || key.startsWith("replace_with_")) throw new Error("Set MODEL_API_KEY in .env.local to run discovery");

const outDir = join(process.cwd(), ".agents", "discovery");
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const stagedUrls = new Set();
// Review worksheets (*.review.json) sit beside staged files and hold no candidates.
for (const name of readdirSync(outDir).filter((file) => file.endsWith(".json") && !file.endsWith(".review.json"))) {
  try {
    for (const candidate of JSON.parse(readFileSync(join(outDir, name), "utf8")).candidates ?? []) {
      const url = canonicalUrl(candidate.canonicalUrl); if (url) stagedUrls.add(url);
    }
  } catch { /* A damaged staging file is skipped, never rewritten. */ }
}

// Duplicate check with the runtime reader role, inside a read-only transaction.
async function registryUrls() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const url = new URL(connectionString);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "verify-full") throw new Error("Verified TLS required");
  url.searchParams.delete("sslmode");
  const client = new pg.Client({
    connectionString: url.toString(), connectionTimeoutMillis: 10_000, application_name: "narak-discovery-dedupe",
    ssl: local ? false : { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT?.trim()
      ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, "\n") }
      : process.env.DATABASE_CA_CERT_PATH ? { ca: readFileSync(process.env.DATABASE_CA_CERT_PATH, "utf8") } : {}) },
  });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('statement_timeout', '5000', true)");
    const result = await client.query("SELECT canonical_url FROM narak.knowledge_sources ORDER BY canonical_url LIMIT 5000");
    await client.query("COMMIT");
    return new Set(result.rows.map((row) => canonicalUrl(row.canonical_url)).filter(Boolean));
  } finally { await client.end(); }
}

let registry = null;
if (values["check-registry"]) {
  try { registry = await registryUrls(); }
  catch {
    // Driver errors can include connection details, so only a fixed message is printed.
    console.error(JSON.stringify({ registry: "unavailable", note: "Continuing without the registry duplicate check" }));
  }
}

const result = await runDiscovery({ topic, key, registryUrls: registry, stagedUrls });
const slug = topic.query.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "topic";
const file = join(outDir, `${result.createdAt.slice(0, 10)}-${slug}-${Date.now().toString(36)}.json`);
writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({
  staged: result.candidates.length, excluded: result.excluded.map((item) => item.reason),
  completedSearches: result.completedSearches, citedSources: result.citedSources,
  registryChecked: result.registryChecked, reviewState: result.reviewState, file,
}));
