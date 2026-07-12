import { useAppStore } from '@/store/appStore'
import {
  Package,
  Download,
  AlertTriangle,
  HardDrive,
  Play,
  Zap,
  CheckCircle,
  Clock,
  TrendingUp,
  Shield,
  Swords,
  Sparkles,
  XCircle,
  ShieldCheck,
  Terminal,
  Rocket,
  Trash2,
} from 'lucide-react'
import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { toast } from '@/lib/toast'
import { runPreflight, preflightSummary } from '@/lib/preflight'
import { LaunchPreflight } from '@/components/ui/LaunchPreflight'
import { StockGamePanel } from '@/components/ui/StockGamePanel'
import type { LogLine } from '@/store/appStore'
import type { SyncProgressUI, DiskPreflightUI, DiskErrorUI, PluginBudgetUI } from '@/types'

const DISK_TARGET_GB = 300 // Nolvus-scale modlist target

// GB formatter safe per valori non-finiti: getFreeSpace ritorna Infinity su un volume non
// sondabile — mai renderizzare "Infinity GB" / "-Infinity GB" all'utente.
const fmtGB = (b: number | undefined | null): string =>
  typeof b === 'number' && Number.isFinite(b) ? (b / 1024 ** 3).toFixed(1) : '—'

// Human ETA: 45s / 12m 30s / 2h 05m
function fmtEta(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`
}

const CATEGORY_COLORS: Record<string, string> = {
  framework: '#7d4dff',
  visuals: '#4d7dff',
  character: '#ff80cc',
  npc: '#ff6a2e',
  gameplay: '#4de0ff',
  combat: '#ff4500',
  animation: '#ffb84d',
  audio: '#4dffaa',
  quest: '#a855f7',
  world: '#22c55e',
  lore: '#f59e0b',
  ui: '#06b6d4',
  performance: '#84cc16',
  adult: '#ec4899',
  translation: '#6366f1',
  patch: '#94a3b8',
  tool: '#64748b',
  other: '#475569',
}

export default function Dashboard() {
  const {
    mods,
    downloads,
    conflicts,
    profiles,
    activeProfileId,
    settings,
    setActivePage,
    activityLog,
    pushLog,
    clearLog,
    vortexStats,
    loadVortexStats,
    updateSettings,
  } = useAppStore()
  const profile = profiles.find((p) => p.id === activeProfileId)
  const [showPreflight, setShowPreflight] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgressUI | null>(null)
  const [diskPf, setDiskPf] = useState<DiskPreflightUI | null>(null)
  const [diskError, setDiskError] = useState<DiskErrorUI | null>(null)
  const [pluginBudget, setPluginBudget] = useState<PluginBudgetUI | null>(null)
  const [pandora, setPandora] = useState<{
    exeFound: boolean
    exePath: string | null
    path: string | null
  } | null>(null)
  // Run-Prog: dimensione del blocco progressivo (prossime N mod non ancora
  // sincronizzate). 0 = intera modlist in un unico run.
  const [blockSize, setBlockSize] = useState(100)
  const autoRan = useRef(false)

  const occupiedGB = (vortexStats?.totalBytes ?? 0) / 1024 / 1024 / 1024
  const uniqueMods = vortexStats?.uniqueMods ?? 0

  // ── Sync pipeline — REAL mass download into the isolated StockGame ────────────
  // Gated: explicit click (or opt-in auto-start) + a scale-aware confirmation, since
  // this downloads/extracts the whole modlist (~329 GB) ONLY into StockGame.
  const syncBridge = () =>
    typeof window !== 'undefined'
      ? (window.api as unknown as {
          sync?: {
            start(o?: {
              concurrency?: number
              limit?: number
            }): Promise<{
              ok: boolean
              total?: number
              stockGameDir?: string
              error?: string
              disk?: DiskErrorUI
            }>
            cancel(): Promise<{ ok: boolean }>
          }
        })
      : null

  // Aggregate disk pre-flight (PRECHECK-01, ora unificato col gate PRECHECK-02): fetch del
  // GO/NO-GO per il run PIANIFICATO — con un blocco Run-Prog valuta il solo blocco. Definita PRIMA
  // di runSync perché il branch di blocco la richiama per riallineare la card al banner.
  const refreshPreflight = useCallback(() => {
    const api = syncBridge() as unknown as {
      sync?: { preflight?: (o?: { limit?: number }) => Promise<DiskPreflightUI> }
    }
    api?.sync
      ?.preflight?.(blockSize > 0 ? { limit: blockSize } : undefined)
      .then(setDiskPf)
      .catch(() => setDiskPf(null))
  }, [blockSize])
  useEffect(() => {
    refreshPreflight()
    // Il banner di blocco è calcolato per un blocco specifico: cambiare Run-Prog lo rende stale
    // (card verde nuova sotto banner rosso vecchio) — via anche il banner.
    setDiskError(null)
  }, [refreshPreflight])

  const runSync = useCallback(
    async (auto = false) => {
      if (syncing) return
      const api = syncBridge()
      if (!api?.sync) {
        toast.error('Non disponibile', "La sincronizzazione reale è solo nell'app desktop.")
        return
      }
      const scopeMsg =
        blockSize > 0
          ? `Scaricherà ed estrarrà il PROSSIMO BLOCCO di ${blockSize} mod non ancora presenti (Run-Prog), `
          : "Scaricherà ed estrarrà l'elenco completo (fino a ~329 GB, migliaia di mod), "
      if (
        !auto &&
        !window.confirm(
          'Avviare il DOWNLOAD REALE da Nexus?\n\n' +
            scopeMsg +
            'UNICAMENTE nella cartella isolata StockGame. ' +
            'Il tuo Skyrim di Steam originale resta intatto.\n\n' +
            'Richiede Nexus Premium attivo nelle Impostazioni. Puoi annullare in qualsiasi momento.\n\nContinuare?',
        )
      )
        return
      setSyncing(true)
      setSyncProgress(null)
      setDiskError(null)
      pushLog(
        blockSize > 0
          ? `Avvio Run-Prog: blocco di ${blockSize} mod nello StockGame isolato…`
          : 'Avvio sincronizzazione completa nello StockGame isolato…',
        'info',
      )
      try {
        const r = await api.sync.start(blockSize > 0 ? { limit: blockSize } : undefined)
        if (!r.ok) {
          // Disk gatekeeper NO-GO: surface a persistent, actionable disk banner (not just a toast).
          // Toast e log DEVONO seguire la reason: "mancano 0.0 GB" su un blocco 'unsized' (o
          // "liberi Infinity GB" su volume non leggibile) contraddicono il problema reale.
          if (r.disk) {
            const d = r.disk as DiskErrorUI
            setDiskError(d)
            if (d.reason === 'unsized') {
              pushLog(`Blocco pre-flight: ${d.unsizedCount} mod senza dimensione nota nel backup`, 'error')
              toast.error('Mass-install bloccato', `${d.unsizedCount} mod senza dimensione nota — rigenera il backup`)
            } else if (d.reason === 'unreadable') {
              pushLog('Blocco pre-flight: spazio su disco non leggibile (volume scollegato?)', 'error')
              toast.error('Mass-install bloccato', 'Spazio su disco non leggibile: verifica il volume')
            } else {
              pushLog(
                `Blocco pre-flight disco${d.cacheDisk ? ' (volume cache download)' : ''}: mancano ${d.missingGB} GB (servono ${d.requiredGB} GB, liberi ${d.freeGB} GB)`,
                'error',
              )
              toast.error('Spazio su disco insufficiente', `Mancano ~${d.missingGB} GB per avviare`)
            }
            refreshPreflight() // riallinea la card GO/NO-GO allo stesso verdetto del banner
          } else {
            pushLog(`Sincronizzazione non avviata: ${r.error}`, 'error')
            toast.error('Sincronizzazione non avviata', r.error ?? '')
          }
          setSyncing(false)
          return
        }
        pushLog(`Sincronizzazione avviata · ${r.total} mod → ${r.stockGameDir}`, 'success')
        // Live progress + completion arrive on the 'sync:progress' channel (listener below).
      } catch (e) {
        pushLog(`Errore: ${(e as Error).message}`, 'error')
        toast.error('Sincronizzazione fallita', (e as Error).message)
        setSyncing(false)
      }
    },
    [syncing, pushLog, blockSize, refreshPreflight],
  )

  const cancelSync = useCallback(() => {
    syncBridge()?.sync?.cancel()
    pushLog('Annullamento richiesto…', 'warn')
  }, [pushLog])

  // Live mass-sync progress (pushed from main on 'sync:progress').
  useEffect(() => {
    const api = window.api as unknown as {
      on?: (ch: string, cb: (...a: unknown[]) => void) => ((...a: unknown[]) => void) | void
      off?: (ch: string, cb: unknown) => void
    }
    if (!api?.on) return
    const handler = (p: unknown) => {
      const s = p as SyncProgressUI
      setSyncProgress(s)
      if (s.phase === 'done' || s.phase === 'cancelled' || s.phase === 'error') {
        setSyncing(false)
        if (s.phase === 'done') {
          pushLog(
            `Sincronizzazione completata · ${s.modsDone} ok, ${s.modsSkipped} già presenti, ${s.modsFailed} falliti`,
            s.modsFailed ? 'warn' : 'success',
          )
          toast.success('Sincronizzazione completata', `${s.modsDone} mod nello StockGame`)
        } else if (s.phase === 'cancelled') pushLog('Sincronizzazione annullata', 'warn')
        else pushLog(`Sincronizzazione interrotta: ${s.lastMessage}`, 'error')
      }
    }
    // Dedicated disk-gatekeeper block (also returned synchronously by sync.start; the channel is the
    // belt-and-suspenders path so the banner still appears if the block arrives out-of-band).
    const diskHandler = (p: unknown) => {
      setDiskError(p as DiskErrorUI)
      setSyncing(false)
    }
    // Verdetto ESL/254 post-run: PRIMA viveva solo nel log file — successo verde a schermo con
    // gioco non avviabile. Ora il main lo manda sul canale dedicato e l'over-budget diventa
    // banner + toast d'errore.
    const budgetHandler = (p: unknown) => {
      const b = p as PluginBudgetUI
      setPluginBudget(b)
      if (b.overBudget) {
        pushLog(
          `⚠ LIMITE PLUGIN SUPERATO: ${b.full} plugin full + ${b.reservedSlots} master vanilla su ${b.limit} — Skyrim non partirà. Converti in ESL o rimuovi ${-b.remaining} plugin full.`,
          'error',
        )
        toast.error('Limite plugin superato', `Rimuovi o converti ${-b.remaining} plugin full: Skyrim non partirà`)
      } else {
        pushLog(
          `Plugin budget OK: ${b.full} full + ${b.reservedSlots} vanilla su ${b.limit} (${b.remaining} slot liberi, ${b.light} ESL)`,
          'info',
        )
      }
    }
    const w = api.on('sync:progress', handler as (...a: unknown[]) => void)
    const wDisk = api.on('sync:disk-error', diskHandler as (...a: unknown[]) => void)
    const wBudget = api.on('sync:plugin-budget', budgetHandler as (...a: unknown[]) => void)
    return () => {
      if (w) api.off?.('sync:progress', w)
      if (wDisk) api.off?.('sync:disk-error', wDisk)
      if (wBudget) api.off?.('sync:plugin-budget', wBudget)
    }
  }, [pushLog])

  // Pandora detection (PANDORA-REGISTER-01): read-only presence check (never runs Pandora).
  useEffect(() => {
    const api = window.api as unknown as {
      tools?: {
        pandoraPath?: () => Promise<{ exeFound: boolean; exePath: string | null; path: string | null }>
      }
    }
    api?.tools
      ?.pandoraPath?.()
      .then(setPandora)
      .catch(() => setPandora(null))
  }, [])

  // Initial read-only scan for the counters + opt-in zero-click auto-start.
  useEffect(() => {
    // La scansione Vortex tocca il disco (IPC): non va ripetuta a ogni ritorno
    // sulla Dashboard se i contatori sono già in store.
    if (!useAppStore.getState().vortexStats) loadVortexStats()
    pushLog('Applicazione avviata · scansione in corso…', 'info')
    if (settings.autoSyncOnLaunch && !autoRan.current) {
      autoRan.current = true
      pushLog('Avvio automatico a zero-clic attivo — esecuzione pipeline…', 'warn')
      runSync(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleAutoStart = async (next: boolean) => {
    if (
      next &&
      !window.confirm(
        "ATTIVARE l'avvio automatico a zero-clic?\n\nAd ogni apertura l'app eseguirà da sola l'intera pipeline " +
          '(scansione, catalogo ed esecuzione di Pandora che rigenera i file di comportamento del gioco), senza ulteriori conferme.\n\nContinuare?',
      )
    )
      return
    await updateSettings({ autoSyncOnLaunch: next })
    pushLog(
      next ? 'Avvio automatico a zero-clic: ATTIVATO' : 'Avvio automatico a zero-clic: disattivato',
      next ? 'warn' : 'info',
    )
  }

  const stats = useMemo(() => {
    const installed = mods.filter((m) => m.is_installed)
    const enabled = mods.filter((m) => m.is_enabled && m.is_installed)
    const totalSizeGB = mods.reduce((acc, m) => acc + m.file_size, 0) / 1024 / 1024 / 1024
    const activeDownloads = downloads.filter((d) => d.status === 'downloading')
    const errors = conflicts.filter((c) => c.severity === 'error')
    const warnings = conflicts.filter((c) => c.severity === 'warning')

    const byCategory: Record<string, number> = {}
    mods.forEach((m) => {
      byCategory[m.category] = (byCategory[m.category] ?? 0) + 1
    })
    const topCategories = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)

    return { installed, enabled, totalSizeGB, activeDownloads, errors, warnings, topCategories }
  }, [mods, downloads, conflicts])

  const goalGB = DISK_TARGET_GB
  const diskGB = occupiedGB > 0 ? occupiedGB : stats.totalSizeGB // prefer the real Vortex footprint
  const progressPct = Math.min(100, (diskGB / goalGB) * 100)

  const preflight = useMemo(
    () => runPreflight({ settings, mods, totalSizeGB: stats.totalSizeGB, goalGB }),
    [settings, mods, stats.totalSizeGB],
  )
  const pf = preflightSummary(preflight)

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold gradient-text-void" style={{ fontFamily: 'Cinzel, serif' }}>
            Dashboard
          </h1>
          <p className="text-dark-400 text-sm mt-1">
            Profilo attivo: <span className="text-white/70 font-medium">{profile?.name ?? '—'}</span>
          </p>
        </div>
        <button
          onClick={() => setShowPreflight(true)}
          title="Esegui il controllo pre-avvio e lancia il gioco"
          className="flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white transition-all duration-200 hover:scale-105 active:scale-95"
          style={{
            background: 'linear-gradient(135deg, #ff4500, #ff6a2e)',
            boxShadow: '0 0 30px rgba(255,69,0,0.35)',
          }}
        >
          <Play size={18} fill="currentColor" />
          Avvia Skyrim AE
        </button>
      </div>

      {/* Hero: Vortex sync — unique-mod counter, 300 GB disk gauge, central button, opt-in */}
      <div
        className="card p-6 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, rgba(125,77,255,0.12), rgba(77,125,255,0.06) 60%, rgba(77,224,255,0.05))',
          borderColor: 'rgba(125,77,255,0.28)',
        }}
      >
        <div className="grid grid-cols-3 gap-6 items-center">
          {/* Unique mods counter */}
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-soul-400 mb-1">
              <Sparkles size={13} /> Mod uniche rilevate
            </div>
            <div
              className="text-5xl font-bold gradient-text-void leading-none"
              style={{ fontFamily: 'Cinzel, serif' }}
            >
              <CountUp value={uniqueMods} />
            </div>
            <p className="text-xs text-dark-400 mt-2">
              da <span className="text-white/70">{vortexStats?.collections ?? 0}</span> collezioni Vortex ·
              <span className="text-white/70"> {vortexStats?.duplicatesRemoved ?? 0}</span> doppioni rimossi
            </p>
          </div>

          {/* Disk gauge toward target */}
          <div className="flex justify-center">
            <DiskGauge occupiedGB={diskGB} targetGB={goalGB} />
          </div>

          {/* Central action + opt-in */}
          <div className="flex flex-col items-stretch gap-3">
            <button
              onClick={() => runSync()}
              disabled={syncing}
              title="Avvia scansione, catalogo, installazione ed esecuzione di Pandora"
              className="flex items-center justify-center gap-2 px-6 py-4 rounded-xl font-bold text-white text-base transition-all duration-200 hover:scale-[1.03] active:scale-95 disabled:opacity-70 disabled:hover:scale-100"
              style={{
                background: 'linear-gradient(135deg, #7d4dff, #4d7dff 60%, #4de0ff)',
                boxShadow: '0 0 34px rgba(125,77,255,0.45)',
              }}
            >
              {syncing ? (
                <>
                  <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />{' '}
                  Sincronizzazione…
                </>
              ) : (
                <>
                  <Rocket size={18} /> Sincronizza e Avvia
                </>
              )}
            </button>
            {/* Run-Prog: blocco progressivo */}
            <label className="flex items-center justify-between gap-2 text-xs text-dark-300">
              <span title="Ogni esecuzione elabora le prossime N mod non ancora presenti nello StockGame. 0 = intera modlist in un unico run.">
                Blocco Run-Prog (mod per esecuzione)
              </span>
              <input
                type="number"
                min={0}
                max={5000}
                step={50}
                value={blockSize}
                disabled={syncing}
                onChange={(e) => setBlockSize(Math.max(0, Math.min(5000, Number(e.target.value) || 0)))}
                className="input-field w-24 text-right"
              />
            </label>
            <Toggle
              checked={!!settings.autoSyncOnLaunch}
              onChange={toggleAutoStart}
              label="Avvio automatico a zero-clic all'apertura"
            />
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          icon={<Package size={20} className="text-void-400" />}
          label="Mod Installate"
          value={stats.installed.length}
          sub={`${stats.enabled.length} attive`}
          color="void"
          onClick={() => setActivePage('modlist')}
        />
        <StatCard
          icon={<HardDrive size={20} className="text-soul-400" />}
          label="Spazio Occupato"
          value={`${diskGB.toFixed(0)} GB`}
          sub={`obiettivo: ${goalGB} GB`}
          color="soul"
          onClick={() => setActivePage('stats')}
        />
        <StatCard
          icon={<Download size={20} className="text-green-400" />}
          label="Download Attivi"
          value={stats.activeDownloads.length}
          sub={`${downloads.length} totali`}
          color="green"
          onClick={() => setActivePage('downloads')}
        />
        <StatCard
          icon={<AlertTriangle size={20} className="text-orange-400" />}
          label="Conflitti"
          value={conflicts.length}
          sub={`${stats.errors.length} errori · ${stats.warnings.length} avvisi`}
          color="orange"
          onClick={() => setActivePage('conflicts')}
        />
      </div>

      {/* Progress bar toward goal */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <TrendingUp size={16} className="text-soul-400" />
            <span className="text-sm font-semibold text-white/80">Progresso Modlist</span>
          </div>
          <span className="text-xs text-dark-400">
            {diskGB.toFixed(0)} / {goalGB} GB ({progressPct.toFixed(0)}%)
          </span>
        </div>
        <div className="h-3 rounded-full bg-dark-800 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${progressPct}%`,
              background:
                progressPct > 90
                  ? 'linear-gradient(90deg, #ff4500, #ff6a2e)'
                  : 'linear-gradient(90deg, #7d4dff, #4d7dff)',
              boxShadow: `0 0 12px ${progressPct > 90 ? 'rgba(255,69,0,0.5)' : 'rgba(125,77,255,0.5)'}`,
            }}
          />
        </div>
        <div className="flex justify-between mt-1.5 text-xs text-dark-500">
          <span>0 GB</span>
          <span>~1000 mod</span>
          <span>{goalGB} GB</span>
        </div>
      </div>

      {/* System preflight — environment compatibility before installing */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-white/80 flex items-center gap-2 text-sm">
            {pf.ready ? (
              <ShieldCheck size={16} className="text-green-400" />
            ) : (
              <Shield size={16} className="text-orange-400" />
            )}
            Controllo Sistema
          </h3>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${pf.ready ? 'bg-green-500/15 text-green-400' : 'bg-orange-500/15 text-orange-400'}`}
          >
            {pf.ready ? 'Pronto per installare' : `${pf.fail} blocco · ${pf.warn} avvisi`}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
          {preflight.map((c) => (
            <button
              key={c.id}
              onClick={() => setActivePage('settings')}
              className="flex items-start gap-2 text-left group"
              title={c.detail}
            >
              {c.status === 'ok' ? (
                <CheckCircle size={13} className="text-green-400 flex-shrink-0 mt-0.5" />
              ) : c.status === 'warn' ? (
                <AlertTriangle size={13} className="text-orange-400 flex-shrink-0 mt-0.5" />
              ) : (
                <XCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                <p className="text-xs text-white/75 group-hover:text-white truncate">{c.label}</p>
                <p className="text-[11px] text-dark-500 truncate">{c.detail}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-3 gap-6">
        {/* Quick actions */}
        <div className="col-span-1 card p-4 space-y-1">
          <h3 className="font-semibold text-white/80 mb-3 flex items-center gap-2 text-sm">
            <Zap size={15} className="text-void-400" />
            Azioni Rapide
          </h3>
          {[
            { label: 'Lista Mod', icon: Package, color: '#7d4dff', page: 'modlist' },
            { label: 'Scarica Mod', icon: Download, color: '#4d7dff', page: 'downloads' },
            { label: 'Rileva Conflitti', icon: AlertTriangle, color: '#ffb84d', page: 'conflicts' },
            { label: 'Strumenti Esterni', icon: Swords, color: '#ff6a2e', page: 'tools' },
            { label: 'Gestisci Profili', icon: Shield, color: '#4dffaa', page: 'profiles' },
            { label: 'Backup', icon: CheckCircle, color: '#ff80cc', page: 'backup' },
            { label: 'Catalogo Mod', icon: Sparkles, color: '#4de0ff', page: 'catalog' },
          ].map(({ label, icon: Icon, color, page }) => (
            <button
              key={label}
              onClick={() => setActivePage(page)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-dark-300
                hover:text-white hover:bg-white/6 transition-all duration-150 text-left"
            >
              <Icon size={15} style={{ color }} />
              {label}
            </button>
          ))}
        </div>

        {/* Category breakdown */}
        <div className="col-span-2 card p-4">
          <h3 className="font-semibold text-white/80 mb-4 flex items-center gap-2 text-sm">
            <Package size={15} className="text-void-400" />
            Mod per Categoria
          </h3>
          {stats.topCategories.length === 0 ? (
            <p className="text-dark-400 text-sm text-center py-8">Nessuna mod installata</p>
          ) : (
            <div className="space-y-2">
              {stats.topCategories.map(([cat, count]) => {
                const pct = Math.round((count / mods.length) * 100)
                const color = CATEGORY_COLORS[cat] ?? '#6b7280'
                return (
                  <div key={cat} className="flex items-center gap-3">
                    <span className="w-24 text-xs text-dark-400 capitalize truncate">{cat}</span>
                    <div className="flex-1 h-2 rounded-full bg-dark-800 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}80` }}
                      />
                    </div>
                    <span className="w-8 text-right text-xs text-dark-400">{count}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Conflict alerts (only if any) */}
      {conflicts.length > 0 && (
        <div className="card p-4 border-orange-500/20">
          <h3 className="font-semibold text-orange-400 mb-3 flex items-center gap-2 text-sm">
            <AlertTriangle size={15} />
            Conflitti Rilevati
          </h3>
          <div className="space-y-1.5">
            {conflicts.slice(0, 4).map((c, i) => (
              <div
                key={`${c.modId}-${i}`}
                className="flex items-start gap-2 text-xs p-2 rounded-lg bg-white/3"
              >
                <span className={c.severity === 'error' ? 'text-red-400' : 'text-orange-400'}>
                  {c.severity === 'error' ? '✕' : '⚠'}
                </span>
                <span className="text-white/70">{c.message}</span>
              </div>
            ))}
            {conflicts.length > 4 && (
              <button
                onClick={() => setActivePage('conflicts')}
                className="text-xs text-void-400 hover:text-void-300 transition-colors mt-1"
              >
                Vedi tutti i {conflicts.length} conflitti →
              </button>
            )}
          </div>
        </div>
      )}

      {/* Recent downloads */}
      <div className="card p-4">
        <h3 className="font-semibold text-white/80 mb-3 flex items-center gap-2 text-sm">
          <Clock size={15} className="text-soul-400" />
          Attività Recente
        </h3>
        {downloads.length === 0 ? (
          <p className="text-dark-400 text-sm text-center py-4">Nessun download recente</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {downloads.slice(0, 6).map((dl) => (
              <div
                key={dl.id}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/4 transition-colors"
              >
                <StatusDot status={dl.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/80 truncate">{dl.name}</p>
                  <p className="text-xs text-dark-500 capitalize">{dl.status}</p>
                </div>
                {dl.total_size > 0 && (
                  <span className="text-xs text-dark-500 font-mono">
                    {(dl.total_size / 1024 / 1024).toFixed(0)}MB
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* System config */}
      <div className="card p-4">
        <h3 className="font-semibold text-white/80 mb-3 flex items-center gap-2 text-sm">
          <CheckCircle size={15} className="text-green-400" />
          Configurazione Sistema
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            {[
              { label: 'GPU', value: 'AMD RX 9070 XT' },
              { label: 'CPU', value: 'Ryzen 7 7800X3D' },
              { label: 'RAM', value: '16 GB DDR5' },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="flex items-center justify-between p-2 rounded-lg bg-white/3 text-xs"
              >
                <span className="text-dark-400">{label}</span>
                <span className="text-white/80 font-medium">{value}</span>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            {[
              { label: 'Skyrim AE', value: settings.gamePath as string | undefined, detected: false },
              { label: 'Mod Organizer 2', value: settings.mo2Path, detected: false },
              { label: 'DynDOLOD', value: settings.dyndolodPath, detected: false },
              {
                label: 'Pandora',
                value: pandora?.exeFound ? (pandora.exePath ?? 'rilevato') : '',
                detected: !!pandora?.exeFound,
              },
            ].map(({ label, value, detected }) => (
              <div
                key={label}
                className="flex items-center justify-between p-2 rounded-lg bg-white/3 text-xs"
                title={value || ''}
              >
                <span className="text-dark-400">{label}</span>
                {value ? (
                  <span className="text-green-400">{detected ? '✓ Rilevato' : '✓ Config.'}</span>
                ) : (
                  <span className="text-orange-400/80">Non config.</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Disk gatekeeper NO-GO (PRECHECK-02) — the run was BLOCKED before the queue could start */}
      {diskError && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <HardDrive size={18} className="text-red-400 mt-0.5 shrink-0" />
              <div>
                <div
                  className="text-sm font-bold text-red-200"
                  style={{ fontFamily: 'Cinzel, serif' }}
                >
                  {diskError.reason === 'unsized'
                    ? 'Mass-install bloccato · dimensioni mod sconosciute'
                    : diskError.reason === 'unreadable'
                      ? 'Mass-install bloccato · spazio su disco non leggibile'
                      : 'Mass-install bloccato · spazio su disco insufficiente'}
                </div>
                {diskError.reason === 'insufficient' && !diskError.cacheDisk ? (
                  <>
                    <p className="text-xs text-red-200/80 mt-1 leading-relaxed">
                      Servono ~<strong>{diskError.requiredGB} GB</strong> (download{' '}
                      {(diskError.requiredBytes / 1024 ** 3).toFixed(1)} GB + margine estrazione
                      {diskError.sameDisk ? ', stesso disco' : ''}), ma sono liberi solo{' '}
                      <strong>{diskError.freeGB} GB</strong> → mancano{' '}
                      <strong className="text-red-300">{diskError.missingGB} GB</strong>.
                    </p>
                    <p className="text-xs text-red-200/70 mt-1">
                      Libera spazio, sposta lo StockGame su un volume più capiente
                      {diskError.profile === '4K'
                        ? ' o passa al profilo texture 2K nelle Impostazioni.'
                        : '.'}
                      {diskError.extraDeps > 0 &&
                        ` (${diskError.extraDeps} dipendenze incluse nella stima)`}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-red-200/80 mt-1 leading-relaxed">{diskError.error}</p>
                )}
              </div>
            </div>
            <button
              onClick={() => setDiskError(null)}
              className="text-xs text-red-300/70 hover:text-red-200 px-2 py-1 rounded shrink-0"
            >
              Chiudi
            </button>
          </div>
        </div>
      )}

      {/* Verdetto ESL/254 post-run: oltre il limite il gioco NON parte — deve urlare, non stare nel log file */}
      {pluginBudget?.overBudget && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <AlertTriangle size={18} className="text-red-400 mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-bold text-red-200" style={{ fontFamily: 'Cinzel, serif' }}>
                  Limite plugin superato · Skyrim non partirà
                </div>
                <p className="text-xs text-red-200/80 mt-1 leading-relaxed">
                  {pluginBudget.full} plugin full installati + {pluginBudget.reservedSlots} master vanilla
                  superano il limite di {pluginBudget.limit} slot. Converti in ESL o rimuovi{' '}
                  <strong className="text-red-300">{-pluginBudget.remaining}</strong> plugin full prima di
                  avviare il gioco ({pluginBudget.light} plugin light ESL non contano).
                </p>
              </div>
            </div>
            <button
              onClick={() => setPluginBudget(null)}
              className="text-xs text-red-300/70 hover:text-red-200 px-2 py-1 rounded shrink-0"
            >
              Chiudi
            </button>
          </div>
        </div>
      )}

      {/* Disk pre-flight (PRECHECK-01) — GO/NO-GO before any download */}
      {diskPf && diskPf.modsTotal > 0 && !syncing && (
        <div
          className={`rounded-xl border p-4 ${diskPf.ok ? 'border-green-500/25 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className={diskPf.ok ? 'text-green-400' : 'text-red-400'} />
              <span className="text-sm font-bold text-dark-100" style={{ fontFamily: 'Cinzel, serif' }}>
                Pre-flight disco · StockGame
                {diskPf.modsSelected != null && diskPf.modsSelected < diskPf.modsTotal && (
                  <span className="ml-2 text-[10px] font-normal text-soul-300">
                    blocco {diskPf.modsSelected} / {diskPf.modsTotal} mod
                  </span>
                )}
              </span>
            </div>
            <span
              className={`text-xs font-bold px-2 py-0.5 rounded ${diskPf.ok ? 'bg-green-500/15 text-green-300' : 'bg-red-500/15 text-red-300'}`}
            >
              {diskPf.ok ? '✓ GO' : '✗ NO-GO'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <PfStat
              label="Richiesto"
              value={`${fmtGB(diskPf.requiredBytes)} GB`}
              sub={`${diskPf.modsSelected ?? diskPf.modsTotal} mod × ${diskPf.extractionOverhead} × ${diskPf.safetyFactor}`}
            />
            <PfStat
              label="Disponibile"
              value={Number.isFinite(diskPf.freeBytes) ? `${fmtGB(diskPf.freeBytes)} GB` : '—'}
            />
            <PfStat
              label="Margine"
              value={
                Number.isFinite(diskPf.freeBytes)
                  ? `${diskPf.marginBytes >= 0 ? '+' : ''}${fmtGB(diskPf.marginBytes)} GB`
                  : '—'
              }
              danger={!diskPf.ok}
            />
          </div>
          {!diskPf.ok && (
            <p className="text-xs text-red-300/90 mt-2">
              {diskPf.reason === 'unreadable' || !Number.isFinite(diskPf.freeBytes) ? (
                <>
                  Spazio su disco <b>non leggibile</b>: verifica che il volume dello StockGame sia
                  connesso e accessibile.
                </>
              ) : diskPf.reason === 'unsized' ? (
                <>
                  {diskPf.unsizedCount ?? 0} mod senza dimensione nota nel backup: rigenera il backup
                  delle collezioni o riduci il blocco Run-Prog.
                </>
              ) : (
                <>
                  Spazio insufficiente{diskPf.cacheDisk ? ' sul volume della cache download' : ''}:
                  mancano ~{fmtGB(diskPf.missingBytes ?? -diskPf.marginBytes)} GB. La sincronizzazione
                  verrà <b>bloccata</b> finché non liberi spazio o sposti lo StockGame su un volume più
                  capiente.
                </>
              )}
            </p>
          )}
        </div>
      )}

      {/* Live mass-sync progress → StockGame */}
      {syncProgress && (
        <div className="rounded-xl border border-soul-500/30 bg-soul-500/5 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              {syncing ? (
                <span className="w-4 h-4 rounded-full border-2 border-soul-400/40 border-t-soul-400 animate-spin" />
              ) : (
                <ShieldCheck size={16} className="text-green-400" />
              )}
              <span className="text-sm font-bold text-dark-100" style={{ fontFamily: 'Cinzel, serif' }}>
                Sincronizzazione modlist → StockGame isolato
              </span>
            </div>
            {syncing && (
              <button onClick={cancelSync} className="btn-ghost flex items-center gap-1.5 px-3 py-1 text-xs">
                <XCircle size={14} /> Annulla
              </button>
            )}
          </div>
          <div className="flex justify-between text-xs text-dark-400 mb-1">
            <span>
              {syncProgress.modsDone + syncProgress.modsSkipped}/{syncProgress.modsTotal} mod
              {syncProgress.modsFailed > 0 ? ` · ${syncProgress.modsFailed} falliti` : ''}
              {syncProgress.modsSkipped > 0 ? ` · ${syncProgress.modsSkipped} già presenti` : ''}
            </span>
            <span className="flex items-center gap-3">
              {syncProgress.throughputMBps > 0 && (
                <span className="text-soul-300">{syncProgress.throughputMBps.toFixed(1)} MB/s</span>
              )}
              {syncProgress.etaSeconds != null && syncing && (
                <span>ETA {fmtEta(syncProgress.etaSeconds)}</span>
              )}
              <span>
                {(syncProgress.bytesDownloaded / 1024 ** 3).toFixed(2)} /{' '}
                {(syncProgress.bytesTotal / 1024 ** 3).toFixed(0)} GB
              </span>
            </span>
          </div>
          {/* BYTE-PRECISE overall bar (monotonic — never resets, so no 100→0→100) */}
          <div className="h-2.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{
                width: `${syncProgress.bytesTotal > 0 ? Math.min(100, (syncProgress.bytesDownloaded / syncProgress.bytesTotal) * 100) : 0}%`,
                background:
                  syncProgress.phase === 'error'
                    ? 'linear-gradient(90deg,#ff4500,#ff6a2e)'
                    : 'linear-gradient(90deg,#7d4dff,#4d7dff)',
                boxShadow: '0 0 12px rgba(125,77,255,0.5)',
              }}
            />
          </div>
          {/* current concurrent items — phase-labelled so the per-item % reset is never confusing */}
          {syncProgress.active.length > 0 && (
            <div className="mt-3 space-y-1">
              {syncProgress.active.slice(0, 5).map((a, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] text-dark-400">
                  <Download size={11} className="text-soul-400 shrink-0" />
                  <span className="truncate flex-1" title={a.name}>
                    {a.name}
                  </span>
                  <span
                    className={`shrink-0 px-1.5 rounded text-[10px] ${a.phase === 'downloading' ? 'bg-soul-500/15 text-soul-300' : a.phase === 'verifying' ? 'bg-amber-500/15 text-amber-300' : 'bg-blue-500/15 text-blue-300'}`}
                  >
                    {a.phase === 'downloading'
                      ? 'download'
                      : a.phase === 'verifying'
                        ? 'verifica'
                        : 'estrazione'}
                  </span>
                  <span className="text-dark-300 w-9 text-right">{a.percent}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* StockGame builder — isolated vanilla copy */}
      <StockGamePanel onLog={pushLog} />

      {/* Real-time activity log console */}
      <LogConsole lines={activityLog} onClear={clearLog} />

      {showPreflight && <LaunchPreflight onClose={() => setShowPreflight(false)} />}
    </div>
  )
}

// Compact stat cell for the disk pre-flight card.
function PfStat({
  label,
  value,
  sub,
  danger,
}: {
  label: string
  value: string
  sub?: string
  danger?: boolean
}) {
  return (
    <div>
      <div className="text-dark-500">{label}</div>
      <div className={`text-base font-bold ${danger ? 'text-red-300' : 'text-dark-100'}`}>{value}</div>
      {sub && <div className="text-[10px] text-dark-500">{sub}</div>}
    </div>
  )
}

// Count-up animation for the headline counters.
function CountUp({ value }: { value: number }) {
  const [n, setN] = useState(0)
  const prev = useRef(0)
  useEffect(() => {
    const from = prev.current,
      to = value,
      dur = 700,
      start = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur)
      const eased = 1 - Math.pow(1 - p, 3)
      setN(Math.round(from + (to - from) * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
      else prev.current = to
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{n.toLocaleString('it-IT')}</>
}

// Circular disk-usage gauge toward the modlist target.
function DiskGauge({ occupiedGB, targetGB }: { occupiedGB: number; targetGB: number }) {
  const pct = Math.min(100, targetGB > 0 ? (occupiedGB / targetGB) * 100 : 0)
  const r = 54,
    circ = 2 * Math.PI * r
  const danger = pct > 92
  const color = danger ? '#ff4500' : '#7d4dff'
  return (
    <div className="relative" style={{ width: 144, height: 144 }}>
      <svg width={144} height={144} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={72} cy={72} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={11} />
        <circle
          cx={72}
          cy={72}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={11}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct / 100)}
          style={{ transition: 'stroke-dashoffset 0.8s ease', filter: `drop-shadow(0 0 6px ${color}aa)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="flex items-center gap-1 text-2xl font-bold text-white">
          <CountUp value={Math.round(occupiedGB)} />
          <span className="text-sm text-dark-400 font-normal">GB</span>
        </div>
        <div className="text-[10px] text-dark-500">su {targetGB} GB</div>
        <div className="text-[11px] font-semibold mt-0.5" style={{ color }}>
          {pct.toFixed(0)}%
        </div>
      </div>
    </div>
  )
}

// Opt-in switch.
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button onClick={() => onChange(!checked)} className="flex items-center gap-2.5 text-left">
      <span
        className="relative w-9 h-5 rounded-full transition-colors flex-shrink-0"
        style={{ background: checked ? '#7d4dff' : 'rgba(255,255,255,0.12)' }}
      >
        <span
          className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200"
          style={{ left: checked ? 18 : 2 }}
        />
      </span>
      <span className="text-xs text-dark-300">{label}</span>
    </button>
  )
}

// Scrollable real-time log console (auto-scrolls to the newest line).
function LogConsole({ lines, onClear }: { lines: LogLine[]; onClear: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  const tone = (l: LogLine['level']) =>
    l === 'success'
      ? 'text-green-400'
      : l === 'warn'
        ? 'text-orange-400'
        : l === 'error'
          ? 'text-red-400'
          : 'text-dark-300'
  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-dark-800">
        <h3 className="font-semibold text-white/80 flex items-center gap-2 text-sm">
          <Terminal size={15} className="text-green-400" /> Console di Log{' '}
          <span className="text-dark-500 text-xs font-normal">({lines.length})</span>
        </h3>
        <button
          onClick={onClear}
          className="text-dark-500 hover:text-white transition-colors p-1"
          title="Pulisci log"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div
        ref={ref}
        className="font-mono text-[11px] leading-relaxed p-3 h-40 overflow-y-auto space-y-0.5"
        style={{ background: 'rgba(5,5,7,0.5)' }}
      >
        {lines.length === 0 ? (
          <p className="text-dark-600">In attesa di attività…</p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="flex gap-2">
              <span className="text-dark-600 flex-shrink-0">{l.time}</span>
              <span className={tone(l.level)}>{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  sub,
  color,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  value: string | number
  sub: string
  color: string
  onClick?: () => void
}) {
  const borderColor =
    {
      void: 'rgba(125,77,255,0.3)',
      soul: 'rgba(77,125,255,0.3)',
      green: 'rgba(74,222,128,0.3)',
      orange: 'rgba(251,146,60,0.3)',
    }[color] ?? 'rgba(255,255,255,0.1)'

  return (
    <button
      onClick={onClick}
      className="card p-4 text-left hover:bg-white/5 transition-colors w-full"
      style={{ borderColor }}
    >
      <div className="flex items-center justify-between mb-2">
        {icon}
        <span className="text-2xl font-bold text-white">{value}</span>
      </div>
      <p className="text-sm font-medium text-white/70">{label}</p>
      <p className="text-xs text-dark-400 mt-0.5">{sub}</p>
    </button>
  )
}

function StatusDot({ status }: { status: string }) {
  const color =
    {
      completed: 'bg-green-400',
      downloading: 'bg-blue-400 animate-pulse',
      failed: 'bg-red-400',
      pending: 'bg-yellow-400',
      paused: 'bg-dark-400',
    }[status] ?? 'bg-dark-400'
  return <div className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />
}
