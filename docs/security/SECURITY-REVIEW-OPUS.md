# SECURITY REVIEW BOARD — OPUS (Lead Security Architect)

> Cycle 1 · 2026-07-10 · Target: Skyrim AE Mod Manager (Electron + TypeScript + React)
> OPUS produces the Threat Model, Risk Assessment, and Mitigation Roadmap and validates every change. OPUS does not modify code.

# Security Architecture Review — Skyrim AE Mod Manager
**Author:** OPUS, Lead Security Architect · **Date:** 2026-07-10 · **Scope:** synthesis of seven subsystem threat-model maps into the architect-level frame for SONNET's line-by-line audit.

---

## 1. Executive Summary

This is a **mature, deliberately hardened Electron codebase** whose designers clearly understood the platform's sharp edges: context isolation and `nodeIntegration:false` are set, secrets are safeStorage-encrypted and never cross IPC, SQL access is column-whitelisted and parameterized, archive extraction has a zip-slip guard and atomic `.part`/`.tmp` promotion, the signed-manifest/catalog engines use a pinned Ed25519 key over an SSRF-hardened JSON transport with monotonic anti-replay, and a single-instance lock protects the database. These controls are real and hold up under inspection; the crypto primitive chain (sha256 → pinned-key Ed25519) correctly fails closed at each stage.

The residual risk is concentrated in **one structural flaw and a small number of defense-in-depth gaps that cluster around it.** The keystone is that the app's stated exec-security invariant — "the renderer chooses *which* tool to launch, never *what* executable runs" — is **not actually enforced**: an unrestricted `settings:set` IPC channel lets a compromised renderer rewrite every executable path the main process later spawns, and two sibling channels (`tools:validate-7z`, `fs:open-path`) hand the renderer a spawn/open primitive directly. Any one of these converts a renderer XSS into local code execution, which matters because the renderer displays attacker-influenceable mod/catalog content and is not explicitly sandboxed. A second cluster erodes the update trust anchor: the pinned public key, host allow-lists, and catalog URL are all overridable via user-writable environment variables, and archive integrity verification is **fail-open** for the ordinary (non-delta) download path. Finally, the supply chain has a **broken lockfile↔manifest correspondence** and ships an **unsigned installer** plus an unverified in-repo 7-Zip binary.

Bottom line: the confidentiality and cryptographic boundaries are sound; the **exec/path-resolution boundary is porous by construction**, and the trust anchor and integrity gates are weaker than the surrounding architecture implies. None of these require exotic conditions — the top three are reachable from a single renderer compromise on a Windows-first app that renders remote content. Remediation is well-scoped and mostly additive (allow-lists, `sandbox:true`, an immutable pin, mandatory hash gating), not a redesign.

---

## 2. Threat Model

### 2.1 Actors

| Actor | Capability | Reaches |
|---|---|---|
| **Malicious mod author / corrupted archive** | Controls archive bytes, internal structure (entry names, ratio, format), and Nexus-sourced install recipes & metadata (names, `thumbnail_url`, descriptions) rendered in the SPA | Download→extract→install pipeline; renderer XSS sinks; 7-Zip/adm-zip parsers |
| **Any website the user visits** | Emits `nxm://…` links; hosts a page that drives a forced download; can attempt to serve candidate manifests/catalogs from an allow-listed GitHub host | `nxm://` dispatch (no consent gate); bulk download transport |
| **Network MITM / redirect hijack / malicious mirror** | On-path or rogue-CA; controls redirects and (for bulk downloads) `HTTP(S)_PROXY`; can replay/withhold authentic-but-stale signed artifacts | `axiosGet` bulk transport (no SSRF/redirect/proxy hardening); update freshness |
| **Malicious update server / fake Nexus** | Serves manifest/catalog contents; cannot forge signatures but can replay older-signed releases or withhold updates | Delta/catalog engines (rollback/freeze) |
| **Same-Windows-user local attacker / malware / a one-shot script the user runs** | No elevation needed: writes `HKCU\Environment`, plants files in Downloads/CWD/app-dir, replays user-scoped DPAPI | Env trust-anchor override; binary/DLL planting; plaintext `secrets/nexus.key`; auto-detect roots |
| **Supply-chain attacker** | Malicious/typosquatted npm package or hijacked transitive dep; distribution-channel MITM against the unsigned installer | `postinstall` + 4 install-script packages (full dev privilege); shipped artifact authenticity |

### 2.2 Assets

- **A1 — Nexus API key** (download/account access). Encrypted at rest via safeStorage/DPAPI in SQLite; masked across IPC. *Also present in plaintext at `secrets/nexus.key` and as `NEXUS_API_KEY` env.*
- **A2 — Ed25519 release private key + passphrase** — signs delta manifests and the reference catalog. Held outside the tree, PKCS8-encrypted. The signer's default input path (`secrets/release_priv.pem`) indicates it was handled in-tree historically.
- **A3 — Ed25519 release public key** — the *trust anchor* for every signed artifact. Not secret; its **integrity is the entire guarantee**.
- **A4 — The user's real game install + tooling** (MO2, LOOT, SSEEdit, DynDOLOD, Pandora, SKSE loader) — spawn targets; the concrete code-execution payoff.
- **A5 — OS integrity / the user's Windows session token** — every spawned child inherits it; the manager runs with full ambient user authority.
- **A6 — Local filesystem & the mod volume** — whole-disk read oracle via `fs:*`; the volume itself is an exhaustible resource.

### 2.3 Trust boundaries

1. **Renderer ↔ main (IPC bridge)** — the primary boundary; the `contextBridge` `api` object (~40 channels) is the *entire* privilege-escalation surface. Preload TypeScript gives **zero runtime protection**; every handler must assume arbitrary argument shapes.
2. **Network → disk** — bulk archive bytes; content authenticity is *supposed* to be the sha256 gate, but that gate is optional (see R-INTEG).
3. **Untrusted archive → parser** — 7-Zip child (intended isolation) vs. the in-process `adm-zip` fallback (**not** isolated; runs on the main thread).
4. **Local environment ↔ verifier** — env vars feed the pinned key, host allow-lists, and source URL — the weakest boundary in the update subsystem.
5. **Process ↔ OS keychain (DPAPI)** — the real at-rest boundary for A1; user-scoped, **not** app-scoped.
6. **`nxm://` protocol / second-instance argv** — a machine-wide, unauthenticated entry point wired straight into download→install.
7. **Producer/CI ↔ signing scripts**, and **npm registry / dep closure → build → shipped artifact**.

---

## 3. Attack Surface (enumerated entry points)

1. **`nxm://` URLs** (`main.ts:342–408`) — cold start (`findNxmUrl(process.argv)`), warm (`second-instance`), macOS `open-url`. Remote, unauthenticated, **no consent prompt**; routes through `parseNxmUrl` into the download queue with the user's stored premium key.
2. **The IPC `api` surface** (`preload.ts:27`) — ~40 `invoke` channels exposed flat, plus a correctly-whitelisted `on/off` event set (`EVENT_CHANNELS`, preload.ts:7–19). High-authority members: `settings.set`, `tools.validate7z(path)`, `tools.launch*`, `launcher.playGame/createShortcut`, `settings.autoDetect`, `fs.openPath/readDir/exists/openExternal`, `stockGame.create`, `sync.start`, `deploy.run`, `delta.apply/finalize/ingest/ingestUrl`, `catalog.update/seed`, `backup.restore/delete`, `wabbajack.parse/export`. A renderer can also bypass preload types entirely via `ipcRenderer.invoke(channel, anyShape)`.
3. **Downloaded archives** — attacker controls bytes, entry names, compression ratio, format; reach `streamToFile` → `extractArchive` (7-Zip child + adm-zip fallback) and the cache-reuse path.
4. **Signed delta manifests & reference catalogs** — via `delta:ingest` (in-IPC object, bypasses the hardened fetch + size cap), `delta:ingest-url`, `catalog:update`, `catalog:seed`. Allow-listed hosts include all of `github.com` / `raw.githubusercontent.com` / `objects.githubusercontent.com`.
5. **`.wabbajack` files & Vortex `collection.json`** — renderer-supplied paths (`wabbajack.parse(wjPath)`, `wabbajack.export(outputPath)`) parsed main-side; validation lives outside the core file pair and must be modeled by SONNET.
6. **External-tool paths** — every spawn target (`mo2Path`, `gamePath`, `sevenZipPath`, `pandoraPath`, `lootPath`, `sseeditPath`, `dyndolodPath`) sourced from the `electron-store`, which is renderer-writable via `settings:set`.
7. **Environment variables** — `NOLVUS_MANIFEST_PUBKEY`, `NOLVUS_CATALOG_HOSTS`, `NOLVUS_MOD_CATALOG_HOSTS`, `NOLVUS_MOD_CATALOG_URL`, `NEXUS_API_KEY`, `NEXUS_ENABLED`, `HTTP(S)_PROXY` — all user-settable without elevation, several feeding the update trust anchor.
8. **On-disk credential & binary planting surfaces** — plaintext `secrets/nexus.key`; auto-detect roots (`C:/Games`, `C:/Modding`, `C:/Tools`, `C:/pandora`, Desktop/Downloads/Documents); bare-name OS helpers (`reg`, `tasklist`, `wscript.exe`) resolvable from app-dir/CWD; the unverified in-repo `resources/7zip-full/7z.exe`+`7z.dll`.
9. **Build/install-time** — `postinstall` + 4 install-script packages execute arbitrary code on any `npm install`; no `.npmrc`/`ignore-scripts`.

---

## 4. Risk Assessment

Severity = worst-case impact × exploitability on *this* app. Likelihood assumes the app's real threat context (renders remote mod content; Windows-first; same-user malware is a realistic local actor). IDs are architect-level and map to the subsystem findings in the appendix.

| # | Risk (file:line) | Severity | Likelihood | Impact |
|---|---|---|---|---|
| **A1** | **`settings:set` has no key/value allow-list** — renderer rewrites `mo2Path`/`gamePath`/`sevenZipPath`/etc., then triggers launch (`main.ts:999–1006` → `launchTool`, 1305–1320) | **Critical** | Med (needs renderer XSS) | Renderer-compromise → **arbitrary local code execution**; also redirects trusted FS roots. *Keystone.* |
| **A2** | **`tools:validate-7z` spawns a renderer-supplied path** before the identity check (`main.ts:1339–1352`; `detect7zPath` returns `configured` if it merely exists, `sevenZip.ts:60–64`) | **Critical** | Med | Single-IPC-call RCE, no settings write required |
| **A3** | **`fs:open-path` opens/executes any absolute path via Windows shell** (`main.ts:1291`) — no scheme/extension filter, unlike sibling `fs:open-external` | **High** | Med | Plant-then-execute (chains with extraction pipeline + `app:get-user-data`) |
| **A4** | **`launcher:playGame` weak target identity** — MO2 branch matches `/modorganizer\.exe$/i` on filename only; game branch spawns `join(gamePath,'skse64_loader.exe')` detached (`main.ts:500–531`) | **High** | Med (compounds A1) | Planted/renamed payload passes; survives via `.lnk` |
| **INTEG** | **Integrity verification is fail-open** — `installer.ts:218` gates on `if(fileHash)`; ordinary `nxm://`/direct downloads have no `delta_changeset` row ⇒ `expectedHash` returns null ⇒ archive extracted **unverified** | **High** | Med-High | The most common download path has **no content check**; amplifies A-SSRF/cache/truncation |
| **PIN** | **Trust anchor relocatable via env** — `NOLVUS_MANIFEST_PUBKEY` (+ host/URL env) overrides the pinned key (`pinnedKey.ts:11–13`) | **High** | Low-Med (needs same-user foothold) | Total signature-verification bypass → arbitrary signed-content delivery |
| **A-SSRF** | **Bulk download lacks SSRF/redirect/proxy hardening** — `axiosGet` follows redirects, honors `HTTP(S)_PROXY`, no host allow-list (`axiosAdapters.ts:9`), unlike `fetchSignedJson` | **Med-High** | Med | Redirect-to-internal / proxy-injection; fetched bytes hit disk & (per INTEG) extract |
| **NAV** | **`will-navigate` allows any `file://` + dev origin-prefix bypass** (`main.ts:322–328`); preload re-injected on every navigation | **High** | Low-Med | Attacker-planted local HTML loads with full IPC; `startsWith('http://localhost:5173')` matches `…5173.evil.com` |
| **SANDBOX** | **Renderer not explicitly `sandbox:true`** (`main.ts:302–306`) | **Med (High as DiD)** | — | A renderer compromise runs in an un-hardened OS process against a huge `api` surface |
| **NXM** | **`nxm://` → download+auto-install with no consent gate** (`main.ts:355–381`) | **High** | Med | Any web page forces attacker-chosen download/extract + consumes premium quota |
| **BUILD-LOCK** | **Lockfile ↔ `package.json` mismatch** (`better-sqlite3 ^11` vs locked 9.6.0; `electron ^33` vs locked 29.4.6) — `npm ci` refuses; builds float via `npm install` | **High** | High (any clean build) | Non-reproducible artifact; lock's SRI/pinning guarantees void |
| **BUILD-SIGN** | **No Authenticode signing** (`win.signAndEditExecutable:false`, no cert config) | **High** | Med | Unsigned installer/`.exe` for an app that writes native code & spawns; swapped installer undetectable |
| **BIN** | **Unverified native 7-Zip in writable location** — in-repo `resources/7zip-full/7z.exe`+`7z.dll`, spawned after only a banner-string check; user-relocatable install dir | **Med-High** | Low-Med | DLL/binary planting of `7z.dll`/`.node` |
| **EXEC-PATH** | **Bare-name OS helpers** `reg`/`tasklist`/`wscript.exe` (`steam/detect.ts:28,73`; `launcherService.ts:134`) resolvable from app-dir/CWD; run automatically during Steam auto-detect | **High** | Low-Med | PATH/CWD hijack with no user interaction |
| **AUTODETECT** | **Auto-detect trusts broad, user-writable roots**, first-match by name, auto-persists (`autoDetect.ts:128–131`; `pandora.ts:15,78` regex `/pandora.*\.exe$/i`; `main.ts:560`) | **High** | Low-Med | Drive-by exe in Downloads/`C:\pandora` → auto-registered → spawned |
| **BOMB** | **Archive-bomb / disk exhaustion** — fixed 2.5× estimate, fail-open free-space probe (returns `Infinity`), pre-flight TOCTOU under 8× concurrency, no runtime cap/watchdog (`diskSpace.ts:21,59`; `installer.ts:229–238`) | **Med** | Med | Volume exhaustion mid-extract; DoS |
| **ADMZIP** | **`adm-zip` fallback parses untrusted zip on the main thread**, synchronous, compressed-size-only cap (`extract.ts:152–181`) | **Med** | Low-Med | ≤256 MB zip bomb → main-process OOM / UI freeze |
| **ROLLBACK** | **No freshness/expiry** — only a local monotonic counter; `published_at` never checked; fresh install starts at 0 (`manifest.ts:70–74`; `service.ts:69–75`) | **Med** | Med | Rollback-to-older-signed / freeze on known-vulnerable manifest |
| **HASH-OPT** | **Manifest `file_hash` never asserted present** (`manifest.ts:19,70–82`) — flows to the same optional `if(fileHash)` gate | **Med** | Low-Med | Signed metadata not actually bound to bytes when field absent |
| **NEXUS-ID** | **`nexus:get-mod` interpolates unvalidated `nexusId` into a secret-bearing `axios.get`** (`main.ts:1221–1233`), bypassing `fetchSignedJson`; default redirect-following can replay the `apikey` header | **Med** | Med | Renderer steers request path on Nexus host with user's premium key |
| **SECRET-DISK** | **Plaintext `secrets/nexus.key` persists** (88 bytes) despite being documented as decommissioned/to-be-rotated | **Med** | Med | Live credential readable by any same-user process/backup/sync agent |
| **CSP** | **`img-src 'self' data: https:`** wide-open exfil channel; no `base-uri`/`object-src`/`form-action`; header-only (no `<meta>` backstop) (`main.ts:279–287`) | **Med** | Med | Beacon exfil defeats `connect-src` lockdown; possible no-CSP prod renderer (verify on shipped build) |
| **OPEN-EXT** | **Loose `startsWith('http')` in window/nav handlers** vs strict `/^https?:\/\//i` in `fs:open-external` (`main.ts:318,326` vs 1295) | **Med** | Low-Med | `httpx://…`-style schemes handed to OS shell |
| **FS-ORACLE** | **`fs:read-dir` / `fs:exists` unrestricted whole-disk oracle** (`main.ts:1268,1272`) | **Med** | Med | Recon; the plant-then-open half of A3 |
| **VALIDATE-ORACLE** | **`nexus:validate-key` unthrottled auth oracle** for renderer-supplied keys (`main.ts:1237–1248`) | **Low-Med** | Med | Credential-stuffing amplifier via trusted main process |
| **ARGV** | **7-Zip argv lacks `--` end-of-switches** (`extract.ts:111–114`); nexus recipes aren't signature-bound | **Low-Med** | Low | Argument-injection into extractor via `-`-leading patterns/paths |
| **ARG-VALIDATION** | **Zero runtime arg validation across the bridge** (systemic; `preload.ts:3`) | **Med (systemic)** | Med | DoS via unhandled rejection on hostile shapes; missing DiD before spawn/fs/store sinks |
| **SIGN-KEY** | **Signer accepts plaintext private key** (warns, proceeds; `sign_manifest.py:102–114`); env passphrase exposed to child processes; deferred ACL lockdown; weak PBKDF2 defaults (`protect_release_key.mjs:92,95`) | **Med-Low** | Low | Producer-side signing-key exposure |

*(Non-findings already ruled out by subsystem leads — do **not** re-report: the `download_url` regex is `^https://`-anchored with required trailing `/` so `@`/suffix host-spoofs fail; JS↔Python canonicalization is byte-compatible; SQL identifier injection is blocked by `pickColumns` whitelists; `.env` is not auto-loaded (no `dotenv`); `secrets/` is excluded from the electron-builder `files` allow-list; the preload `on/off` event whitelist is correct.)*

---

## 5. Least-Privilege Review

**The renderer holds far more authority than its role requires.** It legitimately needs to read state, set a bounded set of UI/path preferences *through trusted dialogs*, and subscribe to events. Instead it can:

- **Name any executable the main process spawns** — via unrestricted `settings:set` (A1) *and* via a path argument `tools:validate-7z` never needed (A2). This is the single most important LP violation: it defeats the entire "resolve paths main-side" design. The exec-target set should be **closed and main-controlled**; path selection belongs behind an explicit main-side file dialog, not a generic key/value write primitive.
- **Open/execute any absolute path** (`fs:open-path`, A3) and **read any directory / test any path** (`fs:read-dir`/`fs:exists`, FS-ORACLE) when the app only ever operates within `userData`, the mods root, StockGame, and user-picked directories. `openPath` is a raw OS-execution primitive handed to the least-trusted component.
- **Authenticate to Nexus with an arbitrary key** (VALIDATE-ORACLE) when it only needs "validate the *stored* key."
- **Inject pre-formed signed blobs and choose fetch targets** (`delta:ingest`, `delta:ingest-url`, `catalog:update/seed`) — the main process delegates "what URL / what artifact" to the lowest-trust component; the allow-list narrows but does not remove that authority, and the in-IPC object path skips the size cap entirely.

**The verifier accepts its own trust anchor from a channel less privileged than the thing it protects.** `pinnedKey.ts:12` reads the root public key — plus host allow-lists and source URL — from user-writable `process.env` (PIN). A pin must be immutable at runtime; rotation belongs to a signed/rebuilt artifact, never an env var. Similarly, anti-replay/current-version state lives in the general-purpose SQLite DB with no tamper-evident separation from ordinary app state (ROLLBACK).

**Spawned children inherit full ambient authority.** No `env` scrubbing on the 7-Zip child (it inherits every parent env var, including any secrets present), no CWD pinning on the `validate-7z` spawn (DLL-plant surface), no job-object/`windowsHide` confinement of launched tools. The detached game spawn is intentional for SKSE; every *tool* spawn also running with the manager's full session token is not.

**Safety and provenance controls that default *open* instead of *closed*.** `getFreeSpace` returns `Infinity` on probe failure (BOMB) — a guard that disables itself. `settings:get-all` returns the entire store to the renderer, safe only incidentally because `nexusApiKey` is today the lone masked key. The build ships an in-repo 7-Zip binary outside the lockfile's integrity boundary (BIN) and an unsigned artifact with no first-install authenticity anchor (BUILD-SIGN), while granting install-time full trust to the entire 712-package graph despite only 4 packages needing build scripts.

---

## 6. Prioritized Mitigation Roadmap

### P0 — Close the renderer→RCE keystone chain (do first; these are the ones that turn XSS into code execution)
1. **Lock down `settings:set`** (A1): enforce an allow-list of renderer-settable keys, and **reject all executable-path and FS-root keys over IPC entirely** — those must be set only by a main-side native file/folder picker. This is the highest-leverage single fix; it restores the "renderer never supplies executables" invariant the codebase already believes it has.
2. **Stop `tools:validate-7z` from spawning renderer input** (A2): validate identity (extension + signature/known-path) *before* any `spawn`, or drop the `configured` argument and validate only the main-resolved candidate.
3. **Confine `fs:open-path`** (A3): restrict to app-owned roots and a safe extension allow-list; reuse the strict validator already present on `fs:open-external`. Apply the same strict `/^https?:\/\//i` check to the window-open/navigation handlers (OPEN-EXT).
4. **Pin navigation to the exact app document** (NAV): replace `startsWith('file://')` / dev origin-prefix with an exact-URL match; block the preload from re-injecting on any other document.
5. **Set `sandbox:true`** on the renderer (SANDBOX) — one line, large blast-radius reduction.
6. **Make the pinned key immutable** (PIN): remove the `NOLVUS_MANIFEST_PUBKEY` env override (and env-driven host/URL overrides), or require the override itself to be signed by the embedded key. Rotation ships as a rebuilt artifact.
7. **Make integrity verification fail-closed** (INTEG + HASH-OPT): require a non-empty `file_hash`/`expectedHash` for *every* extract path; refuse to extract when it is absent. Assert `file_hash` presence in `verifyManifest`.
8. **Fix the build's reproducibility + authenticity floor** (BUILD-LOCK + BUILD-SIGN): reconcile `package.json` with the lockfile so `npm ci` succeeds and the *shipped* artifact is the *audited* one; add Authenticode signing (cert or Azure Trusted Signing). Without BUILD-LOCK, every other finding is against code that may not be what ships.

### P1 — Harden the transport, exec-resolution, and update-freshness gaps
9. **Add SSRF/redirect/proxy hardening to bulk downloads** (A-SSRF): `maxRedirects:0` (or per-hop host re-validation), host allow-list on the resolved URI, controlled proxy behavior — bring `axiosGet` to parity with `fetchSignedJson`.
10. **Absolute-path the OS helpers** (EXEC-PATH): call `reg`/`tasklist`/`wscript.exe` from `%SystemRoot%\System32` by full path.
11. **Strengthen launch-target identity** (A4) and **auto-detect** (AUTODETECT): verify publisher signature / known-good path rather than filename suffix; drop root-of-drive and Downloads/Desktop/Documents from trusted roots, tighten the `pandora` regex, and require explicit user confirmation before persisting any auto-discovered exe.
12. **Route `nexus:get-mod` through the hardened transport and validate `nexusId`** (NEXUS-ID); disable redirect-following on any secret-bearing request.
13. **Add freshness to the update engine** (ROLLBACK): a signed max-age / "latest version" proof and a wall-clock check on `published_at`; do not accept an older-signed release on a fresh (counter=0) install without a freshness proof.
14. **Verify the in-repo 7-Zip binary** (BIN): record and check a pinned SHA-256 (and ideally Authenticode) before spawn; consider installing to a non-user-writable location or dropping the committed blob in favor of the lockfile-governed `7zip-bin`.
15. **Add a `<meta>` CSP backstop and tighten the policy** (CSP): confirm the header attaches to the packaged `file://` main frame; narrow `img-src`, add `base-uri 'self'`, `object-src 'none'`, `form-action 'none'`.
16. **Gate `nxm://` behind user confirmation** (NXM) before it touches the download/install pipeline and the premium key.
17. **Rotate and delete `secrets/nexus.key`** (SECRET-DISK) — the remediation is already documented; perform it.

### P2 — Systemic defense-in-depth and provenance hygiene
18. **Add runtime schema/bounds validation at the IPC boundary** (ARG-VALIDATION) before values reach spawn/fs/store sinks — the `EVENT_CHANNELS` whitelist is the model to generalize.
19. **Contain resource-exhaustion in extraction** (BOMB + ADMZIP + ARGV): make `getFreeSpace` fail *closed*, add a runtime uncompressed-bytes cap and a stall/timeout watchdog on the 7-Zip run, reserve space under concurrency, move the `adm-zip` fallback off the main thread (or cap on *uncompressed* size), append `--` to 7-Zip argv, and bound retained stderr.
20. **Reduce spawn ambient authority**: pass a scrubbed `env` to child processes, pin CWD on all spawns, and confine launched tools (job object / `windowsHide`).
21. **Strengthen cache-reuse trust** (from download-install R5): require a hash match, not size-only, and never accept an arbitrary file when `total_size` is unknown.
22. **Throttle the auth oracle** (VALIDATE-ORACLE) and the in-IPC ingest paths (rate-limit + size cap).
23. **Supply-chain hardening**: add `.npmrc` with `ignore-scripts` + an install-script allow-list for the 4 legitimate packages, pin exact versions, wire an `npm audit`/CI gate, and record provenance/checksums for all committed native binaries.
24. **Producer-side signing hygiene** (SIGN-KEY): make the signer fail-closed on an unencrypted key, move the passphrase to a scoped/one-shot handle, set owner-only ACLs at key-file creation (not a printed manual step), and raise the PBKDF2 iteration count.

**Sequencing note for SONNET:** audit P0 items first and hardest — they share the same root (the renderer's authority over exec targets and the update trust anchor) and are where a single confirmed exploit chain will be found. **A1 is the keystone; verify it and its two siblings (A2, A3) line-by-line before anything else.** Everything downstream assumes BUILD-LOCK is resolved so the audited tree equals the shipped tree.

---

## 8. Re-validation of SONNET's applied changes (OPUS sign-off)

Per the board protocol, OPUS re-validates every architectural change SONNET applied. Verdict on each:

| Change | Architectural verdict |
|---|---|
| `settings:set` flat-identifier key guard | **Approved.** Closes the dotted-key / config-clobber vector without removing the renderer's ability to persist its own UI/config keys — the non-breaking form HAIKU required. |
| `toolPath()` per-tool basename allow-list + `detect7zPath` 7-Zip basename gate | **Approved — this is the keystone (A1) mitigation.** Enforcement moved to the *spawn sink*, so the "renderer picks WHICH tool, never WHAT exe" invariant is now actually true in code, not just in a comment. Residual: an attacker who can both plant a file named e.g. `modorganizer.exe` AND set the path still passes; acceptable given the renderer has no file-write primitive. |
| `tools:validate-7z` pre-spawn identity gate | **Approved (A2).** Removes the single-IPC arbitrary-exe launch. |
| CSP lockdown (object-src/base-uri/form-action/frame-ancestors none) + permission handlers deny-all + `sandbox:true` | **Approved.** Shrinks the renderer's ambient authority to the vetted IPC surface only. NOTE: these three are Electron-runtime behaviors not exercised by the unit suite — require a manual app smoke-test before release. |
| `assertSafeDirectUrl` (https-only + internal-host block) | **Approved.** Closes the renderer→main SSRF-to-localhost primitive and plaintext-MITM on direct URLs; the signed delta path (GitHub, https) is unaffected. |
| `downloads:list` column allow-list (drops nxm_key/expires) | **Approved.** The short-lived download token no longer crosses the IPC boundary. |
| `sanitizePathSegment` hardening (dot-only / reserved-name / trailing-dot) | **Approved.** Removes the one-level directory-escape from a renderer-supplied profile name. |
| `pinnedKey` env-override gated to dev/test/ci | **Approved.** The trust anchor is now immutable in shipped builds. Production key rotation MUST move to a signed rotation mechanism (tracked P1). |
| Absolute System32 paths for reg/tasklist/wscript | **Approved.** Removes the PATH/CWD binary-planting surface. |
| adm-zip uncompressed-size bomb cap; logger control-char sanitize | **Approved.** Bounds two DoS/forgery vectors. |

**Overall architecture verdict after this cycle:** the confidentiality and cryptographic boundaries were already sound; the exec/path-resolution boundary — the structural weakness this review was called to find — is now **enforced at the sink**, moving the app from "porous by construction" to "defense-in-depth, gated behind a renderer compromise that has no confirmed sink today." The remaining open items (update freshness/rollback, mandatory hash-gating on the ordinary download path, IPC arg-schema validation, code-signing, lockfile↔manifest sync) are **P1/P2 and do not block**, but the trust-anchor and integrity gates should be closed before a production release that ships the real signing/update infrastructure. No change SONNET applied lowered an existing control or introduced a new architectural risk.
