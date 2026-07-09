// Minimal Valve KeyValues (VDF) parser — enough for libraryfolders.vdf and
// appmanifest_*.acf. Pure, no deps, fully unit-testable.

export interface VdfNode {
  [key: string]: string | VdfNode
}

export function parseVdf(text: string): VdfNode {
  let i = 0
  const n = text.length

  function skipWs(): void {
    while (i < n) {
      if (/\s/.test(text[i])) {
        i++
        continue
      }
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++
        continue
      }
      break
    }
  }

  function readToken(): string {
    skipWs()
    if (i >= n) return ''
    if (text[i] === '{' || text[i] === '}') return text[i++]
    if (text[i] === '"') {
      i++
      let s = ''
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          s += text[i + 1]
          i += 2
        } else s += text[i++]
      }
      i++ // closing quote
      return s
    }
    let s = ''
    while (i < n && !/\s/.test(text[i]) && text[i] !== '"' && text[i] !== '{' && text[i] !== '}')
      s += text[i++]
    return s
  }

  function parseObject(): VdfNode {
    const obj: VdfNode = {}
    while (i < n) {
      skipWs()
      if (i >= n || text[i] === '}') {
        i++
        break
      }
      const key = readToken()
      if (key === '}' || key === '') break
      skipWs()
      if (text[i] === '{') {
        i++
        obj[key] = parseObject()
      } else {
        obj[key] = readToken()
      }
    }
    return obj
  }

  skipWs()
  const rootKey = readToken()
  skipWs()
  if (text[i] === '{') {
    i++
    return { [rootKey]: parseObject() }
  }
  return {}
}

/** Extract library root paths from libraryfolders.vdf (handles old + new formats). */
export function getLibraryPaths(vdf: VdfNode): string[] {
  const root = (vdf.libraryfolders ?? vdf.LibraryFolders) as VdfNode | undefined
  if (!root) return []
  const paths: string[] = []
  for (const [key, val] of Object.entries(root)) {
    if (typeof val === 'string') {
      // legacy format: "1" "D:\\SteamLibrary"
      if (/^\d+$/.test(key) && val) paths.push(normalize(val))
    } else if (val && typeof val === 'object' && typeof val.path === 'string') {
      // new format: "1" { "path" "D:\\SteamLibrary" ... }
      paths.push(normalize(val.path))
    }
  }
  return paths
}

export interface AppManifest {
  appid: number
  name: string | null
  installdir: string | null
}

export function parseAppManifest(text: string): AppManifest | null {
  const vdf = parseVdf(text)
  const state = vdf.AppState as VdfNode | undefined
  if (!state) return null
  const appid = parseInt(String(state.appid ?? ''), 10)
  if (!Number.isFinite(appid)) return null
  return {
    appid,
    name: typeof state.name === 'string' ? state.name : null,
    installdir: typeof state.installdir === 'string' ? state.installdir : null,
  }
}

function normalize(p: string): string {
  return p.replace(/\\\\/g, '\\').replace(/\\/g, '/')
}
