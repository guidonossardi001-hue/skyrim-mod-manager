// Pure anti-rollback / freshness logic, shared by BOTH signed artifacts (the delta
// release manifest and the reference mod catalog). Each artifact carries a monotonic
// counter (release_counter / catalog_version) AND a signed timestamp (published_at /
// generated_at). Rollback protection requires BOTH to be non-regressing — an attacker who
// finds a way past the counter is still blocked by the timestamp, and vice versa.
//
// Electron-free & side-effect-free so every branch is unit-testable in isolation.

export interface FreshnessBaseline {
  lastCounter: number // highest counter/version already accepted (0 on a fresh install)
  lastPublishedAt: string | null // timestamp of the last accepted artifact (null on fresh install)
}

export interface FreshnessCandidate {
  counter: number
  publishedAt: string
}

// Build-time pinned minimum (the release SHIPPED in this build). Folded into the baseline so
// even the FIRST ingest on a fresh install cannot be rolled back below what shipped (TOFU).
export interface FreshnessFloor {
  counter: number
  publishedAt: string | null
}

export interface FreshnessOptions {
  now?: number // when set, enables the future-skew guard
  maxFutureSkewMs?: number // default 48h
  counterLabel?: string // 'counter' | 'version' for readable messages
}

export type FreshnessResult = { ok: true } | { ok: false; reason: string }

const DEFAULT_MAX_FUTURE_SKEW_MS = 48 * 60 * 60 * 1000

/** Parse an ISO-ish timestamp to epoch ms, or null if unparseable. */
export function parseTimestamp(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * A rollback-resistant "now" for the future-skew guard. The wall clock (Date.now) can be rolled
 * BACK by an attacker/user, which would make legitimately-newer releases look "too far future" and
 * freeze all updates (a DoS that also sustains an existing downgrade). The last accepted release's
 * published_at is a signed lower bound on real time, so never let effective-now fall below it.
 */
export function monotonicNow(wallNowMs: number, lastPublishedAt: string | null): number {
  return Math.max(wallNowMs, parseTimestamp(lastPublishedAt) ?? 0)
}

/**
 * Fold the build-time floor into the DB baseline: the effective baseline is the HIGHER of the
 * two on each axis (counter = max; published_at = the later timestamp). So a fresh install
 * (empty DB) inherits the shipped floor, and an up-to-date install keeps its own higher values.
 */
export function effectiveBaseline(db: FreshnessBaseline, floor: FreshnessFloor): FreshnessBaseline {
  const lastCounter = Math.max(db.lastCounter, floor.counter)
  const dbTs = parseTimestamp(db.lastPublishedAt)
  const flTs = parseTimestamp(floor.publishedAt)
  let lastPublishedAt: string | null
  if (dbTs != null && flTs != null) lastPublishedAt = dbTs >= flTs ? db.lastPublishedAt : floor.publishedAt
  else lastPublishedAt = db.lastPublishedAt ?? floor.publishedAt ?? null
  return { lastCounter, lastPublishedAt }
}

/**
 * The anti-rollback verdict, fail-closed:
 *   • counter must be an integer STRICTLY greater than the baseline (primary anti-rollback);
 *   • published_at must be parseable and NOT older than the baseline timestamp (independent
 *     anti-rollback; equal is allowed so two same-day releases with an advancing counter pass);
 *   • with `now` set, a published_at beyond now+skew is rejected (a tampered far-future stamp
 *     must not poison the baseline and block later legitimate releases).
 * On a fresh install (baseline.lastPublishedAt === null) only the counter/parse checks apply.
 */
export function checkFreshness(
  cand: FreshnessCandidate,
  baseline: FreshnessBaseline,
  opts: FreshnessOptions = {},
): FreshnessResult {
  const label = opts.counterLabel ?? 'counter'

  if (typeof cand.counter !== 'number' || !Number.isInteger(cand.counter)) {
    return { ok: false, reason: `${label} mancante o non intero` }
  }
  if (cand.counter <= baseline.lastCounter) {
    return { ok: false, reason: `replay/downgrade: ${label} ${cand.counter} <= ${baseline.lastCounter}` }
  }

  const ts = parseTimestamp(cand.publishedAt)
  if (ts == null) return { ok: false, reason: 'published_at mancante o non valido' }

  const lastTs = parseTimestamp(baseline.lastPublishedAt)
  if (lastTs != null && ts < lastTs) {
    return { ok: false, reason: `downgrade: published_at ${cand.publishedAt} anteriore a ${baseline.lastPublishedAt}` }
  }

  if (opts.now != null) {
    const skew = opts.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS
    if (ts > opts.now + skew) {
      return { ok: false, reason: `published_at ${cand.publishedAt} nel futuro oltre la tolleranza (possibile manomissione)` }
    }
  }

  return { ok: true }
}
