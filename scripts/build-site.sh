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

# /glossary/ is generated from apps/desktop/src/glossary.ts, the same file the
# desktop app bundles its hover cards from. Rendering it here rather than
# committing it to the website repo is what keeps the app and the site from
# drifting apart on a definition. The checked-in copy is only for local preview.
python3 "$ROOT/scripts/build-glossary-page.py" "$OUT/glossary/index.html"

cat > "$OUT/_headers" <<'EOF'
/registry/*
  Cache-Control: public, max-age=300
  Access-Control-Allow-Origin: *

/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/img/*
  Cache-Control: public, max-age=86400
EOF

# NOTE: /img/* is cached for a day at the edge, so a redrawn favicon.svg keeps
# serving from cache long after it ships — the tab icon is the last thing to
# update and the first thing people notice is stale. When the artwork changes,
# bump the ?v= on the favicon <link> in every page of the modelfit-web repo.

echo "built $OUT"
ls "$OUT"
