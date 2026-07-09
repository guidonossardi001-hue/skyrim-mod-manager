import { useState, useMemo, useEffect } from 'react'
import {
  Plus,
  Trash2,
  Edit3,
  Check,
  X,
  Shield,
  FolderOpen,
  GitCompare,
  MinusCircle,
  PlusCircle,
} from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import type { Mod } from '@/types'
import { clsx } from 'clsx'

export default function Profiles() {
  const { profiles, activeProfileId, setActiveProfile, createProfile, updateProfile, deleteProfile } =
    useAppStore()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [compareA, setCompareA] = useState<number | null>(null)
  const [compareB, setCompareB] = useState<number | null>(null)
  const [showCompare, setShowCompare] = useState(false)
  const [modsA, setModsA] = useState<Mod[]>([])
  const [modsB, setModsB] = useState<Mod[]>([])

  // The global store only holds the ACTIVE profile's mods, so comparing two
  // arbitrary profiles requires fetching each profile's mods directly.
  useEffect(() => {
    if (compareA) window.api.mods.list(compareA).then(setModsA)
    else setModsA([])
  }, [compareA])
  useEffect(() => {
    if (compareB) window.api.mods.list(compareB).then(setModsB)
    else setModsB([])
  }, [compareB])

  const handleCreate = async () => {
    if (!newName.trim()) return
    await createProfile(newName.trim(), newDesc.trim())
    setCreating(false)
    setNewName('')
    setNewDesc('')
  }

  const handleRename = async (id: number) => {
    if (!editName.trim()) return
    await updateProfile(id, { name: editName.trim() } as never)
    setEditingId(null)
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Eliminare il profilo e tutte le sue mod? Questa azione è irreversibile.')) return
    await deleteProfile(id)
  }

  const setPath = async (id: number, field: 'game_path' | 'mo2_path') => {
    const path = await window.api.fs.pickDirectory(
      `Seleziona ${field === 'game_path' ? 'cartella Skyrim' : 'cartella MO2'}`,
    )
    if (path) await updateProfile(id, { [field]: path } as never)
  }

  const compareDiff = useMemo(() => {
    if (!compareA || !compareB) return null
    const modNamesA = new Set(modsA.map((m) => m.name))
    const modNamesB = new Set(modsB.map((m) => m.name))
    const onlyInA = [...modNamesA].filter((n) => !modNamesB.has(n))
    const onlyInB = [...modNamesB].filter((n) => !modNamesA.has(n))
    const common = [...modNamesA].filter((n) => modNamesB.has(n))
    return { onlyInA, onlyInB, common }
  }, [compareA, compareB, modsA, modsB])

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-bold gradient-text-void" style={{ fontFamily: 'Cinzel, serif' }}>
          Gestione Profili
        </h1>
        <div className="flex gap-2">
          {profiles.length >= 2 && (
            <button
              onClick={() => setShowCompare((v) => !v)}
              className="btn-ghost flex items-center gap-2 text-sm"
            >
              <GitCompare size={14} /> Confronta
            </button>
          )}
          <button onClick={() => setCreating(true)} className="btn-primary flex items-center gap-2">
            <Plus size={14} /> Nuovo Profilo
          </button>
        </div>
      </div>

      {/* Profile comparison */}
      {showCompare && profiles.length >= 2 && (
        <div className="card p-4 mb-4 border-soul-800/40">
          <h3 className="text-sm font-semibold text-white/80 mb-3 flex items-center gap-2">
            <GitCompare size={14} className="text-soul-400" /> Confronta Profili
          </h3>
          <div className="flex gap-3 mb-4">
            <select
              value={compareA ?? ''}
              onChange={(e) => setCompareA(Number(e.target.value) || null)}
              className="input-field flex-1 text-xs"
            >
              <option value="">Profilo A</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={compareB ?? ''}
              onChange={(e) => setCompareB(Number(e.target.value) || null)}
              className="input-field flex-1 text-xs"
            >
              <option value="">Profilo B</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {compareDiff && compareA !== compareB && (
            <div className="space-y-3 text-xs">
              {compareDiff.onlyInA.length > 0 && (
                <div>
                  <p className="text-red-400 font-semibold mb-1 flex items-center gap-1">
                    <MinusCircle size={11} /> Solo in {profiles.find((p) => p.id === compareA)?.name} (
                    {compareDiff.onlyInA.length})
                  </p>
                  <div className="space-y-0.5 max-h-24 overflow-y-auto">
                    {compareDiff.onlyInA.map((n) => (
                      <p key={n} className="text-red-300/70 pl-3">
                        {n}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {compareDiff.onlyInB.length > 0 && (
                <div>
                  <p className="text-green-400 font-semibold mb-1 flex items-center gap-1">
                    <PlusCircle size={11} /> Solo in {profiles.find((p) => p.id === compareB)?.name} (
                    {compareDiff.onlyInB.length})
                  </p>
                  <div className="space-y-0.5 max-h-24 overflow-y-auto">
                    {compareDiff.onlyInB.map((n) => (
                      <p key={n} className="text-green-300/70 pl-3">
                        {n}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-dark-400">{compareDiff.common.length} mod in comune</p>
            </div>
          )}
        </div>
      )}

      {/* Create form */}
      {creating && (
        <div className="card p-4 mb-4 border-void-800/50">
          <h3 className="text-sm font-semibold text-white/80 mb-3">Nuovo Profilo</h3>
          <div className="space-y-3">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nome profilo (es. Anime Fantasy v2)"
              className="input-field"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <input
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Descrizione (opzionale)"
              className="input-field"
            />
            <div className="flex gap-2">
              <button onClick={handleCreate} className="btn-primary flex items-center gap-2">
                <Check size={14} />
                Crea
              </button>
              <button onClick={() => setCreating(false)} className="btn-ghost flex items-center gap-2">
                <X size={14} />
                Annulla
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Profile list */}
      <div className="space-y-3">
        {profiles.map((profile) => {
          const isActive = profile.id === activeProfileId
          const isEditing = editingId === profile.id

          return (
            <div
              key={profile.id}
              className={clsx('card p-4 transition-all', isActive && 'border-void-700/60')}
              style={isActive ? { boxShadow: '0 0 20px rgba(125,77,255,0.1)' } : {}}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div
                    className={clsx(
                      'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0',
                      isActive ? 'bg-void-900/60' : 'bg-dark-800',
                    )}
                  >
                    <Shield size={18} className={isActive ? 'text-void-400' : 'text-dark-400'} />
                  </div>

                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="input-field flex-1"
                          onKeyDown={(e) => e.key === 'Enter' && handleRename(profile.id)}
                        />
                        <button
                          onClick={() => handleRename(profile.id)}
                          className="w-7 h-7 rounded flex items-center justify-center text-green-400 hover:bg-green-900/30"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:bg-white/5"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-white/90">{profile.name}</h3>
                        {isActive && <span className="tag tag-framework text-[10px] px-1.5">ATTIVO</span>}
                      </div>
                    )}

                    {profile.description && !isEditing && (
                      <p className="text-xs text-dark-400 mt-0.5">{profile.description}</p>
                    )}

                    {!isEditing && (
                      <div className="mt-2 space-y-1">
                        <PathDisplay
                          label="Skyrim"
                          value={profile.game_path}
                          onSet={() => setPath(profile.id, 'game_path')}
                        />
                        <PathDisplay
                          label="MO2"
                          value={profile.mo2_path}
                          onSet={() => setPath(profile.id, 'mo2_path')}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {!isActive && (
                    <button
                      onClick={() => setActiveProfile(profile.id)}
                      className="btn-ghost text-xs px-3 py-1.5"
                    >
                      Attiva
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setEditingId(profile.id)
                      setEditName(profile.name)
                    }}
                    className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-white hover:bg-white/5 transition-all"
                  >
                    <Edit3 size={13} />
                  </button>
                  {profiles.length > 1 && (
                    <button
                      onClick={() => handleDelete(profile.id)}
                      className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-red-400 hover:bg-red-900/30 transition-all"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PathDisplay({ label, value, onSet }: { label: string; value: string | null; onSet: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-dark-500 w-12 flex-shrink-0">{label}:</span>
      {value ? (
        <span className="text-green-400/80 font-mono truncate">{value}</span>
      ) : (
        <button
          onClick={onSet}
          className="text-orange-400/70 hover:text-orange-400 flex items-center gap-1 transition-colors"
        >
          <FolderOpen size={11} />
          Configura
        </button>
      )}
    </div>
  )
}
