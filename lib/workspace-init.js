import fs from 'node:fs/promises';
import path from 'node:path';
import {git} from './artifact.js';
import {loadConfig,validateConfig,absolute} from './config.js';
import {check,noLinks,hash,json,atomic,readJson,exists,label,relative,secretPath,inside,MAX_FILES} from './util.js';
import {configSession,controlDir,editable,assertNewProfile,publisherTemplate,profileView,revisionToken} from './profiles.js';

const TOKEN=/^[a-f0-9]{24}$/;
const contains=(file,prefixes)=>prefixes.some(p=>file===p||file.startsWith(p+'/'));
const same=(a,b)=>path.relative(a,b)==='';

export async function workspaceContext(cfg,cwd,signal) {
  check(typeof cwd==='string' && path.isAbsolute(cwd),'Current DSH workspace cwd is missing/invalid; no process cwd fallback is allowed');
  cwd=absolute(cwd);await noLinks(cwd);check((await fs.stat(cwd)).isDirectory(),'Workspace cwd must be a directory');
  cwd=await fs.realpath(cwd);
  const command=(args,options={})=>git(cfg,args,{cwd,signal,limit:4*1024*1024,...options});
  const rootText=(await command(['rev-parse','--show-toplevel'])).stdout.toString('utf8').replace(/\r?\n$/,'');
  check(path.isAbsolute(rootText),'Workspace must belong to a non-bare Git repository');
  await noLinks(rootText);const root=await fs.realpath(rootText);
  check(inside(root,cwd),'Git root does not contain the invoking workspace');
  const gitDir=(await command(['rev-parse','--absolute-git-dir'])).stdout.toString('utf8').replace(/\r?\n$/,'');
  await noLinks(gitDir);
  const head=(await command(['rev-parse','--verify','HEAD^{commit}'],{codes:[0,128]}));
  // -z avoids Git's quoted-path display format, including spaces and Unicode.
  const bytes=(await git(cfg,['ls-files','--stage','-z'],{cwd:root,signal,limit:4*1024*1024})).stdout;
  const text=bytes.toString('utf8');check(Buffer.from(text).equals(bytes),'Git paths must be valid UTF-8');
  const files=text.split('\0').filter(Boolean).map(line=>{
    const m=/^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);
    check(m&&m[3]==='0','Resolve Git index conflicts before workspace setup');
    return {path:m[4],mode:m[1]};
  });
  check(files.length<=MAX_FILES,'Workspace tracked-file limit exceeded');
  return {cwd,root,gitDir,head:head.code===0?head.stdout.toString().trim():null,trackedHash:hash(bytes),files};
}

function allowed(f) {
  try {relative(f.path);return !secretPath(f.path)&&['100644','100755'].includes(f.mode);} catch {return false;}
}
function suggestions(files) {
  const directories=new Set(['src','lib','app','apps','packages','test','tests','docs','include','scripts','assets','public','Properties']);
  const roots=/^(README(?:\.[^/]+)?|LICENSE(?:\.[^/]+)?|NOTICE|Makefile|CMakeLists\.txt|Dockerfile|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pyproject\.toml|requirements\.txt|.*\.(?:sln|csproj|fsproj|props|targets|cs|fs|ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|h|cpp|hpp|swift|kt|java))$/i;
  const include=[];
  for(const top of [...new Set(files.map(f=>f.path.split('/')[0]))].sort()) {
    const members=files.filter(f=>f.path===top||f.path.startsWith(top+'/'));
    const isDirectory=members.some(f=>f.path.includes('/'));
    if(members.every(allowed) && (isDirectory?(directories.has(top)||members.some(f=>roots.test(path.posix.basename(f.path)))):roots.test(top))) include.push(top);
  }
  return include;
}
function csv(s) {check(typeof s==='string','Option needs a value');return s?s.split(',').map(v=>v.trim()):[];}
function settings(args) {
  const out={};
  for(let i=0;i<args.length;i+=2) {
    const key=args[i];check(['--profile','--project','--channel','--include','--exclude','--identity','--peers'].includes(key),`Unsupported init option: ${key}`);
    check(i+1<args.length && !Object.hasOwn(out,key),'Missing or duplicate init option');out[key]=args[i+1];
  }
  return out;
}
function suggestedName(root) {return path.basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^[^a-z0-9]+|[-_]+$/g,'').slice(0,48)||`project-${hash(root).slice(0,8)}`;}
function contextRecord(context) {const {files,...rest}=context;return rest;}
function reviewPaths(p,files) {
  check(p.include.length>0,'No safe include suggestion; specify --include src,README.md after tracking source files in Git');
  for(const entry of [...p.include,...p.exclude]) relative(entry);
  const selected=files.filter(f=>contains(f.path,p.include)&&!contains(f.path,p.exclude));
  check(selected.length>0,'Include/exclude selects no Git tracked files');
  for(const f of selected) check(allowed(f),`Unsafe tracked file selected: ${f.path}; exclude it explicitly`);
  return selected;
}

export async function initWorkspace(file,cwd,args=[],{signal}={}) {
  return configSession(file,async(cfg,save)=>{
    signal?.throwIfAborted();
    const context=await workspaceContext(cfg,cwd,signal);
    const pending=path.join(controlDir(file),`workspace-${hash(context.cwd)}.json`);
    if(args.length===1&&TOKEN.test(args[0])) {
      check(await exists(pending),'No init preview for this workspace; run /sp init here first');
      const record=await readJson(pending,2*1024*1024),{token,...review}=record;
      check(token===args[0]&&revisionToken(review)===token,'Init confirmation record changed; preview again');
      check(Date.now()>=review.createdAt&&Date.now()-review.createdAt<=900000,'Init confirmation expired; preview again');
      check(review.revision===cfg.revision,'Config/trust changed; preview /sp init again');
      check(JSON.stringify(review.context)===JSON.stringify(contextRecord(context)),'Workspace/Git index changed; preview /sp init again');
      const candidate=review.candidate,p=candidate.projects[review.profile];
      check(p?.role==='publisher'&&same(p.source,context.root),'Workspace/source binding changed');
      await assertNewProfile(cfg,review.profile,p);reviewPaths(p,context.files);
      signal?.throwIfAborted();await save(candidate);await fs.rm(pending,{force:true});
      return {initialized:review.profile,source:context.root,next:'/sp status',note:'Profile registered; no key generation and no upload occurred.'};
    }
    const opts=settings(args);
    const bound=Object.values(cfg.projects).filter(p=>p.role==='publisher'&&same(p.source,context.root));
    check(bound.length<=1,'Workspace has multiple legacy profiles; resolve the ambiguity in a trusted terminal');
    if(bound.length===1) {check(args.length===0,'Workspace already initialized; /sp init does not replace its binding');return {alreadyInitialized:true,...profileView(cfg,bound[0].name)};}
    const name=label(opts['--profile']||suggestedName(context.root));
    const {profile,identityName,peerNames}=publisherTemplate(cfg,{identity:opts['--identity'],peers:opts['--peers']===undefined?undefined:csv(opts['--peers']),channel:opts['--channel']});
    const p={...profile,project:label(opts['--project']||name),source:context.root,
      include:opts['--include']===undefined?suggestions(context.files):csv(opts['--include']),exclude:csv(opts['--exclude']||'')};
    const selected=reviewPaths(p,context.files);await assertNewProfile(cfg,name,p);
    const candidate=editable(cfg);candidate.projects[name]=p;await validateConfig(candidate,cfg.file);
    const record={kind:'workspace-init',createdAt:Date.now(),revision:cfg.revision,context:contextRecord(context),profile:name,identityName,peerNames,candidate};
    record.token=revisionToken(record);await atomic(pending,json(record));
    return {workspace:context.cwd,gitRoot:context.root,profile:name,project:p.project,channel:p.channel,
      repository:p.repository,branch:p.branch,identity:identityName,peers:peerNames,recipients:p.recipients,
      include:p.include,exclude:p.exclude,selectedFiles:selected.slice(0,200).map(f=>f.path),selectedFileCount:selected.length,
      omittedFromSelection:context.files.length-selected.length,omittedPaths:context.files.filter(f=>!selected.includes(f)).slice(0,200).map(f=>f.path),
      token:record.token,confirm:`/sp init ${record.token}`,
      note:'Review include/exclude, project binding and recipients. Confirmation expires after 15 minutes. No keys will be generated. No config has been written.'};
  });
}

export async function workspaceArgs(file,action,args,cwd,signal) {
  const cfg=await loadConfig(file);
  const implicit=args.length===0||(action==='publish'&&args.length===1&&TOKEN.test(args[0])&&!Object.hasOwn(cfg.projects,args[0]));
  const explicit=implicit?null:cfg.projects[args[0]];
  // Explicit receiver commands retain the v1 plugin contract. Publisher commands,
  // including the advanced explicit-profile form, must match the current workspace.
  if(explicit?.role==='receiver') return {args,expectedConfigHash:explicit.configHash};
  const context=await workspaceContext(cfg,cwd,signal);
  if(!implicit) {
    check(explicit,'Unknown configured profile');check(same(explicit.source,context.root),'Profile belongs to a different workspace; switch DSH workspace first');return {args,expectedConfigHash:explicit.configHash};
  }
  const matches=Object.values(cfg.projects).filter(p=>p.role==='publisher'&&same(p.source,context.root));
  check(matches.length===1,matches.length?'Ambiguous workspace binding; specify its profile explicitly':'Current workspace is not initialized; run /sp init');
  return {args:[matches[0].name,...args],expectedConfigHash:matches[0].configHash};
}

// Small argv parser for human slash commands; it never evaluates shell syntax.
export function commandWords(text) {
  const words=[];let word='',quote=null,active=false;
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(quote) {
      if(ch===quote) quote=null;
      else if(quote==='"'&&ch==='\\'&&['"','\\'].includes(text[i+1])) word+=text[++i];
      else word+=ch;
    } else if(ch==='"'||ch==="'") {quote=ch;active=true;}
    else if(/\s/.test(ch)) {if(active) words.push(word);word='';active=false;}
    else {word+=ch;active=true;}
  }
  check(!quote,'Unclosed quote');if(active)words.push(word);return words;
}
