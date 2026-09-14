import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfigPath, loadConfig,resolveSandbox, runtimePathDefaults } from "./config.js";

test("daemon config default remains separate from runtime state", () => {
  assert.equal(defaultConfigPath(), join(homedir(), ".config", "dovsky", "config.json"));
});

test("real config loader ignores retired UI keys rather than resolving or enabling them", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dovsky-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  const retired = { bridge: { allowRemoteChange: true }, memory: { allowRemoteEdit: true },
    skillsDirectory: 0, frontendReceiptDirectory: false, frontendLiveDirectory: null, instructionFile: {} };
  writeFileSync(path, JSON.stringify({ ...retired,
    projects: [{ id: "fixture", name: "Fixture", path: root, workflows: [] }] }));
  const config = loadConfig(path, { home: root });
  for (const key of Object.keys(retired)) assert.equal(Object.hasOwn(config, key), false, key);
  assert.equal(config.projects[0]?.path, root);
  assert.equal(config.socketPath, join(root, "run", "dovsky.sock"));
});

test("entrypoint runtime defaults use DOVSKY_HOME and DOVSKY_SOCKET without changing library defaults", t => {
  const root = mkdtempSync(join(tmpdir(), "dovsky-config-defaults-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project"), configDirectory = join(root, ".config", "dovsky"), configPath = join(configDirectory, "config.json"), home = join(root, ".dovsky");
  mkdirSync(project); mkdirSync(configDirectory, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ projects: [{ id: "fixture", name: "Fixture", path: project, workflows: [] }] }));
  const libraryDefaults = loadConfig(configPath);
  assert.equal(libraryDefaults.socketPath, join(configDirectory, "run", "dovsky.sock"));
  const defaults = loadConfig(configPath, runtimePathDefaults({ DOVSKY_HOME: home }));
  assert.equal(defaults.socketPath, join(home, "run", "dovsky.sock"));
  assert.equal(defaults.databasePath, join(home, "state", "dovsky.db"));
  assert.equal(defaults.artifactDirectory, join(home, "artifacts"));
  const socketPath = join(root, "override.sock");
  assert.equal(loadConfig(configPath, runtimePathDefaults({ DOVSKY_HOME: home, DOVSKY_SOCKET: socketPath })).socketPath, socketPath);
  writeFileSync(configPath, JSON.stringify({ socketPath: "configured.sock", databasePath: "configured.db", artifactDirectory: "configured-artifacts", projects: [{ id: "fixture", name: "Fixture", path: project, workflows: [] }] }));
  const explicit = loadConfig(configPath, runtimePathDefaults({ DOVSKY_HOME: home, DOVSKY_SOCKET: socketPath }));
  assert.equal(explicit.socketPath, join(configDirectory, "configured.sock"));
  assert.equal(explicit.databasePath, join(configDirectory, "configured.db"));
  assert.equal(explicit.artifactDirectory, join(configDirectory, "configured-artifacts"));
});

test('real loader validates sandbox overrides, mount overlap, capacity bounds and example config',t=>{
  const root=mkdtempSync(join(tmpdir(),'dovsky-config-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const project=join(root,'project');mkdirSync(project);mkdirSync(join(root,'private'));symlinkSync(join(root,'private'),join(root,'alias'));
  const path=join(root,'config.json');
  const base={socketPath:'private/run/bus.sock',databasePath:'private/state/db',artifactDirectory:'private/artifacts',projects:[{id:'p',name:'Fixture',path:'project',workflows:[{id:'w',name:'Fixture',readOnly:false,qualityCommands:[],providers:{codex:{argv:[process.execPath]}}}]}]};
  const load=(extra:object={})=>{writeFileSync(path,JSON.stringify({...base,...extra}));return loadConfig(path);};
  const defaults=load();assert.equal(defaults.maxQueuedJobs,200);assert.equal(defaults.maxActive,3);assert.equal(resolveSandbox(defaults).enabled,true);
  for(const maxActive of [0,17])assert.throws(()=>load({maxActive}),/maxActive/);
  assert.equal(load({maxActive:16}).maxActive,16);
  for(const sandbox of [{enabled:false},{backend:'worktree'},{memoryMax:'infinity'},{cpuQuota:'400'},{tasksMax:4097},{runtimePaths:[join(root,'alias')]},{runtimePaths:[project]}])assert.throws(()=>load({sandbox}));
  for(const maxQueuedJobs of [0,10001])assert.throws(()=>load({maxQueuedJobs}),/maxQueuedJobs/);
  const readOnly=structuredClone(base.projects);readOnly[0]!.workflows[0]!.readOnly=true;readOnly[0]!.workflows[0]!.providers.codex.argv=[process.execPath,'--sandbox','workspace-write'];
  assert.throws(()=>load({projects:readOnly}),/Read-only/);
  const example=JSON.parse(readFileSync(new URL('../../../deploy/config.example.json',import.meta.url),'utf8')) as {projects:Array<{path:string;workflows:Array<Record<string,unknown>>}>};
  // Resolve the example against an owned project; its live-specific runner files are not executed.
  for(const value of example.projects){value.path=project;for(const workflow of value.workflows){delete workflow.evaluation;delete workflow.fontAssets;}}
  assert.ok(load(example).projects.length>0);
});
