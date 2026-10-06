// Formatting/parsing helpers extracted from git-view.js so THAT file contains
// no bare `/` — no division and no regex literal — in code. The async-token
// scan (scripts/verify-gitview-async-token.mjs) fails CLOSED on any `/` it
// cannot classify with certainty (divide vs. regex is undecidable without a
// full parser), so every division and regex literal lives here instead — a
// module the scan does not read (BUG-203 r5). These are pure, synchronous
// helpers: no async, no `guard`, no shared state.
export function ago(v) {
  const s = Math.max(0, Math.floor((Date.now() - (typeof v === 'number' ? v : Date.parse(v))) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? '' : 's'} ago`;
}

const DIFF_META = /^(diff --git |index |(?:new|deleted) file mode |(?:old|new) mode |similarity index |rename (?:from|to) |--- |\+\+\+ )/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
export const isDiffMeta = (line) => DIFF_META.test(line);
export const hunkMatch = (text) => text.match(HUNK);

// The agent-git-grant "…m / …h left" duration label.
export function durationLeftLabel(ms) {
  const m = Math.ceil(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
