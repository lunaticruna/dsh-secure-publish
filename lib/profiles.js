import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig,validateConfig,absolute,binding} from './config.js';
import {check,privateDir,atomic,json,hash,exists,lock,disjoint,label,relative} from './util.js';

export const controlDir=file=>`${absolute(file)}.control`;
export const emptyDevice=()=>({identities:{},peers:{},defaults:{},retired:{}});
export function editable(cfg) {
  const c=structuredClone(cfg.raw);
  c.device={...emptyDevice(),...c.device}; return c;
}

// One lock per config, independent of project locks/state. A stale preview never
// overwrites another workspace's registration or a concurrent terminal change.
export async function configSession(file,fn,{allowMissing=false}={}) {
  file=absolute(file);await privateDir(path.dirname(file));
  return lock(controlDir(file),async()=>{
    const cfg=await exists(file)?await loadConfig(file):null;
    check(cfg||allowMissing,'Device setup missing: run secure-publish bootstrap in a trusted terminal first');
    async function save(candidate) {
      await validateConfig(candidate,file);
      const current=await exists(file)?await loadConfig(file):null;
      check(current?.revision===cfg?.revision,'Config/trust changed; review again');
      await atomic(file,json(candidate)); return loadConfig(file);
    }
    return fn(cfg,save);
  });
}

export async function assertNewProfile(cfg,name,p) {
  label(name);relative(name);
  check(!Object.hasOwn(cfg.raw.projects,name),'Profile name already exists; choose --profile with a different name');
  check(!Object.hasOwn(cfg.device.retired||{},name),'Profile name is retired; state is retained and names cannot be reused');
  check(!await exists(path.join(cfg.stateDir,name)),'State namespace already exists; never reset/reuse old project state');
  const wanted=JSON.stringify(binding(p));
  for(const other of [...Object.values(cfg.raw.projects),...Object.values(cfg.device.retired||{})]) {
    check(other.role!==p.role||JSON.stringify(binding(other))!==wanted,'Project/channel/relay binding already exists or is retired; choose a distinct project/channel');
  }
  if(p.role==='publisher') {
    for(const other of Object.values(cfg.projects)) if(other.source) disjoint(p.source,other.source);
  } else check(!await exists(p.targetRoot),'Receiver targetRoot must be a new dedicated directory');
}

export function defaultsFor(cfg,role) {
  const d=cfg.device.defaults?.[role];
  check(d,`No ${role} device defaults; run secure-publish bootstrap in a trusted terminal (existing v1 keys can be reused)`);
  return d;
}
export function publisherTemplate(cfg,{identity,peers,channel}={}) {
  const d=defaultsFor(cfg,'publisher'),identityName=identity||d.identity,peerNames=peers||d.peers;
  const i=cfg.device.identities?.[identityName];check(i?.role==='publisher','Unknown publisher identity');
  check(peerNames.length>0,'No receiver peer: run secure-publish peer add in a trusted terminal');
  const recipients=peerNames.map(n=>{const p=cfg.device.peers?.[n];check(p?.role==='receiver',`Unknown receiver peer: ${n}`);return p.recipient;});
  check(new Set(recipients).size===recipients.length,'Duplicate recipient keys');
  return {profile:{role:'publisher',repository:d.repository,branch:d.branch,channel:channel||d.channel,
    signingKey:i.signingKey,verifyKey:i.verifyKey,recipients,minSequence:1,maxAgeDays:30},identityName,peerNames};
}
export function receiverTemplate(cfg) {
  const d=defaultsFor(cfg,'receiver'),i=cfg.device.identities?.[d.identity],p=cfg.device.peers?.[d.peer];
  check(i?.role==='receiver' && p?.role==='publisher','Receiver needs an identity and trusted publisher peer; run bootstrap / peer add');
  return {role:'receiver',repository:d.repository,branch:d.branch,channel:d.channel,
    identity:i.identity,verifyKey:p.verifyKey,minSequence:1,maxAgeDays:30};
}
export function profileView(cfg,name) {
  check(Object.hasOwn(cfg.raw.projects,name),'Unknown configured profile');
  const p=cfg.raw.projects[name];
  return {profile:name,...p,stateDir:path.join(cfg.stateDir,name)};
}
export async function commitCandidate(file,revision,candidate) {
  return configSession(file,async(cfg,save)=>{
    check(cfg.revision===revision,'Config/trust changed; review again');
    for(const [name,p] of Object.entries(candidate.projects)) if(!Object.hasOwn(cfg.raw.projects,name)) await assertNewProfile(cfg,name,p);
    return save(candidate);
  });
}
export const revisionToken=value=>hash(json(value)).slice(0,24);
