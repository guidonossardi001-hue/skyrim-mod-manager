import { Minus, Square, X, ChevronDown } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/appStore'

export default function TitleBar() {
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  // Sempre montata: selettore shallow per non ri-renderizzare a ogni set() dello store.
  const { profiles, activeProfileId, setActiveProfile } = useAppStore(
    useShallow((s) => ({
      profiles: s.profiles,
      activeProfileId: s.activeProfileId,
      setActiveProfile: s.setActiveProfile,
    })),
  )
  const activeProfile = profiles.find((p) => p.id === activeProfileId)

  // Close the profile menu on any outside click.
  useEffect(() => {
    if (!profileMenuOpen) return
    const close = () => setProfileMenuOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [profileMenuOpen])

  const handleMaximize = () => window.api.window.maximize()

  return (
    <div
      className="titlebar-drag h-10 flex items-center justify-between px-4 flex-shrink-0"
      style={{ background: 'rgba(5,5,7,0.95)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
    >
      {/* Left: logo + title */}
      <div className="flex items-center gap-3">
        <div
          className="w-6 h-6 rounded flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, #7d4dff, #4d7dff)' }}
        >
          <span className="text-xs font-bold text-white">S</span>
        </div>
        <span
          className="text-sm font-semibold text-white/80"
          style={{ fontFamily: 'Cinzel, serif', letterSpacing: '0.05em' }}
        >
          Skyrim AE Mod Manager
        </span>
        <span className="text-dark-400 text-xs">v1.0.0</span>
      </div>

      {/* Center: active profile selector */}
      <div className="titlebar-no-drag relative">
        <button
          onClick={(e) => {
            e.stopPropagation()
            setProfileMenuOpen((o) => !o)
          }}
          className="flex items-center gap-1.5 px-3 py-1 rounded-md cursor-pointer hover:bg-white/5 transition-colors text-xs text-dark-300"
          title="Cambia profilo"
        >
          <span className="text-white/60">Profilo:</span>
          <span className="text-white/90 font-medium">{activeProfile?.name ?? '—'}</span>
          <ChevronDown
            size={12}
            className={`text-white/40 transition-transform ${profileMenuOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {profileMenuOpen && (
          <div
            className="absolute top-full left-1/2 -translate-x-1/2 mt-1 min-w-48 rounded-lg py-1 z-50 shadow-2xl"
            style={{ background: 'rgba(15,15,20,0.98)', border: '1px solid rgba(255,255,255,0.1)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setActiveProfile(p.id)
                  setProfileMenuOpen(false)
                }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-white/8 ${
                  p.id === activeProfileId ? 'text-void-300 font-medium' : 'text-dark-300'
                }`}
              >
                {p.id === activeProfileId ? '● ' : '○ '}
                {p.name}
              </button>
            ))}
            {profiles.length === 0 && <div className="px-3 py-1.5 text-xs text-dark-500">Nessun profilo</div>}
          </div>
        )}
      </div>

      {/* Right: window controls */}
      <div className="titlebar-no-drag flex items-center gap-0.5">
        <button
          onClick={() => window.api.window.minimize()}
          className="w-8 h-8 flex items-center justify-center rounded text-dark-300 hover:text-white hover:bg-white/10 transition-all"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={handleMaximize}
          className="w-8 h-8 flex items-center justify-center rounded text-dark-300 hover:text-white hover:bg-white/10 transition-all"
        >
          <Square size={12} />
        </button>
        <button
          onClick={() => window.api.window.close()}
          className="w-8 h-8 flex items-center justify-center rounded text-dark-300 hover:text-white hover:bg-red-600 transition-all"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
