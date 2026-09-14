import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test,{type TestContext} from 'node:test';
import { DovskyDaemon } from './daemon.js';
import { DovskyDatabase, type NewJob } from './database.js';
import { resolveBandit,resolveSandbox,type DaemonConfig } from './config.js';
import { readProcessIdentity } from './execution-lease.js';

function fixture(t:TestContext):DovskyDaemon {
  const root=mkdtempSync(join(tmpdir(),'dovsky-foundation-'));
  const daemon=new DovskyDaemon({socketPath:join(root,'run','bus.sock'),databasePath:join(root,'state','state.db'),artifactDirectory:join(root,'artifacts'),maxActive:1,
    projects:[{id:'p',name:'Fixture',path:root,workflows:[{id:'w',name:'Fixture',readOnly:false,qualityCommands:[],providers:{codex:{argv:[process.execPath]}}}]}]});
  t.after(async()=>{await daemon.stop();daemon.close();rmSync(root,{recursive:true,force:true});});
  daemon.database.createRoom('room','Fixture','p','w');return daemon;
}
function job(daemon:DovskyDaemon,id:string,extra:Partial<NewJob>={}):void {
  daemon.database.createJob({id,roomId:'room',projectId:'p',workflowId:'w',provider:'codex',prompt:'fixture',...extra},'turn-'+id);
}

test('auxiliary kinds bypass task inheritance and creation; invalid foreground detachment is rejected',t=>{
  const daemon=fixture(t),db=daemon.database;job(daemon,'parent');
  job(daemon,'candidate',{executionKind:'rollout_candidate',parentJobId:'parent',taskId:'parent',taskLink:'none'});
  job(daemon,'reviewer',{executionKind:'rollout_review',role:'review',reviewOf:'candidate',reviewRound:1});
  for(const id of ['candidate','reviewer'])assert.equal(db.getJob(id)!.taskId,null);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n,1);
  assert.equal(db.db.prepare("SELECT latest_job_id FROM tasks WHERE id='parent'").get()!.latest_job_id,'parent');
  assert.equal(db.latestJob('room','codex')!.id,'parent');
  assert.throws(()=>job(daemon,'bad1',{taskLink:'none'}),/Foreground executions require task/);
  assert.throws(()=>job(daemon,'bad2',{executionKind:'rollout_candidate',role:'review'}),/kind and role/);
  assert.throws(()=>job(daemon,'bad3',{executionKind:'rollout_review',role:'review',taskLink:'inherit'}),/cannot inherit/);
  assert.throws(()=>job(daemon,'bad4',{executionKind:'promotion'}),/Promotion requires/);
});

test('auxiliary acceptance and task completion fail without mutation even with an accidental historical task link',async t=>{
  const daemon=fixture(t),db=daemon.database;job(daemon,'parent');job(daemon,'candidate',{executionKind:'rollout_candidate'});
  db.db.exec("UPDATE jobs SET state='succeeded',task_id='parent' WHERE id='candidate'");
  const before=db.db.prepare("SELECT * FROM tasks WHERE id='parent'").get();
  await assert.rejects(daemon.call('jobs.acceptance.check',{jobId:'candidate'}),{code:'STATE_CONFLICT'});
  await assert.rejects(daemon.call('jobs.acceptance.record',{jobId:'candidate',verdict:'accepted',note:'Fixture decision',checked:[],fingerprint:'fixture',evidenceHash:'fixture'},'acceptance-probe'),{code:'STATE_CONFLICT',message:/Auxiliary/});
  assert.throws(()=>daemon.coordination.finish('parent','candidate',null),/Only foreground/);
  assert.deepEqual(db.db.prepare("SELECT * FROM tasks WHERE id='parent'").get(),before);
});

test('rollout reviewer refutation stores outcome but never grades, corrects, or creates tasks',t=>{
  const daemon=fixture(t),db=daemon.database;job(daemon,'parent');job(daemon,'candidate',{executionKind:'rollout_candidate',parentJobId:'parent'});
  job(daemon,'reviewer',{executionKind:'rollout_review',role:'review',reviewOf:'candidate',reviewRound:1,review:{target:'codex',tier:'hard',corrections:2}});
  db.db.exec("UPDATE jobs SET state='succeeded',thread_id='candidate-thread' WHERE id='candidate'; UPDATE jobs SET state='running' WHERE id='reviewer'");
  const finalize=(daemon as unknown as {finalizeReview:(...args:unknown[])=>void}).finalizeReview.bind(daemon);
  finalize(db.getJob('reviewer'),'1. file.ts:1 — broken behavior\nVERDICT: REFUTED',{});
  assert.equal(db.getJob('reviewer')!.reviewOutcome,'refuted');assert.equal(db.getJob('candidate')!.grade,null);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n,3);assert.equal(db.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n,1);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM task_ownership').get()!.n,0);
});

test('per-room queue cap does not consume another rooms budget; batch rollback is atomic',t=>{
  const daemon=fixture(t),db=daemon.database;
  for(let i=0;i<20;i++)job(daemon,'a'+i);
  assert.throws(()=>job(daemon,'overflow'),/Room room queue/);
  db.createRoom('other','Other','p','w');job(daemon,'other-job',{roomId:'other'});
  assert.equal(db.countQueued(),21);
  assert.throws(()=>db.transaction(()=>{job(daemon,'rollback',{roomId:'other'});job(daemon,'overflow');}),/Room room queue/);
  assert.equal(db.getJob('rollback'),null);assert.equal(db.countQueued(),21);
});

test('event peek uses acknowledged cursor without creating or advancing consumer state',async t=>{
  const daemon=fixture(t),db=daemon.database;job(daemon,'parent');
  const fresh=await daemon.call('events.peek',{consumerId:'reader'});
  assert.ok(fresh);assert.equal(db.db.prepare('SELECT count(*) AS n FROM event_consumers').get()!.n,0);
  const taken=daemon.coordination.consume('reader',null,100);
  assert.ok(taken.items.length>0);
  const before=db.db.prepare('SELECT * FROM event_consumers').all();
  assert.deepEqual(await daemon.call('events.peek',{consumerId:'reader'}),taken);
  assert.deepEqual(db.db.prepare('SELECT * FROM event_consumers').all(),before);
  daemon.coordination.ackEvents('reader',taken.cursor);
  assert.deepEqual(await daemon.call('events.peek',{consumerId:'reader'}),{items:[],cursor:taken.cursor});
});

test('pending external reservation survives reopen and cannot be blindly executed again',t=>{
  const daemon=fixture(t),db=daemon.database;
  const reservation=db.reserveOperation('operator','durable-key','external','hash');assert.equal(reservation.state,'reserved');
  const reopened=new DovskyDatabase(db.path);
  try{assert.throws(()=>reopened.reserveOperation('operator','durable-key','external','hash'),{code:'RECONCILE_REQUIRED'});}finally{reopened.close();}
});

test('restart uses the same scoped observation policy as settlement and keeps the canonical fence',t=>{
  const daemon=fixture(t),db=daemon.database;job(daemon,'scoped');db.db.exec("UPDATE jobs SET state='running' WHERE id='scoped'");
  assert.equal(db.acquireResources('scoped',['canonical-fixture']),true);db.prepareExecutionLease('lease','scoped',null,'provider',1);
  db.enrollExecutionLease('lease',{pid:2147483000,processGroup:2147483000,startTicks:'1',bootId:readProcessIdentity(process.pid)!.bootId},
    {unit:'fixture.scope',cgroupPath:'/fixture/fixture.scope'});
  assert.equal(db.settleExecutionLease('lease')!.state,'reconcile_required');assert.equal(db.recoverInterruptedJobs(),1);
  assert.equal(db.executionForJob('scoped').leases[0]!.state,'reconcile_required');assert.deepEqual(db.executionForJob('scoped').resources,['canonical-fixture']);
});

test('ordinary reviews neither inherit work tasks nor create explicitly supplied tasks',t=>{
  const daemon=fixture(t),db=daemon.database;job(daemon,'worker');
  job(daemon,'review-inherit',{role:'review',reviewOf:'worker',reviewRound:1});
  job(daemon,'review-create',{role:'review',reviewOf:'worker',reviewRound:2,taskId:'review-only-task'});
  assert.equal(db.getJob('review-inherit')!.taskId,null);assert.equal(db.getJob('review-create')!.taskId,null);
  assert.equal(db.db.prepare("SELECT id FROM tasks WHERE id='review-only-task'").get(),undefined);
  assert.throws(()=>job(daemon,'explicit-inherit',{role:'review',taskLink:'inherit'}),/cannot inherit/);
});

test('sandbox config is finite and fail-closed; routing defaults remain independently validated',t=>{
  const daemon=fixture(t),config=daemon.config;
  assert.equal(resolveSandbox(config).backend,'bwrap');assert.equal(resolveSandbox(config).memoryMax,'8G');
  assert.equal(resolveBandit(config).costWeights.frontier,12);
  for(const sandbox of [{enabled:false},{backend:'worktree'},{memoryMax:'infinity'},{cpuQuota:'400'},{tasksMax:0},{runtimePaths:[config.artifactDirectory]},{homePaths:['/']}])assert.throws(()=>resolveSandbox({...config,sandbox} as DaemonConfig));
  assert.throws(()=>resolveBandit({...config,routing:{bandit:{decay:0}}}),/bandit/);
  const resolved=resolveSandbox({...config,sandbox:{memoryMax:'4G'}},config.projects[0],{...config.projects[0]!.workflows[0]!,sandbox:{tasksMax:64}},{argv:['fixture'],sandbox:{network:false}});
  assert.equal(resolved.memoryMax,'4G');assert.equal(resolved.tasksMax,64);assert.equal(resolved.network,false);
});
