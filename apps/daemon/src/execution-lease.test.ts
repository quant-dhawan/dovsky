import assert from "node:assert/strict";
import test from "node:test";
import { inspectProcessGroup, parseProcStat, readProcessIdentity } from "./execution-lease.js";

test("process identity parsing keeps the process group and start generation", () => {
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = "S";
  fields[2] = "77";
  fields[19] = "123456";
  assert.deepEqual(parseProcStat(`123 (worker with spaces) ${fields.join(" ")}`), {
    pid: 123,
    processGroup: 77,
    startTicks: "123456",
  });
  assert.equal(parseProcStat("not a proc stat"), null);
});

test("the current process identity can be observed as a member of its recorded group", () => {
  const identity = readProcessIdentity(process.pid);
  assert.ok(identity);
  const observation = inspectProcessGroup(identity);
  assert.equal(observation.state, "alive");
  assert(observation.members.includes(process.pid));
});
