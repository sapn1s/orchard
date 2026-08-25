# DEPLOY-003 — Server on 4317 not restarted; server-side fixes not live

- **Status:** DONE — 4317 restarted; server fixes live
- **Severity:** high (it masks/undoes other fixes during testing)
- **Area:** ops / deployment
- **Reported:** 2026-08-03 by orchestrator

## Symptom
Several committed SERVER-side fixes are not running, because the live server
process on `127.0.0.1:4317` predates them and cannot be restarted while the
user's live session holds its bridge (restarting would drop the session).
Client (static) fixes DO reach the browser on reload; server ones do not.

Not-yet-live server code includes:
- detach/reattach (a reload/switch no longer kills a running dashboard session)
- reload-live busy reflection (`/api/sessions/live` `busy`/`detached` fields)
- `/api/models` `resolvedModel` (model-picker current-match on the wire id)
- OOM honesty, memories/git/processes routes if the process is old enough

Consequence: while testing, behavior is a MIX of new client + old server, which
has repeatedly muddied diagnosis (e.g. the model-picker current-highlight
depended on a server field the old process never sends).

## Blocker
The live session (the one doing this development) IS the bridge on 4317. The
guarded restart only fires when `liveBridges === 0`, which never happens while
this session runs.

## Resolution (needs user)
At any natural pause, from a terminal:
```
kill $(ss -tlnp | grep -w 4317 | grep -oP 'pid=\K[0-9]+') ; cd ~/projects/claude-station && npm start
```
An idle-watcher script that does this automatically the moment bridges hit zero
is staged at the session scratch dir; it can be installed as a durable helper if
the user wants restarts to be hands-off.

## Verification
After restart: `curl -s 127.0.0.1:4317/api/health` shows a new pid; a
mid-turn reload no longer interrupts; `/api/sessions/live` carries `busy`;
`/api/models` rows carry `resolvedModel`.
