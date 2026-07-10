// Pure modlist compatibility analyzer (renderer + tests). Parses MO2/Skyrim load
// files and produces a structured report: missing deps, version drift, ESL/ESP/ESM
// classification + load-order limit, SKSE / Address Library / DynDOLOD presence,
// and xEdit-cleaning advisories. No DOM, no DB, no Electron — fully unit-testable.

import { parseRequires, LOAD_ORDER_LIMIT, LOAD_ORDER_WARN } from './modUtils'

export type Severity = 'error' | 'warning' | 'info'
export type PluginType = 'ESM' | 'ESP' | 'ESL' | 'unknown'

export interface CompatFinding {
  id: string
  severity: Severity
  label: string
  detail: string
}

export interface CompatMod {
  name: string
  version: string | null
  requires: string
  is_enabled: 0 | 1
  category: string
  nexus_id: number | null
}

export interface CompatInput {
  mods: CompatMod[]
  latestVersions?: Record<number, string> // nexus_id → latest version (provider)
  plugins?: { name: string; enabled: boolean }[]
}

export interface CompatReport {
  findings: CompatFinding[]
  pluginCounts: { esm: number; esp: number; esl: number; unknown: number }
  totals: { error: number; warning: number; info: number }
  ok: boolean
}

// Full analysis surfaced to the UI: runtime/SKSE version (T5) + plugins.txt-based
// modlist report (T3). Produced by the Electron `compat:analyze` engine and by the
// browser mock with the same shape so the page is engine-agnostic.
export interface CompatAnalysis {
  skyrim: { version: string | null; installed: boolean }
  skse: {
    present: boolean
    version: string | null
    gameVersion: string | null
    gameVersionSupported: boolean | null
  }
  report: CompatReport
  pluginSource: 'plugins.txt' | 'derived' | 'none'
  pluginCount: number
}

const OFFICIAL_MASTERS = ['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm']

export function classifyPlugin(name: string): PluginType {
  const n = name.toLowerCase().trim()
  if (n.endsWith('.esm')) return 'ESM'
  if (n.endsWith('.esl')) return 'ESL'
  if (n.endsWith('.esp')) return 'ESP'
  return 'unknown'
}

/** MO2/Skyrim plugins.txt: `*Name.esp` = active, `Name.esp` = present-inactive, `#` = comment. */
export function parsePluginsTxt(content: string): { name: string; enabled: boolean }[] {
  const out: { name: string; enabled: boolean }[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const enabled = line.startsWith('*')
    const name = line.replace(/^\*/, '').trim()
    if (name) out.push({ name, enabled })
  }
  return out
}

/** loadorder.txt: plugin names in order, one per line. */
export function parseLoadOrderTxt(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

function numTuple(v: string | null): number[] {
  return (String(v ?? '').match(/\d+/g) ?? []).map((n) => parseInt(n, 10))
}
function isNewer(candidate: string | null, current: string | null): boolean {
  const a = numTuple(candidate),
    b = numTuple(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

export function analyzeModlist(input: CompatInput): CompatReport {
  const findings: CompatFinding[] = []
  const enabled = input.mods.filter((m) => m.is_enabled)
  const lnames = enabled.map((m) => m.name.toLowerCase())
  const has = (kw: string) => lnames.some((n) => n.includes(kw))

  // 1. Missing dependencies
  for (const m of enabled) {
    for (const req of parseRequires(m.requires)) {
      const r = req.toLowerCase()
      if (!lnames.some((n) => n.includes(r))) {
        findings.push({
          id: `missing-dep:${m.name}:${req}`,
          severity: 'error',
          label: `Dipendenza mancante: ${req}`,
          detail: `"${m.name}" richiede "${req}" che non è attiva`,
        })
      }
    }
  }

  // 2. Frameworks
  if (!has('skse'))
    findings.push({
      id: 'skse',
      severity: 'warning',
      label: 'SKSE non rilevato',
      detail: 'La maggior parte delle mod richiede SKSE64',
    })
  if (has('skse') && !has('address library'))
    findings.push({
      id: 'addrlib',
      severity: 'warning',
      label: 'Address Library non rilevata',
      detail: 'Richiesta da quasi tutti i plugin SKSE moderni',
    })
  if (has('dyndolod'))
    findings.push({
      id: 'dyndolod',
      severity: 'info',
      label: 'DynDOLOD attivo',
      detail: 'Rigenera i LOD dopo modifiche al mondo/alberi',
    })

  // 3. Version drift (obsolete mods)
  if (input.latestVersions) {
    for (const m of enabled) {
      if (m.nexus_id == null) continue
      const latest = input.latestVersions[m.nexus_id]
      if (latest && isNewer(latest, m.version)) {
        findings.push({
          id: `outdated:${m.nexus_id}`,
          severity: 'warning',
          label: `Aggiornamento disponibile: ${m.name}`,
          detail: `${m.version ?? '?'} → ${latest}`,
        })
      }
    }
  }

  // 4. Plugin classification + load-order limit
  const counts = { esm: 0, esp: 0, esl: 0, unknown: 0 }
  let dlcMasterPresent = false
  for (const p of input.plugins ?? []) {
    if (!p.enabled) continue
    const t = classifyPlugin(p.name)
    if (t === 'ESM') counts.esm++
    else if (t === 'ESP') counts.esp++
    else if (t === 'ESL') counts.esl++
    else counts.unknown++
    if (OFFICIAL_MASTERS.includes(p.name.toLowerCase()) && p.name.toLowerCase() !== 'skyrim.esm')
      dlcMasterPresent = true
  }
  // ESL files are light and don't consume a standard load-order slot.
  const fullSlots = counts.esm + counts.esp
  if (fullSlots > LOAD_ORDER_LIMIT) {
    findings.push({
      id: 'loadorder-limit',
      severity: 'error',
      label: 'Limite load order superato',
      detail: `${fullSlots} plugin ESP/ESM attivi (max ${LOAD_ORDER_LIMIT}). Converti alcuni in ESL.`,
    })
  } else if (fullSlots > LOAD_ORDER_WARN) {
    findings.push({
      id: 'loadorder-near',
      severity: 'warning',
      label: 'Vicino al limite load order',
      detail: `${fullSlots}/${LOAD_ORDER_LIMIT} slot ESP/ESM usati`,
    })
  }

  // 5. xEdit cleaning advisory on official DLC masters
  if (dlcMasterPresent) {
    findings.push({
      id: 'xedit-clean',
      severity: 'info',
      label: 'Pulizia xEdit consigliata',
      detail: 'I master DLC ufficiali andrebbero puliti con SSEEdit (QuickAutoClean)',
    })
  }

  const totals = {
    error: findings.filter((f) => f.severity === 'error').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  }
  return { findings, pluginCounts: counts, totals, ok: totals.error === 0 }
}
