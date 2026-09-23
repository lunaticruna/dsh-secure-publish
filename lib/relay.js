import {check, temporary, hash, MAX_PACKET} from './util.js';
import {git} from './artifact.js';

const base = p => `packets/${p.project}/${p.channel}`;
export const remoteURL = p => `https://github.com/${p.repository}.git`;
async function session(p,signal,fn) {
  return temporary(p.stateDir,async dir=>{
    const g = (args,o={})=>git(p,args,{cwd:dir,signal,...o});
    await g(['init','--bare','.']);
    await g(['remote','add','origin',remoteURL(p)]);
    const ref=`refs/heads/${p.branch}`;
    const probe=await g(['ls-remote','--exit-code','--heads','origin',ref],{codes:[0,2],limit:8192});
    let parent;
    if(probe.code===0) {
      await g(['fetch','--no-tags','--depth=1','origin',ref]);
      parent=(await g(['rev-parse','FETCH_HEAD'],{limit:1024})).stdout.toString().trim();
      check(/^[a-f0-9]{40,64}$/.test(parent),'Invalid relay commit');
    }
    return fn({g,parent});
  });
}
export async function download(p,signal) {
  return session(p,signal,async({g,parent})=>{
    check(parent,'Relay branch does not exist');
    const cipher=(await g(['show',`${parent}:${base(p)}/latest.age`],{limit:MAX_PACKET})).stdout;
    return {cipher,relayCommit:parent};
  });
}
export async function upload(p,cipher,sequence,signal) {
  return session(p,signal,async({g,parent})=>{
    const immutable=`${base(p)}/${String(sequence).padStart(12,'0')}.age`;
    if(parent) {
      const names=(await g(['ls-tree','-rz','--name-only',parent],{limit:4*1024*1024})).stdout.toString('utf8').split('\0').filter(Boolean);
      check(names.every(n=>/^packets\/[a-z0-9][a-z0-9_-]{0,47}\/[a-z0-9][a-z0-9_-]{0,47}\/(?:[0-9]{12}|latest)\.age$/.test(n)),
        'Relay branch contains unexpected files; use a dedicated encrypted relay branch');
      const found=await g(['ls-tree',parent,'--',immutable],{limit:4096});
      if(found.stdout.length) {
        const existing=(await g(['show',`${parent}:${immutable}`])).stdout;
        check(hash(existing)===hash(cipher),'Sequence already exists with different ciphertext; restore publisher state or choose a new channel');
        return {relayCommit:parent,alreadyPublished:true};
      }
      const prefix=base(p)+'/';
      const high=Math.max(0,...names.filter(n=>n.startsWith(prefix)&&/\/[0-9]{12}\.age$/.test(n)).map(n=>Number(n.slice(prefix.length,-4))));
      check(sequence>high,'Publisher sequence is behind relay history; restore local state or use a new channel');
      await g(['read-tree',parent]);
    }
    const object=(await g(['hash-object','-w','--stdin'],{input:cipher,limit:1024})).stdout.toString().trim();
    for(const file of [immutable,`${base(p)}/latest.age`]) await g(['update-index','--add','--cacheinfo','100644',object,file]);
    const tree=(await g(['write-tree'],{limit:1024})).stdout.toString().trim();
    const commit=(await g(['commit-tree',tree,...(parent?['-p',parent]:[]),'-m',`Encrypted snapshot ${sequence}`],{
      limit:1024,env:{GIT_AUTHOR_NAME:'Secure Publish',GIT_AUTHOR_EMAIL:'secure-publish@localhost',GIT_COMMITTER_NAME:'Secure Publish',GIT_COMMITTER_EMAIL:'secure-publish@localhost'}
    })).stdout.toString().trim();
    // No force push. A competing writer causes rejection instead of lost history.
    await g(['push','origin',`${commit}:refs/heads/${p.branch}`],{limit:16384});
    return {relayCommit:commit,alreadyPublished:false};
  });
}
