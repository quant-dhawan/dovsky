import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('production Git subprocesses have one bounded argv-only boundary',()=>{
  const root=new URL('../src/',import.meta.url).pathname;
  const walk=(directory:string):string[]=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.name==='__fixtures__'?[]:entry.isDirectory()?walk(join(directory,entry.name)):[join(directory,entry.name)]);
  const offenders=walk(root).filter(path=>path.endsWith('.ts')&&!path.endsWith('.test.ts')&&!path.endsWith('/git.ts')).filter(path=>/\b(?:spawn(?:Sync)?|execFile(?:Sync)?)\(\s*["']git["']/.test(readFileSync(path,'utf8')));
  assert.deepEqual(offenders,[]);
  const boundary=readFileSync(join(root,'git.ts'),'utf8');
  assert.match(boundary,/shell:false/);assert.match(boundary,/timeout:options.timeout \?\? 30_000/);
});
