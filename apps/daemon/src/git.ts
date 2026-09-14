import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularFile, safeTreePath } from './file-state.js';

/** Central bounded Git subprocess boundary; callers pass argv, never shell strings. */
export function gitSpawn(args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function gitSpawn(args: string[], options?: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
export function gitSpawn(args: string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
export function gitSpawn(args: string[], options: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  const env={...process.env,...options.env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  for(const key of Object.keys(env))if(/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key))delete env[key as keyof typeof env];
  return spawnSync('git', ['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args], { ...options,env,shell:false, timeout:options.timeout ?? 30_000, maxBuffer:options.maxBuffer ?? 64*1024*1024 });
}

export function gitBytes(cwd: string, args: string[], input?: Buffer, env?: NodeJS.ProcessEnv): Buffer {
  const result=gitSpawn(['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',cwd,...args],{
    ...(input ? {input} : {}), ...(env ? {env} : {}), encoding:'buffer',
  });
  if(result.error || result.status!==0) throw new Error(`Git ${args[0]} failed: ${result.error?.message ?? result.stderr.toString('utf8').slice(0,2048)}`);
  return result.stdout;
}
export function gitText(cwd: string,args:string[]):string {return gitBytes(cwd,args).toString('utf8').trim();}
export function repositoryRoot(cwd:string):string {return gitText(cwd,['rev-parse','--show-toplevel']);}
export function repositoryHead(cwd:string):string {return gitText(cwd,['rev-parse','HEAD']);}
export function repositoryDirty(cwd:string):boolean {return gitText(cwd,['status','--porcelain=v1','--untracked-files=all'])!=='';}
export function clonePrivate(source:string,target:string,commit:string):void {
  gitBytes(source,['clone','--no-local','--no-hardlinks','--no-checkout','--',source,target]);
  gitBytes(target,['checkout','--detach',commit,'--']);
  assertPrivateRepository(target);
}
export function assertPrivateRepository(root:string):void {
  const directory=join(root,'.git');
  if(!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink())throw new Error('Execution repository must have private Git metadata');
  if(existsSync(join(directory,'commondir'))||existsSync(join(directory,'objects','info','alternates')))throw new Error('Execution repository cannot share Git object storage');
  let entries=0;
  const inspect=(path:string):void=>{
    if(++entries>100_000)throw new Error('Git metadata exceeds inspection bound');
    const stat=lstatSync(path);
    if(stat.isSymbolicLink()||!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))throw new Error('Execution Git metadata cannot contain symlinks, devices or hardlinks');
    if(stat.isDirectory())for(const name of readdirSync(path))inspect(join(path,name));
  };
  inspect(directory);
  // A single config is the private-repository contract. config.worktree is a second
  // executable configuration surface when extensions.worktreeConfig is enabled.
  if(existsSync(join(directory,'config.worktree')))throw new Error('Execution Git metadata cannot contain secondary worktree configuration');
  readRegularFile(join(directory,'config'),1024*1024);
  // Let Git parse its own configuration syntax without following include directives.
  const parsed=gitSpawn(['config','--no-includes','--file',join(directory,'config'),'--name-only','--null','--list'],{encoding:'utf8',maxBuffer:1024*1024});
  if(parsed.error||parsed.status!==0)throw new Error('Invalid private Git configuration');
  const keys=parsed.stdout.split('\0').filter(Boolean).map(key=>key.toLowerCase());
  if(keys.some(key=>/^include(?:if)?\./.test(key)))throw new Error('Execution Git configuration cannot include host configuration');
  if(keys.some(key=>key.startsWith('filter.')))throw new Error('Execution Git configuration cannot run host filters during extraction');
  if(keys.includes('core.worktree'))throw new Error('Execution Git metadata cannot redirect its working tree');
}
export function worktreeAdd(source:string,target:string,commit:string):void {gitBytes(source,['worktree','add','--detach',target,commit]);}
export function worktreeRemove(source:string,target:string):void {gitBytes(source,['worktree','remove','--force',target]);}
export function worktreePrune(source:string):void {gitBytes(source,['worktree','prune']);}
export function remoteBranchHead(cwd:string,remote:string,branch:string):string|null {
  if(!remote||remote.length>4096||remote.startsWith('-')||/[\0\r\n]/.test(remote))throw new Error('Invalid Git remote');
  if(!branch||branch.length>256||branch.startsWith('-')||branch.includes('..')||branch.includes('@{')||/[\0-\x20~^:?*[\\]/.test(branch))throw new Error('Invalid Git branch');
  const ref=`refs/heads/${branch}`;
  const result=gitSpawn(['-C',cwd,'ls-remote','--exit-code','--heads',remote,ref],{encoding:'utf8',maxBuffer:1024*1024});
  if(result.status===2)return null;
  if(result.error||result.status!==0)throw new Error(`Git ls-remote failed: ${result.error?.message ?? result.stderr.slice(0,2048)}`);
  const rows=result.stdout.trim().split('\n').filter(Boolean);
  const match=rows.length===1?/^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(rows[0]!):null;
  if(!match||match[2]!==ref)throw new Error('Git ls-remote returned an invalid branch identity');
  return match[1]!;
}
/**
 * Identity of a working tree's state: HEAD, status, tracked changes and Git-visible
 * untracked bytes. Ignored/generated paths, installed dependencies and environment
 * are outside this legacy identity. Pair it with contentHash to cover all file modes.
 */
export function treeFingerprint(path: string): string | null {
  const git = (args: string[], input?: Buffer) =>
    gitSpawn(["-C", path, ...args], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, input });
  const head = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain=v1", "-z"]);
  const diff = git(["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (head.status !== 0 || status.status !== 0 || diff.status !== 0 || untracked.status !== 0) return null;
  const hash = createHash("sha256").update(head.stdout).update(status.stdout).update(diff.stdout);
  if (untracked.stdout.byteLength > 0) {
    try {
      for(const name of new TextDecoder('utf-8',{fatal:true}).decode(untracked.stdout).split('\0').filter(Boolean)){
        const file=safeTreePath(path,name),stat=lstatSync(file);
        const bytes=stat.isSymbolicLink()?Buffer.from(readlinkSync(file)):readRegularFile(file,256*1024*1024);
        const hashed=git(['hash-object','--no-filters','--stdin'],bytes);
        if(hashed.status!==0)return null;
        hash.update(hashed.stdout);
      }
    }catch{return null;}
  }
  return hash.digest("hex");
}
