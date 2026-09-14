import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ARM_SOURCES, EFFORTS, EXECUTION_KINDS, GRADE_SOURCES, REVIEW_OUTCOMES, ROLLOUT_OUTCOMES, TIERS } from "@dovsky/protocol";
import { DovskyDatabase } from "./database.js";
import { seedHistoricalDatabase } from "./__fixtures__/historical-database.js";
import { V18_JOB_ENUMS } from "./schema-migrations.js";

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "dovsky-migrations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.db");
  seedHistoricalDatabase(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      INSERT INTO attempts(id,job_id,turn_id,number,state) VALUES('attempt','parent','turn-parent',1,'running');
      INSERT INTO execution_leases(id,job_id,attempt_id,command_kind,command_number,state,prepared_at)
        VALUES('lease','parent','attempt','provider',1,'prepared','2026-09-09');
      INSERT INTO checks(id,job_id,command_json,state) VALUES('check','parent','["fixture"]','passed');
      INSERT INTO artifacts VALUES('artifact','parent','evidence','evidence','text/plain',5,'/untouched/evidence');
      INSERT INTO operations VALUES('legacy','jobs.grade','hash','{"value":1}','2026-09-09');
      INSERT INTO routing_policy(key,provider,workflow_id,tier,reason,updated_at) VALUES('codex/review/-','codex','review','hard','known prior','2026-09-09');
      UPDATE jobs SET reported_model='reported',tier='hard',grade='good',grade_source='human' WHERE id='parent';
      INSERT INTO jobs(id,room_id,project_id,workflow_id,provider,prompt,state,role,review_of,review_round,verdict,created_at,updated_at)
        VALUES('review','room','project','review','codex','review','succeeded','review','parent',1,'approved','2026-09-09','2026-09-09');
    `);
  } finally { db.close(); }
  return path;
}

function state(path: string): unknown {
  const db = new DatabaseSync(path);
  try {
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    return { version: db.prepare("PRAGMA user_version").get(), schema,
      data: schema.filter((row) => row.type === 'table').map((row) => [row.name, db.prepare(`SELECT * FROM "${String(row.name)}"`).all()]) };
  } finally { db.close(); }
}

function stopAfter(path: string, version: number): void {
  assert.throws(() => new DovskyDatabase(path, { afterCommit(current) { if (current === version) throw new Error('fixture stop'); } }), /fixture stop/);
}

for (const version of [13,14,15,16,17]) {
  test(`populated v${version} upgrades to 18 preserving rows, references, indexes and legacy operation identity`, (t) => {
    const path = fixture(t);
    if (version > 13) stopAfter(path, version);
    const before = new DatabaseSync(path);
    const indexes = before.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all();
    const canaries = ['turns','events','checks','artifacts','task_controls','task_ownership','release_targets'].map((table) => [table,before.prepare(`SELECT * FROM ${table}`).all()] as const);
    before.close();
    const db = new DovskyDatabase(path);
    try {
      assert.equal(db.db.prepare("PRAGMA user_version").get()!.user_version,18);
      assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(),[]);
      assert.equal(db.integrityCheck(),'ok');
      for (const [table, rows] of canaries) assert.deepEqual(db.db.prepare(`SELECT * FROM ${table}`).all(),rows,table);
      for (const index of indexes) assert.deepEqual(db.db.prepare("SELECT name,sql FROM sqlite_master WHERE name=?").get(index.name!),index);
      assert.equal(db.db.prepare("SELECT review_outcome FROM jobs WHERE id='review'").get()!.review_outcome,'approved');
      assert.equal(db.db.prepare("SELECT execution_kind FROM jobs WHERE id='review'").get()!.execution_kind,'review');
      assert.equal(db.db.prepare("SELECT source FROM tasks WHERE id='parent'").get()!.source,'legacy_unknown');
      assert.equal(db.db.prepare("SELECT arm_source FROM jobs WHERE id='parent'").get()!.arm_source,'legacy_unknown');
      assert.equal(db.db.prepare("SELECT model_identity FROM jobs WHERE id='child'").get()!.model_identity,'legacy_unknown');
      const operation = db.db.prepare("SELECT principal,state,response_json FROM operations WHERE idempotency_key='legacy'").get()!;
      assert.deepEqual({...operation},{principal:'operator',state:'completed',response_json:'{"value":1}'});
      assert.equal(db.db.prepare("SELECT alpha FROM routing_arms").get()!.alpha,3);
      assert.equal(db.db.prepare("SELECT attempt_id FROM execution_leases WHERE id='lease'").get()!.attempt_id,'attempt');
    } finally { db.close(); }
    const migrated = state(path);
    new DovskyDatabase(path).close();
    assert.deepEqual(state(path),migrated,'second open is a no-op');
  });
}

for (const version of [14,15,16,17,18]) {
  test(`migration ${version} rolls back statements and version atomically`, (t) => {
    const path = fixture(t);
    if (version > 14) stopAfter(path,version-1);
    const before = state(path);
    assert.throws(() => new DovskyDatabase(path,{afterStatements(current) { if(current===version) throw new Error('fixture failure'); }}),/fixture failure/);
    assert.deepEqual(state(path),before);
    new DovskyDatabase(path).close();
  });
}

test('frozen v18 enum constraints match current protocol and reject invalid historical values without data loss', (t) => {
  for (const [column,domain] of [['tier',TIERS],['effort',EFFORTS],['grade_source',GRADE_SOURCES],['arm_source',ARM_SOURCES],['execution_kind',EXECUTION_KINDS],['review_outcome',REVIEW_OUTCOMES],['rollout_outcome',ROLLOUT_OUTCOMES]] as const) assert.deepEqual(V18_JOB_ENUMS[column],domain);
  const path=fixture(t); stopAfter(path,17);
  const old=new DatabaseSync(path); old.exec("UPDATE jobs SET effort='future' WHERE id='parent'"); old.close();
  const before=state(path);
  assert.throws(()=>new DovskyDatabase(path),/parent, effort, "future"/);
  assert.deepEqual(state(path),before);
  const repair=new DatabaseSync(path); repair.exec("UPDATE jobs SET effort='high' WHERE id='parent'"); repair.close();
  const db=new DovskyDatabase(path);
  try {
    for(const column of Object.keys(V18_JOB_ENUMS)) assert.throws(()=>db.db.prepare(`UPDATE jobs SET ${column}='invalid' WHERE id='parent'`).run(),/constraint/i,column);
    assert.throws(()=>db.db.exec("UPDATE attempts SET state='invalid'"),/constraint/i);
    assert.equal(db.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys,1);
  } finally {db.close();}
});

test('populated frozen v1 upgrades and migration 7 failure is recoverable', (t) => {
  const root=mkdtempSync(join(tmpdir(),'dovsky-v1-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'state.db'); const old=new DatabaseSync(path);
  old.exec(readFileSync(new URL('../src/__fixtures__/schema-v1.sql',import.meta.url),'utf8'));
  old.exec(`INSERT INTO rooms VALUES('r','Room','p','w','2026-09-09','2026-09-09');
    INSERT INTO jobs(id,room_id,provider,project_id,workflow_id,state,prompt,result,created_at,updated_at)
      VALUES('j','r','codex','p','w','succeeded','prompt','historical result','2026-09-09','2026-09-09');
    INSERT INTO turns(id,job_id,room_id,author,recipient,body,created_at,status) VALUES('t','j','r','human','codex','prompt','2026-09-09','complete');
    INSERT INTO attempts(id,job_id,turn_id,number,state) VALUES('a','j','t',1,'succeeded');`);
  old.close();
  assert.throws(()=>new DovskyDatabase(path,{afterStatements(version){if(version===7)throw new Error('v7 failure');}}),/v7 failure/);
  const failed=new DatabaseSync(path);
  assert.equal(failed.prepare('PRAGMA user_version').get()!.user_version,6);
  assert.equal(failed.prepare("SELECT name FROM sqlite_master WHERE name='routing_policy'").get(),undefined);
  assert.ok(!failed.prepare('PRAGMA table_info(jobs)').all().some(row=>row.name==='grade'));
  failed.close();
  const db=new DovskyDatabase(path);
  try {
    assert.equal(db.db.prepare('PRAGMA user_version').get()!.user_version,18);
    assert.equal(db.getJob('j')!.result,'historical result');
    assert.equal(db.db.prepare("SELECT source FROM tasks WHERE id='j'").get()!.source,'backfill');
    assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.integrityCheck(),'ok');
  } finally{db.close();}
});

test('historical review failures never become verdicts and malformed failure JSON cannot break migration',t=>{
  const path=fixture(t),old=new DatabaseSync(path);
  const cases=[['failed','approved','not JSON','reviewer_failed'],['failed','refuted','{"code":"review_protocol"}','protocol_failed'],['cancelled',null,null,'reviewer_failed'],['succeeded',null,null,'protocol_failed'],['succeeded','inconclusive',null,'inconclusive']] as const;
  for(const [i,[state,verdict,failure]] of cases.entries())old.prepare(`INSERT INTO jobs(id,room_id,project_id,workflow_id,provider,prompt,state,role,review_of,review_round,verdict,failure_json,created_at,updated_at)
    VALUES(?,'room','project','review','codex','review',?,'review','parent',?,?,?,'2026-09-09','2026-09-09')`).run('r'+i,state,i+2,verdict,failure);
  old.close();const db=new DovskyDatabase(path);
  try{for(const [i,item] of cases.entries())assert.equal(db.getJob('r'+i)!.reviewOutcome,item[3]);}finally{db.close();}
});

test('v15 seeds one gate contribution from recorded execution evidence, preserves unknown authority and distinguishes pins',t=>{
  const path=fixture(t);stopAfter(path,14);const old=new DatabaseSync(path);
  old.exec(`UPDATE routing_policy SET reason='pinned by operator';
    INSERT INTO routing_policy(key,provider,workflow_id,tier,reason,updated_at,evidence_job_ids)
      VALUES('codex/automatic/-','codex','automatic','hard','pinned by operator','2026-09-09','{"promotion":true}');`);
  const rows=[
    ['reported','codex','succeeded','model-a','model-a','hard',null,null,'good','human','reported',1],
    ['configured','codex','succeeded','historical-custom',null,'hard',null,null,null,null,'configured_unverified',1],
    ['gate','codex','failed','model-a','model-a','hard','capability','{"code":"quality_gate"}',null,null,'reported',0],
    ['different','codex','succeeded','model-a','model-b','hard',null,null,null,null,'legacy_unknown',null],
    ['unknown-tier','codex','succeeded','model-a',null,null,null,null,null,null,'legacy_unknown',null],
    ['claude-no-report','claude','succeeded','model-a',null,'hard',null,null,null,null,'legacy_unknown',null],
    ['environment','codex','failed','model-a','model-a','hard','environmental','{"code":"provider_auth"}',null,null,'reported',null],
    ['bad','codex','succeeded','model-a','model-a','hard','capability',null,'bad','human','reported',null],
    ['agent','codex','succeeded','model-a','model-a','hard',null,null,'good','agent','reported',null],
    ['cancelled','codex','cancelled','model-a','model-a','hard','environmental',null,null,null,'reported',null],
  ] as const;
  for(const row of rows)old.prepare(`INSERT INTO jobs(id,room_id,project_id,workflow_id,provider,prompt,state,model,reported_model,tier,cause,failure_json,grade,grade_source,created_at,updated_at)
    VALUES(?,'room','project','review',?,'fixture',?,?,?,?,?,?,?,?,'2026-09-09','2026-09-09')`).run(...row.slice(0,10));
  old.close();const db=new DovskyDatabase(path);
  try{
    for(const row of rows){
      const job=db.getJob(row[0])!;assert.equal(job.modelIdentity,row[10],row[0]);assert.equal(job.resolvedModel,row[3]);assert.equal(job.armSource,'legacy_unknown');
      const reward=db.db.prepare('SELECT source,reward FROM routing_rewards WHERE execution_job_id=?').get(row[0]);
      assert.deepEqual(reward?{...reward}:null,row[11]===null?null:{source:'gate',reward:row[11]},row[0]);
    }
    assert.deepEqual({...db.db.prepare("SELECT alpha,beta,successes,failures,pinned FROM routing_arms WHERE key='codex/review/-' AND tier='hard'").get()!},{alpha:5,beta:2,successes:2,failures:1,pinned:1});
    assert.equal(db.db.prepare("SELECT pinned FROM routing_arms WHERE key='codex/automatic/-'").get()!.pinned,0);
    for(const source of ['agent','unknown'])assert.throws(()=>db.db.prepare("UPDATE routing_rewards SET source=? WHERE execution_job_id='reported'").run(source),/constraint/i);
    for(const identity of ['legacy_unknown','mismatch'])assert.throws(()=>db.db.prepare("UPDATE routing_rewards SET model_identity=? WHERE execution_job_id='reported'").run(identity),/constraint/i);
    assert.throws(()=>db.db.exec("INSERT INTO routing_rewards SELECT * FROM routing_rewards WHERE execution_job_id='reported'"),/UNIQUE/);
  }finally{db.close();}
  const before=state(path);new DovskyDatabase(path).close();assert.deepEqual(state(path),before,'reopen cannot double-count seeds');
});
