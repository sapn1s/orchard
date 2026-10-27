#!/usr/bin/env node
// verify-bug279-http-get.mjs — exercises scripts/http-get.mjs against a REAL
// loopback HTTP server on a free ephemeral port, plus the BUG-279 attack brief.
//
// The security invariant under test: http-get.mjs must NEVER cause a fetch to a
// non-loopback host. Every attack below must either (a) refuse before any
// network call, or (b) make the request ONLY to the loopback server and never to
// a remote host. A positive loopback GET must still work.
//
// NOTE: http-get.mjs is spawned ASYNCHRONOUSLY (not spawnSync) so the in-process
// test servers' event loop stays free to answer the child's request.
//
// Run: node scripts/verify-bug279-http-get.mjs   (exit 0 = all pass)

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'http-get.mjs');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; fails.push(name); console.log(`FAIL ${name} :: ${detail}`); }
}

function run(args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
  });
}

let REMOTE_PORT = 0;
let loopbackHits = 0, remoteHits = 0;

const loopback = http.createServer((req, res) => {
  loopbackHits++;
  if (req.url.startsWith('/redirect-remote')) {
    res.writeHead(301, { Location: `http://127.0.0.1:${REMOTE_PORT}/pwned` });
    res.end('redirecting');
    return;
  }
  if (req.url.startsWith('/big')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(5 * 1024 * 1024)); // 5 MiB
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('loopback-ok');
});

// stand-in for an external host (also bound to loopback, different port): if
// http-get ever reaches it, an attack succeeded.
const remote = http.createServer((req, res) => {
  remoteHits++;
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('REMOTE-REACHED');
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const EXIT_REFUSE = 2;  // argument/host/scheme refusal (die code 2)
const EXIT_NETFAIL = 1; // request attempt failed (redirect:'error', conn refused)

async function main() {
  const LB_PORT = await listen(loopback);
  REMOTE_PORT = await listen(remote);

  // 1. POSITIVE: a plain loopback GET works.
  {
    const r = await run([`http://127.0.0.1:${LB_PORT}/`]);
    ok('positive/127.0.0.1 GET returns 200', r.code === 0 && /HTTP 200/.test(r.stdout) && /loopback-ok/.test(r.stdout), JSON.stringify(r));
  }
  // 1b. POSITIVE: localhost by name.
  {
    const r = await run([`http://localhost:${LB_PORT}/`]);
    ok('positive/localhost GET returns 200', r.code === 0 && /HTTP 200/.test(r.stdout), JSON.stringify(r));
  }

  const beforeRemote = remoteHits;

  // 2. second URL argument — must refuse; remote must not be hit.
  {
    const r = await run([`http://127.0.0.1:${LB_PORT}/`, `http://127.0.0.1:${REMOTE_PORT}/`]);
    ok('attack/second-URL refused', r.code === EXIT_REFUSE && !/REMOTE-REACHED/.test(r.stdout), JSON.stringify(r));
  }

  // 3. redirect 301 -> "remote": redirect:'error' must stop it; remote not hit.
  {
    const r = await run([`http://127.0.0.1:${LB_PORT}/redirect-remote`]);
    ok('attack/redirect-to-remote refused (no follow)', r.code !== 0 && !/REMOTE-REACHED/.test(r.stdout), JSON.stringify(r));
  }

  // 4. IPv6 loopback long form -> normalises to ::1 (loopback): host accepted,
  //    then connection fails because we bound v4 only. Never a remote fetch.
  {
    const r = await run([`http://[0:0:0:0:0:0:0:1]:${LB_PORT}/`]);
    ok('ipv6/[0:0:0:0:0:0:0:1] treated as ::1 loopback (host not refused)',
       r.code === EXIT_NETFAIL || r.code === 0, JSON.stringify(r));
  }
  // 4b. IPv4-mapped IPv6 -> host NOT a literal loopback -> refused (over-refuse is safe).
  {
    const r = await run([`http://[::ffff:127.0.0.1]:${LB_PORT}/`]);
    ok('ipv6/[::ffff:127.0.0.1] refused (not a literal loopback host)', r.code === EXIT_REFUSE, JSON.stringify(r));
  }

  // 5. decimal IP that DECODES to loopback -> allowed & correct (it IS 127.0.0.1).
  {
    const r = await run([`http://2130706433:${LB_PORT}/`]);
    ok('decimal/2130706433 decodes to 127.0.0.1 (loopback) — not a remote fetch',
       (r.code === 0 && /loopback-ok/.test(r.stdout)) || r.code === EXIT_NETFAIL, JSON.stringify(r));
  }
  // 5b. a decimal IP that decodes to a REMOTE host must be refused.
  {
    const r = await run([`http://3627734529:${LB_PORT}/`]); // 216.58.x.x range
    ok('decimal/remote-IP refused', r.code === EXIT_REFUSE, JSON.stringify(r));
  }

  // 6. 127.0.0.1.evil.example -> refused.
  {
    const r = await run([`http://127.0.0.1.evil.example:${LB_PORT}/`]);
    ok('attack/127.0.0.1.evil.example refused', r.code === EXIT_REFUSE, JSON.stringify(r));
  }

  // 7. userinfo trick -> host is the part after @ (remote) -> refused.
  {
    const r = await run([`http://127.0.0.1@127.0.0.1.evil.example:${LB_PORT}/`]);
    ok('attack/userinfo@remote refused', r.code === EXIT_REFUSE, JSON.stringify(r));
  }

  // 8. fragment trick http://evil.example#@127.0.0.1 -> host is evil.example -> refused.
  {
    const r = await run([`http://evil.example:${LB_PORT}/#@127.0.0.1`]);
    ok('attack/fragment#@loopback refused', r.code === EXIT_REFUSE, JSON.stringify(r));
  }

  // 9. env proxy must NEVER route a loopback URL through a remote proxy — even
  //    with Node 24's NODE_USE_ENV_PROXY=1, which makes fetch() honour HTTP_PROXY
  //    (BUG-279 round-2 IV break). We stand up a real proxy on loopback that
  //    counts BOTH plain requests and CONNECT tunnels; it must receive NEITHER.
  {
    let proxyReqHits = 0, proxyConnectHits = 0;
    const proxySrv = http.createServer((q, res) => { proxyReqHits++; res.writeHead(200); res.end('VIA-PROXY'); });
    proxySrv.on('connect', (q, sock) => { proxyConnectHits++; try { sock.destroy(); } catch {} });
    const proxyPort = await listen(proxySrv);
    const proxy = `http://127.0.0.1:${proxyPort}`;
    const r = await run([`http://127.0.0.1:${LB_PORT}/`], {
      env: {
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
      },
    });
    ok('proxy/NODE_USE_ENV_PROXY loopback NOT tunnelled through proxy',
       r.code === 0 && /loopback-ok/.test(r.stdout) && proxyReqHits === 0 && proxyConnectHits === 0,
       `code=${r.code} proxyReqHits=${proxyReqHits} proxyConnectHits=${proxyConnectHits} ${JSON.stringify(r)}`);
    proxySrv.close();
  }
  // 9b. same, via --use-env-proxy passed to node through NODE_OPTIONS.
  {
    let proxyConnectHits = 0, proxyReqHits = 0;
    const proxySrv = http.createServer((q, res) => { proxyReqHits++; res.writeHead(200); res.end('VIA-PROXY'); });
    proxySrv.on('connect', (q, sock) => { proxyConnectHits++; try { sock.destroy(); } catch {} });
    const proxyPort = await listen(proxySrv);
    const proxy = `http://127.0.0.1:${proxyPort}`;
    const r = await run([`http://127.0.0.1:${LB_PORT}/`], {
      env: { NODE_OPTIONS: '--use-env-proxy', HTTP_PROXY: proxy, HTTPS_PROXY: proxy },
    });
    ok('proxy/NODE_OPTIONS=--use-env-proxy loopback NOT tunnelled',
       r.code === 0 && /loopback-ok/.test(r.stdout) && proxyReqHits === 0 && proxyConnectHits === 0,
       `code=${r.code} proxyReqHits=${proxyReqHits} proxyConnectHits=${proxyConnectHits} ${JSON.stringify(r)}`);
    proxySrv.close();
  }

  // 10. unicode (fullwidth) digits. IDNA maps fullwidth 127 -> ascii "127", so this
  //     resolves to loopback; the invariant is simply that it never reaches remote.
  {
    const r = await run([`http://１２７.0.0.1:${LB_PORT}/`]);
    ok('attack/unicode-digit host never reaches remote', !/REMOTE-REACHED/.test(r.stdout), JSON.stringify(r));
  }

  // 11. file: scheme -> refused.
  {
    const r = await run(['file:///etc/passwd']);
    ok('attack/file: scheme refused', r.code === EXIT_REFUSE, JSON.stringify(r));
  }

  // 12. large response -> read fully, 200.
  {
    const r = await run([`http://127.0.0.1:${LB_PORT}/big`, '--timeout', '20000']);
    ok('large-response/5MiB read ok', r.code === 0 && /HTTP 200/.test(r.stdout) && r.stdout.length > 5 * 1024 * 1024 - 100, `len=${r.stdout.length} code=${r.code}`);
  }

  // FINAL invariant: the stand-in remote server was NEVER hit by any attack.
  ok('INVARIANT/remote server never reached', remoteHits === beforeRemote, `remoteHits went ${beforeRemote} -> ${remoteHits}`);

  loopback.close();
  remote.close();

  console.log(`\n${pass} passed, ${fail} failed` + (fails.length ? `\nFAILURES: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error', e); process.exit(3); });
