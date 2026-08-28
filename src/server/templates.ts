/**
 * Instruction template library.
 *
 * One markdown file per template under <data>/templates/, self-describing via a
 * minimal YAML-ish frontmatter block. No YAML dependency: the frontmatter is
 * deliberately restricted to `key: value` scalars.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { templatesDir, slugify, writeAtomic, ensureDir, projectRoot, backupOnce, isInside } from '../lib/paths.ts';
import type { InstructionRef } from './registry.ts';
// FEAT-106 — resolve the local-conventions doc wherever the project keeps it
// (legacy `docs/CONVENTIONS.md` or consolidated `.orchard/CONVENTIONS.md`).
import { resolveConventionsFile } from '../../scripts/lib/board-path.mjs';

export type TemplateMode = 'append' | 'replace';

export interface Template {
  id: string;
  name: string;
  defaultMode: TemplateMode;
  /** Marks a doc the user actively evolves — the UI can flag it. */
  living: boolean;
  description: string;
  body: string;
  filePath: string;
  bytes: number;
  updatedAt: string;
  /**
   * FEAT-027 read-through: when set (relative to projectRoot(), or absolute),
   * `body` is resolved from THIS repo file at read time instead of the stored
   * copy below it in the .md file — eliminates the second source of truth for
   * `living` docs like the Working Agreement. Editing the repo file is enough;
   * no re-POST needed.
   */
  source?: string;
  /**
   * True when `source` is set but could not be read (deleted/moved/escapes
   * projectRoot()) — `body` degraded to the last stored copy rather than
   * throwing. The caller can surface this as a staleness warning.
   */
  sourceMissing?: boolean;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = FM_RE.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) meta[k] = v;
  }
  return { meta, body: raw.slice(m[0].length) };
}

function serialize(t: Pick<Template, 'name' | 'defaultMode' | 'living' | 'description' | 'body' | 'source'>): string {
  const esc = (s: string) => s.replace(/[\r\n]+/g, ' ');
  const lines = [
    '---',
    `name: ${esc(t.name)}`,
    `defaultMode: ${t.defaultMode}`,
    `living: ${t.living ? 'true' : 'false'}`,
    `description: ${esc(t.description)}`,
  ];
  if (t.source) lines.push(`source: ${esc(t.source)}`);
  lines.push('---', '', t.body.replace(/\s+$/, ''), '');
  return lines.join('\n');
}

/**
 * Known seed ids and the source path they were originally seeded from,
 * relative to projectRoot(). Used as a NON-DESTRUCTIVE migration in
 * readTemplate(): an already-seeded install (from before FEAT-027) has no
 * `source:` line in its stored .md — rather than requiring a re-seed, a known
 * seed id that lacks `source` adopts this default at READ time. The stored
 * file on disk is never rewritten by this fallback.
 */
const DEFAULT_SEED_SOURCES: Record<string, string> = {
  'working-agreement': path.join('docs', 'prompts', 'WORKING_AGREEMENT.md'),
  'working-agreement-v2': path.join('docs', 'prompts', 'WORKING_AGREEMENT.v2.md'),
};

/**
 * Resolve a stored `source` value to an absolute path, refusing to escape
 * projectRoot() (a hand-edited frontmatter `source: ../../../etc/passwd`
 * must not be read). Absolute inputs are honored as-is only if they land
 * inside projectRoot() too — same guard, so there's exactly one rule.
 */
function resolveSourcePath(source: string): string | null {
  const resolved = path.resolve(projectRoot(), source);
  return isInside(projectRoot(), resolved) ? resolved : null;
}

function safeId(id: string): string {
  const s = slugify(id);
  if (!s || s.includes('..') || s.includes('/')) throw new Error(`templates: bad id ${JSON.stringify(id)}`);
  return s;
}

function fileFor(id: string): string {
  return path.join(templatesDir(), `${safeId(id)}.md`);
}

export function listTemplates(): Template[] {
  ensureDir(templatesDir());
  const out: Template[] = [];
  for (const name of fs.readdirSync(templatesDir())) {
    if (!name.endsWith('.md')) continue;
    const t = readTemplate(name.slice(0, -3));
    if (t) out.push(t);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function readTemplate(id: string): Template | null {
  const file = fileFor(id);
  let raw: string;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const rid = safeId(id);
  const { meta, body: storedBody } = parseFrontmatter(raw);
  const mode: TemplateMode = meta.defaultMode === 'replace' ? 'replace' : 'append';
  // Non-destructive migration for pre-FEAT-027 seeded installs (see
  // DEFAULT_SEED_SOURCES doc comment): adopt the default source at read time
  // only — never rewrites the file.
  const source = meta.source && meta.source.trim() ? meta.source.trim() : DEFAULT_SEED_SOURCES[rid];

  let body = storedBody;
  let bytes = st.size;
  let updatedAt = st.mtime.toISOString();
  let sourceMissing = false;

  if (source) {
    const resolved = resolveSourcePath(source);
    if (resolved) {
      try {
        const sst = fs.statSync(resolved);
        body = fs.readFileSync(resolved, 'utf8');
        bytes = sst.size;
        updatedAt = sst.mtime.toISOString();
      } catch {
        // Source declared but unreadable (deleted/moved) — degrade to the
        // last stored copy rather than throwing.
        sourceMissing = true;
      }
    } else {
      // Path escapes projectRoot() — refuse to read it, degrade instead.
      sourceMissing = true;
    }
  }

  return {
    id: rid,
    name: meta.name || id,
    defaultMode: mode,
    living: meta.living === 'true',
    description: meta.description ?? '',
    body,
    filePath: file,
    bytes,
    updatedAt,
    source,
    sourceMissing,
  };
}

export interface SaveTemplateInput {
  id?: string;
  name: string;
  defaultMode?: TemplateMode;
  living?: boolean;
  description?: string;
  body: string;
  /**
   * FEAT-027: set to make this a read-through / living-doc template. Omit to
   * leave an existing template's `source` untouched (a UI edit that doesn't
   * know about `source` must not silently detach it) — pass `source: ''` to
   * deliberately clear it.
   */
  source?: string;
  /**
   * Required to write over an existing template. Without it a save that collides
   * with an existing id throws TemplateConflictError.
   */
  overwrite?: boolean;
}

export class TemplateConflictError extends Error {
  readonly id: string;
  readonly existingName: string;
  constructor(id: string, existingName: string) {
    super(
      `templates: "${id}" already exists (${JSON.stringify(existingName)}). ` +
        `Creating a template whose name slugifies onto an existing id would destroy it. ` +
        `Send {"id":"${id}","overwrite":true} to update it deliberately, or pick a different name.`,
    );
    this.name = 'TemplateConflictError';
    this.id = id;
    this.existingName = existingName;
  }
}

/**
 * Save a template.
 *
 * The id is derived from `input.id ?? input.name`. That derivation is why this
 * used to be a data-loss route: `POST /api/templates {"name":"Working Agreement",
 * "body":"PWNED"}` slugified onto the seeded `working-agreement` id and
 * overwrote it with HTTP 200 — and `seedTemplates()` skips files that exist, so
 * it never came back. The most likely casualty was the user's actively-evolving
 * "Working Agreement v2".
 *
 * Now: an existing id is a hard conflict unless the caller passes `overwrite`
 * (which only makes sense together with an explicit `id`), and a timestamped
 * `.bak-…` copy is taken before any overwrite so the previous body is always
 * recoverable.
 */
export function saveTemplate(input: SaveTemplateInput): Template {
  const explicitId = typeof input.id === 'string' && input.id.trim().length > 0;
  const id = safeId(input.id ?? input.name);
  ensureDir(templatesDir());
  const file = fileFor(id);
  const existing = readTemplate(id);
  if (existing) {
    if (!input.overwrite || !explicitId) throw new TemplateConflictError(id, existing.name);
    const bak = backupOnce(file);
    if (!bak) throw new Error(`templates: refusing to overwrite ${file} — backup failed`);
  }
  // `source` defaults to whatever the existing template already had (see
  // SaveTemplateInput doc comment) — an unaware UI-edit POST must not
  // silently detach a living doc from its repo file. `source: ''` clears it.
  const resolvedSource = input.source !== undefined ? (input.source.trim() || undefined) : existing?.source;
  writeAtomic(
    file,
    serialize({
      name: input.name,
      defaultMode: input.defaultMode ?? 'append',
      living: input.living ?? false,
      description: input.description ?? '',
      body: input.body,
      source: resolvedSource,
    }),
  );
  const t = readTemplate(id);
  if (!t) throw new Error(`templates: save of ${id} produced no readable file`);
  return t;
}

export function deleteTemplate(id: string): boolean {
  try {
    fs.unlinkSync(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- local conventions */

/**
 * FEAT-039 — per-project local-conventions doc.
 *
 * Path, relative to a project's `hostPath`, that — if present — is injected
 * ALONGSIDE the shared Working Agreement for that project's sessions. This is
 * the routing valve the WA's §L talks about: UNIVERSAL rules belong in the
 * one shared WA (`docs/prompts/WORKING_AGREEMENT.v2.md`, injected for every
 * project); PROJECT-SPECIFIC rules belong here instead, so they don't leak
 * into the shared doc and pollute every other project's sessions.
 */
export const LOCAL_CONVENTIONS_RELPATH = path.join('docs', 'CONVENTIONS.md');

/**
 * Read a project's local-conventions doc and format it as an injectable
 * section, mirroring `boardStateSection()` (src/server/board.ts) in shape:
 * `null` when absent (opt-in — a project with no `docs/CONVENTIONS.md`
 * injects nothing extra), a hard length cap since this competes for the same
 * attention budget as the WA and the live board snapshot.
 *
 * FEAT-039 wiring: `composeInstructions(refs, { hostPath })` folds this
 * section on internally (see below) — a caller that has a project's
 * `hostPath` gets local conventions for free without a second manual fold.
 * The board snapshot (`boardStateSection()`, FEAT-021) is layered separately
 * by the launch call site since it needs a live board read, not a static
 * file:
 *   appendToSystemPrompt(
 *     composeInstructions(refs, { hostPath }).systemPrompt,
 *     boardStateSection(hostPath),
 *   )
 * i.e. shared WA + project-local conventions first (composed together,
 * universal then local), live board state layered last by the caller.
 */
export function localConventionsSection(hostPath: string, opts?: { maxChars?: number }): string | null {
  // FEAT-106 — resolved, not the bare legacy relpath: a migrated project's doc
  // lives under `.orchard/`. `convRel` names it host-relative for the footer.
  const file = resolveConventionsFile(hostPath);
  const convRel = path.relative(hostPath, file).split(path.sep).join('/') || LOCAL_CONVENTIONS_RELPATH;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const body = raw.trim();
  if (!body) return null;

  const maxChars = Math.max(200, opts?.maxChars ?? 4000);
  const parts = [
    '# Project Conventions (local)',
    '',
    `_Auto-injected at launch from ${convRel} (read-only). Project-specific rules ` +
      'only — anything universal belongs in the shared Working Agreement instead (see WA §L / ' +
      '`scripts/check-scope.mjs`).',
    '',
    body,
  ];
  let text = parts.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1).trimEnd()}…`;
  return text;
}

/* ------------------------------------------------------- provider routing */

/**
 * FEAT-043 — mixed-provider routing guidance, injected condensed.
 *
 * Canonical doc: ~/projects/methodology/ROUTING.md; this reads the COMMITTED
 * MIRROR (docs/prompts/ROUTING.md, kept current by scripts/sync-methodology.mjs)
 * so a checkout without the methodology repo still works. Same opt-in contract
 * as localConventionsSection(): absent/empty file → null, no section, no error.
 *
 * SIZE DECISION: the full doc is a research dump (~7KB) that would compete
 * with the WA + board snapshot for attention; ROUTING.md delimits its
 * condensed core with `routing-inject` markers (~2.4KB: the top routing rules,
 * availability/budget factors, and the one-line dispatch command), and only
 * that region is injected, under a header pointing at the full doc. Files
 * without markers degrade to the capped full body rather than silently
 * injecting nothing.
 */
export const ROUTING_MIRROR_RELPATH = path.join('docs', 'prompts', 'ROUTING.md');

const ROUTING_INJECT_RE = /<!--\s*routing-inject:start\s*-->([\s\S]*?)<!--\s*routing-inject:end\s*-->/;

export function routingSection(opts?: { filePath?: string; maxChars?: number }): string | null {
  const file = opts?.filePath ?? path.join(projectRoot(), ROUTING_MIRROR_RELPATH);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  const marked = ROUTING_INJECT_RE.exec(raw);
  const core = (marked ? marked[1]! : raw).trim();
  if (!core) return null;
  const researched = /researched\s+(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1];
  const maxChars = Math.max(200, opts?.maxChars ?? 4000);
  const parts = [
    '# Provider Routing (mixed Claude + GPT fleet)',
    '',
    `_Auto-injected at launch — the condensed core of ROUTING.md${
      researched ? ` (researched ${researched}; STALE after ~3 months or any major model release — re-verify before trusting)` : ''
    }. Full evidence + dispatch examples: \`${ROUTING_MIRROR_RELPATH}\`. Dispatch a task to the other ` +
      'provider with `npm run dispatch -- --provider openai|anthropic … "task"` (claude-station repo)._',
    '',
    core,
  ];
  let text = parts.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1).trimEnd()}…`;
  return text;
}

/* ----------------------------------------------------- response format */

/**
 * FEAT-084/091 — the response-format instruction, injected condensed.
 *
 * FEAT-091 note: the doc now specifies TWO layers — the `orchard-digest` JSON
 * envelope and the prose blocks (`orchard-answer` / `orchard-notes`). Both live
 * inside the SAME `response-format-inject` marked region, so this function is
 * unchanged in mechanism: one region in, one section out, one flag gating both.
 * A second marker pair was deliberately not added — two independently injectable
 * regions would let a project end up instructed in one layer and not the other,
 * and the whole point of the single flag is that the sides cannot disagree.
 *
 * FEAT-083 shipped the parser/renderer, the per-project `responseDigest.enabled`
 * opt-out, and this convention doc — but nothing TOLD a session to emit the
 * format. `composeInstructions` folded WA → local conventions → routing and
 * stopped there, so the digest only worked when the agent happened to remember
 * it and no other project got it at all. This closes that gap.
 *
 * Same opt-in contract + shape as `routingSection()`/`localConventionsSection()`:
 * absent/empty file → null (no section, no error). `RESPONSE_FORMAT.md` delimits
 * a condensed agent-facing core with `response-format-inject` markers (~1 KB: the
 * envelope rules only, not the human documentation around it); only that region
 * is injected, under a header pointing at the full doc. A file without markers
 * degrades to the capped full body rather than injecting nothing.
 *
 * Unlike routing/conventions this is NOT a mirror of a canonical methodology
 * file — `RESPONSE_FORMAT.md` is a project-local doc (the sync-methodology FILES
 * list carries only the WA + ROUTING), so it is edited here directly.
 *
 * `guidance`, when non-empty, is appended under a `## Project override` subhead
 * inside the section — a short per-project nudge (verbosity/detail/style/when to
 * emit). It is validated (length-capped, control-char-rejected in validate.ts)
 * and can only steer tone; it cannot change the fixed JSON schema, fence name,
 * or the fail-closed fallback.
 */
export const RESPONSE_FORMAT_RELPATH = path.join('docs', 'prompts', 'RESPONSE_FORMAT.md');

const RESPONSE_FORMAT_INJECT_RE =
  /<!--\s*response-format-inject:start\s*-->([\s\S]*?)<!--\s*response-format-inject:end\s*-->/;

export function responseFormatSection(opts?: {
  filePath?: string;
  guidance?: string | null;
  maxChars?: number;
}): string | null {
  const file = opts?.filePath ?? path.join(projectRoot(), RESPONSE_FORMAT_RELPATH);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  const marked = RESPONSE_FORMAT_INJECT_RE.exec(raw);
  const core = (marked ? marked[1]! : raw).trim();
  if (!core) return null;

  const guidance = typeof opts?.guidance === 'string' ? opts.guidance.trim() : '';
  // FEAT-091 added layer 2 (the prose blocks) to the marked core, roughly doubling
  // it. The cap is raised so the core is delivered WHOLE — a mid-sentence ellipsis
  // in a rules document is worse than the tokens it saves, and a truncated
  // "close the fence" rule would teach exactly the failure it warns about. The
  // doc's own comment holds the core under ~4.6 KB (round 14 added the in-block
  // prose shape); verify:feat-084 pins the composed section at <= 5500, so this
  // leaves real headroom and the core is never truncated mid-rule.
  const maxChars = Math.max(200, opts?.maxChars ?? 6000);
  const parts = [
    // The literal `Response Format (orchard-digest)` is load-bearing: the FEAT-084
    // suite asserts on it to prove the fold landed and landed LAST. Layer 2 is
    // named by extending the heading, not by rewriting it.
    '# Response Format (orchard-digest) + response blocks',
    '',
    `_Auto-injected at launch — the condensed core of ${RESPONSE_FORMAT_RELPATH}. This project has ` +
      'the response format ENABLED. Two layers: lead substantive replies with the `orchard-digest` ' +
      'envelope (the transcript renderer lifts it into a scannable summary), and give every part ' +
      'of the prose a CATEGORY — `orchard-finding` / `orchard-outcome` / `orchard-ask` / ' +
      '`orchard-judgment` / `orchard-status` / `orchard-narration`, with `orchard-uncategorized ' +
      '<label>` when none fits. Anything outside a ' +
      'block still renders as ordinary prose — nothing is ever lost. Full documentation + ' +
      `degradation contract: \`${RESPONSE_FORMAT_RELPATH}\`._`,
    '',
    core,
  ];
  if (guidance) {
    parts.push('', '## Project override', '', guidance);
  }
  let text = parts.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1).trimEnd()}…`;
  return text;
}

/* --------------------------------------------------------------- composing */

export interface ComposedPrompt {
  /**
   * Ready to hand to Options.systemPrompt.
   * - No `replace` entry  -> `{type:'preset', preset:'claude_code', append}` (the
   *   `--append-system-prompt` semantic), or undefined when nothing applies.
   * - A `replace` entry   -> a plain string (the `--system-prompt` semantic),
   *   which drops the Claude Code preset entirely.
   */
  systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append: string } | undefined;
  /** Ids actually used, in the order they landed in the prompt. */
  appliedIds: string[];
  /** Ids dropped because a later `replace` superseded them. */
  supersededIds: string[];
  missingIds: string[];
  mode: 'none' | 'append' | 'replace';
}

/**
 * Compose an ordered instruction stack.
 * A `replace` entry supersedes everything above it; entries below it append.
 *
 * FEAT-039: when `opts.hostPath` is given, this also folds in that project's
 * local-conventions doc (`localConventionsSection()`, above) after the
 * refs-derived stack — so a session for a project with `docs/CONVENTIONS.md`
 * gets its project-specific rules layered on top of whatever universal
 * Working Agreement `refs` selected, with no separate manual fold required at
 * the call site. A project with no such doc gets exactly the same output as
 * before this option existed (no empty section, no mode change).
 */
export function composeInstructions(
  refs: InstructionRef[],
  opts?: {
    hostPath?: string;
    /**
     * FEAT-043 opt-in: fold the condensed provider-routing section
     * (`routingSection()`) after everything else. `true` reads the repo's
     * committed mirror (docs/prompts/ROUTING.md); a string is an explicit
     * file path (the verification seam). Absent/empty file → byte-identical
     * output, exactly like the local-conventions fold. The session launch
     * path (agent-bridge) passes `routing: true`.
     */
    routing?: boolean | string;
    /**
     * FEAT-084 opt-in: fold the condensed response-format section
     * (`responseFormatSection()`) LAST, after routing. Shapes:
     *   - `false`/absent → nothing injected, byte-identical output (a project
     *     with the digest OFF must neither be instructed nor waste tokens).
     *   - `true` → read the repo's committed doc (docs/prompts/RESPONSE_FORMAT.md).
     *   - `{ guidance, filePath }` → the launch path passes the project's
     *     `responseDigest.guidance`; `filePath` is the verification seam.
     * Gated at the launch site (agent-bridge) on the SAME `responseDigest.enabled`
     * flag the transcript renderer reads, so the two sides can't disagree.
     */
    responseFormat?: boolean | string | { guidance?: string | null; filePath?: string };
  },
): ComposedPrompt {
  const missingIds: string[] = [];
  const resolved: { id: string; mode: TemplateMode; body: string; name: string }[] = [];
  for (const ref of refs) {
    if (ref.enabled === false) continue;
    const t = readTemplate(ref.templateId);
    if (!t) {
      missingIds.push(ref.templateId);
      continue;
    }
    resolved.push({ id: t.id, mode: ref.mode ?? t.defaultMode, body: t.body.trim(), name: t.name });
  }

  let lastReplace = -1;
  for (let i = 0; i < resolved.length; i++) if (resolved[i]!.mode === 'replace') lastReplace = i;

  const supersededIds = lastReplace >= 0 ? resolved.slice(0, lastReplace).map((r) => r.id) : [];
  const kept = lastReplace >= 0 ? resolved.slice(lastReplace) : resolved;

  const section = (r: { name: string; body: string }) => `# ${r.name}\n\n${r.body}`;
  const appliedIds = kept.map((r) => r.id);

  let result: ComposedPrompt;
  if (kept.length === 0) {
    result = { systemPrompt: undefined, appliedIds: [], supersededIds, missingIds, mode: 'none' };
  } else if (lastReplace >= 0) {
    result = {
      systemPrompt: kept.map(section).join('\n\n---\n\n'),
      appliedIds,
      supersededIds,
      missingIds,
      mode: 'replace',
    };
  } else {
    result = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: kept.map(section).join('\n\n---\n\n') },
      appliedIds,
      supersededIds,
      missingIds,
      mode: 'append',
    };
  }

  const hostPath = opts?.hostPath;
  const localSection = hostPath ? localConventionsSection(hostPath) : null;
  if (localSection) {
    result = {
      ...result,
      systemPrompt: appendToSystemPrompt(result.systemPrompt, localSection),
      appliedIds: [...result.appliedIds, 'local-conventions'],
      // A `none` result (no refs applied) that now carries local conventions is
      // effectively an append — keep `mode` consistent with what `systemPrompt`
      // actually is (a preset+append object), same shape callers already handle.
      mode: result.mode === 'none' ? 'append' : result.mode,
    };
  }

  // FEAT-043: provider-routing fold, last (universal WA → project-local →
  // routing guidance). Opt-in per the `routing` option doc above; a missing
  // mirror file injects nothing and the output stays byte-identical.
  const routingOpt = opts?.routing;
  const routingSec = routingOpt
    ? routingSection(typeof routingOpt === 'string' ? { filePath: routingOpt } : undefined)
    : null;
  if (routingSec) {
    result = {
      ...result,
      systemPrompt: appendToSystemPrompt(result.systemPrompt, routingSec),
      appliedIds: [...result.appliedIds, 'provider-routing'],
      mode: result.mode === 'none' ? 'append' : result.mode,
    };
  }

  // FEAT-084: response-format fold, LAST of all (WA → project-local → routing →
  // response format). Opt-in per the `responseFormat` option doc above; `false`
  // or a missing/empty doc injects nothing and the output stays byte-identical.
  const rfOpt = opts?.responseFormat;
  const rfSec = rfOpt
    ? responseFormatSection(
        typeof rfOpt === 'string'
          ? { filePath: rfOpt }
          : typeof rfOpt === 'object'
            ? { filePath: rfOpt.filePath, guidance: rfOpt.guidance }
            : undefined,
      )
    : null;
  if (rfSec) {
    result = {
      ...result,
      systemPrompt: appendToSystemPrompt(result.systemPrompt, rfSec),
      appliedIds: [...result.appliedIds, 'response-format'],
      mode: result.mode === 'none' ? 'append' : result.mode,
    };
  }
  return result;
}

/**
 * Fold an extra section onto an already-composed system prompt WITHOUT
 * clobbering it (FEAT-021). Mirrors the three shapes `ComposedPrompt.systemPrompt`
 * can take:
 *   - a plain string (`replace` semantic) → append below a rule.
 *   - a `{preset, append}` object (`append` semantic) → extend its `append`.
 *   - `undefined` (nothing composed) → become a preset that only appends `extra`.
 * An empty/whitespace `extra` is a no-op (returns the prompt unchanged), so a
 * board-less project injects nothing. Used by both the session launcher
 * (agent-bridge) and the FEAT-021 verify, so the verified path is the real one.
 */
export function appendToSystemPrompt(
  sp: ComposedPrompt['systemPrompt'],
  extra: string | null | undefined,
): ComposedPrompt['systemPrompt'] {
  if (!extra || !extra.trim()) return sp;
  if (typeof sp === 'string') return `${sp}\n\n---\n\n${extra}`;
  if (sp) return { ...sp, append: `${sp.append}\n\n---\n\n${extra}` };
  return { type: 'preset', preset: 'claude_code', append: extra };
}

/* ------------------------------------------------------------------ seeding */

/**
 * Idempotent: seeds the two working-agreement docs if their files are absent,
 * and — FEAT-096 — REFRESHES the stored body of an already-seeded, still-
 * source-backed seed when the source file has moved on (returned in
 * `refreshed`). A template a user has detached or re-pointed is never rewritten;
 * an unchanged body is a no-op (no write, no mtime churn); an unreadable source
 * degrades to the stored copy for an existing template rather than throwing.
 *
 * FEAT-027: each seed now records `source` (relative to projectRoot()) in the
 * saved template's frontmatter, so readTemplate() resolves its body from the
 * repo file at read time instead of the one-shot copy taken here — editing
 * `docs/prompts/WORKING_AGREEMENT*.md` propagates with no re-seed/re-POST.
 * An already-seeded install from before FEAT-027 doesn't need re-seeding
 * either: readTemplate()'s DEFAULT_SEED_SOURCES fallback adopts the same
 * default path for these two known ids even when the stored file predates
 * the `source:` line.
 *
 * FEAT-024: also seeds four opt-in "workflow pattern" templates — reusable
 * dispatch SHAPES harvested from real projects (recursive manager→sub-agent
 * trees, an index-table router, a raw+curated memory split, a go/no-go
 * pre-flight gate). Unlike the two Working Agreement docs above, nothing
 * auto-references these — a project only gets one in its system prompt if it
 * explicitly adds it to its InstructionRef list, exactly like any other
 * template a user creates. They exist here purely so a new project can pick
 * a proven shape off the shelf instead of reinventing it.
 */
export function seedTemplates(): { seeded: string[]; skipped: string[]; refreshed: string[] } {
  const seeded: string[] = [];
  const skipped: string[] = [];
  const refreshed: string[] = [];
  const seeds: (SaveTemplateInput & { sourceAbs: string })[] = [
    {
      id: 'working-agreement',
      name: 'Working Agreement',
      defaultMode: 'append',
      living: false,
      description: 'Stable base: build to production confidence; verification is the deliverable.',
      body: '',
      sourceAbs: path.join(projectRoot(), 'docs', 'prompts', 'WORKING_AGREEMENT.md'),
    },
    {
      id: 'working-agreement-v2',
      name: 'Working Agreement v2',
      defaultMode: 'append',
      living: true,
      description: 'Living copy — appended to whenever a preference or failure mode shows up in practice.',
      body: '',
      sourceAbs: path.join(projectRoot(), 'docs', 'prompts', 'WORKING_AGREEMENT.v2.md'),
    },
    {
      id: 'pattern-manager-subagent-tree',
      name: 'Pattern: Manager→Sub-agent Tree',
      defaultMode: 'append',
      living: false,
      description:
        'For big jobs that split into a few distinct areas (security, performance, docs…): put one ' +
        'manager agent over each area, let it run its own helpers, and the top orchestrator reads only ' +
        "each manager's summary. Use when the work has several domains too complex to fan out flat.",
      body: '',
      sourceAbs: path.join(projectRoot(), 'docs', 'prompts', 'patterns', 'MANAGER_SUBAGENT_TREE.md'),
    },
    {
      id: 'pattern-index-table-router',
      name: 'Pattern: Index-table Router',
      defaultMode: 'append',
      living: false,
      description:
        'Keep a growing pile of docs manageable: the root file is just a table of links to per-topic ' +
        'files, so it never bloats and readers load only the topic they need. Use when notes/playbooks ' +
        'keep piling up and one flat doc would get too big to read.',
      body: '',
      sourceAbs: path.join(projectRoot(), 'docs', 'prompts', 'patterns', 'INDEX_TABLE_ROUTER.md'),
    },
    {
      id: 'pattern-raw-curated-memory-split',
      name: 'Pattern: Raw + Curated Memory Split',
      defaultMode: 'append',
      living: false,
      description:
        'Keep two notes per topic: an append-only raw log of everything as it happens, plus a short ' +
        'summary you rewrite as understanding changes. Readers use the summary; the raw log is insurance ' +
        'if the summary is ever wrong. Use when observations pile up faster than you can digest them.',
      body: '',
      sourceAbs: path.join(projectRoot(), 'docs', 'prompts', 'patterns', 'RAW_CURATED_MEMORY_SPLIT.md'),
    },
    {
      id: 'pattern-go-no-go-preflight',
      name: 'Pattern: Go/No-go Pre-flight Gate',
      defaultMode: 'append',
      living: false,
      description:
        'A short yes/no checklist an agent must fully pass before it starts — any failed item stops it ' +
        'cold. Use when starting in the wrong state (wrong branch, a job already done, a resource still ' +
        'in use) is costly to unwind and the things to check are a clear finite list.',
      body: '',
      sourceAbs: path.join(projectRoot(), 'docs', 'prompts', 'patterns', 'GO_NO_GO_PREFLIGHT.md'),
    },
  ];
  for (const s of seeds) {
    const id = safeId(s.id!);
    const file = fileFor(id);
    if (fs.existsSync(file)) {
      // FEAT-096: an already-seeded, source-backed template is no longer frozen
      // forever. Refresh its STORED body from the source file it is (still)
      // pointed at — but only when it is unambiguously THIS seed's own file, so
      // a user who detached (`source` cleared) or re-pointed the template is
      // never overwritten.
      //
      // The match is decided on the RESOLVED source (readTemplate().source),
      // which folds in the DEFAULT_SEED_SOURCES read-through migration: the two
      // pre-FEAT-027 Working Agreement seeds carry NO `source:` line on disk yet
      // still resolve to their canonical repo path, and those must refresh too.
      // A consequence of that same migration: for the two WA ids specifically,
      // a deliberately-cleared `source:` re-adopts the default and so still
      // matches here — but the read-through already serves the source body for
      // those ids regardless, so aligning the stored body changes nothing a
      // session ever sees. For every non-WA id (the four patterns) a cleared or
      // re-pointed source is honored exactly.
      try {
        const existing = readTemplate(id);
        if (!existing || !existing.source) {
          skipped.push(id); // detached / not source-backed — leave it alone
          continue;
        }
        const resolved = resolveSourcePath(existing.source);
        if (!resolved || resolved !== s.sourceAbs) {
          skipped.push(id); // re-pointed at a different source — leave it alone
          continue;
        }
        if (existing.sourceMissing) {
          skipped.push(id); // source unreadable — fail open, keep the stored copy
          continue;
        }
        // `existing.body` is the fresh read-through source body. Rebuild the file
        // preserving the curated frontmatter verbatim (including the literal
        // `source:` line, or its absence for the pre-FEAT-027 WA seeds) and swap
        // in the new body. Comparing the fully-serialized candidate against the
        // current file is the churn-free no-op test: identical bytes → no write,
        // no mtime bump; and it is self-consistent (a refreshed file re-serializes
        // to itself, so it never churns on the next call).
        const raw = fs.readFileSync(file, 'utf8');
        const { meta } = parseFrontmatter(raw);
        const candidate = serialize({
          name: meta.name || id,
          defaultMode: meta.defaultMode === 'replace' ? 'replace' : 'append',
          living: meta.living === 'true',
          description: meta.description ?? '',
          body: existing.body,
          source: meta.source && meta.source.trim() ? meta.source.trim() : undefined,
        });
        if (candidate === raw) {
          skipped.push(id); // stored body already current — nothing to do
          continue;
        }
        writeAtomic(file, candidate);
        refreshed.push(id);
      } catch {
        // Any unexpected error refreshing an EXISTING template degrades to the
        // stored copy rather than taking down a server boot — fail open.
        skipped.push(id);
      }
      continue;
    }
    let body: string;
    try {
      body = fs.readFileSync(s.sourceAbs, 'utf8');
    } catch (err) {
      throw new Error(`seedTemplates: cannot read seed source ${s.sourceAbs}: ${(err as Error).message}`);
    }
    const { sourceAbs, ...rest } = s;
    saveTemplate({ ...rest, body, source: path.relative(projectRoot(), sourceAbs) });
    seeded.push(id);
  }
  return { seeded, skipped, refreshed };
}
