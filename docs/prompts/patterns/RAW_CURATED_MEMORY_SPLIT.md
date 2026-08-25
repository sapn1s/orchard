# Pattern — Raw + curated memory split

**Shape:** two files (or streams) per memory topic, not one. A RAW file is
append-only — every observation lands there verbatim, in order, never edited
or pruned. A CURATED file is the separately-maintained rollup — a human- or
agent-written summary distilled FROM the raw stream, rewritten (not
appended) whenever it goes stale.

## When to use
- Observations arrive faster than they can be meaningfully synthesized (logs,
  session notes, monitoring hits) — you need the full record for later
  investigation, but reading it all every time is too expensive.
- Readers usually want the CURRENT understanding, not the history that
  produced it — the curated file serves that reader without them needing to
  scroll years of raw entries.
- You've been burned by lossy summarization before — the raw stream is the
  insurance policy: if a curated summary turns out wrong or incomplete,
  the raw record is still there to re-derive it from.

## When NOT to use
- The topic doesn't accumulate — a one-off note doesn't need two files.
- Nobody will ever re-derive from raw — if the curated summary is always
  trusted and the raw stream never gets read back, it's dead weight; a single
  living doc is simpler.

## How to run it
1. RAW file: strictly append-only, one entry per observation, timestamped.
   Never rewritten, never pruned (or pruned only by an explicit, separately
   logged retention policy — not silently).
2. CURATED file: a rollup that IS rewritten in place as understanding
   changes — it is not append-only, that's the raw file's job. State clearly
   at the top of the curated file that it's a distillation and point back to
   the raw file for full history.
3. Curation is a deliberate, occasional pass (not continuous) — read the raw
   entries since the last curation pass, fold them into the curated summary,
   note the raw entries covered so the next pass knows where to resume.
4. Readers default to the curated file; they only open raw when they need to
   verify a specific claim or re-derive something the summary dropped.

## Failure modes to avoid
- Editing the raw file to "clean it up" — destroys the property that makes
  it trustworthy insurance against a bad summary.
- Letting curation lapse so long that the curated file silently drifts from
  what the raw stream actually shows — stamp the curated file with what raw
  range it reflects.
