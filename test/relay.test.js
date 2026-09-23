import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture,cryptoOptions} from './helpers.js';
import {run} from '../lib/util.js';
import {execute} from '../lib/engine.js';
import {loadConfig} from '../lib/config.js';
import {upload} from '../lib/relay.js';

test('production Git relay round-trip, immutable sequence and unrelated paths preserved',
  process.platform==='win32'?{skip:'Test-only POSIX Git wrapper; Windows requires a separate native integration run'}:cryptoOptions,async t=>{
  const f=await fixture(t),remote=path.join(f.dir,'remote.git');
  await run('git',['init','--bare',remote]);
  const realGit=(await run('which',['git'],{limit:4096})).stdout.toString().trim();
  const wrapper=path.join(f.dir,'git-wrapper');
  // Test-only transport: redirect the fixed GitHub URL to a local bare repository.
  // Production code has no remote-override parameter and forbids file transport.
  await fs.writeFile(wrapper,`#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2).map(x=>x==='protocol.file.allow=never'?'protocol.file.allow=always':x);\nconst r=spawnSync(${JSON.stringify(realGit)},['-c',${JSON.stringify('url.'+pathToFileURL(remote).href+'.insteadOf=https://github.com/test/relay.git')},...a],{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o755});
  // Extensionless ESM is supported by Node >=22 syntax detection.
  f.config.binaries={git:wrapper};await f.saveConfig();
  const call=(cmd,...args)=>execute(f.configFile,cmd,args);
  const first=await call('publish','pub');await call('publish','pub',first.token);
  await call('fetch','rx');let d=await call('diff','rx');await call('apply','rx',d.confirm);
  assert.equal(await fs.readFile(path.join(f.current,'src/hello.txt'),'utf8'),'hello version one\n');
  await f.commit('second through Git\n');const second=await call('publish','pub');await call('publish','pub',second.token);
  await call('fetch','rx');d=await call('diff','rx');await call('apply','rx',d.confirm);
  assert.equal(await fs.readFile(path.join(f.current,'src/hello.txt'),'utf8'),'second through Git\n');
  const files=(await run('git',['--git-dir',remote,'ls-tree','-r','--name-only','secure-relay'])).stdout.toString();
  assert(files.includes('000000000001.age'));assert(files.includes('000000000002.age'));
  assert(files.split('\n').filter(Boolean).every(n=>n.endsWith('.age')));
  const cipher=(await run('git',['--git-dir',remote,'show','secure-relay:packets/demo/main/000000000001.age'])).stdout;
  const p=(await loadConfig(f.configFile)).projects.pub;
  await upload({...p,project:'another'},cipher,1);
  const all=(await run('git',['--git-dir',remote,'ls-tree','-r','--name-only','secure-relay'])).stdout.toString();
  assert(all.includes('packets/another/main/000000000001.age'));
  assert(all.includes('packets/demo/main/000000000002.age'));
  const repeat=await upload(p,cipher,1);assert.equal(repeat.alreadyPublished,true);
  await assert.rejects(upload(p,Buffer.from('different ciphertext'),1),/different ciphertext/);
  await upload(p,Buffer.from('opaque sequence four'),4);
  await assert.rejects(upload(p,Buffer.from('stale gap three'),3),/behind relay/);
});
