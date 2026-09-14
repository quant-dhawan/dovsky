import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { loadRuntimeSourceMetadata } from "./build-provenance.js";
import { DovskyDaemon } from "./daemon.js";
import type { DaemonConfig } from "./config.js";
import type { IsolationAvailability, JobIsolation } from "./isolation.js";

function git(cwd:string,...args:string[]):void {
  const result=spawnSync("git",["-C",cwd,...args],{encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
}

function fixture(t:TestContext,
  available:IsolationAvailability|Error={available:true,backend:"bwrap",reason:null,bwrapVersion:"bwrap 1"},
  githubStatus?:number) {
  const root=mkdtempSync(resolve(tmpdir(),"dovsky-doctor-"));
  const project=resolve(root,"project");
  const state=resolve(root,"state");
  mkdirSync(project); mkdirSync(state);
  const entry=resolve(project,"main.js"); writeFileSync(entry,"export {};\n");
  git(project,"init","-q"); git(project,"config","user.email","doctor@example.invalid"); git(project,"config","user.name","Doctor Test");
  git(project,"add","main.js"); git(project,"commit","-qm","fixture");
  const config:DaemonConfig={socketPath:resolve(root,"run","bus.sock"),databasePath:resolve(state,"bus.db"),artifactDirectory:resolve(root,"artifacts"),maxActive:1,
    projects:[{id:"fixture",name:"Fixture",path:project,
      ...(githubStatus===undefined?{}:{github:{enabled:true,remote:"origin",repository:"owner/repo",baseBranch:"main",commitName:"Dovsky",commitEmail:"dovsky@example.invalid",draft:false}}),
      workflows:[{id:"check",name:"Check",readOnly:true,qualityCommands:[],providers:{}}]}]};
  const isolation:JobIsolation={available:async()=>{if(available instanceof Error)throw available;return available;},prepare:async()=>{throw new Error("unused");}};
  const githubRunner=githubStatus===undefined?undefined:async()=>({status:githubStatus,stdout:"",stderr:githubStatus===0?"":"not logged in"});
  const daemon=new DovskyDaemon(config,{isolation,...(githubRunner?{githubRunner}:{})},{entry,builtAt:"2026-09-13T00:00:00.000Z",error:null});
  t.after(async()=>{daemon.close();chmodSync(state,0o700);try{chmodSync(config.databasePath,0o600);}catch{}rmSync(root,{recursive:true,force:true});});
  return {root,project,state,config,daemon};
}

test("build provenance accepts only a real entry and canonical timestamp",t=>{
  const root=mkdtempSync(resolve(tmpdir(),"dovsky-provenance-")); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const entry=resolve(root,"main.js"),stamp=resolve(root,"stamp.json"); writeFileSync(entry,"export {};\n");
  writeFileSync(stamp,'{"builtAt":"not-a-time"}\n'); assert.equal(loadRuntimeSourceMetadata(entry,stamp).builtAt,null);
  writeFileSync(stamp,'{"builtAt":"2026-09-13T00:00:00.000Z"}\n');
  assert.deepEqual(loadRuntimeSourceMetadata(entry,stamp),{entry,builtAt:"2026-09-13T00:00:00.000Z",error:null});
});

test("doctor reports truthful source, schema, database, sandbox, scopes and releases",async t=>{
  const f=fixture(t); const report=await f.daemon.call("doctor",{}) as any;
  assert.equal(report.source.root,f.project); assert.match(report.source.head,/^[0-9a-f]{40}$/); assert.equal(report.source.dirty,false);
  assert.deepEqual(report.schema,{version:18,expected:18,ok:true}); assert.equal(report.database.writable,true);
  assert.deepEqual(report.sandbox,{backend:"bwrap",enabled:true,available:true,bwrapVersion:"bwrap 1",scopes:{prepared:0,running:0,reconcile_required:0,exited:0},reason:null});
  assert.deepEqual(report.releases,{adapters:[],candidates:0,operations:{prepared:0,executing:0,verified:0,not_applied:0,reconcile_required:0,cancelled:0}});
  for(const name of ["source","schema","database","sandbox","releases"])assert.equal(report.checks.find((item:any)=>item.name===name)?.ok,true,name);
  assert.equal(report.ok,true);
});

test("doctor fails closed for dirty source, unavailable sandbox and a read-only database",async t=>{
  const f=fixture(t,{available:false,backend:"bwrap",reason:"fixture unavailable",bwrapVersion:null});
  writeFileSync(resolve(f.project,"dirty.txt"),"dirty\n"); chmodSync(f.config.databasePath,0o400); chmodSync(f.state,0o500);
  const report=await f.daemon.call("doctor",{}) as any;
  try {assert.equal(report.source.dirty,true);assert.equal(report.database.writable,false);assert.equal(report.sandbox.available,false);assert.equal(report.ok,false);}
  finally {chmodSync(f.state,0o700);chmodSync(f.config.databasePath,0o600);}
});

test("doctor reports GitHub authentication for every enabled project",async t=>{
  const authenticated=fixture(t,undefined,0); const good=await authenticated.daemon.call("doctor",{}) as any;
  assert.deepEqual(good.github,[{projectId:"fixture",repository:"owner/repo",authenticated:true,detail:"GitHub CLI is authenticated"}]);
  assert.equal(good.checks.find((item:any)=>item.name==="github:fixture")?.ok,true);

  const unauthenticated=fixture(t,undefined,1); const bad=await unauthenticated.daemon.call("doctor",{}) as any;
  assert.equal(bad.github[0].authenticated,false); assert.equal(bad.checks.find((item:any)=>item.name==="github:fixture")?.ok,false);
  assert.equal(bad.ok,false);
});
