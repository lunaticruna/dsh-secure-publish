import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import {spawn} from 'node:child_process';
import {defaultConfig,loadConfig} from './config.js';
import {check,privateDir,exists,atomic,json,label,relative,run} from './util.js';

export async function setup(file=defaultConfig()) {
  check(process.stdin.isTTY,'init needs an interactive trusted terminal');
  file=path.resolve(file);
  check(!await exists(file),'Config already exists; use examples to add a profile without replacing it');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  const ask=async(q,fallback='')=>(await rl.question(`${q}${fallback?` [${fallback}]`:''}: `)).trim()||fallback;
  try {
    const role=await ask('角色 publisher / receiver','receiver');check(['publisher','receiver'].includes(role),'Invalid role');
    const name=label(await ask('本机配置简称','demo'));
    const project=label(await ask('共享项目标识（两端必须一致）',name));
    const channel=label(await ask('通道（两端必须一致）','main'));
    const repository=await ask('专用中继 GitHub owner/repo（不是插件仓库）');
    check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),'Invalid repository');
    const branch=await ask('密文分支','secure-relay');
    const stateDir=path.join(os.homedir(),'.local','state','dsh-secure-publish');
    const dir=path.dirname(file),keyDir=path.join(dir,'keys');await privateDir(dir);await privateDir(keyDir);
    const p={role,project,channel,repository,branch,minSequence:1,maxAgeDays:30};
    if(role==='publisher') {
      p.source=path.resolve(await ask('已提交源码仓库的绝对路径'));
      p.include=(await ask('明确包含的路径，逗号分隔（如 src,README.md,package.json）')).split(',').map(s=>relative(s.trim()));
      p.exclude=[];
      p.recipients=(await ask('目标机 age1 公钥，逗号分隔')).split(',').map(s=>s.trim());
      p.signingKey=path.join(keyDir,`${name}.minisign.key`);p.verifyKey=path.join(keyDir,`${name}.minisign.pub`);
      check(!await exists(p.signingKey)&&!await exists(p.verifyKey),'Key files already exist');
      console.log('下面由 minisign 自己询问密钥口令；口令不会写进配置。加密签名私钥的发布请在终端执行。');
      await new Promise((resolve,reject)=>{const child=spawn('minisign',['-G','-s',p.signingKey,'-p',p.verifyKey],{stdio:'inherit',shell:false});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('minisign key generation failed')));});
      await fs.chmod(p.signingKey,0o600);
      console.log(`把 ${p.verifyKey} 的公钥通过可信方式发给目标机。不要发送 .key 私钥。`);
    } else {
      p.targetRoot=path.resolve(await ask('新的专用接收目录',path.join(os.homedir(),'SecureWorkspaces',name)));
      p.identity=path.join(keyDir,`${name}.agekey`);p.verifyKey=path.join(keyDir,`${name}.minisign.pub`);
      check(!await exists(p.identity)&&!await exists(p.verifyKey),'Key files already exist');
      await run('age-keygen',['-o',p.identity],{limit:16384});await fs.chmod(p.identity,0o600);
      const pub=(await run('age-keygen',['-y',p.identity],{limit:1024})).stdout.toString().trim();
      console.log(`本机 age 公钥（给发布端）：${pub}`);
      const signer=await ask('粘贴可信发布者 minisign 公钥的 Base64 行（RW…，通过带外方式核对）');
      check(/^RW[A-Za-z0-9+/]{54}$/.test(signer),'Invalid minisign public key');
      await atomic(p.verifyKey,Buffer.from(`untrusted comment: pinned publisher public key\n${signer}\n`));
    }
    const candidate=file+'.new';await atomic(candidate,json({version:1,stateDir,projects:{[name]:p}}));
    try {await loadConfig(candidate);await fs.rename(candidate,file);} catch(e) {await fs.rm(candidate,{force:true});throw e;}
    console.log(`配置已创建：${file}\n下一步：secure-publish doctor`);
  } finally {rl.close();}
}
