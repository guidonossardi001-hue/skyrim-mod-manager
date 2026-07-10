import { useEffect, Suspense, lazy, Component, ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import TitleBar from '@/components/layout/TitleBar'
import Sidebar from '@/components/layout/Sidebar'
import { useAppStore } from '@/store/appStore'
import { ToastContainer } from '@/components/ui/Toast'
import { toast } from '@/lib/toast'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null }
  static getDerivedStateFromError(e: Error) {
    return { error: e.message }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="text-red-400 text-4xl">⚠</div>
          <p className="text-white/80 font-semibold">Errore nel componente</p>
          <pre className="text-red-300 text-xs bg-dark-800 rounded-lg p-4 max-w-xl text-left whitespace-pre-wrap">
            {this.state.error}
          </pre>
          <button onClick={() => this.setState({ error: null })} className="btn-ghost text-sm">
            Riprova
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const Dashboard = lazy(() => import('@/components/pages/Dashboard'))
const ModList = lazy(() => import('@/components/pages/ModList'))
const Catalog = lazy(() => import('@/components/pages/Catalog'))
const Downloads = lazy(() => import('@/components/pages/Downloads'))
const Settings = lazy(() => import('@/components/pages/Settings'))
const Profiles = lazy(() => import('@/components/pages/Profiles'))
const Tools = lazy(() => import('@/components/pages/Tools'))
const Conflicts = lazy(() => import('@/components/pages/Conflicts'))
const Stats = lazy(() => import('@/components/pages/Stats'))
const Docs = lazy(() => import('@/components/pages/Docs'))
const Backup = lazy(() => import('@/components/pages/Backup'))
const Plugins = lazy(() => import('@/components/pages/Plugins'))
const Updates = lazy(() => import('@/components/pages/Updates'))
const Compatibility = lazy(() => import('@/components/pages/Compatibility'))

function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-dark-400">
        <div className="w-8 h-8 rounded-full border-2 border-void-500/30 border-t-void-500 animate-spin" />
        <p className="text-sm">Caricamento...</p>
      </div>
    </div>
  )
}

function Page({ id }: { id: string }) {
  switch (id) {
    case 'dashboard':
      return <Dashboard />
    case 'modlist':
      return <ModList />
    case 'catalog':
      return <Catalog />
    case 'downloads':
      return <Downloads />
    case 'settings':
      return <Settings />
    case 'profiles':
      return <Profiles />
    case 'tools':
      return <Tools />
    case 'conflicts':
      return <Conflicts />
    case 'stats':
      return <Stats />
    case 'docs':
      return <Docs />
    case 'backup':
      return <Backup />
    case 'plugins':
      return <Plugins />
    case 'updates':
      return <Updates />
    case 'compatibility':
      return <Compatibility />
    default:
      return (
        <div className="flex-1 flex items-center justify-center text-dark-400">
          <p>Pagina "{id}" in sviluppo</p>
        </div>
      )
  }
}

export default function App() {
  // Selettore shallow: App è sempre montata — senza selettore ogni set() dello
  // store (incluse le righe di log) ri-renderizzava l'intero albero.
  const {
    activePage,
    loadProfiles,
    loadSettings,
    loadMods,
    loadCatalog,
    loadDownloads,
    isLoading,
    loadingMessage,
  } = useAppStore(
    useShallow((s) => ({
      activePage: s.activePage,
      loadProfiles: s.loadProfiles,
      loadSettings: s.loadSettings,
      loadMods: s.loadMods,
      loadCatalog: s.loadCatalog,
      loadDownloads: s.loadDownloads,
      isLoading: s.isLoading,
      loadingMessage: s.loadingMessage,
    })),
  )
  useKeyboardShortcuts()

  useEffect(() => {
    async function init() {
      useAppStore.getState().setLoading(true, 'Inizializzazione...')
      try {
        await loadSettings()
        await loadProfiles()
        const { activeProfileId } = useAppStore.getState()
        if (activeProfileId) {
          await loadMods(activeProfileId)
        }
        await loadCatalog()
      } catch (e) {
        // Un errore di bootstrap non deve lasciare l'app inchiodata sull'overlay.
        toast.error('Inizializzazione incompleta', (e as Error).message)
      } finally {
        useAppStore.getState().setLoading(false)
      }
    }
    init()
    // Mount-once bootstrap: the store action refs are stable (selected via useShallow),
    // so an empty dep array runs this exactly once — listing them changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // React to backend download/install events (Electron) so the mod list and
  // download list stay fresh no matter which page is open. No-op in the browser
  // mock (which has no IPC) — there the Downloads polling handles refresh.
  useEffect(() => {
    const api = window.api as unknown as {
      on?: (ch: string, cb: (...a: unknown[]) => void) => ((...a: unknown[]) => void) | void
      off?: (ch: string, cb: unknown) => void
    }
    if (!api?.on) return
    const refresh = () => {
      loadDownloads()
      const id = useAppStore.getState().activeProfileId
      if (id) loadMods(id)
    }
    // An nxm:// link (clicked on Nexus) was queued by the main process: surface it,
    // refresh, and jump to the Downloads page so the user sees it start.
    const onNxm = () => {
      loadDownloads()
      useAppStore.getState().setActivePage('downloads')
      toast.success('Download avviato da Nexus', 'Aggiunto alla coda')
    }
    const subs = [
      ...['download:complete', 'install:complete', 'download:error'].map((ch) => ({
        ch,
        w: api.on!(ch, refresh),
      })),
      { ch: 'nxm:queued', w: api.on!('nxm:queued', onNxm) },
    ]
    return () => subs.forEach((s) => api.off?.(s.ch, s.w))
  }, [loadDownloads, loadMods])

  return (
    <div className="flex flex-col h-screen bg-pattern" style={{ background: 'var(--bg-primary)' }}>
      <TitleBar />

      {/* Loading overlay */}
      {isLoading && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(5,5,7,0.9)', backdropFilter: 'blur(8px)' }}
        >
          <div className="flex flex-col items-center gap-4">
            {/* Dragon logo */}
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center animate-pulse-slow"
              style={{
                background: 'linear-gradient(135deg, #7d4dff, #4d7dff)',
                boxShadow: '0 0 40px rgba(125,77,255,0.5)',
              }}
            >
              <span className="text-3xl font-bold text-white" style={{ fontFamily: 'Cinzel, serif' }}>
                S
              </span>
            </div>
            <div className="text-center">
              <p className="text-white/80 font-semibold" style={{ fontFamily: 'Cinzel, serif' }}>
                Skyrim AE Mod Manager
              </p>
              <p className="text-dark-400 text-sm mt-1">{loadingMessage}</p>
            </div>
            <div className="w-48 h-1 rounded-full bg-dark-800 overflow-hidden">
              <div className="progress-shimmer h-full w-2/3 rounded-full" />
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Key by page so a crash on one page resets when navigating elsewhere,
              instead of leaving the whole content area stuck on the error screen. */}
          <ErrorBoundary key={activePage}>
            <Suspense fallback={<PageLoader />}>
              <Page id={activePage} />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <ToastContainer />
    </div>
  )
}
