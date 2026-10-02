# Licensing & compliance

Audit date: 2026-10-02. Re-run before any paid offering or major dependency change.

## DocGraph ModelFit's own licence

MIT (see `LICENSE`, copyright DocGraph). Anyone may use, fork and redistribute
the code, including commercially, as long as the copyright notice is kept.

## Third-party components

- **Nothing DocGraph ModelFit ships is copyleft beyond MPL-2.0.** The only MPL crate in the
  binary is `option-ext` (via `dirs` → tauri), unmodified, which MPL allows in
  any project; its source is linked from the notices file. No GPL, AGPL, LGPL-only,
  SSPL, BUSL or non-commercial licence anywhere in the shipped tree.
- **Notices ship with the binary:** `apps/desktop/src-tauri/resources/THIRD-PARTY-NOTICES.md`,
  listed in `tauri.conf.json` → `bundle.resources`. Generate with
  `node scripts/gen-third-party-notices.mjs`; never edit by hand.
- **CI gate** (`.github/workflows/licenses.yml`): `cargo deny check licenses`
  (allow-list in `deny.toml`), `scripts/check-npm-licenses.mjs` (the shipped npm
  closure plus Tailwind, whose CSS is emitted into the bundle), and the notices
  `--check`. Add a licence to an allow-list only after reading it.
- **Not redistributed by DocGraph ModelFit:** model weights (pulled by the user's own
  Ollama under each model's licence, e.g. Llama Community, Gemma Terms) and
  Ollama itself. The bundled `registry/registry.json` holds factual metadata
  (sizes, hashes, context lengths) plus our own quality scores, no weights or
  model-card text.
- **Website fonts** (Geist, Newsreader) are OFL-1.1; the site ships
  `fonts/OFL.txt` alongside the font files as the licence requires.

## Export control

DocGraph ModelFit uses only standard, published cryptography: TLS (rustls / OS) and
Ed25519 signature verification of updates (`minisign-verify`, via the Tauri
updater). No encryption of user data. This is mass-market, authentication-only
use: EU Regulation 2021/821 Category 5 Part 2 Note 3, and US EAR 5D992.c /
licence exception ENC — no licence or report needed. The source is public
(EAR § 742.15(b) publicly-available encryption source code).

## Privacy

No telemetry, analytics or crash reporting. What the app and website send, and
to whom, is documented in the website's privacy policy
(https://modelfit.docgraph.app/privacy-policy/). Any new network call must be
added there in the same change.
