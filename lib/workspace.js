import fs from 'node:fs/promises';
import path from 'node:path';
import {check, exists, hash, json, read, readJson, atomic, privateDir, noLinks, id, RECEIPT, MAX_PACKET, syncDir} from './util.js';
import {verify, materialize, git} from './artifact.js';

const join = (p,s) => path.join(p.targetRoot,s);
const binding = p => JSON.stringify(p.binding);
export async function root(p) {
  await noLinks(p.targetRoot);
  if(!await exists(p.targetRoot)) {
    await privateDir(p.targetRoot);
    await atomic(join(p,'root.json'),json({format:1,binding:p.binding}));
  }
  await privateDir(p.targetRoot);
  check(await exists(join(p,'root.json')), 'Target root already exists without ownership marker; choose a new dedicated directory');
  const r=await readJson(join(p,'root.json'));
  check(r.format===1 && JSON.stringify(r.binding)===binding(p),'Target belongs to another project/channel');
}
export async function healthy(p) {
  await root(p); check(!await exists(join(p,'transaction.json')),'Interrupted workspace transaction: run recover first');
}
export async function stage(p,verified) {
  await healthy(p);
  const temp=join(p,`incoming-${id()}`);
  try {
    await materialize(temp,verified);
    await fs.rm(join(p,'staged'),{recursive:true,force:true});
    await fs.rename(temp,join(p,'staged')); await syncDir(p.targetRoot);
  } finally {await fs.rm(temp,{recursive:true,force:true});}
}
async function inventory(dir) {
  const entries=[]; let total=0;
  async function walk(at,prefix='') {
    for(const d of (await fs.readdir(at,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file=path.join(at,d.name), name=prefix+d.name;
      const st=await fs.lstat(file); check(!st.isSymbolicLink(),'Workspace contains a symlink/junction; move it outside before applying');
      if(st.isDirectory()) {entries.push([name+'/',0,'directory']);await walk(file,name+'/');}
      else {
        check(st.isFile(),'Workspace contains a special file'); total+=st.size;
        check(total<=256*1024*1024,'Workspace exceeds 256 MiB; keep build outputs outside current');
        entries.push([name,st.mode&0o777,hash(await read(file,MAX_PACKET))]);
      }
      check(entries.length<=50000,'Workspace file count limit');
    }
  }
  await noLinks(dir); await walk(dir);
  return {entries,digest:hash(json(entries))};
}
async function inspect(p,slot,signal) {
  const dir=join(p,slot); if(!await exists(dir)) return null;
  const receipt=await read(path.join(dir,RECEIPT));
  const v=await verify(p,receipt,{signal});
  const inv=await inventory(dir); const map=new Map(inv.entries.map(([name,mode,digest])=>[name,{mode,digest}]));
  for(const f of v.manifest.files) {
    const actual=map.get(f.path);
    check(actual && actual.digest===f.sha256 && (process.platform==='win32' || actual.mode===f.mode), `Managed source was modified: ${f.path}; preserve your edits outside current first`);
  }
  const expected=new Set(v.manifest.files.map(f=>f.path)); expected.add(RECEIPT);
  const extra=inv.entries.filter(([name])=>!name.endsWith('/')&&!expected.has(name)).map(([name])=>name);
  return {...v,entries:inv.entries,treeDigest:inv.digest,extra,slot,dir};
}
function backupName(name) {check(typeof name==='string' && /^backup-[a-f0-9-]{36}$/.test(name),'Invalid backup slot');return name;}
export async function review(p,state,action,signal) {
  await healthy(p);
  const slot=action==='apply'?'staged':backupName(state.previous);
  const from=await inspect(p,'current',signal), to=await inspect(p,slot,signal);
  check(to,action==='apply'?'No staged snapshot; fetch first':'No local backup');
  check(to.extra.length===0 || action==='rollback','Staged directory has unexpected files');
  if(action==='apply') check(to.manifest.sequence===state.highwater && to.digest===state.acceptedEnvelope,'Staged snapshot is not the highest verified version');
  const a=new Map((from?.manifest.files || []).map(f=>[f.path,f])), b=new Map(to.manifest.files.map(f=>[f.path,f]));
  const changes=[];
  for(const n of [...new Set([...a.keys(),...b.keys()])].sort()) {
    const x=a.get(n), y=b.get(n);
    if(!x) changes.push({path:n,change:'add'});
    else if(!y) changes.push({path:n,change:'delete'});
    else if(x.sha256!==y.sha256 || x.mode!==y.mode) changes.push({path:n,change:'modify'});
  }
  const token=hash(json({action,config:p.configHash,from:from?.treeDigest || null,to:to.treeDigest,highwater:state.highwater,slot})).slice(0,24);
  return {action,token,slot,from,to,changes,extraPreservedInBackup:from?.extra || []};
}
export async function diff(p,rev,signal) {
  const parts=[]; let count=0;
  for(const c of rev.changes) {
    if(c.change!=='modify') continue;
    if(++count>20) {parts.push('Further content diffs omitted; file list remains complete.');break;}
    const result=await git(p,['diff','--no-index','--no-ext-diff','--no-textconv','--',path.join(rev.from.dir,c.path),path.join(rev.to.dir,c.path)],
      {signal,codes:[0,1],limit:MAX_PACKET});
    parts.push(result.stdout.subarray(0,12000).toString('utf8'));
  }
  return parts.join('\n').slice(0,64000);
}
export function summary(rev) {
  return {action:rev.action,from:rev.from?.manifest.sequence || null,to:rev.to.manifest.sequence,
    sourceCommit:rev.to.manifest.sourceCommit,changes:rev.changes,extraPreservedInBackup:rev.extraPreservedInBackup,
    confirm:rev.token,explanation:'Whole snapshot replacement. Existing build outputs stay in the backup; no build or code is executed.'};
}
export async function switchVersion(p,state,rev,save,signal) {
  signal?.throwIfAborted();
  const backup=`backup-${id()}`;
  const transaction={format:1,slot:rev.slot,backup,hadCurrent:!!rev.from,previous:state.previous || null,fromDigest:rev.from?.digest || null,toDigest:rev.to.digest};
  await atomic(join(p,'transaction.json'),json(transaction));
  // From the first rename onward, finish or leave a recoverable journal even if cancelled.
  try {
    if(rev.from) await fs.rename(join(p,'current'),join(p,backup));
    await fs.rename(join(p,rev.slot),join(p,'current')); await syncDir(p.targetRoot);
    state.previous=rev.from?backup:null;
    await save(state);
    await fs.unlink(join(p,'transaction.json')); await syncDir(p.targetRoot);
  } catch(e) {throw new Error(`Workspace transaction interrupted; stop builds and run recover. ${e.message}`);}
  return {applied:rev.to.manifest.sequence,current:join(p,'current'),previous:state.previous,highwater:state.highwater};
}
export async function recover(p,state,save,signal) {
  await root(p); const file=join(p,'transaction.json');
  if(!await exists(file)) return {recovered:false,reason:'No interrupted transaction'};
  const t=await readJson(file); backupName(t.backup);
  check(t.format===1 && (t.slot==='staged'||/^backup-[a-f0-9-]{36}$/.test(t.slot)) && /^[a-f0-9]{64}$/.test(t.toDigest),'Invalid transaction journal; inspect manually');
  const current=await inspect(p,'current',signal);
  const candidateExists=await exists(join(p,t.slot)),backupExists=await exists(join(p,t.backup));
  // A repeated application can have identical old/new receipts. Topology plus
  // the old receipt distinguishes "journal written, no rename" from completion.
  if(current && candidateExists && !backupExists) {
    check(t.hadCurrent && current.digest===t.fromDigest,'Original workspace no longer matches the journal');
    const candidate=await inspect(p,t.slot,signal);check(candidate.digest===t.toDigest,'Candidate no longer matches the journal');
    state.previous=t.previous;await save(state);await fs.unlink(file);await syncDir(p.targetRoot);
    return {recovered:true,outcome:'No rename had occurred; original and staged snapshots retained'};
  }
  if(current?.digest===t.toDigest) {
    check(!await exists(join(p,t.slot)), 'Ambiguous recovery: candidate still exists');
    if(t.hadCurrent) check(await inspect(p,t.backup,signal),'Missing transaction backup');
    state.previous=t.hadCurrent?t.backup:null; await save(state);
    await fs.unlink(file); await syncDir(p.targetRoot); return {recovered:true,outcome:'Completed directory switch'};
  }
  if(!current && t.hadCurrent) {
    const original=await inspect(p,t.backup,signal);
    check(original && original.digest===t.fromDigest,'Missing or mismatched original workspace backup');
    await fs.rename(join(p,t.backup),join(p,'current')); await syncDir(p.targetRoot);
  } else check(!await exists(join(p,t.backup)), 'Ambiguous recovery: both current and backup exist');
  check(await exists(join(p,t.slot)), 'Candidate missing; inspect transaction manually');
  state.previous=t.previous; await save(state); await fs.unlink(file); await syncDir(p.targetRoot);
  return {recovered:true,outcome:'Restored original directory; run diff before retrying'};
}
