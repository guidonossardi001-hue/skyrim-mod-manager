import { useState, useCallback } from 'react'
import {
  Download,
  RefreshCw,
  ShieldCheck,
  PackagePlus,
  ArrowUpCircle,
  Trash2,
  MoveVertical,
  CheckCircle2,
  Sparkles,
  Lock,
} from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '@/store/appStore'
import { toast } from '@/components/ui/Toast'
import type { DeltaChangeRow } from '@/types'
// Catalogo di release reale firmato Ed25519 (file_id/file_hash/version per mod,
// prodotto da scripts/build_remote_catalog.mjs). In Electron viene verificato dal
// motore reale contro la chiave pinnata; nel preview browser il mock ne legge il tag.
import signedManifest from '../../../electron/delta/examples/catalog.remote.signed.json'

type Step = 'idle' | 'checked' | 'applying' | 'applied'

const CHANGE: Record<string, { icon: React.ElementType; cls: string; label: string }> = {
  added: { icon: PackagePlus, cls: 'text-green-400 bg-green-900/30', label: 'Nuova' },
  changed: { icon: ArrowUpCircle, cls: 'text-void-400 bg-void-900/30', label: 'Aggiornata' },
  removed: { icon: Trash2, cls: 'text-red-400 bg-red-900/30', label: 'Rimossa' },
  reordered: { icon: MoveVertical, cls: 'text-orange-400 bg-orange-900/30', label: 'Riordino' },
}

export default function Updates() {
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const loadMods = useAppStore((s) => s.loadMods)
  const markDriftFromChangeset = useAppStore((s) => s.markDriftFromChangeset)
  const catalogUrl = useAppStore((s) => s.settings.catalogUrl)
  const profileId = activeProfileId ?? 1

  const [step, setStep] = useState<Step>('idle')
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<'bundle' | 'remoto'>('bundle')
  const [releaseTag, setReleaseTag] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [rows, setRows] = useState<DeltaChangeRow[]>([])
  const [appliedCount, setAppliedCount] = useState(0)

  const total = rows.length
  const pending =
    (counts.added ?? 0) + (counts.changed ?? 0) + (counts.removed ?? 0) + (counts.reordered ?? 0)

  const handleCheck = useCallback(async () => {
    setBusy(true)
    try {
      // Act-03: if a remote catalog URL is configured, fetch it over real HTTPS and
      // verify the signature server-side; otherwise ingest the bundled signed artifact.
      const ingest = catalogUrl
        ? await window.api.delta.ingestUrl(catalogUrl)
        : await window.api.delta.ingest(signedManifest)
      if (!ingest.success) {
        toast.error('Catalogo rifiutato', ingest.error ?? 'firma non valida')
        return
      }
      setSource(catalogUrl ? 'remoto' : 'bundle')
      setReleaseTag(
        (signedManifest as { manifest?: { release_tag?: string } }).manifest?.release_tag ?? '2026.06-core',
      )
      const check = await window.api.delta.check(profileId)
      if (!check.ok) {
        toast.error('Controllo fallito', check.error ?? 'nessuna release')
        return
      }
      const list = await window.api.delta.list(profileId, check.toReleaseId ?? 1)
      setCounts(check.counts ?? {})
      setRows(list)
      markDriftFromChangeset(list) // light up "update disponibile" badges app-wide
      setStep('checked')
      const n = Object.values(check.counts ?? {}).reduce((a, b) => a + b, 0)
      toast.success(
        n > 0 ? `${n} modifiche disponibili` : 'Sei aggiornato',
        `Release ${(signedManifest as { manifest?: { release_tag?: string } }).manifest?.release_tag ?? ''}`,
      )
    } catch (e) {
      toast.error('Errore controllo aggiornamenti', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [profileId, markDriftFromChangeset, catalogUrl])

  const handleApply = useCallback(async () => {
    setBusy(true)
    setStep('applying')
    try {
      const toReleaseId = 1
      const apply = await window.api.delta.apply(profileId, toReleaseId)
      const fin = await window.api.delta.finalize(profileId, toReleaseId)
      setAppliedCount(fin.applied ?? apply.queued)
      const list = await window.api.delta.list(profileId, toReleaseId)
      setRows(list)
      await loadMods(profileId)
      setStep('applied')
      toast.success(
        'Aggiornamento applicato',
        `${fin.applied ?? apply.queued} modifiche commit nello snapshot`,
      )
    } catch (e) {
      toast.error('Apply fallito', (e as Error).message)
      setStep('checked')
    } finally {
      setBusy(false)
    }
  }, [profileId, loadMods])

  const reset = () => {
    setStep('idle')
    setRows([])
    setCounts({})
    setReleaseTag(null)
    setAppliedCount(0)
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1
            className="text-lg font-bold"
            style={{
              fontFamily: 'Cinzel, serif',
              background: 'linear-gradient(135deg, #7d4dff, #4d7dff)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            Aggiornamenti
          </h1>
          <p className="text-xs text-dark-400 mt-1 flex items-center gap-1.5">
            <Lock size={11} className="text-green-400" />
            Motore delta: manifest firmato Ed25519, applicazione atomica e gated (fail-closed).
          </p>
        </div>
        {step !== 'idle' && (
          <button onClick={reset} className="btn-ghost flex items-center gap-2 text-sm">
            <RefreshCw size={14} /> Ricomincia
          </button>
        )}
      </div>

      {/* Stepper */}
      <Stepper step={step} />

      {step === 'idle' && (
        <div className="card p-10 flex flex-col items-center text-center">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: 'linear-gradient(135deg, rgba(125,77,255,0.25), rgba(77,125,255,0.2))' }}
          >
            <Download size={26} className="text-void-300" />
          </div>
          <h3 className="text-lg font-semibold text-white/85">Controlla gli aggiornamenti della modlist</h3>
          <p className="text-dark-400 text-sm mt-2 max-w-md">
            Verifica il manifest firmato della release più recente e calcola il delta rispetto allo snapshot
            installato del profilo attivo.
          </p>
          <button
            onClick={handleCheck}
            disabled={busy}
            className="btn-primary flex items-center gap-2 mt-5 disabled:opacity-50"
          >
            {busy ? <RefreshCw size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            Controlla aggiornamenti
          </button>
        </div>
      )}

      {step !== 'idle' && (
        <>
          {/* Release + counts */}
          <div className="grid grid-cols-5 gap-3 mb-5">
            <div className="card p-4 col-span-1">
              <div className="flex items-center justify-between">
                <Sparkles size={16} className="text-void-400" />
                <span className="text-sm font-bold text-white truncate" title={releaseTag ?? ''}>
                  {releaseTag ?? '—'}
                </span>
              </div>
              <p className="text-xs text-dark-400 mt-1">
                Release verificata{' '}
                <span className="text-void-400">· {source === 'remoto' ? 'fetch HTTPS' : 'bundle'}</span>
              </p>
            </div>
            <CountChip type="added" n={counts.added ?? 0} />
            <CountChip type="changed" n={counts.changed ?? 0} />
            <CountChip type="reordered" n={counts.reordered ?? 0} />
            <CountChip type="removed" n={counts.removed ?? 0} />
          </div>

          {/* Changeset */}
          {pending === 0 ? (
            <div className="card p-10 flex flex-col items-center text-center">
              <CheckCircle2 size={48} className="text-green-400 mb-4" />
              <h3 className="text-lg font-semibold text-white/80">Modlist già aggiornata</h3>
              <p className="text-dark-400 text-sm mt-2">
                Lo snapshot installato corrisponde all'ultima release.
              </p>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-dark-800 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-widest text-dark-300">
                  Changeset ({total})
                </h3>
                {step === 'applied' ? (
                  <span className="text-xs text-green-400 flex items-center gap-1">
                    <CheckCircle2 size={12} /> {appliedCount} applicate
                  </span>
                ) : (
                  <span className="text-xs text-dark-500">in attesa di applicazione</span>
                )}
              </div>
              <div className="divide-y divide-dark-800/70">
                {rows.map((r) => (
                  <ChangeRow key={r.id} r={r} />
                ))}
              </div>
            </div>
          )}

          {/* Apply CTA */}
          {pending > 0 && step !== 'applied' && (
            <div className="flex items-center justify-end gap-3 mt-5">
              <p className="text-xs text-dark-400">
                L'apply scarica gli archivi e committa lo snapshot in modo atomico.
              </p>
              <button
                onClick={handleApply}
                disabled={busy}
                className="btn-primary flex items-center gap-2 disabled:opacity-50"
              >
                {step === 'applying' ? (
                  <>
                    <RefreshCw size={15} className="animate-spin" /> Applicazione…
                  </>
                ) : (
                  <>
                    <Download size={15} /> Scarica e applica
                  </>
                )}
              </button>
            </div>
          )}

          {step === 'applied' && (
            <div
              className="card p-4 mt-5 flex items-center gap-3"
              style={{ borderColor: 'rgba(74,222,128,0.3)' }}
            >
              <ShieldCheck size={18} className="text-green-400" />
              <p className="text-sm text-white/80">
                Commit gated completato. La lista mod e i download riflettono la nuova release.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Stepper({ step }: { step: Step }) {
  const stages = [
    { id: 'check', label: 'Verifica firma', done: step !== 'idle' },
    {
      id: 'diff',
      label: 'Calcolo delta',
      done: step === 'checked' || step === 'applying' || step === 'applied',
    },
    { id: 'apply', label: 'Download', done: step === 'applying' || step === 'applied' },
    { id: 'commit', label: 'Commit snapshot', done: step === 'applied' },
  ]
  return (
    <div className="flex items-center gap-2 mb-6">
      {stages.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2 flex-1">
          <div
            className={clsx(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs w-full',
              s.done ? 'bg-void-900/30 text-void-200' : 'bg-dark-800/60 text-dark-500',
            )}
          >
            <span
              className={clsx(
                'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold',
                s.done ? 'bg-void-500 text-white' : 'bg-dark-700 text-dark-400',
              )}
            >
              {s.done ? '✓' : i + 1}
            </span>
            {s.label}
          </div>
          {i < stages.length - 1 && (
            <div className={clsx('h-px w-3 flex-shrink-0', s.done ? 'bg-void-500/50' : 'bg-dark-700')} />
          )}
        </div>
      ))}
    </div>
  )
}

function CountChip({ type, n }: { type: string; n: number }) {
  const cfg = CHANGE[type]
  return (
    <div className={clsx('card p-4', n === 0 && 'opacity-50')}>
      <div className="flex items-center justify-between">
        <cfg.icon size={16} className={cfg.cls.split(' ')[0]} />
        <span className="text-xl font-bold text-white">{n}</span>
      </div>
      <p className="text-xs text-dark-400 mt-1">{cfg.label}</p>
    </div>
  )
}

function ChangeRow({ r }: { r: DeltaChangeRow }) {
  const cfg = CHANGE[r.change_type] ?? CHANGE.changed
  const name = r.name ?? r.to_file_name ?? `Mod #${r.nexus_id}`
  const applied = r.status === 'applied'
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span
        className={clsx(
          'text-[10px] font-bold px-2 py-1 rounded flex items-center gap-1 flex-shrink-0',
          cfg.cls,
        )}
      >
        <cfg.icon size={11} /> {cfg.label}
      </span>
      <span className="text-sm text-white/85 flex-1 min-w-0 truncate">{name}</span>
      {r.change_type === 'changed' && (
        <span className="text-xs text-dark-400 flex-shrink-0">
          {r.from_version ?? '?'} <span className="text-void-400">→</span> {r.to_version ?? '?'}
        </span>
      )}
      {r.change_type === 'added' && r.to_version && (
        <span className="text-xs text-dark-400 flex-shrink-0">v{r.to_version}</span>
      )}
      {applied ? (
        <CheckCircle2 size={14} className="text-green-400 flex-shrink-0" />
      ) : (
        <span className="text-[10px] text-dark-500 flex-shrink-0">{r.status}</span>
      )}
    </div>
  )
}
