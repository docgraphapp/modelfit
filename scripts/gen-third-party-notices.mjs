#!/usr/bin/env node
/**
 * Generate THIRD-PARTY-NOTICES.md for the ModelFit desktop app.
 *
 * ModelFit is MIT, but its BINARY redistributes ~200 Rust crates plus a small
 * JavaScript bundle. MIT, BSD, ISC, Zlib, Unicode-3.0, CDLA-Permissive-2.0,
 * Apache-2.0 and MPL-2.0 all expect their notices to travel WITH the binary, so
 * this file is written into the Tauri resource dir and listed in
 * tauri.conf.json → bundle.resources. Adapted from DocGraph's generator.
 *
 * We read each package's real licence file from disk (crates under
 * ~/.cargo/registry, npm packages under node_modules) rather than a template,
 * because the copyright line inside it is the part the licence requires.
 * cargo metadata lists every platform's crates, so this over-credits slightly
 * (build-only and other-OS crates) — harmless, and deterministic on any host.
 *
 * Usage (from the repo root):
 *   node scripts/gen-third-party-notices.mjs           # write the file
 *   node scripts/gen-third-party-notices.mjs --check   # CI: fail if stale
 * Exit 2 = could not read a dependency tree (not a pass, not a fail).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const OUT = join(desktop, "src-tauri/resources/THIRD-PARTY-NOTICES.md");
const checkOnly = process.argv.includes("--check");

// Files a package may ship its terms in. Order matters: prefer an explicit
// LICENSE over a COPYING, and collect NOTICE separately (Apache-2.0 §4d makes
// NOTICE contents themselves redistributable-with).
const LICENSE_RE = /^(LICEN[CS]E|COPYING|COPYRIGHT)([-._].*)?$/i;
const NOTICE_RE = /^NOTICE([-._].*)?$/i;

/** Read every licence-ish file in a package directory, concatenated. */
function readLicenseTexts(dir) {
  if (!dir || !existsSync(dir)) return { text: "", files: [] };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { text: "", files: [] };
  }
  const picked = entries
    .filter((e) => e.isFile() && (LICENSE_RE.test(e.name) || NOTICE_RE.test(e.name)))
    .map((e) => e.name)
    .sort();
  const parts = [];
  for (const name of picked) {
    try {
      const body = readFileSync(join(dir, name), "utf8").trim();
      if (body) parts.push(picked.length > 1 ? `----- ${name} -----\n${body}` : body);
    } catch {
      /* unreadable file: treated as missing, reported in the summary */
    }
  }
  return { text: parts.join("\n\n"), files: picked };
}

/**
 * Thrown when the dependency trees cannot be READ at all — no cargo, no
 * node_modules. That is "could not verify", which must never be reported as
 * "verified and stale": the release-preflight job installs neither toolchain,
 * and conflating the two turned a green tree into a bogus hard release block
 * (2026-08-16). Callers map this to exit 2, the same contract
 * check-public-mirrors.mjs uses for an unreachable network.
 */
class CannotCompute extends Error {}

// ---------------------------------------------------------------- Rust crates
function collectRust() {
  let raw;
  try {
    raw = execFileSync(
      "cargo",
      ["metadata", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml", "--format-version", "1"],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (e) {
    throw new CannotCompute(`cargo metadata unavailable: ${e.message.split("\n")[0]}`);
  }
  const meta = JSON.parse(raw);
  const ours = new Set(meta.workspace_members ?? []); // our own crates
  const out = [];
  for (const p of meta.packages) {
    if (ours.has(p.id)) continue;
    const dir = p.manifest_path ? dirname(p.manifest_path) : null;
    const { text, files } = readLicenseTexts(dir);
    out.push({
      ecosystem: "Rust (crates.io)",
      name: p.name,
      version: p.version,
      license: (p.license || "").trim() || (p.license_file ? "(see licence file)" : "UNSPECIFIED"),
      repository: p.repository || "",
      text,
      files,
    });
  }
  return out;
}

// npm devDependencies whose OUTPUT ships in the bundle. Tailwind's preflight
// CSS is emitted verbatim into dist/assets/*.css.
const EMBEDDED_NPM = [{ name: "tailwindcss", why: "preflight CSS emitted into dist/assets" }];

// ------------------------------------------------------------- npm packages
function collectNpm() {
  let paths;
  try {
    paths = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
      cwd: desktop,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    throw new CannotCompute(`npm ls unavailable (run npm ci in apps/desktop): ${e.message.split("\n")[0]}`);
  }
  const dirs = new Map(); // dir → ecosystem
  for (const d of paths) if (d !== desktop) dirs.set(d, "JavaScript (npm)");
  for (const e of EMBEDDED_NPM) {
    const d = join(desktop, "node_modules", e.name);
    if (!existsSync(join(d, "package.json"))) {
      throw new CannotCompute(`embedded package "${e.name}" (${e.why}) is not installed`);
    }
    dirs.set(d, "JavaScript (output embedded in the app)");
  }
  const out = [];
  for (const [dir, ecosystem] of dirs) {
    let pj;
    try {
      pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (pj.name?.startsWith("@types/")) continue;
    const { text, files } = readLicenseTexts(dir);
    const lic = typeof pj.license === "string" ? pj.license : pj.license?.type;
    const repo = typeof pj.repository === "string" ? pj.repository : pj.repository?.url;
    out.push({
      ecosystem,
      name: pj.name,
      version: pj.version,
      license: lic || "UNSPECIFIED",
      repository: pj.homepage || repo || "",
      text,
      files,
    });
  }
  return out;
}

// ------------------------------------------------------------------- render
function render(pkgs) {
  const missing = pkgs.filter((p) => !p.text);
  const withText = pkgs.filter((p) => p.text);

  // Group packages that ship byte-identical terms so the file stays navigable.
  // Most MIT files differ (they embed the copyright holder), so grouping mostly
  // helps for shared-text families — which is exactly where repetition is noise.
  const groups = new Map();
  for (const p of withText) {
    if (!groups.has(p.text)) groups.set(p.text, []);
    groups.get(p.text).push(p);
  }
  const ordered = [...groups.entries()].sort((a, b) =>
    a[1][0].name.localeCompare(b[1][0].name),
  );

  const lines = [];
  lines.push("# Third-party notices");
  lines.push("");
  lines.push(
    "ModelFit is MIT-licensed (see its LICENSE) and is built on open-source",
    "components. This file reproduces the copyright and permission notices",
    "those components require to be distributed with the software. Each",
    "component remains governed by its own licence, reproduced below.",
  );
  lines.push("");
  lines.push(
    "> Generated by `scripts/gen-third-party-notices.mjs`. Do not edit by hand —",
    "> run the script instead. CI and the release preflight verify it is current.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Components: **${pkgs.length}**`);
  for (const eco of [...new Set(pkgs.map((p) => p.ecosystem))].sort()) {
    lines.push(`  - ${eco}: ${pkgs.filter((p) => p.ecosystem === eco).length}`);
  }
  lines.push(`- Distinct licence texts reproduced: **${ordered.length}**`);
  if (missing.length) {
    // Loud, not silent — an unreproduced notice is the one thing this file
    // exists to prevent (same principle as the registry pin checker's skips).
    lines.push(
      `- **Components shipping no licence file on disk: ${missing.length}** ` +
        "(listed at the end — their SPDX identifier is recorded, but no text " +
        "was available to reproduce).",
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const [text, members] of ordered) {
    const heading = members
      .map((m) => `${m.name} ${m.version}`.trim())
      .sort()
      .join(", ");
    lines.push(`## ${heading}`);
    lines.push("");
    const spdx = [...new Set(members.map((m) => m.license))].join(" / ");
    const eco = [...new Set(members.map((m) => m.ecosystem))].join(", ");
    lines.push(`*${eco} — ${spdx}*`);
    const repo = members.find((m) => m.repository)?.repository;
    if (repo) lines.push(`<${repo}>`);
    lines.push("");
    lines.push("```text");
    lines.push(text);
    lines.push("```");
    lines.push("");
  }

  if (missing.length) {
    lines.push("---");
    lines.push("");
    lines.push("## Components with no licence file on disk");
    lines.push("");
    lines.push(
      "These ship no LICENSE/COPYING/NOTICE file in their published artifact.",
      "Their declared SPDX identifier is recorded here; the canonical text of",
      "each licence is reproduced elsewhere in this file.",
    );
    lines.push("");
    lines.push("| Component | Version | Declared licence | Ecosystem |");
    lines.push("|---|---|---|---|");
    for (const p of missing.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`| ${p.name} | ${p.version} | ${p.license} | ${p.ecosystem} |`);
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

// --------------------------------------------------------------------- main
let pkgs;
try {
  pkgs = [...collectRust(), ...collectNpm()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
} catch (e) {
  if (!(e instanceof CannotCompute)) throw e;
  console.error(`SKIPPED-UNVERIFIED: cannot read the dependency trees — ${e.message}`);
  console.error("  THIRD-PARTY-NOTICES.md was NOT checked. This is not a pass.");
  console.error("  Needs a Rust toolchain and `npm ci` in apps/desktop to compute.");
  process.exit(2);
}
const body = render(pkgs);

if (checkOnly) {
  if (!existsSync(OUT)) {
    console.error("FAIL: THIRD-PARTY-NOTICES.md does not exist. Run:");
    console.error("  node scripts/gen-third-party-notices.mjs");
    process.exit(1);
  }
  if (readFileSync(OUT, "utf8") !== body) {
    console.error("FAIL: THIRD-PARTY-NOTICES.md is out of date with the dependency tree.");
    console.error("      A dependency was added, removed, or bumped. Regenerate:");
    console.error("        node scripts/gen-third-party-notices.mjs");
    process.exit(1);
  }
  const missing = pkgs.filter((p) => !p.text).length;
  console.log(
    `OK: THIRD-PARTY-NOTICES.md is current (${pkgs.length} components` +
      (missing ? `, ${missing} without an on-disk licence file` : "") +
      ")",
  );
  process.exit(0);
}

writeFileSync(OUT, body);
const missing = pkgs.filter((p) => !p.text);
console.log(`wrote ${OUT}`);
console.log(`  components: ${pkgs.length}`);
console.log(`  distinct licence texts: ${new Set(pkgs.filter((p) => p.text).map((p) => p.text)).size}`);
if (missing.length) {
  console.log(`  WITHOUT an on-disk licence file: ${missing.length}`);
  for (const p of missing.slice(0, 15)) console.log(`    - ${p.name} ${p.version} (${p.license})`);
  if (missing.length > 15) console.log(`    … and ${missing.length - 15} more`);
}
