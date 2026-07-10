# SECURITY REVIEW BOARD — HAIKU (Offensive Security & QA)

> Cycle 1 · 2026-07-10 · Target: Skyrim AE Mod Manager (Electron + TypeScript + React)
> HAIKU thinks like an attacker: it tries to build a real exploit chain for each finding, refutes filler, checks each fix for regressions, and hunts for newly-introduced vulnerabilities.

## 1. Executive Summary

Of **51 findings** SONNET raised, HAIKU **confirmed or rated plausible 37** and **refuted 14** (duplicates-of-baseline, non-exploitable, or overstated). Each survivor was tested against this app's real model, not a generic checklist. The single most important attacker insight shaped the whole cycle:

> **There is no confirmed XSS sink in `src/` today.** The renderer loads only local bundled files with contextIsolation on / nodeIntegration off. So every "malicious renderer calls a dangerous IPC" chain requires a *prior* code-execution foothold (an XSS via untrusted mod/catalog HTML, or a malicious dependency). That foothold is **realistic but unproven** — which is why the RCE-class findings are rated High-as-defense-in-depth, not Critical-live-RCE.

The malicious-content premises (crafted archive, poisoned manifest, hostile `nxm://`, malformed JSON) are fully realistic and were weighted accordingly.

## 2. Attack simulations run

| Attack | Result against current code (post-fix) |
|---|---|
| **Malicious mod archive → path traversal (zip-slip)** | Blocked. `assertNoZipSlip` (adm-zip) + 7-Zip containment. Symlink-entry and `--`/argv variants **refuted**. |
| **Zip bomb / archive bomb** | 7-Zip streams (disk-preflight backstop); adm-zip fallback now **capped on declared uncompressed size (FIX 13)**. Residual: no *ratio* guard on the streaming 7-Zip run (P2). |
| **Directory escape via hostile profile/mod name (`..`, `CON`, trailing dot)** | **Was CONFIRMED exploitable → now blocked (FIX 5)**, regression-tested. |
| **Renderer XSS → arbitrary tool spawn (settings:set + launch)** | Foothold unproven; the spawn sink is now **basename-gated (FIX 2/3/4)**, so even post-foothold the arbitrary-exe launch is removed. |
| **Renderer → main-process SSRF (downloads:add http://internal)** | **Was exploitable → now blocked (FIX 6)**: https-only + internal-host reject. |
| **Fake Nexus / malicious update server — forged manifest** | Blocked: pinned Ed25519 + sha256 fail-closed. Env-key-swap bypass **was open → now closed in prod (FIX 15)**. |
| **Rollback / downgrade (replay an old *authentically-signed* release)** | **Still open** — `published_at` never checked (deferred; see §4). |
| **DLL search-order hijack on tool spawn** | **Refuted** for the game/MO2 launch (CWD is pinned). Bare-name `reg/tasklist/wscript` planting **was open → now closed (FIX 12)**. |
| **MITM on secret-bearing Nexus request (redirect steals apikey)** | **Refuted** — client does not follow cross-host redirects on those calls. |
| **Prototype pollution via malicious JSON / mods:add-many** | **Refuted** — `dot-prop@6` blocks `__proto__`/`constructor`; SQL builders column-whitelisted. `settings:set` dotted-key vector **closed (FIX 1)**. |
| **Log forging via crafted mod name** | **Was CONFIRMED → now blocked (FIX 14)**. |
| **Corrupted DB / manifest / oversized archive / malformed metadata** | Handled: integrity check fails closed; `fetchSignedJson` size-caps + rejects redirects; no-throw boundaries hold. |

## 3. Refuted findings (14) — recorded so they are not re-litigated

- Renderer `sandbox:true` absent — *refuted as a standalone issue* (contextIsolation already isolates); SONNET added `sandbox:true` anyway as no-cost hardening.
- `index.html` meta CSP `unsafe-inline` — refuted (header CSP governs; no untrusted script reaches the frame).
- Primary 7-Zip path "no symlink/containment check" — refuted (7-Zip extraction is contained; the claim conflated it with adm-zip).
- `getFreeSpace` "fails open" — refuted (fail-open is intentional and backstopped).
- `axiosGet` "follows redirects / honors proxy with no re-validation" — refuted for the threat as stated.
- Nexus request "follows redirects, leaks apikey" — refuted.
- Anti-replay high-water-mark "in unauthenticated DB" — refuted (local state, local attacker already wins).
- MO2 "filename-suffix regex only" planting — refuted (CWD pinned; combined with FIX 2 now moot).
- `validate-7z` "no pinned cwd → DLL hijack" — refuted.
- 7-Zip argv "lacks `--`" — refuted (paths are controlled, not switch-injectable).
- `catalog:seed` "writes into signed-catalog table" — refuted (separate unsigned table; not a trust bypass).
- `postinstall` + 4 install-script packages — refuted (all are legitimate build tooling).
- `nxm://` machine-wide registration — refuted as a standalone vuln (it is the product's purpose; the *dispatch* hardening is a separate P1 note).
- preload `on/off` listener-leak — refuted (the WeakMap wrapper handles reuse correctly).

## 4. Highest-value residual attack surface (still open after this cycle)

1. **Rollback / update freshness** (`delta/service.ts`) — an authentically-signed OLD release is accepted by a fresh/reset client. **Recommended next:** persist a monotonic high-water mark of `published_at`/release id and reject regressions.
2. **`nxm://` has no consent gate** (`main.ts`) — any website can emit a link that enqueues a download using the stored premium key. Recommend a confirmation prompt before the pipeline touches the key.
3. **`fs:open-path` / `fs:read-dir`** — whole-disk read/enumerate oracle + shell-open (can launch a binary). Confine to app roots; switch the Downloads button to `showItemInFolder`.
4. **Fail-open integrity on the ordinary download path** — a mod with no known hash extracts unverified.
5. **Supply chain** — unsigned installer, lockfile drift, unchecksummed bundled `7z.exe`.

None is a *live* remote-RCE in the current build; all are gated behind a foothold or a producer/infra action.

## 5. Regression & fix-quality verification (QA gate)

HAIKU re-ran the full gate after SONNET's changes. **Every fix was checked for (a) does it actually close the hole, (b) does it break functionality, (c) does it introduce a new vuln.**

```
tsc --noEmit         → clean
eslint               → 0 errors
vitest run           → 417 passed / 417  (410 existing + 7 new sanitizePathSegment cases)
```

Fix-quality notes:
- **FIX 1/2/3** — HAIKU rejected SONNET's *first* drafts ("reject all path keys"; "basename allow-list alone"). The applied versions move enforcement to the spawn sink and keep the Settings save + pick-then-validate flows intact. **Accepted.**
- **FIX 6** — HAIKU rejected a Nexus-only allow-list (would break signed delta downloads from GitHub). The applied https + internal-host guard preserves delta. **Accepted.**
- **FIX 9 (`sandbox:true`, permission handlers, CSP)** — Electron-runtime behaviors **not covered by the unit suite.** ⚠️ **Required before release: a manual app smoke-test** — launch the app, confirm the window renders, downloads/installs run, and no preload/IPC breakage appears in the console. This is the one gap the automated gate cannot close.
- **No new vulnerability introduced** by any applied change; no existing control disabled.

## 6. Overall security status after Cycle 1

**Improved and internally consistent.** The exec/path-resolution boundary — the structural weakness — is now enforced at the sink; the trust anchor is immutable in production; SSRF, token-leak, log-forgery, path-escape, and binary-planting vectors are closed. Remaining known risks are **P1/P2, non-blocking for the current (Nexus-disabled, mock-provider) posture**, but the rollback/freshness and mandatory-hash gates should close before a release that ships live signing/update infrastructure. **Cycle verdict: no known *live* vulnerability remains in the audited paths; the open items are defense-in-depth and provenance hardening, tracked in OPUS's roadmap.**
