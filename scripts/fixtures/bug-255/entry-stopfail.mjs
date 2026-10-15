// BUG-255 r3 — fault-injection server entry for the scratch demo ONLY (never the real service).
// The real server, except that AgentSession.close() for an ACCOUNT SWITCH fails:
//   BUG255_STOPFAIL=before — close() throws before tearing anything down (the bridge and CLI intact);
//   BUG255_STOPFAIL=after  — close() has begun teardown (marked closed, bridge removed) and then throws
//                            before it ends the CLI (a half-done stop that would leave the CLI orphaned).
// BUG255_ROOT selects the tree under test (the fixed tree, or a synthesized pre-fix copy).
import * as path from 'node:path';
const ROOT = process.env.BUG255_ROOT;
if (!ROOT) throw new Error('BUG255_ROOT is required');
const ab = await import(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'));
const P = ab.AgentSession.prototype;
const origClose = P.close;
const origSnap = P.pushRunningSnapshot;
P.close = async function (reason, opts) {
  const mode = process.env.BUG255_STOPFAIL;
  if (String(reason).includes('account switch')) {
    if (mode === 'before') throw new Error('injected: the CLI did not stop');
    if (mode === 'after') this.__bug255FailSnap = true;
  }
  return origClose.call(this, reason, opts);
};
P.pushRunningSnapshot = function (...args) {
  if (this.__bug255FailSnap) { this.__bug255FailSnap = false; throw new Error('injected: the stop failed part-way'); }
  return origSnap.apply(this, args);
};
await import(path.join(ROOT, 'src', 'server', 'index.ts'));
