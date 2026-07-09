import type { SqliteDb } from '../db/sqlite'

// nxm:// protocol handling. When a user clicks "Mod Manager Download" on Nexus the
// browser opens a URL like:
//   nxm://skyrimspecialedition/mods/2347/files/12345?key=abc&expires=1719200000&user_id=42
// Premium accounts can resolve the download_link from (mod_id, file_id) alone; the
// `key`+`expires` pair is what authorises a NON-premium (manual) download and is
// short-lived, so it is persisted on the download row and forwarded to the resolver.
// Pure + DB-only (no Electron) → unit-testable.

export interface NxmLink {
  game: string
  modId: number
  fileId: number
  key?: string
  expires?: number
  userId?: number
}

const NXM_RE = /^nxm:\/\/([^/?#]+)\/mods\/(\d+)\/files\/(\d+)(?:[?#](.*))?$/i

/** Parse an nxm:// URL into its mod/file identity (+ optional non-premium key/expires). */
export function parseNxmUrl(raw: string): NxmLink | null {
  if (typeof raw !== 'string') return null
  const m = raw.trim().match(NXM_RE)
  if (!m) return null
  const [, game, modId, fileId, query] = m
  const qs = new URLSearchParams(query ?? '')
  const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined)
  return {
    game: game.toLowerCase(),
    modId: Number(modId),
    fileId: Number(fileId),
    key: qs.get('key') ?? undefined,
    expires: num(qs.get('expires')),
    userId: num(qs.get('user_id')),
  }
}

/** Find the nxm:// argument the OS appended to our process/second-instance argv. */
export function findNxmUrl(argv: readonly string[]): string | null {
  return argv.find((a) => typeof a === 'string' && /^nxm:\/\//i.test(a.trim())) ?? null
}

/**
 * Insert a pending download row for an nxm link (carrying key/expires for the
 * non-premium flow) and return its id. The caller enqueues it into the pipeline.
 */
export function createNxmDownload(
  db: SqliteDb,
  link: NxmLink,
  opts: { profileId: number; name?: string },
): number {
  const mod = db.prepare('SELECT id, name FROM mods WHERE nexus_id=? LIMIT 1').get(link.modId) as
    { id: number; name: string } | undefined
  const name = opts.name ?? mod?.name ?? `Nexus mod ${link.modId} (file ${link.fileId})`
  const res = db
    .prepare(
      "INSERT INTO downloads (mod_id, profile_id, nexus_id, file_id, name, status, nxm_key, nxm_expires) VALUES (?,?,?,?,?, 'pending', ?, ?)",
    )
    .run(
      mod?.id ?? null,
      opts.profileId,
      link.modId,
      link.fileId,
      name,
      link.key ?? null,
      link.expires ?? null,
    )
  return Number(res.lastInsertRowid)
}
