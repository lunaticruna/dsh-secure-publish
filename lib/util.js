import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const MAX_RAW = 32 * 1024 * 1024;
export const MAX_PACKET = 80 * 1024 * 1024;
export const MAX_FILES = 10000;
export const RECEIPT = '.secure-publish-envelope.json';
export function check(ok, message) { if (!ok) throw new Error(message); }
export const hash = data => createHash('sha256').update(data).digest('hex');
export const json = value => Buffer.from(JSON.stringify(value));
export const id = () => randomUUID();
export function label(s) { check(typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(s), 'Invalid project/channel name'); return s; }
export function relative(s) {
  check(typeof s === 'string' && s.length > 0 && s.length <= 240 && s === s.normalize('NFC'), 'Invalid/non-NFC path');
  const parts = s.split('/');
  check(parts.every(p => p && p !== '.' && p !== '..' && !/[\x00-\x1f\x7f<>:"\\|?*]/.test(p)
    && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)), `Unsafe portable path: ${s}`);
  check(!parts.some(p => /^\.git(?:$|\.)/i.test(p) && p.toLowerCase() !== '.gitignore' && p.toLowerCase() !== '.gitattributes'), `Git metadata forbidden: ${s}`);
  check(!parts.some(p => p.toLowerCase().startsWith('.secure-publish')), 'Reserved internal path');
  return s;
}
export function secretPath(s) {
  return s.split('/').some(p => /^(\.env(?:\..*)?|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.npmrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(rsa|ed25519|ecdsa)(?:\..*)?)$/i.test(p)
    || /\.(key|pem|p12|pfx|keystore|agekey)$/i.test(p));
}
export function inside(a, b) { const r = path.relative(a, b); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); }
export function disjoint(a,b) { check(!inside(a,b) && !inside(b,a), `Directories must not overlap: ${a} / ${b}`); }
export async function exists(p) { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export async function noLinks(p) {
  p = path.resolve(p); let at = path.parse(p).root;
  for (const part of p.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    try { check(!(await fs.lstat(at)).isSymbolicLink(), `Symlink/junction forbidden: ${at}`); }
    catch (e) { if (e.code === 'ENOENT') break; throw e; }
  }
}
export async function privateDir(p) {
  await noLinks(p); await fs.mkdir(p, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') check(((await fs.stat(p)).mode & 0o077) === 0, `Private directory must have mode 700: ${p}`);
}
export async function privateFile(p) {
  await noLinks(p); const st = await fs.stat(p);
  check(st.isFile(), `Expected regular file: ${p}`);
  if (process.platform !== 'win32') check((st.mode & 0o077) === 0, `Private file must have mode 600: ${p}`);
}
export async function read(p, limit = MAX_PACKET) {
  await noLinks(p); const st = await fs.stat(p);
  check(st.isFile() && st.size <= limit, `Not a bounded regular file: ${p}`);
  const b = await fs.readFile(p); check(b.length <= limit, 'File grew beyond limit'); return b;
}
export async function readJson(p, limit = 1024 * 1024) { return JSON.parse((await read(p, limit)).toString('utf8')); }
export async function atomic(p, data) {
  await noLinks(p); const tmp = `${p}.${id()}.tmp`;
  const fd = await fs.open(tmp, 'wx', 0o600);
  try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
  try { await fs.rename(tmp, p); await syncDir(path.dirname(p)); }
  finally { await fs.rm(tmp, { force: true }); }
}
export async function syncDir(p) {
  if (process.platform === 'win32') return;
  const fd = await fs.open(p, 'r'); try { await fd.sync(); } finally { await fd.close(); }
}
export async function temporary(parent, fn) {
  await privateDir(parent); const dir = await fs.mkdtemp(path.join(parent, 'tmp-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
export async function lock(dir, fn) {
  await privateDir(dir); const file = path.join(dir, 'lock'); let fd;
  try { fd = await fs.open(file, 'wx', 0o600); }
  catch(e) { if(e.code === 'EEXIST') throw new Error('Project locked; if a process crashed, use unlock after it has exited'); throw e; }
  try { await fd.writeFile(json({pid:process.pid,createdAt:new Date().toISOString()})); await fd.sync(); return await fn(); }
  finally { await fd.close(); await fs.rm(file, { force:true }); }
}
export async function unlock(dir) {
  const file = path.join(dir, 'lock'); const data = await readJson(file);
  check(Number.isSafeInteger(data.pid) && data.pid > 0, 'Invalid lock; inspect manually');
  try { process.kill(data.pid, 0); throw new Error('Lock owner is still running (or PID was reused)'); }
  catch(e) { if (e.code !== 'ESRCH') throw e; }
  await fs.unlink(file); return { unlocked:true };
}
export async function run(bin, args, {cwd, input, signal, limit = MAX_PACKET, codes = [0], interactive = false, env = {}} = {}) {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const clean = {...process.env, ...env};
    for (const k of Object.keys(clean)) if (/^GIT_(CONFIG|DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|EXTERNAL_DIFF$)/.test(k)) delete clean[k];
    const child = spawn(bin, args, { cwd, env:clean, shell:false, windowsHide:true,
      stdio:[interactive ? 'inherit' : 'pipe', 'pipe', 'pipe'], signal });
    let out = [], err = [], size = 0, errSize = 0, failure;
    const timer = setTimeout(() => { failure = new Error(`${path.basename(bin)} timed out; check status before retrying`); child.kill(); }, 120000);
    child.on('error', e => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error(`Missing executable: ${bin}`) : e); });
    child.stdout.on('data', b => { size += b.length; if(size > limit) { failure = new Error('Subprocess output limit exceeded'); child.kill(); } else out.push(b); });
    child.stderr.on('data', b => { if(interactive) process.stderr.write(b); errSize += b.length; if(errSize <= 16384) err.push(b); });
    child.stdin?.on('error', () => {});
    if(!interactive) child.stdin.end(input);
    child.on('close', code => {
      clearTimeout(timer);
      if(failure) return reject(failure);
      // Never copy arbitrary child stderr into conversation logs (credentials/remote text).
      if(!codes.includes(code)) return reject(new Error(`${path.basename(bin)} failed (exit ${code}); check keys, authentication, branch and permissions in a trusted terminal`));
      resolve({code, stdout:Buffer.concat(out), stderr:Buffer.concat(err)});
    });
  });
}
