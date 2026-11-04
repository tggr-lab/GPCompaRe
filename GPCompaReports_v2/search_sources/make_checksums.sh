#!/bin/sh
# Rewrites CHECKSUMS.sha256 for every cache file in this folder (run from here).
cd "$(dirname "$0")" && find . -type f \( -name '*.gz' -o -name '*.tsv' -o -name '*.json' \) ! -name 'validation_report.json' | sort | xargs sha256sum > CHECKSUMS.sha256
