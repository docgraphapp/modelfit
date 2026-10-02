#!/usr/bin/env node
// Licence gate for the desktop frontend's PRODUCTION dependency closure (audit
// 2026-10-02). Dev-only packages never ship and are skipped, except Tailwind,
// whose preflight CSS is emitted into the bundle. Run from the repo root.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop");
const ALLOW = /^\(?(MIT|MIT-0|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|CC0-1\.0|Unlicense|Zlib|BlueOak-1\.0\.0|MPL-2\.0)((\s+(OR|AND)\s+)\(?(MIT|MIT-0|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|CC0-1\.0|Unlicense|Zlib|BlueOak-1\.0\.0|MPL-2\.0)\)?)*\)?$/;

let paths;
try {
  paths = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: desktop, encoding: "utf8" })
    .split("\n").map((l) => l.trim()).filter((p) => p && p !== desktop);
} catch (e) {
  console.error(`npm ls failed (run npm ci in apps/desktop): ${e.message.split("\n")[0]}`);
  process.exit(2);
}
paths.push(join(desktop, "node_modules", "tailwindcss"));

const bad = [];
for (const dir of paths) {
  let pj;
  try { pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { continue; }
  const lic = typeof pj.license === "string" ? pj.license : pj.license?.type ?? "NONE";
  if (!ALLOW.test(lic)) bad.push(`${pj.name}@${pj.version}\t${lic}`);
}
if (bad.length) {
  console.error(`npm licence gate: ${bad.length} shipped package(s) outside the allow-list:\n${bad.join("\n")}`);
  process.exit(1);
}
console.log(`npm licence gate OK: ${paths.length} shipped packages, all permissive.`);
