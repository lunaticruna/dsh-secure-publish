import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {run,hash} from '../lib/util.js';
import {execute} from '../lib/engine.js';

export const haveCrypto=['age','age-keygen','minisign','git'].every(bin=>spawnSync(bin,[bin==='minisign'?'-v':'--version']).status===0);
export const cryptoOptions=haveCrypto?{}:{skip:'Install real age and minisign for integration tests (CI requires them).'};
export async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'secure-publish-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source');await fs.mkdir(source,{mode:0o700});
  const g=async(...args)=>run('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:source});
  await g('init');await g('config','user.name','Test');await g('config','user.email','test@localhost');
  await fs.mkdir(path.join(source,'src'));await fs.writeFile(path.join(source,'src','hello.txt'),'hello version one\n');
  await g('add','.');await g('commit','-m','fixture');
  const identity=path.join(dir,'identity.agekey'),signingKey=path.join(dir,'signing.key'),verifyKey=path.join(dir,'signing.pub');
  await run('age-keygen',['-o',identity]);await fs.chmod(identity,0o600);
  const recipient=(await run('age-keygen',['-y',identity])).stdout.toString().trim();
  await run('minisign',['-G','-W','-s',signingKey,'-p',verifyKey]);await fs.chmod(signingKey,0o600);
  const common={project:'demo',channel:'main',repository:'test/relay',branch:'secure-relay',verifyKey,minSequence:1,maxAgeDays:30};
  const config={version:1,stateDir:path.join(dir,'state'),projects:{
    pub:{...common,role:'publisher',source,include:['src'],exclude:[],recipients:[recipient],signingKey},
    rx:{...common,role:'receiver',identity,targetRoot:path.join(dir,'workspace')}
  }};
  const configFile=path.join(dir,'config.json');
  const saveConfig=()=>fs.writeFile(configFile,JSON.stringify(config),{mode:0o600});await saveConfig();
  let packet;const versions=new Map();
  const transport={
    async upload(_p,cipher,seq) {if(versions.has(seq)&&hash(versions.get(seq))!==hash(cipher)) throw new Error('Conflict');versions.set(seq,Buffer.from(cipher));packet=Buffer.from(cipher);return {relayCommit:'a'.repeat(40)};},
    async download() {if(!packet) throw new Error('No packet');return {cipher:Buffer.from(packet),relayCommit:'a'.repeat(40)};}
  };
  const call=(cmd,...args)=>execute(configFile,cmd,args,{transport});
  const publish=async()=>{const preview=await call('publish','pub');await call('publish','pub',preview.token);return preview;};
  const apply=async()=>{const preview=await call('diff','rx');await call('apply','rx',preview.confirm);return preview;};
  const commit=async(text)=>{await fs.writeFile(path.join(source,'src','hello.txt'),text);await g('add','.');await g('commit','-m','update');};
  return {dir,source,g,identity,recipient,signingKey,verifyKey,config,configFile,saveConfig,call,publish,apply,commit,versions,transport,
    setPacket(b){packet=b;},getPacket(){return packet;},current:path.join(config.projects.rx.targetRoot,'current')};
}
