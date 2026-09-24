import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import {spawn} from 'node:child_process';
import {defaultConfig,loadConfig,validateConfig,absolute,recipient,publicKeyLine,binding} from './config.js';
import {check,privateDir,exists,atomic,json,label,run,read,id,lock,unlock} from './util.js';
import {configSession,controlDir,editable,emptyDevice,assertNewProfile,receiverTemplate,profileView,commitCandidate} from './profiles.js';

async function terminal(fn,io={}) {
  io.signal?.throwIfAborted();
  if(io.ask) return fn({log:()=>{},external:fn=>fn(),...io}); // test dependency injection; never exposed by slash commands
  check(process.stdin.isTTY,'This operation needs an interactive trusted terminal');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  try {return await fn({
    signal:io.signal,
    ask:async(q,fallback='')=>(await rl.question(`${q}${fallback?` [${fallback}]`:''}: `,{signal:io.signal})).trim()||fallback,
    log:console.log,
    external:async fn=>{
      const wasRaw=process.stdin.isRaw;rl.pause();process.stdin.setRawMode?.(false);
      try{return await fn();}finally{process.stdin.setRawMode?.(!!wasRaw);rl.resume();}
    }
  });}finally{rl.close();}
}
const yes=async(io,q)=>(await io.ask(q,'no')).toLowerCase()==='yes';
function keygen(cfg) {const age=cfg?.binaries.age;return age&&path.isAbsolute(age)?path.join(path.dirname(age),process.platform==='win32'?'age-keygen.exe':'age-keygen'):'age-keygen';}
async function generateSigner(bin,privateKey,publicKey,io) {
  io.log('minisign 将在终端询问口令；口令不进入配置或聊天。');
  await io.external(()=>new Promise((resolve,reject)=>{
    const child=spawn(bin,['-G','-s',privateKey,'-p',publicKey],{stdio:'inherit',shell:false,signal:io.signal});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('minisign key generation failed')));
  }));
  await fs.chmod(privateKey,0o600);
}
async function storePeer(c,name,role,key,keyDir,cfg) {
  label(name);check(!Object.hasOwn(c.device.peers,name),'Peer name already exists; existing trust is never silently replaced');
  if(role==='receiver') {
    recipient(key);
    // Ask the official age implementation to validate the full encoding/checksum.
    await run(cfg?.binaries.age||'age',['--encrypt','-r',key],{input:Buffer.alloc(0),limit:8192});
    c.device.peers[name]={role,recipient:key};
  }
  else {
    publicKeyLine(Buffer.from(key));await privateDir(keyDir);
    const verifyKey=path.join(keyDir,`peer-${name}-${id()}.minisign.pub`);
    await atomic(verifyKey,Buffer.from(`untrusted comment: pinned publisher public key\n${key}\n`));
    c.device.peers[name]={role,verifyKey};
  }
}

// Device setup knows no source/target/project path. Legacy profiles supply only
// reusable identity/trust/defaults; their bindings and state are never changed.
export async function bootstrap(file=defaultConfig(),io={}) {
  return terminal(async ui=>configSession(file,async(cfg,save)=>{
    const role=await ui.ask('本机角色 publisher / receiver','publisher');check(['publisher','receiver'].includes(role),'Invalid role');
    const c=cfg?editable(cfg):{version:1,stateDir:path.resolve(file)===defaultConfig()?path.join(os.homedir(),'.local','state','dsh-secure-publish'):path.join(path.dirname(absolute(file)),'state'),projects:{},device:emptyDevice()};
    if(c.device.defaults[role]) return {alreadyBootstrapped:true,role,defaults:c.device.defaults[role],next:role==='publisher'?'/sp init in each DSH workspace':'secure-publish profile add'};
    const legacy=Object.entries(c.projects).filter(([,p])=>p.role===role);
    let reused;
    if(legacy.length) {
      const selected=await ui.ask(`复用已有 profile 的身份和信任（${legacy.map(([n])=>n).join(', ')}；new 表示新建设备身份）`,legacy[0][0]);
      if(Object.hasOwn(c.projects,selected)&&c.projects[selected].role===role) reused=c.projects[selected];
      else check(selected==='new','Unknown legacy profile');
    }
    const identityName=label(await ui.ask('设备身份名称',`${role}-main`));
    let identity=c.device.identities[identityName];
    const keyDir=path.join(path.dirname(absolute(file)),'keys');
    if(identity) check(identity.role===role,'Identity name already has a different role');
    else if(reused) identity=role==='publisher'?{role,signingKey:reused.signingKey,verifyKey:reused.verifyKey}:{role,identity:reused.identity};
    else {
      const mode=await ui.ask('密钥 generate / existing','generate');check(['generate','existing'].includes(mode),'Invalid key mode');
      await privateDir(keyDir);
      if(role==='publisher') {
        identity={role,signingKey:mode==='existing'?absolute(await ui.ask('已有 minisign 私钥绝对路径')):path.join(keyDir,`${identityName}.minisign.key`),
          verifyKey:mode==='existing'?absolute(await ui.ask('对应 minisign 公钥绝对路径')):path.join(keyDir,`${identityName}.minisign.pub`)};
        if(mode==='generate') {
          check(!await exists(identity.signingKey)&&!await exists(identity.verifyKey),'Key files already exist; use existing mode to import them');
          await generateSigner(cfg?.binaries.minisign||'minisign',identity.signingKey,identity.verifyKey,ui);
        }
      } else {
        identity={role,identity:mode==='existing'?absolute(await ui.ask('已有 age 私钥绝对路径')):path.join(keyDir,`${identityName}.agekey`)};
        if(mode==='generate') {
          check(!await exists(identity.identity),'Key file already exists; use existing mode to import it');
          await run(keygen(cfg),['-o',identity.identity],{limit:16384});await fs.chmod(identity.identity,0o600);
        }
      }
    }
    c.device.identities[identityName]=identity;
    const publicKey=role==='publisher'?publicKeyLine(await read(identity.verifyKey,8192)):(await run(keygen(cfg),['-y',identity.identity],{limit:8192})).stdout.toString().trim();
    ui.log(`本机可分享的公钥（请通过可信渠道核对）：\n${publicKey}`);
    const d={identity:identityName,repository:await ui.ask('默认密文中继 owner/repo（不是插件仓库）',reused?.repository||''),
      branch:await ui.ask('默认密文分支',reused?.branch||'secure-relay'),channel:await ui.ask('默认通道',reused?.channel||'main')};
    if(role==='publisher') {
      d.peers=[];
      const keys=reused?.recipients||[(await ui.ask('Windows 接收机 age 公钥（可留空，稍后 peer add）'))].filter(Boolean);
      for(let index=0;index<keys.length;index++) {
        const name=label(await ui.ask('Receiver peer 名称',index===0?'windows-main':`receiver-${index+1}`));
        const existing=c.device.peers[name];
        if(existing) check(existing.role==='receiver'&&existing.recipient===keys[index],'Existing peer trust differs');
        else await storePeer(c,name,'receiver',keys[index],keyDir,cfg);
        d.peers.push(name);
      }
    } else {
      const key=reused?publicKeyLine(await read(reused.verifyKey,8192)):await ui.ask('可信发布者 minisign 公钥 RW…（可留空，稍后 peer add）');
      if(key) {
        const name=label(await ui.ask('Publisher peer 名称','dsha-main'));
        const existing=c.device.peers[name];
        if(existing) check(existing.role==='publisher'&&publicKeyLine(await read(existing.verifyKey,8192))===key,'Existing peer trust differs');
        else if(reused) c.device.peers[name]={role:'publisher',verifyKey:reused.verifyKey};
        else await storePeer(c,name,'publisher',key,keyDir,cfg);
        d.peer=name;
      }
    }
    c.device.defaults[role]=d;await validateConfig(c,file);
    ui.log(JSON.stringify({role,identity:identityName,publicKey,defaults:d,preservedProfiles:Object.keys(c.projects)},null,2));
    if(!await yes(ui,'确认保存设备配置？输入 yes')) return {cancelled:true,note:'Generated keys are retained; existing mode can reuse them.'};
    ui.signal?.throwIfAborted();await save(c);
    return {bootstrapped:role,identity:identityName,publicKey,config:absolute(file),next:role==='publisher'?'/sp init in the current DSH workspace':'secure-publish profile add',
      note:'Existing profiles, keys and sequence/high-water state were preserved. If no peer was supplied, use peer add first.'};
  },{allowMissing:true}),io);
}

export async function manage(file,action,args=[],io={}) {
  if(action==='bootstrap'||action==='init') {check(args.length===0,'bootstrap takes no arguments');return bootstrap(file,io);}
  if(action==='config'&&args[0]==='unlock') {check(args.length===1,'config unlock takes no further arguments');return unlock(controlDir(file));}
  const cfg=await loadConfig(file),[verb,name,other]=args;
  if(action==='identity') {
    check(verb==='show'&&args.length<=2,'Use identity show [name]');
    const list=name?{[name]:cfg.device.identities?.[name]}:cfg.device.identities;
    const out={};for(const [n,i] of Object.entries(list||{})) {
      check(i,'Unknown device identity');out[n]={role:i.role,publicKey:i.role==='publisher'?publicKeyLine(await read(i.verifyKey,8192)):(await run(keygen(cfg),['-y',i.identity],{limit:8192})).stdout.toString().trim()};
    } return out;
  }
  if(action==='profile') {
    if(verb==='list') {check(args.length===1,'profile list takes no arguments');return Object.keys(cfg.projects).map(n=>profileView(cfg,n));}
    if(verb==='show') {check(args.length===2,'Use profile show <name>');return profileView(cfg,name);}
    check(['add','clone','remove'].includes(verb),'Use profile add | clone <source> <new> | list | show <name> | remove <name>');
    check((verb==='add'&&args.length===1)||(verb==='clone'&&args.length===3)||(verb==='remove'&&args.length===2),'Invalid profile command arguments');
    return terminal(async ui=>{
      const c=editable(cfg);
      if(verb==='remove') {
        const p=profileView(cfg,name);ui.log(JSON.stringify(p,null,2));
        check(await ui.ask('只移除注册，保留密钥、源码和状态；旧名称及绑定不可通过 add 重用。输入 profile 名确认')===name,'Removal cancelled');
        return lock(path.join(cfg.stateDir,name),()=>configSession(file,async(current,save)=>{
          check(current.revision===cfg.revision,'Config/trust changed; review again');
          delete c.projects[name];c.device.retired[name]={role:p.role,...binding(p)};
          ui.signal?.throwIfAborted();await save(c);return {removed:name,stateRetained:true,nameAndBindingReserved:true};
        }));
      }
      const newName=label(verb==='clone'?other:await ui.ask('本机 profile 简称','project-a'));
      let p;
      if(verb==='clone') {check(cfg.raw.projects[name]?.role==='receiver','CLI clone supports receiver profiles; create publishers from their DSH workspace');p=structuredClone(cfg.raw.projects[name]);}
      else p=receiverTemplate(cfg);
      p.project=label(await ui.ask('共享项目标识（与 Publisher 一致）',newName));
      p.channel=label(await ui.ask('通道（与 Publisher 一致）',p.channel));
      p.repository=await ui.ask('中继 owner/repo',p.repository);p.branch=await ui.ask('密文分支',p.branch);
      p.targetRoot=absolute(await ui.ask('新的专用接收目录（绝对路径）',path.join(os.homedir(),'SecureWorkspaces',newName)));
      p.minSequence=Number(await ui.ask('首次信任序号下限（从 Publisher 可信渠道获得）','1'));
      p.maxAgeDays=Number(await ui.ask('制品有效天数',String(p.maxAgeDays)));
      await assertNewProfile(cfg,newName,p);c.projects[newName]=p;await validateConfig(c,file);
      ui.log(JSON.stringify({profile:newName,...p,stateDir:path.join(cfg.stateDir,newName)},null,2));
      if(!await yes(ui,'确认注册？输入 yes'))return {cancelled:true};
      ui.signal?.throwIfAborted();await commitCandidate(file,cfg.revision,c);
      return {created:newName,stateCopied:false,next:`secure-publish fetch ${newName}`};
    },io);
  }
  if(action==='peer') {
    if(verb==='list') {check(args.length===1,'peer list takes no arguments');return cfg.device.peers||{};}
    if(verb==='show') {check(args.length===2&&Object.hasOwn(cfg.device.peers||{},name),'Use peer show <known-peer>');const p=cfg.device.peers[name];return {name,...p,...(p.verifyKey?{publicKey:publicKeyLine(await read(p.verifyKey,8192))}:{})};}
    check((verb==='add'&&args.length===1)||(['remove','default'].includes(verb)&&args.length===2),'Use peer add | list | show <name> | default <name> | remove <name>');
    return terminal(async ui=>{
      const c=editable(cfg);let peerName=name;
      if(verb==='add') {
        peerName=label(await ui.ask('Peer 名称','windows-main'));
        const role=await ui.ask('Peer 角色 receiver / publisher','receiver');check(['receiver','publisher'].includes(role),'Invalid peer role');
        const key=await ui.ask(role==='receiver'?'通过可信渠道核对的 age1 公钥':'通过可信渠道核对的 minisign RW 公钥');
        await storePeer(c,peerName,role,key,path.join(path.dirname(absolute(file)),'keys'),cfg);
      }
      const peer=c.device.peers[peerName];check(peer,'Unknown peer');
      const localRole=peer.role==='receiver'?'publisher':'receiver',d=c.device.defaults[localRole];
      if(verb==='remove') {
        for(const p of Object.values(c.projects)) check(peer.role==='receiver'?!p.recipients?.includes(peer.recipient):p.verifyKey!==peer.verifyKey,'Peer is pinned by an existing profile; removing trust cannot silently rewrite that profile');
        if(d) {if(localRole==='publisher')d.peers=d.peers.filter(n=>n!==peerName);else if(d.peer===peerName)delete d.peer;}
        delete c.device.peers[peerName];
      } else if(verb==='default'||(d&&(localRole==='publisher'?d.peers.length===0:!d.peer))) {
        check(d,'Run bootstrap for this device role first');
        if(localRole==='publisher')d.peers=[peerName];else d.peer=peerName;
      }
      await validateConfig(c,file);ui.log(JSON.stringify({operation:verb,peer:peerName,value:peer,defaults:c.device.defaults,note:'Defaults affect new profiles only; existing bindings retain their pinned trust.'},null,2));
      if(!await yes(ui,'确认保存？输入 yes'))return {cancelled:true};
      ui.signal?.throwIfAborted();await commitCandidate(file,cfg.revision,c);return {operation:verb,peer:peerName};
    },io);
  }
  throw new Error('Unknown management action');
}

export const setup=bootstrap;
