import { useEffect, useState, useCallback, useMemo, memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/appStore'
import { Download, Pause, X, Play, FolderOpen, CheckCircle, AlertCircle, Clock } from 'lucide-react'
import type { Download as DL } from '@/types'
import { clsx } from 'clsx'

interface DownloadProgress {
  id: number
  downloaded: number
  total: number
  percent: number
  speed: number
}

interface InstallProgress {
  stage: string
  percent: number
}

export default function Downloads() {
  // Selettore shallow: la pagina si ri-renderizza solo quando cambiano QUESTI
  // campi, non a ogni set() dello store (es. le righe di log della Dashboard).
  const { downloads, loadDownloads, activeProfileId } = useAppStore(
    useShallow((s) => ({
      downloads: s.downloads,
      loadDownloads: s.loadDownloads,
      activeProfileId: s.activeProfileId,
    })),
  )
  const [progress, setProgress] = useState<Record<number, DownloadProgress>>({})
  const [installProgress, setInstallProgress] = useState<Record<number, InstallProgress>>({})

  useEffect(() => {
    // Real-time progress from the main process. The preload exposes the IPC bridge
    // on window.api.on (NOT window.electron, which is never injected), so live
    // events drive the smooth progress bar instead of relying only on 3s polling.
    const api = window.api as unknown as {
      on?: (ch: string, cb: (...a: unknown[]) => void) => ((...a: unknown[]) => void) | void
      off?: (ch: string, cb: unknown) => void
    }
    if (!api?.on) return

    const onProgress = (data: DownloadProgress) => setProgress((prev) => ({ ...prev, [data.id]: data }))
    const onComplete = (data: { id: number }) => {
      setProgress((prev) => {
        const next = { ...prev }
        delete next[data.id]
        return next
      })
      loadDownloads()
    }
    const onError = () => loadDownloads()

    // Extraction/verification progress for heavy archives (Electron only): keeps the
    // UI live during the (potentially minutes-long) unpack of a multi-GB archive.
    const onInstallProgress = (data: { id: number; stage: string; percent?: number }) =>
      setInstallProgress((prev) => ({
        ...prev,
        [data.id]: { stage: data.stage, percent: data.percent ?? 0 },
      }))
    const onInstallDone = (data: { id: number }) => {
      setInstallProgress((prev) => {
        const next = { ...prev }
        delete next[data.id]
        return next
      })
      loadDownloads()
    }

    const subs = [
      { ch: 'download:progress', w: api.on('download:progress', onProgress as (...a: unknown[]) => void) },
      { ch: 'download:complete', w: api.on('download:complete', onComplete as (...a: unknown[]) => void) },
      { ch: 'download:error', w: api.on('download:error', onError) },
      {
        ch: 'install:progress',
        w: api.on('install:progress', onInstallProgress as (...a: unknown[]) => void),
      },
      { ch: 'install:complete', w: api.on('install:complete', onInstallDone as (...a: unknown[]) => void) },
      { ch: 'install:error', w: api.on('install:error', onInstallDone as (...a: unknown[]) => void) },
    ]
    return () => subs.forEach((s) => api.off?.(s.ch, s.w))
  }, [loadDownloads])

  useEffect(() => {
    loadDownloads()
    const interval = setInterval(loadDownloads, 3000)
    return () => clearInterval(interval)
  }, [activeProfileId, loadDownloads])

  // NOTA: il refresh della lista mod al completamento di un download è già
  // gestito globalmente da App.tsx (sottoscrizione download:complete/install:complete);
  // il vecchio effetto locale qui duplicava le chiamate loadMods.

  const controlDownload = useCallback(
    async (id: number, action: 'pause' | 'resume' | 'cancel') => {
      const api = window.api as unknown as { download: Record<string, (id: number) => Promise<unknown>> }
      await api.download[action]?.(id)
      loadDownloads()
    },
    [loadDownloads],
  )

  // Derivazioni pure memoizzate: 5 filter + 2 reduce girano solo quando cambia
  // l'array downloads, non a ogni tick di progresso (16+/s con 4 download attivi).
  const { grouped, totalSize, totalDone, activeCount, completedCount } = useMemo(
    () => ({
      grouped: {
        active: downloads.filter((d) => d.status === 'downloading' || d.status === 'installing'),
        pending: downloads.filter((d) => d.status === 'pending'),
        completed: downloads.filter((d) => d.status === 'completed'),
        failed: downloads.filter((d) => d.status === 'failed'),
        paused: downloads.filter((d) => d.status === 'paused'),
      },
      totalSize: downloads.reduce((a, d) => a + d.total_size, 0),
      totalDone: downloads.reduce((a, d) => a + d.downloaded_size, 0),
      activeCount: downloads.filter((d) => d.status === 'downloading').length,
      completedCount: downloads.filter((d) => d.status === 'completed').length,
    }),
    [downloads],
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-dark-800 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-bold gradient-text-soul" style={{ fontFamily: 'Cinzel, serif' }}>
            Download Manager
          </h1>
          <div className="flex items-center gap-3 text-xs text-dark-400">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              {activeCount} attivi
            </span>
            <span>·</span>
            <span className="text-green-400">{completedCount} completati</span>
            <span>·</span>
            <span>{grouped.failed.length} falliti</span>
          </div>
        </div>

        {/* Overall progress */}
        {activeCount > 0 && (
          <div>
            <div className="flex justify-between text-xs text-dark-400 mb-1">
              <span>Progresso totale</span>
              <span className="font-mono">
                {(totalDone / 1024 / 1024 / 1024).toFixed(2)} /{(totalSize / 1024 / 1024 / 1024).toFixed(2)}{' '}
                GB
              </span>
            </div>
            <div className="h-1.5 bg-dark-700 rounded-full overflow-hidden">
              <div
                className="progress-shimmer h-full rounded-full transition-all duration-500"
                style={{ width: totalSize > 0 ? `${(totalDone / totalSize) * 100}%` : '0%' }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Lists */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {grouped.active.length > 0 && (
          <Section title="In corso" icon={<Download size={14} className="text-blue-400" />}>
            {grouped.active.map((dl) => (
              <DownloadRow
                key={dl.id}
                dl={dl}
                prog={progress[dl.id]}
                iprog={installProgress[dl.id]}
                onControl={controlDownload}
              />
            ))}
          </Section>
        )}

        {grouped.paused.length > 0 && (
          <Section title="In pausa" icon={<Pause size={14} className="text-yellow-400" />}>
            {grouped.paused.map((dl) => (
              <DownloadRow key={dl.id} dl={dl} prog={progress[dl.id]} onControl={controlDownload} />
            ))}
          </Section>
        )}

        {grouped.pending.length > 0 && (
          <Section title="In attesa" icon={<Clock size={14} className="text-dark-400" />}>
            {grouped.pending.map((dl) => (
              <DownloadRow key={dl.id} dl={dl} onControl={controlDownload} />
            ))}
          </Section>
        )}

        {grouped.failed.length > 0 && (
          <Section title="Falliti" icon={<AlertCircle size={14} className="text-red-400" />}>
            {grouped.failed.map((dl) => (
              <DownloadRow key={dl.id} dl={dl} onControl={controlDownload} />
            ))}
          </Section>
        )}

        {grouped.completed.length > 0 && (
          <Section title="Completati" icon={<CheckCircle size={14} className="text-green-400" />}>
            {grouped.completed.map((dl) => (
              <DownloadRow key={dl.id} dl={dl} onControl={controlDownload} />
            ))}
          </Section>
        )}

        {downloads.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-dark-400">
            <Download size={44} className="mb-4 opacity-20" />
            <p className="text-sm">Nessun download presente</p>
            <p className="text-xs mt-1 opacity-60">Vai al Catalogo per aggiungere mod da scaricare</p>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-widest text-dark-400">
        {icon}
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

// memo: con centinaia/migliaia di righe (coda Nolvus-scale) un tick di progresso
// ri-renderizza SOLO la riga il cui progress è cambiato, non l'intera lista.
const DownloadRow = memo(function DownloadRow({
  dl,
  prog,
  iprog,
  onControl,
}: {
  dl: DL
  prog?: DownloadProgress
  iprog?: InstallProgress
  onControl: (id: number, action: 'pause' | 'resume' | 'cancel') => void
}) {
  const isInstalling = dl.status === 'installing'
  const percent = isInstalling
    ? (iprog?.percent ?? 0)
    : (prog?.percent ?? (dl.total_size > 0 ? Math.round((dl.downloaded_size / dl.total_size) * 100) : 0))
  const sizeMB = dl.total_size / 1024 / 1024
  const doneMB = (prog?.downloaded ?? dl.downloaded_size) / 1024 / 1024
  const installLabel =
    iprog?.stage === 'verifying'
      ? 'Verifica integrità…'
      : iprog?.stage === 'extracting'
        ? `Estrazione ${iprog.percent}%`
        : 'Installazione…'

  const statusColor =
    {
      downloading: 'text-blue-400',
      installing: 'text-purple-400',
      completed: 'text-green-400',
      failed: 'text-red-400',
      paused: 'text-yellow-400',
      pending: 'text-dark-400',
    }[dl.status] ?? 'text-dark-400'

  const statusLabel =
    {
      downloading: 'Download...',
      installing: installLabel,
      completed: 'Completato',
      failed: 'Fallito',
      paused: 'In pausa',
      pending: 'In attesa',
    }[dl.status] ?? dl.status

  return (
    <div
      className={clsx(
        'card p-3 flex items-start gap-3',
        dl.status === 'failed' && 'border-red-900/40',
        dl.status === 'completed' && 'border-green-900/30',
      )}
    >
      {/* Status icon */}
      <div
        className={clsx(
          'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
          dl.status === 'downloading'
            ? 'bg-blue-900/30'
            : dl.status === 'completed'
              ? 'bg-green-900/30'
              : dl.status === 'failed'
                ? 'bg-red-900/30'
                : 'bg-dark-700',
        )}
      >
        {dl.status === 'downloading' && <Download size={16} className="text-blue-400 animate-bounce" />}
        {dl.status === 'completed' && <CheckCircle size={16} className="text-green-400" />}
        {dl.status === 'failed' && <AlertCircle size={16} className="text-red-400" />}
        {dl.status === 'paused' && <Pause size={16} className="text-yellow-400" />}
        {dl.status === 'pending' && <Clock size={16} className="text-dark-400" />}
        {dl.status === 'installing' && <Download size={16} className="text-purple-400 animate-pulse" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-white/85 truncate">{dl.name}</span>
          <span className={clsx('text-xs flex-shrink-0', statusColor)}>{statusLabel}</span>
        </div>

        {dl.status === 'downloading' || dl.status === 'installing' ? (
          <>
            <div className="flex items-center justify-between text-xs text-dark-400 mt-1 mb-1.5">
              <span className="font-mono">
                {isInstalling
                  ? iprog?.stage === 'verifying'
                    ? 'Verifica integrità…'
                    : 'Estrazione archivio'
                  : `${doneMB.toFixed(0)} / ${sizeMB.toFixed(0)} MB`}
              </span>
              <span>{percent}%</span>
            </div>
            <div className="h-1.5 bg-dark-700 rounded-full overflow-hidden">
              <div
                className="progress-shimmer h-full rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          </>
        ) : (
          <div className="text-xs text-dark-400 mt-0.5">
            {sizeMB > 0
              ? `${sizeMB >= 1024 ? (sizeMB / 1024).toFixed(1) + ' GB' : sizeMB.toFixed(0) + ' MB'}`
              : ''}
            {dl.error && <span className="text-red-400 ml-2">{dl.error}</span>}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {dl.status === 'downloading' && (
          <button
            title="Pausa"
            onClick={() => onControl(dl.id, 'pause')}
            className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-yellow-400 hover:bg-yellow-900/20 transition-all"
          >
            <Pause size={13} />
          </button>
        )}
        {(dl.status === 'paused' || dl.status === 'failed') && (
          <button
            title="Riprendi"
            onClick={() => onControl(dl.id, 'resume')}
            className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-green-400 hover:bg-green-900/20 transition-all"
          >
            <Play size={13} />
          </button>
        )}
        {dl.status === 'completed' && dl.file_path && (
          <button
            onClick={() => window.api.fs.openDownload(dl.id)}
            title="Apri cartella"
            className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-soul-400 hover:bg-soul-900/20 transition-all"
          >
            <FolderOpen size={13} />
          </button>
        )}
        {dl.status !== 'completed' && (
          <button
            title="Annulla"
            onClick={() => onControl(dl.id, 'cancel')}
            className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-red-400 hover:bg-red-900/20 transition-all"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  )
})
