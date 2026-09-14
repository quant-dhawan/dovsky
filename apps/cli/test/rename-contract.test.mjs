import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const manifest = (path) => JSON.parse(readFileSync(path, "utf8"));

test("Dovsky package graph and executable entrypoints are canonical", () => {
  assert.equal(manifest("package.json").name, "dovsky");
  assert.equal(manifest("apps/cli/package.json").name, "@dovsky/cli");
  assert.equal(manifest("apps/daemon/package.json").name, "@dovsky/daemon");
  assert.equal(manifest("packages/protocol/package.json").name, "@dovsky/protocol");
  assert.equal(manifest("packages/legacy-import/package.json").name, "@dovsky/legacy-import");
  assert.deepEqual(manifest("apps/daemon/package.json").bin, { dovskyd: "./dist/main.js" });
  assert.equal(existsSync("bin/dovsky"), true);
  assert.equal(existsSync("bin/abus"), false);
  assert.equal(existsSync("deploy/systemd/dovsky-daemon.service"), true);
  assert.equal(existsSync("deploy/systemd/agentbus-daemon.service"), false);
  const lockfile = manifest("package-lock.json");
  for (const name of ["@dovsky/cli", "@dovsky/daemon", "@dovsky/legacy-import", "@dovsky/protocol"]) assert.ok(lockfile.packages[`node_modules/${name}`]?.link, name);
});

test("Dovsky defaults do not reuse predecessor runtime paths", async () => {
  const { socketFor } = await import("../src/rpc.mjs");
  const previous = process.env.DOVSKY_HOME;
  try {
    process.env.DOVSKY_HOME = "/fixture/dovsky-home";
    assert.equal(socketFor(new Map()), "/fixture/dovsky-home/run/dovsky.sock");
  } finally {
    if (previous === undefined) delete process.env.DOVSKY_HOME;
    else process.env.DOVSKY_HOME = previous;
  }
  assert.match(readFileSync("packages/legacy-import/src/cli.ts", "utf8"), /path\.join\(os\.homedir\(\), "\.agentbus", "jobs"\)/);
});
