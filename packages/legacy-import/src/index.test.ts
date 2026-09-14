import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyImportSummary, scanLegacySpool } from "./index.js";

test("initializes an empty dry-run summary", () => {
  assert.deepEqual(emptyImportSummary(), {
    scanned: 0,
    eligible: 0,
    skipped: 0,
    warnings: [],
  });
});

test("normalizes schema zero jobs without changing the source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dovsky-legacy-"));
  const id = "job-legacy-1";
  const directory = path.join(root, id);
  await mkdir(directory);
  const metadata = JSON.stringify({
    id,
    to: "claude",
    cwd: "/tmp/project",
    created: "2026-09-01T10:00:00Z",
    model: "sonnet",
  });
  await writeFile(path.join(directory, "job.json"), metadata);
  await writeFile(path.join(directory, "status"), "done\n");
  await writeFile(path.join(directory, "prompt.txt"), "Inspect this\n");
  await writeFile(path.join(directory, "result.md"), "Looks good\n");

  const scan = await scanLegacySpool(root);
  assert.equal(scan.scanned, 1);
  assert.equal(scan.eligible, 1);
  assert.equal(scan.jobs[0]?.schemaVersion, 0);
  assert.equal(scan.jobs[0]?.state, "succeeded");
  assert.equal(scan.jobs[0]?.provider, "claude");
  assert.equal(await readFile(path.join(directory, "job.json"), "utf8"), metadata);
});

test("marks orphaned active jobs failed and preserves uncertainty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dovsky-legacy-"));
  const directory = path.join(root, "job-orphan");
  await mkdir(directory);
  await writeFile(path.join(directory, "job.json"), JSON.stringify({ to: "codex" }));
  await writeFile(path.join(directory, "status"), "running\n");

  const scan = await scanLegacySpool(root);
  const job = scan.jobs[0];
  assert.equal(job?.state, "failed");
  assert.equal(job?.failure?.code, "daemon_restart");
  assert.equal(job?.createdAt, null);
  assert.ok(scan.warnings.some((warning) => warning.includes("imported as failed")));
});
