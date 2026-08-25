#!/usr/bin/env bash
# Assemble the modelfit.docgraph.app deploy directory.
#
# The site and the model registry share one Cloudflare Pages project, and a
# Pages deploy REPLACES the whole site — so both must be published together or
# one wipes the other. Always deploy the directory this script produces.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist-site}"

rm -rf "$OUT"
mkdir -p "$OUT/registry/v1"

cp -R "$ROOT/website/." "$OUT/"
cp "$ROOT/registry/registry.json" "$OUT/registry/v1/registry.json"

cat > "$OUT/_headers" <<'EOF'
/registry/*
  Cache-Control: public, max-age=300
  Access-Control-Allow-Origin: *

/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/img/*
  Cache-Control: public, max-age=86400
EOF

echo "built $OUT"
ls "$OUT"
