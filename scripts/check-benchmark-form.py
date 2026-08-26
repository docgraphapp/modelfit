#!/usr/bin/env python3
"""Check the Share-my-benchmark URL against the GitHub issue form.

GitHub prefills an issue form by matching query-string keys to field `id`s and
silently ignores anything that does not match — so a renamed or mistyped id
produces a blank field with no error anywhere. Nothing else in the build would
catch that, and the failure is only visible to a user who has already clicked
Share. This asserts the two halves agree.

Usage: python3 scripts/check-benchmark-form.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import yaml

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / ".github" / "ISSUE_TEMPLATE" / "benchmark.yml"
# Query keys that steer GitHub itself rather than filling a field.
CONTROL_KEYS = {"template", "labels", "title", "assignees", "projects"}


def real_url() -> tuple[dict[str, str], str]:
    """Run the shipped builder; return its printed fields and the URL."""
    out = subprocess.run(
        ["cargo", "run", "-q", "-p", "modelfit-share", "--example", "share_url"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    lines = [l for l in out.splitlines() if l.strip()]
    url = lines[-1]
    printed = {}
    for line in lines[:-1]:
        m = re.match(r"^(.*?)\s{2,}(.*)$", line)
        if m:
            printed[m.group(1).strip()] = m.group(2).strip()
    return printed, url


def main() -> int:
    spec = yaml.safe_load(TEMPLATE.read_text())
    fields = {b["id"]: b for b in spec["body"] if "id" in b}
    required = {
        i for i, b in fields.items() if b.get("validations", {}).get("required")
    }

    printed, url = real_url()
    parts = urlsplit(url)
    query = {k: v[0] for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
    errors: list[str] = []

    if parts.scheme != "https" or parts.netloc != "github.com":
        errors.append(f"unexpected destination: {parts.scheme}://{parts.netloc}")
    if query.get("template") != TEMPLATE.name:
        errors.append(f"template param is {query.get('template')!r}, expected {TEMPLATE.name!r}")

    sent = set(query) - CONTROL_KEYS
    unknown = sorted(sent - set(fields))
    if unknown:
        errors.append(f"query keys with no field in the form (silently dropped): {unknown}")

    missing_required = sorted(required - sent)
    if missing_required:
        errors.append(f"required fields never prefilled: {missing_required}")

    for key in sorted(sent):
        if not query[key].strip():
            errors.append(f"{key}: prefilled with an empty value")

    # The preview the user approves must be what the URL carries.
    labels = {fields[i]["attributes"]["label"]: i for i in sent if i in fields}
    for label, value in printed.items():
        fid = labels.get(label)
        if fid is None:
            errors.append(f"preview row {label!r} has no matching form field")
        elif query.get(fid) != value:
            errors.append(f"{fid}: preview shows {value!r} but URL carries {query.get(fid)!r}")

    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        return 1

    print(
        f"ok · {len(sent)} fields prefilled, {len(required)} required all present, "
        f"preview matches URL"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
