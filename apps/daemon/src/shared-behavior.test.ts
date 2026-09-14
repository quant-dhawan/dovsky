import assert from 'node:assert/strict';
import { chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,unlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test,{type TestContext} from 'node:test';
import { DovskyDaemon,digestPath,treeFingerprint } from './daemon.js';
import { gitBytes,gitText } from './git.js';
import type { EvaluationSpec,StoredJob } from './model.js';

function fixture(t:TestContext){
  const root=mkdtempSync(join(tmpdir(),'dovsky-shared-')),project=join(root,'project');mkdirSync(project);
  gitBytes(project,['init','-q']);gitBytes(project,['config','user.name','Fixture']);gitBytes(project,['config','user.email','fixture@example.invalid']);
  writeFileSync(join(project,'tracked.txt'),'before\n');gitBytes(project,['add','.']);gitBytes(project,['commit','-qm','baseline']);
  const daemon=new DovskyDaemon({socketPath:join(root,'run','bus.sock'),databasePath:join(root,'state','db'),artifactDirectory:join(root,'artifacts'),maxActive:1,
    projects:[{id:'p',name:'Fixture',path:project,workflows:[{id:'w',name:'Fixture',readOnly:false,qualityCommands:[],providers:{codex:{argv:[process.execPath]}}}]}]});
  t.after(async()=>{await daemon.stop();daemon.close();rmSync(root,{recursive:true,force:true});});
  daemon.database.createRoom('room','Fixture','p','w');
  const job=(id:string,evaluation?:EvaluationSpec)=>daemon.database.createJob({id,roomId:'room',projectId:'p',workflowId:'w',provider:'codex',prompt:'Fixture',...(evaluation?{evaluation}:{})},'turn-'+id);
  return {root,project,daemon,job};
}
const low:EvaluationSpec={baselineJobId:'missing-original',level:'low',reason:'Fixture',criteria:[],runnerSource:'',runnerPath:'runner.mjs',runnerHash:'fixture',qualityCommands:[],reviewRequired:false};

test('protected digests distinguish executable modes, directory structure and link targets',t=>{
  const {project}=fixture(t),path=join(project,'protected');writeFileSync(path,'name\0value');const file=digestPath(path);
  chmodSync(path,0o755);assert.notEqual(digestPath(path),file,'chmod alone changes protection identity');
  chmodSync(path,0o644);unlinkSync(path);mkdirSync(path);writeFileSync(join(path,'name'),'value');assert.notEqual(digestPath(path),file,'directory and file framing cannot collide');
  const directory=digestPath(path);chmodSync(path,0o700);assert.notEqual(digestPath(path),directory);
  symlinkSync('tracked.txt',join(project,'link'));const link=digestPath(join(project,'link'));unlinkSync(join(project,'link'));symlinkSync('protected',join(project,'link'));assert.notEqual(digestPath(join(project,'link')),link);
});

test('the real protect gate rejects an executable-mode-only change',async t=>{
  const {daemon,project,job}=fixture(t);job('protected-worker');
  const worker=daemon.database.getJob('protected-worker')!;
  worker.gates={protect:['tracked.txt'],requireChange:null,verify:null,redBefore:null,writable:[]};
  const start={fingerprint:treeFingerprint(project),protectDigests:[digestPath(join(project,'tracked.txt'))]};
  chmodSync(join(project,'tracked.txt'),0o755);
  const internal=daemon as unknown as {resolveWorkflow:(project:string,workflow:string)=>{workflow:unknown};runGates:(job:StoredJob,cwd:string,workflow:unknown,result:string,start:unknown)=>Promise<{code:string;summary:string}|null>};
  const failure=await internal.runGates(worker,project,internal.resolveWorkflow('p','w').workflow,'Fixture',start);
  assert.equal(failure?.code,'quality_gate');assert.match(failure!.summary,/Protected paths were modified: tracked.txt/);
  assert.equal(daemon.database.getRoom('room').checks.at(-1)?.state,'failed');
});

test('evidence fallback cannot collide with earlier scratch files or escape its final failure boundary',t=>{
  const {root,project,daemon,job}=fixture(t);job('worker',low);
  const directory=join(root,'artifacts','jobs','worker');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'font-policy.json'),'[]');writeFileSync(join(directory,'evidence-before-0'),'previous pass');
  const start={commit:gitText(project,['rev-parse','HEAD']),fingerprint:treeFingerprint(project),protectDigests:[],untracked:new Set<string>(),dirty:new Map(),pre:{directory:join(root,'pre'),complete:true}};
  writeFileSync(join(project,'tracked.txt'),'after\n');
  const worker=daemon.database.getJob('worker')!;
  const internal=daemon as unknown as {buildRoomEvidence:(job:StoredJob,cwd:string,start:unknown,brief:string,result:string)=>{text:string;complete:boolean};buildEvidence:(...args:unknown[])=>{text:string;complete:boolean}};
  const result=internal.buildRoomEvidence(worker,project,start,'Fixture brief','Fixture result');
  assert.equal(result.complete,false);assert.match(result.text,/status: INCOMPLETE/);assert.equal(readFileSync(join(directory,'evidence-before-0'),'utf8'),'previous pass');
  const original=internal.buildEvidence;internal.buildEvidence=()=>{throw new Error('second failure');};
  try{const failed=internal.buildRoomEvidence(worker,project,start,'Fixture','Fixture');assert.equal(failed.complete,false);assert.match(failed.text,/status: INCOMPLETE/);}finally{internal.buildEvidence=original;}
});

test('earlier failed work remains attention-worthy after later accepted evaluation',t=>{
  const {daemon,job}=fixture(t),db=daemon.database;job('failed',low);job('accepted',low);
  db.db.exec("UPDATE jobs SET state='failed' WHERE id='failed'; UPDATE jobs SET state='succeeded',end_fingerprint='fixture',evaluation_evidence_hash='evidence' WHERE id='accepted'; UPDATE tasks SET state='completed'");
  const room=db.getRoom('room').room;assert.equal(room.evaluation!.state,'accepted');assert.equal(room.needsAttention,true);
  assert.ok(db.listRooms(100,null,undefined,'attention').items.some(room=>room.id==='room'));
  db.db.exec("UPDATE jobs SET state='succeeded',end_fingerprint='fixture',evaluation_evidence_hash='evidence' WHERE id='failed'");
  assert.equal(db.getRoom('room').room.needsAttention,false);
});

test('queue wait uses started minus created, nearest-rank percentiles, and excludes unstarted or invalid history',async t=>{
  const {daemon,job}=fixture(t),db=daemon.database;
  for(const [id,wait] of [['zero',0],['one',100],['two',200],['three',300],['four',400]] as const){
    job(id);db.db.prepare('UPDATE jobs SET created_at=?,started_at=? WHERE id=?').run('2026-09-13T10:00:00.000Z',new Date(Date.parse('2026-09-13T10:00:00.000Z')+wait).toISOString(),id);
  }
  job('queued');job('invalid');db.db.prepare("UPDATE jobs SET started_at='invalid' WHERE id='invalid'").run();
  job('old');db.db.prepare("UPDATE jobs SET created_at='2026-09-11T10:00:00.000Z',started_at='2026-09-11T10:00:01.000Z' WHERE id='old'").run();
  const usage=db.usage() as unknown as {jobs:{jobId:string;queueWaitMs:number|null}[];queueWait:{p50:number|null;p95:number|null;max:number|null;samples:number}};
  assert.equal(usage.jobs.find(item=>item.jobId==='one')!.queueWaitMs,100);
  assert.equal(usage.jobs.find(item=>item.jobId==='queued')!.queueWaitMs,null);
  assert.equal(usage.jobs.find(item=>item.jobId==='invalid')!.queueWaitMs,null);
  assert.deepEqual(usage.queueWait,{p50:200,p95:1000,max:1000,samples:6});
  assert.equal((db.getJobSummary('two').usage as unknown as {queueWaitMs:number}).queueWaitMs,200);
  const internal=db as unknown as {queueWaitStats:(since:string)=>unknown};
  assert.deepEqual(internal.queueWaitStats('2026-09-12T10:00:00.000Z'),{p50:200,p95:400,max:400,samples:5});
  assert.deepEqual(internal.queueWaitStats('2026-09-14T10:00:00.000Z'),{p50:null,p95:null,max:null,samples:0});
  const health=await daemon.call('health',{}) as {queueWait:{samples:number}};
  const expected=db.queueWaitStats(new Date(Date.now()-24*60*60*1000).toISOString());
  assert.deepEqual(health.queueWait,expected);
});
