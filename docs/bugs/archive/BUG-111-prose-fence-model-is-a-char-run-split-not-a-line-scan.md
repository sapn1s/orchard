# BUG-111 — prose() models a code fence as a character-run split, not a line scan, so it disagrees with the block grammar about what a fence is

- **Status:** OPEN — divergence-class; unify prose()'s fence model with the block grammar. Do NOT start until response-blocks.js settles (it is under active change).
- **Severity:** medium — content stays VISIBLE in realistic cases (divergence, not the hidden-content class), but it is the same parser-vs-renderer disagreement that produced five BROKEN verdicts on the block grammar, and it is the last such disagreement designed in rather than accidental
- **Area:** frontend — the shared markdown renderer `prose()` in `public/lib/dom.js`, whose fence model diverges from the block grammar in `public/lib/response-blocks.js`
- **Reported:** 2026-08-19, from the BUG-110 lane's real-browser investigation (it gathered the evidence below while fixing an over-wide-table content-loss bug and correctly declined to fix this larger, lower-severity defect inside that charter)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED (it rewrites the shared renderer's fence model)

## In plain terms

The app has two halves of one rendering pipeline that must agree on where a fenced code block starts and ends. `public/lib/response-blocks.js` — the block grammar, which has been through five clean-room rounds — now scans fences line by line, parameterised on the fence character: it honours the closer being at least as long as the opener, info strings, 0–3 spaces of indentation, and both fence characters (backtick and tilde, which CommonMark treats as equal citizens). `prose()` in `public/lib/dom.js`, the renderer the whole app uses to turn model- and file-provided markdown into DOM, still models a fence as `src.split(/```/)` — it splits the whole string on runs of backticks and calls every other chunk "code". That is a character-run splitter, not a line-based scanner. So the two halves disagree about what a fence is and where it ends.

Because they disagree, real-browser evidence (gathered by the BUG-110 lane) shows:

- A `~~~` (tilde) code block is invisible to `prose()` — it only knows backticks — so the block renders as **live prose**. A `#` inside it becomes a real heading; a `| a | b |` line becomes a real table. The fenced content is shown, but shown wrong.
- A fence opened **inside a blockquote or a list item** leaks its `>` and its indent markers into the rendered `<pre>`, because the splitter has no notion of the line context a fence sits in.

Content generally stays visible, so this is the **divergence** class, not the hidden-content class that has produced five BROKEN verdicts on the block grammar. But a parser and a renderer disagreeing about a region's extent is precisely the shape those five defects took, and this is the last place where that disagreement is designed in rather than accidental. The block grammar in `response-blocks.js` is the **source of truth**; the goal is one shared understanding of a fence, not a second implementation that happens to agree today.

**Sequencing — do not start yet.** `response-blocks.js` is under active change right now (see the in-flight FEAT-091 work). Building the shared fence model against it while it moves means building against a moving target. This work should start only once that grammar settles.

**Why it was not fixed in the finding lane.** Replacing `prose()`'s fence model does not just add tilde support — it changes backtick edge-case behaviour too (today an inline ```` ``` ```` run splits), and so perturbs every existing renderer suite. That makes it a core-renderer rewrite with its own regression surface, at a **lower** severity than the content-loss charter (BUG-110) it was found under. Per the coordinator's explicit offer, it is a separate ticket rather than folded into that hotfix.

> Everything below is the technical record — reference, not needed to understand the change above.

## Symptom

Two observed renderings, both from a real browser (BUG-110 lane):

```
~~~js
# not a heading
| a | b |
~~~
```

renders with `preCount 0` — no `<pre>` at all; the `#` line renders as a real `<h?>` and the `| a | b |` line as a real `<table>`, because `prose()` never recognised the `~~~` opener as a fence.

A fence opened inside a blockquote or a list item renders a `<pre>` whose body still contains the leading `>` / indentation markers of the enclosing construct.

## Repro

Feed `prose()` (or any surface that renders model/file markdown — assistant messages, plan cards, guide pages, ticket bodies) a `~~~`-fenced block, or a backtick fence nested inside a `>` blockquote or an indented list item. Compare against `response-blocks.js`'s line-based scanner over the same input: the two disagree on the fenced region's extent.

## Expected

`prose()` and `response-blocks.js` share ONE understanding of a fence. Every fenced region `response-blocks.js` recognises, `prose()` renders as a `<pre>` with the same extent, under either fence character, at any legal indentation, inside a blockquote or list item, with the enclosing markers stripped from the `<pre>` body.

## Design guidance (already written down by the finding lane — reuse, do not re-derive)

`prose()`'s current model is `src.split(/```/)` (`public/lib/dom.js` line 327) plus an info-string strip `chunk.replace(/^[^\n]*\n/, '')` — a character-run splitter, not a line scanner. Replace it with a line-based scanner that matches the `response-blocks.js` grammar (the source of truth), specifically:

- **Parameterise the fence CHARACTER** — one scanner over backtick OR tilde, not a second tilde branch bolted onto the backtick path (a second branch is a second model that will drift, which is this bug).
- **Match closer length ≥ opener length** — a fence closes on a run of the SAME character, at least as long as the opener.
- **Handle info strings** — with CommonMark's one asymmetry: a backtick fence's info string may not contain a backtick; a tilde fence's may contain anything.
- **Handle 0–3-space indentation** of the opener/closer (4+ columns is indented code, not a fence).
- **Handle blockquote and list-item continuation** — a fence opened inside a `>` blockquote or an indented list item, with the enclosing `>`/indent markers stripped from the rendered `<pre>` body.

The aim is one shared fence understanding, not a parallel implementation that coincidentally agrees.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `public/lib/dom.js` — `prose()` (line 315; the fence model is `src.split(/```/)` at line 327 and the info-string strip at line 330). `public/lib/response-blocks.js` — the line-based, char-parameterised fence scanner that is the source of truth (see its header comment: both fence characters, closer-length, info-string and 0–3-indent rules; a tilde run never closes a backtick fence or vice versa).
- Related tickets: BUG-110 (over-wide table body row content loss — the lane that found this; its Activity-log handoff carries the same evidence and guidance); BUG-109 (lone-CR fence content loss, same renderer); ARCH-006 (line-ending normalisation owned per-renderer — same "two halves of the pipeline hold independent models of one grammar" class); FEAT-091 (the response-blocks.js work currently in flight — the reason this is sequenced AFTER it settles).
- Repro test: `npm run verify:bug-109` real-browser suite renders the shipped `/lib/dom.js`; a fence-divergence case can be added there or in a new `verify:bug-111` when the fix lands. No test exists yet.
- Known dependencies / blockers: BLOCKED on `public/lib/response-blocks.js` settling — it is under active change (FEAT-091). Building the shared fence model against a moving grammar is building against a moving target.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — filed by the coordinator from the BUG-110 lane's handoff
- **Understood:** two halves of one render pipeline hold independent, drifting models of a fence — `prose()` a character-run split on backticks (`src.split(/```/)`), `response-blocks.js` a line-based, char-parameterised scanner. The BUG-110 lane gathered real-browser evidence of the consequences (tilde blocks rendering as live prose so an inner `#`/`|` becomes a real heading/table; blockquote/list-item fences leaking their `>`/indent into the `<pre>`) and deliberately did NOT fix it inside its content-loss charter, because unifying the fence model changes backtick edge-case behaviour too and perturbs every renderer suite — a core-renderer rewrite with its own regression surface at a lower severity than the content-loss bug it was found under.
- **Changed:** nothing — this is the filing entry, no product code touched.
- **Still open / handoff:** do the unification once `response-blocks.js` settles (currently changing under FEAT-091). Make `prose()` share the block grammar's fence understanding: parameterise the fence character, match closer length ≥ opener length, handle info strings, handle 0–3-space indentation, handle blockquote and list-item continuation. The block grammar is the source of truth; the goal is one shared understanding, not a second implementation that happens to agree today. This is `fix`-class and touches the shared renderer, so it needs an independent clean-room verify before VERIFIED (content-loss-adjacent, regression-prone renderer).
