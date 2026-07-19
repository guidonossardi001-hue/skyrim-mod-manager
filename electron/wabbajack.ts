import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { extname } from 'path'
import axios from 'axios'
import Database from 'better-sqlite3'

// wabbajackPath/outputPath arrivano grezzi dal renderer (nessun kind whitelisted come in
// util/openTargets.ts): un renderer compromesso potrebbe passare un path UNC (pull di un
// payload remoto) o un'estensione eseguibile/di avvio come destinazione di scrittura. Qui
// si limita il danno all'estensione attesa, coerente col resto della app (isExecutablePath).
function isUncPath(p: string): boolean {
  return /^\\\\/.test(p) || /^\/\//.test(p)
}

// Wabbajack modlist format (.wabbajack is a renamed zip containing modlist.json)
interface WabbajackManifest {
  Name: string
  Version: string
  Author: string
  Description: string
  Archives: WabbajackArchive[]
  Directives: WabbajackDirective[]
}

interface WabbajackArchive {
  Hash: string
  Name: string
  Size: number
  State: { $type: string; ID?: number; FileID?: number }
}

interface WabbajackDirective {
  Type: string
  To: string
  SourceDataID?: string
}

export function initWabbajack(db: Database.Database) {
  // Parse a .wabbajack file and import its modlist
  ipcMain.handle('wabbajack:parse', async (_e, wabbajackPath: string, profileId: number) => {
    if (isUncPath(wabbajackPath) || extname(wabbajackPath).toLowerCase() !== '.wabbajack') {
      return { success: false, error: 'Percorso non valido: atteso un file .wabbajack locale' }
    }
    if (!existsSync(wabbajackPath)) return { success: false, error: 'File non trovato' }

    try {
      // .wabbajack files are ZIP archives
      const { default: AdmZip } = await import('adm-zip').catch(() => ({ default: null }))
      if (!AdmZip) return { success: false, error: 'adm-zip non installato. Eseguire: npm install adm-zip' }

      const zip = new AdmZip(wabbajackPath)
      const manifestEntry = zip.getEntry('modlist')
      if (!manifestEntry) return { success: false, error: 'modlist non trovata nel file .wabbajack' }

      const manifest: WabbajackManifest = JSON.parse(zip.readAsText(manifestEntry))

      // Map Wabbajack archives to our mod format
      const nexusArchives = manifest.Archives.filter((a) => a.State?.$type?.includes('NexusDownloader'))

      const insertMod = db.prepare(`
        INSERT OR IGNORE INTO mods (profile_id, nexus_id, name, file_size, is_enabled, is_installed, priority, load_order, tags, conflicts, requires, category)
        VALUES (?, ?, ?, ?, 1, 0, 999, 999, '[]', '[]', '[]', 'other')
      `)

      const tx = db.transaction((archives: WabbajackArchive[]) => {
        archives.forEach((a) => {
          const nexusId = a.State?.ID ?? null
          insertMod.run(profileId, nexusId, a.Name.replace(/\.[^/.]+$/, ''), a.Size)
        })
      })
      tx(nexusArchives)

      return {
        success: true,
        name: manifest.Name,
        version: manifest.Version,
        author: manifest.Author,
        totalMods: nexusArchives.length,
        imported: nexusArchives.length,
      }
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Check Wabbajack CDN for available modlists
  ipcMain.handle('wabbajack:browse-modlists', async () => {
    try {
      const res = await axios.get(
        'https://raw.githubusercontent.com/wabbajack-tools/mod-lists/master/modlists.json',
        {
          timeout: 10000,
        },
      )
      // Filter Skyrim SE / AE lists
      const lists = (res.data as Array<Record<string, unknown>>).filter((l) =>
        String(l.game ?? '')
          .toLowerCase()
          .includes('skyrim'),
      )
      return { success: true, lists }
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message, lists: [] }
    }
  })

  // Export current profile as a Wabbajack-compatible manifest stub
  ipcMain.handle('wabbajack:export', async (_e, profileId: number, outputPath: string) => {
    if (isUncPath(outputPath) || extname(outputPath).toLowerCase() !== '.json') {
      return { success: false, error: 'Percorso non valido: atteso un file .json locale' }
    }
    const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(profileId) as Record<string, unknown>
    const mods = db.prepare('SELECT * FROM mods WHERE profile_id=?').all(profileId) as Record<
      string,
      unknown
    >[]

    const manifest = {
      Name: profile.name,
      Version: '1.0.0',
      Author: 'Skyrim AE Mod Manager',
      Description: profile.description ?? '',
      GameType: 'SkyrimSpecialEdition',
      IsNSFW: false,
      Archives: mods
        .filter((m) => m.nexus_id)
        .map((m) => ({
          Hash: '',
          Name: `${m.name}.7z`,
          Size: m.file_size ?? 0,
          State: {
            $type: 'NexusDownloader, Wabbajack.Lib',
            ID: m.nexus_id,
            GameName: 'SkyrimSpecialEdition',
          },
        })),
      Directives: [],
    }

    await writeFile(outputPath, JSON.stringify(manifest, null, 2), 'utf8')
    return { success: true, path: outputPath, modCount: manifest.Archives.length }
  })
}
