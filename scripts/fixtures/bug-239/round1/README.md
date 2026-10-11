Pinned round-1 copies of `src/server/park-guard.ts` and `src/server/lane-incidents.ts`
(BUG-239, as verified BROKEN by independent run d8d016bd, candidate fad7e757739c).
The only edit is the relative import path to `src/lib/paths.ts`. They are the FIXED
must-FAIL baseline for arms R1/R2 of `scripts/verify-bug-239-bound-hangs-no-park.mjs`:
those arms must reproduce both breaks here and pass on the current modules. Never update them.
