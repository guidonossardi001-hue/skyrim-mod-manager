import {
  LayoutDashboard,
  Package,
  Search,
  Download,
  Settings,
  Shield,
  Swords,
  Palette,
  Music,
  Globe,
  ChevronLeft,
  ChevronRight,
  Wrench,
  BookOpen,
  AlertTriangle,
  BarChart3,
  Users,
  FileCode,
  ArrowUpCircle,
  ShieldCheck,
  Play,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/appStore'
import { clsx } from 'clsx'

interface NavItem {
  id: string
  label: string
  icon: React.ElementType
  badge?: number | string
  group?: string
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'principale' },
  { id: 'modlist', label: 'Lista Mod', icon: Package, group: 'principale' },
  { id: 'catalog', label: 'Catalogo', icon: Search, group: 'principale' },
  { id: 'downloads', label: 'Download', icon: Download, group: 'principale' },
  { id: 'updates', label: 'Aggiornamenti', icon: ArrowUpCircle, group: 'principale' },

  { id: 'visuals', label: 'Grafica', icon: Palette, group: 'categorie' },
  { id: 'character', label: 'Personaggio', icon: Users, group: 'categorie' },
  { id: 'combat', label: 'Combattimento', icon: Swords, group: 'categorie' },
  { id: 'gameplay', label: 'Gameplay', icon: Globe, group: 'categorie' },
  { id: 'audio', label: 'Audio', icon: Music, group: 'categorie' },

  { id: 'conflicts', label: 'Conflitti', icon: AlertTriangle, group: 'tools' },
  { id: 'compatibility', label: 'Compatibilità', icon: ShieldCheck, group: 'tools' },
  { id: 'plugins', label: 'Plugin', icon: FileCode, group: 'tools' },
  { id: 'tools', label: 'Strumenti', icon: Wrench, group: 'tools' },
  { id: 'profiles', label: 'Profili', icon: Shield, group: 'tools' },
  { id: 'stats', label: 'Statistiche', icon: BarChart3, group: 'tools' },
  { id: 'docs', label: 'Documentazione', icon: BookOpen, group: 'tools' },
  { id: 'backup', label: 'Backup', icon: Shield, group: 'tools' },

  { id: 'settings', label: 'Impostazioni', icon: Settings, group: 'bottom' },
]

const GROUPS = [
  { id: 'principale', label: 'Principale' },
  { id: 'categorie', label: 'Categorie' },
  { id: 'tools', label: 'Strumenti' },
]

const CATEGORY_PAGES = new Set(['visuals', 'character', 'combat', 'gameplay', 'audio'])

export default function Sidebar() {
  // Sempre montata: selettore shallow per non ri-renderizzare a ogni set() dello store.
  const {
    activePage,
    setActivePage,
    openCategory,
    sidebarCollapsed,
    setSidebarCollapsed,
    setLauncherActive,
    conflicts,
    downloads,
    modUpdates,
  } = useAppStore(
    useShallow((s) => ({
      activePage: s.activePage,
      setActivePage: s.setActivePage,
      openCategory: s.openCategory,
      sidebarCollapsed: s.sidebarCollapsed,
      setSidebarCollapsed: s.setSidebarCollapsed,
      setLauncherActive: s.setLauncherActive,
      conflicts: s.conflicts,
      downloads: s.downloads,
      modUpdates: s.modUpdates,
    })),
  )

  const pendingDownloads = downloads.filter((d) => d.status === 'downloading').length
  const availableUpdates = Object.values(modUpdates).filter((u) => u.hasUpdate).length

  // Category items are shortcuts that open the mod list pre-filtered by category,
  // instead of routing to non-existent pages.
  const navigate = (id: string) => (CATEGORY_PAGES.has(id) ? openCategory(id) : setActivePage(id))

  const getBadge = (id: string) => {
    if (id === 'conflicts') return conflicts.length || undefined
    if (id === 'downloads') return pendingDownloads || undefined
    if (id === 'updates') return availableUpdates || undefined
    return undefined
  }

  return (
    <div
      className={clsx(
        'flex flex-col h-full transition-all duration-300 flex-shrink-0 relative',
        sidebarCollapsed ? 'w-16' : 'w-56',
      )}
      style={{ background: 'rgba(10,10,12,0.95)', borderRight: '1px solid rgba(255,255,255,0.06)' }}
    >
      {/* Collapse toggle */}
      <button
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        className="absolute -right-3 top-6 z-10 w-6 h-6 rounded-full flex items-center justify-center
          bg-dark-800 border border-dark-600 text-dark-400 hover:text-white hover:border-dark-400 transition-all"
      >
        {sidebarCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      {/* Return to the Fantasy Launcher (One-Click Play) */}
      <div className="px-3 pt-3">
        <button
          onClick={() => setLauncherActive(true)}
          title="Torna al Launcher (GIOCA)"
          className={clsx(
            'w-full flex items-center gap-2 rounded-lg font-semibold text-white transition-all hover:scale-[1.02]',
            sidebarCollapsed ? 'justify-center py-2.5' : 'justify-center py-2.5 px-3',
          )}
          style={{
            background: 'linear-gradient(135deg, #ff4500, #ff6a2e)',
            boxShadow: '0 0 20px rgba(255,69,0,0.28)',
            fontFamily: 'Cinzel, serif',
          }}
        >
          <Play size={16} fill="currentColor" />
          {!sidebarCollapsed && 'GIOCA'}
        </button>
      </div>

      {/* Nav groups */}
      <div className="flex-1 overflow-y-auto py-3 space-y-1">
        {GROUPS.map((group) => {
          const items = NAV_ITEMS.filter((i) => i.group === group.id)
          return (
            <div key={group.id} className="mb-1">
              {!sidebarCollapsed && (
                <div className="px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-dark-400">
                  {group.label}
                </div>
              )}
              {items.map((item) => (
                <NavBtn
                  key={item.id}
                  item={item}
                  active={activePage === item.id}
                  collapsed={sidebarCollapsed}
                  badge={getBadge(item.id)}
                  onClick={() => navigate(item.id)}
                />
              ))}
            </div>
          )
        })}
      </div>

      {/* Bottom: settings */}
      <div className="border-t border-dark-800 py-2">
        {NAV_ITEMS.filter((i) => i.group === 'bottom').map((item) => (
          <NavBtn
            key={item.id}
            item={item}
            active={activePage === item.id}
            collapsed={sidebarCollapsed}
            onClick={() => setActivePage(item.id)}
          />
        ))}
      </div>
    </div>
  )
}

function NavBtn({
  item,
  active,
  collapsed,
  badge,
  onClick,
}: {
  item: NavItem
  active: boolean
  collapsed: boolean
  badge?: number
  onClick: () => void
}) {
  const Icon = item.icon

  return (
    <button
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      className={clsx(
        'w-full flex items-center gap-3 px-3 py-2 mx-1 rounded-lg transition-all duration-150 relative text-sm',
        collapsed ? 'justify-center w-10 mx-auto' : '',
        active ? 'text-white font-medium' : 'text-dark-300 hover:text-white hover:bg-white/5',
      )}
      style={
        active
          ? {
              background: 'linear-gradient(135deg, rgba(125,77,255,0.2), rgba(77,125,255,0.15))',
              borderLeft: '2px solid #7d4dff',
            }
          : {}
      }
    >
      {active && (
        <div
          className="absolute inset-0 rounded-lg"
          style={{ boxShadow: 'inset 0 0 20px rgba(125,77,255,0.1)' }}
        />
      )}

      <Icon size={16} className={active ? 'text-void-400' : ''} />

      {!collapsed && <span className="flex-1 text-left truncate">{item.label}</span>}

      {badge && badge > 0 && (
        <span
          className={clsx(
            'rounded-full text-xs font-bold flex items-center justify-center',
            collapsed ? 'absolute top-0.5 right-0.5 w-4 h-4 text-[10px]' : 'w-5 h-5',
            item.id === 'conflicts' ? 'bg-orange-500 text-white' : 'bg-void-500 text-white',
          )}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}
