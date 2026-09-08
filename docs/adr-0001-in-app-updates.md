# ADR-0001 — In-app updates

**Status:** Accepted · 2026-09-08 · steps 1–2 implemented, 3–5 outstanding
**Relates to:** [REQUIREMENTS.md](../REQUIREMENTS.md) (NFR "Auto-update: Tauri
updater, signed releases", milestone M6),
[gap-plan-2026-09.md](gap-plan-2026-09.md) (registry updates without a release
stay the primary freshness path; this ADR is about the *shell*, not the data).

## Context

ModelFit is a Tauri 2 desktop app (`apps/desktop`) at v0.1.0 with no release
workflow yet: `.github/workflows` only builds the registry, and CI holds no
secrets ([production-deploy](production-deploy.md) ships the site from a local
wrangler). Users who install v1 will otherwise have to notice a new version on
the website and re-download the installer by hand.

Requirements from the product side:

1. Check for a new version in the background; never block startup or first
   paint, never show a spinner for it.
2. Notify the user non-modally that a new version exists and let them install
   it *without re-downloading the app themselves*.
3. Provide a manual "Check for updates" button in the UI.
4. Failures (offline, manifest down, bad signature) are silent to the user and
   logged; the app keeps working on the current version.

Constraints:

- The repo is public (`github.com/docgraphapp/modelfit`), the website repo is
  private.
- macOS replaces the app bundle in place, which Gatekeeper only allows for a
  signed and notarized bundle. Windows installers must also be signed to avoid
  SmartScreen warnings. Both need secrets that CI does not currently hold.
- Registry freshness is already solved out of band (remote JSON); the updater
  must not become a second path for data updates.

## Decision

### 1. Mechanism: `tauri-plugin-updater`

Use the official Tauri 2 updater plugin rather than a hand-rolled downloader.
It fetches a static JSON manifest, compares semver against the bundled
version, streams the platform bundle, verifies a minisign signature, and
installs in place. The relaunch afterwards is core Tauri's `AppHandle::restart`
called from our own command, so `tauri-plugin-process` is not needed — the
frontend never talks to the updater directly, and adding a second plugin only
to expose a restart to JS would widen the IPC surface for nothing.

Rejected: a custom "download DMG and open it" flow (still a manual reinstall,
so it fails requirement 2) and Sparkle/WinSparkle (two native stacks to
maintain for one feature the Tauri plugin already covers).

### 2. Manifest and artifact hosting: GitHub Releases on the public repo

Each tagged release publishes the platform bundles, their `.sig` files, and a
`latest.json` manifest as release assets. The updater endpoint is the stable
`releases/latest/download/latest.json` URL. The manifest is one small JSON
file, so a check is a single request.

Rejected: hosting the manifest on `modelfit.docgraph.app`. It would tie app
releases to the site deploy path, which is local-only today, and the site repo
is private while the app is public. Can be revisited if we ever need
staged rollouts or download analytics.

### 3. Signing: minisign for the updater, platform signing for install

- **Updater signature**: one minisign keypair generated with
  `tauri signer generate`. Public key is committed in `tauri.conf.json`
  (`plugins.updater.pubkey`). Private key and password become the
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` CI
  secrets. Losing the private key means every installed copy can never update
  again, so the key is also stored in the team password manager.
- **macOS**: Developer ID Application certificate + notarization via
  App Store Connect API key. Required for in-place replacement to work.
- **Windows**: code-signing certificate. Not strictly required for the
  updater to function, but unsigned installers get SmartScreen-blocked, so
  it ships with M6 as REQUIREMENTS already says.
- **Linux**: AppImage only for v1; no platform signature needed beyond
  minisign.

This is the first time CI holds secrets. That is a deliberate change to the
[production-deploy](production-deploy.md) posture and is limited to the
release workflow, which runs only on `v*` tags.

### 4. Check policy

| When | What |
|---|---|
| Startup | Rust spawns the check on a background task ~5 s after the window is shown, with a 10 s network timeout. |
| While open | Re-check every 6 h. |
| Manual | "Check for updates" button in the footer, beside the registry version and "Copy diagnostics" — the same place people already look when something seems off. Runs the same check immediately and *does* surface the outcome ("up to date (0.1.0)", "couldn't reach the update server"). |
| Dev builds | Skipped entirely (`cfg!(debug_assertions)` or `?scenario=` browser harness). |

The startup check uses `tauri::async_runtime::spawn` from `setup`, after the
existing first-paint `show()` path, so it can never delay the window.

### 5. UI behaviour

Implemented in `UpdateBanner` (`apps/desktop/src/App.tsx`); the four stages it
renders are `available`, `downloading`, `ready`, `failed`.

- The background check announces itself as `updater://available`, and the
  download reports `updater://progress`; the frontend listens for both. There
  is no error event: a background failure is nobody's business but the log's,
  and the manual check reports through its own return value.
- Available update: a small dismissible banner, not a modal. Text shows the
  version and release notes summary from the manifest. Actions: **Install and
  restart**, **Later**.
- Install: the download runs in the background with a progress bar in the
  banner. Nothing else in the app is disabled. Install and restart are two
  separate steps — the banner switches to "Restart now" once the new version
  is in place, so the app never disappears out from under a user mid-task.
- A failed download leaves the banner in place offering **Try again**.
- **Later** records the dismissed version in `localStorage`
  (`modelfit:update-dismissed`), alongside the calibration and measurements
  already kept there, so the same version is not offered again on the next
  startup. The manual button ignores the dismissal.
- Errors from the background check are logged via `tauri-plugin-log` and never
  shown.

### 6. Release workflow (new)

`release.yml`, triggered on `v*` tags:

1. Matrix build (macOS universal, Windows x64, Linux x64) with
   `tauri-apps/tauri-action`, which builds, signs (minisign + platform),
   notarizes on macOS, and uploads bundles + `latest.json` to a draft GitHub
   Release.
2. A human publishes the draft. Publishing is the moment installed apps start
   seeing the new version, so it stays manual.

Versions come from `tauri.conf.json` and `Cargo.toml`; a small check in the
workflow fails if the tag and config versions disagree.

## Consequences

- **Positive**: users stay current without visiting the site; the same pipeline
  gives us signed installers, which M6 needs anyway; check + install logic is
  ~200 lines of glue rather than a downloader we own.
- **Negative**: the minisign private key becomes a single point of failure;
  key loss or leak forces a manual re-download of the app for every user.
  Mitigated by password-manager backup and a documented rotation procedure
  (ship a release signed with both old and new keys is *not* supported by the
  plugin, so rotation = one manual reinstall).
- **Negative**: Apple Developer Program membership and a Windows code-signing
  certificate become recurring costs.
- **Neutral**: the app version is now bumped in three places
  (`tauri.conf.json`, `Cargo.toml`, `package.json`). A script or a check in the
  release workflow keeps them aligned.
- Registry freshness is unchanged: model data still updates without an app
  release, as decided in the gap plan.

## Implementation plan

| Step | Scope | Depends on |
|---|---|---|
| 1 | ✅ Plugin wiring in `lib.rs`, `updater.rs` commands, events, dev-build skip | nothing |
| 2 | ✅ React banner, "Check for updates" button, dismissed-version state, browser-harness mock scenarios | 1 |
| 3 | Generate minisign keypair, commit pubkey, add CI secrets | decision on who holds the key |
| 4 | `release.yml` with tauri-action, draft release, version check | 3, Apple/Windows certificates |
| 5 | First tagged release; verify update from 0.1.0 → 0.1.1 on each platform | 4 |

Steps 1–2 are done. They shipped against a **throwaway keypair**: the public
key currently in `tauri.conf.json` (`RWQQPdpwHQGQIhLvZELzR90UZ9gIiP5WyYUHUFpcX/jBBpcGXhgI48Rv`)
has no private half in anyone's hands and exists only so the app compiles and
the plugin initialises. **Step 3 must replace it**; until then no manifest
this app accepts can be produced, which is the safe failure mode.

The UI is exercised through the browser harness rather than a real release:
`?scenario=update` announces an update on the same delay the shell uses,
`?scenario=update-fail` breaks the download halfway. Both verified end to end
(banner → progress → "Restart now", dismissal surviving a reload, manual check
re-offering a dismissed version).

## Open questions

- Who owns the Apple Developer account and the signing keys?
- Do we want a "beta" channel later? The plugin supports multiple endpoints,
  so this is additive, but it affects the manifest naming from day one
  (`latest.json` vs `stable.json`). Default: single `latest.json`, rename only
  if a beta channel is ever added.
