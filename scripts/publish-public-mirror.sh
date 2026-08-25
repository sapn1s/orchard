#!/usr/bin/env bash
# publish-public-mirror.sh — build a fresh-history public tree of this repo.
# FEAT-049 item 5.
#
# The private repo's git HISTORY contains private project names, absolute
# /home paths and personal context throughout (commits + ticket evolution), so
# the public release is a FRESH-HISTORY mirror: current (scrubbed) tracked
# files only, one initial commit, brand-new repo. This script never touches
# the private repo or its remote.
#
#   scripts/publish-public-mirror.sh                       # build + gate + report (no network)
#   scripts/publish-public-mirror.sh --out /tmp/mirror     # choose the build dir
#   scripts/publish-public-mirror.sh --push --repo orchard # ALSO gh repo create + push
#
# Default mode does no network I/O and no gh calls. --push requires --repo and
# a PASSING leak gate.
#
# RUN AS THE USER from a plain terminal. Agents author/dry-run this, never push.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEAK_GATE="$SRC_DIR/scripts/leak-gate.mjs"
COMMIT_MSG="Orchard — initial public release"

OUT_DIR=""
PUSH=0
REPO_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --out)  OUT_DIR="${2:?--out needs a directory}"; shift 2 ;;
    --push) PUSH=1; shift ;;
    --repo) REPO_NAME="${2:?--repo needs a name}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "ABORT: unknown argument '$1' (use --out <dir>, --push --repo <name>)" >&2; exit 2 ;;
  esac
done

if [ "$PUSH" -eq 1 ] && [ -z "$REPO_NAME" ]; then
  echo "ABORT: --push requires --repo <name>" >&2; exit 2
fi
if [ -z "$OUT_DIR" ]; then
  OUT_DIR="$(mktemp -d /tmp/orchard-mirror.XXXXXX)"
fi
TREE_DIR="$OUT_DIR/tree"
if [ -e "$TREE_DIR" ]; then
  echo "ABORT: $TREE_DIR already exists — pass a fresh --out dir" >&2; exit 1
fi
mkdir -p "$TREE_DIR"

echo "== public-mirror build =="
echo "   source : $SRC_DIR"
echo "   output : $TREE_DIR"
echo ""

# ---------------------------------------------------------------------------
# 1. Copy exactly the git-tracked files (working-tree contents, so the scrub
#    pass is included; gitignored + untracked files are excluded by design).
#
#    BUG-080: DROP private image assets. git tracks docs/bugs/assets/*.png —
#    raw dashboard captures whose pixels show private /home paths, usernames,
#    email and session titles that the text leak-gate can never scan. Only
#    images under a curated public allowlist (public/, docs/assets/ — the
#    README's hand-picked screenshots) are copied; every other image is
#    excluded from the tarball. Belt AND suspenders: the leak gate (step 2,
#    TREE mode) also HARD-FAILS on any non-allowlisted image that reaches the
#    tree, so a mistake here is caught, not shipped.
# ---------------------------------------------------------------------------
IMG_ALLOW_RE='^(public/|docs/assets/)'   # keep IN SYNC with leak-gate.mjs IMG_ALLOW
IMG_EXT_RE='\.(png|jpe?g|gif|ico|webp|bmp|tiff?|svg)$'
COPY_LIST="$OUT_DIR/tracked.filtered.z"
EXCLUDED_IMAGES=0
: > "$COPY_LIST"
while IFS= read -r -d '' f; do
  if printf '%s' "$f" | grep -qiE "$IMG_EXT_RE" && ! printf '%s' "$f" | grep -qE "$IMG_ALLOW_RE"; then
    EXCLUDED_IMAGES=$((EXCLUDED_IMAGES + 1))
    continue
  fi
  printf '%s\0' "$f" >> "$COPY_LIST"
done < <(cd "$SRC_DIR" && git ls-files -z)
( cd "$SRC_DIR" && tar --null -T "$COPY_LIST" -cf - ) | tar -xf - -C "$TREE_DIR"
FILE_COUNT="$(find "$TREE_DIR" -type f | wc -l)"
echo "-- copied $FILE_COUNT tracked files (excluded $EXCLUDED_IMAGES private image(s) not on the public allowlist)"

# ---------------------------------------------------------------------------
# 2. Leak gate — HARD gate over the built tree. The gate script is authored by
#    the FEAT-049 audit lane. It has landed, so a MISSING gate is no longer a
#    "build ungated with a warning" case — it is an aborted build.
#
#    FEAT-049 second pass: the old stub branch built a full fresh-history repo
#    when the gate file was absent and only refused the --push. That is a
#    foot-gun: deleting or renaming one file silently downgraded the only
#    check standing between this tree and a permanent public disclosure, and
#    the operator's evidence that the gate ran was a line of stdout nobody
#    reads. A publish pipeline whose gate can go missing has no gate. Absent
#    gate now aborts before anything is built.
# ---------------------------------------------------------------------------
GATE_OK=0
if [ ! -f "$LEAK_GATE" ]; then
  echo "ABORT: leak gate MISSING ($LEAK_GATE)." >&2
  echo "       The mirror is only safe because that gate runs; refusing to build without it." >&2
  echo "       Tree left for inspection at: $TREE_DIR" >&2
  exit 1
fi
echo "-- leak gate: node $LEAK_GATE $TREE_DIR"
if node "$LEAK_GATE" "$TREE_DIR"; then
  GATE_OK=1
  echo "-- leak gate: PASS"
else
  echo "ABORT: leak gate FAILED — the built tree still contains private tokens." >&2
  echo "       Tree left for inspection at: $TREE_DIR" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Fresh history: new git repo, single initial commit.
# ---------------------------------------------------------------------------
git -C "$TREE_DIR" init -q -b main
# This machine has no global git identity (the private repo carries it as
# repo-local config), so the fresh repo inherits it explicitly.
GIT_NAME="$(git -C "$SRC_DIR" config user.name || true)"
GIT_EMAIL="$(git -C "$SRC_DIR" config user.email || true)"
if [ -z "$GIT_NAME" ] || [ -z "$GIT_EMAIL" ]; then
  echo "ABORT: no git user.name/user.email resolvable from $SRC_DIR — set one, then re-run." >&2
  exit 1
fi
git -C "$TREE_DIR" config user.name "$GIT_NAME"
git -C "$TREE_DIR" config user.email "$GIT_EMAIL"
git -C "$TREE_DIR" add -A
git -C "$TREE_DIR" commit -q -m "$COMMIT_MSG"
echo "-- fresh history: $(git -C "$TREE_DIR" log --oneline | head -1)"

# ---------------------------------------------------------------------------
# 4. Publish — ONLY with --push --repo <name>, only from the fresh tree.
#    The private repo's remote is never read or written.
# ---------------------------------------------------------------------------
if [ "$PUSH" -eq 1 ]; then
  if [ "$GATE_OK" -ne 1 ]; then
    echo "ABORT: refusing --push — leak gate absent or not passed." >&2
    exit 1
  fi
  echo "-- creating public repo '$REPO_NAME' and pushing"
  gh repo create "$REPO_NAME" --public --source "$TREE_DIR" --push
  echo "-- pushed: $(git -C "$TREE_DIR" remote get-url origin)"
else
  echo ""
  echo "report:"
  echo "  tree      : $TREE_DIR ($FILE_COUNT files, single commit '$COMMIT_MSG')"
  if [ "$GATE_OK" -eq 1 ]; then
    echo "  leak gate : PASS"
  else
    echo "  leak gate : NOT RUN (scripts/leak-gate.mjs missing — blocked dependency)"
  fi
  echo "  publish   : skipped (re-run with --push --repo <name> to gh-create + push)"
fi
