#!/usr/bin/env python3
"""Verify every glossary anchor still exists in the fundamentals post.

The app's hover cards deep-link into section ids on modelfit.docgraph.app.
Those ids are a contract: shipped builds keep requesting them forever, so a
renamed section silently breaks "Learn more" for every user who has not
updated. This fails the build instead.

Run from CI after the website is checked out, or locally with the sibling
docgraphapp/modelfit-web clone in place.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GLOSSARY = ROOT / "apps/desktop/src/glossary.ts"
POST = "blog/local-llm-fundamentals/index.html"


def find_site() -> Path | None:
    for candidate in (ROOT / "website", ROOT.parent / "website"):
        if (candidate / POST).is_file():
            return candidate
    return None


def main() -> int:
    site = find_site()
    if site is None:
        print(f"skip: no website checkout with {POST}")
        return 0

    anchors = set(re.findall(r'anchor: "([^"]+)"', GLOSSARY.read_text()))
    ids = set(re.findall(r'<section id="([^"]+)">', (site / POST).read_text()))

    missing = sorted(anchors - ids)
    if missing:
        print(f"error: {POST} has no section for: {', '.join(missing)}", file=sys.stderr)
        print("Anchors are a published contract — add the section, don't rename it.", file=sys.stderr)
        return 1

    print(f"ok: all {len(anchors)} glossary anchors resolve in {POST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
