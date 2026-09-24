import {defaultConfig} from './config.js';
import {execute,HELP} from './engine.js';
import {fileURLToPath} from 'node:url';
import {initWorkspace,workspaceArgs,commandWords} from './workspace-init.js';

export function setupHint() {
  const quote=s=>process.platform==='win32'?`'${s.replaceAll("'","''")}'`:`'${s.replaceAll("'","'\\''")}'`;
  const cli=fileURLToPath(new URL('./cli.js',import.meta.url));
  return `在受信任终端执行设备初始化（只需一次）：\n${process.platform==='win32'?'& ':''}${quote(process.execPath)} ${quote(cli)} --config ${quote(defaultConfig())} bootstrap\n\n完成后回到当前 DSH Workspace，输入 /sp init。密钥和 peer 仅在终端维护；不要把私钥或口令发进聊天。`;
}

// Exported for host-contract integration tests. Production always supplies the
// fixed config path and the invocation's agent cwd, never a chat-selected path.
export async function handleWorkspaceCommand(file,invocation) {
  const {rawInput,signal,agent}=invocation;
  try {
    const words=commandWords(rawInput),action=words.shift()||'help';
    if(action==='help') return {kind:'success',text:HELP};
    if(action==='setup') {
      if(words.length) throw new Error('setup takes no arguments');
      return {kind:'success',text:setupHint()};
    }
    const cwd=agent?.session?.header?.cwd;
    let result;
    if(action==='init') result=await initWorkspace(file,cwd,words,{signal});
    else {
      let resolution={args:words};
      if(['status','config','publish'].includes(action)) resolution=await workspaceArgs(file,action,words,cwd,signal);
      result=await execute(file,action,resolution.args,{signal,expectedConfigHash:resolution.expectedConfigHash});
      if(action==='publish'&&result?.token) result.confirm=`/sp publish ${result.token}`;
    }
    return {kind:'success',text:typeof result==='string'?result:JSON.stringify(result,null,2)};
  } catch(e) {return {kind:'error',text:`Secure Publish: ${e.message}`};}
}

export const name='secure-publish';
export const inject=['commands'];

// Shared command contract verified against dsh-v0.1.2-rc.1 and current upstream.
// No runtime import of Cordis: use the singleton and services supplied by the host.
// No model tool, HTTP listener, automatic publish hook, or embedded credential UI.
export function apply(ctx) {
  ctx.commands.register({
    name:'sp',
    description:'安全发布 / 接收源码（人工命令，minisign + age）',
    input:{hint:'setup | init | status | config | publish | help'},
    recordInput:false,
    handler:invocation=>handleWorkspaceCommand(defaultConfig(),invocation)
  });
}
