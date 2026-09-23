/**
 * FEAT-076 — per-project "Wiring" health status.
 *
 * The question this answers: is a given project actually running with our
 * METHODOLOGY (Working Agreement, local conventions, ticket board, board
 * drift-guard) — not just our RUNTIME (MCP tools, provider routing)? A project
 * can silently launch with our tools and none of our discipline; this computes,
 * per methodology layer, whether it is applied.
 *
 * The one rule that makes this trustworthy: every field is derived from its
 * TRUE SOURCE on every call — the live registry object the caller passes plus
 * small filesystem reads under the project's own hostPath. Nothing is memoised
 * or cached; a status that can go stale is a status that can lie, and the whole
 * point of the panel is that it cannot. All reads are cheap (existsSync + a few
 * small text reads), fine to run on every drawer-open.
 *
 * IMPORTANT: this module only READS. It never scaffolds, never shells out, never
 * touches any tree — reading a project's wiring status must have zero side
 * effects (in particular it must NEVER run onboard against anything). The Apply
 * actions live at the route layer and are gated behind an explicit click.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Project, InstructionRef } from './registry.ts';
import { toolSettingsOf } from './registry.ts';
// FEAT-106 — wiring must report a project's methodology layers wherever that
// project actually keeps them: legacy (`docs/`, `scripts/`) or consolidated
// (`.orchard/`). Every literal path here is resolved so a migrated project reads
// as wired, not partial. The board tool has no dedicated resolver, so its two
// candidate locations are probed inline with a legacy fallback.
import { resolveBoardDir, resolveConventionsFile, resolveOrchardDir } from '../../scripts/lib/board-path.mjs';

/**
 * v4 is the standalone default (supersedes v1/v2/v3). The v1/v2/v3 ids remain
 * recognised so historical project rows and explicit user selections keep
 * resolving and coherentWaStack() strips any of them when re-attaching v4.
 */
export const WA_BASE_ID = 'working-agreement';
export const WA_EXT_ID = 'working-agreement-v2';
export const WA_V3_ID = 'working-agreement-v3';
export const WA_DEFAULT_ID = 'working-agreement-v4';
/** The coherent default attach set. */
export const WA_COHERENT_IDS = [WA_DEFAULT_ID] as const;
/** All template ids recognised as part of the Working Agreement stack. */
export const WA_TEMPLATE_IDS = [WA_BASE_ID, WA_EXT_ID, WA_V3_ID, WA_DEFAULT_ID] as const;

export type WiringState = 'ok' | 'warn' | 'missing' | 'info';
/** What an Apply click on this row does; null = nothing to apply (informational). */
export type WiringApply = 'onboard' | 'attach-wa' | null;

export interface WiringCheck {
  key: string;
  label: string;
  state: WiringState;
  /** One human line explaining the current state (shown under the row). */
  detail: string;
  apply: WiringApply;
}

export interface WiringStatus {
  projectId: string;
  hostPath: string;
  checks: WiringCheck[];
}

/** Non-empty (after trimming) regular file at `p`? Never throws. */
function fileHasContent(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    return fs.readFileSync(p, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

/** Regular file at `p`, any size? Never throws. */
function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A resolvable Working-Agreement pointer in the project's own CLAUDE.md — either
 * onboard's authored pointer / `--wa-pointer` appended section (both name
 * WORKING_AGREEMENT) or any hand-written reference to the shared WA path. This
 * is the "OR" arm of the WA check: a repo can carry the WA via its CLAUDE.md
 * instead of an attached template ref.
 */
function claudeMdHasWaPointer(hostPath: string): boolean {
  const file = path.join(hostPath, 'CLAUDE.md');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  return /WORKING_AGREEMENT/i.test(raw) || raw.includes('orchard:wa-pointer');
}

/**
 * The COHERENCE of the enabled Working-Agreement refs in a project's stack.
 * Presence alone is not satisfaction (BUG-099): a v2-only stack has a WA ref but
 * is missing the entire base core, so it must NOT report as fully applied.
 */
export interface WaRefState {
  /** Enabled WA template ids currently in the stack (any order). */
  enabledIds: string[];
  /** The stable base (v1) is enabled. */
  hasBase: boolean;
  /** The living extension (v2) is enabled. */
  hasExt: boolean;
  /**
   * The enabled WA refs form a self-contained stack. True iff the base is
   * present — v1 is self-contained, so v1 or v1+v2 is coherent; v2 alone is not.
   */
  coherent: boolean;
  /** Only the extension (v2) is enabled, without its base — a half-applied WA. */
  extensionOnly: boolean;
}

/** Classify the enabled Working-Agreement refs in a project's instruction stack. */
export function waRefState(project: Project): WaRefState {
  const stack = project.settings?.instructions ?? [];
  const known = new Set<string>(WA_TEMPLATE_IDS);
  const enabledIds = stack
    .filter((ref) => ref.enabled !== false && known.has(ref.templateId))
    .map((ref) => ref.templateId);
  const hasBase = enabledIds.includes(WA_BASE_ID);
  const hasExt = enabledIds.includes(WA_EXT_ID);
  const hasDefault = enabledIds.includes(WA_DEFAULT_ID);
  return { enabledIds, hasBase: hasBase || hasDefault, hasExt, coherent: hasDefault || hasBase, extensionOnly: hasExt && !hasBase && !hasDefault };
}

/**
 * Is a COHERENT Working-Agreement ref stack present AND enabled? Coherence, not
 * mere presence: the base (v1) carries the core, so it must be enabled. A v2-only
 * stack returns false — it is a half-applied methodology, not a satisfied one.
 */
export function hasEnabledWaRef(project: Project): boolean {
  return waRefState(project).coherent;
}

/**
 * Build the COHERENT Working-Agreement instruction stack for `project`: the
 * stable base (v1) FIRST, then the living extension (v2), both enabled, with
 * every other existing ref preserved in place. Idempotent and repair-safe —
 * enables disabled WA refs rather than duplicating them, inserts a missing base
 * immediately before v2 (base first), and fixes a pre-existing v2-then-v1 order.
 * This is the SINGLE source of the attach mutation, reused by both the wiring
 * "Apply" route and the add-project auto-apply (FEAT-089), so both take the same
 * validated PATCH path (BUG-099) rather than hand-rolling it twice.
 */
export function coherentWaStack(project: Project): InstructionRef[] {
  const stack: InstructionRef[] = (project.settings?.instructions ?? [])
    .filter((r) => !WA_TEMPLATE_IDS.includes(r.templateId as typeof WA_TEMPLATE_IDS[number]))
    .map((r) => ({ ...r }));
  stack.push({ templateId: WA_DEFAULT_ID, enabled: true });
  return stack;
}

/**
 * Compute the wiring status for a project from its true sources. `project` is
 * the live registry row (never client input); `hostPath` is read from it, never
 * from the client. Pure read — see the module header.
 */
export function wiringStatus(project: Project): WiringStatus {
  const hostPath = project.hostPath;
  const checks: WiringCheck[] = [];

  /*
   * Working Agreement — a COHERENT attached ref stack OR a CLAUDE.md pointer.
   * Coherence, not mere presence (BUG-099): a v2-only stack has a WA ref but is
   * missing the entire base core, so it surfaces as a partial (⚠️) with a repair
   * Apply, never as ✅. The CLAUDE.md pointer is the fallback ONLY when there is
   * no usable ref — a pointer is ambient provider instruction Orchard does not
   * compose, so it can never mask a half-applied ref stack.
   */
  const wa = waRefState(project);
  const waPointer = claudeMdHasWaPointer(hostPath);
  if (wa.coherent) {
    checks.push({
      key: 'working-agreement',
      label: 'Working Agreement',
      state: 'ok',
      detail: wa.hasExt
        ? 'Attached as a coherent stack — the stable base (v1) plus its living extension (v2), base first — injected into every session launched here.'
        : 'Attached as an enabled instruction template — injected into every session launched here.',
      apply: null,
    });
  } else if (wa.extensionOnly) {
    checks.push({
      key: 'working-agreement',
      label: 'Working Agreement',
      state: 'warn',
      detail:
        'Half-applied: only the living extension (working-agreement-v2) is attached. Its stable base (working-agreement) — which carries the definition of done, evidence-over-narrative and the final report — is not injected, and v2 opens by pointing at a base that never loads. Apply to add the base first and make the stack coherent.',
      apply: 'attach-wa',
    });
  } else {
    checks.push({
      key: 'working-agreement',
      label: 'Working Agreement',
      state: waPointer ? 'ok' : 'missing',
      detail: waPointer
        ? 'Not attached as a template, but this project’s CLAUDE.md points at the shared Working Agreement.'
        : 'Not applied. Sessions launch without the shared Working Agreement — our orchestration discipline is not loaded.',
      apply: waPointer ? null : 'attach-wa',
    });
  }

  /* Host-relative, POSIX-style rendering of a resolved path for the detail text. */
  const relOf = (abs: string): string => path.relative(hostPath, abs).split(path.sep).join('/');

  /* Local conventions — the resolved CONVENTIONS.md exists & non-empty. */
  const convFile = resolveConventionsFile(hostPath);
  const convRel = relOf(convFile);
  const convOk = fileHasContent(convFile);
  checks.push({
    key: 'conventions',
    label: 'Local conventions',
    state: convOk ? 'ok' : 'missing',
    detail: convOk
      ? `${convRel} is present and non-empty — auto-injected alongside the Working Agreement.`
      : `No non-empty ${convRel}. Project-specific rules are not injected into sessions.`,
    apply: convOk ? null : 'onboard',
  });

  /* Ticket board — the resolved board dir has INDEX.md AND README.md. */
  const boardDir = resolveBoardDir(hostPath);
  const boardRel = relOf(boardDir);
  const boardIndex = fileExists(path.join(boardDir, 'INDEX.md'));
  const boardReadme = fileExists(path.join(boardDir, 'README.md'));
  const boardOk = boardIndex && boardReadme;
  checks.push({
    key: 'board',
    label: 'Ticket board',
    state: boardOk ? 'ok' : boardIndex || boardReadme ? 'warn' : 'missing',
    detail: boardOk
      ? `${boardRel}/ board present (INDEX.md + README.md) — the accumulating-context tracker is in place.`
      : boardIndex || boardReadme
        ? `Partial board: one of ${boardRel}/INDEX.md or README.md is missing. Scaffold to complete it.`
        : `No ${boardRel}/ board. There is no durable, survives-compaction ticket tracker for this project.`,
    apply: boardOk ? null : 'onboard',
  });

  /* Board drift-guard — package.json has board:check AND scripts/board.mjs present. */
  const pkg = readJson(path.join(hostPath, 'package.json'));
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null
    ? (pkg.scripts as Record<string, unknown>)
    : {};
  const hasCheckScript = typeof scripts['board:check'] === 'string' && scripts['board:check'] !== '';
  // The board tool lands at `.orchard/board.mjs` (flat) or `scripts/board.mjs`
  // (legacy). No dedicated resolver, so probe the consolidated location first and
  // fall back to the legacy one, so a mid-migration project is not called broken.
  const orchardBoardTool = path.join(resolveOrchardDir(hostPath), 'board.mjs');
  const legacyBoardTool = path.join(hostPath, 'scripts', 'board.mjs');
  const boardToolPath = fileExists(orchardBoardTool) ? orchardBoardTool : legacyBoardTool;
  const boardToolRel = relOf(boardToolPath);
  const hasBoardTool = fileExists(boardToolPath);
  const guardOk = hasCheckScript && hasBoardTool;
  checks.push({
    key: 'drift-guard',
    label: 'Board drift-guard',
    state: guardOk ? 'ok' : hasCheckScript || hasBoardTool ? 'warn' : 'missing',
    detail: guardOk
      ? `board:check script + ${boardToolRel} present — the board can be reconciled against its tickets.`
      : !pkg
        ? `No parseable package.json, so no board:check wiring. Scaffold installs ${boardToolRel} and (if a package.json exists) the npm script.`
        : hasCheckScript || hasBoardTool
          ? `Partial: one of the board:check script or ${boardToolRel} is missing.`
          : 'No board drift-guard. Nothing catches an INDEX that has drifted from the ticket files.',
    apply: guardOk ? null : 'onboard',
  });

  /* Provider routing — universal, always applied at launch (informational). */
  checks.push({
    key: 'routing',
    label: 'Provider routing',
    state: 'info',
    detail: 'Universal — the condensed provider-routing guidance is folded into every session launched from Orchard.',
    apply: null,
  });

  /* Integrations — the attachable MCP tools (informational; managed elsewhere in
     settings). FEAT-146 moved the Integrations card out of this pane into
     "Permissions & tools", so "above" stopped being true — the pointer names the
     category now, which is also the only form that survives the next re-home. */
  const tools = toolSettingsOf(project);
  const onTools = [tools.serena ? 'Serena' : null, tools.playwright ? 'Playwright' : null, tools.openaiDispatch ? 'OpenAI dispatch' : null].filter(Boolean);
  checks.push({
    key: 'integrations',
    label: 'Integrations',
    state: 'info',
    detail: onTools.length
      ? `Attached MCP tools: ${onTools.join(', ')}. Manage these under Permissions & tools.`
      : 'No attachable MCP tools enabled. Manage these under Permissions & tools.',
    apply: null,
  });

  return { projectId: project.id, hostPath, checks };
}
