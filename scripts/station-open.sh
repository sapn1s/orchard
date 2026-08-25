#!/usr/bin/env bash
# Launch (or reuse) the claude-station background service, then open the
# dashboard in the default browser. Intended for use as the Exec= line of
# the claude-station.desktop launcher (Super+R -> "Claude Station").
set -euo pipefail

systemctl --user start claude-station
xdg-open http://127.0.0.1:4317
