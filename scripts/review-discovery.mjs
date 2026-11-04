import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  IntakeConflict, ReviewRefused, buildDiscoveryManifest, createWorksheet, recordDecision, reviewStatus, runDiscoveryIntake, setCase,
} from "./lib/discovery-review.mjs";
import { connectRegistryWriter } from "./lib/registry-writer.mjs";

// Operator review of staged discovery candidates. Usage:
//   npm run evidence:review -- status --file <staged.json>
//   npm run evidence:review -- decide --file <staged.json> --candidate D1 --accept --reviewer "<name>" --rationale "<why>"
//       --page-read --attribution-checked --published-on YYYY-MM-DD --keep 1,3 [--publisher "<name>"] [--title "<title>"]
//       [--text 3="<your paraphrase>"] [--attribution 2="<who, as reported by publisher>"] [--corrects 4=D1#2]
//   npm run evidence:review -- decide --file <staged.json> --candidate D2 --reject --reviewer "<name>" --rationale "<why>"
//   npm run evidence:review -- case --file <staged.json> --case-key <key> --title "<title>" --summary "<summary>" --author "<name>"
//       --trigger "copy|<trigger-key>|<match text>|D1#1|<description>" [--event-date YYYY-MM-DD]
//   npm run evidence:review -- intake --file <staged.json> [--check-hosted | --apply] [--session-pooler]
// The worksheet sits next to the staged file in .agents/discovery, which Git ignores.
// Without --check-hosted or --apply, intake validates offline and touches no database.
// --apply writes to the registry with the privileged role. Only the user runs it.
const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, strict: true, options: {
  file: { type: "string" }, candidate: { type: "string" }, accept: { type: "boolean" }, reject: { type: "boolean" },
  reviewer: { type: "string" }, rationale: { type: "string" }, "page-read": { type: "boolean" }, "attribution-checked": { type: "boolean" },
  "published-on": { type: "string" }, publisher: { type: "string" }, title: { type: "string" }, keep: { type: "string" },
  text: { type: "string", multiple: true }, attribution: { type: "string", multiple: true }, corrects: { type: "string", multiple: true },
  "case-key": { type: "string" }, summary: { type: "string" }, author: { type: "string" }, "event-date": { type: "string" },
  trigger: { type: "string", multiple: true }, "check-hosted": { type: "boolean" }, apply: { type: "boolean" }, "session-pooler": { type: "boolean" },
} });

function fail(message) { console.error(JSON.stringify({ result: "stopped", reason: message })); process.exit(1); }
if (!["status", "decide", "case", "intake"].includes(command)) fail("Use status, decide, case or intake");
if (!values.file) fail("Name the staged discovery file with --file");

const stagingDir = realpathSync(join(process.cwd(), ".agents", "discovery"));
const stagedPath = realpathSync(values.file);
if (relative(stagingDir, dirname(stagedPath)) !== "" || !stagedPath.endsWith(".json") || stagedPath.endsWith(".review.json")) {
  fail("The staged file must be a discovery file directly inside .agents/discovery");
}
const stagedText = readFileSync(stagedPath, "utf8");
const sheetPath = stagedPath.replace(/\.json$/, ".review.json");
const save = (sheet) => writeFileSync(sheetPath, `${JSON.stringify(sheet, null, 2)}\n`, { mode: 0o600 });
const pairs = (list = []) => Object.fromEntries(list.map((item) => {
  const at = item.indexOf("=");
  if (at < 1) fail(`Write ${item} as <assertion number>=<value>`);
  return [Number(item.slice(0, at)), item.slice(at + 1)];
}));

try {
  let sheet = existsSync(sheetPath) ? JSON.parse(readFileSync(sheetPath, "utf8")) : createWorksheet(basename(stagedPath), stagedText);
  if (!existsSync(sheetPath)) save(sheet);
  if (command === "decide") {
    if (Boolean(values.accept) === Boolean(values.reject)) fail("Choose exactly one of --accept or --reject");
    const texts = pairs(values.text), attributions = pairs(values.attribution), corrects = pairs(values.corrects);
    const rewrites = {};
    for (const at of new Set([...Object.keys(texts), ...Object.keys(attributions), ...Object.keys(corrects)].map(Number))) {
      rewrites[at] = { ...(texts[at] ? { text: texts[at] } : {}), ...(attributions[at] ? { attribution: attributions[at] } : {}), ...(corrects[at] ? { corrects: corrects[at] } : {}) };
    }
    sheet = recordDecision(sheet, stagedText, {
      candidateId: values.candidate, decision: values.accept ? "accepted" : "rejected", reviewer: values.reviewer, rationale: values.rationale,
      pageRead: values["page-read"] === true, attributionChecked: values["attribution-checked"] === true, publishedOn: values["published-on"],
      publisher: values.publisher, title: values.title, keep: (values.keep ?? "").split(",").filter(Boolean).map(Number), rewrites,
    });
    save(sheet);
  }
  if (command === "case") {
    const triggers = (values.trigger ?? []).map((item) => {
      const [kind, key, matchText, evidence, description] = item.split("|");
      return { kind, key, matchText, evidence, description };
    });
    sheet = setCase(sheet, stagedText, {
      caseKey: values["case-key"], title: values.title, contextSummary: values.summary, eventStartDate: values["event-date"] ?? null,
      authoredBy: values.author, triggers,
    });
    save(sheet);
  }
  if (command === "intake") {
    if (values["check-hosted"] && values.apply) fail("Use --check-hosted or --apply, not both");
    const rows = buildDiscoveryManifest(sheet, stagedText);
    console.log(JSON.stringify({ manifest: "valid", caseKey: rows.knowledge_cases[0].case_key, status: "emerging",
      intended: { sources: rows.knowledge_sources.length, evidence: rows.case_evidence.length, triggers: rows.case_triggers.length } }));
    if (values["check-hosted"] || values.apply) {
      const require = createRequire(import.meta.url);
      require("@next/env").loadEnvConfig(process.cwd());
      let client;
      try {
        client = await connectRegistryWriter({ sessionPooler: values["session-pooler"] === true, applicationName: "narak-discovery-intake" });
        console.log(JSON.stringify(await runDiscoveryIntake(client, rows, { apply: values.apply === true })));
      } finally { if (client) await client.end(); }
    }
  } else {
    console.log(JSON.stringify({ worksheet: relative(process.cwd(), sheetPath), case: sheet.case?.caseKey ?? null, candidates: reviewStatus(sheet, stagedText) }, null, 2));
  }
} catch (error) {
  // Driver errors can carry connection details, so only fixed or review messages print.
  const known = error instanceof ReviewRefused || error instanceof IntakeConflict;
  console.error(JSON.stringify({ result: "stopped", reason: known ? error.message : "The worksheet, configuration, connection or intake check failed",
    sqlState: /^[0-9A-Z]{5}$/.test(error?.code ?? "") ? error.code : undefined }));
  process.exitCode = 1;
}
