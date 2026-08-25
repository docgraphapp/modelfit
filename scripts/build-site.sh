#!/usr/bin/env bash
# Assemble the modelfit.docgraph.app deploy directory.
#
# The site and the model registry share one Cloudflare Pages project, and a
# Pages deploy REPLACES the whole site — so both must be published together or
# one wipes the other. Always deploy the directory this script produces.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist-site}"

# The website lives in the separate docgraphapp/modelfit-web repo. In CI it is
# checked out into $ROOT/website; locally it is the sibling checkout ../website.
if [ -d "$ROOT/website" ]; then
  SITE="$ROOT/website"
elif [ -d "$ROOT/../website" ]; then
  SITE="$ROOT/../website"
else
  echo "error: website checkout not found (clone docgraphapp/modelfit-web next to this repo)" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/registry/v1"

cp -R "$SITE/." "$OUT/"
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
