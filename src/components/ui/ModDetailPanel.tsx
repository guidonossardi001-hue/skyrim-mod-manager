import { useState, useEffect } from 'react'
import {
  X,
  ExternalLink,
  RefreshCw,
  Save,
  AlertTriangle,
  CheckCircle,
  Package,
  Tag,
  HardDrive,
  Calendar,
  User,
  ArrowUpCircle,
} from 'lucide-react'
import { clsx } from 'clsx'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/appStore'
import { toast } from '@/lib/toast'
import type { Mod, ModCategory } from '@/types'

const CATEGORY_LABELS: Record<ModCategory, string> = {
  framework: 'Framework',
  visuals: 'Grafica',
  character: 'Personaggio',
  npc: 'NPC',
  gameplay: 'Gameplay',
  combat: 'Combattimento',
  animation: 'Animazione',
  audio: 'Audio',
  quest: 'Quest',
  world: 'Mondo',
  lore: 'Lore',
  ui: 'Interfaccia',
  performance: 'Prestazioni',
  adult: 'Adulti',
  translation: 'Traduzione',
  patch: 'Patch',
  tool: 'Strumento',
  other: 'Altro',
}

interface Props {
  mod: Mod | null
  onClose: () => void
}

export function ModDetailPanel({ mod, onClose }: Props) {
  const { conflicts, modUpdates, settings, updateMod, checkForUpdates } = useAppStore(
    useShallow((s) => ({
      conflicts: s.conflicts,
      modUpdates: s.modUpdates,
      settings: s.settings,
      updateMod: s.updateMod,
      checkForUpdates: s.checkForUpdates,
    })),
  )
  const [notes, setNotes] = useState(mod?.description ?? '')
  const [checkingUpdate, setCheckingUpdate] = useState(false)

  // The panel instance is reused across different mods (it stays mounted and just
  // receives a new `mod`), so the notes field must resync when the mod changes.
  // Intentionally keyed on mod.id ONLY: re-syncing on mod.description would clobber
  // the user's unsaved edits whenever the store row refreshes.
  useEffect(() => {
    setNotes(mod?.description ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod?.id])

  if (!mod) return null

  const modConflicts = conflicts.filter((c) => c.modId === mod.id)
  const updateInfo = modUpdates[mod.id]
  const requires: string[] = (() => {
    try {
      return JSON.parse(mod.requires || '[]')
    } catch {
      return []
    }
  })()
  const conflictsWith: string[] = (() => {
    try {
      return JSON.parse(mod.conflicts || '[]')
    } catch {
      return []
    }
  })()

  const sizeMB = mod.file_size / 1024 / 1024
  const sizeStr = sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(2)} GB` : `${sizeMB.toFixed(0)} MB`

  const handleSaveNotes = async () => {
    await updateMod(mod.id, { description: notes })
    toast.success('Note salvate', mod.name)
  }

  const handleCheckUpdate = async () => {
    // settings.nexusApiKey ora è solo il segnaposto mascherato: indica SE la chiave
    // è impostata; il valore reale resta nel processo main.
    if (!settings.nexusApiKey) {
      toast.warning('API Key mancante', 'Configura la Nexus API Key nelle Impostazioni')
      return
    }
    if (!mod.nexus_id) {
      toast.info('Nexus ID assente', 'Questa mod non ha un ID Nexus configurato')
      return
    }
    setCheckingUpdate(true)
    try {
      const result = await checkForUpdates(mod.id)
      if (result.hasUpdate) {
        toast.warning('Aggiornamento disponibile', `${mod.name} → v${result.latestVersion}`)
      } else {
        toast.success('Mod aggiornata', `${mod.name} è alla versione più recente`)
      }
    } catch {
      toast.error('Errore controllo aggiornamento')
    } finally {
      setCheckingUpdate(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        data-close-on-escape
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 bottom-0 z-50 w-96 flex flex-col shadow-2xl"
        style={{ background: 'var(--bg-secondary)', borderLeft: '1px solid rgba(255,255,255,0.08)' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-dark-800 flex-shrink-0">
          <div className="flex-1 min-w-0 pr-3">
            <h2 className="font-bold text-white/90 leading-tight">{mod.name}</h2>
            {mod.author && (
              <p className="text-xs text-dark-400 mt-0.5 flex items-center gap-1">
                <User size={11} /> {mod.author}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-dark-400 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
          >
            <X size={15} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Status + update badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={clsx(
                'px-2 py-0.5 rounded-full text-xs font-semibold',
                mod.is_enabled ? 'bg-green-500/20 text-green-400' : 'bg-dark-700 text-dark-400',
              )}
            >
              {mod.is_enabled ? '● Attiva' : '○ Disattiva'}
            </span>
            <span className="tag" style={{ fontSize: '11px' }}>
              {CATEGORY_LABELS[mod.category as ModCategory] ?? mod.category}
            </span>
            {mod.version && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-dark-700 text-dark-300">
                v{mod.version}
              </span>
            )}
            {updateInfo?.hasUpdate && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-orange-500/20 text-orange-400 flex items-center gap-1">
                <ArrowUpCircle size={11} /> v{updateInfo.latestVersion}
              </span>
            )}
            {mod.translation_it ? (
              <span className="px-2 py-0.5 rounded-full text-xs bg-void-500/20 text-void-400">🇮🇹 IT</span>
            ) : null}
          </div>

          {/* Meta info */}
          <div className="space-y-2">
            <InfoRow icon={<HardDrive size={13} />} label="Dimensione" value={sizeStr} />
            <InfoRow icon={<Tag size={13} />} label="Priorità" value={`${mod.priority}`} />
            {mod.nexus_id && (
              <InfoRow icon={<Package size={13} />} label="Nexus ID" value={`${mod.nexus_id}`} />
            )}
            {mod.install_path && (
              <InfoRow icon={<Calendar size={13} />} label="Percorso" value={mod.install_path} truncate />
            )}
          </div>

          {/* Conflicts for this mod */}
          {modConflicts.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-dark-400 uppercase tracking-wide mb-2">Conflitti</h4>
              <div className="space-y-1.5">
                {modConflicts.map((c, i) => (
                  <div
                    key={i}
                    className={clsx(
                      'flex items-start gap-2 p-2 rounded-lg text-xs',
                      c.severity === 'error'
                        ? 'bg-red-900/20 text-red-300'
                        : 'bg-orange-900/20 text-orange-300',
                    )}
                  >
                    <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                    <span>{c.message}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {modConflicts.length === 0 && (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-green-900/10 text-green-400 text-xs">
              <CheckCircle size={13} /> Nessun conflitto rilevato
            </div>
          )}

          {/* Requirements */}
          {requires.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-dark-400 uppercase tracking-wide mb-2">Dipendenze</h4>
              <div className="flex flex-wrap gap-1.5">
                {requires.map((r) => (
                  <span key={r} className="px-2 py-0.5 rounded-full text-xs bg-dark-700 text-dark-300">
                    {r}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Conflicts with */}
          {conflictsWith.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-dark-400 uppercase tracking-wide mb-2">
                Incompatibile con
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {conflictsWith.map((r) => (
                  <span key={r} className="px-2 py-0.5 rounded-full text-xs bg-red-900/30 text-red-400">
                    {r}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Notes */}
          <section>
            <h4 className="text-xs font-semibold text-dark-400 uppercase tracking-wide mb-2">
              Note / Descrizione
            </h4>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Aggiungi note personali su questa mod..."
              className="input-field w-full resize-none text-xs"
            />
            <button
              onClick={handleSaveNotes}
              className="mt-2 flex items-center gap-1.5 text-xs text-void-400 hover:text-void-300 transition-colors"
            >
              <Save size={12} /> Salva note
            </button>
          </section>
        </div>

        {/* Footer actions */}
        <div className="p-4 border-t border-dark-800 flex items-center gap-2 flex-shrink-0">
          {mod.nexus_id && (
            <button
              onClick={handleCheckUpdate}
              disabled={checkingUpdate}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-soul-400 hover:text-soul-300 hover:bg-soul-900/20 transition-all disabled:opacity-50"
            >
              <RefreshCw size={13} className={checkingUpdate ? 'animate-spin' : ''} />
              {checkingUpdate ? 'Controllo...' : 'Controlla aggiornamento'}
            </button>
          )}
          {mod.nexus_url && (
            <button
              onClick={() => window.api.fs.openExternal(mod.nexus_url!)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-dark-400 hover:text-white hover:bg-white/8 transition-all ml-auto"
            >
              <ExternalLink size={13} /> Nexus Mods
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function InfoRow({
  icon,
  label,
  value,
  truncate,
}: {
  icon: React.ReactNode
  label: string
  value: string
  truncate?: boolean
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-dark-500 flex-shrink-0">{icon}</span>
      <span className="text-dark-400 w-20 flex-shrink-0">{label}</span>
      <span className={clsx('text-white/70', truncate && 'truncate')}>{value}</span>
    </div>
  )
}
