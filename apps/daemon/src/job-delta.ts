import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { CanonicalIdentity } from '@dovsky/protocol';
import { assertPrivateRepository, clonePrivate, gitBytes, gitText, treeFingerprint } from './git.js';
import { assertRealDirectory, readRegularFile, safeTreePath } from './file-state.js';

const MAX_FILE_BYTES=64*1024*1024;
const MAX_TREE_BYTES=256*1024*1024;
export interface TreeEntry {path:string;type:'file'|'link'|'directory';mode:number;size:number;hash:string;}
export interface TreeManifest {version:1;commit:string;identity:CanonicalIdentity;entries:TreeEntry[];}
/** This directory is daemon-only, immutable and never mounted into a provider namespace. */
export interface BaselineHandle {directory:string;manifest:TreeManifest;}
export interface DeltaEntry {path:string;before:TreeEntry|null;after:TreeEntry|null;}
export interface DeltaArtifact {baseline:BaselineHandle;final:BaselineHandle;entries:DeltaEntry[];}
const sha=(bytes:Buffer|string):string=>createHash('sha256').update(bytes).digest('hex');
const compare=(a:TreeEntry,b:TreeEntry):number=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path));

function digest(entries:TreeEntry[]):string {
  const hash=createHash('sha256');
  for(const entry of entries){
    // Length-framed fields cannot collide through separator characters in names/targets.
    for(const field of [entry.path,entry.type,String(entry.mode),String(entry.size),entry.hash]){
      const bytes=Buffer.from(field);const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);hash.update(length).update(bytes);
    }
  }
  return hash.digest('hex');
}

function captureEntries(root:string,save?:(hash:string,bytes:Buffer)=>void):TreeEntry[] {
  const gitlinks=new Set(gitBytes(root,['ls-files','--stage','-z']).toString('utf8').split('\0').filter(line=>line.startsWith('160000 ')).map(line=>line.slice(line.indexOf('\t')+1)));
  const names=new TextDecoder('utf-8',{fatal:true}).decode(gitBytes(root,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  if(names.length>100_000)throw new Error('Execution baseline exceeds the bounded entry count');
  const entries=new Map<string,TreeEntry>();let total=0;
  for(const path of new Set(names)){
    // An index entry below a replaced file/link is deleted, not permission to follow it.
    let shadowed=false;
    const parts=path.split('/');
    for(let i=1;i<parts.length;i++){
      const parent=safeTreePath(root,parts.slice(0,i).join('/'));
      try{if(!lstatSync(parent).isDirectory()){shadowed=true;break;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    if(shadowed)continue;
    const absolute=safeTreePath(root,path);
    let stat;try{stat=lstatSync(absolute);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(stat.isDirectory()&&!gitlinks.has(path))continue; // A tracked file became a directory; its present children are separate entries.
    if(!stat.isFile()&&!stat.isSymbolicLink())throw new Error(`Unsupported tracked entry (including submodules): ${path}`);
    const bytes=stat.isSymbolicLink()?Buffer.from(readlinkSync(absolute)):readRegularFile(absolute,MAX_FILE_BYTES);
    total+=bytes.length;if(total>MAX_TREE_BYTES)throw new Error('Execution baseline exceeds the bounded snapshot size');
    const hash=sha(bytes);save?.(hash,bytes);
    entries.set(path,{path,type:stat.isSymbolicLink()?'link':'file',mode:stat.mode&0o7777,size:bytes.length,hash});
    let parent=dirname(path);
    while(parent!=='.'){
      const parentStat=lstatSync(safeTreePath(root,parent));
      if(!parentStat.isDirectory())throw new Error(`Unsafe snapshot directory: ${parent}`);
      entries.set(parent,{path:parent,type:'directory',mode:parentStat.mode&0o7777,size:0,hash:sha('')});
      parent=dirname(parent);
    }
  }
  return [...entries.values()].sort(compare);
}

export function contentHash(root:string):string{return digest(captureEntries(root));}
export function canonicalIdentity(root:string):CanonicalIdentity {
  const fingerprint=treeFingerprint(root);if(!fingerprint)throw new Error('Cannot establish canonical Git identity');
  return {fingerprint,contentHash:contentHash(root)};
}
export function assertCanonicalIdentity(root:string,expected:CanonicalIdentity):void {
  const current=canonicalIdentity(root);
  if(current.fingerprint!==expected.fingerprint||current.contentHash!==expected.contentHash)throw new Error('Canonical tree changed since the execution baseline; refusing application');
}

export function captureBaseline(root:string,directory:string):BaselineHandle {
  const base=resolve(root),store=resolve(directory),rel=relative(base,store);
  assertRealDirectory(base);assertRealDirectory(dirname(store));
  if(!rel||rel==='.'||!rel.startsWith('../'))throw new Error('Baseline metadata must be outside the provider project');
  const before=canonicalIdentity(base),commit=gitText(base,['rev-parse','HEAD']);
  mkdirSync(store,{mode:0o700});mkdirSync(resolve(store,'blobs'),{mode:0o700});
  const entries=captureEntries(base,(hash,bytes)=>{const path=resolve(store,'blobs',hash);if(!existsSync(path))writeFileSync(path,bytes,{flag:'wx',mode:0o400});});
  const manifest:TreeManifest={version:1,commit,identity:{fingerprint:before.fingerprint,contentHash:digest(entries)},entries};
  if(manifest.identity.contentHash!==before.contentHash)throw new Error('Tree changed during baseline capture');
  assertCanonicalIdentity(base,before);
  const serialized=JSON.stringify(manifest);
  if(Buffer.byteLength(serialized)>16*1024*1024)throw new Error('Execution baseline manifest is oversized');
  writeFileSync(resolve(store,'manifest.json'),serialized,{flag:'wx',mode:0o400});
  chmodSync(resolve(store,'blobs'),0o500);chmodSync(store,0o500);
  return {directory:store,manifest};
}

export function readBaseline(directory:string):BaselineHandle {
  const manifest=JSON.parse(readRegularFile(resolve(directory,'manifest.json'),16*1024*1024).toString()) as TreeManifest;
  if(manifest.version!==1||!Array.isArray(manifest.entries)||typeof manifest.commit!=='string'||!manifest.identity)throw new Error('Invalid baseline manifest');
  const names=new Set<string>();
  for(const entry of manifest.entries){
    if(typeof entry.path!=='string'||!['file','link','directory'].includes(entry.type)||!Number.isInteger(entry.mode)||entry.mode<0||entry.mode>0o7777||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>MAX_FILE_BYTES||!/^[a-f0-9]{64}$/.test(entry.hash)||names.has(entry.path))throw new Error('Invalid baseline entry');
    safeTreePath(directory,entry.path);names.add(entry.path);
  }
  const sorted=[...manifest.entries].sort(compare);
  if(JSON.stringify(sorted)!==JSON.stringify(manifest.entries)||digest(sorted)!==manifest.identity.contentHash)throw new Error('Baseline manifest identity changed');
  return {directory:resolve(directory),manifest};
}

function blob(snapshot:BaselineHandle,entry:TreeEntry):Buffer {
  const bytes=readRegularFile(resolve(snapshot.directory,'blobs',entry.hash),MAX_FILE_BYTES);
  if(bytes.length!==entry.size||sha(bytes)!==entry.hash)throw new Error(`Baseline blob changed: ${entry.path}`);
  return bytes;
}

function same(a:TreeEntry|undefined,b:TreeEntry|undefined):boolean{return JSON.stringify(a??null)===JSON.stringify(b??null);}
export function captureDelta(baseline:BaselineHandle,root:string,directory:string):DeltaArtifact {
  assertPrivateRepository(root);
  return diffSnapshots(baseline,captureBaseline(root,directory));
}
export function diffSnapshots(baseline:BaselineHandle,final:BaselineHandle):DeltaArtifact {
  const before=new Map(baseline.manifest.entries.map(entry=>[entry.path,entry])),after=new Map(final.manifest.entries.map(entry=>[entry.path,entry]));
  const entries=[...new Set([...before.keys(),...after.keys()])].sort().filter(path=>!same(before.get(path),after.get(path))).map(path=>({path,before:before.get(path)??null,after:after.get(path)??null}));
  return {baseline,final,entries};
}

function materialize(root:string,current:TreeEntry[],snapshot:BaselineHandle):void {
  const next=new Map(snapshot.manifest.entries.map(entry=>[entry.path,entry]));
  const previous=new Map(current.map(entry=>[entry.path,entry]));
  const replacedAncestors=new Set(current.filter(entry=>entry.type!=='directory'&&next.get(entry.path)?.type==='directory').map(entry=>entry.path));
  // Read/validate every new preimage before the first target mutation.
  const contents=new Map(snapshot.manifest.entries.filter(e=>e.type!=='directory').map(e=>[e.path,blob(snapshot,e)]));
  for(const entry of snapshot.manifest.entries){
    const path=safeTreePath(root,entry.path,replacedAncestors);
    if([...replacedAncestors].some(parent=>entry.path.startsWith(parent+'/')))continue;
    if(!previous.has(entry.path)){
      let existing;try{existing=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(existing&&(entry.type!=='directory'||!existing.isDirectory()||(existing.mode&0o7777)!==entry.mode))throw new Error(`Unmanaged contents block addition: ${entry.path}`);
    }
    if(entry.type==='file'&&!same(previous.get(entry.path),entry)&&existsSync(`${path}.dovsky-apply`))throw new Error(`Application temporary path already exists: ${entry.path}`);
  }
  const elevated:TreeEntry[]=[];let completed=false;
  try {
  // Only captured directories may be made writable, and only during application.
  for(const entry of current.filter(e=>e.type==='directory').sort((a,b)=>a.path.split('/').length-b.path.split('/').length)){
    if((entry.mode&0o700)!==0o700){chmodSync(safeTreePath(root,entry.path),entry.mode|0o700);elevated.push(entry);}
  }
  for(const entry of [...current].sort((a,b)=>b.path.split('/').length-a.path.split('/').length)){
    const desired=next.get(entry.path);if(same(entry,desired))continue;
    const path=safeTreePath(root,entry.path);
    if(entry.type==='directory'){
      if(!desired||desired.type!=='directory')try{rmdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOTEMPTY')throw error;if(desired)throw new Error(`Untracked/ignored contents block replacement: ${entry.path}`);}
    }else unlinkSync(path);
  }
  for(const entry of snapshot.manifest.entries.filter(e=>e.type==='directory').sort((a,b)=>a.path.split('/').length-b.path.split('/').length))mkdirSync(safeTreePath(root,entry.path),{recursive:true,mode:0o700});
  for(const entry of snapshot.manifest.entries){
    if(entry.type==='directory'||same(previous.get(entry.path),entry))continue;
    const path=safeTreePath(root,entry.path),bytes=contents.get(entry.path)!;
    if(entry.type==='link')symlinkSync(bytes.toString(),path);
    else{const temporary=`${path}.dovsky-apply`;writeFileSync(temporary,bytes,{flag:'wx',mode:entry.mode});chmodSync(temporary,entry.mode);renameSync(temporary,path);}
  }
  for(const entry of snapshot.manifest.entries.filter(e=>e.type==='directory').reverse())chmodSync(safeTreePath(root,entry.path),entry.mode);
  completed=true;
  } finally {
    for(const entry of elevated.reverse()){
      // A replaced ancestor may now be a link; never follow it during cleanup.
      let path:string;try{path=safeTreePath(root,entry.path);}catch{continue;}
      let stat;try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(stat.isDirectory()&&!stat.isSymbolicLink())chmodSync(path,completed&&next.get(entry.path)?.type==='directory'?next.get(entry.path)!.mode:entry.mode);
    }
  }
}

export function materializeBaseline(source:string,target:string,baseline:BaselineHandle):void {
  clonePrivate(source,target,baseline.manifest.commit);
  restoreSnapshot(target,baseline);
}

export function restoreSnapshot(target:string,snapshot:BaselineHandle):void {
  materialize(target,captureEntries(target),snapshot);
  if(contentHash(target)!==snapshot.manifest.identity.contentHash)throw new Error('Private repository does not match captured snapshot');
}

/** Caller holds canonical/task locks until application and all gates are settled. */
export function applyDelta(root:string,delta:DeltaArtifact,intentPath:string):CanonicalIdentity {
  assertRealDirectory(root);assertRealDirectory(dirname(intentPath));
  const intentRelative=relative(resolve(root),resolve(intentPath));
  if(!intentRelative.startsWith('../'))throw new Error('Application intent must be outside the provider project');
  assertCanonicalIdentity(root,delta.baseline.manifest.identity);
  const final=readBaseline(delta.final.directory),baseline=readBaseline(delta.baseline.directory);
  // Durable intent is exclusive: a crash/retry requires explicit preimage reconciliation.
  writeFileSync(intentPath,JSON.stringify({version:1,state:'applying',baseline:baseline.directory,final:final.directory,expected:baseline.manifest.identity,contentHash:final.manifest.identity.contentHash}),{flag:'wx',mode:0o400});
  assertCanonicalIdentity(root,baseline.manifest.identity);
  materialize(root,baseline.manifest.entries,final);
  const identity=canonicalIdentity(root);
  if(identity.contentHash!==final.manifest.identity.contentHash)throw new Error('Applied tree does not match reviewed content; reconcile persisted intent');
  writeFileSync(`${intentPath}.complete`,JSON.stringify(identity),{flag:'wx',mode:0o400});
  return identity;
}
