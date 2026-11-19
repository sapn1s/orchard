/**
 * FEAT-120 — cross-provider conversation handoff (the PURE half).
 *
 * The engine a session runs on is pinned by its transcript: a Codex thread id
 * resumes only on Codex, a Claude session file only on Claude (see
 * orchard-transcripts.ts#resumeProviderOf). So "switch this conversation to the
 * other engine" cannot be a literal resume — it is a HANDOFF: start a NEW
 * session on the target engine whose FIRST TURN is seeded with the prior
 * conversation. Full-fidelity replay is impossible across engines (private
 * reasoning carries a provider-bound signature; tool ids/names and their
 * results are engine-private; subagent trees differ), so the honest deliverable
 * is the CONVERSATION: every human turn and every assistant TEXT answer, in
 * order, with tool activity SUMMARISED (never presented as executed state) and
 * an explicit notice of what did not carry over.
 *
 * This module is PURE — no fs, no model call, no I/O — so the seed is fully
 * testable offline and deterministic. The reader that produces `entries`
 * (readUniformSession) and the wiring that delivers the seed as the first turn
 * live elsewhere; seeding MUST ride the first turn, never the system prompt
 * (BUG-165: volatile system-prompt content busts the provider prompt cache).
 */

/** The raw uniform transcript entry both engines project into (jsonl.ts#toMessage shape). */
export interface UniformEntry {
  type?: 'user' | 'assistant' | string;
  message?: {
    role?: string;
    content?: unknown; // string, or an array of { type, text?, name?, ... } blocks
  };
  [k: string]: unknown;
}

export interface HandoffSeedOptions {
  /** The engine the source session ran on, for the preamble wording. */
  sourceProvider?: string | null;
  /** True when readUniformSession dropped older turns (oversize source / ring cap). */
  elided?: boolean;
}

export interface HandoffSeed {
  /** The first-turn text to hand the target engine as `firstPrompt`. */
  seed: string;
  /** The enumerated "what did NOT carry over" items, for the UI disclosure. */
  lostContext: string[];
  /** How many tool calls were summarised (never replayed). */
  toolCallsSummarised: number;
}

/** The invariant list the lost-context notice always enumerates (FEAT-120 criterion). */
export const LOST_CONTEXT_ITEMS: readonly string[] = [
  'the previous assistant’s private reasoning (never portable between engines)',
  'exact tool calls and their results — summarised, not replayed; re-derive anything needed from the live files',
  'any subagent/sub-thread internal activity',
  'attachments and images (re-attach them if they still matter)',
];

function providerLabel(p: string | null | undefined): string {
  if (p === 'openai') return 'OpenAI Codex';
  if (p === 'anthropic') return 'Claude';
  return 'another assistant';
}

/** The blocks of an entry as an array, tolerating a string `content`. */
function blocksOf(entry: UniformEntry): Array<Record<string, unknown>> {
  const c = entry.message?.content;
  if (typeof c === 'string') return c.trim() ? [{ type: 'text', text: c }] : [];
  if (Array.isArray(c)) return c.filter((b) => b && typeof b === 'object') as Array<Record<string, unknown>>;
  return [];
}

/**
 * Build the first-turn seed from uniform entries. Deterministic, pure.
 * - Emits every human turn and every assistant TEXT answer, in order.
 * - `thinking` blocks are DROPPED entirely (a Claude thinking block carries a
 *   provider-bound signature; a Codex one is empty) — never carried.
 * - `tool_use`/`tool_result` are NEVER presented as executed state: each
 *   assistant turn's tool activity collapses to a one-line count + names.
 * - Always appends the explicit lost-context notice.
 */
export function buildHandoffSeed(entries: UniformEntry[], opts: HandoffSeedOptions = {}): HandoffSeed {
  const sourceLabel = providerLabel(opts.sourceProvider);
  const body: string[] = [];
  let toolCallsSummarised = 0;

  for (const e of entries) {
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const blocks = blocksOf(e);
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => String(b.text).trim())
      .filter(Boolean)
      .join('\n');
    const toolUses = blocks.filter((b) => b.type === 'tool_use');

    if (e.type === 'user') {
      // A user entry carrying only tool_result blocks is engine-private echo —
      // never presented as state. Emit only genuine human text.
      if (text) body.push(`USER: ${text}`);
      continue;
    }

    // assistant
    let line = text ? `ASSISTANT: ${text}` : '';
    if (toolUses.length) {
      toolCallsSummarised += toolUses.length;
      const names = [...new Set(toolUses.map((b) => (typeof b.name === 'string' ? b.name : null)).filter(Boolean))].join(', ');
      const summary = `(ran ${toolUses.length} tool call${toolUses.length === 1 ? '' : 's'}${names ? `: ${names}` : ''} — results not carried; re-derive from the live files if needed)`;
      line = line ? `${line}\n${summary}` : `ASSISTANT: ${summary}`;
    }
    if (line) body.push(line);
  }

  const preamble =
    `You are continuing a conversation that previously ran on ${sourceLabel}. ` +
    `Below is the prior dialogue between the user and that assistant, in order. ` +
    `Read it in full, then continue from exactly where it left off, in the same style — do not restart the topic or re-introduce yourself. ` +
    `Tool activity is summarised, not replayed: anything the previous assistant learned only from a tool must be re-derived against the live files, which is safer anyway (a replayed result can be stale).`;

  const elidedNote = opts.elided
    ? '_Note: the earliest turns of this conversation were too long to carry inline and have been omitted; the most recent turns are below._'
    : '';

  const notice = [
    '---',
    '**What did NOT carry over from the previous engine** (stated, not hidden):',
    ...LOST_CONTEXT_ITEMS.map((s) => `- ${s}`),
  ].join('\n');

  const seed = [preamble, elidedNote, '---', body.join('\n\n'), notice]
    .filter(Boolean)
    .join('\n\n');

  return { seed, lostContext: [...LOST_CONTEXT_ITEMS], toolCallsSummarised };
}
