/**
 * Type surface for the board reconciliation tool (FEAT-032 item #5) so server
 * code can `import { genBoard, checkBoard } from '../../scripts/board.mjs'` and
 * still typecheck. The implementation stays an executable .mjs so
 * `node scripts/board.mjs check|gen [--dir=…]` keeps working unchanged, and so
 * onboarded projects can carry a byte-identical copy of it.
 *
 * FEAT-058 (the ticket dashboard) writes to ticket files and must then leave the
 * board reconciled. It calls THESE functions rather than hand-editing INDEX.md —
 * `genBoard` is the only thing that knows which columns are curated
 * (Open.Owner / Open.Status / Done.Commit) and must be preserved by id.
 */

export interface BoardTicket {
  id: string;
  file: string;
  title: string;
  severity: string | null;
  done: boolean;
  statusRaw: string;
  /** The H1's id when it disagrees with the filename, else null. */
  idMismatch: string | null;
}

export interface ReadTicketsResult {
  tickets: Map<string, BoardTicket>;
  errors: string[];
}

export interface CheckResult {
  /** Hard drift — a non-empty array is what makes `board:check` exit 1. */
  fails: string[];
  /** Advisory only (title divergence). */
  warns: string[];
  ticketCount: number;
}

/** Parse every `{ARCH,BUG,FEAT,DEPLOY}-NNN-*.md` in `dir` into tickets. */
export function readTickets(dir: string): ReadTicketsResult;

/** Reconcile INDEX.md against the ticket files. Never writes. */
export function checkBoard(dir: string): CheckResult;

/**
 * Rewrite `dir/INDEX.md`'s Open/Done tables FROM the ticket files, preserving
 * the curated columns by id. Returns the new file text. Throws when INDEX.md is
 * missing one of the `## Open` / `## Done` / `## Shipped` sections.
 */
export function genBoard(dir: string): string;

export function normalizeSeverity(raw: string | null | undefined): string | null;
export function isDoneStatus(raw: string | null | undefined): boolean;
