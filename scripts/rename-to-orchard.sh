#!/usr/bin/env bash
# rename-to-orchard.sh — migrate this machine's claude-station install to "orchard".
# FEAT-049 item 4 (revives FEAT-036).
#
# RUN THIS FROM A PLAIN TERMINAL AS THE USER. Never run it from inside an
# Orchard/Claude session: stopping the service and moving the directory would
# kill the very session executing the script (and orphan its subagents).
#
# Default mode is DRY-RUN: prints the exact plan with resolved paths and runs
# every preflight check read-only. Nothing is mutated without --apply.
#
#   scripts/rename-to-orchard.sh                 # dry-run (safe, read-only)
#   scripts/rename-to-orchard.sh --apply         # perform the rename
#   scripts/rename-to-orchard.sh --apply --rename-github   # also rename the GitHub repo
#
# What it does (each step preflight-checked, loud abort on any failure):
#   1. stop claude-station.service
#   2. mv ~/projects/claude-station -> ~/projects/orchard
#   3. rewrite the machine-local systemd unit -> orchard.service, disable old,
#      enable new, daemon-reload
#   4. rewrite the .desktop launcher -> orchard.desktop, update-desktop-database
#   5. migrate ~/.claude/projects/-home-<user>-projects-claude-station ->
#      -home-<user>-projects-orchard  (Claude Code keys each project's session
#      transcripts AND auto-memory by the encoded absolute path of the project
#      dir; without this move the renamed repo would open with empty history
#      and no memory — the old data would be stranded under the dead key)
#   6. fix absolute old-path references inside the migrated memory/*.md files
#   7. update registry.json hostPath (server's project registry)
#   8. update repo-local deploy/ reference copies + station-open.sh
#   9. (--rename-github only) gh repo rename + git remote set-url
#  10. start orchard.service, verify /api/health returns 200
#
# NOT touched: ~/.local/share/claude-station (the server data dir is keyed by a
# constant in src/lib/paths.ts, not by the repo path — renaming it is a code
# change, out of scope here; see post-checklist).

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolved paths (single source of truth for the whole script)
# ---------------------------------------------------------------------------
OLD_NAME="claude-station"
NEW_NAME="orchard"

OLD_DIR="$HOME/projects/$OLD_NAME"
NEW_DIR="$HOME/projects/$NEW_NAME"

UNIT_DIR="$HOME/.config/systemd/user"
OLD_UNIT="$UNIT_DIR/$OLD_NAME.service"
NEW_UNIT="$UNIT_DIR/$NEW_NAME.service"

APP_DIR="$HOME/.local/share/applications"
OLD_DESKTOP="$APP_DIR/$OLD_NAME.desktop"
NEW_DESKTOP="$APP_DIR/$NEW_NAME.desktop"

# Claude Code encodes a project's absolute path by replacing '/' with '-'
# (leading slash included), e.g. $HOME/projects/claude-station ->
# -home-<user>-projects-claude-station. Transcripts + auto-memory live under it.
OLD_CLAUDE_KEY="${OLD_DIR//\//-}"
NEW_CLAUDE_KEY="${NEW_DIR//\//-}"
OLD_CLAUDE_DIR="$HOME/.claude/projects/$OLD_CLAUDE_KEY"
NEW_CLAUDE_DIR="$HOME/.claude/projects/$NEW_CLAUDE_KEY"

REGISTRY_JSON="$HOME/.local/share/$OLD_NAME/registry.json"

HEALTH_URL="http://127.0.0.1:4317/api/health"

APPLY=0
RENAME_GITHUB=0

for arg in "$@"; do
  case "$arg" in
    --apply)          APPLY=1 ;;
    --rename-github)  RENAME_GITHUB=1 ;;
    -h|--help)        sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "ABORT: unknown argument '$arg' (use --apply, --rename-github)"; exit 2 ;;
  esac
done

MODE="DRY-RUN"
[ "$APPLY" -eq 1 ] && MODE="APPLY"

say()   { printf '%s\n' "$*"; }
plan()  { printf '  would: %s\n' "$*"; }
abort() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

# In APPLY mode run the command; in dry-run just print it.
run() {
  if [ "$APPLY" -eq 1 ]; then
    printf '  exec : %s\n' "$*"
    "$@"
  else
    plan "$*"
  fi
}

say "== rename-to-orchard ($MODE) =="
say "   $OLD_DIR  ->  $NEW_DIR"
say ""

# ---------------------------------------------------------------------------
# Self-protection: refuse to MUTATE from inside an Orchard-managed session or
# from a cwd inside the repo (stopping the service / mv would kill the very
# session running the script). Dry-run is read-only, so these only warn there.
# ---------------------------------------------------------------------------
selfguard() {
  if [ "$APPLY" -eq 1 ]; then abort "$1"; else say "  WARN  $1 (fatal under --apply)"; fi
}
if grep -q "$OLD_NAME-host-" /proc/self/cgroup 2>/dev/null; then
  selfguard "running inside a $OLD_NAME session-host scope — run from a plain terminal"
fi
if [ -n "${CLAUDECODE:-}" ]; then
  selfguard "CLAUDECODE env set — this looks like a Claude session; run from a plain terminal"
fi
case "$PWD/" in
  "$OLD_DIR"/*) selfguard "cwd ($PWD) is inside $OLD_DIR — cd elsewhere first (mv would orphan your shell)" ;;
esac

# ---------------------------------------------------------------------------
# Preflight (all read-only; every check runs in both modes)
# ---------------------------------------------------------------------------
say "-- preflight --"
FAIL=0
check() { # check <ok|fail> <message>
  if [ "$1" = ok ]; then printf '  PASS  %s\n' "$2"; else printf '  FAIL  %s\n' "$2"; FAIL=1; fi
}

[ -d "$OLD_DIR" ]        && check ok "source dir exists: $OLD_DIR"        || check fail "source dir missing: $OLD_DIR"
[ ! -e "$NEW_DIR" ]      && check ok "target dir absent: $NEW_DIR"        || check fail "target dir already exists: $NEW_DIR"
[ -f "$OLD_UNIT" ]       && check ok "systemd unit exists: $OLD_UNIT"     || check fail "systemd unit missing: $OLD_UNIT"
[ ! -e "$NEW_UNIT" ]     && check ok "target unit absent: $NEW_UNIT"      || check fail "target unit already exists: $NEW_UNIT"
[ -f "$OLD_DESKTOP" ]    && check ok "desktop entry exists: $OLD_DESKTOP" || check fail "desktop entry missing: $OLD_DESKTOP"
[ -d "$OLD_CLAUDE_DIR" ] && check ok "Claude project dir exists: $OLD_CLAUDE_DIR" || check fail "Claude project dir missing: $OLD_CLAUDE_DIR"
[ ! -e "$NEW_CLAUDE_DIR" ] && check ok "Claude target key absent: $NEW_CLAUDE_DIR" || check fail "Claude target key already exists: $NEW_CLAUDE_DIR"

# Live session hosts: an active claude-station-host-*.scope means a Claude/Codex
# session is running whose control files and cwd point at the old path — the
# rename would strand or kill it. Hard abort until they are closed.
SCOPES="$(systemctl --user list-units "$OLD_NAME-host-*" --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -c . || true)"
if [ "${SCOPES:-0}" -eq 0 ]; then
  check ok "no live session-host scopes"
else
  check fail "$SCOPES live session-host scope(s) running (systemctl --user list-units '$OLD_NAME-host-*') — close all sessions first"
fi

# Clean working tree so the mv is a lossless checkpoint.
if [ -d "$OLD_DIR/.git" ]; then
  DIRTY="$(git -C "$OLD_DIR" status --porcelain | grep -c . || true)"
  if [ "${DIRTY:-0}" -eq 0 ]; then
    check ok "git working tree clean"
  else
    check fail "git working tree has $DIRTY uncommitted change(s) — commit or stash first"
  fi
else
  check fail "no .git in $OLD_DIR"
fi

# Service state is informational, not a failure: we stop it ourselves.
if systemctl --user is-active --quiet "$OLD_NAME.service" 2>/dev/null; then
  say "  INFO  $OLD_NAME.service is ACTIVE — step 1 would stop it"
else
  say "  INFO  $OLD_NAME.service is not active (stop becomes a no-op)"
fi

if [ "$RENAME_GITHUB" -eq 1 ]; then
  command -v gh >/dev/null 2>&1 && check ok "gh CLI available" || check fail "--rename-github given but gh CLI not found"
fi

say ""
if [ "$FAIL" -ne 0 ]; then
  if [ "$APPLY" -eq 1 ]; then
    abort "preflight failed — nothing was changed"
  fi
  say "!! preflight FAILED — '--apply' would ABORT here without changing anything."
  say "!! The plan below is shown for review only. Fix the FAIL lines, then re-run."
else
  say "preflight OK"
fi
say ""

# ---------------------------------------------------------------------------
# The plan (executed under --apply, printed otherwise)
# ---------------------------------------------------------------------------
say "-- step 1: stop service --"
run systemctl --user stop "$OLD_NAME.service"

say "-- step 2: move project directory --"
run mv "$OLD_DIR" "$NEW_DIR"

say "-- step 3: systemd unit --"
if [ "$APPLY" -eq 1 ]; then
  printf '  exec : write %s (paths -> %s, Description=Orchard)\n' "$NEW_UNIT" "$NEW_DIR"
  sed -e "s|$OLD_DIR|$NEW_DIR|g" \
      -e "s|^Description=.*|Description=Orchard (local dashboard/server)|" \
      "$OLD_UNIT" > "$NEW_UNIT"
else
  plan "write $NEW_UNIT: copy of $OLD_UNIT with $OLD_DIR -> $NEW_DIR and Description=Orchard (local dashboard/server)"
fi
run systemctl --user disable "$OLD_NAME.service"
run rm "$OLD_UNIT"
run systemctl --user daemon-reload
run systemctl --user enable "$NEW_NAME.service"

say "-- step 4: desktop launcher --"
if [ "$APPLY" -eq 1 ]; then
  printf '  exec : write %s (Exec/Icon -> %s)\n' "$NEW_DESKTOP" "$NEW_DIR"
  sed -e "s|$OLD_DIR|$NEW_DIR|g" "$OLD_DESKTOP" > "$NEW_DESKTOP"
else
  plan "write $NEW_DESKTOP: copy of $OLD_DESKTOP with Exec/Icon paths $OLD_DIR -> $NEW_DIR (Name is already 'Orchard')"
fi
run rm "$OLD_DESKTOP"
if command -v update-desktop-database >/dev/null 2>&1; then
  run update-desktop-database "$APP_DIR"
else
  say "  note : update-desktop-database not installed — skipping (launchers usually rescan anyway)"
fi

say "-- step 5: migrate Claude Code project data --"
# Claude Code stores per-project session transcripts and auto-memory under
# ~/.claude/projects/<abs-path-with-slashes-as-dashes>. Moving the repo changes
# that key, so we move the data to the new key to preserve full session history
# and memory continuity for the renamed path.
run mv "$OLD_CLAUDE_DIR" "$NEW_CLAUDE_DIR"

say "-- step 6: fix absolute paths inside migrated memory files --"
if [ "$APPLY" -eq 1 ]; then
  if [ -d "$NEW_CLAUDE_DIR/memory" ]; then
    MATCHES="$(grep -rl "$OLD_DIR" "$NEW_CLAUDE_DIR/memory" 2>/dev/null || true)"
    if [ -n "$MATCHES" ]; then
      printf '%s\n' "$MATCHES" | while IFS= read -r f; do
        printf '  exec : sed %s -> %s in %s\n' "$OLD_DIR" "$NEW_DIR" "$f"
        sed -i "s|$OLD_DIR|$NEW_DIR|g" "$f"
      done
    else
      say "  note : no absolute old-path references found in memory files"
    fi
  fi
else
  plan "grep -rl '$OLD_DIR' $NEW_CLAUDE_DIR/memory && sed each hit to $NEW_DIR (transcripts left untouched — historical record)"
fi

say "-- step 7: server registry --"
if [ -f "$REGISTRY_JSON" ]; then
  if [ "$APPLY" -eq 1 ]; then
    printf '  exec : update hostPath in %s (backup: %s.pre-rename)\n' "$REGISTRY_JSON" "$REGISTRY_JSON"
    cp "$REGISTRY_JSON" "$REGISTRY_JSON.pre-rename"
    sed -i "s|$OLD_DIR|$NEW_DIR|g" "$REGISTRY_JSON"
  else
    plan "backup $REGISTRY_JSON -> .pre-rename, then sed hostPath $OLD_DIR -> $NEW_DIR"
  fi
else
  say "  note : $REGISTRY_JSON not found — skipping"
fi

say "-- step 8: repo-local reference copies (inside the moved repo) --"
if [ "$APPLY" -eq 1 ]; then
  printf '  exec : rewrite %s/deploy/{%s.service,%s.desktop} and scripts/station-open.sh\n' "$NEW_DIR" "$NEW_NAME" "$NEW_NAME"
  sed -e "s|$OLD_DIR|$NEW_DIR|g" \
      -e "s|^Description=.*|Description=Orchard (local dashboard/server)|" \
      "$NEW_DIR/deploy/$OLD_NAME.service" > "$NEW_DIR/deploy/$NEW_NAME.service"
  sed -e "s|$OLD_DIR|$NEW_DIR|g" \
      -e "s|^Name=.*|Name=Orchard|" \
      -e "s|^Comment=.*|Comment=Open the Orchard dashboard|" \
      "$NEW_DIR/deploy/$OLD_NAME.desktop" > "$NEW_DIR/deploy/$NEW_NAME.desktop"
  rm "$NEW_DIR/deploy/$OLD_NAME.service" "$NEW_DIR/deploy/$OLD_NAME.desktop"
  sed -i "s|systemctl --user start $OLD_NAME|systemctl --user start $NEW_NAME|" "$NEW_DIR/scripts/station-open.sh"
  say "  note : these edits dirty the (moved) working tree on purpose — review + commit them afterwards"
else
  plan "rewrite deploy/$OLD_NAME.{service,desktop} -> deploy/$NEW_NAME.{service,desktop} + point scripts/station-open.sh at $NEW_NAME.service (then commit)"
fi

say "-- step 9: GitHub rename (optional) --"
if [ "$RENAME_GITHUB" -eq 1 ]; then
  GH_USER="$(gh api user -q .login)"
  [ -n "$GH_USER" ] || abort "could not resolve the GitHub login via 'gh api user' — is gh authed?"
  run gh repo rename "$NEW_NAME" --repo "$GH_USER/$OLD_NAME" --yes
  run git -C "$NEW_DIR" remote set-url origin "https://github.com/$GH_USER/$NEW_NAME.git"
else
  say "  skip : --rename-github not given (GitHub repo + git remote left as-is; old remote URL keeps working via GitHub redirects even after a later rename)"
fi

say "-- step 10: start + verify --"
run systemctl --user start "$NEW_NAME.service"
if [ "$APPLY" -eq 1 ]; then
  say "  exec : curl $HEALTH_URL (up to 20s)"
  ok=0
  for _ in $(seq 1 20); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)" = "200" ]; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" -eq 1 ]; then
    say "  PASS  health check: 200 from $HEALTH_URL"
  else
    abort "health check FAILED — inspect: journalctl --user -u $NEW_NAME.service -n 50"
  fi
else
  plan "curl $HEALTH_URL until HTTP 200 (20s timeout), abort with journalctl pointer on failure"
fi

say ""
say "== post-rename checklist =="
say "  [ ] relaunch any Orchard sessions you closed for the preflight (fresh cwd: $NEW_DIR)"
say "  [ ] Super+R launcher: entry should now read from $NEW_DESKTOP (log out/in if it's stale)"
say "  [ ] in the moved repo: review + commit the deploy/ + station-open.sh rewrites; run npm run board:check"
say "  [ ] server data dir is still $HOME/.local/share/$OLD_NAME (constant in src/lib/paths.ts) — renaming it is a separate code change"
say "  [ ] registry project id/name still '$OLD_NAME' (only hostPath was migrated) — cosmetic; rename via the UI if desired"
say "  [ ] residual references: grep -r '$OLD_DIR' ~/.config ~/.mcp.json 2>/dev/null (e.g. serena/MCP configs)"
if [ "$RENAME_GITHUB" -eq 0 ]; then
  say "  [ ] GitHub repo still '$OLD_NAME' — rerun with --rename-github or rename manually when ready"
fi
say ""
if [ "$APPLY" -eq 1 ]; then
  say "DONE — $OLD_NAME is now $NEW_NAME."
elif [ "$FAIL" -ne 0 ]; then
  say "DRY-RUN complete — preflight FAILED (see above); '--apply' would abort. Nothing was changed."
  exit 1
else
  say "DRY-RUN complete — nothing was changed. Re-run with --apply from a plain terminal to execute."
fi
