import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";

// A new loopback-only cluster, never DATABASE_URL or the hosted project.
const directory = mkdtempSync("/private/tmp/narak-knowledge-test-");
const data = directory + "/data";
const socket = directory + "/socket";
mkdirSync(socket, { mode: 0o700 });
const probe = createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
const testUrl = `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:${port}/postgres`;
const env = { ...process.env, DATABASE_URL: testUrl, DATABASE_MIGRATION_URL: "", NARAK_TEST_DATABASE_URL: testUrl };
let started = false;
try {
  execFileSync("initdb", ["-D", data, "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"], { stdio: "pipe" });
  execFileSync("pg_ctl", ["-D", data, "-l", directory + "/postgres.log", "-o", `-F -p ${port} -k ${socket} -c listen_addresses=127.0.0.1`, "-w", "start"], { stdio: "pipe" });
  started = true;
  console.log("Running registry tests against a disposable local PostgreSQL cluster.");
  const testFile = process.argv.includes("--intake") ? "tests/three-case-intake.test.mjs"
    : process.argv.includes("--discovery") ? "tests/discovery-review.test.mjs" : "tests/knowledge-db.integration.test.ts";
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", testFile], { env, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  if (started) execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "pipe" });
  rmSync(directory, { recursive: true, force: true });
}
