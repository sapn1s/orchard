import * as api from './api.js';
import { createSlidePanel } from './slide-panel.js';
import { ago, isDiffMeta, hunkMatch, durationLeftLabel } from './git-view-fmt.js';

const TEN_MINUTES = 600000, PAGE = 50;
export function createGitView(ctx) {
  const root = document.createElement('section'); root.className = 'git-view slide-panel'; root.hidden = true;
  root.innerHTML = `<header class="gt-top"><a class="gt-home" href="#/">← sessions</a><span class="gt-brand">Git</span><select class="gt-sel" aria-label="Project"></select><nav class="gt-views" aria-label="Git view"><button data-view="changes">Changes</button><button data-view="branches">Branches</button><button data-view="history">History</button><button data-view="stashes">Stashes</button></nav><span class="spacer"></span><span class="gt-error gt-view-error" role="status"></span><div class="gt-actions"><div class="gt-gitwrite" title="Whether AGENT sessions in this project may run git writes (commit/push). Your commits here are never blocked by this — it only governs agent git."><span class="gt-gw-dot"></span><span class="gt-gw-state">Agent git…</span><button class="gt-gw-allow" type="button" title="Allow agent commit/push in this project for 30 minutes">Allow 30 min</button><button class="gt-gw-settings" type="button" title="Choose whether agents may commit and push here, for how long (30 minutes or until you turn it off), and how they work.">Manage…</button><button class="gt-gw-revoke" type="button" hidden>Revoke</button></div><span class="gt-branch"></span><div class="gt-sync"><button></button><small></small></div></div></header><div class="gt-filters"><label class="gt-all"><input type="checkbox"><span>Select all</span></label><input class="gt-find" type="search"><span class="gt-summary"></span></div><div class="gt-body"><aside class="gt-side"><div class="gt-files" role="list"></div><form class="gt-commit"><input class="gt-title" required aria-label="Commit summary" placeholder="Summary (required)"><textarea class="gt-description" rows="1" aria-label="Commit description" placeholder="Description (optional)"></textarea><button>Commit</button><span class="gt-reason"></span><div class="gt-error"></div></form><form class="gt-create"><label>New branch<input class="gt-new-branch" required placeholder="Branch name"></label><button>Create and switch</button><span class="gt-reason"></span><div class="gt-error"></div></form></aside><article class="gt-diff"></article></div>`;
  document.body.append(root); const slide = createSlidePanel(root, { settledClass: 'git-open' });
  const q = s => root.querySelector(s), files = q('.gt-files'), diff = q('.gt-diff'), filter = q('.gt-find'), filters = q('.gt-filters');
  const allWrap=q('.gt-all'), all=q('.gt-all input'), allLabel=q('.gt-all span'), summary=q('.gt-summary'), commitForm=q('.gt-commit'), commit=q('.gt-commit button'), title=q('.gt-title'), description=q('.gt-description');
  const createForm=q('.gt-create'), create=q('.gt-create button'), branchName=q('.gt-new-branch'), error=q('.gt-commit .gt-error'), branchError=q('.gt-create .gt-error'), branchReason=q('.gt-create .gt-reason');
  const sync=q('.gt-sync button'), syncNote=q('.gt-sync small'), projectSelect=q('.gt-sel'), home=q('.gt-home'), viewError=q('.gt-view-error');
  // FEAT-108 r3 — the direct git-write permission toggle + visible state.
  // FEAT-164 — the "Allow permanently…" arm/confirm button is gone; the standing
  // policy (scoped commits / soft releases / cadence) lives in project Settings now,
  // reached by the "Settings…" button. The pill still shows "Allow 30 min" + Revoke.
  const gwWrap=q('.gt-gitwrite'), gwDot=q('.gt-gw-dot'), gwState=q('.gt-gw-state'), gwAllow=q('.gt-gw-allow'), gwRevoke=q('.gt-gw-revoke'), gwSettings=q('.gt-gw-settings');
  let grant=null, policy=null, gwBusy=false;
  // FEAT-190 — the agent-git policy is managed HERE (the git page) now, not the Settings drawer.
  let gwTimed=null, gwPanelOpen=false, gwDraft=null, gwReached=[], gwSummary='', gwPanel=null, gwErr='', gwLoaded=false, gwLoadFailed=false, gwLoadSeq=0, gwRevision=null;
  // FEAT-196 — the just-generated device-pairing token (shown ONCE), and a busy flag.
  let gwPairResult=null, gwPairBusy=false;
  let projectId, view='changes', data, stashData={stashes:[]}, branchData, historyData, filtered=[], selected, parent, request=0, generation=0, filterTimer, fetchTimer, fetchedAt;
  let loading=false, batching=false, committing=false, syncing=false, branchBusy=false, liveConfirmed=false, historyBusy=false, failures=0; const rows=new Map(), pending=new Set();
  const project=()=>ctx.getProject(projectId), fail=(m='')=>{(view==='branches'?branchError:error).textContent=m;viewError.textContent=m}, operation=(name,state,detail='')=>{root.dataset.lastOperation=name;root.dataset.lastResponse=state;root.dataset.lastDetail=detail}, stagedCount=()=>data?.changes.filter(c=>c.staged).length??0;
  const liveCount=()=>branchData?.liveSessions??0, liveBlocked=()=>liveCount()>0&&!liveConfirmed;
  function empty(s){diff.replaceChildren(Object.assign(document.createElement('div'),{className:'gt-empty',textContent:s}))}
  function stats(n,c){n.append(Object.assign(document.createElement('span'),{className:c.binary?'gt-binary':'gt-added',textContent:c.binary?'binary':`+${c.added??0}`}));if(!c.binary)n.append(Object.assign(document.createElement('span'),{className:'gt-removed',textContent:`−${c.removed??0}`}))}
  function renderDiff(path,r){const head=Object.assign(document.createElement('div'),{className:'gt-diff-head',textContent:path}),pre=document.createElement('div');pre.className='gt-diff-lines';let a=null,b=null;for(const text of(r.diff??'').split('\n').filter((x,i,a)=>!isDiffMeta(x)&&!(i===a.length-1&&x===''))){const line=document.createElement('div');line.className=text[0]==='+'?'add':text[0]==='-'?'del':text.startsWith('@@')?'hunk':'';const h=hunkMatch(text);if(h){a=+h[1];b=+h[2]}const x=document.createElement('span'),y=document.createElement('span');if(!h&&a!==null&&text[0]!=='+'){x.textContent=a;a+=1}if(!h&&b!==null&&text[0]!=='-'){y.textContent=b;b+=1}const code=document.createElement('code');code.textContent=text||' ';line.append(x,y,code);pre.append(line)}diff.replaceChildren(head,pre);if(r.truncated)diff.prepend(Object.assign(document.createElement('div'),{className:'gt-truncated',textContent:'Large diff truncated after 1 MB.'}))}
  function paint(){const s=data?.status, staged=stagedCount(), count=filtered.filter(c=>c.staged).length;root.querySelectorAll('.gt-views button').forEach(b=>b.className=`gt-btn${b.dataset.view===view?' on':''}`);q('[data-view="stashes"]').hidden=!stashData.stashes.length;q('.gt-branch').textContent=s?`${s.branch??`detached @ ${s.detachedAt??'?'}`} · ${s.dirty} changed${s.added===null?'':` · +${s.added} −${s.removed}${s.untrackedLinesIncluded===false?' (tracked only)':''}`}`:'';
    if(view==='changes'){summary.textContent=`${filtered.length} of ${data?.changes.length??0} · ${staged} staged`;all.checked=filtered.length>0&&count===filtered.length;all.indeterminate=count>0&&count<filtered.length;all.disabled=loading||batching||!filtered.length;allLabel.textContent=batching?'Working…':`Select all ${filtered.length}${filter.value.trim()?' matching':''}`;const why=!staged?'nothing staged':!title.value.trim()?'a title is required':'';commit.disabled=loading||committing||!!why;q('.gt-commit .gt-reason').textContent=committing?'':why;commit.textContent=committing?'Committing…':staged?`Commit ${staged} file${staged===1?'':'s'} to ${s?.branch??'HEAD'}`:`Commit to ${s?.branch??'HEAD'}`}
    const noRemote=s&&!s.remoteUrl&&!s.upstream,noUpstream=s&&!s.upstream&&!!s.remoteUrl,action=(s?.behind??0)>0?'pull':(s?.ahead??0)>0?'push':noUpstream?'publish':'fetch';sync.textContent=syncing?'Working…':noRemote?'No origin configured':action==='pull'?`Pull origin (↓${s.behind})`:action==='push'?`Push origin (↑${s.ahead})`:action==='publish'?`Publish ${s.branch??'branch'} to origin`:'Fetch origin';sync.dataset.action=action;sync.disabled=loading||syncing||!s||noRemote;syncNote.textContent=failures?'could not reach origin':noUpstream?`${s.branch??'This branch'} isn't on origin yet — commits stay local until you publish`:fetchedAt?`Last fetched ${ago(fetchedAt)}`:'';const dirty=s?.dirty??0;branchReason.textContent=dirty?`${dirty} files have uncommitted changes — commit them first. Orchard will not carry them across branches or discard them.`:liveBlocked()?`${liveCount()} session${liveCount()===1?'':'s'} live — confirm above before creating a branch.`:'';create.disabled=branchBusy||loading||dirty>0||liveBlocked()||!branchName.value.trim()}
  function configure(){const changes=view==='changes';allWrap.hidden=!changes;commitForm.hidden=!changes;createForm.hidden=view!=='branches';sync.closest('.gt-sync').hidden=!changes;filters.hidden=view==='stashes';filter.hidden=view==='stashes';filter.placeholder=view==='branches'?'Filter branches…':view==='history'?'Filter commits…':'Filter changed files…';filter.setAttribute('aria-label',filter.placeholder.slice(0,-1));selected=null;parent=null;rows.clear()}
  function buildFiles(list=data?.changes??[],stage=true){rows.clear();const frag=document.createDocumentFragment();for(const c of list){const el=document.createElement('div');el.className='gt-file';const box=document.createElement('input');box.type='checkbox';box.hidden=!stage;box.checked=c.staged;const name=document.createElement('button');name.type='button';name.className='gt-file-name';name.title=c.path;const slash=c.path.lastIndexOf('/'),leaf=document.createElement('strong'),dir=document.createElement('span');leaf.textContent=c.path.slice(slash+1);dir.textContent=slash<0?'':c.path.slice(0,slash+1);name.append(leaf,dir);const kind=Object.assign(document.createElement('span'),{className:`gt-kind ${c.type}`,textContent:c.type}),stat=document.createElement('span');stat.className='gt-stat';stats(stat,c);if(stage)box.onchange=()=>void toggle(c.path,box.checked);name.onclick=()=>void selectFile(c.path);el.append(box,name,kind,stat);frag.append(el);rows.set(c.path,{el,box,c,search:c.path.toLowerCase()})}files.replaceChildren(frag);applyFilter()}
  function applyFilter(){const n=filter.value.trim().toLowerCase();if(view==='changes'){filtered=[];for(const r of rows.values()){r.el.hidden=!!n&&!r.search.includes(n);if(!r.el.hidden)filtered.push(r.c)}}else{let shown=0;for(const r of rows.values()){r.el.hidden=!!n&&!r.search.includes(n);if(!r.el.hidden)shown+=1}summary.textContent=view==='branches'?`${shown} of ${(branchData?.branches.length??0)+(branchData?.remotes.length??0)} branches`:`${shown} commits loaded`}paint()}
  // Stage/unstage is a write whose response carries the current status. Like
  // every other async path here it is owned by the generation that issued it: a
  // stage POST resolving after the user has switched projects must NOT render
  // project A's status into project B, and its catch must not show A's error or
  // clear B's `loading` mid-load (BUG-203 r2). Token captured at click time.
  async function toggle(path,staged){const token=generation;pending.add(path);fail();try{const r=await guard(token,api.gitAction(project().id,'stage',{path,staged}));data.status=r.status;for(const p of r.paths){const row=rows.get(p.path);if(row){row.c.staged=p.staged;row.box.checked=p.staged}}ctx.onStatusChanged?.(r.status,projectId);pending.delete(path);paint()}catch(e){fail(e.message);loadChanges(true,token);pending.delete(path);paint()}}
  async function toggleAll(){if(all.disabled)return;const paths=filtered.map(c=>c.path),staged=all.checked,token=generation;batching=true;fail();operation('select-all','pending',`${paths.length} paths, staged=${staged}`);paint();try{const r=await guard(token,api.gitAction(project().id,'stage',{paths,staged}));operation('select-all','ok',`${r.paths.length} paths`);data.status=r.status;for(const p of r.paths){const row=rows.get(p.path);if(row){row.c.staged=p.staged;row.box.checked=p.staged}}ctx.onStatusChanged?.(r.status,projectId);batching=false;paint()}catch(e){operation('select-all',String(e.status??'error'),e.message);fail(e.message);loadChanges(true,token);batching=false;paint()}}
  // `request` supersedes an earlier diff click within the SAME view; `superseded`
  // additionally bails if the whole project/sub-view moved on while the diff was
  // in flight (so A's diff never lands in B's diff pane).
  async function selectFile(path){selected=path;for(const[k,r]of rows)r.el.dataset.selected=String(k===path);request+=1;const token=request,gen=generation;empty('Reading diff…');try{const r=await guard(gen,view==='changes'?api.gitAction(project().id,'diff',{path}):view==='stashes'?api.gitStashShow(project().id,parent,path):api.gitCommitDiff(project().id,parent,path));if(token===request)renderDiff(path,r)}catch(e){if(token===request)empty(e.message)}}
  // Leaf loaders carry the same rule as loadHistory/loadMore: `loading` and the
  // shared `data`/DOM they write are owned by the generation that started the
  // load. A load whose view has moved on (`superseded`) drops its result and
  // never clears `loading` — otherwise a superseded project-A load resolving
  // late clobbers project B's just-rendered view / clears B's loading flag. The
  // current view always re-sets `loading` at the top of its own leaf loader, so
  // skipping the stale clear can never wedge it (BUG-142: one authority via
  // `superseded`, threaded from loadView's token).
  async function loadChanges(quiet=false,token=generation){if(!quiet){loading=true;fail();paint()}try{const d=await guard(token,api.gitChanges(project().id));data=d;buildFiles();if(data.changes[0])void selectFile(data.changes[0].path);else empty('No uncommitted changes.');ctx.onStatusChanged?.(data.status,projectId);loading=false;paint()}catch(e){fail(e.message);files.replaceChildren();empty(e.message);loading=false;paint()}}
  function branchRow(b){const el=document.createElement('div');el.className='gt-branch-row';el.dataset.current=String(b.current);const button=Object.assign(document.createElement('button'),{type:'button',className:'gt-branch-name',textContent:b.name,disabled:b.current||!!data?.status.dirty||branchBusy||liveBlocked()});button.onclick=()=>void switchBranch(b.name);el.append(button,Object.assign(document.createElement('span'),{className:'gt-current',textContent:b.current?'current':''}),Object.assign(document.createElement('span'),{className:'gt-upstream',textContent:b.upstream??'no upstream'}),Object.assign(document.createElement('span'),{className:'gt-track',textContent:b.upstream?`↑${b.ahead??0} ↓${b.behind??0}`:''}));return el}
  // A remote-tracking branch, checked out as a new local tracking branch. A
  // `.../HEAD` symref is not a branch, so it stays a plain, inert label.
  function remoteRow(name){const head=name.endsWith('/HEAD');const local=name.slice(name.indexOf('/')+1);const already=branchData.branches.some(b=>b.name===local);const el=document.createElement('div');el.className='gt-branch-row';el.dataset.remote='true';const button=Object.assign(document.createElement('button'),{type:'button',className:'gt-branch-name',textContent:name,disabled:head||!!data?.status.dirty||branchBusy||liveBlocked()});if(!head)button.onclick=()=>void checkoutRemote(name);el.append(button,Object.assign(document.createElement('span'),{className:'gt-current',textContent:''}),Object.assign(document.createElement('span'),{className:'gt-upstream',textContent:head?'':already?`→ ${local}`:`track as ${local}`}),Object.assign(document.createElement('span'),{className:'gt-track gt-checkout',textContent:head?'':'check out'}));return el}
  // The live-session warning (the user's "sessions keep working on some branch"
  // hazard). Warn + require an explicit confirm; never block outright — a repo
  // stuck on a branch with live sessions must still be switchable, and git's own
  // dirty-tree refusal already guards uncommitted work.
  function liveBanner(){const n=liveCount();if(!n)return null;const el=document.createElement('div');el.className='gt-live-warn';el.dataset.confirmed=String(!liveBlocked());el.append(Object.assign(document.createElement('span'),{className:'gt-live-msg',textContent:`${n} session${n===1?'':'s'} live in this project — switching branch changes files under ${n===1?'a':'the'} running agent.`}));if(liveBlocked()){const btn=Object.assign(document.createElement('button'),{type:'button',className:'gt-live-confirm',textContent:'Switch anyway'});btn.onclick=()=>{liveConfirmed=true;buildBranches();paint()};el.append(btn)}else el.append(Object.assign(document.createElement('span'),{className:'gt-live-ok',textContent:'switching enabled'}));return el}
  function buildBranches(){rows.clear();const frag=document.createDocumentFragment();const warn=liveBanner();if(warn)frag.append(warn);for(const b of branchData.branches){const el=branchRow(b);frag.append(el);rows.set(`l:${b.name}`,{el,search:`${b.name} ${b.upstream??''}`.toLowerCase()})}if(branchData.remotes.length)frag.append(Object.assign(document.createElement('div'),{className:'gt-group',textContent:'Remote branches'}));for(const name of branchData.remotes){const el=remoteRow(name);frag.append(el);rows.set(`r:${name}`,{el,search:name.toLowerCase()})}files.replaceChildren(frag);applyFilter();empty('Choose a local branch to switch to it, or a remote branch to check it out.')}
  async function loadBranches(token=generation){loading=true;liveConfirmed=false;fail();paint();try{const[b,d]=await guard(token,Promise.all([api.gitBranches(project().id),api.gitChanges(project().id)]));branchData=b;data=d;buildBranches();ctx.onStatusChanged?.(data.status,projectId);loading=false;paint()}catch(e){fail(e.message);empty(e.message);loading=false;paint()}}
  // Write paths carry the same rule as the load paths (BUG-142/BUG-203): the
  // busy flag and the shared state a follow-up renders are owned by the
  // generation that started the write. A git write itself always completes
  // server-side; what a superseded continuation must NOT do is render the old
  // project's branches/changes into the view the user has since switched to, or
  // clear the SHARED branchBusy/committing flag that the now-current view's own
  // write may own. Capture the token at click/submit time, thread it into the
  // refresh, and gate every shared-state write + flag-clear on `!superseded`.
  // open() owns the cross-generation reset (branchBusy/committing below).
  async function refreshBranch(token=generation){try{const[b,d,s]=await guard(token,Promise.all([api.gitBranches(project().id),api.gitChanges(project().id),api.gitStashes(project().id)]));branchData=b;data=d;stashData=s;buildBranches();ctx.onStatusChanged?.(data.status,projectId)}catch(e){void e}}
  async function switchBranch(name){if(data?.status.dirty||branchBusy||liveBlocked())return;const token=generation;branchBusy=true;buildBranches();try{const r=await guard(token,api.gitSwitchBranch(project().id,name));ctx.notify(`switched to ${r.switched}`);refreshBranch(token);branchBusy=false;paint()}catch(e){fail(e.message);refreshBranch(token);branchBusy=false;paint()}}
  async function checkoutRemote(name){if(data?.status.dirty||branchBusy||liveBlocked())return;const token=generation;branchBusy=true;buildBranches();try{const r=await guard(token,api.gitCheckoutRemote(project().id,name));ctx.notify(`checked out ${r.checkedOut} tracking ${r.tracking}`);refreshBranch(token);branchBusy=false;paint()}catch(e){fail(e.message);refreshBranch(token);branchBusy=false;paint()}}
  function parentRow(key,title,meta,fn,head=false){const el=document.createElement('button');el.type='button';el.className='gt-parent-row';el.dataset.selected=String(key===parent);if(head)el.append(Object.assign(document.createElement('em'),{textContent:'HEAD'}));el.append(Object.assign(document.createElement('strong'),{textContent:title}),Object.assign(document.createElement('span'),{textContent:meta}));el.onclick=fn;return el}
  function detailBack(label,fn){const back=Object.assign(document.createElement('button'),{type:'button',className:'gt-back',textContent:`← ${label}`});back.onclick=()=>{selected=null;parent=null;fn()};files.prepend(back)}
  function buildStashes(){const frag=document.createDocumentFragment();for(const s of stashData.stashes)frag.append(parentRow(s.ref,s.ref,`${s.branch?`${s.branch} · `:''}${s.subject} · ${ago(s.timestamp)}`,()=>void selectStash(s.ref)));files.replaceChildren(frag);summary.textContent=`${stashData.stashes.length} stash${stashData.stashes.length===1?'':'es'}`;empty(stashData.stashes.length?'Choose a stash to list its files.':'No stashed changes.')}
  async function loadStashes(token=generation){loading=true;paint();try{const s=await guard(token,api.gitStashes(project().id));stashData=s;buildStashes();loading=false;paint()}catch(e){fail(e.message);empty(e.message);loading=false;paint()}}
  async function selectStash(ref){const id=project().id,token=generation;parent=ref;buildStashes();empty('Reading stashed files…');fail();operation('stash-show','pending',ref);try{const r=await guard(token,api.gitStashShow(id,ref));operation('stash-show','ok',`${r.files.length} files`);buildFiles(r.files,false);detailBack('All stashes',buildStashes);summary.textContent=`${r.files.length} files in ${ref}`;if(r.files[0])void selectFile(r.files[0].path);else empty('This stash has no files.')}catch(e){operation('stash-show',String(e.status??'error'),e.message);fail(e.message);empty(e.message)}}
  function historyRows(commits,offset=0){const frag=document.createDocumentFragment();for(const [i,c]of commits.entries()){const el=parentRow(c.sha,c.shortSha,`${c.subject} · ${c.author} · ${ago(c.date)}`,()=>void selectCommit(c.sha),offset+i===0);frag.append(el);rows.set(c.sha,{el,search:`${c.shortSha} ${c.subject} ${c.author}`.toLowerCase()})}return frag}
  function historyMore(){files.querySelector('.gt-more')?.remove();if(historyData.nextCursor){const more=Object.assign(document.createElement('button'),{type:'button',className:'gt-more',textContent:historyBusy?'Loading…':'Load more',disabled:historyBusy});more.onclick=()=>void loadMore();files.append(more)}}
  function buildHistory(){rows.clear();files.replaceChildren(historyRows(historyData.commits));historyMore();applyFilter();if(!parent)empty('Choose a commit to list its changed files.')}
  // The ONE authority for "is the response I'm holding still for the current
  // view?" — `generation` is bumped by open() on every project/sub-view switch;
  // a captured token that no longer matches means the user has moved on.
  const superseded = (token) => token !== generation;
  // The ONE async boundary in this module (ARCH-010). EVERY git-view async
  // operation is `await guard(token, <promise>)` — nothing else here may `await`
  // or use `.then`/`.catch`/`.finally` (enforced structurally by
  // scripts/verify-gitview-async-token.mjs, a parsed scan). guard resolves to
  // the value ONLY while the captured generation is still current; if the view
  // has moved on it returns a promise that NEVER settles, so the awaiting
  // continuation never runs and cannot touch shared state or the DOM. A
  // rejection is forwarded only while current, so a real error reaches the
  // caller's catch but a superseded failure is swallowed. This is why no caller
  // needs to remember a `superseded` check after its await: reaching the code
  // after `await guard(...)` IS the proof the token is still current. Internal
  // async loaders are therefore never awaited — they are fired (they self-guard)
  // — so the only await anywhere is of guard() itself.
  // A superseded continuation must never run AND must be COLLECTABLE. Each
  // superseded resolution adopts its OWN fresh never-settling promise, not a
  // shared module-lifetime one: a shared NEVER is a GC root and its reaction
  // list pins every superseded op's async frame forever → unbounded growth per
  // project switch (BUG-203 r4). A per-call `new Promise(()=>{})` is referenced
  // only by the frame that awaits it — an unrooted cycle — so the pair is
  // collected once the view has moved on.
  const guard = (token, promise) => promise.then((v) => superseded(token) ? new Promise(() => {}) : v, (e) => superseded(token) ? new Promise(() => {}) : Promise.reject(e));
  // A single navigation fires open() twice (hashchange AND popstate both route
  // git, and a Back/Forward across sub-views raises both), so two loadHistory
  // race. Without the token guard a superseded one resolves late and rebuilds
  // the list — silently discarding a page loadMore() had already appended, so
  // "Load more adds nothing" (BUG-142). History is the only sub-view carrying
  // accumulated client state a rebuild can destroy. Bind to open()'s generation
  // and never touch shared state or the DOM once superseded.
  async function loadHistory(token=generation){if(superseded(token))return;loading=true;paint();try{const r=await guard(token,api.gitLog(project().id,{limit:PAGE}));historyData=r;buildHistory();loading=false;paint()}catch(e){fail(e.message);empty(e.message);loading=false;paint()}}
  // loadMore APPENDS to the current view. Bound to the same generation token:
  // navigating to another project (or sub-view) while this page fetch is in
  // flight would otherwise splice project A's commits into project B's rendered
  // list — silent cross-project wrongness, the exact class BUG-142 exists to
  // kill and the one path the first fix did not cover. historyBusy is the
  // re-entry guard, and it is OWNED by the current generation: only a load-more
  // that is still current (`!superseded`) may clear it. A superseded one must
  // NOT touch it — clearing the SHARED flag would re-open the guard for another
  // view's in-flight load-more, letting a duplicate page-2 fetch fire and
  // corrupting that view's history (BUG-142 r4 clean-room BROKEN verdict: B
  // ends 150 rows / 100 unique). open() owns the cross-generation reset.
  async function loadMore(){if(!historyData.nextCursor||historyBusy)return;const token=generation,id=project().id,cursor=historyData.nextCursor;historyBusy=true;fail();operation('history-more','pending',`cursor=${cursor}`);historyMore();try{const r=await guard(token,api.gitLog(id,{limit:PAGE,cursor}));const offset=historyData.commits.length;historyData={commits:[...historyData.commits,...r.commits],nextCursor:r.nextCursor};files.querySelector('.gt-more')?.before(historyRows(r.commits,offset));operation('history-more','ok',`${r.commits.length} rows, next=${r.nextCursor??'null'}`);applyFilter();historyBusy=false;historyMore()}catch(e){operation('history-more',String(e.status??'error'),e.message);fail(e.message);historyBusy=false;historyMore()}}
  async function selectCommit(sha){parent=sha;buildHistory();empty('Reading commit files…');const token=generation;try{const r=await guard(token,api.gitCommitFiles(project().id,sha));buildFiles(r.files,false);detailBack('Commit history',buildHistory);summary.textContent=`${r.files.length} files in ${sha.slice(0,7)}`;if(r.files[0])void selectFile(r.files[0].path);else empty('This commit has no files.')}catch(e){empty(e.message)}}
  // loadView dispatches the right leaf loader WITHOUT awaiting it (each self-
  // guards). Its only await is the guarded status prefetch for history/stashes.
  async function loadView(token=generation){configure();filter.value='';if(view!=='changes'&&view!=='branches'){try{const status=await guard(token,api.gitStatus(project().id));data={status,changes:[]};ctx.onStatusChanged?.(status,projectId)}catch(e){void e}}if(view==='changes')loadChanges(false,token);else if(view==='branches')loadBranches(token);else if(view==='history')loadHistory(token);else loadStashes(token)}
  // The current-project option is set synchronously by open(); projects() only
  // APPENDS the other repos, each behind guard — so a superseded projects() can
  // never wipe or repopulate the dropdown open() just set for the new view
  // (BUG-203 r3: open()'s continuation must not touch state after the boundary).
  async function projects(token=generation){for(const p of ctx.getProjects()){if(p.id===projectId)continue;try{const s=await guard(token,api.gitStatus(p.id));if(s?.repo)projectSelect.append(Object.assign(document.createElement('option'),{value:p.id,textContent:p.name}))}catch{}}}
  function clearFetch(){clearTimeout(fetchTimer);fetchTimer=null}function schedule(t){clearFetch();if(slide.isOpen()&&t===generation)fetchTimer=setTimeout(()=>void fetchNow(t),Math.min(TEN_MINUTES*(2**failures),3600000))}
  async function fetchNow(t,explicit=false){if(!slide.isOpen()||superseded(t))return;if(data?.status&&!data.status.remoteUrl&&!data.status.upstream)return;if(document.hidden||syncing){schedule(t);return}syncing=true;paint();try{const r=await guard(t,api.gitAction(project().id,'fetch'));data=data??{};data.status=r.status;fetchedAt=Date.now();failures=0;fail();ctx.onStatusChanged?.(r.status,projectId);syncing=false;paint();schedule(t)}catch(e){failures+=1;if(explicit)fail(e.message);syncing=false;paint();schedule(t)}}
  // FEAT-108 r3 — visible state: is agent git permitted for this project, until when?
  // FEAT-164 — a STANDING grant is now a declared project policy (none | scoped |
  // release). The pill reflects it: a timed grant keeps its "N left" text; a standing
  // commit grant reads "Agent git · soft releases" (release mode) or "· scoped". The
  // standing policy is set in project Settings ("Settings…"); the pill only offers the
  // explicit 30-minute grant and a Revoke (which clears both, server-side).
  const gwStanding=()=>policy&&policy.mode&&policy.mode!=='none'?policy.mode:null;
  function gwLabel(){
    if(grant&&grant.scope!=='permanent'){if(grant.scope==='once')return'Agent git: one write allowed';const ms=Math.max(0,Date.parse(grant.expiresAt)-Date.now());return`Agent git allowed · ${durationLeftLabel(ms)} left`}
    const s=gwStanding();
    if(s==='release')return'Agent git · soft releases';
    if(s==='scoped')return policy&&policy.branchMode&&policy.branchMode.enabled?'Agent git · ticket branches':'Agent git on · until you turn it off';
    if(grant&&grant.scope==='permanent')return'Agent git on · until you turn it off';
    return'Agent git blocked';
  }
  function gwTitle(){
    if(grant&&grant.scope!=='permanent')return`${grant.scope==='once'?'One commit or push':'A timed pass'}, given ${grant.grantedVia==='request-approval'?'when you approved an agent’s request':'with “Allow 30 min”'}; ends ${new Date(grant.expiresAt).toLocaleString()}`;
    const s=gwStanding();
    if(s==='release')return'On until you turn it off, as soft releases: agents never commit or push directly; finished, verified work is bundled into numbered release commits. Change it with Manage….';
    if(s==='scoped')return'Agents may commit here until you turn it off (Manage…). Every commit and push is still checked for leaks.';
    if(grant&&grant.scope==='permanent')return'Agents may commit here until you turn it off (Manage…).';
    return'Agents can’t commit or push in this project. Allow 30 min, or Manage… to allow it until you turn it off.';
  }
  // The pill is "on" for a timed grant OR a standing commit policy.
  const gwOn=()=>!!grant||!!gwStanding();
  function paintGrant(){const on=gwOn();const scope=grant?grant.scope:(gwStanding()?'permanent':'none');gwWrap.dataset.on=String(on);gwWrap.dataset.scope=scope;gwWrap.dataset.mode=gwStanding()??'none';gwState.textContent=gwLabel();gwState.title=gwTitle();gwAllow.hidden=on;gwAllow.disabled=gwBusy||!projectId;gwSettings.disabled=!projectId;gwRevoke.hidden=!on;gwRevoke.disabled=gwBusy}
  // FEAT-190 r3 (IV run 01a13c5b BROKEN) — `gwLoaded` guards the panel against seeding a draft
  // before the server policy has arrived. Opening "Manage" during the in-flight loadGrant used to
  // seed gwDraftFrom(null) → a default-ON commit+push draft, so an untouched Save silently flipped
  // an EXISTING push:false grant to push:true (a silent over-grant). The panel now shows a loading
  // state until this resolves; on resolution, an open panel is RE-SEEDED from the real policy.
  // FEAT-190 r3 (IV run 01a13c6d) — `gwLoadSeq` makes the LATEST loadGrant the sole authority over
  // the shared grant state (policy/grant/gwLoaded/gwDraft). `guard`'s generation token only
  // supersedes across navigations; two loadGrant calls within ONE generation (open()'s initial load
  // AND the re-fetch when the panel opens) both resolve, and a LATE initial response used to re-seed
  // the draft — discarding the user's in-progress push-OFF edit (silent over-grant). A superseded
  // loadGrant (seq ≠ gwLoadSeq) now touches nothing. Same pattern as `request` for diffs.
  async function loadGrant(token=generation){gwLoadSeq+=1;const seq=gwLoadSeq;if(!projectId){grant=null;gwTimed=null;policy=null;gwReached=[];gwSummary='';gwDraft=null;gwRevision=null;gwLoaded=true;gwLoadFailed=false;paintGrant();if(gwPanelOpen)paintGwPanel();return}try{const r=await guard(token,api.gitWriteGrant(projectId));if(seq!==gwLoadSeq)return;grant=r?.grant??null;gwTimed=r?.timedGrant??null;policy=r?.policy??null;gwRevision=r?.revision??null;gwReached=Array.isArray(r?.reachedRepos)?r.reachedRepos:[];gwSummary=r?.summary??'';gwDraft=null;gwLoaded=true;gwLoadFailed=false;paintGrant();if(gwPanelOpen){gwDraft=gwDraftFrom(policy);paintGwPanel();}}catch{if(seq!==gwLoadSeq)return;grant=null;gwTimed=null;policy=null;gwReached=[];gwDraft=null;gwRevision=null;gwLoaded=false;gwLoadFailed=true;paintGrant();if(gwPanelOpen)paintGwPanel();}}
  // FEAT-190 — the edit buffer the panel mutates, seeded from the server policy.
  // FEAT-190 r3 — a FRESH grant (no stored policy yet, mode none) DEFAULTS commit AND push ON
  // ("if i grant, then i have granted … default should allow"). An EXISTING policy reflects its
  // stored flags exactly, so a previously-set push:false (an explicit opt-out, or a legacy
  // release grant) is preserved and never silently re-enabled. Push is turned off only by the
  // explicit push toggle below.
  function gwDraftFrom(pol){const r=(pol&&pol.release)||{};const bm=(pol&&pol.branchMode)||{};const granted=!!(pol&&pol.mode&&pol.mode!=='none');return{commit:granted?!!pol.commit:true,push:granted?!!pol.push:true,scope:(pol&&typeof pol.scope==='string')?pol.scope:'',optIn:!!r.opt_in,minTickets:r.minTickets==null?'':String(r.minTickets),maxWaitHours:r.maxWaitHours==null?'':String(r.maxWaitHours),minIntervalHours:r.minIntervalHours==null?'':String(r.minIntervalHours),tagPrefix:r.tagPrefix==null?'':String(r.tagPrefix),overrides:{},branchEnabled:!!bm.enabled,branchAgentLand:!!bm.agentLand,timedMinutes:30,timedCustom:false};}
  // FEAT-201 — the timed-pass duration picker. Presets the user can grant without re-granting every
  // 30 min; the custom field is capped at 1440 (24h = the server ceiling MAX_GRANT_MS) so a chosen
  // duration is NEVER silently clamped. Anything longer than a day is "Until I turn it off".
  const GW_DUR_PRESETS=[{min:30,label:'30 min'},{min:60,label:'1 hour'},{min:480,label:'8 hours'},{min:1440,label:'24 hours'}];
  const GW_MAX_TIMED_MIN=1440;
  const gwDurLabel=(min)=>{const m=Math.round(Number(min)||0);if(m<60)return `${m} min`;const hr=m/60;const hh=Number.isInteger(hr)?hr:Math.round(hr*10)/10;return `${hh} hour${hh===1?'':'s'}`;};
  const gwClampMin=(min)=>Math.min(GW_MAX_TIMED_MIN,Math.max(1,Math.round(Number(min)||0)));
  function gwPayload(){const d=gwDraft,int=s=>{const n=Number(s);return s!==''&&Number.isFinite(n)?n:undefined;},release={opt_in:d.optIn};for(const k of['minTickets','maxWaitHours','minIntervalHours']){const v=int(d[k]);if(v!==undefined)release[k]=v;}if(d.tagPrefix.trim())release.tagPrefix=d.tagPrefix.trim();const repoOverrides={};for(const[k,ov]of Object.entries(d.overrides))repoOverrides[k]=ov;
  // FEAT-191 — ALWAYS carry branchMode so a panel save never silently drops an enabled branch-mode
  // grant. Mutually exclusive with release opt-in (the server refuses the combo); the toggles below
  // keep them exclusive, so this never submits both enabled.
  const branchMode={enabled:!!d.branchEnabled,providers:['claude'],agentLand:!!d.branchEnabled&&!!d.branchAgentLand,pilot:true};
  return{commit:d.commit,push:d.commit&&d.push,scope:d.scope.trim()||null,release,...(Object.keys(repoOverrides).length?{repoOverrides}:{}),branchMode,revision:gwRevision};}
  gwAllow.onclick=async()=>{if(gwBusy||!projectId)return;const token=generation;gwBusy=true;paintGrant();try{const r=await guard(token,api.grantGitWrite(projectId,{scope:'duration',minutes:30}));grant=r?.grant??null;gwTimed=grant;ctx.notify('agent git writes allowed for 30 minutes');if(gwPanelOpen){gwDraft=null;paintGwPanel();}gwBusy=false;paintGrant()}catch(e){fail(e.message);gwBusy=false;paintGrant()}};
  gwRevoke.onclick=async()=>{if(gwBusy||!projectId)return;const token=generation;gwBusy=true;paintGrant();try{await guard(token,api.revokeGitWrite(projectId));grant=null;gwTimed=null;policy=null;ctx.notify('agent git writes revoked');gwBusy=false;paintGrant();if(gwPanelOpen){gwDraft=null;paintGwPanel();}}catch(e){fail(e.message);gwBusy=false;paintGrant()}};
  // FEAT-190 — "Manage…" opens the agent-git panel IN PLACE (the controls moved off the Settings
  // drawer). A tiny DOM helper keeps the panel readable without a framework.
  function h(tag,props,...kids){const e=document.createElement(tag);for(const[k,v]of Object.entries(props||{})){if(k==='class')e.className=v;else if(k==='text')e.textContent=v;else if(k.startsWith('on')&&typeof v==='function')e[k.toLowerCase()]=v;else if(v!=null)e.setAttribute(k,String(v));}for(const kid of kids.flat())if(kid!=null)e.append(kid.nodeType?kid:document.createTextNode(String(kid)));return e;}
  function gwToggle(label,on,disabled,onflip){const b=h('button',{type:'button',class:'gt-gw-sw','aria-pressed':String(!!on),'data-on':String(!!on)},on?'on':'off');b.disabled=!!disabled;if(!disabled)b.onclick=onflip;return h('label',{class:'gt-gw-row'},h('span',{text:label}),b);}
  // FEAT-190 r3 — a save carries the rendered revision (gwPayload) so the server can reject a stale
  // write (409). On 409 we NEVER auto-retry: we re-fetch the current policy (a fresh revision +
  // values) and tell the user to review and save again. Revoke (body===null) is not revision-gated.
  async function gwSave(body,msg){if(gwBusy||!projectId)return;const token=generation;gwBusy=true;gwErr='';paintGwPanel();try{const r=await guard(token,body===null?api.deleteGitWritePolicy(projectId):api.putGitWritePolicy(projectId,body));policy=r?.policy??null;gwRevision=r?.revision??gwRevision;gwSummary=r?.summary??gwSummary;if(Array.isArray(r?.reachedRepos))gwReached=r.reachedRepos;gwDraft=null;ctx.notify(msg);gwBusy=false;paintGrant();paintGwPanel();}catch(e){if(e&&e.status===409){gwErr='These settings changed in another tab or session — review the current values below, then save again.';gwBusy=false;gwDraft=null;gwLoaded=false;paintGwPanel();void loadGrant(token);}else{gwErr=e.message||String(e);gwBusy=false;paintGwPanel();}}}
  // 2026-10-16 (panel clarity) — the live TIMED pass (30 minutes / one write / an approved agent
  // request), shown with its expiry even when a standing grant also exists (grantView reports the
  // standing one first, so the GET carries `timedGrant` separately).
  function gwTimedView(){const t=gwTimed||(grant&&grant.scope!=='permanent'?grant:null);if(!t||!t.expiresAt)return null;const ms=Date.parse(t.expiresAt)-Date.now();return Number.isFinite(ms)&&ms>0?t:null;}
  const gwClock=iso=>{const t=new Date(iso);return Number.isNaN(t.getTime())?'':t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});};
  const gwModeName=pol=>pol&&pol.branchMode&&pol.branchMode.enabled?'ticket branches':pol&&pol.mode==='release'?'soft releases':'direct commits';
  // One plain status line: is agent git on, and for how long.
  function gwStatusBlock(standing,timed){
    let state='off',title='Off: agents can’t commit or push in this project.',sub='Your own commits are never blocked.';
    const via=timed&&timed.grantedVia==='request-approval'?'Given when you approved an agent’s request.':'Given with “Allow 30 min”.';
    if(standing){state='standing';title='On until you turn it off';sub=`Agents ${policy.push?'commit and push':'commit (no push)'} · ${gwModeName(policy)}. Saved in this project’s settings, so it survives restarts.`;}
    else if(timed&&timed.scope==='once'){state='once';title='On for one commit or push';sub=`It turns itself off after that one write (or at ${gwClock(timed.expiresAt)} if unused). ${via}`;}
    else if(timed){state='timed';const ms=Math.max(0,Date.parse(timed.expiresAt)-Date.now());title=`On until ${gwClock(timed.expiresAt)} (${durationLeftLabel(ms)} left)`;sub=`A timed pass: it ends on its own, or sooner if Orchard restarts. ${via}`;}
    const box=h('div',{class:'gt-gw-status','data-state':state},h('span',{class:'gt-gw-status-dot'}),h('div',{},h('b',{class:'gt-gw-status-t',text:title}),h('p',{class:'gt-gw-sum',text:sub})));
    if(standing&&timed)box.append(h('p',{class:'gt-gw-sum gt-gw-status-also',text:`A timed pass is also on until ${gwClock(timed.expiresAt)}.`}));
    return box;
  }
  // A single-choice group (radio semantics) with a one-line plain explanation per option.
  function gwChoice(label,cls,opts,value,disabled,onpick){
    const grp=h('div',{class:`gt-gw-sec gt-gw-choice ${cls}`,role:'radiogroup','aria-label':label},h('div',{class:'gt-gw-sec-h',text:label}));
    for(const o of opts){const on=o.value===value;const b=h('button',{type:'button',role:'radio',class:'gt-gw-opt','data-value':o.value,'aria-checked':String(on),'data-on':String(on)},h('span',{class:'gt-gw-opt-mark'}),h('span',{class:'gt-gw-opt-txt'},h('b',{text:o.label}),h('small',{text:o.hint})));b.disabled=!!disabled;if(!disabled)b.onclick=()=>{if(!on)onpick(o.value);};grp.append(b);}
    return grp;
  }
  // "For a set time" → the timed grant for the chosen duration (FEAT-201). Choosing it while a
  // standing grant is on SWITCHES to the timed pass: the standing policy is turned off first (DELETE
  // git-write-policy keeps the note and cadence), so the chosen window really is the whole window.
  async function gwAllowTimed(){if(gwBusy||!projectId)return;const mins=gwClampMin((gwDraft&&gwDraft.timedMinutes)||30);const token=generation;gwBusy=true;gwErr='';paintGwPanel();try{if(policy&&policy.mode&&policy.mode!=='none'){const r0=await guard(token,api.deleteGitWritePolicy(projectId));policy=r0?.policy??null;gwRevision=r0?.revision??gwRevision;gwSummary=r0?.summary??gwSummary;}const r=await guard(token,api.grantGitWrite(projectId,{scope:'duration',minutes:mins}));grant=r?.grant??null;gwTimed=grant;gwDraft=null;ctx.notify(`agent git allowed for ${gwDurLabel(mins)}`);gwBusy=false;paintGrant();paintGwPanel();}catch(e){gwErr=e.message||String(e);gwBusy=false;paintGrant();paintGwPanel();}}
  // "Turn off" — ends everything: the timed pass AND the standing grant (DELETE git-write-grant,
  // the same route as the pill's Revoke). The note and cadence are kept for a later re-grant.
  async function gwTurnOff(){if(gwBusy||!projectId)return;const token=generation;gwBusy=true;gwErr='';paintGwPanel();try{await guard(token,api.revokeGitWrite(projectId));grant=null;gwTimed=null;ctx.notify('agent git turned off');gwBusy=false;gwDraft=null;gwLoaded=false;paintGrant();paintGwPanel();void loadGrant(token);}catch(e){gwErr=e.message||String(e);gwBusy=false;paintGwPanel();}}
  function paintGwPanel(){
    if(!gwPanel){gwPanel=h('div',{class:'gt-gw-panel',role:'dialog','aria-label':'Agent git'});root.append(gwPanel);}
    gwPanel.hidden=!gwPanelOpen;gwWrap.dataset.panel=String(gwPanelOpen);
    if(!gwPanelOpen){gwPanel.replaceChildren();return;}
    // FEAT-190 r3 — until the server policy has loaded, show a loading state with NO toggles and
    // NO Save, so the user cannot save a default-on draft over an unknown (possibly push:false)
    // grant. loadGrant re-paints this panel once it resolves.
    // FEAT-190 r3 (IV run 01a13c63 BROKEN) — a FAILED policy load must NOT be treated as "no grant".
    // Show an error with NO toggles and NO Save, so a user cannot save a default-on draft over an
    // existing (unknown, possibly push:false) grant when the GET errors.
    if(gwLoadFailed){gwPanel.replaceChildren(h('div',{class:'gt-gw-head'},h('strong',{text:'Agent git for this project'}),h('button',{type:'button',class:'gt-gw-x',onclick:()=>{gwPanelOpen=false;paintGwPanel();}},'×')),h('p',{class:'gt-gw-err',text:'Couldn’t load the current agent-git policy — nothing was changed. Close and reopen to retry.'}));return;}
    if(!gwLoaded){gwPanel.replaceChildren(h('div',{class:'gt-gw-head'},h('strong',{text:'Agent git for this project'}),h('button',{type:'button',class:'gt-gw-x',onclick:()=>{gwPanelOpen=false;paintGwPanel();}},'×')),h('p',{class:'gt-gw-sum',text:'Loading the current agent-git policy…'}));return;}
    if(!gwDraft)gwDraft=gwDraftFrom(policy);const d=gwDraft;const mode=policy?.mode??'none';
    const standing=mode!=='none';const timed=gwTimedView();
    // How long — "For 30 minutes" (a timed pass, server memory) vs "Until I turn it off" (the
    // standing policy, stored in the project settings). Seeded once per draft: an active timed pass
    // with no standing grant opens on "30 minutes"; everything else on "until I turn it off" (so an
    // untouched Save keeps its FEAT-190 meaning: store the standing policy).
    if(!d.dur)d.dur=(!standing&&timed)?'timed':'standing';
    const body=[];
    body.push(h('div',{class:'gt-gw-head'},h('strong',{text:'Agent git for this project'}),h('button',{type:'button',class:'gt-gw-x','aria-label':'Close',onclick:()=>{gwPanelOpen=false;paintGwPanel();}},'×')));
    body.push(gwStatusBlock(standing,timed));
    body.push(gwChoice('How long','gt-gw-dur',[
      {value:'timed',label:'For a set time',hint:'A timed pass that ends on its own (or sooner if Orchard restarts).'},
      {value:'standing',label:'Until I turn it off',hint:'Stays on, across restarts, until you press Turn off.'},
    ],d.dur,false,v=>{d.dur=v;paintGwPanel();}));
    if(d.dur==='timed'){
      // FEAT-201 — the duration picker: preset chips + a custom minutes field (≤24h). The chosen
      // value drives gwAllowTimed; nothing here changes the agent CANNOT-mint/extend invariant (the
      // grant is still minted by the user-only POST route).
      const dm=gwClampMin(d.timedMinutes||30);const custom=!!d.timedCustom;
      const chips=h('div',{class:'gt-gw-dur-chips',role:'radiogroup','aria-label':'Duration'});
      for(const p of GW_DUR_PRESETS){const on=!custom&&dm===p.min;const b=h('button',{type:'button',role:'radio',class:'gt-gw-chip','aria-checked':String(on),'data-on':String(on)},p.label);b.disabled=gwBusy;b.onclick=()=>{d.timedCustom=false;d.timedMinutes=p.min;paintGwPanel();};chips.append(b);}
      {const on=custom;const b=h('button',{type:'button',role:'radio',class:'gt-gw-chip gt-gw-chip-custom','aria-checked':String(on),'data-on':String(on)},'Custom');b.disabled=gwBusy;b.onclick=()=>{d.timedCustom=true;paintGwPanel();};chips.append(b);}
      body.push(h('div',{class:'gt-gw-sec gt-gw-dur-sec'},chips));
      if(custom){
        const inp=h('input',{class:'gt-gw-dur-min',type:'number',min:'1',max:String(GW_MAX_TIMED_MIN),step:'1','aria-label':'Custom minutes'});inp.value=String(dm);
        inp.oninput=()=>{const n=Number(inp.value);if(inp.value!==''&&Number.isFinite(n))d.timedMinutes=n;};
        inp.onblur=()=>{d.timedMinutes=gwClampMin(d.timedMinutes||30);paintGwPanel();};
        body.push(h('label',{class:'gt-gw-field gt-gw-dur-field'},h('span',{text:`Minutes (1–${GW_MAX_TIMED_MIN} = up to 24h; longer? use “Until I turn it off”)`}),inp));
      }
      body.push(h('p',{class:'gt-gw-note',text:standing?`This replaces the current “until you turn it off” permission with a ${gwDurLabel(dm)} pass: agents may commit and push here for ${gwDurLabel(dm)}, then it ends.`:`For the next ${gwDurLabel(dm)} agents may commit and push in this project. To choose how they work, pick “Until I turn it off”.`}));
    }else{
      // commit / push — default ON; each an opt-OUT. Turning commit ON brings push ON by default
      // (FEAT-190 r3: a grant allows push unless the user explicitly toggles it off); turning commit
      // OFF forces push off (push requires commit).
      body.push(h('div',{class:'gt-gw-sec'},h('div',{class:'gt-gw-sec-h',text:standing?'What agents may do':'What agents will be allowed to do'}),
        gwToggle('Agents may commit',d.commit,false,()=>{d.commit=!d.commit;d.push=d.commit;paintGwPanel();}),
        gwToggle('Agents may also push to the remote',d.commit&&d.push,!d.commit,()=>{d.push=!d.push;paintGwPanel();})));
      // How agents work — ONE choice over the existing fields (release.opt_in, branchMode.enabled),
      // which stay mutually exclusive exactly as before (FEAT-191: the server refuses both on).
      const wm=d.branchEnabled?'branch':d.optIn?'release':'direct';
      body.push(gwChoice('How agents work','gt-gw-mode',[
        {value:'direct',label:'Direct commits',hint:'Agents commit straight to the current branch, as you would.'},
        {value:'release',label:'Soft releases',hint:'Agents never commit or push directly; finished, verified work is bundled into numbered release commits on a schedule.'},
        {value:'branch',label:'Ticket branches (pilot)',hint:'Each agent commits only on its own ticket branch; a verified ticket is merged into main as one commit.'},
      ],wm,!d.commit,v=>{d.optIn=v==='release';d.branchEnabled=v==='branch';paintGwPanel();}));
      if(d.branchEnabled)body.push(gwToggle('Let agents merge a verified ticket into main themselves (off: only you merge)',d.branchAgentLand,!d.commit,()=>{d.branchAgentLand=!d.branchAgentLand;paintGwPanel();}));
      // note for agents — OPTIONAL guidance, never narrows the grant
      const ta=h('textarea',{class:'gt-gw-scope',rows:'2',maxlength:'2000',placeholder:'e.g. “Commit only after the tests pass.” Guidance only: it does not limit what agents may do.'});ta.value=d.scope;ta.oninput=()=>{d.scope=ta.value;};
      body.push(h('label',{class:'gt-gw-field'},h('span',{text:'Note for agents (optional)'}),ta));
      // other repos (cross-repo), from the reach log — per-repo opt-out. Throwaway repos (scratch,
      // tmp, confined) are filtered server-side; a real repo shows its folder name, full path on hover.
      if(gwReached.length){const list=h('div',{class:'gt-gw-reached'},h('div',{class:'gt-gw-sec-h gt-gw-reached-h',text:`Other repos agents committed to (${gwReached.length})`}),h('p',{class:'gt-gw-note',text:'This permission also covers other repos an agent works in from this project. Turn any of them off here.'}));
        for(const rp of gwReached){const ov=d.overrides[rp.key]||{disabled:rp.disabled,commit:rp.commit,push:rp.push};d.overrides[rp.key]=ov;
          const full=rp.toplevel||String(rp.key||'').replace(/\/\.git\/?$/,'')||String(rp.key||'');const folder=full.replace(/\/+$/,'').split('/').pop()||full;
          const row=h('div',{class:'gt-gw-reached-row','data-disabled':String(!!ov.disabled)},
            h('span',{class:'gt-gw-reached-name',title:full,text:folder}),
            gwToggle('Commit',!ov.disabled&&ov.commit!==false,false,()=>{ov.commit=ov.commit===false;paintGwPanel();}),
            gwToggle('Push',!ov.disabled&&ov.push!==false,false,()=>{ov.push=ov.push===false;paintGwPanel();}),
            gwToggle('Block',!!ov.disabled,false,()=>{ov.disabled=!ov.disabled;paintGwPanel();}));
          if(rp.remotes&&rp.remotes.length)row.append(h('span',{class:'gt-gw-reached-rem',title:rp.remotes.join(', '),text:`remote: ${rp.remotes[0]}${rp.remotes.length>1?` +${rp.remotes.length-1}`:''}`}));
          list.append(row);}
        body.push(list);}
    }
    // actions
    const acts=h('div',{class:'gt-gw-acts'});
    const dmSave=gwClampMin(d.timedMinutes||30);
    const saveText=gwBusy?'Saving…':d.dur==='timed'?(standing?`Switch to ${gwDurLabel(dmSave)}`:timed&&timed.scope==='duration'?`Restart for ${gwDurLabel(dmSave)}`:`Allow for ${gwDurLabel(dmSave)}`):standing?'Save':'Allow until I turn it off';
    const save=h('button',{type:'button',class:'gt-gw-save',onclick:()=>{if(d.dur==='timed')void gwAllowTimed();else void gwSave(gwPayload(),'agent git saved — on until you turn it off');}},saveText);save.disabled=gwBusy;acts.append(save);
    if(standing||timed){const rev=h('button',{type:'button',class:'gt-gw-revoke2',onclick:()=>void gwTurnOff()},'Turn off');rev.disabled=gwBusy;acts.append(rev);}
    body.push(acts);
    if(gwErr)body.push(h('div',{class:'gt-gw-err',text:gwErr}));
    body.push(h('p',{class:'gt-gw-foot',text:'Every agent commit and push is still checked for leaked secrets and private paths (the leak gate). Force-pushes stay refused. Your own commits are never blocked by this.'}));
    // FEAT-196 — pair a phone so you can grant this from your phone over Tailscale. Only this
    // desktop (localhost) can pair; the token is shown once and lives only in the phone's browser.
    const pair=h('div',{class:'gt-gw-sec gt-gw-pair'},h('div',{class:'gt-gw-sec-h',text:'Grant from your phone (Tailscale)'}));
    if(gwPairResult){
      const frag=`#pair=${gwPairResult.token}`;
      const inp=h('input',{class:'gt-gw-pair-tok',readonly:'readonly','aria-label':'Pairing fragment'});inp.value=frag;
      pair.append(
        h('p',{class:'gt-gw-note',text:`Paired “${gwPairResult.label}”. On your phone, open your Orchard URL and append this once — shown only now:`}),
        h('div',{class:'gt-gw-pair-row'},inp,(()=>{const b=h('button',{type:'button',class:'gt-gw-chip',onclick:async()=>{try{await navigator.clipboard.writeText(frag);ctx.notify('pairing fragment copied');}catch{ctx.notify('select and copy the fragment');}}},'Copy');return b;})()),
        h('p',{class:'gt-gw-note',text:'Then that phone can grant agent git-write here. It cannot pair other devices. Revoke any time from this desktop.'}),
      );
    } else {
      const lab=h('input',{class:'gt-gw-pair-label',placeholder:'Device label (e.g. “my phone”)','aria-label':'Device label',maxlength:'120'});
      const btn=h('button',{type:'button',class:'gt-gw-chip',onclick:async()=>{if(gwPairBusy)return;gwPairBusy=true;paintGwPanel();try{const r=await api.createPairing(lab.value.trim()||'phone');gwPairResult={token:r.token,label:r.label};}catch(e){gwErr=e.message;}gwPairBusy=false;paintGwPanel();}},gwPairBusy?'Pairing…':'Pair a phone…');btn.disabled=gwPairBusy;
      pair.append(h('p',{class:'gt-gw-note',text:'Pair a trusted device once, from this desktop, to grant agent git-write from it while away. An agent can never pair itself or read the token.'}),h('div',{class:'gt-gw-pair-row'},lab,btn));
    }
    body.push(pair);
    gwPanel.replaceChildren(...body);
  }
  // FEAT-190 r3 (IV run 01a13c67 BROKEN) — opening "Manage" ALWAYS re-fetches the current policy
  // from the server, never trusting the possibly-stale in-memory `policy` (a second tab may have
  // changed the grant since this page loaded it). It drops to the loading state and re-seeds the
  // draft from the fresh policy when loadGrant resolves, so an untouched Save cannot clobber another
  // tab's push:false with a stale default-on draft. (Residual: a sub-second TOCTOU between this
  // re-fetch and Save still needs a server-side optimistic-concurrency guard — flagged, not closed.)
  gwSettings.onclick=()=>{if(!projectId)return;gwPanelOpen=!gwPanelOpen;if(gwPanelOpen){gwLoaded=false;gwLoadFailed=false;gwDraft=null;gwPairResult=null;gwPairBusy=false;const token=generation;paintGwPanel();void loadGrant(token);}else paintGwPanel();};
  projectSelect.onchange=()=>ctx.navigate(projectSelect.value,{view});root.querySelectorAll('.gt-views button').forEach(b=>b.onclick=()=>{if(b.dataset.view!==view)ctx.navigate(projectId,{view:b.dataset.view})});title.oninput=paint;branchName.oninput=paint;filter.oninput=()=>{clearTimeout(filterTimer);filterTimer=setTimeout(applyFilter,180)};all.onchange=()=>void toggleAll();
  sync.onclick=async()=>{const action=sync.dataset.action;if(sync.disabled)return;if(action==='fetch')return void fetchNow(generation,true);const token=generation,serverAction=action==='publish'?'push':action;syncing=true;paint();try{const r=await guard(token,api.gitAction(project().id,serverAction));data.status=r.status;ctx.notify(action==='publish'?`published ${r.status?.branch??'branch'} to origin`:action==='push'?'pushed to origin':'pulled from origin');ctx.onStatusChanged?.(r.status,projectId);loadChanges(true,token);syncing=false;paint()}catch(e){fail(e.message);if(e.body?.status)data.status=e.body.status;syncing=false;paint()}};
  commitForm.onsubmit=async e=>{e.preventDefault();if(commit.disabled)return;const token=generation;committing=true;paint();try{const r=await guard(token,api.gitAction(project().id,'commit',{title:title.value,description:description.value}));title.value='';description.value='';ctx.notify(`committed ${r.committed}`);loadChanges(true,token);ctx.onStatusChanged?.(r.status,projectId);committing=false;paint()}catch(x){fail(x.message);committing=false;paint()}};
  createForm.onsubmit=async e=>{e.preventDefault();if(create.disabled)return;const token=generation;branchBusy=true;paint();try{const r=await guard(token,api.gitCreateBranch(project().id,branchName.value.trim()));branchName.value='';ctx.notify(`created ${r.created}`);refreshBranch(token);branchBusy=false;paint()}catch(x){fail(x.message);refreshBranch(token);branchBusy=false;paint()}};
  // The stashes-tab chip count, prefetched for non-stash views (guarded, fired).
  async function loadStashCount(token){try{const r=await guard(token,api.gitStashes(project().id));stashData=r;paint()}catch(e){void e}}
  // open() is the generation authority: it bumps `generation` (superseding every
  // in-flight continuation) and resets EVERY per-project transient flag so a
  // freshly-opened view never inherits a stale one. It has NO `await` of its own:
  // every load/project/stash/fetch is FIRED (each self-guards via guard()), so
  // open() cannot suspend and then run a continuation against a superseded view
  // (BUG-203 r3 — the projects() dropdown-wipe was exactly that suspend-then-run).
  // Any boolean/Set that gates the UI or tracks an in-flight request belongs in
  // the reset list below.
  async function open(route={},returnHash='#/'){generation+=1;const token=generation;clearFetch();failures=0;fetchedAt=null;syncing=false;historyBusy=false;branchBusy=false;committing=false;loading=false;batching=false;gwBusy=false;gwPanelOpen=false;gwDraft=null;gwTimed=null;gwReached=[];gwErr='';gwLoaded=false;gwLoadFailed=false;gwRevision=null;if(gwPanel)gwPanel.hidden=true;liveConfirmed=false;pending.clear();stashData={stashes:[]};projectId=route.projectId||ctx.getProject()?.id||ctx.getProjects()[0]?.id||null;view=['changes','branches','history','stashes'].includes(route.view)?route.view:'changes';home.href=returnHash;root.setAttribute('aria-hidden','false');slide.open();const current=ctx.getProject(projectId);projectSelect.replaceChildren(...(current?[Object.assign(document.createElement('option'),{value:current.id,textContent:current.name,selected:true})]:[]));if(projectId){void loadGrant(token);void loadView(token);void projects(token);if(view!=='stashes')void loadStashCount(token);if(view==='changes')void fetchNow(token)}}
  function close(){generation+=1;clearFetch();clearTimeout(filterTimer);root.setAttribute('aria-hidden','true');slide.close()}return{root,home,open,close,isOpen:slide.isOpen};
}
