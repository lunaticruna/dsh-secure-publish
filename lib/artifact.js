import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {check, hash, json, relative, secretPath, MAX_RAW, MAX_PACKET, MAX_FILES, RECEIPT, run, read, temporary, syncDir} from './util.js';

export const FORMAT = 'dsh-secure-publish/v1';
const selected = (p, prefixes) => prefixes.some(s => p === s || p.startsWith(s+'/'));
export async function git(p, args, options = {}) {
  return run(p.binaries.git, ['--no-pager','--no-optional-locks','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','tag.gpgsign=false','-c','protocol.file.allow=never',...args], options);
}
export function validateFiles(files) {
  check(Array.isArray(files) && files.length > 0 && files.length <= MAX_FILES, 'Invalid file count');
  let total = 0; const names = new Set(); const directories = new Set();
  for(const f of files) {
    relative(f.path); check(!secretPath(f.path), `Blocked secret-like path: ${f.path}`);
    const lower = f.path.toLowerCase(); check(!names.has(lower) && !directories.has(lower), 'Duplicate/case-colliding/file-directory path');
    for(let at = lower.indexOf('/'); at !== -1; at = lower.indexOf('/', at+1)) {
      const parent = lower.slice(0,at); check(!names.has(parent), 'File-directory collision'); directories.add(parent);
    }
    names.add(lower);
    check(f.mode === 0o644 || f.mode === 0o755, 'Invalid file mode');
    check(Number.isSafeInteger(f.size) && f.size >= 0 && /^[a-f0-9]{64}$/.test(f.sha256), 'Invalid file metadata');
    total += f.size; check(total <= MAX_RAW, 'Source size limit: 32 MiB');
  }
  return total;
}
function b64(s, max = MAX_PACKET) {
  check(typeof s === 'string' && s.length <= Math.ceil(max/3)*4 && s.length%4===0 && !/[^A-Za-z0-9+/=]/.test(s), 'Invalid base64');
  const b = Buffer.from(s,'base64'); check(b.length <= max && b.toString('base64')===s, 'Decoded size/encoding limit'); return b;
}
export async function snapshot(p, signal) {
  const cwd = p.source;
  const top=(await git(p,['rev-parse','--show-toplevel'],{cwd,signal,limit:8192})).stdout.toString().trim();
  check(path.resolve(top)===path.resolve(cwd),'source must be the Git repository root');
  const dirty = (await git(p,['status','--porcelain=v1','--untracked-files=normal'],{cwd,signal,limit:1024*1024})).stdout;
  check(dirty.length === 0, 'Source must be clean and committed; commit or remove untracked files first');
  const commit = (await git(p,['rev-parse','--verify','HEAD^{commit}'],{cwd,signal,limit:1024})).stdout.toString().trim();
  check(/^[a-f0-9]{40,64}$/.test(commit), 'Invalid source commit');
  const tree = (await git(p,['ls-tree','-rz','--full-tree',commit],{cwd,signal,limit:4*1024*1024})).stdout.toString('utf8');
  const files = []; const data = []; let total=0;
  for(const line of tree.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\t([\s\S]*)$/.exec(line); check(match, 'Invalid Git tree');
    const [,mode,type,object,file] = match;
    if(!selected(file,p.include) || selected(file,p.exclude || [])) continue;
    relative(file); check(!secretPath(file), `Blocked secret-like path: ${file}`);
    check(type === 'blob' && ['100644','100755'].includes(mode), `Symlinks/submodules forbidden: ${file}`);
    const content = (await git(p,['cat-file','blob',object],{cwd,signal,limit:MAX_RAW})).stdout;
    // LFS blobs are pointers, not source; fail rather than silently ship an incomplete snapshot.
    check(!content.subarray(0,100).toString().startsWith('version https://git-lfs.github.com/spec/v1'), `Git LFS not supported: ${file}`);
    check(!/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|AGE-SECRET-KEY-1/.test(content.toString('utf8')), `Private key material detected: ${file}`);
    files.push({path:file,mode:mode === '100755' ? 0o755 : 0o644,size:content.length,sha256:hash(content)});
    total+=content.length;check(total<=MAX_RAW && files.length<=MAX_FILES,'Source size/file count limit');data.push(content.toString('base64'));
  }
  validateFiles(files);
  return {commit,files,payload:gzipSync(json(data),{level:6})};
}
export async function seal(p, snap, sequence, {signal,interactive=false} = {}) {
  if(!interactive) {
    const lines=(await read(p.signingKey,8192)).toString('utf8').trim().split(/\r?\n/);
    const header=Buffer.from(lines.at(-1),'base64');
    check(header.length>=6 && header[2]===0 && header[3]===0,
      'Password-protected minisign key: prepare publish from a trusted terminal; the Web plugin never requests a key password');
  }
  const manifest = json({format:FORMAT,...p.binding,sequence,createdAt:new Date().toISOString(),sourceCommit:snap.commit,
    payloadSha256:hash(snap.payload),files:snap.files});
  return temporary(p.stateDir, async dir => {
    const mf = path.join(dir,'manifest.json'), pf = path.join(dir,'payload.json.gz');
    await fs.writeFile(mf,manifest,{mode:0o600}); await fs.writeFile(pf,snap.payload,{mode:0o600});
    for(const f of [mf,pf]) await run(p.binaries.minisign,['-S','-s',p.signingKey,'-m',f,'-x',f+'.minisig','-t',FORMAT],{signal,interactive,limit:16384});
    const envelope = json({format:FORMAT,manifest:manifest.toString('base64'),manifestSignature:(await read(mf+'.minisig',8192)).toString('base64'),
      payload:snap.payload.toString('base64'),payloadSignature:(await read(pf+'.minisig',8192)).toString('base64')});
    check(envelope.length <= MAX_PACKET, 'Envelope size limit');
    // A configured signing key must correspond to the locally pinned verification key.
    await verify(p,envelope,{signal});
    const recipients = p.recipients.flatMap(r=>['-r',r]);
    const cipher = (await run(p.binaries.age,['--encrypt',...recipients],{input:envelope,signal})).stdout;
    return {cipher,manifest:JSON.parse(manifest)};
  });
}
export async function decrypt(p, cipher, signal) {
  check(cipher.length <= MAX_PACKET, 'Ciphertext size limit');
  return (await run(p.binaries.age,['--decrypt','-i',p.identity],{input:cipher,signal})).stdout;
}
export async function verify(p, envelopeBytes, {signal, freshness=false} = {}) {
  check(envelopeBytes.length <= MAX_PACKET, 'Envelope size limit');
  const e = JSON.parse(envelopeBytes.toString('utf8')); check(e.format === FORMAT, 'Unknown envelope format');
  const manifestBytes = b64(e.manifest,4*1024*1024), payload = b64(e.payload,MAX_PACKET);
  await temporary(p.stateDir, async dir => {
    for(const [name,bytes,sig] of [['manifest',manifestBytes,e.manifestSignature],['payload',payload,e.payloadSignature]]) {
      const f = path.join(dir,name); await fs.writeFile(f,bytes,{mode:0o600}); await fs.writeFile(f+'.minisig',b64(sig,8192),{mode:0o600});
      await run(p.binaries.minisign,['-V','-p',p.verifyKey,'-m',f,'-x',f+'.minisig','-q'],{signal,limit:16384});
    }
  });
  const m = JSON.parse(manifestBytes.toString('utf8'));
  check(m.format === FORMAT && Object.entries(p.binding).every(([k,v])=>m[k] === v), 'Signature valid but project/channel/repository/branch binding does not match');
  check(Number.isSafeInteger(m.sequence) && m.sequence >= p.minSequence, 'Sequence below configured trust floor');
  check(typeof m.createdAt === 'string' && Number.isFinite(Date.parse(m.createdAt)) && /^[a-f0-9]{40,64}$/.test(m.sourceCommit), 'Invalid signed metadata');
  if(freshness) {
    const age = Date.now() - Date.parse(m.createdAt);
    check(age >= -300000 && age <= p.maxAgeDays*86400000, 'Artifact expired or timestamp is in the future');
  }
  validateFiles(m.files); check(m.payloadSha256 === hash(payload), 'Payload digest mismatch');
  const decoded = gunzipSync(payload,{maxOutputLength:MAX_RAW*2});
  const data = JSON.parse(decoded.toString('utf8')); check(Array.isArray(data) && data.length === m.files.length, 'Payload file count mismatch');
  const contents = data.map((s,i)=>{const b=b64(s,MAX_RAW);check(b.length===m.files[i].size && hash(b)===m.files[i].sha256,'Source digest mismatch');return b;});
  return {manifest:m,contents,digest:hash(envelopeBytes),envelope:envelopeBytes};
}
export async function materialize(dir, verified) {
  await fs.mkdir(dir,{mode:0o700});
  const dirs=new Set([dir]);
  async function durable(file,bytes,mode) {const fd=await fs.open(file,'wx',mode);try{await fd.writeFile(bytes);await fd.chmod(mode);await fd.sync();}finally{await fd.close();}}
  for(let i=0;i<verified.manifest.files.length;i++) {
    const f=verified.manifest.files[i], to=path.join(dir,...f.path.split('/'));
    await fs.mkdir(path.dirname(to),{recursive:true,mode:0o700});
    for(let at=path.dirname(to);at!==dir;at=path.dirname(at)) dirs.add(at);
    await durable(to,verified.contents[i],f.mode);
  }
  await durable(path.join(dir,RECEIPT),verified.envelope,0o600);
  for(const d of [...dirs].sort((a,b)=>b.length-a.length)) await syncDir(d);
}
