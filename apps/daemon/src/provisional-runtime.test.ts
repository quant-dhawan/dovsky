import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { JobSummary, ProvisionalResultV1 } from "@dovsky/protocol";
import type { DaemonConfig } from "./config.js";
import { FixtureDaemon, removeFixtureTree } from "./__fixtures__/runtime-isolation.js";

const providerFixture = new URL("./__fixtures__/provider.js", import.meta.url).pathname;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function harness(): { root: string; project: string; daemon: FixtureDaemon } {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-provisional-runtime-"));
  const project = resolve(root, "project");
  spawnSync("mkdir", ["-p", project]);
  git(project, "init", "-q");
  git(project, "config", "user.email", "test@example.invalid");
  git(project, "config", "user.name", "Dovsky Test");
  writeFileSync(resolve(project, "tracked.txt"), "baseline\n");
  git(project, "add", "tracked.txt");
  git(project, "commit", "-qm", "baseline");
  const config: DaemonConfig = {
    socketPath: resolve(root, "run", "dovsky.sock"),
    databasePath: resolve(root, "state", "dovsky.db"),
    artifactDirectory: resolve(root, "artifacts"),
    maxActive: 1,
    projects: [{ id: "test", name: "Test", path: project, workflows: [{
      id: "default", name: "Default", readOnly: false,
      qualityCommands: [[process.execPath, "-e", "setTimeout(()=>process.exit(1),750)"]],
      providers: { codex: { argv: [process.execPath, providerFixture, "success"] } },
    }] }],
  };
  return { root, project, daemon: new FixtureDaemon(config) };
}

async function until<T>(read: () => Promise<T | null>, timeout = 5_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("Timed out waiting for provisional runtime condition");
}

function treeBytes(path: string): number {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    return stat.isDirectory() ? readdirSync(path).reduce((total, name) => total + treeBytes(resolve(path, name)), 0) : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

test("provisional result is immutable and readable while gates remain authoritative", async () => {
  const value = harness();
  let scratchHighWaterBytes = 0;
  const sampler = process.env.DOVSKY_SETUP_SAMPLE === "1" ? setInterval(() => {
    scratchHighWaterBytes = Math.max(scratchHighWaterBytes, treeBytes(value.root));
  }, 10) : null;
  try {
    value.daemon.start();
    const created = await value.daemon.call("rooms.create", {
      title: "provisional", projectId: "test", workflowId: "default",
      prompt: "report success", recipients: ["codex"],
    }, randomUUID()) as { roomId: string; jobIds: string[] };
    const jobId = created.jobIds[0]!;
    const early = await until(async () => {
      const result = await value.daemon.call("jobs.result", { jobId }) as {
        state: string; result: string | null; provisional?: ProvisionalResultV1;
        provisionalArtifact?: { version: number; result: { text: string }; changes: { entries: unknown[] } };
      };
      if (["succeeded", "failed", "cancelled"].includes(result.state)) throw new Error(`Job settled before provisional feedback: ${JSON.stringify(result)}`);
      return result.provisional ? result : null;
    });
    assert.equal(early.state, "running");
    assert.equal(early.result, null);
    assert.deepEqual(early.provisional?.checksCompleted, ["provider_protocol", "scope_absent", "application_complete"]);
    assert.equal(early.provisionalArtifact?.version, 1);
    assert.match(early.provisionalArtifact?.result.text ?? "", /RESULT:/);

    const acceptance = await value.daemon.call("jobs.acceptance.check", { jobId }) as { accepted: boolean };
    assert.equal(acceptance.accepted, false);

    const eventPage = await value.daemon.call("events.list", { afterId: 0, limit: 500 }) as
      Array<{ type: string; jobId: string | null; data: ProvisionalResultV1 }>;
    const provisionalEvents = eventPage.filter((event) => event.type === "job.provisional_result.v1" && event.jobId === jobId);
    assert.equal(provisionalEvents.length, 1);
    assert.deepEqual(provisionalEvents[0]!.data, early.provisional);
    const setupEvents = eventPage.filter((event) => event.type === "execution.setup.v1" && event.jobId === jobId);
    assert.ok(setupEvents.length >= 1);
    const setup = setupEvents[0]!.data as unknown as { commandNumber: number; trace: { version: number; kind: string; phases: unknown[]; totalMs: number } };
    assert.equal(setup.commandNumber, 1);
    assert.equal(setup.trace.version, 1);
    assert.equal(setup.trace.kind, "provider");
    assert.ok(setup.trace.phases.length >= 3);
    assert.ok(setup.trace.totalMs >= 0);

    const readArtifact = async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const chunk = await value.daemon.call("artifacts.read", {
          roomId: created.roomId,
          artifactId: early.provisional!.artifactId,
          offset,
        }) as {
          data: string; nextOffset: number | null;
        };
        chunks.push(Buffer.from(chunk.data, "base64"));
        offset = chunk.nextOffset;
      }
      return Buffer.concat(chunks);
    };
    const before = await readArtifact();
    assert.equal(before.length, early.provisional!.size);
    assert.equal(createHash("sha256").update(before).digest("hex"), early.provisional!.sha256);
    writeFileSync(resolve(value.project, "unrelated-after-provisional.txt"), "later\n");
    assert.deepEqual(await readArtifact(), before);

    const failed = await until(async () => {
      const page = await value.daemon.call("jobs.list", { limit: 100 }) as { items: JobSummary[] };
      return page.items.find((job) => job.id === jobId && job.state === "failed") ?? null;
    });
    assert.equal(failed.state, "failed");
    const finalResult = await value.daemon.call("jobs.result", { jobId }) as {
      state: string; result: string | null; failure: unknown; provisional?: ProvisionalResultV1;
    };
    assert.equal(finalResult.state, "failed");
    assert.ok(finalResult.failure);
    assert.deepEqual(finalResult.provisional, early.provisional);
    const finalEvents = await value.daemon.call("events.list", { afterId: 0, limit: 500 }) as
      Array<{ type: string; jobId: string | null; data: { trace?: { kind?: string } } }>;
    assert.equal(finalEvents.filter((event) => event.type === "job.provisional_result.v1" && event.jobId === jobId).length, 1);
    assert.equal(finalEvents.some((event) => event.type === "execution.setup.v1" && event.jobId === jobId && event.data.trace?.kind === "gate"), true);
    assert.equal(finalEvents.some((event) => event.type === "review.requested" && event.jobId === jobId), false);
    if (sampler) {
      clearInterval(sampler);
      scratchHighWaterBytes = Math.max(scratchHighWaterBytes, treeBytes(value.root));
      const traces = finalEvents.filter((event) => event.type === "execution.setup.v1" && event.jobId === jobId).map((event) => event.data.trace);
      process.stdout.write(`DOVSKY_SETUP_SAMPLE ${JSON.stringify({ traces, scratchHighWaterBytes, maxRssKiB: process.resourceUsage().maxRSS })}\n`);
    }
  } finally {
    if (sampler) clearInterval(sampler);
    await value.daemon.stop();
    value.daemon.close();
    removeFixtureTree(value.root);
  }
});
