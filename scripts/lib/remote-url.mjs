/**
 * FEAT-164 — THE remote parser (independent adjudicator ruling after verify e5d8ca9e: ONE shared
 * parseRemote). Every git remote / push-destination decision classifies and compares through
 * this function; nothing else may regex a URL, strip `file://` or compare remote strings.
 *
 *   parseRemote(u, { base }) →
 *     { kind: 'local',   path }  an absolute local path (resolved against `base` when relative)
 *     { kind: 'network', key  }  a comparable `host/path` key
 *     null                       unparseable or refused — the CALLER MUST REFUSE
 *
 * No single standard parser covers git's grammar: Node's URL mis-parses scp-like forms, and git
 * hands URLs back unchanged (aliases and insteadOf are already resolved by git itself in
 * git-target.mjs; that stays). So the rules are git's own:
 *   - `<transport>::<address>` (remote helpers, e.g. ext::) → null (it can run anything).
 *   - `scheme://…` is a URL. `file://…` → fileURLToPath; a host (even "localhost") or a NUL → null.
 *     Any other scheme is network: host lowercased, path percent-DECODED, `//` collapsed, leading
 *     and trailing `/` trimmed, one trailing `.git` stripped, then CASE-FOLDED. Port and user are
 *     ignored. Compared by key, never by string.
 *   - scp-like `[user@]host:path`: git's rule, a colon with NO slash before it (and no `://`).
 *     `[host]:path` brackets are accepted. Same key normalisation.
 *   - anything else is a local path.
 * Empty input, a NUL anywhere (raw or decoded), an undecodable `%`, or an empty host → null.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

function keyOf(host, rawPath) {
  if (typeof host !== 'string') return null;
  const h = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!h || /[\s/\\]/.test(h)) return null;
  let p;
  try { p = decodeURIComponent(rawPath ?? ''); } catch { return null; }
  if (p.includes('\0')) return null;
  p = p.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  if (!p) return null;
  return `${h}/${p}`;
}

export function parseRemote(u, { base = process.cwd() } = {}) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!s || s.includes('\0')) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(s)) return null;           // remote-helper transport
  const m = SCHEME.exec(s);
  if (m) {
    let url;
    try { url = new URL(s); } catch { return null; }
    if (m[1].toLowerCase() === 'file') {
      // file://host/... is refused, including "localhost" (WHATWG normalises that host to '', so check the raw form).
      if (url.host !== '' || !/^file:\/\/\//i.test(s)) return null;
      let p;
      try { p = fileURLToPath(url); } catch { return null; }
      if (!p || p.includes('\0')) return null;
      return { kind: 'local', path: path.resolve(p) };
    }
    const key = keyOf(url.hostname, url.pathname);
    return key ? { kind: 'network', key } : null;
  }
  const colon = s.indexOf(':');
  const slash = s.indexOf('/');
  if (colon > 0 && (slash < 0 || slash > colon)) {                   // scp-like: no slash before the colon
    let hostPart = s.slice(0, colon);
    // `[host]:path` (the bracket may contain colons): take up to the closing bracket.
    if (s.startsWith('[') || /@\[/.test(s)) {
      const close = s.indexOf(']');
      if (close < 0 || s[close + 1] !== ':') return null;
      hostPart = s.slice(0, close + 1);
      const key = keyOf(hostPart.replace(/^.*@/, ''), s.slice(close + 2));
      return key ? { kind: 'network', key } : null;
    }
    const key = keyOf(hostPart.replace(/^.*@/, ''), s.slice(colon + 1));
    return key ? { kind: 'network', key } : null;
  }
  let p;
  try { p = path.resolve(typeof base === 'string' && base ? base : process.cwd(), s); } catch { return null; }
  return { kind: 'local', path: p };
}
