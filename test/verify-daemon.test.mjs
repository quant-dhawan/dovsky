import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const script=resolve(root,"deploy","verify.mjs");
const head=spawnSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();
const healthy={ok:true,result:{ok:true}};
const goodDoctor={ok:true,result:{ok:true,checks:["source","schema","database","sandbox","releases"].map(name=>({name,ok:true,detail:"fixture"})),
  source:{head,dirty:false},schema:{ok:true},database:{writable:true},sandbox:{available:true}}};

async function run(t,responses) {
  const directory=mkdtempSync(resolve(tmpdir(),"dovsky-verify-")); const socketPath=resolve(directory,"bus.sock");
  t.after(()=>rmSync(directory,{recursive:true,force:true})); let connection=0;
  const server=createServer(socket=>{const response=responses[connection++];let body="";socket.setEncoding("utf8");socket.on("data",chunk=>body+=chunk);socket.on("end",()=>{
    if(response!==undefined)socket.end(`${JSON.stringify(typeof response==="function"?response(JSON.parse(body.trim())):response)}\n`);else socket.destroy();
  });});
  await new Promise((done,reject)=>{server.once("error",reject);server.listen(socketPath,done);});
  const result=await new Promise((done,reject)=>{const child=spawn(process.execPath,[script],{cwd:root,env:{...process.env,DOVSKY_SOCKET:socketPath},stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
    child.once("error",reject);child.once("close",code=>done({code,stdout,stderr}));});
  await new Promise(done=>server.close(done)); return result;
}

test("deploy verifier accepts a healthy complete doctor report without creating a job",async t=>{
  const result=await run(t,[healthy,goodDoctor]); assert.equal(result.code,0,result.stderr); assert.match(result.stdout,/Verification passed/);
  assert.doesNotMatch(result.stdout+result.stderr,/verification job|rooms\.create|routing\.list/);
});

test("deploy verifier rejects a negative doctor envelope and enforces the check floor",async t=>{
  const result=await run(t,[healthy,{ok:false,error:{message:"doctor failed"}}]); assert.equal(result.code,1); assert.match(result.stderr,/daemon doctor \(doctor failed\)/);
  assert.match(result.stderr,/observed 0/);
});

test("deploy verifier rejects empty checks and inconsistent deployment facts",async t=>{
  const result=await run(t,[healthy,{ok:true,result:{ok:false,checks:[],source:{head:"0".repeat(40),dirty:true},schema:{ok:false},database:{writable:false},sandbox:{available:false}}}]);
  assert.equal(result.code,1); for(const value of ["observed 0","reports healthy","matches checkout HEAD","checkout is clean","schema is current","database is writable","sandbox is available"])assert.match(result.stderr,new RegExp(value));
});

test("deploy verifier rejects a closed transport and still reports the doctor floor",async t=>{
  const result=await run(t,[undefined]); assert.equal(result.code,1); assert.match(result.stderr,/daemon RPC is healthy/); assert.match(result.stderr,/observed 0/);
});
