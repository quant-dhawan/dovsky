import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTransition,
  canTransition,
  isSafeId,
  JOB_STATES,
  parseRoutingKey,
  routingKey,
  TERMINAL_JOB_STATES,
} from "./index.js";

test("documents every job state and preserves terminal states", () => {
  for (const state of JOB_STATES) {
    if (TERMINAL_JOB_STATES.has(state)) {
      for (const destination of JOB_STATES) {
        assert.equal(canTransition(state, destination), false);
      }
    }
  }
});

test("allows only explicit lifecycle transitions", () => {
  assert.equal(canTransition("queued", "starting"), true);
  assert.equal(canTransition("running", "succeeded"), true);
  assert.equal(canTransition("cancel_requested", "cancelled"), true);
  assert.throws(() => assertTransition("failed", "running"), /Invalid job transition/);
});

test("accepts opaque safe identifiers and rejects traversal", () => {
  assert.equal(isSafeId("job_01J7Y3"), true);
  assert.equal(isSafeId("../../etc/passwd"), false);
  assert.equal(isSafeId("bad id"), false);
  assert.equal(isSafeId(""), false);
});


test("routingKey and parseRoutingKey round-trip, with - for no charter", () => {
  assert.equal(routingKey("codex", "change", null), "codex/change/-");
  assert.deepEqual(parseRoutingKey(routingKey("claude", "review", "Argus")), { provider: "claude", workflowId: "review", charter: "Argus" });
  assert.deepEqual(parseRoutingKey("codex/change/-"), { provider: "codex", workflowId: "change", charter: null });
  assert.equal(parseRoutingKey("codex/change"), null);
  assert.equal(parseRoutingKey("gemini/change/-"), null);
});
