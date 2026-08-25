# Pattern — Index-table router

**Shape:** a small root document that is nothing but a table (or short list)
pointing to topic/playbook files, each of which holds the actual detail. The
root never grows past a page; all growth happens in the leaf files it points
to.

## When to use
- Knowledge accumulates over time (playbooks, runbooks, per-topic notes) and
  a flat single doc would eventually blow the context budget every reader
  pays just to find the one section they need.
- Readers usually need ONE topic at a time, not the whole corpus — a router
  lets them load only that leaf file.
- New topics get added faster than existing ones get rewritten — an index
  table absorbs new rows cheaply without restructuring the whole doc.

## When NOT to use
- The corpus is small and stable (a handful of short sections) — a single
  flat doc is simpler and the indirection just costs an extra read.
- Topics are tightly cross-referential (readers need most of them together
  most of the time) — splitting fights the natural access pattern.

## How to build it
1. Root file (e.g. `INDEX.md`) is a table: topic name, one-line description
   of what's in it, path to the leaf file. Nothing else — no prose, no
   detail that belongs in a leaf.
2. One leaf file per topic, self-contained (a reader who jumps straight to
   the leaf via a link should not need the root's context to understand it).
3. Every new topic gets a new leaf file + one new row in the root — never a
   new section bolted onto an existing leaf unless it's genuinely the same
   topic.
4. Keep the root's row descriptions accurate and current — the root's whole
   value is letting a reader pick the right leaf WITHOUT opening it first.

## Failure modes to avoid
- Letting the root accumulate prose/detail "just this once" — it's a slow
  leak that eventually recreates the flat-doc problem the pattern exists to
  avoid.
- Leaf files that assume the reader also read the root or sibling leaves —
  defeats the point of loading only what's needed.
- Rows that go stale (topic renamed/split but the root not updated) — the
  router becomes actively misleading, worse than no router.
