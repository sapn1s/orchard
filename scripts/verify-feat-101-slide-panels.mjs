#!/usr/bin/env node
/** FEAT-101: real-Brave/raw-CDP verification of all shared slide panels. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { PROJECTS, BOARD } from './lib/guide-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = path.join(ROOT, 'scratch'), RUN = path.join(SCRATCH, 'slide-verify');
const DATA = path.join(RUN, 'data'), STORE = path.join(RUN, 'store');
const PROFILE = path.join(RUN, 'profile'), FIXTURE = path.join(RUN, 'fixture');
const SHOTS = path.join(SCRATCH, 'slide-shots'), BRAVE = process.env.VERIFY_BROWSER || 'brave';
fs.rmSync(RUN, { recursive: true, force: true });
for (const d of [DATA, STORE, PROFILE, FIXTURE, SHOTS]) fs.mkdirSync(d, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws=ws; this.id=0; this.pending=new Map(); this.listeners=new Map(); }
  static async connect(url) {
    const ws=new WebSocket(url,{maxPayload:64*1024*1024});
    await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)}); const c=new Cdp(ws);
    ws.on('message',(raw)=>{const m=JSON.parse(raw); if(m.id&&c.pending.has(m.id)){const p=c.pending.get(m.id);c.pending.delete(m.id);m.error?p.j(new Error(m.error.message)):p.r(m.result)}else if(m.method)for(const fn of c.listeners.get(m.method)||[])fn(m.params)}); return c;
  }
  send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise((r,j)=>this.pending.set(id,{r,j}))}
  on(method,fn){const a=this.listeners.get(method)||[];a.push(fn);this.listeners.set(method,a)}
  async eval(expression){const x=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(x.exceptionDetails)throw new Error(x.exceptionDetails.exception?.description||x.exceptionDetails.text);return x.result?.value}
  async waitFor(expr,ms=20000){const t=Date.now();while(Date.now()-t<ms){try{if(await this.eval(expr))return}catch{}await sleep(80)}throw new Error(`timeout: ${expr}`)}
  close(){try{this.ws.close()}catch{}}
}
const freePort=()=>new Promise((r,j)=>{const s=net.createServer();s.once('error',j);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
const stop=(p)=>{if(p&&p.exitCode===null)try{p.kill('SIGTERM')}catch{}};
function seed(){const d=path.join(FIXTURE,'docs','bugs');fs.mkdirSync(d,{recursive:true});const rows=BOARD.rows.map(x=>`| ${x.id} | ${x.title} | ${x.owner} | ${x.status} | ${x.sev} |`).join('\n');fs.writeFileSync(path.join(d,'INDEX.md'),`# Board\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|---|---|---|---|---|\n${rows}\n`);for(const x of BOARD.rows)fs.writeFileSync(path.join(d,`${x.id}-fixture.md`),`# ${x.id} — ${x.title}\n\n- **Status:** OPEN\n`)}
let pass=0,fail=0;function check(n,label,ok,m){ok?pass++:fail++;console.log(`${ok?'PASS':'FAIL'} [${n}] ${label}\n  measured: ${JSON.stringify(m)}`)}
const q=JSON.stringify;
async function click(c,s){if(!await c.eval(`(()=>{const e=document.querySelector(${q(s)});if(!e)return false;e.click();return true})()`))throw new Error(`missing ${s}`)}
async function state(c,s){return c.eval(`(()=>{const p=document.querySelector(${q(s)}),z=getComputedStyle(p),w=document.querySelector('.window'),m=z.transform.match(/^matrix\\([^,]+,[^,]+,[^,]+,[^,]+,\\s*([^,]+)/);return{t:performance.now(),transform:z.transform,x:z.transform==='none'?0:Number(m&&m[1]),width:p.getBoundingClientRect().width,display:z.display,hidden:p.hidden,visibility:z.visibility,open:p.classList.contains('open'),settled:document.documentElement.classList.contains(p.id==='ticketsView'?'tickets-open':p.id==='guideView'?'guide-open':'__'),windowVisibility:getComputedStyle(w).visibility,scrollWidth:document.scrollingElement.scrollWidth,clientWidth:document.scrollingElement.clientWidth,rows:document.querySelectorAll('#tvList .tv-row').length}})()`)}
// One Runtime.evaluate stays armed in the page while rAF records what was
// actually painted. CDP round-trip latency therefore cannot bunch nominally
// separate samples onto the same main-thread instant.
function record(c,s,{ms=350,reverse=null,cross='none'}={}){return c.eval(`new Promise((resolve)=>{const p=document.querySelector(${q(s)}),w=document.querySelector('.window'),out=[],started=performance.now();let before=null,after=null,reversed=false;const snap=()=>{const z=getComputedStyle(p),m=z.transform.match(/^matrix\\([^,]+,[^,]+,[^,]+,[^,]+,\\s*([^,]+)/);return{t:performance.now(),transform:z.transform,x:z.transform==='none'?0:Number(m&&m[1]),width:p.getBoundingClientRect().width,display:z.display,hidden:p.hidden,visibility:z.visibility,open:p.classList.contains('open'),settled:document.documentElement.classList.contains(p.id==='ticketsView'?'tickets-open':p.id==='guideView'?'guide-open':'__'),windowVisibility:getComputedStyle(w).visibility,scrollWidth:document.scrollingElement.scrollWidth,clientWidth:document.scrollingElement.clientWidth,rows:document.querySelectorAll('#tvList .tv-row').length}};const frame=()=>{const v=snap();out.push(v);if(!reversed&&${q(reverse)}&&v.x>1&&v.x<v.width-1&&((${q(cross)}==='opening'&&v.x<=v.width*.55)||(${q(cross)}==='closing'&&v.x>=v.width*.45))){before=v;document.querySelector(${q(reverse)})?.click();after=snap();reversed=true}if(performance.now()-started<${ms})requestAnimationFrame(frame);else resolve({frames:out,before,after,reversed})};requestAnimationFrame(frame)})`)}
const mid=x=>Number.isFinite(x.x)&&x.x>1&&x.x<x.width-1;
const monotonic=(a,down,tol=2)=>a.every((x,i)=>!i||(down?x.x<=a[i-1].x+tol:x.x>=a[i-1].x-tol));
const motion=(a,down)=>{const m=a.filter(mid);return new Set(m.map(x=>Math.round(x.x))).size>=3&&monotonic(m,down)};
const measured=a=>{const m=a.filter(mid),xs=a.map(x=>x.x).filter(Number.isFinite);return{summary:{count:a.length,first:a[0]?.x,last:a.at(-1)?.x,min:Math.min(...xs),max:Math.max(...xs),distinctMid:new Set(m.map(x=>Math.round(x.x))).size},raw:a}};

let server,browser,cdp;
try{
  seed();const port=await freePort(),base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,[path.join(ROOT,'src/server/index.ts')],{cwd:ROOT,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',CLAUDE_STATION_DATA:DATA,CLAUDE_PROJECTS_DIR:STORE},stdio:['ignore','ignore','pipe']});server.stderr.on('data',d=>process.stderr.write(`[server] ${d}`));
  let healthy=false;for(let i=0;i<100&&!healthy;i++){try{healthy=(await fetch(`${base}/api/health`)).ok}catch{}if(!healthy)await sleep(100)}if(!healthy)throw new Error('server unhealthy');
  const reg=await(await fetch(`${base}/api/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostPath:FIXTURE,name:PROJECTS[0].name})})).json();if(!reg.project?.id)throw new Error(`registration failed ${JSON.stringify(reg)}`);
  browser=spawn(BRAVE,['--headless=new',`--user-data-dir=${PROFILE}`,'--remote-debugging-port=0','--no-first-run','--disable-extensions','--force-color-profile=srgb','--window-size=1440,900','about:blank'],{stdio:['ignore','ignore','pipe']});
  let dp=0;for(let i=0;i<100&&!dp;i++){try{dp=Number(fs.readFileSync(path.join(PROFILE,'DevToolsActivePort'),'utf8').split('\n')[0])}catch{}await sleep(100)}if(!dp)throw new Error('Brave CDP unavailable');
  const targets=await(await fetch(`http://127.0.0.1:${dp}/json/list`)).json();cdp=await Cdp.connect(targets.find(x=>x.type==='page').webSocketDebuggerUrl);await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await cdp.send('Page.navigate',{url:base});await cdp.waitFor(`window.__station&&document.querySelector('#cogBtn:not([disabled])')`,60000);await sleep(500);
  const surfaces=[{name:'drawer',el:'#drawer',open:'#cogBtn',close:'#dClose',kind:'visibility'},{name:'tickets',el:'#ticketsView',open:'#boardBtn',close:'#tvHome',kind:'hidden'},{name:'guide',el:'#guideView',open:'#guideBtn',close:'#gvHome',kind:'hidden'}];
  for(const s of surfaces){
    const openingP=record(cdp,s.el);await click(cdp,s.open);const opening=(await openingP).frames;
    check(1,`${s.name} opening slide`,opening[0].x>1&&motion(opening,true),measured(opening));
    check(4,`${s.name} session visibility opening`,s.name==='drawer'||(opening.filter(mid).every(x=>x.windowVisibility==='visible')&&opening.at(-1).windowVisibility==='hidden'),measured(opening));
    check(7,`${s.name} no opening overflow`,opening.every(x=>x.scrollWidth===x.clientWidth),opening.map(x=>({at:x.at,scroll:x.scrollWidth,client:x.clientWidth})));
    const closingP=record(cdp,s.el);await click(cdp,s.close);const closing=(await closingP).frames,cm=closing.filter(mid),hidden=s.kind==='visibility'?closing.at(-1).visibility==='hidden':closing.at(-1).hidden;
    check(2,`${s.name} closing slide`,motion(closing,false)&&cm.every(x=>x.visibility==='visible'&&!x.hidden)&&hidden,measured(closing));
    check(4,`${s.name} session visible on close`,s.name==='drawer'||closing.every(x=>x.windowVisibility==='visible'),measured(closing));
    check(7,`${s.name} no closing overflow`,closing.every(x=>x.scrollWidth===x.clientWidth),closing.map(x=>({at:x.at,scroll:x.scrollWidth,client:x.clientWidth})));
    const shown=x=>x.display!=='none'&&x.visibility==='visible'&&!x.hidden;
    const inBounds=x=>!shown(x)||(Number.isFinite(x.x)&&x.x>=0&&x.x<=x.width);
    const openSettled=x=>x.x<1&&x.open&&!x.hidden&&x.visibility==='visible'&&(s.name==='drawer'||x.settled);
    const closedSettled=x=>(s.kind==='visibility'?x.visibility==='hidden':x.hidden)&&!x.open&&(s.name==='drawer'||!x.settled)&&x.windowVisibility==='visible';
    /* No-teleport, measured against the panel's OWN top speed rather than a flat
       tolerance: across a reversal the panel may legitimately travel one frame's
       worth (mid-slide that is ~275px at 1440 wide), but it must never snap to
       the far edge. The bound is the largest per-frame delta observed BEFORE the
       reversal — a genuine snap is several times that. */
    const noTeleport=(r)=>{const pre=r.frames.filter(x=>x.t<=r.before.t);let peak=0;for(let i=1;i<pre.length;i++)peak=Math.max(peak,Math.abs(pre[i].x-pre[i-1].x));return Math.abs(r.after.x-r.before.x)<=Math.max(peak,2)+2};
    const ocP=record(cdp,s.el,{reverse:s.close,cross:'opening'});await click(cdp,s.open);const oc=await ocP,ocPost=oc.after?oc.frames.filter(x=>x.t>=oc.after.t&&shown(x)):[];
    const closeEnd=oc.frames.at(-1),openCloseContinuity=oc.reversed?noTeleport(oc):closedSettled(closeEnd);
    const settleOpenP=record(cdp,s.el);await click(cdp,s.open);await settleOpenP;
    /* Frames after the panel goes display:none report x=0 (a percentage translate
       cannot resolve without a box) — that is a measurement artefact, not a
       position, so the travel assertions look only at frames still on screen.
       The settled endpoint is asserted separately by closedSettled/openSettled. */
    const coP=record(cdp,s.el,{reverse:s.open,cross:'closing'});await click(cdp,s.close);const co=await coP,coPost=co.after?co.frames.filter(x=>x.t>=co.after.t&&shown(x)):[];
    const openEnd=co.frames.at(-1),closeOpenContinuity=co.reversed?noTeleport(co):openSettled(openEnd);
    const all=[...oc.frames,...co.frames];
    check(3,`${s.name} interruption both directions`,all.every(inBounds)&&openCloseContinuity&&monotonic(ocPost,false)&&closedSettled(closeEnd)&&closeOpenContinuity&&monotonic(coPost,true)&&openSettled(openEnd),{openThenClose:{...oc,frames:measured(oc.frames)},closeThenOpen:{...co,frames:measured(co.frames)},openCloseContinuity,closeOpenContinuity});
    const settleClosedP=record(cdp,s.el);await click(cdp,s.close);await settleClosedP;
  }
  // Reload so rows cached by the earlier motion passes cannot satisfy this test.
  await cdp.send('Page.reload',{ignoreCache:true});await cdp.waitFor(`window.__station&&document.querySelector('#boardBtn')`,60000);await sleep(300);
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/tickets*',requestStage:'Request'},{urlPattern:'*/api/board*',requestStage:'Request'}]});const paused=[];cdp.on('Fetch.requestPaused',e=>paused.push(e.requestId));await click(cdp,'#boardBtn');await sleep(100);const loading=await state(cdp,'#ticketsView');check(5,'ticket panel moves before data arrives',mid(loading)&&loading.rows===0&&paused.length>0,{at:100,...loading,pausedRequests:paused.length});for(const requestId of paused.splice(0))await cdp.send('Fetch.continueRequest',{requestId});await cdp.send('Fetch.disable');await sleep(250);await click(cdp,'#tvHome');await sleep(280);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  for(const s of surfaces){await click(cdp,s.open);const a=await state(cdp,s.el);await sleep(20);const b=await state(cdp,s.el);await click(cdp,s.close);const d=await state(cdp,s.el);await sleep(20);const e=await state(cdp,s.el);const h=s.kind==='visibility'?d.visibility==='hidden':d.hidden;check(6,`${s.name} reduced motion synchronous`,a.x===0&&b.x===0&&a.open&&!a.hidden&&a.visibility==='visible'&&(s.name==='drawer'||a.settled)&&!d.open&&h&&e.x===d.x&&(s.name==='drawer'||!d.settled),{openNow:a,openLater:b,closeNow:d,closeLater:e})}
  await cdp.send('Emulation.setEmulatedMedia',{features:[]});
  for(const theme of ['light','dark']){await cdp.eval(`document.documentElement.dataset.theme=${q(theme)}`);for(const s of surfaces){await click(cdp,s.open);await sleep(280);const cap=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),file=path.join(SHOTS,`${theme}-${s.name}-open.png`);fs.writeFileSync(file,Buffer.from(cap.data,'base64'));const end=await state(cdp,s.el),bytes=fs.statSync(file).size;check(8,`${theme} ${s.name} endpoint screenshot`,bytes>2000&&end.x===0&&end.visibility==='visible'&&!end.hidden,{file,bytes,endpoint:end});await click(cdp,s.close);await sleep(280)}}
  console.log(`\nSUMMARY ${pass} passed, ${fail} failed; screenshots: ${SHOTS}`);if(fail)process.exitCode=1;
}finally{cdp?.close();stop(browser);stop(server);await sleep(300)}
