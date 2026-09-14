import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// A disposable local process, never a real provider or socket client.
const directory = process.argv[2]!;
const jobId = process.env.DOVSKY_JOB_ID!;
readFileSync(0, "utf8");
const record = (event: string): void => appendFileSync(resolve(directory, "observations.jsonl"), `${JSON.stringify({ event, jobId, socket: process.env.DOVSKY_SOCKET, argv: process.argv.slice(3) })}\n`);
record("started");
process.stdout.write(`${JSON.stringify({ type: "command_execution", command: "fixture waiting for release" })}\n`);
const deadline = Date.now() + 10_000;
while (!existsSync(resolve(directory, `${jobId}.release`))) {
  if (Date.now() > deadline) throw new Error("Fixture was not released by its test");
  await new Promise((done) => setTimeout(done, 10));
}
// Delay the thread announcement until after the followup has been submitted.
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "late-fixture-thread" })}\n`);
const result = `DOVSKY_RESULT: ${JSON.stringify({ outcome: "completed", phase: "Fixture completed", blocker: null, nextAction: null, acknowledgedControls: [] })}`;
record("finished");
process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } })}\n`);
