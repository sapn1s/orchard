/**
 * FEAT-206 — a local fake Anthropic Messages API for capturing the REAL claude
 * CLI's wire frames without spending quota and without a model's variance.
 *
 * The CLI under test is real (the SDK-bundled binary); only the model is
 * scripted. A `script(req, ctx)` function decides each reply from the request
 * (messages, tools, system), and returns one of:
 *   { text, delayMs?, chunks? }                 — a streamed text reply
 *   { tool: { name, input }, text? }            — a streamed tool_use (stop_reason tool_use)
 *   { tools: [{ name, input }, …], text? }      — several tool_use blocks in one reply
 *   { status, error: { type, message }, headers? } — an HTTP error (401 / 429 / 529 …)
 *   { usageInput: N }                           — merged into any of the above: the
 *                                                 input_tokens the reply reports
 *   { headers: {...} }                          — extra response headers (rate-limit headers)
 *   { midStreamError: { type, message } }       — stream the text, then an SSE `error`
 *                                                 event instead of message_stop
 *
 * Requests the script does not care about (no `tools` — titles, summaries,
 * classifiers) get a plain short text reply unless the script handles them.
 *
 *   const api = await startFakeApi({ script });   // api.url, api.requests, api.close()
 */
import * as http from 'node:http';

let seq = 0;
const nid = (p) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`;

function lastUser(req) {
  const ms = Array.isArray(req.messages) ? req.messages : [];
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'user') return ms[i];
  return null;
}
/** Flatten a message's content to text (tool_result bodies included). */
export function textOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content.map((c) => {
    if (typeof c?.text === 'string') return c.text;
    if (c?.type === 'tool_result') return typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x?.text ?? '').join('') : '';
    return '';
  }).join('\n');
}
export function systemText(req) {
  if (typeof req.system === 'string') return req.system;
  if (Array.isArray(req.system)) return req.system.map((s) => s?.text ?? '').join('\n');
  return '';
}
/** The whole conversation as text (first user message identifies a lane). */
export function convoText(req) {
  return (req.messages ?? []).map((m) => textOf(m)).join('\n');
}
export function toolResultsIn(req) {
  let n = 0;
  for (const m of req.messages ?? []) if (m.role === 'user' && Array.isArray(m.content)) for (const c of m.content) if (c?.type === 'tool_result') n++;
  return n;
}
export function lastToolResult(req) {
  const u = lastUser(req);
  if (!u || !Array.isArray(u.content)) return null;
  const r = u.content.filter((c) => c?.type === 'tool_result');
  return r.length ? r[r.length - 1] : null;
}
export { lastUser };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startFakeApi({ script, log } = {}) {
  const requests = [];
  const server = http.createServer(async (rq, rs) => {
    let body = '';
    for await (const c of rq) body += c;
    const url = rq.url || '';
    if (rq.method !== 'POST' || !url.startsWith('/v1/messages')) {
      rs.writeHead(url.startsWith('/v1/') ? 404 : 200, { 'content-type': 'application/json' });
      rs.end(url.startsWith('/v1/') ? JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake api' } }) : '{}');
      return;
    }
    let req = {};
    try { req = JSON.parse(body || '{}'); } catch { /* keep {} */ }
    if (url.startsWith('/v1/messages/count_tokens')) {
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ input_tokens: Math.ceil(body.length / 4) }));
      return;
    }
    const entry = { at: Date.now(), model: req.model, stream: !!req.stream, nTools: (req.tools ?? []).length, nMessages: (req.messages ?? []).length, last: textOf(lastUser(req)).slice(0, 300) };
    requests.push(entry);
    let plan;
    try { plan = (script && (await script(req, { requests, entry }))) || null; } catch (e) { plan = { text: `script error: ${e.message}` }; }
    if (!plan) plan = { text: 'ok' };
    entry.plan = plan.status ? `HTTP ${plan.status}` : plan.tool ? `tool:${plan.tool.name}` : plan.tools ? `tools:${plan.tools.map((t) => t.name).join(',')}` : 'text';
    log?.(entry);
    if (plan.status) {
      rs.writeHead(plan.status, { 'content-type': 'application/json', 'request-id': nid('req'), ...(plan.headers ?? {}) });
      rs.end(JSON.stringify({ type: 'error', error: plan.error ?? { type: 'api_error', message: 'fake' }, request_id: nid('req') }));
      return;
    }
    const usageIn = plan.usageInput ?? Math.ceil(body.length / 4);
    const blocks = [];
    if (plan.text) blocks.push({ type: 'text', text: plan.text });
    for (const t of plan.tools ?? (plan.tool ? [plan.tool] : [])) blocks.push({ type: 'tool_use', id: nid('toolu'), name: t.name, input: t.input ?? {} });
    const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const msgId = nid('msg');
    if (!req.stream) {
      if (plan.delayMs) await sleep(plan.delayMs);
      rs.writeHead(200, { 'content-type': 'application/json', 'request-id': nid('req'), ...(plan.headers ?? {}) });
      rs.end(JSON.stringify({ id: msgId, type: 'message', role: 'assistant', model: req.model, content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: usageIn, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
      return;
    }
    rs.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': nid('req'), ...(plan.headers ?? {}) });
    const ev = (type, data) => rs.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: msgId, type: 'message', role: 'assistant', model: req.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usageIn, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    const chunks = Math.max(1, plan.chunks ?? 1);
    const per = plan.delayMs ? plan.delayMs / chunks : 0;
    let i = 0;
    for (const b of blocks) {
      if (b.type === 'text') {
        ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
        const step = Math.ceil(b.text.length / chunks);
        for (let k = 0; k < b.text.length; k += step) {
          if (per) await sleep(per);
          if (rs.destroyed) return;
          ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text.slice(k, k + step) } });
        }
      } else {
        ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      if (plan.midStreamError) { ev('error', { error: plan.midStreamError }); rs.end(); return; }
      ev('content_block_stop', { index: i });
      i++;
    }
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
    ev('message_stop', {});
    rs.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, port, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
