#!/usr/bin/env node
import {execute} from './engine.js';
import {defaultConfig} from './config.js';
import {setup} from './setup.js';

const args=process.argv.slice(2);
let config=defaultConfig();
if(args[0]==='--config') {args.shift();config=args.shift();if(!config) {console.error('--config requires a path');process.exit(2);}}
const action=args.shift()||'help';
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort(new Error('Cancelled; inspect status before retrying')));
try {
  if(action==='init') await setup(config);
  else {
    const result=await execute(config,action,args,{signal:controller.signal,interactive:!!process.stdin.isTTY});
    console.log(typeof result==='string'?result:JSON.stringify(result,null,2));
  }
} catch(e) {console.error(`Secure Publish: ${e.message}`);process.exitCode=1;}
