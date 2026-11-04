import { createRequire } from "node:module";
import { ReviewRefused, runCaseReview } from "./lib/case-review.mjs";
import { connectRegistryReader } from "./lib/registry-reader.mjs";
import { connectRegistryWriter } from "./lib/registry-writer.mjs";

// Verify or reject one documented case after reading it. A dry run is the default and uses
// the read-only runtime connection. Only --apply opens the privileged registry connection.
//
//   npm run case:review -- --case <case key or ID>
//   npm run case:review -- --case <key> --decision verify --reviewer "Name" --rationale "Why"
//   npm run case:review -- --case <key> --decision verify --reviewer "Name" --rationale "Why" --apply
const args = process.argv.slice(2);
const options = {};
const flags = new Set();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (["--apply", "--model-triggers-reviewed", "--session-pooler"].includes(arg)) { flags.add(arg); continue; }
  if (!["--case", "--decision", "--reviewer", "--rationale"].includes(arg) || index + 1 >= args.length) {
    console.error("Use --case <key or ID>, and to decide --decision verify|reject --reviewer \"Name\" --rationale \"Why\". Add --apply to write.");
    process.exit(2);
  }
  options[arg.slice(2)] = args[++index];
}
if (!options.case) { console.error("Name the case with --case <key or ID>."); process.exit(2); }
if (flags.has("--session-pooler") && !flags.has("--apply")) { console.error("--session-pooler applies only with --apply."); process.exit(2); }

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());
const apply = flags.has("--apply");

function print(report, decision, result) {
  const line = (text = "") => console.log(text);
  line(`Case ${report.case.key} (${report.case.id})`);
  line(`  ${report.case.title}`);
  line(`  Status ${report.case.status}. Event start ${report.case.eventStartDate ?? "none"}. Seen ${report.case.firstSeenAt} to ${report.case.lastSeenAt}.`);
  line(`  Summary: ${report.case.summary}`);
  line(); line(`Sources (${report.sources.length})`);
  for (const source of report.sources) line(`  ${source.publisher ?? "unknown publisher"}, ${source.publishedOn ?? "no date"}, ${source.storageRights}. ${source.title}\n    ${source.url}\n    Provenance: ${source.provenance}`);
  line(); line(`Notes (${report.evidence.length})`);
  for (const entry of report.evidence) line(`  [${entry.kind}] ${entry.key}${entry.correctsKey ? ` corrects ${entry.correctsKey}` : ""}, known ${entry.observedAt}\n    ${entry.text}\n    Attribution: ${entry.attribution}`);
  line(); line(`Triggers (${report.triggers.length})`);
  for (const trigger of report.triggers) line(`  [${trigger.kind}] ${trigger.key}, ${trigger.origin}${trigger.modelId ? ` by ${trigger.modelId}` : ""}, valid from ${trigger.validFrom ?? "any date"}\n    ${trigger.matchText ?? trigger.publication}\n    ${trigger.description}`);
  line(); line("History");
  for (const event of report.history) line(`  ${event.at} ${event.from ?? "new"} to ${event.to}, ${event.method} by ${event.actor}. ${event.rationale}`);
  line(); line(report.flags.length ? "Flags for the reviewer" : "No flags");
  for (const flag of report.flags) line(`  ${flag}`);
  line();
  if (decision) line(`${result === "applied" ? "Applied" : "Dry run, nothing written"}: ${decision.toStatus} by ${decision.reviewer}. Rationale: ${decision.rationale}`);
  else line("Dry run, nothing written. Add --decision, --reviewer and --rationale to plan a review, then --apply to write it.");
}

let client;
try {
  client = apply ? await connectRegistryWriter({ sessionPooler: flags.has("--session-pooler"), applicationName: "narak-case-review" }) : await connectRegistryReader();
  const outcome = await runCaseReview(client, { caseRef: options.case, ...(options.decision !== undefined ? { decision: options.decision } : {}),
    ...(options.reviewer !== undefined ? { reviewer: options.reviewer } : {}), ...(options.rationale !== undefined ? { rationale: options.rationale } : {}) },
  { apply, modelTriggersReviewed: flags.has("--model-triggers-reviewed") });
  print(outcome.report, outcome.decision, outcome.result);
} catch (error) {
  // Driver errors can carry connection details. Only refusals are printed in full.
  console.error(error instanceof ReviewRefused ? `Stopped. ${error.message}.` : `Stopped. The connection, the registry checks or the database refused the change${/^[0-9A-Z]{5}$/.test(error?.code ?? "") ? ` (SQL state ${error.code})` : ""}. Nothing was written.`);
  process.exitCode = 1;
} finally { if (client) await client.end(); }
