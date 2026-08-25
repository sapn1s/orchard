# BUG-116 — enabling the stealth browser LAUNCHED it: a Chrome window per session, for sessions that never touch a browser

- **Status:** IN-PROGRESS — fixed for `direct` isolation; `container` unchanged and still eager (see "What is NOT fixed")
- **Severity:** medium
- **Area:** server — browser attach / session start (`src/server/browser.ts`, `src/server/agent-bridge.ts`)
- **Reported:** 2026-08-19 by the user, from live use: *"every new session on first message spawns a browser of 'about:blank' and doesn't close it"*
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.
  It touches the session-start path and the MCP attach seam, and it introduces a
  new process that stands between the model and a browser; a self-written
  fixture is not the last word on that.

## The argument

Turning a tool ON is not using it. A project with the stealth browser enabled
got a real, headful, logged-in Chrome window the moment a session took its first
message — sitting on `about:blank`, doing nothing, for the overwhelming majority
of sessions that never make a single browser call. Nothing closed it, because
nothing had asked for it in the first place; it was left to the daemon's
fifteen-minute idle timeout to notice.

That is the wrong shape twice over. The visible half is a window the user did
not ask for. The invisible half is worse: a Chrome-sized resident set, a
per-project profile unlocked and warm, and a browsing session opened by a
process that had no intention of browsing.

The fix is that the browser exists exactly when something needs it. A session
that never calls a browser tool now launches nothing at all; the first tool call
brings the daemon and Chrome up, and the tools behave identically once it does.

The correction that matters for anyone reading this later: there were **two**
independent triggers, and fixing either one alone leaves the window open. The
obvious one — `startSession()` calling `browser.start()` — is not the one that
would have kept biting.

## Not the reported cause

The first hypothesis was that this came from BUG-108, which pinned
`@playwright/mcp` and pointed it at an existing browser with `--executable-path`.
It did not. Probed directly against the provisioned binary with the exact
arguments a session receives, `initialize` + `tools/list` on the Playwright MCP
server leaves the browser count **unchanged (87 → 87)**. Serena's pinned server
does the same. Neither is involved.

The mechanism is older than BUG-108 and is present in the first commit of this
repository's history. It is a regression only in the sense that the user
noticed it; nothing recent caused it.

<!-- ------------------------------ technical detail below this line ------------------------------ -->

## Repro

```
# scratch server, scratch data dir, scratch browser state, free port, fake CLI
project: isolation=direct, settings.browser.enabled=true
start a session, send ONE message, let the model reply without calling any tool
```

Before the fix, counting by `/proc/<pid>/cmdline` for the project's own
`--user-data-dir` (never `pgrep` — see verify-browser's note):

```
browser processes for the project BEFORE the message : 0
NEW browser processes after ONE message              : 13
  pid …892  chrome --remote-debugging-port=36937 --user-data-dir=<state>/projects/<id>/chrome-data …
  (+ crashpad ×2, zygote ×2, gpu-process, network, storage, 3 renderers, data_decoder)
STILL ALIVE after the session ends                   : 13
```

The launched binary is the adapter's Chrome for Testing
(`~/.cache/puppeteer/chrome/linux-151.0.7922.47/chrome-linux64/chrome`), started
headful (`SBMCP_HEADLESS` defaults to `false`, deliberately — a headless Chrome
is detectable and the whole point of this adapter is that it is not). A fresh
headful Chrome on a fresh profile is a window showing `about:blank`. That is
precisely what was reported.

## The two triggers

**Trigger 1 — the station started it.** `startSession()` ran
`browser.start(project)` for every browser-enabled project, unconditionally,
before the container step. The comment explaining it is about the container's
bind mount, which is a real constraint — but it was being applied to `direct`
too, where no bind mount exists.

**Trigger 2 — and this is the one that survives fixing trigger 1.** Removing the
eager start alone changes nothing a user would see. Every CLI lists the tools of
every MCP server it is handed, at session start. The adapter's shim answers
`tools/list` by asking the daemon:

```js
case 'tools/list':
  if (!toolCache) toolCache = (await call('tools/list', {}, 90_000)).tools;
```

`call()` → `ensureDaemon()` → spawn the daemon → and the daemon's `main()`
does `await launch()` **before** it starts serving. So merely LISTING the tools
starts Chrome. Measured live, on the pre-fix path, with the eager start already
removed: **11 Chrome processes after nothing but `initialize` + `tools/list`.**

That measurement is the reason the first reproduction was not enough. It used a
scripted fake CLI, which never spawns the MCP servers at all, so it could only
ever see trigger 1. The real CLI sees both.

## The fix

The tool table never needed the daemon. It is a static export the adapter keeps
in `src/tools.mjs` and the daemon hands straight back
(`if (msg.op === 'tools/list') return { tools: TOOLS }`).

`src/server/sbmcp-lazy-shim.mjs` (new, station-owned) sits in front of the
adapter's shim for `direct` isolation and answers the whole no-side-effect half
of the protocol — `initialize`, `tools/list`, `resources/list`, `prompts/list`,
`ping` — out of that same table, spawning nothing. The first `tools/call` starts
the adapter's shim unchanged, and from then on the lazy shim is a byte pipe:
only requests it does not answer itself are forwarded, so every line the inner
shim writes is a reply to a line we forwarded, in the client's own id space —
no id rewriting and no request table to fall out of step.

Two supporting changes:

- `mcpServerFor()` now carries `SBMCP_IDLE_MS` on the direct shape. The shim's
  own autostart spawns the daemon with no `--idle-ms`, so without this a
  project's configured idle timeout would silently revert to the adapter's
  15-minute default on the path that now actually starts Chrome.
- `available()` now also requires `src/tools.mjs`, because the lazy shim serves
  the tool table from it — an adapter missing that file could no longer list
  tools without a daemon, and that must be an honest precondition failure rather
  than a surprise at `tools/list` time.

`startSession()` keeps its availability check, so a missing adapter still
refuses the session outright: handing back a session silently missing the
browser the user enabled only moves the failure to mid-task.

## What is NOT fixed: container isolation

A `container` project still launches the browser at session start, and this is
structural rather than an oversight:

- the container bind-mounts the socket **file**, and docker creates a root-owned
  **directory** at a missing mount source — it would fail to be a socket and
  would leave a root-owned directory in the user's state dir;
- the socket only exists while the daemon is serving;
- the container's shim is deliberately run with `SBMCP_AUTOSTART=0` — a
  container must never spawn Chrome, because it would be the wrong, detectable
  Chrome — so nothing inside the container can bring the daemon up later.

Three shortcuts were considered and rejected with reasons, so they are not
re-tried:

- **Bind the project's browser directory instead of the socket file.** It works,
  and it exposes `chrome-data` — the logged-in profile, cookies included — to
  the container. That is a worse bug than the one being fixed.
- **Relocate the socket to a dedicated sub-directory and bind that.** The daemon
  accepts `--socket`, but the adapter's `stop` and `status` derive the socket
  from the project root with no override, so relocating it breaks both.
- **Start the daemon lazily from `canUseTool` when a browser tool is requested.**
  Container sessions default to `bypassPermissions`, where ordinary tool calls
  never reach that callback.

Making the container path lazy needs either a lazy-Chrome mode in the adapter
(move `await launch()` out of `main()` and behind the first tool call — about
five lines, in a repo outside this one) or a host-side socket-activation proxy
in the station. Both are real work with their own proof bar and neither belongs
in this fix.

## Who owns closing it, and how this differs from BUG-114

**Distinct mechanism, not a duplicate.** BUG-114 is about ownership *loss*:
session hosts escape into their own systemd scopes, outlive the harness that
spawned them, and end up with no owner at all. This browser was never
unowned — it had a documented owner the whole time (the daemon's own idle
timeout, plus `browser.stop()` on project delete, plus `sbmcp reap`). The defect
was that it was **started for nothing**, so the owner was reclaiming something
that should never have existed.

The lifetime policy is deliberately unchanged: the daemon outlives a session on
purpose, because that is what keeps a login warm, and it is deliberately left
running across a server restart. With the launch made lazy, that policy now
applies only to a browser some session actually asked for.

**Count.** Measured, not inferred: three consecutive sessions against one
project produced **10, 10, 10** Chrome processes — the same daemon, reused. So
it is at most one browser per project, not one per session and not one per
message. A new one appears when a session starts after the previous daemon's
idle timeout has expired, which is why it reads as "every new session".

## Census: which browsers on this machine are from this bug

Taken while investigating, so the cleanup question has an honest answer.
**None.** All three real browser-enabled projects reported
`running: false, chrome_procs_live: 0`. Of the root browser processes alive:

- **1** is the user's own daily-driver Brave (parented to init);
- **7** are headless `about:blank` orphans from verification harnesses — three
  from one renderer suite's scratch profiles, plus four other one-off profiles —
  all reparented, i.e. their spawners are gone. That is the BUG-114 family, not
  this one.

Nothing was killed that this lane did not start.

## Context pack

- Files/functions in play: `src/server/sbmcp-lazy-shim.mjs` (new),
  `src/server/browser.ts` (`mcpServerFor`, `available`, `toolsModulePath`,
  `lazyShimPath`), `src/server/tools.ts` (`plannedMcpServers`),
  `src/server/agent-bridge.ts` (`startSession`, the browser-before-container block).
- Adapter files the mechanism lives in (outside this repo): the shim's
  `tools/list` handler, the daemon's `main()`, and its static `TOOLS` export.
- Related tickets: BUG-108 (ruled out as the cause, with a measurement),
  BUG-114 (adjacent leak, different mechanism), BUG-035 (the two-shape MCP attach
  seam this rides on).
- Repro test: `npm run verify:bug-116` — includes a live must-FAIL control that
  drives the pre-fix wiring in the same run and asserts the browser appears.
- Known dependencies: the adapter repo and a Chrome the adapter can launch.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — fix lane

**Understood.** Reproduced first, changed nothing until it was reproduced. A
`direct`, browser-enabled project, one message, no tool use: 0 → 13 browser
processes, all still alive after the session ended. Then found the second
trigger by driving the real MCP shim by hand, which is what the fake-CLI
reproduction structurally could not see.

**Ruled out** the reported hypothesis with a measurement rather than an
argument: Playwright MCP `initialize` + `tools/list` on the pinned binary with
the exact session arguments left the browser count at 87 → 87; Serena the same.

**Changed.** New `src/server/sbmcp-lazy-shim.mjs`; `browser.ts` points `direct`
at it, carries `SBMCP_IDLE_MS`, and requires the adapter's `tools.mjs`;
`tools.ts` passes the project's idle setting through; `agent-bridge.ts` starts
the browser only for `container` and reports "armed" otherwise.

**Verified** (numbers as printed, exit codes read directly, never piped):

| suite | result | exit |
| --- | --- | --- |
| `verify:bug-116` (new) | 16 passed, 0 failed | 0 |
| `verify:browser` — REAL session, real model, real bot-walled site | 24 passed, 0 failed | 0 |
| `verify:container` | 19 passed, 0 failed | 0 |
| `verify:tool-toggle` | 16/16 | 0 |
| `verify:mcp-attach` | 26/26 | 0 |
| `verify-bug-107-image-staleness` | 23/23 PASS (0 FAIL, 0 SKIP) | 0 |
| `verify-bug-108-playwright-pin` | 20/20 PASS (0 FAIL, 0 SKIP) | 0 |
| `npm run gate` | leak-gate PASS, check-nul PASS, typecheck PASS | 0 |

The strongest of these is `verify:browser`: it drives a real model through the
new shim to a site plain `curl` gets a bodyless 403 from, and the model came
back with the page title and a named job posting. The tools were not broken to
stop the window.

Inside `verify:bug-116` the pair that carries the argument:

```
PASS  initialize + tools/list through the LAZY shim starts NOTHING
      observed: 0 chrome process(es); 11 tools listed
PASS  MUST-FAIL CONTROL: the same tools/list through the ADAPTER shim (the old wiring) DOES open a browser
      observed: 11 chrome process(es) after a mere tools/list on the pre-fix path
PASS  the lazily served tool table is byte-identical to the one the daemon serves
```

**Still open.** Container isolation, argued above. Every daemon this lane
started was stopped through the adapter's own CLI against a scratch state dir
and confirmed at zero processes; nothing else was touched.

**Handoff.** An independent pass should attack the pipe rather than the launch
count — that is where a fixture written by the author is weakest. Specifically:
a `tools/call` arriving before the inner shim has finished starting; two calls
in flight at once; a client that sends `tools/list` *after* the inner shim is
up (the reply must still come from the static table and must still match); the
inner shim dying mid-call; and a partial JSON line split across two stdin
chunks. Also worth checking that nothing else in the tree still assumes a
`direct` session has a live browser at `session-init`.

**Symptom of a deeper design flaw?** Yes, in a small way, and it is already
written down rather than filed: "listing what a tool can do" and "making the
tool ready to do it" were the same operation. Any MCP server that answers
discovery by waking its backend has this bug. Worth an ARCH ticket only if a
second one shows up.

### 2026-08-19 — independent clean-room verification (df13918)

- **Verified-by:** dispatch openai run 01a01982-32d1-7630-a313-bf8689faf8d3 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

### 2026-08-19 — the two relay defects the clean-room pass found, fixed

`regressed-from: BUG-116` (df13918 — this lane's own first cut).

The clean-room pass confirmed the half the ticket was about: through the new
shim, `tools/list` starts **0** Chrome processes, the same request through the
old wiring starts **10**, a real `tools/call` renders a real page, and cleanup
leaves nothing behind. It then attacked the relay, which is exactly where the
handoff above said a fixture written by the author would be weakest, and it was
right twice. Its script is reproduced verbatim as case A of section 5 of
`verify:bug-116`; against df13918 it printed

```
{"replyIds":[42,41],"parseErrorCount":0,"replyCount":2}   exit 1
BROKEN: malformed input was dropped and/or later local reply overtook an
        earlier forwarded request
```

**Defect 1 — malformed input was logged and dropped.** `bad json from client:
…` and then `continue`. The client's request simply vanished and the caller
waited forever. JSON-RPC has `-32700` for precisely this; it is now sent.

**Defect 2 — replies came back out of request order.** The cause is in the
ticket's own design note: *"that makes relaying a byte copy: no id rewriting, no
request table, nothing to get out of step."* That reasoning is sound about
*identity* and wrong about *time*. Two answer sources run at different speeds —
a `ping` answered locally in microseconds is written while an earlier
`tools/call` is still out at the daemon — so `inner.stdout.pipe(process.stdout)`
reorders the conversation. Six requests in flight on the pre-fix shim come back
`[2,6,4,3,5,1]`.

**The structure, and what it makes unrepresentable.** Every request that will
produce a reply takes a slot in one FIFO (`outbox`) at the moment its line is
parsed — synchronously, before anything is answered, forwarded or awaited. A
slot is later *filled*: locally, by the matching inner reply, or by an error.
Bytes leave only by draining the head while the head is filled.

- **Unrepresentable, not guarded:** out-of-order release. The drain is the only
  writer to stdout (there is no `send()` any more) and it cannot skip an
  unfilled head, so no reply can precede one reserved earlier — regardless of
  how many are in flight, how fast a local answer is, or whether the inner shim
  itself answers out of order (it does; `[1,2,3,4,5,6]` comes back in order).
- **Unrepresentable:** answering twice. `fill()` is idempotent per slot and a
  slot is the only route to stdout, so the property the first cut got right is
  now structural rather than incidental.
- **Guarded, not unrepresentable:** *silence*. Each way a request can lose its
  answer is a separate arm — `-32700` for unparseable, `-32600` for a non-
  request, `-32603` from the inner shim's `exit` and `error` events for
  everything still outstanding. A new way to lose a request would need a new
  arm. This is the class to attack next.
- Inner output that answers nothing outstanding (a server notification, an
  unknown id) is neither dropped nor written immediately: it is given a slot at
  the tail. An id is matched by value *and* type against the **oldest**
  outstanding forwarded slot, so a client that reuses an id is still answered in
  order and still once.

The deliberate cost is head-of-line blocking: a fast local reply waits behind a
slow forwarded one. That is what "in request order" means, and it is what a
client pipelining requests is entitled to assume.

**Framing was also rewritten** (one `readLines` used for both streams): several
messages in one chunk, one message split across chunks, a final line with no
trailing newline, and a scan cursor so a large message is not re-scanned from
the start on every chunk.

**Verification.** Section 5 of `verify:bug-116` covers everything the clean-room
pass named as untested, each with a live must-FAIL control — the **actual
df13918 source**, recovered with `git show` and run in the same process (the
suite says which, and falls back to a labelled reproduction only if history is
unavailable).

| shape | fixed | pre-fix control |
| --- | --- | --- |
| malformed before forwarding | `parseErrors=1 ids=[null,41,42]` | `parseErrors=0 ids=[42,41]` |
| 6 in flight, inner answers out of order | `[1,2,3,4,5,6]` | `[2,6,4,3,5,1]` |
| answered twice | 0 duplicates | 0 duplicates (kept) |
| malformed *after* forwarding began | `parseErrors=1 ids=[51,null,52]` | `parseErrors=0 ids=[52,51]` |
| 3 messages in 1 chunk + 1 message in 3 chunks | `[61,62,63,64]`, payload intact | — |
| 4 MiB payload | 4194304 bytes, byte-identical | — |
| inner shim dies mid-call | error reply, shim still serves after | **no reply at all** |

| suite | result | exit |
| --- | --- | --- |
| `verify:bug-116` | **27/27 PASS** (was 17) | 0 |
| `verify:browser` | 24 passed, 0 failed | 0 |
| `verify:container` | 19 passed, 0 failed | 0 |
| `verify:tool-toggle` | 16/16 | 0 |
| `verify:mcp-attach` | 26/26 | 0 |
| `verify-bug-107-image-staleness` | 23/23 PASS | 0 |
| `verify-bug-108-playwright-pin` | 20/20 PASS | 0 |
| `npm run gate` | leak-gate PASS, check-nul PASS, typecheck PASS | 0 |

The lazy-start property was re-measured after the rewrite from `/proc`, not from
logs: `0 chrome process(es); 11 tools listed` through the lazy shim against `10
chrome process(es)` through the adapter shim, and the first real `tools/call`
returned the rendered fixture page (`"title": "BUG-116 fixture"`). A shim that
starts nothing because it forwards nothing would fail that pair.

**Note on the run.** `verify:browser` first failed in the working tree with
`SyntaxError: Identifier 'TICKET_FILE_RE' has already been declared` from
`scripts/board.mjs` — a concurrent lane's mid-edit state crashing the server at
boot, nothing to do with this change. All anti-regressions above were therefore
run in a `git worktree` at `HEAD` carrying only this lane's two files, where
`verify:browser` passes 24/0.

**Handoff, again.** The relay's remaining weak class is *silence*, and it is
guarded rather than structural. An independent pass should hunt for a request
that reaches `dispatch()` and reserves no slot, or reserves one nothing can
fill: an inner shim that accepts the write and then hangs forever without
exiting (there is no timeout — deliberate, since a browser call can legitimately
take minutes, but it means a wedged daemon is indistinguishable from a slow
one); `stdin` ending with forwarded requests still outstanding (`process.exit(0)`
runs without draining); and stdout backpressure on a payload larger than the
pipe buffer. Container isolation remains unfixed and eager, as argued above.

- **Verified-by:** dispatch openai run 01a01997-26e1-78b2-88b3-68aaa967cada (clean-room, `scripts/independent-verify.mjs`, range 05fd4dce..4f8d4884 with `docs/*` excluded via a synthetic base) — VERDICT: BROKEN

---

## Round 3 — the ordering requirement was mine, not the protocol's

**regressed-from:** this same ticket, commit `4f8d488`. The FIFO that round
introduced is what caused the first defect below; the second it never covered.

An independent cross-provider clean-room pass against `4f8d488` returned BROKEN
with two lost-reply defects:

1. `node adversarial-hanging-provider.mjs` → exit 1, `{"repliesAfter1500ms":0,
   "output":""}`. A stub provider accepted a forwarded `tools/call` and then
   stayed alive answering nothing. A locally-answered `ping` was sent behind it.
   After 1500 ms stdout was **completely empty** — not one reply. The forwarded
   slot never filled, the drain will not skip an unfilled head, and so a reply
   computed in microseconds was withheld forever. Requirement (4) — "an inner
   shim that dies fills every outstanding request with an error" — does not
   catch this, because the provider never exits.
2. `node adversarial-eof.mjs` → exit 1, `{"exit":{"code":0},"replies":[]}`. On
   client stdin EOF the shim killed the provider and called `process.exit(0)`
   without draining, discarding an accepted request that was about to be
   answered, and reporting success while doing it.

### What the protocol actually requires

The dispatch that produced `4f8d488` told the verifier that replies must be
released in the order the requests arrived. **That was invented.** It is not in
this protocol, and the read of the sources is not ambiguous:

- **JSON-RPC 2.0** (jsonrpc.org/specification), §5 Response object: *"The Server
  MUST reply with the same value in the Response object if included. This member
  is used to correlate the context between the two objects."* §6 Batch: *"The
  Server MAY process a batch rpc call as a set of concurrent tasks, processing
  them in any order and with any width of parallelism"*; *"The Response objects
  being returned from a batch call MAY be returned in any order within the
  Array"*; *"The Client SHOULD match contexts between the set of Request objects
  and the resulting set of Response objects based on the id member within each
  Object."*
- **MCP 2025-06-18** base protocol: *"All messages between MCP clients and
  servers MUST follow the JSON-RPC 2.0 specification"*, and the only stated
  obligation on a reply is *"Responses MUST include the same ID as the request
  they correspond to."* No ordering, interleaving or serialization clause exists
  in the base protocol, lifecycle or transports pages. The stdio transport
  constrains FRAMING only (*"Messages are delimited by newlines, and MUST NOT
  contain embedded newlines"*; *"The server MUST NOT write anything to its
  stdout that is not a valid MCP message"*). Streamable HTTP openly presumes
  concurrently-running requests and multiple simultaneous streams.
- **The SDK this station's clients actually run** — `@modelcontextprotocol/sdk`
  1.30.0 — agrees, in code: `dist/esm/shared/protocol.js:449` resolves a reply
  with `this._responseHandlers.get(Number(response.id))`, a `Map` keyed by id
  populated at line 688. There is no queue and no head anywhere in the response
  path. Worse for the FIFO: the timeout is *per id*
  (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`, `protocol.js:8`, armed at 712 from
  when THAT request was sent), so holding a computed reply behind a slow one
  spends the held request's own budget for nothing.

So strict in-order release was a self-inflicted constraint, and it was a
strictly worse trade: reordering is harmless to a conforming client, silence is
not. **The previous round over-constrained the relay.** The FIFO is removed
rather than worked around — no deadline, no watchdog, no machinery to escape a
constraint that should not have existed.

### The fix

- **Replies are written the moment they exist.** `outbox`/`reserve`/`drain` are
  gone. What remains is `outstanding`, a list of forwarded requests awaiting the
  provider — not an output queue; nothing waits behind its head. It exists only
  to match a reply to the request that is owed it, to resolve a reused id
  oldest-first, and to fail everything explicitly if the provider dies.
- **One reply per request is now structural in a stronger way than before.** A
  slot answers once, and an inner line that is *response-shaped* (`result` or
  `error`) but matches nothing outstanding is DROPPED with a stderr log instead
  of being relayed: it can only be stale or duplicate, and relaying it would be
  a second answer to a request the client has already had. Notifications and
  server-initiated requests still pass straight through. A non-JSON line from
  the provider is dropped rather than forwarded, because relaying it would put a
  non-MCP message on our stdout, which the stdio transport forbids.
- **Client EOF drains instead of discarding.** `process.stdin.on('end')` no
  longer kills the provider and exits. It stops reading, keeps the provider
  alive, and exits only when nothing is outstanding. The exit is deferred behind
  a zero-length `process.stdout.write('', cb)` because `process.exit()`
  truncates whatever is still queued on a pipe.
- **Nothing exits 0 with work unanswered.** If stdout itself dies, replies are
  undeliverable and the process exits **1** if anything is still outstanding.
- **No deadline is invented anywhere.** A browser call can legitimately run for
  minutes; any timer here would fabricate an error for a page that is merely
  slow. Liveness is bought by never making one request's answer wait on
  another's, which costs nothing.
- **Waiting does not outlive an explicit stop.** The honest cost of draining on
  EOF is that a wedged provider keeps this process alive, and stdout EPIPE does
  not bound it (a shim that never writes never notices). So `SIGTERM`/`SIGHUP`/
  `SIGINT` now fail everything outstanding with `-32603` — an error, not silence
  — and take the inner shim down with them. That is a supervisor's instruction
  to stop, not a guess about latency.

### Verification

Both defects were reproduced as must-FAIL against `4f8d488` **before** the fix,
using the verifier's own preserved script and an EOF equivalent:

| repro, pre-fix | printed | exit |
| --- | --- | --- |
| hanging provider | `{"repliesAfter1500ms":0,"ids":[],"output":""}` | 1 |
| stdin EOF mid-call | `{"exit":{"code":0},"replyCount":0,"replies":[]}` + `FAIL: stdin EOF discarded the accepted forwarded request without any reply` | 1 |

and after:

| repro, post-fix | printed | exit |
| --- | --- | --- |
| hanging provider | `{"repliesAfter1500ms":1,"ids":[2],...}` — the ping is delivered while the call is still out | 0 |
| stdin EOF mid-call | `{"exit":{"code":0},"replyCount":1,"replies":[{"id":1,"result":{"ok":true}}]}` | 0 |

**On the verifier's own script exiting 1 either way.** It asserts *two* replies
within 1500 ms — i.e. that the hung `tools/call` is also answered. That cannot
be done without inventing a deadline and fabricating an error for a call the
provider may yet answer. The defect it found is nonetheless gone: stdout went
from **0 replies** to **1**, and the channel is no longer silenced. The suite
asserts exactly that, and asserts separately that no answer is fabricated for
the hung id.

`npm run verify:bug-116` — **40/40 PASS, exit 0** (was 24 checks). Sections 5–7
now carry two live must-FAIL controls recovered from history rather than one:
`df13918` (the byte pipe) and `4f8d488` (the FIFO). Measured:

- `MUST-FAIL CONTROL: the FIFO round (4f8d488 source) writes NOTHING at all` —
  `replies=0 pingAnswered=false`.
- `MUST-FAIL CONTROL: the FIFO round exits 0 on EOF having answered nobody` —
  `answered=false exit={"code":0,"signal":null}`.
- Six in flight, provider answering out of order: `ids=[2,6,4,3,5,1] dupes=0` —
  all six, exactly once. Order is deliberately **not** asserted.
- 40 in flight, provider latency 0–400 ms: `count=40 dupes=0 missing=[]
  crossed=[]`; `released in request order=false`, recorded and not asserted.
- id reused across two in-flight requests: `replies with the reused id=2
  echoes=["reuse-a","reuse-b"]` — neither lost, neither duplicated.
- ids of unexpected type: `count=6 dupes=0
  keys=["true","1.5","\"1\"","1","{\"k\":1}","[7]"]` — returned by value and by
  type, `1` and `"1"` never conflated.
- provider answers the same request twice: `1` reply reaches the client.
- provider emits a reply for an id nothing is waiting on: `stale id
  leaked=false real answers=1`.
- a late reply for a request the error path already answered: `replies for the
  errored id=1 isError=true next request answered=1`.
- backpressure, 3 MiB to a consumer that is not reading: `blocked-phase lines=0
  replies=3 lengths=[1048576,1048576,1048576] intact=true unparseable=0`.
- SIGTERM while wedged, counted from `/proc`: `inner shims in /proc before=1
  after=0; replies=1 isError=true shim exited=true`.

The properties the previous round proved are all still asserted and still pass:
`-32700` for malformed input before and after forwarding began, no duplicates,
three messages in one chunk and one split across three, a 4 MiB payload byte for
byte (`4194304 bytes returned, intact=true`), an error when the provider dies
plus the shim surviving to serve the next request, `tools/list` starting no
browser (`0 chrome process(es); 11 tools listed` against `10 chrome process(es)`
through the adapter shim), and a real `tools/call` returning the rendered page
(`"title": "BUG-116 fixture"`). Process counts are read from `/proc`.

Anti-regressions:

| suite | result | exit |
| --- | --- | --- |
| `verify:bug-116` | 40/40 | 0 |
| `verify:browser` | 24/24 | 0 |
| `verify:container` | 19/19 | 0 |
| `verify:tool-toggle` | 16/16 | 0 |
| `verify:mcp-attach` | 26/26 | 0 |
| `verify-bug-107-image-staleness` | 23/23 | 0 |
| `verify-bug-108-playwright-pin` | 20/20 | 0 |
| `npm run gate` | leak-gate PASS, check-nul PASS, typecheck PASS | 0 |

One `verify:browser` run in the middle of this lane reported 23/1: the failing
check was `CONTROL: plain curl is BLOCKED on the target site`, which asserts a
third-party site's bot policy and returned HTTP 200 that minute. It is external
and unrelated to this change; the immediate re-run was 24/24.

### Handoff

The relay's ordering constraint is gone, so the class of bug it created is gone
with it. What an independent pass should attack next: the drain-on-EOF path
holding this process alive against a provider that is wedged *and* a supervisor
that never signals (SIGKILL of the shim still orphans the inner shim — that is
older than this round and unchanged); a provider that emits a reply for an id
belonging to a request still in flight under a DIFFERENT client id space; and
`initialize` being answered locally while the real provider is never told the
negotiated protocol version. Container isolation remains unfixed and eager, as
argued above.

- **Verified-by:** dispatch openai run 01a019b3-1d28-7371-91e0-557ebda5515b (clean-room, `scripts/independent-verify.mjs`, range 5e13c39c..703a4368 with `docs/*` excluded via a synthetic base) — VERDICT: BROKEN

## Round 4 — a request accepted is a request answered, whatever answers it

The clean-room pass on `703a436` found a lost reply, and it is the same shape as
the two before it: the fix was right about what it addressed and left one path
unconsidered.

```
node adversarial-local-eof.mjs → exit 1
{"result":{"code":0,"signal":null},"replyCount":0,"stdoutBytes":0}
```

A single `tools/list` followed immediately by stdin EOF. The shim accepted the
request and exited 0 having written **zero bytes** — not an answer, not an
error, nothing.

The mechanism is structural. `dispatch()` built a slot for a locally-answered
method and called `answerLocally` asynchronously **without putting it on
`outstanding`**; only the forwarded arm registered. `outstanding` was therefore
not "everything accepted" but "everything accepted that the inner shim owes", so
`finishIfDrained()` at EOF asked the right question and was given an answer that
was true of half the system. Round 3's own EOF tests only ever ended input with
*forwarded* work in flight, which is exactly why 40 checks passed over it.

### The fix: one ledger, and no way to be off it

`outstanding` is now THE LEDGER — every accepted, unanswered request, whoever
owes the reply — and two structures keep it honest rather than asking the next
author to remember:

- `accept(id, owedBy)` is the only constructor of a slot, and it pushes in the
  same statement that creates it. There is no separate "register" call that a
  third answer source could forget; to get something `answer()` will take, you
  come through the ledger.
- `serveLocally()` guarantees its slot is settled. `.then(handler)` →
  `.catch(→ -32603)` → `.finally(if still unanswered, -32603)`. "Accepted, ran,
  answered nobody" is not a reachable state for a local handler.

`owedBy` (`'inner'` | `'local'`) exists for exactly one reason: the provider
dying must fail the requests **the provider** owes and no others. Putting local
work on the same list without that distinction would have traded a lost reply
for a fabricated one — a `tools/list` about to be answered from the static table
erroring because a daemon it never needed died. `failOutstanding(reason, 'inner')`
on the child's `exit`/`error`; unfiltered for a signal, a crash or a stranded
loop. The inner-reply matcher gained the same filter, so a provider reply can
never satisfy a local request that happens to share an id.

Two exit paths that could previously end with work owed were also closed:
`uncaughtException`/`unhandledRejection` now fail the ledger and exit 1, and
`beforeExit` — the event loop emptying while the ledger is not, which can only
mean the work is stranded — fails it rather than exiting silently. A
`failedExitCode` latch was needed for both: answering the ledger drains it,
draining it reaches `finishIfDrained()`, and that path exits **0**, so a crash
that errored every outstanding request still reported success. Measured before
the latch: `exit code 0` on the crash fixture; after: `1`.

### The enumeration — the deliverable that should end this cycle

**Every path by which a reply can be owed:**

| # | owed by | created at | on the ledger |
| --- | --- | --- | --- |
| 1 | the inner shim (`tools/call`, and any future non-local method with an id) | `dispatch()` forwarded arm | yes, `owedBy:'inner'` |
| 2 | this process (`initialize`, `ping`, `tools/list`, `resources/list`, `prompts/list`) | `serveLocally()` | yes, `owedBy:'local'` ← **was not, and is this round's defect** |
| 3 | this process, refusal: `-32700` unparseable line | stdin reader | yes, `owedBy:'local'` |
| 4 | this process, refusal: `-32600` non-request | `dispatch()` guard | yes, `owedBy:'local'` |

And every path that owes **nothing**, with the reason: a notification
(`id` absent or null) — no reply exists by definition; `notifications/*` —
same; an inner line that is a notification or a server-initiated request —
relayed, not an answer to anything we hold; an inner response matching no slot —
dropped, because that request already has its one reply.

**Every path by which the process can exit, against that ledger:**

| exit path | what it does with the ledger | rows 1–4 |
| --- | --- | --- |
| stdin EOF, then the last answer lands (`finishIfDrained`) | exits only when it is **empty** | all |
| SIGTERM / SIGHUP / SIGINT | `failOutstanding()` unfiltered, then exit 0 | all |
| inner shim `exit` / `error` | `failOutstanding(…, 'inner')` — row 1 only, by design | 1 |
| stdout gone (`onStdoutError`) | replies are undeliverable to anyone; exits **1** iff the ledger is non-empty | all |
| `uncaughtException` / `unhandledRejection` | `failOutstanding()` unfiltered, then exit 1 | all |
| `beforeExit` — loop empty, ledger not | `failOutstanding()` unfiltered, exit 1 | all |
| `process.exit(2)`, missing env at startup | before stdin is read; the ledger is provably empty | n/a |
| `SIGKILL` | nothing in-process can answer; the client's per-id timeout is the only backstop | **not addressable** |

The cross product is 4 rows × 7 addressable columns; row 1 × every column and
row 2 × every column are asserted in section 8 and sections 6–7 of
`verify:bug-116`. Rows 3 and 4 are answered inside the same synchronous
statement that accepts them, so no exit can interleave — they are on the ledger
anyway, because "answered immediately" is a property of today's code and not a
rule the next edit is bound by.

### Unrepresentable versus merely guarded — being specific

**Unrepresentable** (the state cannot be constructed, not "is checked for"):

- *A slot invisible to the exit paths.* Creation and registration are one
  statement in `accept()`. A future third answer source cannot forget to
  register, because there is nothing to forget — there is no unregistered slot
  to obtain.
- *A local handler that settles having answered nobody.* The `finally` answers
  it. Returning, throwing and rejecting all end in a reply.
- *A provider reply satisfying a local request with the same id.* The matcher
  requires `owedBy === 'inner'`.

**Guarded, not structural** — named because a shim that happens to await the
right things is weaker than one where the bad state cannot exist:

- `emit()` writes to stdout without a slot. It has exactly two legitimate
  callers (`answer()`, and relaying an inner notification). Nothing in the
  language stops a third; only the header and the call sites do.
- Hand-rolling `{answered:false}` instead of calling `accept()` still compiles.
  `answer()` now *detects* it — a first answer for a slot not on the ledger logs
  `BUG: answered a slot that was never accept()ed` — and still emits the reply,
  because the client should not be punished for our bug. That is a tripwire, not
  a prohibition; a brand-and-throw would only convert it into the crash path.
- Exit-code honesty rests on the `failedExitCode` latch being consulted by
  `exitWhenFlushed`, i.e. on every exit going through that one function.
- `SIGKILL` on this process still orphans the inner shim. Unchanged from round
  3, unfixable from inside, stated rather than implied.

**Known adjacency, deliberately NOT fixed here:** a client message that is a
*response* (to a server-initiated request the inner shim sent us) hits the
`typeof msg.method !== 'string'` guard and is answered `-32600` instead of being
relayed back to the inner shim, which would then wait forever. That strands a
reply the INNER shim is owed, not one the client is owed, so it is outside this
round's invariant; the adapter makes no server→client requests today. It is the
obvious next attack surface and is filed here rather than left to be
rediscovered.

### How real is the race

Honest measurement, because the fixture is not the user: with the **real** 5 KiB
`src/tools.mjs` on a warm cache, `tools/list` + immediate EOF answered **60/60**
on this machine (20 sequential, then 40 launched at once under 8-way CPU load) —
the stdin-EOF read simply lost the race to the import every time. The window is
one dynamic `import()` wide, and it opens for a tool table on a cold or slow
mount (it lives in a *separate* repo, `~/random_projects/stealth-browser-mcp`),
for any future table with a top-level `await`, or on a machine where the read
lands differently. The verifier's fixture widens that window rather than
inventing it — and the signal, crash and stranded-loop variants of the same hole
do not depend on the width at all. Reported as a real defect of the class, not
as a fixture artifact.

### Verification

Must-FAIL first, against the shipped `703a436` code, using the verifier's own
preserved script:

- before: `{"result":{"code":0,"signal":null},"replyCount":0,"stdoutBytes":0}` —
  **exit 1**.
- after: `{"result":{"code":0,"signal":null},"replyCount":1,"stdoutBytes":72}` —
  **exit 0**.

`npm run verify:bug-116` — **50/50 PASS, exit 0** (was 40). Section 8 is new and
carries a third live must-FAIL control recovered from history, `703a436` itself
(`git show 703a436:src/server/sbmcp-lazy-shim.mjs`, accepted only if it contains
the untracked-slot line and no `accept(`). Measured:

- `MUST-FAIL CONTROL: the 703a436 source exits 0 on EOF having answered the
  accepted request with nothing` — `replies=0 bytesOnStdout=0
  exit={"code":0,"signal":null}`.
- `MUST-FAIL CONTROL: the 703a436 source answers nobody when SIGTERM lands on a
  local answer` — `replies=0 exited=true`.
- local answer + immediate EOF: `replies=1 isResult=true bytesOnStdout=103
  exit={"code":0,"signal":null}`.
- all five locally-served methods + a forwarded call + a malformed line, all in
  flight at EOF: `missing=[] dupes=0 fabricatedErrors=[] parseErrors=1
  exit={"code":0,"signal":null}` — and the reply order that came back,
  `[null,p1,p3,p4,p5,p6,p2]`, is recorded and not asserted.
- SIGTERM on a local answer in flight: `replies=1 isError=true exited=true`.
- provider dies while a local answer is in flight: `forwarded isError=true local
  isResult=true local fabricated=false replies=2` — the death fails only what
  the provider owed.
- the local answer itself fails (tool table will not import): `replies=1
  isError=true`.
- the same id in flight on both paths at once: `replies with that id=2 local
  answered=true forwarded answered=true`.
- uncaught throw with a request accepted: `replies=1 isError=true
  exit={"code":1,"signal":null}`.
- event loop empties with a request owed: `replies=1 isError=true
  exit={"code":1,"signal":null}`.

Every property round 3 proved was re-run, not assumed, and still passes:
`-32700` before and after forwarding began, six in flight answered out of order
`ids=[2,6,4,3,5,1] dupes=0`, 4 MiB byte for byte (`4194304 bytes returned,
intact=true`), chunk-boundary framing, an error instead of silence when the
provider dies plus the shim surviving to serve the next request, ids of
unexpected type (`count=6 dupes=0 keys=["true","1.5","\"1\"","1","{\"k\":1}","[7]"]`),
an id reused in flight (`replies with the reused id=2
echoes=["reuse-a","reuse-b"]`), a late reply after the error path answered
(`replies for the errored id=1 isError=true`), 40 in flight with 0–400 ms
latency (`count=40 dupes=0 missing=[] crossed=[]`), 3 MiB backpressure
(`lengths=[1048576,1048576,1048576] intact=true unparseable=0`), SIGTERM cleanup
counted from `/proc` (`inner shims before=1 after=0`), `tools/list` starting no
browser (`0 chrome process(es); 11 tools listed` against `10 chrome process(es)`
through the adapter shim), and a real `tools/call` returning the rendered page
(`"title": "BUG-116 fixture"`). Process counts from `/proc`, not from logs.

| suite | result | exit |
| --- | --- | --- |
| `verify:bug-116` | 50/50 | 0 |
| `verify:browser` | 24/24 | 0 |
| `verify:container` | 19/19 | 0 |
| `verify:tool-toggle` | 16/16 | 0 |
| `verify:mcp-attach` | 26/26 | 0 |
| `verify-bug-107-image-staleness` | 23/23 | 0 |
| `verify-bug-108-playwright-pin` | 20/20 | 0 |
| `npm run gate` | see below | 0 |

`regressed-from:` round 3 (`703a436`), which introduced the untracked local slot
while fixing the FIFO liveness defect of `4f8d488`.

**Independent verification is warranted** — this is the fourth round on this file
and the third consecutive round in which an independent pass found a real defect
the author's own suite passed over. The enumeration above is the thing to attack:
if a fifth round exists, it is a row or a column this table does not have.

- **Verified-by:** dispatch openai run 01a019c8-a9c0-7ae0-b4aa-dee6ee726ee8 (clean-room, `scripts/independent-verify.mjs`, range 98abb1e2..4954b659 with `docs/*` excluded via a synthetic base) — VERDICT: BROKEN

## Round 5 — the signal row was hand-written, and hand-written means short

**regressed-from:** this same ticket, commit `4954b65`. The exit-column table
round 4 shipped listed `SIGTERM/SIGHUP/SIGINT` as its signal row — the same kind
of hand-written enumeration the fix spends its length arguing against, and it was
short by exactly what nobody happened to type.

The clean-room pass on `4954b65` (the one recorded at the end of round 4) found
it:

```
node adversarial-sigquit.mjs → exit 1
{"ended":{"code":null,"signal":"SIGQUIT"},"matchingReplies":0,"replies":[]}
```

A locally-owed `tools/list` in flight, then a catchable `SIGQUIT` (Ctrl-\, or
`kill -QUIT`). The shim registered handlers for three signals only, so `SIGQUIT`
took its default action — terminate + core dump — killing the process with the
ledger unsettled and the reply lost. Not a new class of bug: the fourth instance
of "the fix was right about what it addressed and left one member of a
hand-listed set unconsidered."

### The fix: derive the set, do not list it

The trivial fix is "add SIGQUIT". That would leave the row still hand-written and
still one typo from short again. So the set is no longer a list. It is **every
signal the platform names** — `os.constants.signals`, the only programmatic
source of what this build can be sent — **minus an explicit, reasoned exclusion
set** (`terminationSignals()` / `NON_TERMINATION_SIGNALS` in the shim). This
inverts the failure mode: forgetting to *exclude* a signal merely gives it a
graceful handler it did not strictly need, whereas forgetting to *include* one
strands the ledger — which was the whole defect. A signal the platform grows
later is handled by default and must be deliberately named to be dropped.

On this platform the derived set is the 12 catchable, terminate-by-default
signals: `SIGHUP SIGINT SIGQUIT SIGUSR2 SIGALRM SIGTERM SIGXCPU SIGXFSZ
SIGVTALRM SIGPROF SIGIO SIGPWR` — i.e. the three the old list had, plus
`SIGQUIT`, plus eight a hand list reliably forgets (`SIGPWR`, the resource-limit
pair, the timers, `SIGIO`, `SIGUSR2`).

What is **deliberately excluded**, each for a stated reason (full text in the
shim header):

- **Uncatchable:** `SIGKILL`, `SIGSTOP` — the kernel acts regardless; `process.on`
  for them throws. No handler can run, so none is claimed.
- **Default disposition is not "terminate":** `SIGCHLD` (default-ignore — and it
  fires when *our own inner shim* changes state; treating it as a stop would exit
  us every time the child does anything, which is the sharpest reason a "handle
  everything" approach must still exclude), `SIGURG`, `SIGWINCH`, `SIGCONT`
  (resume), `SIGTSTP`/`SIGTTIN`/`SIGTTOU` (job-control stop).
- **Node has neutralised or reserved them:** `SIGPIPE` (Node ignores it; broken
  pipe surfaces as EPIPE, which `onStdoutError` already owns), `SIGUSR1` (Node
  reserves it to start the inspector).
- **Synchronous faults:** `SIGSEGV`/`SIGILL`/`SIGFPE`/`SIGBUS`/`SIGABRT`(/`SIGIOT`)/
  `SIGTRAP`/`SIGSYS`/`SIGSTKFLT` — the process's own execution going wrong, not a
  supervisor asking it to stop. State is already undefined (or, for `SIGABRT`,
  Node is aborting on its own fatal error), so running JS shutdown there is
  unsound and would mask the fault; they keep their default action.

Aliases that share a signal number (`SIGIO`/`SIGPOLL`, `SIGABRT`/`SIGIOT`)
collapse to one, and a number is excluded if *any* of its names is excluded, so
neither name of an excluded pair can slip in under the other. Each handler is
installed under a `try/catch` so a surprise-uncatchable name recorded and skipped
rather than crashing startup.

### The other dimension — the rows — is already structural, and stays that way

Round 4's deliverable also hand-wrote the *rows* (every source that can owe a
reply). Re-examined with the same suspicion: those are **not** a maintained list.
Every reply-owing path — forwarded, local, the `-32700` refusal, the `-32600`
refusal — obtains its slot through the single constructor `accept()`, which
registers into the ledger in the same statement that creates the slot; `answer()`
even detects a slot that skipped it. There is no way to owe the client a reply
without being on the ledger, so the row set is derived-by-construction, not
listed. `emit()` is the only other writer to stdout and it carries no slot only
for things that owe nothing (relayed inner notifications). So the fix needed was
on the exit-column dimension alone; the row dimension required no change and the
suspicion confirmed it was already sound.

### Verification

Must-FAIL first, against the shipped `4954b65` code, using the clean room's own
preserved `adversarial-sigquit.mjs`:

- before (pre-fix shim): `{"ended":{"code":null,"signal":"SIGQUIT"},"matchingReplies":0,"replies":[]}` — **exit 1**.
- after (fixed shim, same scenario): `{"ended":{"code":0,"signal":null},"matchingReplies":1,"replies":[{...,"error":{"code":-32603,...}}]}` — **exit 0**.

`npm run verify:bug-116` — **56/56 PASS, exit 0** (was 50). Section 9 is new. It
does **not** hand-write a signal list: it asks the shim binary to print its own
installed set (`node <lazy-shim> --print-termination-signals`) and iterates that,
so the test and the fix share one source — a test that enumerated independently
could be short in the same way the bug was. Measured:

- `SIGQUIT is in the shim's own derived termination set` — `derived set (12):
  ["SIGHUP","SIGINT","SIGQUIT","SIGUSR2","SIGALRM","SIGTERM","SIGXCPU","SIGXFSZ","SIGVTALRM","SIGPROF","SIGIO","SIGPWR"]`.
- `the three signals the previous rounds already handled are still in the set`.
- `the uncatchable and non-terminating signals are DELIBERATELY excluded` —
  `KILL=false STOP=false CHLD=false CONT=false WINCH=false TSTP=false`.
- `EVERY signal in the derived set errors the outstanding request explicitly and
  exits cleanly` — `12 signals proven; killed-by-default-or-silent: [];
  SIGQUIT={"replies":1,"isError":true,"exited":true,"bySignal":null}`. Each is
  delivered to a shim holding a deterministic outstanding forwarded request; a
  settled ledger is one error reply and `signal===null` (our `process.exit` ran),
  never `signal===<sig>` (the default action killed us).
- `the clean-room scenario — a LOCAL answer in flight, then SIGQUIT — now errors
  the ledger and exits cleanly` — `replies=1 isError=true killedBySignal=null`.
- `MUST-FAIL CONTROL: the 4954b65 source is killed by SIGQUIT's default action,
  answering nobody` — `replies=0 killedBySignal=SIGQUIT` (source recovered with
  `git show 4954b65:…`, accepted only if it contains the three-signal literal and
  no `terminationSignals`).

Every property the prior rounds proved was re-run, not assumed, and still passes
(`-32700` before/after forwarding, six in flight out of order `ids=[2,6,4,3,5,1]
dupes=0`, 4 MiB byte-for-byte `4194304 intact=true`, chunk-boundary framing,
backpressure `lengths=[1048576,1048576,1048576] intact=true`, provider death an
error not silence, the process never exiting 0 with work owed, `tools/list`
starting `0 chrome process(es); 11 tools listed` against `10` on the adapter
path, a real `tools/call` returning the rendered `"title": "BUG-116 fixture"`).
Process counts are read from `/proc`, not logs.

| suite | result | exit |
| --- | --- | --- |
| `verify:bug-116` | 56/56 | 0 |
| `verify:browser` (real model, real bot-walled site) | 24/24 | 0 |
| `verify:container` | 19/19 | 0 |
| `verify:tool-toggle` | 16/16 | 0 |
| `verify:mcp-attach` | 26/26 | 0 |
| `verify-bug-107-image-staleness` | 23/23 | 0 |
| `verify-bug-108-playwright-pin` | 20/20 | 0 |
| `npm run gate` | typecheck PASS, check-nul PASS; leak-gate reported a pre-existing hit in another lane's uncommitted `ARCH-004` (line 377), not present at HEAD and outside this lane — this lane's own files (`sbmcp-lazy-shim.mjs`, `verify-bug-116-lazy-browser.mjs`) scan clean | n/a |

**Independent verification is warranted** — this is the fifth round on this file
and the fourth consecutive round in which an independent pass found a real defect
the author's own suite passed over. This is a session-lifecycle, regression-prone
change. The two dimensions are now BOTH derived rather than listed (rows by
`accept()`, columns' signal set by `os.constants.signals`); if a sixth round
exists it is either a non-signal exit column the table still lists by hand, or a
platform where the exclusion set's reasoning is wrong.

- **Verified-by:** dispatch anthropic run 1862ee23-6d42-4882-abf8-97efbc5ca6e5 (clean-room, `scripts/independent-verify.mjs`, range e64268f8..608064f7 with `docs/*` excluded via a synthetic base; cross-provider openai attempted FIRST and abandoned after four failed `vrun` handshakes from the codex sandbox — same-provider, decorrelation reduced) — VERDICT: HOLDS
