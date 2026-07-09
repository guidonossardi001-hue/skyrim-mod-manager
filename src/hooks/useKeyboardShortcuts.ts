import { useEffect } from 'react'
import { useAppStore } from '@/store/appStore'

const PAGE_SHORTCUTS: Record<string, string> = {
  '1': 'dashboard',
  '2': 'modlist',
  '3': 'catalog',
  '4': 'downloads',
  '5': 'conflicts',
  '6': 'plugins',
  '7': 'tools',
  '8': 'stats',
  '9': 'settings',
}

export function useKeyboardShortcuts() {
  const { setActivePage, detectConflicts } = useAppStore()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

      if (e.key === 'Escape') {
        const el = document.querySelector<HTMLElement>('[data-close-on-escape]')
        el?.click()
        return
      }

      if (e.ctrlKey || e.metaKey) {
        if (isInput) return

        if (PAGE_SHORTCUTS[e.key]) {
          e.preventDefault()
          setActivePage(PAGE_SHORTCUTS[e.key])
          return
        }

        if (e.key === 'f' || e.key === 'F') {
          e.preventDefault()
          const searchInput = document.querySelector<HTMLInputElement>('main input[placeholder*="Cerca"]')
          searchInput?.focus()
          return
        }

        if (e.key === 'r' || e.key === 'R') {
          e.preventDefault()
          detectConflicts()
          return
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setActivePage, detectConflicts])
}
