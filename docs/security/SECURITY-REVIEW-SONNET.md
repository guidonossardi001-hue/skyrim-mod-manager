# SECURITY REVIEW BOARD — SONNET (Senior Secure Software Engineer)

> Cycle 1 · 2026-07-10 · Target: Skyrim AE Mod Manager (Electron + TypeScript + React)
> SONNET audits the repository across every dimension and applies minimal, reviewable, security-preserving fixes.

## 1. Executive Summary

The codebase is mature and already hardened (contextIsolation, `nodeIntegration:false`, safeStorage-encrypted secrets that never cross IPC, SQL column-whitelisting + parameterized queries, zip-slip guard, SSRF host allow-list on signed artifacts, pinned Ed25519 verification, single-instance lock, atomic `.part`/`.tmp` promotion). The audit spanned 12 dimensions and produced **51 raw findings**; after HAIKU's adversarial verification **37 survived** (14 refuted as duplicates-of-baseline or non-issues).

This cycle applies **14 code fixes** across 8 files. They cluster on the one structural weakness OPUS identified: **the renderer's indirect authority over spawned executables and the update trust anchor.** Every fix is additive (a new guard) — none disables an existing control. **Result: `tsc` clean, ESLint 0 errors, 417/417 tests green (410 existing + 7 new).**

## 2. Applied fixes

Severity uses HAIKU's adjusted rating. "Probability" is likelihood in this app model (renderer loads only local bundled content; contextIsolation on — so most renderer-origin chains require a *first* code-execution foothold, of which none is confirmed today).

---

### FIX 1 — `settings:set` accepts arbitrary keys (RCE keystone, indirect)
- **Dimension:** ipc-permission-model / command-injection · **Severity:** High · **Files:** `electron/main.ts`
- **Vulnerability:** the handler branched only on `SECRET_KEYS`; every other key was written verbatim to `electron-store`. Because `electron-store` uses `dot-prop`, a crafted key (`"a.b"`, dotted paths) could reach nested/unexpected state, and all executable-path settings (`mo2Path`, `sevenZipPath`, …) are round-tripped through this same channel.
- **Impact:** config-clobber; feeds the spawn sinks below.
- **Probability:** Medium (needs renderer foothold).
- **Solution & why:** reject any key that is not a flat identifier (`/^[A-Za-z][A-Za-z0-9_]*$/`). This blocks dotted/pollution keys **without** removing the renderer's ability to persist its legitimate flat config/path keys — the non-breaking form HAIKU required (a blanket "reject path keys" would have silently broken the Settings save flow, which persists picked paths via `settings:set`).
- **New risks:** none; legitimate keys are all flat identifiers (verified against every `store.get/set` call site).

### FIX 2 — Tool-launch handlers spawn whatever path is in the store (existsSync-only)
- **Dimension:** command-injection-rce · **Severity:** High · **Files:** `electron/main.ts`
- **Vulnerability:** `toolPath(key)` returned any existing path; `launchTool` spawned it. A mis-set/tampered `mo2Path`/`sseeditPath`/etc. became an arbitrary-binary launcher, falsifying the file's own "renderer never supplies executables" comment.
- **Impact:** native code execution with the user's session (post-foothold).
- **Probability:** Medium.
- **Solution & why:** enforce a **per-tool expected basename** at the spawn sink (`TOOL_BINARIES`): `modorganizer.exe`, `loot(.exe)`, `sseedit/xedit…`, `dyndolod…`, `pandora….exe`. Enforcing at the *sink* (not the setter) is what actually makes the invariant true, and it mirrors the pre-existing `resolveGameLaunchTarget` check that already required `modorganizer.exe`.
- **New risks:** a non-canonically-named tool binary is refused (logged). Acceptable and documented — 7-Zip/MO2/xEdit/LOOT/DynDOLOD ship with canonical names.

### FIX 3 — `tools:validate-7z` launches a renderer-supplied path before the identity check
- **Dimension:** command-injection-rce · **Severity:** High · **Files:** `electron/main.ts`
- **Vulnerability:** the `configured` path was passed to `detect7zPath` (returned as-is if it merely exists) and **spawned**; the "is it 7-Zip?" banner check ran only *after* the process started.
- **Impact:** single-IPC arbitrary-exe launch (post-foothold).
- **Probability:** Medium.
- **Solution & why:** gate on a 7-Zip basename (`/^(7z|7za|7zg|7zr)\.exe$/i`) **before** spawn. Keeps the pick-then-validate UX (you can still validate a just-picked `7z.exe`) while removing the arbitrary-launch primitive.
- **New risks:** none for real 7-Zip binaries.

### FIX 4 — 7-Zip spawn choke-point (`detect7zPath`) covers the extraction path too
- **Dimension:** command-injection-rce · **Severity:** High · **Files:** `electron/install/sevenZip.ts`
- **Vulnerability:** the extraction pipeline (`resolveRar7z` → `run7z`) spawns `store.get('sevenZipPath')`, which FIX 3 alone did not cover.
- **Solution & why:** add the same basename gate inside `detect7zPath`'s `configured` branch — the single choke point for *every* 7-Zip spawn. Trusted `COMMON_7Z_PATHS` constants are unaffected.
- **Verification:** all 12 `sevenZip.test.ts` cases still pass (they use canonical `7z.exe` names).

### FIX 5 — `sanitizePathSegment` allowed a one-level directory escape
- **Dimension:** filesystem-path-traversal · **Severity:** Low (CONFIRMED exploitable) · **Files:** `electron/util/paths.ts`
- **Vulnerability:** a renderer-supplied profile/mod name of `..` (or `.`, or trailing-dot/space, or a reserved device name like `CON`) survived sanitization and, via `join(root, name)`, escaped the intended directory or hit a Windows device.
- **Impact:** write/enumerate one level outside the profile/instance root.
- **Probability:** Low–Medium (needs foothold to set a hostile profile name).
- **Solution & why:** reject `.`/`..` and Windows reserved device names outright (→ fallback), and strip trailing dots/spaces that Windows silently drops. Ordinary names pass through unchanged.
- **Verification:** new `electron/util/paths.test.ts` (7 cases) asserts the escape is neutralized and normal names are untouched.

### FIX 6 — Direct download URL: plaintext http + arbitrary host (SSRF)
- **Dimension:** download-mitm-network · **Severity:** Medium · **Files:** `electron/downloadManager.ts`
- **Vulnerability:** `resolveUrl` returned a stored direct `url` as-is if it matched `^https?://` — no https requirement, no host constraint. A renderer-supplied `downloads:add` URL turned the main process into an SSRF proxy (reach localhost/LAN) and permitted plaintext-MITM'd content.
- **Solution & why:** `assertSafeDirectUrl` — require `https:` and reject internal/loopback/link-local hosts. Scoped so the signed **delta** path (already host-allow-listed at manifest verify, GitHub over https) is unaffected; a strict Nexus-only allow-list would have broken delta (HAIKU's warning).
- **New risks:** a legitimately-stored direct URL on a private host would now be refused — none exist in the app's Nexus/GitHub-centric flows.

### FIX 7 — Non-premium download token leaked to the renderer
- **Dimension:** secrets-env-keys · **Severity:** Low (CONFIRMED) · **Files:** `electron/main.ts`
- **Vulnerability:** `downloads:list` used `SELECT *`, returning the short-lived `nxm_key`/`nxm_expires` secret to the renderer.
- **Solution & why:** explicit column list omitting the token columns (used only main-side).
- **New risks:** none — no renderer code consumes those columns.

### FIX 8 — CSP omitted object/base/form/frame directives
- **Dimension:** electron-window-csp-sandbox · **Severity:** Low · **Files:** `electron/main.ts`
- **Solution & why:** prepend `object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` in both dev and prod — closes plugin, `<base>`-rewrite, form-exfil, and clickjacking/embedding vectors CSP leaves open by default. `img-src https:` retained to avoid breaking Nexus CDN thumbnails.

### FIX 9 — No permission handler; renderer not sandboxed
- **Dimension:** electron-window-csp-sandbox · **Severity:** Low (defense-in-depth) · **Files:** `electron/main.ts`
- **Solution & why:** `setPermissionRequestHandler`/`setPermissionCheckHandler` deny-all (the app needs no camera/mic/geo/USB/notifications), and `sandbox:true` on the window (the preload uses only contextBridge + ipcRenderer, both sandbox-safe). Shrinks a compromised renderer's reach to the vetted IPC surface only.
- **New risks:** these are Electron-runtime behaviors **not exercised by the unit suite** → require a manual app smoke-test (see HAIKU report §5).

### FIX 10 — Loose `startsWith('http')` external-open scheme check
- **Dimension:** electron-window-csp-sandbox · **Severity:** Low · **Files:** `electron/main.ts`
- **Solution & why:** replaced with a strict `^https?://` test in both the window-open handler and `will-navigate`, so schemes like `httpx:`/`http-evil:` no longer pass to `shell.openExternal`.

### FIX 11 — `nexus:get-mod` interpolates an unvalidated id into a secret-bearing URL
- **Dimension:** ipc-permission-model · **Severity:** Low · **Files:** `electron/main.ts`
- **Solution & why:** reject non-positive-integer `nexusId` before building the URL (the request carries the API key) — no path/query injection into the Nexus API URL.

### FIX 12 — Binary-planting on bare-name `spawn`
- **Dimension:** command-injection-rce · **Severity:** Low · **Files:** `electron/steam/detect.ts`, `electron/launcher/launcherService.ts`
- **Vulnerability:** `reg.exe`, `tasklist.exe`, `wscript.exe` invoked by bare name → a planted binary on PATH/CWD could run instead.
- **Solution & why:** resolve all three from an absolute `%SystemRoot%\System32` path.

### FIX 13 — adm-zip fallback: compressed-size cap only (zip bomb → OOM)
- **Dimension:** archive-bomb-extraction · **Severity:** Low · **Files:** `electron/install/extract.ts`
- **Solution & why:** the in-memory fallback buffers output; add a **declared-uncompressed-total** cap (4 GiB) before extracting. 7-Zip (streaming) remains the path for genuinely large archives and is unaffected.

### FIX 14 — Log injection / forgery via untrusted names
- **Dimension:** logging-errors-races-leaks · **Severity:** Low (CONFIRMED) · **Files:** `electron/logger.ts`
- **Solution & why:** neutralize control characters (newline/CR/tab/NUL) in `scope`/`message` and cap length — a crafted mod/catalog name can no longer inject or forge extra log lines.

### FIX 15 — Trust anchor overridable by a user-writable env var
- **Dimension:** update-signing-antireplay / secrets · **Severity:** Low→High-if-reached · **Files:** `electron/delta/pinnedKey.ts`
- **Vulnerability:** `NOLVUS_MANIFEST_PUBKEY` could replace the pinned Ed25519 public key at runtime; a local attacker setting it (e.g. `HKCU\Environment`) makes every forged manifest verify.
- **Solution & why:** honor the override only in dev/test/ci; **production always pins the embedded key.** Production rotation must ship a new build or a signed key-rotation manifest (tracked as P1).
- **New risks:** env-based rotation no longer works in shipped builds — intended; that mechanism was the vulnerability.

## 3. Dimensions audited (12)

electron-window-csp-sandbox · ipc-permission-model · filesystem-path-traversal-toctou · archive-bomb-extraction · download-mitm-network · update-signing-antireplay · secrets-env-keys · command-injection-rce · input-validation-proto-pollution · xss-renderer · dependency-supply-chain · logging-errors-races-leaks.

Notable clean results: **XSS** — no `dangerouslySetInnerHTML` anywhere in `src/`; the single `innerHTML` (`src/main.tsx`) is a static error string; React auto-escaping holds. **Prototype pollution** — `electron-store`/`dot-prop@6` blocks `__proto__`/`constructor`; SQL row builders are column-whitelisted. **Secret confidentiality & crypto chain** — sound (safeStorage fail-closed, sha256→Ed25519 fails closed at each stage).

## 4. Not applied this cycle (deferred — see roadmap)

Documented for OPUS's P1/P2 backlog rather than applied, because each needs a design decision or a build/infra action beyond a minimal in-tree patch:

- **Update freshness / rollback** (`delta/service.ts`): `published_at` is signed but never checked → a fresh/reset client accepts an authentically-signed *old* release. Needs a persisted monotonic high-water mark.
- **Mandatory hash-gating on the ordinary download path** (`installer.ts` / `delta/manifest.ts`): integrity verification is fail-open when no hash is present. Requiring `file_hash` may reject existing manifests — needs a migration plan.
- **`fs:open-path` / `fs:read-dir` confinement** (`main.ts`): whole-disk read/enumerate + shell-open oracle. Right fix is root-confinement + switching the Downloads "open folder" button to `shell.showItemInFolder` (a renderer change) — deferred to avoid breaking legit "open .7z/installer" flows.
- **Install concurrency cap** (`downloadManager.ts`): cache-hits bypass the download concurrency gate → unbounded concurrent extractions.
- **Supply chain:** lockfile↔manifest drift (`npm ci` currently fails), unsigned NSIS installer/executable, no recorded checksum for the bundled `7z.exe`/`7z.dll`.
- **Producer hygiene:** `scripts/sign_manifest.py` is fail-open on an unencrypted private key.
- **`secrets/nexus.key`:** a live plaintext API key on disk (gitignored, not committed). **Delete after confirming it is migrated to the encrypted store** — SONNET will not delete a user key file unprompted.

## 5. Final verification

```
tsc --noEmit         → clean
eslint src electron  → 0 errors (3 pre-existing renderer warnings, untouched files)
vitest run           → 417 passed / 417 (45 files)
```
No regression. No control weakened. See HAIKU report for the adversarial re-check and residual attack surface.
