#!/usr/bin/env python3
"""Render /glossary/ on the website from the app's glossary.ts.

glossary.ts is the single source of truth for every definition ModelFit
publishes: the desktop app renders entries as hover cards, this renders the
same entries as a web page. Hand-editing the page would recreate exactly the
drift this is meant to prevent, so the generated block is fenced by markers and
replaced wholesale on every build.

Usage: build-glossary-page.py [--check] <template-and-target.html>

--check renders in memory and fails if the file on disk differs, so a hand-edit
to the checked-in copy is reported rather than silently overwritten at build.
"""
import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GLOSSARY = ROOT / "apps/desktop/src/glossary.ts"
DEFAULT_POST = "fundamentals"

START = "<!-- glossary:entries:start -->"
END = "<!-- glossary:entries:end -->"
TOC_START = "<!-- glossary:toc:start -->"
TOC_END = "<!-- glossary:toc:end -->"

POSTS_RE = re.compile(r"(\w+): `\$\{SITE\}(/blog/[a-z0-9-]+/)`")
ENTRY_RE = re.compile(
    r'^  (\w+): \{\s*'
    r'title:\s*"((?:[^"\\]|\\.)*)",\s*'
    r'brief:\s*\n?\s*"((?:[^"\\]|\\.)*)",\s*'
    r'anchor:\s*"([^"]+)",'
    r'(?:\s*post:\s*"([^"]+)",)?'
    r'(?:\s*aliases:\s*\[([^\]]*)\],)?',
    re.M,
)
ALIAS_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')


def kebab(name: str) -> str:
    """Mirror glossaryUrl() in glossary.ts — the anchors must agree."""
    return re.sub(r"[A-Z]", lambda m: "-" + m.group(0).lower(), name)


def unescape_ts(s: str) -> str:
    return s.replace('\\"', '"').replace("\\\\", "\\")


def main() -> int:
    args = sys.argv[1:]
    check = "--check" in args
    args = [a for a in args if a != "--check"]
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    target = Path(args[0])
    if not target.is_file():
        print(f"error: no glossary template at {target}", file=sys.stderr)
        return 1

    source = GLOSSARY.read_text()
    posts = dict(POSTS_RE.findall(source))
    entries = ENTRY_RE.findall(source)
    if not entries:
        print("error: parsed no entries out of glossary.ts", file=sys.stderr)
        return 1

    terms = sorted(
        (
            {
                "id": kebab(name),
                "title": unescape_ts(title),
                "brief": unescape_ts(brief),
                "href": f"{posts[post or DEFAULT_POST]}#{anchor}",
                # Searchable but not shown: shorthand people type, not read.
                "aka": " ".join(
                    unescape_ts(a) for a in ALIAS_RE.findall(aliases or "")
                ),
            }
            for name, title, brief, anchor, post, aliases in entries
        ),
        key=lambda t: t["title"].lower(),
    )

    toc = "\n".join(
        f'        <li><a href="#{t["id"]}">{html.escape(t["title"])}</a></li>'
        for t in terms
    )
    body = "\n".join(
        f'''      <section id="{t['id']}"{f' data-aka="{html.escape(t["aka"])}"' if t["aka"] else ""}>
        <h2>{html.escape(t['title'])}<a class="anchor" href="#{t['id']}" aria-label="Link to this term">#</a></h2>
        <p>{html.escape(t['brief'])}</p>
        <p><a class="term-more" href="{t['href']}">Full explanation →</a></p>
      </section>'''
        for t in terms
    )

    page = target.read_text()
    for start, end, block in ((TOC_START, TOC_END, toc), (START, END, body)):
        if start not in page or end not in page:
            print(f"error: {target} is missing the {start} / {end} markers", file=sys.stderr)
            return 1
        page = re.sub(
            re.escape(start) + r".*?" + re.escape(end),
            lambda _: f"{start}\n{block}\n{' ' * 6}{end}",
            page,
            flags=re.S,
        )

    if check:
        if page != target.read_text():
            print(f"error: {target} is out of date with glossary.ts", file=sys.stderr)
            print("It is generated — run scripts/build-glossary-page.py to refresh it.", file=sys.stderr)
            return 1
        print(f"ok: {target} matches all {len(terms)} entries in glossary.ts")
        return 0

    target.write_text(page)
    print(f"ok: rendered {len(terms)} glossary terms into {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
