import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

/** Existing metadata/output ancestors cannot redirect access through symlinks. */
export function assertRealDirectory(path:string):void {
  const absolute=resolve(path),root=parse(absolute).root;
  let current=root;
  for(const part of absolute.slice(root.length).split('/').filter(Boolean)){
    current=join(current,part);const stat=lstatSync(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`Unsafe directory ancestor: ${current}`);
  }
}

/** A provider output is never a stream/device/link, even when it appears after launch. */
export function readRegularFile(path:string,maxBytes:number):Buffer {
  assertRealDirectory(dirname(path));
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd);
    if(!before.isFile()||before.size>maxBytes)throw new Error(`Refusing non-regular or oversized file: ${path}`);
    const buffer=Buffer.alloc(Math.min(before.size+1,maxBytes+1));
    let count=0;
    while(count<buffer.length){const read=readSync(fd,buffer,count,buffer.length-count,null);if(!read)break;count+=read;}
    const bytes=buffer.subarray(0,count);
    const after=fstatSync(fd);
    if(bytes.length>maxBytes||bytes.length!==before.size||before.size!==after.size||before.mode!==after.mode||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error(`File changed while being captured: ${path}`);
    return bytes;
  }finally{closeSync(fd);}
}

/** Validate every ancestor with lstat so a relative file cannot escape through a link. */
export function safeTreePath(root:string,path:string,replacedAncestors:ReadonlySet<string>=new Set()):string {
  if(!path||isAbsolute(path)||path.includes('\0')||path.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'))throw new Error(`Unsafe tree path: ${path}`);
  const base=resolve(root),target=resolve(base,path);
  const rel=relative(base,target);
  if(rel==='..'||rel.startsWith('../'))throw new Error(`Path escapes tree: ${path}`);
  const parts=path.split('/');
  for(let i=1;i<parts.length;i++) {
    if(replacedAncestors.has(parts.slice(0,i).join('/')))return target;
    const parent=join(base,...parts.slice(0,i));
    try{const stat=lstatSync(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`Unsafe tree ancestor: ${parent}`);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  return target;
}
