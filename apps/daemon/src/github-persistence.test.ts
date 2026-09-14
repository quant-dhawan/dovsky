import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DovskyDatabase, type PullRequestReservationInput } from "./database.js";

function fixture(t:import("node:test").TestContext) {
  const root=mkdtempSync(resolve(tmpdir(),"dovsky-pr-db-")); const db=new DovskyDatabase(resolve(root,"state.db"));
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  db.createRoom("room-one","Room","project","change");
  for(const id of ["job-one","job-two"])db.createJob({id,roomId:"room-one",provider:"codex",projectId:"project",workflowId:"change",prompt:"fixture"},`turn-${id}`);
  const input:PullRequestReservationInput={jobId:"job-one",roomId:"room-one",repository:"owner/repo",remote:"origin",baseBranch:"main",branch:"dovsky/room-job",
    startCommit:"1".repeat(40),fingerprint:"2".repeat(64),contentHash:"3".repeat(64),evidenceHash:"4".repeat(64),intent:{version:1,draft:false}};
  return {db,input};
}

test("pull request reservation, progress, result and replay are durable and event-once",t=>{
  const {db,input}=fixture(t); const first=db.reservePullRequestOperation("operator","pr:job-one","github.pr.create","request",input);
  assert.equal(first.state,"reserved"); if(first.state!=="reserved")return;
  assert.equal(first.pullRequest.state,"reserved");
  assert.equal(db.reservePullRequestOperation("operator","pr:job-one","github.pr.create","request",input).state,"reserved");
  db.recordPullRequestProgress(input.jobId,"committed","5".repeat(40)); db.recordPullRequestProgress(input.jobId,"pushed","5".repeat(40));
  const opened=()=>db.recordPullRequestResult(input.jobId,{state:"open",headSha:"5".repeat(40),number:7,url:"https://github.com/owner/repo/pull/7",bodyHash:"6".repeat(64)});
  opened(); opened();
  assert.equal(db.db.prepare("SELECT count(*) AS count FROM events WHERE job_id=? AND type='pull_request.opened'").get(input.jobId)?.count,1);
  const merged=()=>db.recordPullRequestResult(input.jobId,{state:"merged",headSha:"5".repeat(40),number:7,url:"https://github.com/owner/repo/pull/7",mergedAt:"2026-09-13T00:00:00.000Z",mergeCommit:"7".repeat(40)});
  const view=merged(); merged(); assert.equal(view.state,"merged");
  assert.equal(db.db.prepare("SELECT count(*) AS count FROM events WHERE job_id=? AND type='pull_request.merged'").get(input.jobId)?.count,1);
  assert.throws(()=>db.recordPullRequestResult(input.jobId,{state:"open",headSha:"5".repeat(40),number:7,url:"https://github.com/owner/repo/pull/7"}),/cannot move from merged to open/);
  db.completeOperation(first.reservation,db.getPullRequest(input.jobId)!);
  const replay=db.reservePullRequestOperation("operator","pr:job-one","github.pr.create","request",input);
  assert.equal(replay.state,"completed"); if(replay.state==="completed")assert.equal(replay.response.url,"https://github.com/owner/repo/pull/7");
});

test("pull request identity and branch ownership conflicts fail closed",t=>{
  const {db,input}=fixture(t); db.reservePullRequestOperation("operator","pr:job-one","github.pr.create","request",input);
  assert.throws(()=>db.reservePullRequestOperation("operator","pr:job-one","github.pr.create","changed",input),{code:"IDEMPOTENCY_CONFLICT"});
  assert.throws(()=>db.reservePullRequestOperation("operator","pr:job-one","github.pr.create","request",{...input,evidenceHash:"9".repeat(64)}),{code:"IDEMPOTENCY_CONFLICT"});
  assert.throws(()=>db.reservePullRequestOperation("operator","pr:job-two","github.pr.create","second",{...input,jobId:"job-two"}),{code:"IDEMPOTENCY_CONFLICT"});
  db.recordPullRequestProgress(input.jobId,"committed","5".repeat(40));
  assert.throws(()=>db.recordPullRequestProgress(input.jobId,"committed","6".repeat(40)),/head changed/);
  assert.equal(db.recordPullRequestProgress(input.jobId,"committed","6".repeat(40),true).headSha,"6".repeat(40));
  assert.equal(db.markPullRequestReconcileRequired(input.jobId).state,"reconcile_required");
  assert.equal(db.recordPullRequestProgress(input.jobId,"committed","7".repeat(40),true).headSha,"7".repeat(40));
  assert.throws(()=>db.recordPullRequestResult(input.jobId,{state:"open",headSha:"8".repeat(40),number:7,url:"https://github.com/owner/repo/pull/7"}),/head changed/);
  db.recordPullRequestProgress(input.jobId,"pushed","7".repeat(40));
  assert.throws(()=>db.recordPullRequestResult(input.jobId,{state:"open",headSha:"7".repeat(40),number:7,url:"https://example.invalid/7"}),/fields are invalid/);
});
