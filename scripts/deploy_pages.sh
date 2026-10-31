#!/usr/bin/env bash
# Publish a staged release to the gh-pages branch.
#
#   scripts/build_release.sh --stage DIR --studio-dist DIST
#   scripts/deploy_pages.sh DIR
#
# There is no database-only deployment. The sync below deletes whatever the
# source does not hold, so a build without studio/ would delete the Studio. A
# database update goes through build_release.sh with the current Studio build,
# and this script refuses a stage that lacks it.
#
# Pre-requisites:
#   - `origin` remote pointing at the GitHub repo
#   - Push access to that repo
#   - The browser smoke tests must be runnable: see
#     docs/superpowers/RELEASE_CHECKLIST.md for the one-time venv setup.
#     They run automatically below, against the staged site, before anything
#     is pushed. A skipped run is treated as a failure, not a pass, and there
#     is no flag to bypass them.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE="$ROOT/.gh-pages-worktree"
BRANCH="gh-pages"
PY="$ROOT/.venv-test/bin/python"

[ $# -eq 1 ] || { sed -n 2,5p "$0" >&2; exit 2; }
STAGE="$(cd "$1" && pwd)"

cd "$ROOT"

# 0. Sanity checks: remote exists, and the stage is a complete release
if ! git remote | grep -qx "origin"; then
  echo "ERROR: no 'origin' remote. Set one with:" >&2
  echo "  git remote add origin git@github.com:tggr-lab/GPCompaRe.git" >&2
  exit 1
fi
for need in index.html studio/index.html studio/sw.js; do
  [ -f "$STAGE/$need" ] || { echo "ERROR: $STAGE has no $need" >&2; exit 1; }
done
"$PY" "$ROOT/scripts/check_stage.py" "$STAGE"

# 1. Required pre-deployment check: browser smoke tests against the stage.
#
#     This tests the real artefact, before the push, so a failure costs
#     nothing. run_browser_tests.sh exits non-zero if the venv is missing, if
#     Playwright is not installed, if there is no build, or if pytest collects
#     nothing, so a skip cannot masquerade as a pass here.
#
#     There is deliberately no bypass flag. This is a publication companion
#     site, so no emergency justifies publishing unverified JavaScript. If an
#     exceptional case ever needs one, edit this script: that leaves a record
#     in git, which an environment variable would not.
echo "==> Required pre-deployment check: browser smoke tests..."
if ! SMOKE_BUILD_DIR="$STAGE" bash "$ROOT/scripts/run_browser_tests.sh" -q; then
  echo "" >&2
  echo "ERROR: browser smoke tests did not pass against the stage." >&2
  echo "       Nothing has been pushed. The gh-pages branch is untouched." >&2
  echo "" >&2
  echo "       If they could not run at all, that is still a failure, not a" >&2
  echo "       pass: see docs/superpowers/RELEASE_CHECKLIST.md for the" >&2
  echo "       one-time venv setup." >&2
  exit 1
fi

# 2. Clean any previous worktree
if [ -d "$WORKTREE" ]; then
  git worktree remove "$WORKTREE" --force || rm -rf "$WORKTREE"
fi

# 3. Bring the local branch up to origin. Fast-forward only: a branch that has
#    moved on origin (a commit made outside this script) must not be overwritten.
git fetch origin "$BRANCH:$BRANCH"

if ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "==> Creating orphan gh-pages branch..."
  git worktree add --detach "$WORKTREE"
  cd "$WORKTREE"
  git checkout --orphan "$BRANCH"
  git rm -rf . >/dev/null 2>&1 || true
  touch .nojekyll
  git add .nojekyll
  git commit -m "Initialize gh-pages"
  cd "$ROOT"
else
  git worktree add "$WORKTREE" "$BRANCH"
fi

# 4. Sync the stage into the worktree. --delete drops files the stage does not
#    hold, which is why the stage has to be a complete release. The stage is
#    already free of /data/, /poster/ and /dossier/ (build_release.sh, and
#    check_stage.py refuses them); the excludes stay as a second guard.
echo "==> Syncing stage to gh-pages..."
rsync -a --delete \
  --exclude='.git' --exclude='.nojekyll' \
  --exclude='/data/' \
  --exclude='/poster/' --exclude='/dossier/' \
  "$STAGE/" "$WORKTREE/"
# Drop any stale data/ left from a previous deploy so gh-pages stays lean.
rm -rf "$WORKTREE/data"
touch "$WORKTREE/.nojekyll"

# 5. Commit + push
cd "$WORKTREE"
git add -A
if git diff --cached --quiet; then
  echo "==> No changes to deploy"
else
  TAG="$(cd "$ROOT" && git describe --tags --always)"
  STAMP="$(date -Iseconds)"
  git commit -m "Deploy: $TAG ($STAMP)"
  git push origin "$BRANCH"
fi

cd "$ROOT"
git worktree remove "$WORKTREE" --force
echo ""
echo "==> Done."
echo "    Live URL: https://tggr-lab.github.io/GPCompaRe/ (Studio: studio/)"
echo "    The old https://tggr-lab.github.io/gpcompreports/ address forwards to it."
