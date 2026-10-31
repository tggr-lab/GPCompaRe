#!/usr/bin/env bash
# Assemble one release: the database at the staging root, Studio under studio/.
#
#   scripts/build_release.sh --stage DIR --studio-dist DIR [--data-root DIR] [--build-dir DIR]
#
#   --stage        staging directory, replaced by this run
#   --studio-dist  the Studio's `npm run build` output, built from a clean commit
#   --data-root    checkout holding The_batch_RRCS_analyzer/ and the
#                  GPCompaReports_v2/output/data caches (default: this repo's
#                  main checkout, because both are gitignored and a linked
#                  worktree has neither)
#   --build-dir    where the database is generated (default: <stage>-db-build).
#
# Reuses an existing --build-dir only with --skip-build, which assembles again
# without regenerating. Nothing here pushes anything; publish with
# scripts/deploy_pages.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv-test/bin/python"
STAGE="" STUDIO_DIST="" DATA_ROOT="" BUILD="" SKIP_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    --studio-dist) STUDIO_DIST="$2"; shift 2 ;;
    --data-root) DATA_ROOT="$2"; shift 2 ;;
    --build-dir) BUILD="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$STAGE" ] && [ -n "$STUDIO_DIST" ] || { sed -n 2,16p "$0" >&2; exit 2; }
if [ -z "$DATA_ROOT" ]; then
  DATA_ROOT="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")"
fi
BUILD="${BUILD:-${STAGE%/}-db-build}"
ANALYZER="$DATA_ROOT/The_batch_RRCS_analyzer"
BATCH="$ANALYZER/batch_analysis_full/batch_analysis_20260202_151051"
CACHES="$DATA_ROOT/GPCompaReports_v2/output/data"

[ -x "$PY" ] || { echo "no venv at $ROOT/.venv-test: see GPCompaReports_v2/requirements-site.txt" >&2; exit 1; }
[ -d "$BATCH/csv_data" ] || { echo "no batch data at $BATCH" >&2; exit 1; }
[ -f "$STUDIO_DIST/index.html" ] && [ -f "$STUDIO_DIST/sw.js" ] || {
  echo "no Studio build at $STUDIO_DIST" >&2; exit 1; }

# A failed import does not stop the generator: it builds every report without
# a snake plot. Stop here instead.
export PYTHONPATH="$ANALYZER"
(cd "$ROOT" && "$PY" - <<'PY'
import sys
sys.path.insert(0, '.')
from GPCompaReports_v2.website.page_generators.gpcr_report_helpers import _BUILDER_OK, _OUROBOROS_OK
if not (_OUROBOROS_OK and _BUILDER_OK):
    sys.exit('snake plots unavailable: ouroboros=%s, builder=%s' % (_OUROBOROS_OK, _BUILDER_OK))
PY
)

if [ "$SKIP_BUILD" -eq 0 ]; then
  rm -rf "$BUILD"
  mkdir -p "$BUILD/data"
  # The Conservation and AlphaMissense views read these caches from the output
  # directory, and a fresh directory silently loses them.
  cp "$CACHES"/conservation_*.json "$CACHES"/alphamissense_*.json "$BUILD/data/"
  SEEDED=$(find "$BUILD/data" -name '*.json' | wc -l)
  [ "$SEEDED" -ge 566 ] || { echo "seeded only $SEEDED cache files from $CACHES" >&2; exit 1; }
  echo "==> Generating the database (seeded $SEEDED caches)..."
  "$PY" "$ROOT/GPCompaReports_v2/generate_site.py" --output "$BUILD" --batch-dir "$BATCH"
fi

echo "==> Assembling $STAGE..."
mkdir -p "$STAGE"
rsync -a --delete \
  --exclude='/data/' --exclude='/poster/' --exclude='/dossier/' --exclude='/studio/' \
  "$BUILD/" "$STAGE/"
mkdir -p "$STAGE/studio"
rsync -a --delete "${STUDIO_DIST%/}/" "$STAGE/studio/"
touch "$STAGE/.nojekyll"

"$PY" "$ROOT/scripts/check_stage.py" "$STAGE"
echo "==> Stage ready: $STAGE"
