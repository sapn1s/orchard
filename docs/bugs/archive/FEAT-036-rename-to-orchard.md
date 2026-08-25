# FEAT-036 — Rename claude-station → Orchard (repo / dir / service / paths)

- **Status:** DONE — won't-do by user decision (2026-08-05 user decision: leave the folder/repo/service path as claude-station; user-facing brand is fully Orchard — UI, favicon, wordmark, launcher). Rationale: path rename is a risky live migration (service unit paths, Claude memory-dir keying, git remote) for purely internal value.
- **Area:** project rename
- **Reported:** 2026-08-04 by user

## Goal
Rename the whole project from `claude-station` to `orchard` (provider-agnostic — Claude
is just one engine; multi-provider is a plausible future).

## Ripple (why it's a real refactor, not a sed)
- GitHub repo (`gh repo rename`), the local dir path (breaks Claude's memory-dir encoding
  `-home-<user>-projects-claude-station` → new path), `package.json` name, the systemd unit
  + `.desktop` launcher (FEAT-028) + `scripts/station-open.sh`, container/image names
  (`container-manager.ts`), `.mcp.json` project path, doc references, port stays 4317.
- Memory-dir move loses continuity unless handled. Do at a clean checkpoint, verify the
  service + launcher + containers still resolve, and update the memory files' repo path.

## Approach (when we do it)
Inventory every `claude-station` reference (ast-grep/rg), rename in a staged way, re-point
the systemd service + launcher, verify end-to-end. Branding (FEAT-035) can land first
independently (product name in the UI ≠ repo name).

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. Deferred; FEAT-035 (branding) proceeds first. Big careful refactor — its own pass.

### 2026-08-05 — orchestrator
- User decided: leave it. Launcher already renamed to Orchard; path rename closed as won't-do.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
