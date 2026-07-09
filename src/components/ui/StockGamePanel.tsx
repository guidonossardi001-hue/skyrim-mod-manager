import { useEffect, useRef, useState, useCallback } from 'react'
import { HardDrive, Copy, Link2, ShieldCheck, AlertTriangle, Loader2, FolderGit2 } from 'lucide-react'
import type { StockGameDetect, StockGameProgress, StockGameResult } from '@/types'

const GB = 1024 ** 3,
  MB = 1024 ** 2
const fmt = (b: number) => (b >= GB ? `${(b / GB).toFixed(2)} GB` : `${(b / MB).toFixed(0)} MB`)

// Narrow accessor for the preload bridge — undefined in the browser preview / mock,
// so every call is guarded and the panel degrades to an informative disabled state.
type Bridge = {
  stockGame?: {
    detect(): Promise<StockGameDetect>
    create(opts?: { mode?: 'hardlink' | 'copy' }): Promise<StockGameResult>
  }
  on?: (ch: string, cb: (...a: unknown[]) => void) => ((...a: unknown[]) => void) | void
  off?: (ch: string, cb: unknown) => void
}
const bridge = (): Bridge | null => (typeof window !== 'undefined' ? (window.api as unknown as Bridge) : null)

export function StockGamePanel({ onLog }: { onLog?: (msg: string) => void }) {
  const [detect, setDetect] = useState<StockGameDetect | null>(null)
  const [mode, setMode] = useState<'hardlink' | 'copy'>('hardlink')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<StockGameProgress | null>(null)
  const [result, setResult] = useState<StockGameResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const available = !!bridge()?.stockGame

  // initial detect (read-only) + live progress subscription
  useEffect(() => {
    const api = bridge()
    if (!api?.stockGame) return
    api.stockGame
      .detect()
      .then(setDetect)
      .catch((e) => setError(String(e?.message ?? e)))
    const handler = (p: unknown) => setProgress(p as StockGameProgress)
    const w = api.on?.('stockgame:progress', handler as (...a: unknown[]) => void)
    return () => {
      if (w) api.off?.('stockgame:progress', w)
    }
  }, [])

  const create = useCallback(async () => {
    const api = bridge()
    if (!api?.stockGame || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    setProgress(null)
    onLog?.(`StockGame: avvio creazione (${mode})…`)
    try {
      const res = await api.stockGame.create({ mode })
      setResult(res)
      onLog?.(
        `StockGame pronto: ${res.filesTotal} file (${res.hardlinked} hardlink, ${res.copied} copie), ${fmt(res.bytesTotal)}${res.missingRequired.length ? ` — ATTENZIONE mancano ${res.missingRequired.join(', ')}` : ''}`,
      )
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      setError(msg)
      onLog?.(`StockGame ERRORE: ${msg}`)
    } finally {
      setBusy(false)
    }
  }, [mode, busy, onLog])

  const pct =
    progress && progress.bytesTotal > 0
      ? Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100)
      : busy
        ? 2
        : 0
  const phaseLabel: Record<StockGameProgress['phase'], string> = {
    scanning: 'Analisi sorgente…',
    copying: mode === 'hardlink' ? 'Collegamento file vanilla…' : 'Copia file vanilla…',
    verifying: 'Verifica file richiesti…',
    done: 'Completato',
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/3 p-5">
      <div className="flex items-center gap-2 mb-3">
        <FolderGit2 size={18} className="text-soul-400" />
        <h3 className="text-sm font-bold text-dark-100" style={{ fontFamily: 'Cinzel, serif' }}>
          StockGame — copia vanilla isolata
        </h3>
      </div>

      {!available && (
        <p className="text-xs text-orange-400/80 flex items-center gap-2">
          <AlertTriangle size={14} /> Disponibile solo nell'app desktop (non nell'anteprima browser).
        </p>
      )}

      {available && (
        <>
          {/* source / target / size estimate */}
          <div className="grid grid-cols-2 gap-3 text-xs mb-4">
            <Field label="Sorgente (Steam)" value={detect?.source ?? '— non rilevata —'} mono />
            <Field label="Destinazione isolata" value={detect?.target ?? '…'} mono />
            <Field
              label="Vanilla da copiare"
              value={detect?.plan ? `${detect.plan.files} file · ${fmt(detect.plan.totalBytes)}` : '…'}
            />
            <Field label="Mod scartati" value={detect?.plan ? `${detect.plan.skippedFiles} elementi` : '…'} />
          </div>

          {/* mode selector */}
          <div className="flex gap-2 mb-4">
            <ModeBtn
              active={mode === 'hardlink'}
              onClick={() => setMode('hardlink')}
              icon={<Link2 size={14} />}
              title="Hardlink"
              sub="0 byte extra (stesso disco)"
              disabled={busy}
            />
            <ModeBtn
              active={mode === 'copy'}
              onClick={() => setMode('copy')}
              icon={<Copy size={14} />}
              title="Copia"
              sub="byte indipendenti"
              disabled={busy}
            />
          </div>

          {/* progress bar */}
          {(busy || progress) && (
            <div className="mb-3">
              <div className="flex justify-between text-xs text-dark-400 mb-1">
                <span>{progress ? phaseLabel[progress.phase] : 'Avvio…'}</span>
                <span>
                  {progress
                    ? `${progress.filesDone}/${progress.filesTotal} · ${fmt(progress.bytesDone)}`
                    : ''}
                </span>
              </div>
              <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${pct}%`,
                    background: 'linear-gradient(90deg,#7d4dff,#4d7dff)',
                    boxShadow: '0 0 10px rgba(125,77,255,0.5)',
                  }}
                />
              </div>
            </div>
          )}

          {/* result / error */}
          {result && (
            <div
              className={`text-xs rounded-lg p-3 mb-3 flex items-start gap-2 ${result.missingRequired.length ? 'bg-orange-500/10 text-orange-300' : 'bg-green-500/10 text-green-300'}`}
            >
              {result.missingRequired.length ? (
                <AlertTriangle size={14} className="mt-0.5" />
              ) : (
                <ShieldCheck size={14} className="mt-0.5" />
              )}
              <span>
                {result.filesTotal} file · {fmt(result.bytesTotal)} · {result.hardlinked} hardlink,{' '}
                {result.copied} copie, {result.alreadyPresent} già presenti · scartati {result.skippedFiles}{' '}
                mod
                {result.missingRequired.length > 0 && (
                  <>
                    <br />
                    Mancano file vanilla richiesti: {result.missingRequired.join(', ')}
                  </>
                )}
              </span>
            </div>
          )}
          {error && (
            <p className="text-xs text-red-400 mb-3 flex items-center gap-2">
              <AlertTriangle size={14} /> {error}
            </p>
          )}

          <button
            onClick={create}
            disabled={busy || !detect?.source}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold text-sm text-white disabled:opacity-50 transition-all"
            style={{ background: 'linear-gradient(90deg,#7d4dff,#4d7dff)' }}
          >
            {busy ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Creazione in corso…
              </>
            ) : (
              <>
                <HardDrive size={16} /> Crea StockGame
              </>
            )}
          </button>
        </>
      )}
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-dark-500 mb-0.5">{label}</div>
      <div className={`text-dark-200 truncate ${mono ? 'font-mono text-[11px]' : ''}`} title={value}>
        {value}
      </div>
    </div>
  )
}

function ModeBtn({
  active,
  onClick,
  icon,
  title,
  sub,
  disabled,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  sub: string
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-all disabled:opacity-50 ${active ? 'border-soul-500/60 bg-soul-500/10' : 'border-white/10 bg-white/3 hover:border-white/20'}`}
    >
      <span className={active ? 'text-soul-300' : 'text-dark-400'}>{icon}</span>
      <span className="leading-tight">
        <span className="block text-xs font-semibold text-dark-100">{title}</span>
        <span className="block text-[10px] text-dark-500">{sub}</span>
      </span>
    </button>
  )
}
