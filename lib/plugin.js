import {defaultConfig} from './config.js';
import {execute,HELP} from './engine.js';

export const name='secure-publish';
export const inject=['commands'];

// Shared command contract verified against dsh-v0.1.2-rc.1 and current upstream.
// No runtime import of Cordis: use the singleton and services supplied by the host.
// No model tool, HTTP listener, automatic publish hook, or embedded credential UI.
export function apply(ctx) {
  ctx.commands.register({
    name:'sp',
    description:'安全发布 / 接收源码（人工命令，minisign + age）',
    input:{hint:'help | doctor | publish/fetch/diff/apply/rollback <profile>'},
    recordInput:false,
    async handler({rawInput,signal}) {
      const words=rawInput.trim().split(/\s+/).filter(Boolean);
      if(!words.length || words[0]==='help') return {kind:'success',text:HELP};
      try {
        const result=await execute(defaultConfig(),words[0],words.slice(1),{signal});
        return {kind:'success',text:typeof result==='string'?result:JSON.stringify(result,null,2)};
      } catch(e) {return {kind:'error',text:`Secure Publish: ${e.message}`};}
    }
  });
}
