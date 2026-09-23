import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {check, label, relative, privateFile, privateDir, noLinks, disjoint, inside, hash, json, read} from './util.js';

export const defaultConfig = () => path.join(os.homedir(), '.config', 'dsh-secure-publish', 'config.json');
function keys(o, allowed, where) { check(o && typeof o === 'object' && !Array.isArray(o), `Invalid ${where}`); for(const k of Object.keys(o)) check(allowed.includes(k), `Unknown ${where} field: ${k}`); }
function absolute(p) { check(typeof p === 'string' && path.isAbsolute(p), 'Paths must be absolute (no ~ expansion)'); return path.resolve(p); }
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
  const c = JSON.parse(bytes); keys(c,['version','stateDir','binaries','projects'],'config');
  check(c.version === 1, 'Unsupported config version'); keys(c.projects,Object.keys(c.projects || {}),'projects');
  const stateDir = absolute(c.stateDir); await privateDir(stateDir);
  keys(c.binaries || {},['git','age','minisign'],'binaries');
  const binaries = {};
  for(const k of ['git','age','minisign']) binaries[k] = await executable(c.binaries?.[k] || k);
  const projects = {};
  for(const [name,p] of Object.entries(c.projects)) {
    label(name); keys(p,['role','project','channel','repository','branch','source','include','exclude','recipients','signingKey','verifyKey','identity','targetRoot','minSequence','maxAgeDays'],'project');
    check(['publisher','receiver'].includes(p.role), 'role must be publisher or receiver');
    label(p.project); label(p.channel);
    check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository) && !p.repository.includes('..'), 'repository must be GitHub owner/repo');
    check(typeof p.branch === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$/.test(p.branch)
      && !p.branch.includes('..') && !p.branch.includes('//') && !p.branch.endsWith('/')
      && p.branch.split('/').every(s=>!s.startsWith('.')&&!s.endsWith('.')&&!s.endsWith('.lock')), 'Invalid branch');
    check(Number.isSafeInteger(p.minSequence) && p.minSequence >= 1 && p.minSequence<=999999999999, 'minSequence must be 1..999999999999');
    check(Number.isInteger(p.maxAgeDays) && p.maxAgeDays >= 1 && p.maxAgeDays <= 3650, 'maxAgeDays must be 1..3650');
    const out = {...p, name, stateDir:path.join(stateDir,name), binaries, verifyKey:absolute(p.verifyKey)};
    await noLinks(out.verifyKey);
    const trustHash=hash(await read(out.verifyKey,8192));
    if(p.role === 'publisher') {
      out.source = absolute(p.source); await noLinks(out.source);
      check(Array.isArray(p.include) && p.include.length > 0, 'Publisher requires explicit include paths');
      check(p.exclude===undefined || Array.isArray(p.exclude),'exclude must be an array');
      for(const prefix of [...p.include,...(p.exclude || [])]) relative(prefix);
      check(Array.isArray(p.recipients) && p.recipients.length > 0 && p.recipients.length <= 32
        && p.recipients.every(k=> typeof k === 'string' && /^age1[0-9a-z]{58}$/.test(k)), 'Use native age X25519 recipients only');
      out.signingKey = absolute(p.signingKey); await privateFile(out.signingKey);
      disjoint(out.source, stateDir); check(!inside(out.source,file), 'Config must be outside source');
      check(!inside(out.source,out.signingKey), 'Signing key must be outside source');
      check(!inside(out.source,out.verifyKey), 'Pinned verification key must be outside source');
      check(p.identity === undefined && p.targetRoot === undefined, 'Receiver fields not allowed on publisher');
    } else {
      out.identity = absolute(p.identity); await privateFile(out.identity);
      out.targetRoot = absolute(p.targetRoot); await noLinks(out.targetRoot);
      disjoint(out.targetRoot,stateDir); check(!inside(out.targetRoot,file) && !inside(out.targetRoot,out.identity) && !inside(out.targetRoot,out.verifyKey), 'Target must not contain config or keys');
      for(const k of ['source','include','exclude','recipients','signingKey']) check(p[k] === undefined, `Publisher field not allowed on receiver: ${k}`);
    }
    out.configHash = hash(json({file, ...p, binaries, trustHash}));
    out.binding = {project:p.project, channel:p.channel, repository:p.repository.toLowerCase(), branch:p.branch};
    projects[name] = out;
  }
  const receivers = Object.values(projects).filter(p=>p.role === 'receiver');
  for(let i=0;i<receivers.length;i++) for(let j=i+1;j<receivers.length;j++) disjoint(receivers[i].targetRoot,receivers[j].targetRoot);
  for(const r of receivers) for(const p of Object.values(projects)) {
    if(p.source) disjoint(r.targetRoot,p.source);
    for(const k of ['verifyKey','signingKey','identity']) if(p[k]) check(!inside(r.targetRoot,p[k]),'Target must not contain any configured key');
  }
  return {file,projects,binaries,stateDir};
}
