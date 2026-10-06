/**
 * ARCH-022 — static half of the "no door around the lifecycle authority" proof.
 *
 * Parses every .ts/.mjs/.js file under src/ (types stripped by node:module stripTypeScriptTypes, then a
 * small JS tokenizer — TypeScript 7 here ships no JS compiler API and no other parser is installed) and finds every call to a
 * child_process spawner (spawn, spawnSync, execFile, execFileSync, exec, execSync, fork), however it
 * was imported (named, aliased, namespace, default, require). For each call it classifies the first
 * argument:
 *   - a string literal: the binary. `docker` (any path ending in docker) or a shell is a FINDING
 *     outside docker-exec.ts — a shell can reach docker (`sh -c "docker rm …"`).
 *   - anything else (a variable, a call): DYNAMIC. A dynamic binary is a FINDING unless the exact
 *     (file, expression) pair is in DYNAMIC_ALLOWED below, each with the reason it cannot be docker.
 * It also fails on any reference to CLAUDE_STATION_DOCKER or `docker.sock` used as a client socket
 * outside docker-exec.ts, and on any import of `sealAuthority` outside lifecycle.ts.
 *
 * ARCH-022 decision (b-i): the scan follows every module the SERVER imports, wherever it lives — src/ imports
 * scripts/lib/*.mjs, and a server-reachable docker mutation there escaped (attacker b, round 3: `ensureSandboxUp`
 * ran `node scripts/docker-sandbox.mjs up`). Outside src/ the same rules apply, except that a LITERAL `docker`
 * spawn whose argv is a literal read (`docker info`, `ps`, `inspect`…) is allowed: reads need no authority.
 * A node child (`process.execPath`) is no longer allowed everywhere: it can run any script (that is how the
 * sandbox CLI was reached), so each one is listed below with what it runs.
 *
 * The list is fail-closed: a new spawner call with a computed binary is a finding until someone
 * proves it is not docker and adds it here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', '/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash', '/usr/bin/env']);

/**
 * (relative file -> first-argument source texts) proven not to be docker, each with its reason.
 * `process.execPath` (this node binary) is allowed everywhere.
 */
export const DYNAMIC_ALLOWED = {
  'src/server/docker-exec.ts': ['*'], // the one spawner
  // node children (process.execPath), each running a fixed script that does not run docker:
  'src/server/browser.ts': ['process.execPath'], // the Playwright CLI (cliPath())
  'src/server/dispatch-client.mjs': ['process.execPath'], // the checkout's dispatch client script
  'src/server/git.ts': ['process.execPath', 'term'], // the leak gate (scripts/leak-gate.mjs); term: CLAUDE_STATION_TERMINAL ?? 'kitty'
  'src/server/index.ts': ['process.execPath'], // the consolidation pass script
  'src/server/runtime/claude-runtime.ts': ['process.execPath'], // the leak gate
  'src/server/runtime/runtime-update.ts': ['bin', 'process.execPath'], // the SDK's bundled claude binary; an import check of the new SDK JS
  'src/server/container-manager.ts': ['bin'], // hostBin(bin): every call site is checked below to pass a literal, non-docker binary
  'src/server/dispatch-broker.ts': ['process.env.ORCHARD_DISPATCH_NODE || process.execPath'], // node for the dispatch runner
  'src/server/claude-accounts.ts': ['bin'], // CLAUDE_STATION_CLAUDE_BIN || 'claude' — the Claude CLI
  'src/server/claude-login.ts': ['bin'], // the Claude CLI (auth login)
  'src/server/provider-usage.ts': ['bin'], // the codex CLI (app-server)
  'src/server/provisioning.ts': ['bin', 'cmd'], // provisioned tool binaries (--version); run(cmd) is called only with 'uv' / 'npm'
  'src/server/runtime/codex-runtime.ts': ['command'], // the codex CLI the runtime resolved
  'src/server/session-host.mjs': ['command'], // the session engine (claude CLI) the host was told to run
  // server-imported scripts/lib modules (followed since ARCH-022 decision b-i):
  'scripts/lib/git-shim.mjs': ['finder', 'bin'], // 'which'/'where' to find git; the real git binary
};
/** Files allowed to MENTION CLAUDE_STATION_DOCKER, and why (never to pick a binary with it). */
export const DOCKER_ENV_REFERENCE_ALLOWED = {
  'scripts/lib/docker-sandbox.mjs': 'the isolation guard reads it only to REFUSE (a docker shim could reach any daemon)',
};
/** Files where a LOCAL variable shadows a spawner name (not child_process): the value check skips it there. */
export const SHADOWED = {
  'src/server/runtime/codex-runtime.ts': ['spawn'], // `const spawn = thread.source.subAgent.thread_spawn` (a codex thread record)
};

/* ------------------------------------------------------------- tokenizer */
const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** Tokens: {t:'id'|'str'|'tpl'|'num'|'p'|'re', v, line}. Comments dropped. Template literals: one 'tpl' token
 *  whose v is the raw text; a template with substitutions is marked dynamic. */
export function tokenize(src) {
  const out = [];
  let i = 0; let line = 1;
  const n = src.length;
  const prevSig = () => out[out.length - 1];
  const regexAllowed = () => {
    const p = prevSig();
    if (!p) return true;
    if (p.t === 'id') return KW_BEFORE_REGEX.has(p.v);
    if (p.t === 'num' || p.t === 'str' || p.t === 'tpl' || p.t === 're') return false;
    return !(p.v === ')' || p.v === ']' || p.v === '}');
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; line += (src.slice(i, end).match(/\n/g) || []).length; i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; let v = '';
      while (j < n && src[j] !== c) { if (src[j] === '\\') { v += src[j + 1]; j += 2; continue; } if (src[j] === '\n') line++; v += src[j]; j++; }
      out.push({ t: 'str', v, line }); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let depth = 0; let dyn = false; let v = '';
      while (j < n) {
        const d = src[j];
        if (d === '\\') { v += src[j + 1]; j += 2; continue; }
        if (d === '\n') line++;
        if (depth === 0 && d === '`') break;
        if (depth === 0 && d === '$' && src[j + 1] === '{') { dyn = true; depth = 1; j += 2; continue; }
        if (depth > 0) {
          // skip nested strings inside ${ … } coarsely
          if (d === '{') depth++; else if (d === '}') depth--;
          j++; continue;
        }
        v += d; j++;
      }
      out.push({ t: 'tpl', v, dyn, line }); i = j + 1; continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1; let cls = false;
      while (j < n) { const d = src[j]; if (d === '\\') { j += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; else if (d === '\n') break; j++; }
      j++; while (j < n && /[a-z]/i.test(src[j])) j++;
      out.push({ t: 're', v: src.slice(i, j), line }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i + 1; while (j < n && /[\w$]/.test(src[j])) j++; out.push({ t: 'id', v: src.slice(i, j), line }); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j++; out.push({ t: 'num', v: src.slice(i, j), line }); i = j; continue; }
    out.push({ t: 'p', v: c, line }); i++;
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(ts|mts|mjs|js|cjs)$/.test(e.name) && !/\.d\.(ts|mts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const isCP = (s) => /^(node:)?child_process$/.test(s);

/** Text of the first call argument starting at token index k (just after '('): tokens to the top-level ',' or ')'. */
function firstArg(toks, k) {
  let depth = 0; const parts = [];
  for (let j = k; j < toks.length; j++) {
    const t = toks[j];
    if (t.t === 'p' && '([{'.includes(t.v)) depth++;
    if (t.t === 'p' && ')]}'.includes(t.v)) { if (depth === 0) break; depth--; }
    if (t.t === 'p' && t.v === ',' && depth === 0) break;
    parts.push(t);
  }
  return parts;
}

/** Tokens of the n-th (0-based) argument starting at k (just after the open paren). */
function argAt(toks, k, n) {
  let j = k; let depth = 0;
  for (let idx = 0; idx < n; idx++) {
    for (; j < toks.length; j++) {
      const t = toks[j];
      if (t.t === 'p' && '([{'.includes(t.v)) depth++;
      if (t.t === 'p' && ')]}'.includes(t.v)) { if (depth === 0) return []; depth--; }
      if (t.t === 'p' && t.v === ',' && depth === 0) { j++; break; }
    }
  }
  return firstArg(toks, j);
}

const READ_VERBS = new Set(['info', 'version', 'ps', 'inspect', 'images', 'logs', 'top', 'port', 'diff', 'history', 'events', 'stats']);

/** Relative import specifiers of a module (static, dynamic, require) resolved to files that exist. */
function importsOf(abs, toks) {
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    let spec = null;
    if (t.t === 'id' && t.v === 'from' && toks[k + 1]?.t === 'str') spec = toks[k + 1].v;
    if (t.t === 'id' && (t.v === 'import' || t.v === 'require') && toks[k + 1]?.v === '(' && toks[k + 2]?.t === 'str') spec = toks[k + 2].v;
    if (t.t === 'id' && t.v === 'import' && toks[k + 1]?.t === 'str') spec = toks[k + 1].v; // import 'x' (side effect)
    if (!spec || !spec.startsWith('.')) continue;
    const r = path.resolve(path.dirname(abs), spec);
    if (fs.existsSync(r) && fs.statSync(r).isFile()) out.push(r);
  }
  return out;
}

export function scanTree(root) {
  const findings = [];
  const dynamicSeen = [];
  const srcRoot = path.join(root, 'src');
  const queue = walk(srcRoot);
  const seenFiles = new Set(queue);
  const files = [];
  while (queue.length) {
    const abs = queue.shift();
    files.push(abs);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const inSrc = !path.relative(srcRoot, abs).startsWith('..');
    let text = fs.readFileSync(abs, 'utf8');
    if (/\.(ts|mts)$/.test(abs)) {
      try { text = stripTypeScriptTypes(text, { mode: 'strip' }); }
      catch { try { text = stripTypeScriptTypes(text, { mode: 'transform' }); } catch (e) { findings.push(`${rel}: could not strip types (${e.message.split('\n')[0]}) — cannot prove it spawns no docker`); continue; } }
    }
    const toks = tokenize(text);
    // follow the server's imports out of src/ (and on from there)
    for (const dep of importsOf(abs, toks)) {
      if (seenFiles.has(dep) || !/\.(ts|mts|mjs|js)$/.test(dep) || /\.d\.mts$/.test(dep)) continue;
      seenFiles.add(dep); queue.push(dep);
    }
    const strs = toks.filter((t) => t.t === 'str' || t.t === 'tpl').map((t) => t.v);
    const ids = new Set(toks.filter((t) => t.t === 'id').map((t) => t.v));
    if (rel !== 'src/server/docker-exec.ts' && !DOCKER_ENV_REFERENCE_ALLOWED[rel] && (strs.some((v) => v.includes('CLAUDE_STATION_DOCKER')) || ids.has('CLAUDE_STATION_DOCKER'))) {
      findings.push(`${rel}: references CLAUDE_STATION_DOCKER (only docker-exec.ts may pick the docker binary)`);
    }
    if (rel !== 'src/server/lifecycle.ts' && rel !== 'src/server/docker-exec.ts' && ids.has('sealAuthority')) {
      findings.push(`${rel}: references sealAuthority (only lifecycle.ts may take the mutation capability)`);
    }
    // Bindings of child_process.
    const fnNames = new Map(); const nsNames = new Set();
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      // import { a as b, c } from 'child_process'   |  import * as ns from …  |  import d from …
      if (t.t === 'id' && t.v === 'import' && !(toks[k + 1]?.v === '(')) {
        let j = k + 1; const clause = [];
        while (j < toks.length && !(toks[j].t === 'id' && toks[j].v === 'from') && !(toks[j].t === 'str')) clause.push(toks[j++]);
        if (toks[j]?.v === 'from') j++;
        if (toks[j]?.t === 'str' && isCP(toks[j].v)) {
          for (let q = 0; q < clause.length; q++) {
            const c = clause[q];
            if (c.v === '*' && clause[q + 1]?.v === 'as') nsNames.add(clause[q + 2].v);
          }
          if (clause[0]?.t === 'id' && clause[0].v !== 'type') nsNames.add(clause[0].v);
          const lb = clause.findIndex((c) => c.v === '{');
          if (lb >= 0) {
            for (let q = lb + 1; q < clause.length && clause[q].v !== '}'; q++) {
              const c = clause[q];
              if (c.t !== 'id' || c.v === 'type') continue;
              if (clause[q + 1]?.v === 'as') { if (SPAWNERS.has(c.v)) fnNames.set(clause[q + 2].v, c.v); q += 2; }
              else if (SPAWNERS.has(c.v)) fnNames.set(c.v, c.v);
            }
          }
        }
      }
      // require('child_process') / import('child_process') in any form
      if (t.t === 'id' && (t.v === 'require' || t.v === 'import') && toks[k + 1]?.v === '(') {
        const a = toks[k + 2];
        if (a && (a.t === 'str' || a.t === 'tpl') && isCP(a.v)) {
          // const X = require(...)  |  const { a: b } = require(...)
          let b = k - 1; if (toks[b]?.v === 'await') b--; if (toks[b]?.v === '=') b--;
          if (toks[b]?.t === 'id') nsNames.add(toks[b].v);
          else if (toks[b]?.v === '}') {
            let q = b; while (q > 0 && toks[q].v !== '{') q--;
            for (let r = q + 1; r < b; r++) {
              const c = toks[r]; if (c.t !== 'id') continue;
              if (toks[r + 1]?.v === ':') { if (SPAWNERS.has(c.v)) fnNames.set(toks[r + 2].v, c.v); r += 2; }
              else if (SPAWNERS.has(c.v)) fnNames.set(c.v, c.v);
            }
          } else findings.push(`${rel}:${t.line}: child_process loaded in a form this scan cannot bind (${toks.slice(b, k + 4).map((x) => x.v).join(' ')})`);
        } else if (a && !(a.t === 'str' || a.t === 'tpl') && t.v === 'require') {
          findings.push(`${rel}:${t.line}: require() of a computed module — cannot prove it is not child_process`);
        }
      }
    }
    if (!fnNames.size && !nsNames.size) continue;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      let spawner = null; let open = -1;
      if (t.t === 'id' && fnNames.has(t.v) && toks[k + 1]?.v === '(' && toks[k - 1]?.v !== '.' && toks[k - 1]?.v !== 'function') { spawner = fnNames.get(t.v); open = k + 1; }
      if (t.t === 'id' && nsNames.has(t.v) && toks[k + 1]?.v === '.' && SPAWNERS.has(toks[k + 2]?.v) && toks[k + 3]?.v === '(') { spawner = toks[k + 2].v; open = k + 3; }
      // a spawner passed around as a value (const f = spawn; f(...)) is a finding: it escapes the scan
      if (!spawner && t.t === 'id' && fnNames.has(t.v) && !(SHADOWED[rel] ?? []).includes(t.v) && toks[k - 1]?.v !== '.' && toks[k + 1]?.v !== '(' && toks[k - 1]?.v !== '{' && toks[k - 1]?.v !== ',' && toks[k - 1]?.v !== 'as') {
        findings.push(`${rel}:${t.line}: spawner ${t.v} used as a value — it escapes this scan`);
      }
      if (!spawner) continue;
      const arg = firstArg(toks, open + 1);
      const where = `${rel}:${t.line} ${spawner}(…)`;
      if (arg.length === 1 && (arg[0].t === 'str' || (arg[0].t === 'tpl' && !arg[0].dyn))) {
        const bin = arg[0].v;
        const first = (spawner === 'exec' || spawner === 'execSync') ? bin.trim().split(/\s+/)[0] : bin;
        const isDocker = /(^|\/)docker$/.test(first);
        let readOnly = false;
        if (!inSrc && isDocker && spawner !== 'exec' && spawner !== 'execSync') {
          // a literal argv array whose first element is a read verb
          const a2 = argAt(toks, open + 1, 1);
          readOnly = a2.length > 1 && a2[0].v === '[' && a2[1].t === 'str' && READ_VERBS.has(a2[1].v);
        }
        if (rel !== 'src/server/docker-exec.ts' && !readOnly && (isDocker || SHELLS.has(first) || ((spawner === 'exec' || spawner === 'execSync') && /\bdocker\b/.test(bin)))) {
          findings.push(`${where}: spawns ${JSON.stringify(first)} outside docker-exec.ts`);
        }
      } else {
        const src = arg.map((x) => (x.t === 'str' ? JSON.stringify(x.v) : x.v)).join(' ').replace(/ \. /g, '.').replace(/ \| \| /g, ' || ');
        dynamicSeen.push(`${where}: ${src}`);
        const ok = DYNAMIC_ALLOWED[rel];
        if (!ok || !(ok.includes('*') || ok.includes(src))) findings.push(`${where}: computed binary \`${src}\` is not proven non-docker (route it through docker-exec.ts, or prove it and add it to DYNAMIC_ALLOWED)`);
      }
    }
    if (rel === 'src/server/container-manager.ts') {
      for (let k = 0; k < toks.length; k++) {
        if (toks[k].t === 'id' && toks[k].v === 'hostBin' && toks[k + 1]?.v === '(' && toks[k - 1]?.v !== 'function') {
          const arg = firstArg(toks, k + 2);
          if (!(arg.length === 1 && arg[0].t === 'str')) findings.push(`${rel}:${toks[k].line} hostBin with a computed binary`);
          else if (/(^|\/)docker$/.test(arg[0].v) || SHELLS.has(arg[0].v)) findings.push(`${rel}:${toks[k].line} hostBin(${JSON.stringify(arg[0].v)}) reaches docker/a shell`);
        }
      }
    }
  }
  return { findings, dynamicSeen, files: files.length };
}
