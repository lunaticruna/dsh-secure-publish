import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from './config.js';
import {check,hash,json,atomic,read,readJson,exists,lock,unlock,run} from './util.js';
import {snapshot,seal,decrypt,verify} from './artifact.js';
import * as relay from './relay.js';
import * as workspace from './workspace.js';
import {profileView} from './profiles.js';

export const HELP = `Secure Publish 0.2.0 (minisign + age)
DSH / DSHA current workspace (human commands):
  /sp setup                      Show the exact terminal bootstrap command
  /sp init                       Preview a profile bound to this workspace's Git root
  /sp init <token>               Confirm the reviewed profile (15 minutes)
  /sp init --profile app --project app --include src,README.md --exclude src/private
  /sp status                     Current workspace profile
  /sp config                     Show its fixed configuration (no private key contents)
  /sp publish [token]            Prepare / confirm this workspace's publication
Trusted terminal (secure-publish; not slash commands):
  bootstrap                      Device identity, peers and relay defaults; no source path
  init                           Alias for bootstrap (changed from 0.1.0)
  identity show [name]            Share public keys only
  peer add | list | show <name> | default <name> | remove <name>
  profile add                    Register a receiver project interactively
  profile clone <source> <new>    Reuse receiver trust, start independent state
  profile list | show <name> | remove <name>
  config unlock                  Clear a dead configuration lock
Explicit profile commands (CLI; receiver slash commands remain available):
  sp doctor
  sp status <profile>
  sp publish <profile>          Prepare and review a committed snapshot
  sp publish <profile> <token>  Upload exactly the reviewed ciphertext
  sp fetch <profile>            Download, decrypt, verify, stage (no apply)
  sp diff <profile>             Review staged changes and get an apply token
  sp apply <profile> <token>     Apply the reviewed snapshot
  sp rollback <profile>         Review the previous local snapshot
  sp rollback <profile> <token>  Restore it without lowering the trust high-water mark
  sp recover <profile>          Recover an interrupted directory switch
  sp unlock <profile>           Clear only a dead process's lock
Config: ~/.config/dsh-secure-publish/config.json
In CLI examples, replace sp with secure-publish.
Commands are human-only; do not send keys/passwords to chat.`;

async function stateFor(p) {
  const file=path.join(p.stateDir,'state.json');
  if(!await exists(file)) return {format:1,binding:p.binding,nextSequence:p.minSequence,highwater:0,acceptedCipher:null,acceptedEnvelope:null,previous:null};
  const s=await readJson(file);
  check(s.format===1 && JSON.stringify(s.binding)===JSON.stringify(p.binding),'State belongs to another project/channel');
  check(Number.isSafeInteger(s.nextSequence)&&s.nextSequence>=1&&Number.isSafeInteger(s.highwater)&&s.highwater>=0,'Invalid state counters');
  return s;
}
function role(p,wanted) {check(p.role===wanted,`This action requires a ${wanted} profile`);}
export async function execute(configPath,action='help',args=[],options={}) {
  const {signal,interactive=false,transport=relay}=options;
  if(action==='help') return HELP;
  const cfg=await loadConfig(configPath);
  if(action==='doctor') {
    check(args.length===0,'doctor takes no arguments');
    const binaries={};
    for(const [name,bin] of Object.entries(cfg.binaries)) {
      try {await run(bin,[name==='minisign'?'-v':'--version'],{signal,limit:16384});binaries[name]='available';}
      catch(e) {binaries[name]=e.message;}
    }
    return {version:'0.2.0',node:process.version,binaries,profiles:Object.keys(cfg.projects),deviceRoles:Object.keys(cfg.device.defaults||{}),platform:process.platform,
      note:process.platform==='win32'?'Protect config, state and keys with Windows ACLs; mode checks cannot enforce Windows ACLs.':'Config/key permissions checked.'};
  }
  check(['status','config','publish','fetch','diff','apply','rollback','recover','unlock'].includes(action),'Unknown action');
  check(args.length>=1 && args.length<=2,'Expected profile and optional confirmation token');
  check(['publish','apply','rollback'].includes(action)||args.length===1,'Unexpected argument');
  const [name,token]=args, p=cfg.projects[name]; check(p,'Unknown configured profile');
  check(options.expectedConfigHash===undefined||options.expectedConfigHash===p.configHash,'Workspace profile changed; retry from the current workspace');
  if(action==='config')return profileView(cfg,name);
  if(token!==undefined) check(/^[a-f0-9]{24}$/.test(token),'Invalid confirmation token');
  if(action==='unlock') return unlock(p.stateDir);
  return lock(p.stateDir,async()=>{
    const current=await loadConfig(configPath);
    check(current.projects[name]?.configHash===p.configHash,'Profile changed or was removed; retry from the current configuration');
    const state=await stateFor(p), save=s=>atomic(path.join(p.stateDir,'state.json'),json(s));
    if(action==='status') return {profile:name,role:p.role,binding:p.binding,nextSequence:state.nextSequence,highwater:state.highwater,
      previous:state.previous,pending:await exists(path.join(p.stateDir,'pending.json')),
      ...(p.targetRoot?{current:path.join(p.targetRoot,'current'),recoveryRequired:await exists(path.join(p.targetRoot,'transaction.json'))}:{})};
    if(action==='publish') {
      role(p,'publisher');
      const metaPath=path.join(p.stateDir,'pending.json'), packetPath=path.join(p.stateDir,'pending.age');
      if(!token) {
        const snap=await snapshot(p,signal), sequence=Math.max(state.nextSequence,p.minSequence);
        check(Number.isSafeInteger(sequence+1) && sequence<=999999999999,'Sequence exhausted');
        state.nextSequence=sequence+1; await save(state); // reserve even if signing/upload later fails
        const sealed=await seal(p,snap,sequence,{signal,interactive});
        const meta={configHash:p.configHash,sequence,sourceCommit:snap.commit,files:snap.files.map(f=>({path:f.path,size:f.size})),
          ciphertextSha256:hash(sealed.cipher),createdAt:Date.now(),repository:p.repository,branch:p.branch,recipients:[...p.recipients]};
        meta.token=hash(json(meta)).slice(0,24);
        await atomic(packetPath,sealed.cipher); await atomic(metaPath,json(meta));
        return {...meta,confirm:`publish ${name} ${meta.token}`,note:'Only ciphertext will be uploaded; review included paths, recipients and repository. Confirmation expires after 15 minutes.'};
      }
      const meta=await readJson(metaPath,4*1024*1024);
      check(meta.token===token && meta.configHash===p.configHash,'Confirmation/config mismatch; prepare again');
      const {token:storedToken,...reviewed}=meta;
      check(hash(json(reviewed)).slice(0,24)===storedToken,'Prepared review record changed');
      check(Date.now()>=meta.createdAt && Date.now()-meta.createdAt<=900000,'Publish confirmation expired; prepare again');
      const cipher=await read(packetPath); check(hash(cipher)===meta.ciphertextSha256,'Prepared ciphertext changed');
      const result=await transport.upload(p,cipher,meta.sequence,signal);
      // A failed/ambiguous push keeps the exact pending packet so the same token can be retried idempotently.
      await fs.rm(metaPath); await fs.rm(packetPath);
      return {published:meta.sequence,...result};
    }
    role(p,'receiver');
    if(action==='fetch') {
      await workspace.healthy(p);
      const {cipher,relayCommit}=await transport.download(p,signal), cipherHash=hash(cipher);
      const envelope=await decrypt(p,cipher,signal), v=await verify(p,envelope,{signal,freshness:true});
      check(v.manifest.sequence>state.highwater || (v.manifest.sequence===state.highwater && state.acceptedCipher===cipherHash),
        'Replay/rollback/equivocation rejected: sequence is older, or the same sequence has different ciphertext');
      state.highwater=v.manifest.sequence; state.acceptedCipher=cipherHash; state.acceptedEnvelope=v.digest;
      await save(state); // fail-closed if staging is interrupted; identical retry remains allowed
      await workspace.stage(p,v);
      return {staged:v.manifest.sequence,sourceCommit:v.manifest.sourceCommit,files:v.manifest.files.length,relayCommit,next:`diff ${name}`};
    }
    if(action==='recover') return workspace.recover(p,state,save,signal);
    const which=action==='rollback'?'rollback':'apply';
    const review=await workspace.review(p,state,which,signal);
    if(action==='diff') return {...workspace.summary(review),diff:await workspace.diff(p,review,signal)};
    if(action==='rollback'&&!token) return workspace.summary(review);
    check(token===review.token,'Confirmation does not match the current diff; run diff/rollback again');
    return workspace.switchVersion(p,state,review,save,signal);
  });
}
