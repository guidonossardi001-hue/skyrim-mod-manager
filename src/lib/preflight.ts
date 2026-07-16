import type { AppSettings, Mod } from '@/types'

// Pre-install compatibility checks, the way a modlist installer validates the
// environment before touching anything (Nolvus: game path, not in Program Files,
// Nexus Premium, free space…). Pure over data we already hold so it can be unit
// tested and run in the browser preview; disk-space probing stays best-effort.

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface PreflightCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

export interface PreflightInput {
  settings: AppSettings
  mods: Mod[]
  totalSizeGB: number
  goalGB?: number
}

const FRAMEWORK_KEYWORDS = ['skse', 'address library', 'sse engine fixes']

export function runPreflight({
  settings,
  mods,
  totalSizeGB,
  goalGB = 230,
}: PreflightInput): PreflightCheck[] {
  const checks: PreflightCheck[] = []
  const gamePath = settings.gamePath?.trim() ?? ''

  // 1. Game path configured
  checks.push(
    gamePath
      ? { id: 'game-path', label: 'Cartella Skyrim AE', status: 'ok', detail: gamePath }
      : {
          id: 'game-path',
          label: 'Cartella Skyrim AE',
          status: 'fail',
          detail: 'Percorso non configurato nelle Impostazioni',
        },
  )

  // 2. NOT under Program Files — the classic Skyrim modding pitfall (UAC/virtualization)
  if (gamePath) {
    const inProgramFiles = /program files/i.test(gamePath)
    checks.push({
      id: 'program-files',
      label: 'Posizione gioco sicura',
      status: inProgramFiles ? 'fail' : 'ok',
      detail: inProgramFiles
        ? 'Skyrim è in "Program Files": sposta l\'installazione fuori per evitare problemi di permessi'
        : 'Fuori da Program Files',
    })
  }

  // 3. Install destination — INFORMATIVO, mai un avviso: senza un percorso esplicito le
  // mod vanno nella cartella gestita dall'app, che è il funzionamento normale (e il campo
  // non è impostabile dalle Impostazioni: avvisare di "configurarlo" era un vicolo cieco).
  checks.push({
    id: 'mods-path',
    label: 'Cartella mod (destinazione)',
    status: 'ok',
    detail: settings.modsPath || 'Cartella predefinita gestita dall’app',
  })

  // NB: nessun check su Mod Organizer 2 — il launcher avvia il gioco ESCLUSIVAMENTE via
  // SKSE interno e distribuisce le mod da sé (deploy hardlink + plugins.txt di sistema).
  // MO2 non fa parte di nessun percorso: avvisare che manca era rumore non azionabile.

  // 4. Nexus API key
  checks.push(
    settings.nexusApiKey
      ? { id: 'nexus', label: 'Nexus API Key', status: 'ok', detail: 'Configurata' }
      : {
          id: 'nexus',
          label: 'Nexus API Key',
          status: 'warn',
          detail: 'Assente: download e controllo aggiornamenti limitati',
        },
  )

  // 5. Framework (SKSE / Address Library) present among installed mods
  const hasFramework = mods.some((m) => {
    const n = m.name.toLowerCase()
    return m.is_enabled && FRAMEWORK_KEYWORDS.some((k) => n.includes(k))
  })
  checks.push({
    id: 'framework',
    label: 'Framework base (SKSE)',
    status: hasFramework ? 'ok' : 'warn',
    detail: hasFramework
      ? 'Presente'
      : 'Nessun framework SKSE attivo: la maggior parte delle mod lo richiede',
  })

  // 6. Disk budget (informational)
  const remaining = goalGB - totalSizeGB
  checks.push({
    id: 'disk',
    label: 'Budget spazio',
    status: remaining < 0 ? 'warn' : 'ok',
    detail:
      remaining < 0
        ? `Superato l'obiettivo di ${goalGB} GB`
        : `${totalSizeGB.toFixed(1)} / ${goalGB} GB usati`,
  })

  return checks
}

export function preflightSummary(checks: PreflightCheck[]): {
  ok: number
  warn: number
  fail: number
  ready: boolean
} {
  const ok = checks.filter((c) => c.status === 'ok').length
  const warn = checks.filter((c) => c.status === 'warn').length
  const fail = checks.filter((c) => c.status === 'fail').length
  return { ok, warn, fail, ready: fail === 0 }
}
