#!/usr/bin/env python3
"""Verify every glossary deep link still resolves on the website.

The app's hover cards deep-link into section ids on modelfit.docgraph.app.
Those ids are a contract: shipped builds keep requesting them forever, so a
renamed section silently breaks "Learn more" for every user who has not
updated. This fails the build instead.

Checks both halves of each link — that the post still exists at the path the
app expects, and that the post still defines the section the app asks for.

Run from CI after the website is checked out, or locally with the sibling
docgraphapp/modelfit-web clone in place.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GLOSSARY = ROOT / "apps/desktop/src/glossary.ts"
DEFAULT_POST = "fundamentals"

# Entries are formatted with `post:` on the line after `anchor:`, so one regex
# reads both. A term with no `post:` falls back to DEFAULT_POST, matching
# termUrl() in glossary.ts.
ENTRY_RE = re.compile(r'anchor: "([^"]+)",(?:\s*post: "([^"]+)",)?')
POSTS_RE = re.compile(r'(\w+): `\$\{SITE\}(/blog/[a-z0-9-]+/)`')
SECTION_RE = re.compile(r'<section id="([^"]+)">')


def find_site(rel_paths) -> Path | None:
    """A checkout is valid only if every post the app links to is in it."""
    for candidate in (ROOT / "website", ROOT.parent / "website"):
        if all((candidate / p).is_file() for p in rel_paths):
            return candidate
    return None


def main() -> int:
    source = GLOSSARY.read_text()

    posts = {name: path for name, path in POSTS_RE.findall(source)}
    if not posts:
        print("error: could not parse the POSTS map in glossary.ts", file=sys.stderr)
        return 1

    links = [(anchor, post or DEFAULT_POST) for anchor, post in ENTRY_RE.findall(source)]
    if not links:
        print("error: could not parse any glossary anchors", file=sys.stderr)
        return 1

    unknown = sorted({p for _, p in links if p not in posts})
    if unknown:
        print(f"error: glossary references unknown post(s): {', '.join(unknown)}", file=sys.stderr)
        return 1

    used = sorted({p for _, p in links})
    rel = {p: f"{posts[p].strip('/')}/index.html" for p in used}

    site = find_site(rel.values())
    if site is None:
        print(f"skip: no website checkout with {', '.join(sorted(rel.values()))}")
        return 0

    ids = {p: set(SECTION_RE.findall((site / rel[p]).read_text())) for p in used}

    missing = sorted({(post, a) for a, post in links if a not in ids[post]})
    if missing:
        for post, anchor in missing:
            print(f"error: {rel[post]} has no section id '{anchor}'", file=sys.stderr)
        print("Anchors are a published contract — add the section, don't rename it.", file=sys.stderr)
        return 1

    print(f"ok: all {len(links)} glossary links resolve across {len(used)} post(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
