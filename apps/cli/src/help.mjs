const details = {
  send: "--project ID --workflow ID [--to claude|codex|both] [--new-room] [--session ID] [--title TEXT] [--review[=PROVIDER]|--no-review] [--review-tier TIER --review-rounds N --rollouts N] [--eval LEVEL --eval-reason TEXT --acceptance-file FILE]",
  followup: "--to claude|codex [--from-review]; --from-review refuses an additional prompt",
  accept: "--criteria 0,1 --note TEXT [--grade good|bad] [--fingerprint HASH --evidence-hash HASH]",
  reject: "--note TEXT [--criteria 0,1] [--fingerprint HASH --evidence-hash HASH]",
  events: "peek reads without advancing; take advances delivery; --room ROOM --limit N",
  "events-ack": "--through ID advances acknowledgement only",
  evidence: "[--out FILE] reads all evidence pages", diff: "[--stat]", pr: "JOB [--draft] | status JOB",
  routing: "set KEY --tier TIER | unpin --provider P --workflow W [--charter C] | reset ... [--tier TIER]",
  execution: "show JOB | reconcile JOB --expect REVISION [--terminate]",
  control: "TASK instruction|decision|pause|resume MESSAGE", sessions: "[--project ID] | new TITLE --project ID --workflow ID",
};
const global = "Global options: --socket PATH, --key KEY, --json, --project ID, --workflow ID, --session ID, --to PROVIDER, --tier TIER, --model MODEL, --effort EFFORT, --charter NAME, --cwd PATH, --verify CMD, --protect PATH, --require-change PATH, --red-before CMD, --writable PATH.";
export function renderHelp(table) { return `Dovsky CLI\n\nUsage:\n${table.flatMap((entry) => entry.names.map((name) => { const suffix = entry.usage.includes(" ") ? entry.usage.slice(entry.usage.indexOf(" ")) : ""; return `  dovsky ${name}${suffix}\n    ${entry.summary}${details[name] ? `\n    ${details[name]}` : ""}`; })).join("\n")}\n\n${global}\n\nAcceptance records a terminal human decision. Events peek reads without advancing; take advances delivery; ack advances acknowledgement.\n`; }
