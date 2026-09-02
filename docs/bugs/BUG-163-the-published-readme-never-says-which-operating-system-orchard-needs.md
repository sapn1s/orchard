# BUG-163 — The published README never says which operating system Orchard needs

- **Status:** OPEN
- **Severity:** medium
- **Area:** docs / README
- **Reported:** 2026-09-02 by exploration lane (Windows-viability investigation)
- **Verification-class:** docs-only

## Symptom

A stranger clones the public repository on Windows, follows the Quick start
exactly, and it appears to work. `npm install` succeeds. `npm start` succeeds.
The dashboard loads at `http://127.0.0.1:4317`. Projects list.

Then features fail one at a time, none of them saying why:

- Session search returns nothing, ever (ripgrep is spawned by name and is not
  present on a stock Windows box).
- Snapshots fail per request (`cp --reflink=always` does not exist).
- The reply-format Stop hook is written into the project but never fires (the
  hook command embeds a POSIX `$VAR` the Windows shell does not expand).
- Restart survival is silently off.
- Headless dispatch fails.

None of these announce a platform problem, because there is no platform check
anywhere in `src/` to announce one. The person is left debugging a tool that
was never built for their machine, and the README never told them.

The README's first requirement is the one it does not state.

## Repro

1. Read `README.md` on the public repository. Note the Quick start:
   `npm install` then `npm start`.
2. Search it for a stated operating system. There is none. `package.json`
   pins `engines.node` only; there is no `os` field.
3. The only platform hints are incidental and all describe *optional* extras:
   systemd for running it as a background app, btrfs for snapshots. A reader
   reasonably concludes those are the optional Linux bits and the core is
   portable.
4. It is not. The core assumes Linux.

## Expected

The Quick start states the platform before the install command, so a Windows
or macOS reader stops there instead of an hour later. Specifically: Linux, or
Windows via WSL2, and the external commands the core actually shells out to.

## Context pack (grows — the "where to look", so no agent cold-starts)

**What the investigation established.** Native Windows is the bad outcome —
not a clean refusal but a boot that succeeds and then degrades in ways the user
cannot diagnose. WSL2 is the honest Windows answer and works today with no code
changes.

- `README.md` — Quick start (~line 38) is where the requirement belongs.
  Existing platform mentions at lines 44, 50, 79, 99 are all about optional
  extras, which is what makes the omission misleading rather than merely absent.
- `docs/guide/README.md:3` — says "systemd user service", also in passing.
- **No `process.platform` / `win32` branch exists anywhere in `src/`.** Verified
  by grep. Every bit of accidental portability comes from `try`/`catch` and
  `path.join`, not from design. This is why nothing warns.

Core things that break on native Windows, with the file that causes each:

- `src/server/search.ts:155` — `spawn('rg', …)`. Session search dies.
- `src/server/snapshots.ts:352` — `spawnSync('cp', ['--reflink=always', …])`.
  Snapshots die. (Also `chmodSync` at :385.)
- `scripts/onboard.mjs:544` — the Stop hook command is
  `node "$CLAUDE_PROJECT_DIR/scripts/hooks/response-format-gate.mjs"`. POSIX
  variable syntax; never expands on Windows, so the hook silently never fires.
  This one is a *silent* failure, the worst of the set.
- `scripts/dispatch.mjs:317,337` — bare `claude` spawn plus a negative-pid
  process-group kill, which throws on Windows. Headless dispatch dies and leaks
  orphans.
- `src/server/dispatch-broker.ts:141,148` — Unix domain socket plus
  `chmod 0o700`/`0o600`.
- `src/server/survival.ts:182,337` — `systemd-run`. Absent, so survival is
  cleanly off (this one degrades correctly).
- `src/server/index.ts:131-147`, `src/server/survival.ts:227` — `/proc` reads,
  both caught, both returning `null`. Degradation, not a crash.

What *degrades* rather than breaks, on any platform without the dependency:
survival (no systemd), container isolation (no Docker), snapshots (no reflink
filesystem — this one already fails loudly by design,
`src/server/snapshots.ts:22`), `/api/processes`. The server itself boots fine.

**WSL2 works today, unmodified.** The dashboard is reachable from the Windows
browser at `http://127.0.0.1:4317` because WSL2 forwards Windows localhost into
the VM, and the host allowlist (`src/server/index.ts:3214-3217`) already admits
both `127.0.0.1:PORT` and `localhost:PORT`. A user needs: WSL2 with systemd
enabled (`systemd=true` in `/etc/wsl.conf`) if they want the background service
and restart survival, Node 23+, and the `claude` or `codex` CLI signed in
*inside* WSL. Projects should live on the WSL filesystem, not `/mnt/c`:
`encodeCwd` handles the path fine, but `/mnt/c` is drvfs, so snapshots cannot
reflink, `fs.watch` (`src/server/watcher.ts:215`) is unreliable there, and
performance is poor.

Note the one piece of existing Windows handling is not what it looks like:
`src/lib/session-history.ts:277` (`detectOs`) and `:262` (`encodeCwd`) handle
Windows *drive-letter* paths only so that transcripts copied in from a Windows
machine can be read and flagged — `:588` literally warns "Windows session: file
paths inside these transcripts do not resolve on this host". That is import
tolerance, not Windows support, and it should not be mistaken for one.

- Related tickets: FEAT-049 (publishing exposure — same "what does the public
  repo tell a stranger" surface).
- Repro test: none needed; this is a docs claim, checkable by reading.
- Known dependencies / blockers: none. The fix is a line, and it does not wait
  on any code change.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — exploration lane (investigation only, no code changed)

- **Understood:** The question asked was whether a real person can use Orchard
  on Windows. The answer is: only through WSL2. Native Windows produces the
  worst available outcome — it starts, so the user commits time, and then fails
  piecemeal with no message naming the cause. The root of the *reporting*
  failure is that `src/` contains no platform check at all, so there is no place
  where a wrong platform could be noticed and stated.
- **Deliberately not done:** no port, no compatibility shim, no
  `process.platform` guards. The gap here is a sentence in the README, not a
  compatibility layer, and building the layer would be a much larger and less
  honest answer to what a stranger actually needs.
- **Changed:** nothing. This ticket only.
- **Verified:** read-only investigation. Evidence is the file:line list in the
  context pack above, each read directly. The absence of platform branching in
  `src/` was checked by grep for `process.platform` and `win32` and came back
  empty.
- **Still open / handoff:** the fix is to add the platform requirement to the
  README Quick start, next to `npm install`, before it. It should say Linux, or
  Windows via WSL2, and name what the core shells out to (`git`, `rg`, `cp`
  with reflink for snapshots) plus what each optional extra needs (systemd for
  the background service and restart survival, Docker for container isolation).
  A second, optional and larger step — worth its own ticket if wanted, not this
  one — is a boot-time platform notice so a non-Linux start says so once instead
  of degrading in silence.
- **Symptom of a deeper design flaw?** Not closing this ticket, so not
  answering yet. The candidate, recorded for whoever does close it: the project
  has no notion of a platform contract anywhere in code, which is why five
  independent features each degrade in their own private way rather than one
  check saying "this is not a supported host". Worth an ARCH only if a
  boot-time notice is ever actually wanted.
