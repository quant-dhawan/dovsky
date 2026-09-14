import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, {type TestContext} from 'node:test';
import { DovskyDaemon } from './daemon.js';
import type { RpcOrigin } from './rpc-origin.js';

const caller: RpcOrigin={kind:'job',jobId:'caller'};
function fixture(t: TestContext): DovskyDaemon {
  const root=mkdtempSync(join(tmpdir(),'dovsky-origin-'));
  const daemon=new DovskyDaemon({socketPath:join(root,'operator.sock'),databasePath:join(root,'state.db'),artifactDirectory:join(root,'artifacts'),maxActive:1,
    projects:[{id:'p',name:'Fixture',path:root,workflows:[{id:'w',name:'Fixture',readOnly:false,qualityCommands:[],providers:{codex:{argv:[process.execPath]}}}]}]});
  t.after(async()=>{await daemon.stop();daemon.close();rmSync(root,{recursive:true,force:true});});
  const db=daemon.database;
  db.createRoom('room','Fixture','p','w');
  for(const id of ['caller','unrelated','ancestor','descendant']) db.createJob({id,roomId:'room',projectId:'p',workflowId:'w',provider:'codex',prompt:'fixture'},`turn-${id}`);
  db.db.exec("UPDATE jobs SET state='succeeded'; UPDATE jobs SET state='running',parent_job_id='ancestor' WHERE id='caller'; UPDATE jobs SET retry_of_job_id='caller' WHERE id='descendant'");
  return daemon;
}

test('job authority is checked before replay, reserves no denied calls, and cannot access operator methods',async(t)=>{
  const daemon=fixture(t),db=daemon.database;
  await daemon.call('jobs.grade',{jobId:'unrelated',grade:'good'},'operator-key');
  const before=db.db.prepare('SELECT count(*) AS n FROM operations').get()!.n;
  for(const method of ['jobs.acceptance.record','jobs.acceptance.check','releases.operations.execute','releases.operations.reconcile','routing.pin','tasks.controls.create','jobs.get','health','github.pr.create']){
    await assert.rejects(daemon.call(method,{jobId:'unrelated',grade:'good'},'operator-key',caller),{code:'FORBIDDEN'});
  }
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM operations').get()!.n,before);
  for(const jobId of ['caller','ancestor','descendant'])await assert.rejects(daemon.call('jobs.grade',{jobId,grade:'bad',source:'human'},'lineage-key',caller),{code:'FORBIDDEN'});
});

test('checkpoint and acknowledgement are limited to the callers own foreground task',async(t)=>{
  const daemon=fixture(t);
  for(const method of ['tasks.checkpoint','tasks.controls.ack']){
    for(const params of [{taskId:'caller',jobId:'unrelated'},{taskId:'unrelated',jobId:'caller'}])await assert.rejects(daemon.call(method,{...params,controlIds:[]},'wrong-target',caller),{code:'FORBIDDEN'});
  }
  await daemon.call('tasks.checkpoint',{taskId:'caller',jobId:'caller'},'own-checkpoint',caller);
  daemon.database.db.exec("UPDATE jobs SET execution_kind='rollout_candidate' WHERE id='caller'");
  await assert.rejects(daemon.call('tasks.checkpoint',{taskId:'caller',jobId:'caller'},'own-checkpoint',caller),{code:'FORBIDDEN'});
});

test('agent grades remain advisory and cannot overwrite reviewer or human grades; principals cannot replay each other',async(t)=>{
  const daemon=fixture(t),db=daemon.database;
  const params={jobId:'unrelated',grade:'bad',source:'human'};
  await daemon.call('jobs.grade',params,'shared-key',caller);
  assert.equal(db.getJob('unrelated')!.gradeSource,'agent');
  assert.equal(db.getJob('unrelated')!.cause,null);
  await daemon.call('jobs.grade',{...params,grade:'good'},'shared-key');
  assert.equal(db.getJob('unrelated')!.gradeSource,'human');
  await daemon.call('jobs.grade',params,'second-key',caller);
  assert.equal(db.getJob('unrelated')!.grade,'good');
  assert.equal(db.getJob('unrelated')!.gradeSource,'human');
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM operations WHERE idempotency_key='shared-key'").get()!.n,2);
  await assert.rejects(daemon.call('jobs.grade',{...params,grade:'good'},'shared-key',caller),{code:'IDEMPOTENCY_CONFLICT'});
  db.db.exec("UPDATE jobs SET state='succeeded' WHERE id='caller'");
  await assert.rejects(daemon.call('jobs.grade',params,'shared-key',caller),{code:'FORBIDDEN'});
});

test('durable reservations reject duplicate pending execution, preserve conflicts, and complete without a held transaction',async(t)=>{
  const daemon=fixture(t),db=daemon.database;
  const pending=db.reserveOperation('operator','external','github.pr.create','hash');
  assert.equal(pending.state,'reserved');if(pending.state!=='reserved')return;
  assert.equal(db.db.isTransaction,false);
  assert.throws(()=>db.reserveOperation('operator','external','github.pr.create','hash'),{code:'RECONCILE_REQUIRED'});
  assert.throws(()=>db.reserveOperation('operator','external','github.pr.create','other'),{code:'IDEMPOTENCY_CONFLICT'});
  const other=db.reserveOperation('job:caller','external','github.pr.create','hash');assert.equal(other.state,'reserved');
  db.completeOperation(pending.reservation,{number:7});
  assert.deepEqual(db.reserveOperation('operator','external','github.pr.create','hash'),{state:'completed',response:{number:7}});
  assert.throws(()=>db.completeOperation(pending.reservation,{number:8}),{code:'STATE_CONFLICT'});
  const stillPending=db.db.prepare("SELECT state FROM operations WHERE principal='job:caller' AND idempotency_key='external'").get();
  assert.equal(stillPending!.state,'pending');
});
