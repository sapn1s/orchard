#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const real=path.resolve('src/server/dispatch-client.mjs');
function run(file){return spawnSync(process.execPath,[file,'--check'],{env:{...process.env,ORCHARD_DISPATCH_ENTITLED:'0',ORCHARD_DISPATCH_SOCK:''},encoding:'utf8'});}
if(process.argv.includes('--must-fail-proof')){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feat102-prefx-'));const broken=path.join(dir,'dispatch-client.mjs');
  fs.writeFileSync(broken,fs.readFileSync(real,'utf8').replace("if (process.env.ORCHARD_DISPATCH_ENTITLED === '0') unavailable('this session was launched with settings.tools.openaiDispatch disabled'); else ",''));
  const r=run(broken);fs.rmSync(dir,{recursive:true,force:true});
  assert.notEqual(r.status,0,'MUST-FAIL proof: synthesized pre-fix client incorrectly reports entitlement OFF as available');
}else{
  const r=run(real);assert.notEqual(r.status,0);assert.match(r.stdout,/unavailable/);assert.match(r.stdout,/settings\.tools\.openaiDispatch/);
  console.log(`PASS entitlement OFF: exit=${r.status}; output=${JSON.stringify(r.stdout.trim())}`);
  const reason='host broker could not start: forced bind failure';
  const unavailable=spawnSync(process.execPath,[real,'--check'],{env:{...process.env,ORCHARD_DISPATCH_ENTITLED:'1',ORCHARD_DISPATCH_SOCK:'',ORCHARD_DISPATCH_UNAVAILABLE_REASON:reason},encoding:'utf8'});
  assert.notEqual(unavailable.status,0);assert.match(unavailable.stdout,/unavailable/);assert.match(unavailable.stdout,/forced bind failure/);
  console.log(`PASS unavailable check: exit=${unavailable.status}; same reason named`);

  const state=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'feat102-startfail-')),'data');process.env.CLAUDE_STATION_DATA=state;
  const bridge=await import('../src/server/agent-bridge.ts');const broker=await import('../src/server/dispatch-broker.ts');
  const host=path.dirname(state);const project={id:'forced-failure',name:'forced',hostPath:host,isolation:'direct',settings:{tools:{serena:false,playwright:false,openaiDispatch:true}}};
  fs.mkdirSync(broker.dispatchProjectDir(project),{recursive:true});fs.writeFileSync(path.join(broker.dispatchProjectDir(project),'unexpected'),'force broker refusal');
  const events=[];const got=await bridge.prepareDispatchForSession({project,onEvent:e=>events.push(e)});
  assert.match(got,/unexpected entries/);assert(events.some(e=>e.t==='error'&&e.fatal===false&&e.message.includes('unexpected entries')));assert(events.some(e=>e.t==='status'&&e.status.includes('without OpenAI dispatch')));
  const note=bridge.dispatchAvailabilityNote(true,'dispatch-client',got);assert.match(note,/enabled for this project but currently UNAVAILABLE/);assert.match(note,/unexpected entries/);
  console.log('PASS forced broker failure is non-fatal and prompt names the same reason');
  fs.rmSync(path.dirname(state),{recursive:true,force:true});
}
