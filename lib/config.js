import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {check, label, relative, privateFile, privateDir, noLinks, disjoint, inside, hash, json, read} from './util.js';

export const defaultConfig = () => path.join(os.homedir(), '.config', 'dsh-secure-publish', 'config.json');
function keys(o, allowed, where) { check(o && typeof o === 'object' && !Array.isArray(o), `Invalid ${where}`); for(const k of Object.keys(o)) check(allowed.includes(k), `Unknown ${where} field: ${k}`); }
export function absolute(p) { check(typeof p === 'string' && path.isAbsolute(p), 'Paths must be absolute (no ~ expansion)'); return path.resolve(p); }
export function binding(p) { return {project:p.project,channel:p.channel,repository:p.repository.toLowerCase(),branch:p.branch}; }
export function relayFields(p) {
  check(typeof p.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository) && !p.repository.includes('..'), 'repository must be GitHub owner/repo');
  check(typeof p.branch === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$/.test(p.branch)
    && !p.branch.includes('..') && !p.branch.includes('//') && !p.branch.endsWith('/')
    && p.branch.split('/').every(s=>!s.startsWith('.')&&!s.endsWith('.')&&!s.endsWith('.lock')), 'Invalid branch');
  label(p.channel);
}
export function recipient(key) { check(typeof key === 'string' && /^age1[0-9a-z]{58}$/.test(key),'Use native age X25519 recipients only'); return key; }
export function publicKeyLine(bytes) {
  const key=bytes.toString('utf8').trim().split(/\r?\n/).at(-1);
  check(/^RW[A-Za-z0-9+/]{54}$/.test(key),'Invalid minisign public key'); return key;
}
async function executable(name) {
  check(typeof name === 'string' && name.length > 0, 'Invalid executable');
  if(path.isAbsolute(name)) { await noLinks(path.dirname(name)); return name; }
  check(!/[\\/]/.test(name), 'Executable must be a name or absolute path');
  for(const d of (process.env.PATH || '').split(path.delimiter).filter(d=>path.isAbsolute(d))) {
    for(const ext of process.platform === 'win32' ? ['.exe', ''] : ['']) {
      const p = path.join(d, name+ext); try { await fs.access(p, 1); return p; } catch {}
    }
  }
  return name; // doctor reports the dependency; startup itself remains usable.
}
export async function loadConfig(file = defaultConfig()) {
  file = absolute(file); await privateFile(file);
  const bytes = await fs.readFile(file); check(bytes.length <= 1024*1024, 'Config too large');
  const result=await validateConfig(JSON.parse(bytes),file);
  return {...result,revision:hash(json({bytes:hash(bytes),trust:result.trust}))};
}
// All writers validate a candidate against its final filename before replacing it.
// Device metadata is optional: existing v1 projects and state paths remain usable.
export async function validateConfig(c,file=defaultConfig()) {
  file=absolute(file); check(json(c).length<=1024*1024,'Config too large');
  keys(c,['version','stateDir','binaries','projects','device'],'config');
  check(c.version === 1, 'Unsupported config version'); keys(c.projects,Object.keys(c.projects || {}),'projects');
  const stateDir = absolute(c.stateDir); await privateDir(stateDir);
  check(!inside(stateDir,file),'Config must be outside stateDir');
  disjoint(stateDir,`${file}.control`);
  keys(c.binaries || {},['git','age','minisign'],'binaries');
  const binaries = {};
  for(const k of ['git','age','minisign']) binaries[k] = await executable(c.binaries?.[k] || k);
  const projects = Object.create(null),keyPaths=new Set(),trust={};
  const keyFile=async(p,secret=false)=>{
    p=absolute(p); if(secret) await privateFile(p); else await noLinks(p);
    const bytes=await read(p,16384);keyPaths.add(p);trust[p]=hash(bytes);
    check(!inside(stateDir,p),'Keys must be outside stateDir'); return bytes;
  };
  const device=c.device || {identities:{},peers:{},defaults:{},retired:{}};
  keys(device,['identities','peers','defaults','retired'],'device');
  for(const field of ['identities','peers','defaults','retired']) keys(device[field]||{},Object.keys(device[field]||{}),field);
  for(const [name,i] of Object.entries(device.identities||{})) {
    label(name); keys(i,['role','signingKey','verifyKey','identity'],'identity');
    check(['publisher','receiver'].includes(i.role),'Invalid identity role');
    if(i.role==='publisher') {
      check(i.identity===undefined,'Unexpected age identity');
      await keyFile(i.signingKey,true);publicKeyLine(await keyFile(i.verifyKey));
    } else {
      check(i.signingKey===undefined && i.verifyKey===undefined,'Unexpected signing identity');
      await keyFile(i.identity,true);
    }
  }
  for(const [name,p] of Object.entries(device.peers||{})) {
    label(name);keys(p,['role','recipient','verifyKey'],'peer');
    if(p.role==='receiver') {recipient(p.recipient);check(p.verifyKey===undefined,'Unexpected peer verification key');}
    else {check(p.role==='publisher' && p.recipient===undefined,'Invalid peer role');publicKeyLine(await keyFile(p.verifyKey));}
  }
  keys(device.defaults||{},['publisher','receiver'],'defaults');
  for(const [role,d] of Object.entries(device.defaults||{})) {
    keys(d,['identity','peers','peer','repository','branch','channel'],'defaults');relayFields(d);
    check(device.identities?.[d.identity]?.role===role,'Default identity is missing or has the wrong role');
    if(role==='publisher') {
      check(d.peer===undefined && Array.isArray(d.peers) && d.peers.length<=32,'Invalid receiver peers');
      check(new Set(d.peers).size===d.peers.length,'Duplicate receiver peers');
      for(const n of d.peers) check(device.peers?.[n]?.role==='receiver','Default receiver peer is missing');
    } else {check(d.peers===undefined,'Unexpected receiver defaults');if(d.peer!==undefined)check(device.peers?.[d.peer]?.role==='publisher','Default publisher peer is missing');}
  }
  for(const [name,p] of Object.entries(device.retired||{})) {
    label(name);keys(p,['role','project','channel','repository','branch'],'retired profile');label(p.project);relayFields(p);
    check(['publisher','receiver'].includes(p.role) && !Object.hasOwn(c.projects,name),'Invalid retired profile');
  }
  for(const [name,p] of Object.entries(c.projects)) {
    label(name); keys(p,['role','project','channel','repository','branch','source','include','exclude','recipients','signingKey','verifyKey','identity','targetRoot','minSequence','maxAgeDays'],'project');
    check(['publisher','receiver'].includes(p.role), 'role must be publisher or receiver');
    label(p.project); label(p.channel);
    relayFields(p);
    check(Number.isSafeInteger(p.minSequence) && p.minSequence >= 1 && p.minSequence<=999999999999, 'minSequence must be 1..999999999999');
    check(Number.isInteger(p.maxAgeDays) && p.maxAgeDays >= 1 && p.maxAgeDays <= 3650, 'maxAgeDays must be 1..3650');
    const out = {...p, name, stateDir:path.join(stateDir,name), binaries, verifyKey:absolute(p.verifyKey)};
    const trustHash=hash(await keyFile(out.verifyKey));
    if(p.role === 'publisher') {
      out.source = absolute(p.source); await noLinks(out.source);
      check(Array.isArray(p.include) && p.include.length > 0, 'Publisher requires explicit include paths');
      check(p.exclude===undefined || Array.isArray(p.exclude),'exclude must be an array');
      for(const prefix of [...p.include,...(p.exclude || [])]) relative(prefix);
      check(Array.isArray(p.recipients) && p.recipients.length > 0 && p.recipients.length <= 32
        && p.recipients.every(k=> typeof k === 'string' && /^age1[0-9a-z]{58}$/.test(k)), 'Use native age X25519 recipients only');
      out.signingKey = absolute(p.signingKey); await keyFile(out.signingKey,true);
      disjoint(out.source, stateDir); check(!inside(out.source,file), 'Config must be outside source');
      check(!inside(out.source,out.signingKey), 'Signing key must be outside source');
      check(!inside(out.source,out.verifyKey), 'Pinned verification key must be outside source');
      check(p.identity === undefined && p.targetRoot === undefined, 'Receiver fields not allowed on publisher');
    } else {
      out.identity = absolute(p.identity); await keyFile(out.identity,true);
      out.targetRoot = absolute(p.targetRoot); await noLinks(out.targetRoot);
      disjoint(out.targetRoot,stateDir); check(!inside(out.targetRoot,file) && !inside(out.targetRoot,out.identity) && !inside(out.targetRoot,out.verifyKey), 'Target must not contain config or keys');
      for(const k of ['source','include','exclude','recipients','signingKey']) check(p[k] === undefined, `Publisher field not allowed on receiver: ${k}`);
    }
    out.configHash = hash(json({file, ...p, binaries, trustHash}));
    out.binding = binding(p);
    projects[name] = out;
  }
  const receivers = Object.values(projects).filter(p=>p.role === 'receiver');
  for(let i=0;i<receivers.length;i++) for(let j=i+1;j<receivers.length;j++) disjoint(receivers[i].targetRoot,receivers[j].targetRoot);
  for(const r of receivers) for(const p of Object.values(projects)) {
    if(p.source) disjoint(r.targetRoot,p.source);
    for(const k of ['verifyKey','signingKey','identity']) if(p[k]) check(!inside(r.targetRoot,p[k]),'Target must not contain any configured key');
  }
  for(const p of Object.values(projects)) {
    disjoint(p.source||p.targetRoot,`${file}.control`);
    for(const key of keyPaths) check(!inside(p.source||p.targetRoot,key),'Source/target must not contain any configured key');
  }
  return {file,projects,binaries,stateDir,raw:c,device,trust};
}
