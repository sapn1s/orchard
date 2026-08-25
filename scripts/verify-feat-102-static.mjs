#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'feat102-static-'));process.env.CLAUDE_STATION_DATA=path.join(tmp,'data');
const reg=await import('../src/server/registry.ts');const val=await import('../src/server/validate.ts');const cm=await import('../src/server/container-manager.ts');const b=await import('../src/server/dispatch-broker.ts');
let pass=0;function check(name,fn){fn();pass++;console.log(`PASS ${name}`)}
check('entitlement defaults OFF',()=>assert.equal(reg.defaultToolSettings().openaiDispatch,false));
check('entitlement validates and round-trip patch shape',()=>assert.equal(val.validateProjectPatch({settings:{tools:{openaiDispatch:true}}}).settings.tools.openaiDispatch,true));
check('entitlement rejects non-boolean',()=>assert.throws(()=>val.validateProjectPatch({settings:{tools:{openaiDispatch:'yes'}}}),/must be a boolean/));
const base={id:'p-one',name:'P',hostPath:tmp,isolation:'container',settings:{tools:{serena:false,playwright:false,openaiDispatch:true},mounts:[]}};
check('socket path derives only from project id under dataDir',()=>assert.equal(b.dispatchSocketPath(base),path.join(process.env.CLAUDE_STATION_DATA,'dispatch/p-one/dispatch.sock')));
check('bad/traversing project id refused',()=>assert.throws(()=>b.dispatchSocketPath({...base,id:'../p-two'}),/not safe/));
check('missing socket directory omitted (BUG-136)',()=>assert(!cm.desiredBinds(base).some(x=>x.containerPath===b.CONTAINER_DISPATCH_SOCKET_DIR)));
check('user mount cannot shadow socket directory',()=>assert(cm.validateMounts([{hostPath:tmp,containerPath:b.CONTAINER_DISPATCH_SOCKET_DIR,readOnly:true}],{requireHostPath:true}).some(x=>x.includes('managed'))));
check('user mount cannot expose broker state',()=>assert(cm.validateMounts([{hostPath:b.dispatchStateHome(),containerPath:'/mnt/stolen',readOnly:true}]).some(x=>x.includes('broker state'))));
const argv=cm.execArgv(base,{command:'claude',args:[],env:{ORCHARD_DISPATCH_SOCK:b.CONTAINER_DISPATCH_SOCKET,ORCHARD_DISPATCH_ENTITLED:'1'},execId:'x'});
check('container exec receives fixed container socket',()=>assert(argv.join(' ').includes(`ORCHARD_DISPATCH_SOCK=${b.CONTAINER_DISPATCH_SOCKET}`)));
const down=cm.execArgv(base,{command:'claude',args:[],env:{ORCHARD_DISPATCH_ENTITLED:'1',ORCHARD_DISPATCH_UNAVAILABLE_REASON:'bind failed'},execId:'y'}).join(' ');
check('unavailable container session gets reason and no socket env',()=>{assert.match(down,/ORCHARD_DISPATCH_UNAVAILABLE_REASON=bind failed/);assert(!down.includes('ORCHARD_DISPATCH_SOCK='))});
fs.rmSync(tmp,{recursive:true,force:true});console.log(`RESULT ${pass} PASS / 0 FAIL`);
