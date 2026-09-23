import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,inject} from '../lib/plugin.js';
test('plugin registers only a human command with the shared DSH/DSHA contract',async()=>{
  const registered=[];apply({commands:{register(d){registered.push(d);}}});
  assert.deepEqual(inject,['commands']);assert.equal(registered.length,1);
  const d=registered[0];assert.equal(d.name,'sp');assert.equal(d.recordInput,false);
  assert.equal(typeof d.input.hint,'string');
  const result=await d.handler({rawInput:' help ',signal:new AbortController().signal});
  assert.equal(result.kind,'success');assert(result.text.includes('minisign + age'));
});
