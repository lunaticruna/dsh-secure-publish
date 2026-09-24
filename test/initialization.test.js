import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,cryptoOptions} from './helpers.js';
import {bootstrap,manage} from '../lib/setup.js';
import {loadConfig,validateConfig,publicKeyLine} from '../lib/config.js';
import {handleWorkspaceCommand,setupHint} from '../lib/plugin.js';
import {initWorkspace,workspaceArgs,commandWords} from '../lib/workspace-init.js';
import {execute} from '../lib/engine.js';
import {controlDir,emptyDevice,commitCandidate,revisionToken} from '../lib/profiles.js';
import {atomic,json,hash,run,exists} from '../lib/util.js';

function answers(overrides={},questions=[]) {
  return {ask:async(q,fallback='')=>{
    questions.push(q);for(const [prefix,value] of Object.entries(overrides)) if(q.startsWith(prefix))return typeof value==='function'?value(q,fallback):value;
    if(q.startsWith('确认'))return 'yes';return fallback;
  }};
}
async function device(f) {
  f.config.device={...emptyDevice(),identities:{publisher:{role:'publisher',signingKey:f.signingKey,verifyKey:f.verifyKey},receiver:{role:'receiver',identity:f.identity}},
    peers:{windows:{role:'receiver',recipient:f.recipient},dsha:{role:'publisher',verifyKey:f.verifyKey}},
    defaults:{publisher:{identity:'publisher',peers:['windows'],repository:'test/relay',branch:'secure-relay',channel:'main'},receiver:{identity:'receiver',peer:'dsha',repository:'test/relay',branch:'secure-relay',channel:'main'}}};
  await f.saveConfig();
}
async function repo(f,name) {
  const root=path.join(f.dir,name);await fs.mkdir(path.join(root,'src'),{recursive:true});
  await fs.writeFile(path.join(root,'src','hello.js'),'export const answer=42;\n');await fs.writeFile(path.join(root,'README.md'),'example\n');
  const g=(...args)=>run('git',args,{cwd:root,limit:1024*1024});
  await g('init');await g('config','user.name','Fixture');await g('config','user.email','fixture@localhost');await g('add','.');await g('commit','-m','fixture');
  return {root,g};
}
async function register(f,root,args=[]) {const preview=await initWorkspace(f.configFile,root,args);await initWorkspace(f.configFile,root,[preview.token]);return preview;}
const slash=(f,root,rawInput)=>handleWorkspaceCommand(f.configFile,{rawInput,signal:new AbortController().signal,agent:{session:{header:{cwd:root}}}});
async function success(f,root,command) {const r=await slash(f,root,command);assert.equal(r.kind,'success',r.text);return JSON.parse(r.text);}

test('legacy bootstrap reuses identity and trust without asking for a workspace or changing state',cryptoOptions,async t=>{
  const f=await fixture(t);const prepared=await f.call('publish','pub');
  const original=JSON.stringify(f.config.projects),key=await fs.readFile(f.signingKey),state=await fs.readFile(path.join(f.config.stateDir,'pub/state.json'));
  const questions=[];const r=await bootstrap(f.configFile,answers({'本机角色':'publisher'},questions));
  assert.equal(r.bootstrapped,'publisher');assert(!questions.some(q=>/source|targetRoot|源码.*路径|接收目录|共享项目/.test(q)));
  const cfg=await loadConfig(f.configFile);assert.equal(JSON.stringify(cfg.raw.projects),original);
  assert.deepEqual(await fs.readFile(f.signingKey),key);assert.deepEqual(await fs.readFile(path.join(f.config.stateDir,'pub/state.json')),state);
  assert.equal(cfg.device.identities['publisher-main'].signingKey,f.signingKey);
  assert.equal(cfg.device.peers['windows-main'].recipient,f.recipient);
  await f.call('publish','pub',prepared.token); // additive metadata must not invalidate legacy project state
});

test('fresh receiver bootstrap can exchange keys later and register without editing JSON',cryptoOptions,async t=>{
  const f=await fixture(t),file=path.join(f.dir,'receiver-device','config.json');
  const r=await bootstrap(file,answers({'本机角色':'receiver','默认密文中继':'test/relay'}));
  assert.match(r.publicKey,/^age1/);let cfg=await loadConfig(file);
  assert.deepEqual(Object.keys(cfg.projects),[]);assert.equal(cfg.device.defaults.receiver.peer,undefined);
  const publicKey=publicKeyLine(await fs.readFile(f.verifyKey));
  await manage(file,'peer',['add'],answers({'Peer 名称':'dsha','Peer 角色':'publisher','通过可信渠道':publicKey}));
  const target=path.join(f.dir,'new receiver target');
  await manage(file,'profile',['add'],answers({'本机 profile':'one','新的专用接收目录':target}));
  cfg=await loadConfig(file);assert.equal(cfg.projects.one.targetRoot,target);assert.equal(cfg.device.defaults.receiver.peer,'dsha');
  const info=JSON.stringify(await manage(file,'identity',['show']));assert(info.includes(r.publicKey));assert(!info.includes('AGE-SECRET-KEY'));
});

test('workspace init obtains invocation agent cwd, previews without config writes and binds the Git root',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const {root}=await repo(f,'project-a');const before=await fs.readFile(f.configFile);
  const p=await success(f,path.join(root,'src'),'init');assert.equal(p.gitRoot,root);assert.equal(p.workspace,path.join(root,'src'));
  assert.deepEqual(await fs.readFile(f.configFile),before);assert.deepEqual(p.include,['README.md','src']);
  await success(f,path.join(root,'src'),`init ${p.token}`);
  const cfg=await loadConfig(f.configFile);assert.equal(cfg.projects['project-a'].source,root);
  assert.equal(cfg.projects['project-a'].signingKey,f.signingKey);assert.deepEqual(cfg.projects['project-a'].recipients,[f.recipient]);
  assert.equal((await success(f,root,'config')).project,'project-a');assert.equal((await success(f,root,'init')).alreadyInitialized,true);
});

test('five workspaces reuse device defaults but keep independent profiles and publication counters',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const roots=[];
  for(let i=1;i<=5;i++) {const {root}=await repo(f,`app-${i}`);roots.push(root);await register(f,root);}
  const first=await success(f,roots[0],'publish');assert.match(first.confirm,/^\/sp publish [a-f0-9]{24}$/);
  assert.equal((await success(f,roots[0],'status')).nextSequence,2);
  for(let i=1;i<5;i++) {const s=await success(f,roots[i],'status');assert.equal(s.profile,`app-${i+1}`);assert.equal(s.nextSequence,1);}
  const mismatch=await slash(f,roots[0],'publish app-2');assert.equal(mismatch.kind,'error');assert.match(mismatch.text,/different workspace/);
  const cfg=await loadConfig(f.configFile);assert.equal(new Set(roots.map((_,i)=>cfg.projects[`app-${i+1}`].stateDir)).size,5);
});

test('missing, relative, non-Git and symlink workspaces never fall back to server cwd',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const before=await fs.readFile(f.configFile);
  for(const cwd of [undefined,'relative',f.dir]) {const r=await slash(f,cwd,'init');assert.equal(r.kind,'error');}
  if(process.platform!=='win32') {const link=path.join(f.dir,'alias');await fs.symlink(f.source,link);assert.equal((await slash(f,link,'init')).kind,'error');}
  assert.deepEqual(await fs.readFile(f.configFile),before);
});

test('chat cannot select an arbitrary source, target, relay or configuration path',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const {root}=await repo(f,'flags');const before=await fs.readFile(f.configFile);
  for(const flag of ['--source','--targetRoot','--repository','--branch','--config']) await assert.rejects(initWorkspace(f.configFile,root,[flag,'anything']),/Unsupported init option/);
  assert.deepEqual(await fs.readFile(f.configFile),before);
});

test('confirmation is scoped to exact cwd and invalidated by config or pinned key changes',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const {root}=await repo(f,'review');
  let p=await initWorkspace(f.configFile,root);await assert.rejects(initWorkspace(f.configFile,path.join(root,'src'),[p.token]),/No init preview/);
  f.config.device.defaults.publisher.channel='changed';await f.saveConfig();
  await assert.rejects(initWorkspace(f.configFile,root,[p.token]),/Config\/trust changed/);
  p=await initWorkspace(f.configFile,root);await fs.appendFile(f.signingKey,'\n');
  await assert.rejects(initWorkspace(f.configFile,root,[p.token]),/Config\/trust changed/);
  assert(!Object.hasOwn((await loadConfig(f.configFile)).projects,'review'));
});

test('Git index changes, expired and modified previews are rejected before writing config',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const {root,g}=await repo(f,'stale');const before=await fs.readFile(f.configFile);
  let p=await initWorkspace(f.configFile,root);await fs.writeFile(path.join(root,'src/new.js'),'new');await g('add','.');
  await assert.rejects(initWorkspace(f.configFile,root,[p.token]),/Workspace\/Git index changed/);
  p=await initWorkspace(f.configFile,root);const pending=path.join(controlDir(f.configFile),`workspace-${hash(root)}.json`);
  let record=JSON.parse(await fs.readFile(pending,'utf8'));record.candidate.projects.stale.channel='tampered';await atomic(pending,json(record));
  await assert.rejects(initWorkspace(f.configFile,root,[p.token]),/confirmation record changed/);
  await initWorkspace(f.configFile,root);record=JSON.parse(await fs.readFile(pending,'utf8'));delete record.token;record.createdAt-=900001;record.token=revisionToken(record);await atomic(pending,json(record));
  await assert.rejects(initWorkspace(f.configFile,root,[record.token]),/expired/);assert.deepEqual(await fs.readFile(f.configFile),before);
});

test('another workspace registration invalidates old previews instead of losing its changes',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const a=await repo(f,'a'),b=await repo(f,'b');
  const pa=await initWorkspace(f.configFile,a.root),pb=await initWorkspace(f.configFile,b.root);
  await initWorkspace(f.configFile,a.root,[pa.token]);await assert.rejects(initWorkspace(f.configFile,b.root,[pb.token]),/Config\/trust changed/);
  await register(f,b.root);const cfg=await loadConfig(f.configFile);assert(cfg.projects.a);assert(cfg.projects.b);
});

test('includes stay explicit; secrets are omitted from suggestions and require exclusion if selected',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const {root,g}=await repo(f,'includes');
  await fs.writeFile(path.join(root,'src/.env'),'TOKEN=fixture');await g('add','.');await g('commit','-m','fixture paths');
  let p=await initWorkspace(f.configFile,root);assert.deepEqual(p.include,['README.md']);assert.equal(p.omittedFromSelection,2);
  await assert.rejects(initWorkspace(f.configFile,root,['--include','src']),/Unsafe tracked file/);
  await assert.rejects(initWorkspace(f.configFile,root,['--include','.']),/Unsafe portable path/);
  p=await register(f,root,['--include','src,README.md','--exclude','src/.env']);assert.equal(p.selectedFileCount,2);
  assert.deepEqual((await loadConfig(f.configFile)).projects.includes.exclude,['src/.env']);
});

test('duplicate names, duplicate bindings and key/source conflicts fail without replacing config',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const {root}=await repo(f,'conflicts');const before=await fs.readFile(f.configFile);
  await assert.rejects(initWorkspace(f.configFile,root,['--profile','pub']),/name already exists/);
  await assert.rejects(initWorkspace(f.configFile,root,['--project','demo']),/binding already exists/);
  const insideKey=path.join(root,'src','trust.pub');await fs.copyFile(f.verifyKey,insideKey);
  f.config.device.peers.another={role:'publisher',verifyKey:insideKey};await f.saveConfig();const withPeer=await fs.readFile(f.configFile);
  await assert.rejects(initWorkspace(f.configFile,root),/must not contain any configured key/);
  assert.deepEqual(await fs.readFile(f.configFile),withPeer);assert(before.length>0);
});

test('receiver add and clone reuse trust without copying high-water, staging or target paths',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);await f.publish();await f.call('fetch','rx');
  const original=await fs.readFile(path.join(f.config.stateDir,'rx/state.json'));
  const cloned=path.join(f.dir,'second receiver');
  await manage(f.configFile,'profile',['clone','rx','second'],answers({'新的专用接收目录':cloned}));
  const cfg=await loadConfig(f.configFile);assert.equal(cfg.projects.second.identity,f.identity);assert.equal(cfg.projects.second.verifyKey,f.verifyKey);
  assert.equal(cfg.projects.second.targetRoot,cloned);assert.equal(await exists(path.join(cfg.stateDir,'second/state.json')),false);
  assert.equal((await execute(f.configFile,'status',['second'])).highwater,0);assert.equal((await f.call('status','rx')).highwater,1);
  assert.deepEqual(await fs.readFile(path.join(f.config.stateDir,'rx/state.json')),original);
  await fs.access(path.join(f.config.projects.rx.targetRoot,'staged'));
  await manage(f.configFile,'profile',['add'],answers({'本机 profile':'third','新的专用接收目录':path.join(f.dir,'third')}));
  assert.equal((await manage(f.configFile,'profile',['show','third'])).identity,f.identity);
  assert.equal((await manage(f.configFile,'profile',['list'])).length,4);
});

test('overlapping target/config/key/state paths and stale writes preserve original config bytes',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const before=await fs.readFile(f.configFile);
  for(const target of [f.config.projects.rx.targetRoot,f.source,path.join(f.config.stateDir,'bad'),f.dir]) {
    await assert.rejects(manage(f.configFile,'profile',['clone','rx','bad'],answers({'新的专用接收目录':target})));
    assert.deepEqual(await fs.readFile(f.configFile),before);
  }
  const cfg=await loadConfig(f.configFile),candidate=structuredClone(cfg.raw);candidate.device.defaults.publisher.channel='new';
  await fs.appendFile(f.configFile,'\n');await assert.rejects(commitCandidate(f.configFile,cfg.revision,candidate),/Config\/trust changed/);
  assert.deepEqual(await fs.readFile(f.configFile),Buffer.concat([before,Buffer.from('\n')]));
});

test('removing a profile preserves state and reserves its old name and binding',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);await f.publish();await f.call('fetch','rx');const state=await fs.readFile(path.join(f.config.stateDir,'rx/state.json'));
  await manage(f.configFile,'profile',['remove','rx'],answers({'只移除注册':'rx'}));
  assert.deepEqual(await fs.readFile(path.join(f.config.stateDir,'rx/state.json')),state);await fs.access(f.identity);
  let cfg=await loadConfig(f.configFile);assert.equal(cfg.projects.rx,undefined);assert.equal(cfg.device.retired.rx.project,'demo');
  await assert.rejects(manage(f.configFile,'profile',['add'],answers({'本机 profile':'rx','共享项目':'new','新的专用接收目录':path.join(f.dir,'fresh')})),/retired/);
  await assert.rejects(manage(f.configFile,'profile',['add'],answers({'本机 profile':'renamed','共享项目':'demo','新的专用接收目录':path.join(f.dir,'fresh')})),/binding already exists or is retired/);
});

test('peer defaults affect only future projects and in-use peer removal is refused',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const key=path.join(f.dir,'other.agekey');await run('age-keygen',['-o',key]);
  const recipient=(await run('age-keygen',['-y',key])).stdout.toString().trim();
  await manage(f.configFile,'peer',['add'],answers({'Peer 名称':'second','Peer 角色':'receiver','通过可信渠道':recipient}));
  await manage(f.configFile,'peer',['default','second'],answers());
  let cfg=await loadConfig(f.configFile);assert.deepEqual(cfg.device.defaults.publisher.peers,['second']);assert.deepEqual(cfg.projects.pub.recipients,[f.recipient]);
  await assert.rejects(manage(f.configFile,'peer',['remove','windows'],answers()),/pinned by an existing profile/);
  assert.equal((await manage(f.configFile,'peer',['show','second'])).recipient,recipient);
  await manage(f.configFile,'peer',['remove','second'],answers());cfg=await loadConfig(f.configFile);assert.deepEqual(cfg.device.defaults.publisher.peers,[]);
});

test('legacy workspace lookup works, rejects ambiguity and detects changes between resolution and execution',cryptoOptions,async t=>{
  const f=await fixture(t);assert.equal((await success(f,f.source,'status')).profile,'pub');
  const resolution=await workspaceArgs(f.configFile,'publish',[],f.source);
  f.config.projects.pub.include=['README.md'];await f.saveConfig();
  await assert.rejects(execute(f.configFile,'publish',resolution.args,{expectedConfigHash:resolution.expectedConfigHash}),/Workspace profile changed/);
  f.config.projects.alternate={...f.config.projects.pub,channel:'other'};await f.saveConfig();assert.match((await slash(f,f.source,'status')).text,/Ambiguous/);
});

test('workspace inspection disables repository fsmonitor commands',cryptoOptions,async t=>{
  if(process.platform==='win32')return;
  const f=await fixture(t);await device(f);const {root,g}=await repo(f,'hooks');const marker=path.join(f.dir,'should-not-exist');
  const hook=path.join(f.dir,'monitor.sh');await fs.writeFile(hook,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
  await g('config','core.fsmonitor',hook);await register(f,root);await success(f,root,'publish');assert.equal(await exists(marker),false);
});

test('slash argv quoting handles relative paths with spaces without evaluating a shell',()=>{
  assert.deepEqual(commandWords('init --include "src files,README.md" --exclude ""'),['init','--include','src files,README.md','--exclude','']);
  assert.deepEqual(commandWords('init --project $(id)'),['init','--project','$(id)']);assert.throws(()=>commandWords('init "oops'),/Unclosed/);
  assert(setupHint().includes('cli.js'));assert(setupHint().includes('bootstrap'));
});

test('peer registration rejects an age recipient with an invalid checksum without changing config',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const before=await fs.readFile(f.configFile);
  const bad=f.recipient.slice(0,-1)+(f.recipient.endsWith('q')?'p':'q');
  await assert.rejects(manage(f.configFile,'peer',['add'],answers({'Peer 名称':'bad','Peer 角色':'receiver','通过可信渠道':bad})),/age failed/);
  assert.deepEqual(await fs.readFile(f.configFile),before);
});

test('workspace root whitespace cannot retarget a similarly named repository',cryptoOptions,async t=>{
  if(process.platform==='win32')return;
  const f=await fixture(t);await device(f);const a=await repo(f,'same'),b=await repo(f,'same ');
  await register(f,a.root);const p=await register(f,b.root,['--profile','with-space']);assert.equal(p.gitRoot,b.root);
  assert.equal((await success(f,b.root,'publish')).files.length,2);
});

test('cancelling a trusted-terminal confirmation leaves config unchanged',cryptoOptions,async t=>{
  const f=await fixture(t);await device(f);const before=await fs.readFile(f.configFile),controller=new AbortController();
  const io=answers({'本机 profile':'cancelled','新的专用接收目录':path.join(f.dir,'cancelled'),'确认注册':()=>{controller.abort(new Error('Cancelled'));return 'yes';}});
  io.signal=controller.signal;
  await assert.rejects(manage(f.configFile,'profile',['add'],io),/Cancelled/);
  assert.deepEqual(await fs.readFile(f.configFile),before);
});
