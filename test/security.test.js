import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {hash,json,relative,secretPath,RECEIPT,run} from '../lib/util.js';
import {validateFiles,verify,decrypt} from '../lib/artifact.js';
import {loadConfig} from '../lib/config.js';
import {fixture,cryptoOptions,haveCrypto} from './helpers.js';

if(process.env.REQUIRE_CRYPTO==='1') assert(haveCrypto,'CI must install real crypto tools; skipped integration tests are not a passing release gate');
test('portable paths reject traversal, control chars, devices, aliases and metadata',()=>{
  for(const p of ['../evil','/evil','a/../../b','C:/evil','a\\b','a\0b','a//b','a/./b','file:ads','NUL.txt','con','a.','a ','A/.git/config','.secure-publish-envelope.json','e\u0301.txt']) assert.throws(()=>relative(p),p);
  assert.equal(relative('src/日本語.cs'),'src/日本語.cs');
  for(const p of ['.env','.env.production','src/key.pem','keys/id_ed25519','secrets.json']) assert(secretPath(p),p);
});
test('signed file lists reject case collisions, file/directory collisions and invalid modes',()=>{
  const f=p=>({path:p,size:1,mode:0o644,sha256:'a'.repeat(64)});
  for(const files of [[f('A'),f('a')],[f('a'),f('a/b')],[f('a/b'),f('a')],[{...f('a'),mode:0o7777}]]) assert.throws(()=>validateFiles(files));
});
test('real crypto lifecycle: publish -> stage -> explicit apply -> upgrade -> local rollback',cryptoOptions,async t=>{
  const f=await fixture(t); const preview=await f.call('publish','pub');
  assert.equal(f.getPacket(),undefined,'preview must not upload');
  assert(preview.recipients.includes(f.recipient));
  await assert.rejects(f.call('publish','pub','a'.repeat(24)),/mismatch/);
  await f.call('publish','pub',preview.token);
  assert(!f.getPacket().includes(Buffer.from('hello version one')));
  assert(!f.getPacket().includes(Buffer.from('src/hello')));
  const oldMask=process.umask(0o077);
  try {await f.call('fetch','rx');await assert.rejects(fs.access(f.current));await f.apply();}
  finally {process.umask(oldMask);}
  assert.equal(await fs.readFile(path.join(f.current,'src/hello.txt'),'utf8'),'hello version one\n');
  await f.commit('hello version two\n');await f.publish();await f.call('fetch','rx');
  const d=await f.call('diff','rx');assert(d.diff.includes('hello version two'));
  await f.call('apply','rx',d.confirm);
  const r=await f.call('rollback','rx');await f.call('rollback','rx',r.confirm);
  assert.equal(await fs.readFile(path.join(f.current,'src/hello.txt'),'utf8'),'hello version one\n');
  assert.equal((await f.call('status','rx')).highwater,2);
  f.setPacket(f.versions.get(1));await assert.rejects(f.call('fetch','rx'),/Replay/);
});
test('ciphertext corruption and wrong recipient cannot create a staging snapshot',cryptoOptions,async t=>{
  const f=await fixture(t);await f.publish();const good=Buffer.from(f.getPacket());
  const bad=Buffer.from(good);bad[bad.length-1]^=1;f.setPacket(bad);
  await assert.rejects(f.call('fetch','rx'),/failed/);
  assert.equal((await f.call('status','rx')).highwater,0);
  const wrong=path.join(f.dir,'wrong.agekey');await run('age-keygen',['-o',wrong]);await fs.chmod(wrong,0o600);
  f.config.projects.rx.identity=wrong;await f.saveConfig();f.setPacket(good);
  await assert.rejects(f.call('fetch','rx'),/failed/);
});
test('manifest tampering, payload tampering and a wrong pinned signing key are rejected',cryptoOptions,async t=>{
  const f=await fixture(t);await f.publish();const {projects:{rx}}=await loadConfig(f.configFile);
  const envelope=await decrypt(rx,f.getPacket());const original=JSON.parse(envelope);
  const bad={...original};const m=JSON.parse(Buffer.from(bad.manifest,'base64'));m.sequence=999;
  bad.manifest=Buffer.from(JSON.stringify(m)).toString('base64');await assert.rejects(verify(rx,json(bad)),/failed/);
  const changed={...original};const payload=Buffer.from(changed.payload,'base64');payload[12]^=1;changed.payload=payload.toString('base64');
  await assert.rejects(verify(rx,json(changed)),/failed/);
  const wrong=path.join(f.dir,'wrong.pub');await run('minisign',['-G','-W','-s',path.join(f.dir,'wrong.key'),'-p',wrong]);
  await assert.rejects(verify({...rx,verifyKey:wrong},envelope),/failed/);
});
test('valid signatures do not authorize a different project/channel/repository',cryptoOptions,async t=>{
  const f=await fixture(t);await f.publish();const {projects:{rx}}=await loadConfig(f.configFile);
  const envelope=await decrypt(rx,f.getPacket());
  for(const [key,value] of [['project','other'],['channel','other'],['repository','someone/else'],['branch','other']])
    await assert.rejects(verify({...rx,binding:{...rx.binding,[key]:value}},envelope),/binding/);
  await assert.rejects(verify({...rx,minSequence:2},envelope),/trust floor/);
});
test('identical fetch retries are allowed, same-sequence different ciphertext is rejected',cryptoOptions,async t=>{
  const f=await fixture(t);await f.publish();await f.call('fetch','rx');await f.call('fetch','rx');
  const {projects:{rx}}=await loadConfig(f.configFile);const envelope=await decrypt(rx,f.getPacket());
  const changed=(await run('age',['-r',f.recipient],{input:envelope})).stdout;f.setPacket(changed);
  await assert.rejects(f.call('fetch','rx'),/equivocation/);
});
test('uncommitted source, symlinks, secrets and LFS pointers never publish',cryptoOptions,async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.source,'src/untracked'),'data');
  await assert.rejects(f.call('publish','pub'),/clean/);await fs.rm(path.join(f.source,'src/untracked'));
  await fs.writeFile(path.join(f.source,'src/.env'),'TOKEN=secret');await f.g('add','.');await f.g('commit','-m','secret fixture');
  await assert.rejects(f.call('publish','pub'),/secret-like/);
  await f.g('rm','src/.env');await fs.writeFile(path.join(f.source,'src/lfs'),'version https://git-lfs.github.com/spec/v1\noid sha256:test');await f.g('add','.');await f.g('commit','-m','lfs');
  await assert.rejects(f.call('publish','pub'),/LFS/);
  if(process.platform!=='win32') {await f.g('rm','src/lfs');await fs.symlink('/tmp',path.join(f.source,'src/link'));await f.g('add','.');await f.g('commit','-m','symlink');await assert.rejects(f.call('publish','pub'),/Symlinks/);}
  assert.equal(f.getPacket(),undefined);
});
test('allowlist excludes committed files outside selected paths',cryptoOptions,async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.source,'private.txt'),'not for shipment');await f.g('add','.');await f.g('commit','-m','outside');
  const p=await f.publish();assert.deepEqual(p.files.map(x=>x.path),['src/hello.txt']);
  await f.call('fetch','rx');await f.apply();await assert.rejects(fs.access(path.join(f.current,'private.txt')));
});
test('stale confirmation and tampered staged/current files cannot be applied',cryptoOptions,async t=>{
  const f=await fixture(t);await f.publish();await f.call('fetch','rx');await f.apply();
  await f.commit('two\n');await f.publish();await f.call('fetch','rx');const d=await f.call('diff','rx');
  await fs.writeFile(path.join(f.current,'build.log'),'changed after review');
  await assert.rejects(f.call('apply','rx',d.confirm),/Confirmation/);
  const d2=await f.call('diff','rx');assert.deepEqual(d2.extraPreservedInBackup,['build.log']);
  await fs.writeFile(path.join(f.config.projects.rx.targetRoot,'staged/src/hello.txt'),'tampered');
  await assert.rejects(f.call('apply','rx',d2.confirm),/modified/);
  await f.call('fetch','rx');await fs.writeFile(path.join(f.current,'src/hello.txt'),'local debugging edit');
  await assert.rejects(f.call('diff','rx'),/modified/);
});
test('config changes invalidate a prepared upload and private permissions are enforced',cryptoOptions,async t=>{
  const f=await fixture(t);const p=await f.call('publish','pub');
  f.config.projects.pub.include.push('README.md');await f.saveConfig();
  await assert.rejects(f.call('publish','pub',p.token),/mismatch/);
  if(process.platform!=='win32') {await fs.chmod(f.configFile,0o644);await assert.rejects(f.call('doctor'),/600/);}
});
test('an interrupted switch before/after installing the candidate can be recovered',cryptoOptions,async t=>{
  const f=await fixture(t);await f.publish();await f.call('fetch','rx');await f.apply();
  await f.commit('two\n');await f.publish();await f.call('fetch','rx');
  const root=f.config.projects.rx.targetRoot,backup='backup-11111111-1111-4111-8111-111111111111';
  const envelope=await fs.readFile(path.join(root,'staged',RECEIPT));
  const tx={format:1,slot:'staged',backup,hadCurrent:true,previous:null,fromDigest:hash(await fs.readFile(path.join(f.current,RECEIPT))),toDigest:hash(envelope)};
  await fs.writeFile(path.join(root,'transaction.json'),json(tx));await fs.rename(f.current,path.join(root,backup));
  await assert.rejects(f.call('diff','rx'),/recover/);await f.call('recover','rx');
  assert.equal(await fs.readFile(path.join(f.current,'src/hello.txt'),'utf8'),'hello version one\n');
  await fs.writeFile(path.join(root,'transaction.json'),json(tx));await fs.rename(f.current,path.join(root,backup));await fs.rename(path.join(root,'staged'),f.current);
  await f.call('recover','rx');assert.equal((await f.call('status','rx')).previous,backup);
  assert.equal(await fs.readFile(path.join(f.current,'src/hello.txt'),'utf8'),'two\n');
});
test('live locks cannot be unlocked and unmanaged existing target directories are refused',cryptoOptions,async t=>{
  const f=await fixture(t);await f.call('status','rx');
  const lock=path.join(f.config.stateDir,'rx/lock');await fs.writeFile(lock,json({pid:process.pid}));
  await assert.rejects(f.call('unlock','rx'),/running/);await assert.rejects(f.call('status','rx'),/locked/);await fs.unlink(lock);
  await fs.mkdir(f.config.projects.rx.targetRoot,{mode:0o700});await f.publish();
  await assert.rejects(f.call('fetch','rx'),/ownership marker/);
});
test('recovery before a rename handles repeated application of the same snapshot',cryptoOptions,async t=>{
  const f=await fixture(t);await f.publish();await f.call('fetch','rx');await f.apply();await f.call('fetch','rx');
  const root=f.config.projects.rx.targetRoot,envelope=await fs.readFile(path.join(f.current,RECEIPT));
  const tx={format:1,slot:'staged',backup:'backup-22222222-2222-4222-8222-222222222222',hadCurrent:true,
    previous:null,fromDigest:hash(envelope),toDigest:hash(envelope)};
  await fs.writeFile(path.join(root,'transaction.json'),json(tx));
  const result=await f.call('recover','rx');assert(result.outcome.includes('No rename'));
  await fs.access(path.join(root,'staged',RECEIPT));await fs.access(path.join(root,'current',RECEIPT));
  assert.equal((await f.call('status','rx')).highwater,1);
});
