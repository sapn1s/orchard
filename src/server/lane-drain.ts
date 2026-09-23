/**
 * ARCH-017 step 2 — THE GROUP-SETTLE DRAIN.
 *
 * The defect this exists to end: a fan-out of N background lanes costs N
 * wakeups, because each child's completion is owned by the harness and arrives
 * as its own turn. The drain makes the GROUP the unit of delivery — when the
 * last member of a closed group settles, ONE drain carries every member's
 * result together, so an N-lane fan-out costs one delivery instead of N.
 *
 * WHAT THIS MODULE IS NOT. It never pushes into a live turn and it never wakes
 * anything. It computes what is ready and records deliveries; the rail polls it
 * and a human (or the next dispatch) collects. That is deliberate — see hazard
 * 1 below — and it is why "one drain" is observable as one HTTP response
 * carrying N results rather than as an interrupt.
 *
 * THE FOUR HAZARDS, and where each is closed:
 *
 *  1. A LANE SETTLING WHILE THE ORCHESTRATOR IS MID-TURN. Closed by delivery
 *     being PULL, not push: settling writes the ledger and nothing else, so a
 *     lane finishing mid-turn cannot interrupt, re-enter, or race the turn. The
 *     result waits in a durable record that outlives every process involved.
 *  2. A DRAIN RACING A NEWLY DISPATCHED LANE. Closed by `groupOpen`
 *     (`lanes.ts`): while a group is open the drain refuses to fire even if
 *     every existing member is terminal, because another member may be
 *     milliseconds from being recorded. Without this, a fan-out whose second
 *     lane is dispatched just after the first settles drains the first alone
 *     and the group is delivered twice — the exact "N wakes" defect, restored.
 *  3. A GROUP NEVER CLOSED. Closed by the PERSISTED `groupCloseDeadline`:
 *     `sweep()` here closes expired groups at runtime and `reconcileBoot()`
 *     re-arms from the same number across a restart. A forgotten close costs at
 *     most one TTL, never forever.
 *  4. STARVATION OF A HELD RESULT. Closed by `HELD_STARVATION_MS`: a terminal
 *     result whose siblings are still running is RELEASED to the rail on its
 *     own once it has waited too long. Without it, one slow lane holds every
 *     fast sibling hostage and the feature makes the user wait longer than the
 *     per-lane wakes it replaced.
 *
 * DELIVERY DISCIPLINE (step 1's rule 2, unchanged and re-used, not re-invented):
 * settle → HANDOFF → send → ACKNOWLEDGE, and the acknowledgement needs the
 * consumer's own receipt. `process()` stamps the handoff and returns the bytes;
 * `acknowledge()` stamps only against a receipt whose digest matches what was
 * sent. A drain whose response never arrives therefore leaves every lane in it
 * HELD and back on the rail at the next poll — the result is not lost, it is
 * re-offered. That is why processing is two calls and not one.
 */
import crypto from 'node:crypto';
// `.ts`, not `.js`: the server is run by plain `node` with type stripping (no
// bundler, no path rewrite), so a `.js` specifier resolves to a file that does
// not exist. It typechecks either way — this only fails at RUNTIME, which is
// how it was found: the scratch server refused to boot.
import * as lanes from './lanes.ts';

/** A row on the `#railPending` surface. One item = one "process" click. */
export interface PendingItem {
  /** Stable key: `group:<groupId>` or `lane:<laneId>`. The rail's dedupe key. */
  id: string;
  kind: 'group' | 'lane';
  groupId: string;
  /** Every lane this one click would collect. A group item carries N of these. */
  laneIds: string[];
  label: string;
  projectId: string | null;
  projectName: string | null;
  ticket: string | null;
  /** Newest settle in the item — what the rail sorts and dates by. */
  at: number;
  /** True when this is a complete unit: collecting it leaves nothing behind. */
  ready: boolean;
  /** Non-terminal siblings still to come. `0` on a ready item, by definition. */
  waitingOn: number;
  /** Why it is on the rail IN THIS SHAPE. Rendered at the user verbatim. */
  reason: string;
  bytes: number;
  excerpt: string;
  failed: number;
}

export interface DrainBundle {
  /** The receipt the consumer must echo back to `acknowledge()`. */
  /*
   * ROUND 11 (finding 1) — THE RESPONSE NEVER CARRIES THE EXPECTED DIGEST.
   *
   * A seventh cross-provider review proved the core property was still forgeable
   * by ECHO: `process()` used to return `digest` — the exact value
   * `acknowledge()` compares against — so a consumer could hand it straight back
   * (`CASE=ack: echo server receipt; consumer emits 0 bytes; disk
   * acknowledged=true`) without ever displaying or emitting the bundle. A proof
   * the verifier hands to the prover is not a proof. The response carries only
   * the CHALLENGE (`nonce`, `channel`, `bytes`); the consumer must COMPUTE the
   * digest over the bytes it actually received — `receiptDigest(nonce, channel,
   * bundle)` — which it can only do by possessing them. The expected digest lives
   * ONLY on the record (`handoffEvidence`) and is never transmitted.
   */
  receipt: { nonce: string; channel: string; bytes: number };
  itemIds: string[];
  lanes: { id: string; label: string; state: string; failureKind: string | null; text: string }[];
  /** The N results as one document — this is the payload "one drain" refers to. */
  bundle: string;
  /** Lanes whose handoff could not be recorded; they stay HELD and re-offered. */
  skipped: { id: string; why: string }[];
}

const EXCERPT_MAX = 400;

function terminalState(s: string): boolean {
  return s !== 'pending' && s !== 'running';
}

/**
 * Close every open group whose persisted deadline has passed (hazard 3, runtime
 * half). Idempotent and safe to call on every poll: `closeGroup` keeps the
 * first close and a group already closed is skipped here entirely.
 */
export function sweep(now: number = Date.now()): { closed: string[] } {
  const closed: string[] = [];
  const open = new Map<string, number>();
  for (const r of lanes.readAll()) {
    if (r.groupOpen && r.groupCloseDeadline != null) open.set(r.groupId, r.groupCloseDeadline);
  }
  for (const [gid, deadline] of open) {
    if (deadline > now) continue;
    lanes.closeGroup(gid, `its ${Math.round((lanes.GROUP_CLOSE_TTL_MS) / 60000)}-minute close deadline passed without an explicit close`, now);
    closed.push(gid);
  }
  return { closed };
}

/**
 * Is this group a complete, drainable unit RIGHT NOW?
 *
 * Both halves are required and neither implies the other: `closed` says no new
 * member can arrive (hazard 2), `outstanding === 0` says no existing member is
 * still working. A group can be closed with members running, and can have zero
 * running members while still open.
 */
export function groupTerminal(groupId: string): { terminal: boolean; why: string; state: lanes.GroupState } {
  const g = lanes.groupState(groupId);
  if (!g.members) return { terminal: false, why: `no such group (${groupId})`, state: g };
  if (g.open) return { terminal: false, why: `the group is still OPEN — another member may yet be dispatched into it, so draining now would deliver a partial fan-out and then deliver again`, state: g };
  if (g.outstanding > 0) return { terminal: false, why: `${g.outstanding} of ${g.members} member(s) have not settled yet`, state: g };
  return { terminal: true, why: `all ${g.members} member(s) are terminal and the group is closed`, state: g };
}

/**
 * What is waiting for a human, as the rail should show it.
 *
 * A group whose members are ALL terminal collapses to ONE item carrying every
 * held result — that collapse is the feature. A group still in flight lists its
 * already-finished members individually, each marked `ready:false` with the
 * count it is waiting on: that is the ESCAPE HATCH, a result you can pull early
 * without waiting for its siblings. A held result past the starvation bound
 * flips to `ready:true` on its own (hazard 4).
 */
export function pending(opts: { projectId?: string | null; now?: number; sweepFirst?: boolean } = {}): PendingItem[] {
  const now = opts.now ?? Date.now();
  if (opts.sweepFirst !== false) {
    try { sweep(now); } catch { /* a sweep failure must not blank the rail — stale-open is visible, an empty rail is a lie */ }
  }
  /*
   * ROUND 9 (finding 4) — persist starvation-release BEFORE reading, so readiness
   * is monotonic. Independent of `sweepFirst` (a different hazard); best-effort, so
   * a read-only server still renders the rail from the timestamps it can see.
   */
  try { lanes.releaseStarved(now); } catch { /* best effort: a non-writer still reads readiness from time */ }
  const all = lanes.readAll().filter((r) => !opts.projectId || r.projectId === opts.projectId);
  const byGroup = new Map<string, lanes.LaneRecord[]>();
  for (const r of all) {
    if (!byGroup.has(r.groupId)) byGroup.set(r.groupId, []);
    byGroup.get(r.groupId)!.push(r);
  }
  const items: PendingItem[] = [];
  for (const [gid, rows] of byGroup) {
    const held = rows.filter((r) => lanes.isHeld(r) && terminalState(r.state));
    if (!held.length) continue;
    /*
     * ROUND 8 — READINESS THROUGH THE ONE PREDICATE, NO LOCAL RE-DERIVATION.
     *
     * This computed `open` and `outstanding` itself — `rows.some(r =>
     * r.groupOpen)` — which is NOT what `groupState()` answers: it ignores the
     * seal. So `groupTerminal` (which asks `groupState`) and this surface gave
     * DIFFERENT answers for the same group — the ARCH-010 two-answers defect a
     * fourth review measured:
     *
     *   1 readiness terminal=true pending=[{"kind":"lane","ready":false}]
     *
     * A drained-and-sealed group read `terminal=true` from `groupTerminal` but
     * was rendered as a still-filling LANE item here, because this line saw only
     * the raw `groupOpen` flag. Both now read `groupState`, so the rail and the
     * drain-readiness check cannot disagree about whether a group is complete.
     */
    const g = lanes.groupState(gid);
    const outstanding = g.outstanding;
    const open = g.open;
    const complete = !open && outstanding === 0;
    if (complete) {
      items.push(makeItem(`group:${gid}`, 'group', gid, held, 0, true,
        held.length === 1
          ? 'this lane is finished and its result has not reached anyone yet'
          : `all ${rows.length} lanes in this group are finished — collecting this delivers ${held.length} results together, in one go`));
      continue;
    }
    const blocked = open
      ? 'its group is still open, so more lanes may join it'
      : `${outstanding} sibling lane(s) are still running`;
    for (const r of held) {
      const waited = now - (r.settledAt ?? r.dispatchedAt);
      /*
       * ROUND 10 (finding 5) — READINESS IS THE PERSISTED STAMP, AND NOTHING ELSE.
       * Round 9 read `starvationReleasedAt != null || waited >= threshold`, so when
       * `releaseStarved`'s write FAILED the time arm still exposed readiness — and a
       * restart, reading the un-persisted stamp as absent, then reversed it
       * (`writeFailure=true: ready=true->false`). Readiness that is exposed but not
       * durable is exactly the regression this must not have. So it is TRUE only
       * once the release is on disk: a failed stamp is simply not-ready-yet, and the
       * next successful poll releases it durably and permanently. The threshold is
       * evaluated by `releaseStarved` (the writer); a non-writer reads the stamp.
       */
      const starved = r.starvationReleasedAt != null;
      items.push(makeItem(`lane:${r.id}`, 'lane', gid, [r], outstanding, starved,
        starved
          ? `finished ${Math.round(waited / 60000)} min ago and released on its own: ${blocked}, and a finished result is not held back indefinitely waiting on them`
          : `finished, but ${blocked}. It will be delivered with the rest when they finish — or you can collect it now.`));
    }
  }
  items.sort((a, b) => b.at - a.at);
  return items;
}

function makeItem(id: string, kind: 'group' | 'lane', groupId: string, held: lanes.LaneRecord[], waitingOn: number, ready: boolean, reason: string): PendingItem {
  const head = held[0];
  const texts = held.map((r) => r.resultExcerpt ?? '');
  return {
    id,
    kind,
    groupId,
    laneIds: held.map((r) => r.id),
    label: kind === 'group' && held.length > 1 ? `${held.length} lanes — ${head.label}` : head.label,
    projectId: head.projectId,
    projectName: head.projectName,
    ticket: head.ticket,
    at: Math.max(...held.map((r) => r.settledAt ?? r.dispatchedAt)),
    ready,
    waitingOn,
    reason,
    bytes: held.reduce((n, r) => n + (r.resultExcerpt?.length ?? 0), 0),
    excerpt: texts.join('\n').slice(0, EXCERPT_MAX),
    failed: held.filter((r) => r.state !== 'settled').length,
  };
}

/**
 * COLLECT. Reads each lane's AUTHORITATIVE result file, stamps Orchard's half
 * of the two-part fact, and returns the bundle plus the receipt envelope the
 * caller must echo to `acknowledge()`.
 *
 * Nothing is marked acknowledged here, and that is the point: this function has
 * no evidence the bytes arrived.
 *
 * THREE RULES A CROSS-PROVIDER REVIEW FOUND MISSING, all enforced below:
 *
 *  1. THE BUNDLE CONTAINS ONLY WHAT WAS ACTUALLY HANDED OFF. Measured:
 *     `3 partial: sent=1 skipped=1 bundleContainsSkipped=true
 *     skippedHandoffOnDisk=null` — a lane whose handoff write failed was
 *     SKIPPED in the ledger and still shipped inside the returned bundle, so
 *     the consumer read a result the ledger says was never sent, and could
 *     never acknowledge it. The stamp set and the payload are now made
 *     consistent by construction (see the fixpoint loop).
 *  2. NO SILENT EXCERPT SUBSTITUTION. Measured: `3 missing-result-file:
 *     excerptAcknowledged=true` — a missing authoritative file fell back to the
 *     bounded `resultExcerpt` and that truncation was then acknowledged as a
 *     complete delivery. DECIDED DELIBERATELY: refuse. A lane whose result file
 *     is gone is skipped with a reason naming the file; it stays held and
 *     visible (its excerpt is still on the rail item, and the user can read and
 *     dismiss it) rather than being silently shipped as if whole. The rejected
 *     alternative — ship it marked but never acknowledgeable — recreates the
 *     permanent-stranding class round 2 was spent removing.
 *  3. THE RECEIPT IS NONCE- AND CHANNEL-BOUND, via the store's own
 *     `receiptDigest` (see `lanes.ts`), not a second local implementation.
 */
export function process(itemIds: string[], opts: { projectId?: string | null; now?: number; channel?: string } = {}): DrainBundle {
  const items = pending({ projectId: opts.projectId, now: opts.now });
  const wanted = new Set(itemIds);
  const chosen = items.filter((i) => wanted.has(i.id));
  const channel = opts.channel ?? DEFAULT_CHANNEL;
  const laneIds: string[] = [];
  for (const i of chosen) for (const id of i.laneIds) if (!laneIds.includes(id)) laneIds.push(id);

  /* ---- gather the candidates, refusing anything we cannot send WHOLE ---- */
  const skipped: DrainBundle['skipped'] = [];
  let candidates: DrainBundle['lanes'] = [];
  /* ROUND 9 (finding 3): the immutable generation of the exact record each result
   * was read from, so the handoff stamp can refuse if the row is swapped meanwhile. */
  const genById = new Map<string, string>();
  for (const id of laneIds) {
    const rec = lanes.get(id);
    if (!rec) { skipped.push({ id, why: 'no longer in the ledger' }); continue; }
    genById.set(id, rec.generation);
    const text = lanes.readResult(id);
    if (text == null) {
      /* RULE 2 — the authoritative file is the result. Its excerpt is a label. */
      const why = `the authoritative result file is unreadable or missing (${rec.resultPointer ?? 'no pointer was ever recorded'}), and this will not ship a bounded excerpt in its place — a truncated result acknowledged as a complete one is a worse outcome than an uncollected one. The excerpt is still on the record and on the rail; discard the item if it is all you need.`;
      try { lanes.markHeldReason(id, why); } catch { /* best effort */ }
      skipped.push({ id, why });
      continue;
    }
    candidates.push({ id, label: rec.label, state: rec.state, failureKind: rec.failureKind, text });
  }

  /*
   * RULE 1 — A FIXPOINT, so the payload and the stamp set cannot disagree.
   *
   * The digest must cover the exact bundle that is returned, and a lane can
   * only be in that bundle if its handoff was really recorded. Those two facts
   * are mutually dependent, so: compute the bundle over the current candidate
   * set, attempt to stamp every member of it, drop the failures, and repeat.
   * The set only ever shrinks, so this terminates; two iterations suffice in
   * practice and the bound is a guard, not an expectation.
   */
  const nonce = lanes.receiptNonce();
  let bundle = '';
  let bytes = 0;
  let sent: DrainBundle['lanes'] = [];
  /*
   * THE BOUND IS N+1, NOT 4, AND EXHAUSTION REFUSES THE WHOLE DRAIN.
   *
   * Each failing pass removes at least one lane, so the set converges in at
   * most `laneIds.length` passes; a fixed bound of 4 could be exhausted by
   * sequential failures. Measured by a cross-provider review:
   *   3-fixpoint {"writes":14,"sent":0,"skipped":["e","d","c","b"],
   *               "payloadIds":["a","b"],"diskStamped":["a","b","c","d"]}
   * — the loop ran out, and the function then returned a PAYLOAD containing a
   * skipped lane while the DISK carried stamps for lanes not in the payload.
   * That is exactly the invariant the fixpoint was introduced to guarantee,
   * violated by its own escape hatch.
   *
   * So: the bound is derived from the input, and if it is ever hit anyway the
   * drain REFUSES — empty payload, every lane skipped with a reason. Returning
   * an inconsistent pair is the one unacceptable option, and "we could not
   * agree with the disk, so we sent nothing" is always safe: the results stay
   * held and the next drain re-stamps them.
   */
  let converged = false;
  for (let attempt = 0; attempt <= laneIds.length && candidates.length; attempt++) {
    const trial = renderBundle(candidates);
    const trialBytes = Buffer.byteLength(trial, 'utf8');
    const trialDigest = lanes.receiptDigest(nonce, channel, trial);
    const evidence = `group-settle drain ${lanes.encodeReceiptFacts({ sha256: trialDigest, nonce, channel })} — ${trialBytes} bytes across ${candidates.length} lane(s), as part of ${chosen.map((c) => c.id).join(', ')}`;
    const ok: DrainBundle['lanes'] = [];
    const failedNow: DrainBundle['skipped'] = [];
    for (const l of candidates) {
      try {
        /*
         * `restampHandoff`, NOT `markHandoff`: a lane can legitimately be
         * drained more than once (the advertised "re-offered, not lost" path),
         * and first-wins would keep a digest from an earlier, differently
         * shaped bundle so no honest receipt for THIS send could ever match.
         */
        lanes.restampHandoff(l.id, trialBytes, evidence, genById.get(l.id));
        ok.push(l);
      } catch (e) {
        try { lanes.markHeldReason(l.id, `the drain could not record handing this result over (${(e as Error).message}), so it was NOT sent and stays held`); } catch { /* best effort */ }
        failedNow.push({ id: l.id, why: (e as Error).message });
      }
    }
    if (!failedNow.length) {
      /* Every candidate stamped against THIS bundle: payload and disk agree.
       * `trialDigest` is recorded in the evidence (on disk) but NOT returned —
       * finding 1: the response must never carry the value acknowledge compares. */
      sent = ok; bundle = trial; bytes = trialBytes; converged = true;
      break;
    }
    skipped.push(...failedNow);
    candidates = ok;          // recompute the bundle without them and stamp again
  }
  if (!candidates.length) converged = true;   // nothing left to send is consistent
  if (!converged) {
    for (const l of candidates) {
      const why = 'the drain could not produce a payload that matches what the ledger recorded (repeated write failures), so NOTHING was sent rather than sending a bundle the ledger disagrees with';
      try { lanes.markHeldReason(l.id, why); } catch { /* best effort */ }
      skipped.push({ id: l.id, why });
    }
    candidates = [];
  }
  if (!candidates.length) { bundle = ''; bytes = 0; sent = []; }

  return {
    receipt: { nonce, channel, bytes },
    itemIds: chosen.map((c) => c.id),
    lanes: sent,
    bundle,
    skipped,
  };
}

function renderBundle(ls: DrainBundle['lanes']): string {
  return ls.map((l) => `── ${l.label} (${l.id}) — ${l.state}${l.failureKind ? ` / ${l.failureKind}` : ''}\n${l.text}`).join('\n\n');
}

/** The destination the rail delivers into — the analogue of the socket's fd. */
const DEFAULT_CHANNEL = 'composer';

/** How the expected digest is embedded in (and recovered from) the handoff. */
/*
 * The expected receipt is recovered FROM THE RECORD, not held in memory, so the
 * check still works after a restart and cannot be bypassed by a process that
 * never did the send. `restampHandoff` rewrites this on every drain, so the
 * nonce ROTATES per send — which is what makes replay impossible rather than
 * merely unlikely.
 *
 * STRUCTURED, not regex-parsed: a review found the old channel pattern
 * truncating `composer/main` to `composer` and refusing a valid receipt.
 */
const expectedFacts = lanes.decodeReceiptFacts;

/**
 * The consumer's half. Stamps `acknowledged` ONLY against a receipt that proves
 * possession of the exact bytes `process()` returned — a digest the caller can
 * only produce by having them. A wrong or absent digest leaves every lane held.
 */
export function acknowledge(
  laneIds: string[],
  receipt: { bytes: number; digest: string; nonce?: string; channel?: string },
  by: lanes.LaneAcknowledgedBy = 'group-settle',
): { acknowledged: string[]; refused: { id: string; why: string }[] } {
  const acknowledged: string[] = [];
  const refused: { id: string; why: string }[] = [];
  for (const id of laneIds) {
    const rec = lanes.get(id);
    if (!rec) { refused.push({ id, why: 'not in the ledger' }); continue; }
    if (rec.handoffAt == null) {
      const why = 'Orchard has no record of sending this result, so a receipt for it cannot be genuine';
      try { lanes.markHeldReason(id, why); } catch { /* best effort */ }
      refused.push({ id, why });
      continue;
    }
    /*
     * THE PROOF IS COMPARED, NOT MERELY SHAPED. The expected digest is the one
     * this store recorded when it handed the bytes over; a receipt that does
     * not reproduce it cannot have been computed from the bytes, so whatever
     * the caller holds, it is not this result. Byte count must match too — a
     * truncated response has a different length and a different digest, and
     * checking both means a mismatch names WHICH way it went wrong.
     */
    const facts = expectedFacts(rec.handoffEvidence);
    const want = facts?.sha256 ?? null;
    const wantNonce = facts?.nonce ?? null;
    const wantChannel = facts?.channel ?? null;
    const got = receipt && typeof receipt.digest === 'string' ? receipt.digest : null;
    /*
     * DECLARED, NOT NON-EMPTY. `!wantChannel` rejected the empty string, so a
     * lane handed over on a channel of `''` could never be acknowledged at all:
     * `2 channel "" sent=1 ack=0` (third cross-provider review). The channel is
     * documented as a FREE string — whatever the next caller picks — and the
     * empty one is a value like any other. The question is whether the sender
     * recorded the field, which is what `decodeReceiptFacts` already type-checks.
     * `sha256` and `nonce` are still required to be non-empty: an empty digest
     * or nonce is not a choice a caller makes, it is a missing fact.
     */
    if (!want || !wantNonce || wantChannel == null) {
      const why = `this lane's handoff recorded no checkable receipt (${JSON.stringify(String(rec.handoffEvidence).slice(0, 80))}), so no receipt for it can be verified and none will be trusted`;
      try { lanes.markHeldReason(id, why); } catch { /* best effort */ }
      refused.push({ id, why });
      continue;
    }
    /*
     * REPLAY AND DESTINATION, using the SAME rule as the socket transport.
     *
     * Measured before this: `oldReceiptAccepted=1 channelOmitted=true` — a
     * receipt from an EARLIER drain acknowledged a later, byte-identical
     * bundle, and no destination had to be named at all, because this path had
     * reimplemented only the possession third of a rule the ledger already
     * enforced in full. The nonce on the RECORD rotates on every send
     * (`restampHandoff` rewrites the evidence), so a stale receipt now names a
     * nonce that no longer applies; and the channel must be stated, so
     * "I hold these bytes" can no longer pass as "I delivered them where you
     * asked".
     */
    if (receipt?.nonce !== wantNonce) {
      const why = `the receipt is not for THIS send: it carries nonce ${receipt?.nonce ? `${String(receipt.nonce).slice(0, 12)}…` : '(none)'} but the send being acknowledged used ${wantNonce.slice(0, 12)}…. A receipt from an earlier drain cannot acknowledge a later one, even when the bytes are identical. The result stays held.`;
      try { lanes.markHeldReason(id, why); } catch { /* best effort */ }
      refused.push({ id, why });
      continue;
    }
    if (receipt?.channel !== wantChannel) {
      const why = `the receipt does not state the destination this result was sent to: expected channel ${JSON.stringify(wantChannel)}, got ${JSON.stringify(receipt?.channel ?? null)}. Possession alone is not delivery. The result stays held.`;
      try { lanes.markHeldReason(id, why); } catch { /* best effort */ }
      refused.push({ id, why });
      continue;
    }
    if (!lanes.receiptMatches(want, got) || !Number.isFinite(receipt.bytes) || receipt.bytes !== rec.handoffBytes) {
      /* ROUND 11 (finding 1) — DO NOT ECHO THE EXPECTED DIGEST, even partially.
       * The message used to print `want.slice(0,16)` — 16 hex chars of the value
       * the caller is trying to reproduce. The response must never carry the
       * comparison value, so only the PRESENTED digest and the expected BYTE
       * count (not a secret) are named; the expected sha256 stays on disk. */
      const why = `the acknowledgement did not prove possession of what was sent: expected a sha256 over ${rec.handoffBytes} bytes, got ${got ? `${got.slice(0, 16)}…` : 'no digest'} over ${receipt?.bytes}. The result stays held and pullable.`;
      try { lanes.markHeldReason(id, why); } catch { /* best effort */ }
      refused.push({ id, why });
      continue;
    }
    try {
      lanes.markAcknowledged(id, by, `pending-rail receipt: ${receipt.bytes} bytes across ${laneIds.length} lane(s), nonce ${wantNonce.slice(0, 12)}…, delivered to channel ${JSON.stringify(wantChannel)}`, receipt.digest);
      acknowledged.push(id);
    } catch (e) {
      const why = (e as Error).message;
      try { lanes.markHeldReason(id, `a valid receipt arrived but the acknowledgement could not be recorded (${why}) — the result stays held and pullable`); } catch { /* best effort */ }
      refused.push({ id, why });
    }
  }
  return { acknowledged, refused };
}
