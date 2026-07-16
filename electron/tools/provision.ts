import { join, basename, dirname } from 'path'

// Provisioning automatico degli strumenti di modding dalle RELEASE UFFICIALI GitHub
// (fix "far funzionare al 100%": LOOT/SSEEdit/xLODGen non installati sulla macchina →
// la pagina Percorsi resta vuota e le feature che li orchestrano sono monche).
//
// Fonti FISSE e ufficiali (mai input utente → niente injection su owner/repo):
//   • LOOT     → github.com/loot/loot            (asset loot_<ver>-win64.7z)
//   • SSEEdit  → github.com/TES5Edit/TES5Edit    (asset xEdit.<ver>.7z; l'exe xEdit adatta
//                 il comportamento al NOME file → alias SSEEdit64.exe, pratica standard)
//   • xLODGen  → github.com/sheson/xLODGen       (asset xLODGen.<ver>.7z)
// DynDOLOD NON è su GitHub (solo Nexus/dyndolod.info) → fuori da questo modulo.
//
// Difese: URL API costruita da costanti; browser_download_url accettata SOLO se
// https://github.com/<owner>/<repo>/releases/... (l'API non può redirigerci altrove);
// estrazione con l'estrattore atomico esistente (zip-slip già gestito lì).
// PURO: ogni IO iniettato (ProvisionDeps) — unit-testabile senza rete/disco.

export interface GithubAsset {
  name: string
  browser_download_url: string
  size?: number
}

export interface GithubRelease {
  tag_name: string
  assets: GithubAsset[]
}

export interface ToolSource {
  key: 'loot' | 'sseedit' | 'xlodgen'
  label: string
  settingKey: 'lootPath' | 'sseeditPath' | 'xlodgenPath'
  owner: string
  repo: string
  assetPattern: RegExp
  /** Nomi exe accettati dopo l'estrazione, in ordine di preferenza. */
  exeCandidates: string[]
  /** Alias da creare se l'exe trovato non combacia col nome atteso dal launcher. */
  aliasTo?: string
}

export const TOOL_SOURCES: ToolSource[] = [
  {
    key: 'loot',
    label: 'LOOT',
    settingKey: 'lootPath',
    owner: 'loot',
    repo: 'loot',
    assetPattern: /^loot_[\d.]+-win64\.7z$/i,
    exeCandidates: ['LOOT.exe'],
  },
  {
    key: 'sseedit',
    label: 'SSEEdit (xEdit)',
    settingKey: 'sseeditPath',
    owner: 'TES5Edit',
    repo: 'TES5Edit',
    assetPattern: /^xedit\.[\w.]+\.7z$/i,
    // Le release recenti (4.1.5x) shippano xTESEdit*.exe, le vecchie xEdit*.exe:
    // l'exe adatta il gioco al NOME file, quindi l'alias SSEEdit64.exe vale per entrambe.
    exeCandidates: [
      'SSEEdit64.exe',
      'SSEEditx64.exe',
      'SSEEdit.exe',
      'xTESEdit64.exe',
      'xTESEdit.exe',
      'xEdit64.exe',
      'xEdit.exe',
    ],
    aliasTo: 'SSEEdit64.exe',
  },
  {
    key: 'xlodgen',
    label: 'xLODGen',
    settingKey: 'xlodgenPath',
    owner: 'sheson',
    repo: 'xLODGen',
    assetPattern: /^xlodgen\.[\w.]+\.7z$/i,
    exeCandidates: ['xLODGenx64.exe', 'xLODGen64.exe', 'xLODGen.exe'],
  },
]

export function releaseApiUrl(s: ToolSource): string {
  return `https://api.github.com/repos/${s.owner}/${s.repo}/releases/latest`
}

/** Parse difensivo della risposta API: forma inattesa → null, mai throw. */
export function parseRelease(raw: unknown): GithubRelease | null {
  const r = raw as { tag_name?: unknown; assets?: unknown }
  if (!r || typeof r.tag_name !== 'string' || !Array.isArray(r.assets)) return null
  const assets = (r.assets as { name?: unknown; browser_download_url?: unknown; size?: unknown }[])
    .filter((a) => typeof a?.name === 'string' && typeof a?.browser_download_url === 'string')
    .map((a) => ({
      name: a.name as string,
      browser_download_url: a.browser_download_url as string,
      size: typeof a.size === 'number' ? a.size : undefined,
    }))
  return { tag_name: r.tag_name, assets }
}

/** Asset che combacia col pattern E scaricabile SOLO dal dominio release di quel repo. */
export function pickReleaseAsset(release: GithubRelease, s: ToolSource): GithubAsset | null {
  const prefix = `https://github.com/${s.owner}/${s.repo}/releases/`
  return (
    release.assets.find((a) => s.assetPattern.test(a.name) && a.browser_download_url.startsWith(prefix)) ??
    null
  )
}

/**
 * Trova l'exe del tool tra i file estratti (path relativi): match case-insensitive sul
 * basename, preferendo l'ordine dei candidati e, a parità, il path meno profondo.
 */
export function findToolExe(filesRel: string[], exeCandidates: string[]): string | null {
  for (const cand of exeCandidates) {
    const matches = filesRel
      .filter((f) => basename(f).toLowerCase() === cand.toLowerCase())
      .sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length)
    if (matches.length) return matches[0]
  }
  return null
}

export interface ProvisionDeps {
  fetchJson: (url: string) => Promise<unknown>
  downloadFile: (url: string, destPath: string) => Promise<void>
  extract: (archivePath: string, destDir: string) => Promise<unknown>
  listFilesRel: (root: string) => string[]
  copyFile: (from: string, to: string) => void
  mkdirp: (p: string) => void
  rmFile: (p: string) => void
  /** Radice installazioni tool gestite (es. <userData>/tools). */
  toolsRoot: string
  log?: (msg: string) => void
}

export interface ProvisionResult {
  ok: boolean
  key: ToolSource['key']
  label: string
  version?: string
  exePath?: string
  error?: string
}

/** Scarica+estrae+individua l'exe di UN tool. No-throw: sempre un ProvisionResult. */
export async function provisionTool(s: ToolSource, deps: ProvisionDeps): Promise<ProvisionResult> {
  const fail = (error: string): ProvisionResult => ({ ok: false, key: s.key, label: s.label, error })
  try {
    deps.log?.(`${s.label}: interrogo le release GitHub di ${s.owner}/${s.repo}`)
    const release = parseRelease(await deps.fetchJson(releaseApiUrl(s)))
    if (!release) return fail('risposta release GitHub non riconosciuta')
    const asset = pickReleaseAsset(release, s)
    if (!asset) return fail(`nessun asset compatibile nella release ${release.tag_name}`)

    const dlDir = join(deps.toolsRoot, '.dl')
    deps.mkdirp(dlDir)
    const archivePath = join(dlDir, asset.name)
    deps.log?.(`${s.label}: scarico ${asset.name} (${release.tag_name})`)
    await deps.downloadFile(asset.browser_download_url, archivePath)

    const destDir = join(deps.toolsRoot, s.key)
    deps.log?.(`${s.label}: estraggo in ${destDir}`)
    try {
      await deps.extract(archivePath, destDir)
    } finally {
      try {
        deps.rmFile(archivePath)
      } catch {
        /* archivio residuo innocuo in .dl */
      }
    }

    const rel = findToolExe(deps.listFilesRel(destDir), s.exeCandidates)
    if (!rel) return fail('eseguibile non trovato dopo l’estrazione')
    let exePath = join(destDir, rel)

    // xEdit: l'exe cambia gioco in base al nome → l'alias SSEEdit64.exe È la config.
    if (s.aliasTo && basename(exePath).toLowerCase() !== s.aliasTo.toLowerCase()) {
      const aliased = join(dirname(exePath), s.aliasTo)
      deps.copyFile(exePath, aliased)
      exePath = aliased
    }

    deps.log?.(`${s.label} ${release.tag_name} pronto: ${exePath}`)
    return { ok: true, key: s.key, label: s.label, version: release.tag_name, exePath }
  } catch (e) {
    return fail((e as Error).message)
  }
}
