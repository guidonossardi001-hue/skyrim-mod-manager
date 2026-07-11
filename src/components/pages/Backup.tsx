import { useState, useEffect } from 'react'
import { useAppStore } from '@/store/appStore'
import { Archive, RotateCcw, Trash2, Clock, FolderOpen, Upload, Download } from 'lucide-react'
import { format } from 'date-fns'
import { it } from 'date-fns/locale'

interface BackupEntry {
  name: string
  path: string
  size: number
  date: string
}

export default function Backup() {
  const { activeProfileId, profiles } = useAppStore()
  const [backups, setBackups] = useState<BackupEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const profile = profiles.find((p) => p.id === activeProfileId)

  const loadBackups = async () => {
    const list = await (window.api as unknown as { backup: { list(): Promise<BackupEntry[]> } }).backup.list()
    setBackups(list)
  }

  useEffect(() => {
    loadBackups()
  }, [])

  const showMsg = (text: string, ok: boolean) => {
    setMessage({ text, ok })
    setTimeout(() => setMessage(null), 3000)
  }

  const createBackup = async () => {
    if (!activeProfileId) return
    setLoading(true)
    const r = await (
      window.api as unknown as {
        backup: { create(id: number, label?: string): Promise<{ success: boolean; name: string }> }
      }
    ).backup.create(activeProfileId, profile?.name.replace(/\s+/g, '_'))
    setLoading(false)
    if (r.success) {
      showMsg(`Backup creato: ${r.name}`, true)
      loadBackups()
    } else showMsg('Errore durante il backup', false)
  }

  const restoreBackup = async (backupPath: string) => {
    if (!activeProfileId) return
    if (!confirm('Ripristinare questo backup? Sostituirà tutte le mod del profilo attivo.')) return
    setLoading(true)
    const r = await (
      window.api as unknown as {
        backup: { restore(p: string, id: number): Promise<{ success: boolean; restored: number }> }
      }
    ).backup.restore(backupPath, activeProfileId)
    setLoading(false)
    if (r.success) {
      showMsg(`Ripristinate ${r.restored} mod`, true)
      await useAppStore.getState().loadMods()
    } else showMsg('Errore durante il ripristino', false)
  }

  const deleteBackup = async (backupPath: string, name: string) => {
    if (!confirm(`Eliminare il backup "${name}"?`)) return
    await (window.api as unknown as { backup: { delete(p: string): Promise<void> } }).backup.delete(
      backupPath,
    )
    loadBackups()
  }

  const importWabbajack = async () => {
    const path = await window.api.fs.pickFile('Seleziona file .wabbajack', [
      { name: 'Wabbajack', extensions: ['wabbajack'] },
    ])
    if (!path || !activeProfileId) return
    setLoading(true)
    const r = await (
      window.api as unknown as {
        wabbajack: {
          parse(
            p: string,
            id: number,
          ): Promise<{ success: boolean; name?: string; imported?: number; error?: string }>
        }
      }
    ).wabbajack.parse(path, activeProfileId)
    setLoading(false)
    if (r.success) showMsg(`Importate ${r.imported} mod da "${r.name}"`, true)
    else showMsg(`Errore Wabbajack: ${r.error}`, false)
  }

  const exportWabbajack = async () => {
    if (!activeProfileId) return
    const path = await window.api.fs.pickFile('Salva come', [{ name: 'Wabbajack', extensions: ['json'] }])
    if (!path) return
    setLoading(true)
    const r = await (
      window.api as unknown as {
        wabbajack: { export(id: number, p: string): Promise<{ success: boolean; modCount?: number }> }
      }
    ).wabbajack.export(activeProfileId, path)
    setLoading(false)
    if (r.success) showMsg(`Esportate ${r.modCount} mod`, true)
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl">
      <h1 className="text-lg font-bold gradient-text-void mb-6" style={{ fontFamily: 'Cinzel, serif' }}>
        Backup & Ripristino
      </h1>

      {/* Message */}
      {message && (
        <div
          className={`mb-4 px-4 py-2 rounded-lg text-sm ${message.ok ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}
        >
          {message.text}
        </div>
      )}

      {/* Actions */}
      <div className="card p-4 mb-6">
        <h3 className="text-sm font-semibold text-white/70 mb-3">Azioni</h3>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={createBackup}
            disabled={loading || !activeProfileId}
            className="btn-primary flex items-center gap-2 justify-center"
          >
            <Archive size={14} />
            {loading ? 'Attendi...' : 'Crea Backup Ora'}
          </button>
          <button
            onClick={() => window.api.fs.revealFolder('backups')}
            className="btn-ghost flex items-center gap-2 justify-center"
          >
            <FolderOpen size={14} />
            Apri Cartella Backup
          </button>
          <button
            onClick={importWabbajack}
            disabled={loading}
            className="btn-ghost flex items-center gap-2 justify-center"
          >
            <Upload size={14} />
            Importa .wabbajack
          </button>
          <button
            onClick={exportWabbajack}
            disabled={loading}
            className="btn-ghost flex items-center gap-2 justify-center"
          >
            <Download size={14} />
            Esporta Manifest
          </button>
        </div>
      </div>

      {/* Backup list */}
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-white/70 mb-3 flex items-center gap-2">
          <Archive size={14} />
          Backup Salvati ({backups.length})
        </h3>

        {backups.length === 0 ? (
          <p className="text-dark-400 text-sm text-center py-6">
            Nessun backup presente. Crea il primo backup ora.
          </p>
        ) : (
          <div className="space-y-2">
            {backups.map((b) => (
              <div
                key={b.path}
                className="flex items-center gap-3 p-3 rounded-lg hover:bg-white/3 transition-colors"
              >
                <Archive size={16} className="text-void-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white/80 truncate">{b.name}</p>
                  <div className="flex items-center gap-2 text-xs text-dark-400 mt-0.5">
                    <Clock size={10} />
                    <span>{format(new Date(b.date), 'dd MMM yyyy HH:mm', { locale: it })}</span>
                    <span>·</span>
                    <span>{(b.size / 1024).toFixed(0)} KB</span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => restoreBackup(b.path)}
                    className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-green-400 hover:bg-green-900/20 transition-all"
                    title="Ripristina"
                  >
                    <RotateCcw size={13} />
                  </button>
                  <button
                    onClick={() => deleteBackup(b.path, b.name)}
                    className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-red-400 hover:bg-red-900/20 transition-all"
                    title="Elimina"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
