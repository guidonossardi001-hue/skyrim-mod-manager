import type { NxmLink } from './nxm'

// In-memory store of nxm:// download requests AWAITING explicit user consent.
//
// The security invariant: an nxm:// link never becomes a real download until the user
// approves it here. handleNxmUrl only ever `add`s a pending request; the download row +
// enqueue happen exclusively in the `nxm:approve` IPC after `take` hands back the request.
// Closing the modal = `reject` = the request is dropped (default-deny). A `cap` bounds how
// many can pile up so a page firing a burst of links can't exhaust memory / the queue.
//
// Pure (no Electron): the token generator is injected, so the whole lifecycle is unit-testable.

export interface PendingNxm {
  token: string
  link: NxmLink
  hasKey: boolean // whether the link carried a non-premium key (for display only)
  name?: string // best-effort resolved mod name (enrichment); undefined until/if resolved
  receivedAt: number
}

/** The subset sent to the renderer — never leak the non-premium `key` to the UI. */
export interface PendingNxmView {
  token: string
  game: string
  modId: number
  fileId: number
  hasKey: boolean
  name?: string
  receivedAt: number
}

export interface NxmConsentOptions {
  genToken: () => string
  cap?: number
}

export type AddResult = { ok: true; token: string } | { ok: false; reason: string }

const DEFAULT_CAP = 20

export class NxmConsentStore {
  private readonly pending = new Map<string, PendingNxm>()
  private readonly genToken: () => string
  private readonly cap: number

  constructor(opts: NxmConsentOptions) {
    this.genToken = opts.genToken
    this.cap = opts.cap ?? DEFAULT_CAP
  }

  /** Register a request awaiting consent. Refused once the cap is reached (anti-flood). */
  add(link: NxmLink, receivedAt: number): AddResult {
    if (this.pending.size >= this.cap) {
      return { ok: false, reason: `troppe richieste in attesa (max ${this.cap})` }
    }
    const token = this.genToken()
    this.pending.set(token, { token, link, hasKey: !!link.key, receivedAt })
    return { ok: true, token }
  }

  /** Attach best-effort metadata (mod name) to a pending request; no-op if already gone. */
  patch(token: string, patch: { name?: string }): void {
    const req = this.pending.get(token)
    if (req && patch.name) req.name = patch.name
  }

  /** UI-safe snapshot of all pending requests, oldest first. Never includes the key. */
  list(): PendingNxmView[] {
    return [...this.pending.values()]
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .map((r) => ({
        token: r.token,
        game: r.link.game,
        modId: r.link.modId,
        fileId: r.link.fileId,
        hasKey: r.hasKey,
        name: r.name,
        receivedAt: r.receivedAt,
      }))
  }

  /** Approve: remove and RETURN the request (the only path that leads to a download). */
  take(token: string): PendingNxm | null {
    const req = this.pending.get(token) ?? null
    if (req) this.pending.delete(token)
    return req
  }

  /** Reject/drop a request without downloading. Returns whether it existed. */
  reject(token: string): boolean {
    return this.pending.delete(token)
  }

  size(): number {
    return this.pending.size
  }
}
