import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test,{type TestContext} from 'node:test';
import { assertPrivateRepository, gitBytes, gitText, treeFingerprint } from './git.js';
import { applyDelta, captureBaseline, captureDelta, contentHash, materializeBaseline, readBaseline } from './job-delta.js';
import { readRegularFile } from './file-state.js';

function fixture(t:TestContext):{root:string;repo:string} {
  const root=mkdtempSync(join(tmpdir(),'dovsky-delta-')),repo=join(root,'repo');mkdirSync(repo);
  t.after(()=>{
    const writable=(path:string):void=>{const stat=lstatSync(path);if(stat.isDirectory()&&!stat.isSymbolicLink()){chmodSync(path,0o700);for(const name of readdirSync(path))writable(join(path,name));}};
    writable(root);rmSync(root,{recursive:true,force:true});
  });
  gitBytes(repo,['init','-q']);gitBytes(repo,['config','user.name','Fixture']);gitBytes(repo,['config','user.email','fixture@example.invalid']);
  writeFileSync(join(repo,'tracked.txt'),'original\n');writeFileSync(join(repo,'deleted.txt'),'delete\n');writeFileSync(join(repo,'mode.sh'),'#!/bin/sh\n');writeFileSync(join(repo,'.gitignore'),'ignored.txt\n');
  gitBytes(repo,['add','.']);gitBytes(repo,['commit','-qm','baseline']);
  return {root,repo};
}

test('immutable dirty baseline and exact delta preserve binary, deletion, rename, modes and symlinks',t=>{
  const {root,repo}=fixture(t);
  writeFileSync(join(repo,'tracked.txt'),'pre-existing dirty bytes\n');
  writeFileSync(join(repo,'untracked.bin'),Buffer.from([0,255,1,2]));chmodSync(join(repo,'mode.sh'),0o755);
  unlinkSync(join(repo,'deleted.txt'));symlinkSync('tracked.txt',join(repo,'link'));
  const baseline=captureBaseline(repo,join(root,'baseline'));
  assert.deepEqual(readBaseline(baseline.directory),baseline);
  const privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  assert.equal(contentHash(privateRepo),baseline.manifest.identity.contentHash);
  assert.equal(lstatSync(join(privateRepo,'.git')).isDirectory(),true);
  assert.equal(existsSync(join(privateRepo,'.git','objects','info','alternates')),false);
  const originalObject=gitText(repo,['rev-parse','HEAD']);
  const canonicalObject=join(repo,'.git','objects',originalObject.slice(0,2),originalObject.slice(2));
  if(existsSync(canonicalObject))assert.equal(lstatSync(canonicalObject).nlink,1);
  writeFileSync(join(privateRepo,'tracked.txt'),'provider correction\n');
  writeFileSync(join(privateRepo,'new.bin'),Buffer.from([0,255,10]));
  writeFileSync(join(privateRepo,'renamed.bin'),readFileSync(join(privateRepo,'untracked.bin')));unlinkSync(join(privateRepo,'untracked.bin'));
  chmodSync(join(privateRepo,'mode.sh'),0o644);unlinkSync(join(privateRepo,'link'));symlinkSync('renamed.bin',join(privateRepo,'link'));
  const delta=captureDelta(baseline,privateRepo,join(root,'final'));
  assert.equal(readFileSync(join(repo,'tracked.txt'),'utf8'),'pre-existing dirty bytes\n','canonical remains unchanged before apply');
  const applied=applyDelta(repo,delta,join(root,'apply-intent.json'));
  assert.equal(applied.contentHash,delta.final.manifest.identity.contentHash);
  assert.equal(readFileSync(join(repo,'tracked.txt'),'utf8'),'provider correction\n');
  assert.deepEqual(readFileSync(join(repo,'new.bin')),Buffer.from([0,255,10]));
  assert.equal(existsSync(join(repo,'deleted.txt')),false);assert.equal(existsSync(join(repo,'untracked.bin')),false);
  assert.equal(lstatSync(join(repo,'mode.sh')).mode&0o777,0o644);assert.equal(readlinkSync(join(repo,'link')),'renamed.bin');
  assert.ok(existsSync(join(root,'apply-intent.json.complete')));
  assert.equal(gitText(repo,['rev-parse','HEAD']),baseline.manifest.commit,'never commit in operator tree');
});

test('untracked chmod bypasses legacy fingerprint but dual identity refuses before mutation',t=>{
  const {root,repo}=fixture(t);writeFileSync(join(repo,'untracked.sh'),'same bytes\n',{mode:0o644});
  const baseline=captureBaseline(repo,join(root,'baseline')),privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  writeFileSync(join(privateRepo,'tracked.txt'),'must not apply');const delta=captureDelta(baseline,privateRepo,join(root,'final'));
  const oldFingerprint=treeFingerprint(repo);chmodSync(join(repo,'untracked.sh'),0o755);
  assert.equal(treeFingerprint(repo),oldFingerprint,'regression reproduces the original identity hole');
  const before=contentHash(repo);
  assert.throws(()=>applyDelta(repo,delta,join(root,'intent')),/Canonical tree changed/);
  assert.equal(contentHash(repo),before);assert.equal(readFileSync(join(repo,'tracked.txt'),'utf8'),'original\n');assert.equal(existsSync(join(root,'intent')),false);
});

test('ignored-file collision refuses without overwriting operator bytes',t=>{
  const {root,repo}=fixture(t);writeFileSync(join(repo,'ignored.txt'),'operator ignored bytes');
  const baseline=captureBaseline(repo,join(root,'baseline')),privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  writeFileSync(join(privateRepo,'.gitignore'),'');writeFileSync(join(privateRepo,'ignored.txt'),'candidate bytes');
  const delta=captureDelta(baseline,privateRepo,join(root,'final')),before=contentHash(repo);
  assert.throws(()=>applyDelta(repo,delta,join(root,'intent')),/Unmanaged contents/);
  assert.equal(contentHash(repo),before);assert.equal(readFileSync(join(repo,'ignored.txt'),'utf8'),'operator ignored bytes');
});

test('snapshot blobs are validated before target mutation and output reads reject symlinks and size overflow',t=>{
  const {root,repo}=fixture(t),baseline=captureBaseline(repo,join(root,'baseline')),privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  writeFileSync(join(privateRepo,'tracked.txt'),'candidate');const delta=captureDelta(baseline,privateRepo,join(root,'final'));
  const entry=delta.final.manifest.entries.find(entry=>entry.path==='tracked.txt')!;
  const blob=join(delta.final.directory,'blobs',entry.hash);chmodSync(blob,0o600);writeFileSync(blob,'tampered');
  assert.throws(()=>applyDelta(repo,delta,join(root,'intent')),/Baseline blob changed/);
  assert.equal(readFileSync(join(repo,'tracked.txt'),'utf8'),'original\n');
  symlinkSync(join(repo,'tracked.txt'),join(root,'output-link'));
  assert.throws(()=>readRegularFile(join(root,'output-link'),100),/ELOOP/);
  assert.throws(()=>readRegularFile(join(repo,'tracked.txt'),2),/oversized/);
  assert.throws(()=>captureBaseline(repo,join(repo,'metadata')),/outside/);
});

test('framed content identity detects type swaps and parent directory modes',t=>{
  const {repo}=fixture(t);mkdirSync(join(repo,'dir'));writeFileSync(join(repo,'dir','a'),'value');
  const first=contentHash(repo);chmodSync(join(repo,'dir'),0o700);assert.notEqual(contentHash(repo),first);
  const second=contentHash(repo);unlinkSync(join(repo,'dir','a'));symlinkSync('../tracked.txt',join(repo,'dir','a'));assert.notEqual(contentHash(repo),second);
});

test('exact application supports file-directory and directory-symlink swaps without following targets',t=>{
  const {root,repo}=fixture(t);mkdirSync(join(repo,'nested'));writeFileSync(join(repo,'nested','old'),'old');gitBytes(repo,['add','.']);gitBytes(repo,['commit','-qm','directory']);
  const baseline=captureBaseline(repo,join(root,'baseline')),privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  unlinkSync(join(privateRepo,'tracked.txt'));mkdirSync(join(privateRepo,'tracked.txt'));writeFileSync(join(privateRepo,'tracked.txt','new'),'new');
  rmSync(join(privateRepo,'nested'),{recursive:true});symlinkSync('tracked.txt',join(privateRepo,'nested'));
  const delta=captureDelta(baseline,privateRepo,join(root,'final'));
  applyDelta(repo,delta,join(root,'intent'));
  assert.equal(readFileSync(join(repo,'tracked.txt','new'),'utf8'),'new');
  assert.equal(readlinkSync(join(repo,'nested')),'tracked.txt');
  assert.equal(contentHash(repo),contentHash(privateRepo));
});

test('application preserves read-only directory modes and newline filenames',t=>{
  const {root,repo}=fixture(t);mkdirSync(join(repo,'readonly'));
  const name='readonly/line\nbreak';writeFileSync(join(repo,name),'before');chmodSync(join(repo,'readonly'),0o500);
  const baseline=captureBaseline(repo,join(root,'baseline')),privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  writeFileSync(join(privateRepo,name),'after');
  const delta=captureDelta(baseline,privateRepo,join(root,'final'));
  applyDelta(repo,delta,join(root,'intent'));
  assert.equal(readFileSync(join(repo,name),'utf8'),'after');assert.equal(lstatSync(join(repo,'readonly')).mode&0o777,0o500);
  assert.equal(contentHash(repo),contentHash(privateRepo));
});

test('private repository validation refuses shared metadata and working-tree redirection',t=>{
  const {root,repo}=fixture(t),baseline=captureBaseline(repo,join(root,'baseline')),privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  const config=join(privateRepo,'.git','config'),original=readFileSync(config);
  gitBytes(privateRepo,['config','core.worktree',repo]);assert.throws(()=>assertPrivateRepository(privateRepo),/redirect/);writeFileSync(config,original);
  writeFileSync(config,Buffer.concat([original,Buffer.from('\n[include]\npath = /host/config\n')]));assert.throws(()=>assertPrivateRepository(privateRepo),/include host/);writeFileSync(config,original);
  const alternates=join(privateRepo,'.git','objects','info','alternates');writeFileSync(alternates,join(repo,'.git','objects'));assert.throws(()=>assertPrivateRepository(privateRepo),/share Git/);unlinkSync(alternates);
  const linked=join(privateRepo,'.git','linked-config');linkSync(config,linked);assert.throws(()=>assertPrivateRepository(privateRepo),/hardlinks/);unlinkSync(linked);
  assertPrivateRepository(privateRepo);
});

test('snapshot metadata and output ancestors cannot redirect into another tree',t=>{
  const {root,repo}=fixture(t),outside=join(root,'outside');mkdirSync(outside);symlinkSync(outside,join(root,'alias'));
  assert.throws(()=>captureBaseline(repo,join(root,'alias','baseline')),/Unsafe directory ancestor/);
  assert.equal(existsSync(join(outside,'baseline')),false);
  writeFileSync(join(outside,'output'),'private');assert.throws(()=>readRegularFile(join(root,'alias','output'),100),/Unsafe directory ancestor/);
  const baseline=captureBaseline(repo,join(root,'baseline')),privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  writeFileSync(join(privateRepo,'tracked.txt'),'candidate');const delta=captureDelta(baseline,privateRepo,join(root,'final'));
  assert.throws(()=>applyDelta(repo,delta,join(repo,'intent')),/outside the provider project/);
  assert.equal(readFileSync(join(repo,'tracked.txt'),'utf8'),'original\n');
  gitBytes(privateRepo,['config','filter.host.clean','touch '+join(outside,'executed')]);
  assert.throws(()=>captureDelta(baseline,privateRepo,join(root,'filtered')),/host filters/);assert.equal(existsSync(join(outside,'executed')),false);
});

test('secondary Git configuration cannot execute a filter during extraction',t=>{
  const {root,repo}=fixture(t),baseline=captureBaseline(repo,join(root,'baseline')),privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  gitBytes(privateRepo,['config','extensions.worktreeConfig','true']);
  const marker=join(root,'host-filter-ran');
  writeFileSync(join(privateRepo,'.git','config.worktree'),`[filter "probe"]\n clean = "touch ${marker}; cat"\n required = true\n`);
  writeFileSync(join(privateRepo,'.gitattributes'),'tracked.txt filter=probe\n');writeFileSync(join(privateRepo,'tracked.txt'),'provider output');
  assert.throws(()=>assertPrivateRepository(privateRepo),/secondary worktree configuration/);
  assert.throws(()=>captureDelta(baseline,privateRepo,join(root,'final')),/secondary worktree configuration/);
  assert.equal(existsSync(marker),false);
});

test('failed directory replacement restores elevated modes and retains recovery intent',t=>{
  const {root,repo}=fixture(t);writeFileSync(join(repo,'.gitignore'),'ignored.txt\nreadonly/ignored.txt\n');
  mkdirSync(join(repo,'readonly'));writeFileSync(join(repo,'readonly','managed'),'before');writeFileSync(join(repo,'readonly','ignored.txt'),'operator bytes');chmodSync(join(repo,'readonly'),0o500);
  const baseline=captureBaseline(repo,join(root,'baseline')),privateRepo=join(root,'private');materializeBaseline(repo,privateRepo,baseline);
  chmodSync(join(privateRepo,'readonly'),0o700);rmSync(join(privateRepo,'readonly'),{recursive:true});symlinkSync('tracked.txt',join(privateRepo,'readonly'));
  const delta=captureDelta(baseline,privateRepo,join(root,'final')),intent=join(root,'intent');
  assert.throws(()=>applyDelta(repo,delta,intent),/ignored contents block replacement/);
  assert.equal(lstatSync(join(repo,'readonly')).mode&0o777,0o500);assert.equal(readFileSync(join(repo,'readonly','ignored.txt'),'utf8'),'operator bytes');
  assert.equal(existsSync(intent),true);assert.equal(existsSync(intent+'.complete'),false);
  assert.throws(()=>applyDelta(repo,delta,intent),/Canonical tree changed|EEXIST/);
});
