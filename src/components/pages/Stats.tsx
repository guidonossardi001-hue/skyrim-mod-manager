import { useMemo } from 'react'
import { useAppStore } from '@/store/appStore'
import { Cpu } from 'lucide-react'

const CATEGORY_LABELS: Record<string, string> = {
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

const CATEGORY_COLORS: Record<string, string> = {
  framework: '#7d4dff',
  visuals: '#4d7dff',
  character: '#ff69b4',
  npc: '#ffa500',
  gameplay: '#00c864',
  combat: '#ff4500',
  animation: '#00b4c8',
  audio: '#b464ff',
  quest: '#ffe033',
  world: '#33ddff',
  ui: '#ffe033',
  performance: '#64c864',
  adult: '#ff0050',
  patch: '#aaaaaa',
  other: '#666666',
  translation: '#66ffcc',
}

export default function Stats() {
  const { mods, downloads, profiles, activeProfileId } = useAppStore()

  const stats = useMemo(() => {
    const enabled = mods.filter((m) => m.is_enabled)
    const installed = mods.filter((m) => m.is_installed)

    const byCategory = mods.reduce<Record<string, { count: number; sizeMB: number; enabled: number }>>(
      (acc, m) => {
        if (!acc[m.category]) acc[m.category] = { count: 0, sizeMB: 0, enabled: 0 }
        acc[m.category].count++
        acc[m.category].sizeMB += m.file_size / 1024 / 1024
        if (m.is_enabled) acc[m.category].enabled++
        return acc
      },
      {},
    )

    const totalSizeGB = mods.reduce((a, m) => a + m.file_size, 0) / 1024 / 1024 / 1024
    const itTranslations = mods.filter((m) => m.translation_it).length
    const withNexusId = mods.filter((m) => m.nexus_id).length
    const completedDl = downloads.filter((d) => d.status === 'completed').length
    const totalDlSizeGB =
      downloads.filter((d) => d.status === 'completed').reduce((a, d) => a + d.total_size, 0) /
      1024 /
      1024 /
      1024

    const perfScore = (() => {
      let score = 100
      const enabledNames = enabled.map((m) => m.name.toLowerCase())
      const has = (kw: string) => enabledNames.some((n) => n.includes(kw))
      if (has('enb')) score -= 18
      if (has('cathedral weathers')) score -= 5
      if (has('nolvus')) score -= 10
      if (has('4k') || has('2160p')) score -= 12
      if (has('bijin') || has('pandorable') || has('high poly npc')) score -= 8
      if (has('dyndolod')) score -= 6
      if (has('xlodgen')) score -= 3
      if (has('hdt-smp') || has('hdt smp') || has('cbpc')) score -= 5
      if (has('valhalla')) score -= 2
      if (has('precision')) score -= 2
      if (enabled.some((m) => m.category === 'performance')) score += 10
      return Math.max(30, Math.min(100, score))
    })()

    return {
      enabled,
      installed,
      byCategory,
      totalSizeGB,
      itTranslations,
      withNexusId,
      completedDl,
      totalDlSizeGB,
      perfScore,
    }
  }, [mods, downloads])

  const sortedCategories = Object.entries(stats.byCategory).sort((a, b) => b[1].count - a[1].count)

  const maxCount = Math.max(...sortedCategories.map(([, v]) => v.count), 1)

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h1 className="text-lg font-bold gradient-text-void" style={{ fontFamily: 'Cinzel, serif' }}>
        Statistiche Modlist
      </h1>

      {/* Key numbers */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Mod Totali', value: mods.length, color: '#7d4dff' },
          { label: 'Spazio Totale', value: `${stats.totalSizeGB.toFixed(1)} GB`, color: '#4d7dff' },
          { label: 'Tradotte IT', value: stats.itTranslations, color: '#4dffaa' },
          { label: 'Da Nexus', value: stats.withNexusId, color: '#ffb84d' },
        ].map(({ label, value, color }) => (
          <div key={label} className="card p-4">
            <div className="text-2xl font-bold text-white" style={{ color }}>
              {value}
            </div>
            <div className="text-xs text-dark-400 mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* By category bar chart */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-white/70 mb-4">Mod per Categoria</h3>
        <div className="space-y-2">
          {sortedCategories.map(([cat, data]) => (
            <div key={cat} className="flex items-center gap-3">
              <span className="w-28 text-xs text-dark-400 text-right flex-shrink-0">
                {CATEGORY_LABELS[cat] ?? cat}
              </span>
              <div className="flex-1 h-5 bg-dark-700 rounded relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded transition-all duration-500"
                  style={{
                    width: `${(data.count / maxCount) * 100}%`,
                    background: `${CATEGORY_COLORS[cat] ?? '#555'}55`,
                    borderRight: `2px solid ${CATEGORY_COLORS[cat] ?? '#555'}`,
                  }}
                />
              </div>
              <div className="w-16 text-right flex-shrink-0">
                <span className="text-xs font-mono text-white/70">{data.count}</span>
                <span className="text-xs text-dark-500 ml-1">mod</span>
              </div>
              <div className="w-20 text-right flex-shrink-0">
                <span className="text-xs font-mono text-dark-400">
                  {data.sizeMB >= 1024
                    ? `${(data.sizeMB / 1024).toFixed(1)} GB`
                    : `${data.sizeMB.toFixed(0)} MB`}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Size progress toward goal */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-white/70 mb-3">Progresso verso obiettivo 230 GB</h3>
        <div className="flex items-center justify-between text-xs text-dark-400 mb-2">
          <span>{stats.totalSizeGB.toFixed(1)} GB installati</span>
          <span>230 GB obiettivo</span>
        </div>
        <div className="h-3 bg-dark-700 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min((stats.totalSizeGB / 230) * 100, 100)}%`,
              background: 'linear-gradient(90deg, #7d4dff, #4d7dff)',
            }}
          />
        </div>
        <p className="text-xs text-dark-500 mt-2">
          {(230 - stats.totalSizeGB).toFixed(1)} GB rimanenti all'obiettivo
        </p>
      </div>

      {/* Performance estimator */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-white/70 mb-3 flex items-center gap-2">
          <Cpu size={15} className="text-orange-400" /> Stima Prestazioni (RX 9070 XT @ 1080p)
        </h3>
        <div className="flex items-center gap-4 mb-3">
          <div className="flex-1 h-4 bg-dark-700 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${stats.perfScore}%`,
                background:
                  stats.perfScore > 70
                    ? 'linear-gradient(90deg, #4dffaa, #22c55e)'
                    : stats.perfScore > 50
                      ? 'linear-gradient(90deg, #ffb84d, #f97316)'
                      : 'linear-gradient(90deg, #ff4500, #ef4444)',
              }}
            />
          </div>
          <span
            className="text-xl font-bold w-16 text-right"
            style={{
              color: stats.perfScore > 70 ? '#4dffaa' : stats.perfScore > 50 ? '#ffb84d' : '#ff4500',
            }}
          >
            {stats.perfScore}%
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            {
              label: 'FPS stimati',
              value: stats.perfScore > 70 ? '60+ stabili' : stats.perfScore > 50 ? '45–60 FPS' : '30–45 FPS',
            },
            {
              label: 'VRAM stimata',
              value: stats.perfScore > 70 ? '~6 GB' : stats.perfScore > 50 ? '~8 GB' : '~10+ GB',
            },
            {
              label: 'Qualità preset',
              value:
                stats.perfScore > 70
                  ? 'Ultra + ENB leggero'
                  : stats.perfScore > 50
                    ? 'Alto + ENB medio'
                    : 'Medio + ENB pesante',
            },
            { label: 'Upscaling', value: stats.perfScore < 60 ? 'FSR 3 consigliato' : 'Non necessario' },
          ].map(({ label, value }) => (
            <div key={label} className="flex justify-between p-2 rounded bg-white/3">
              <span className="text-dark-400">{label}</span>
              <span className="text-white/70 font-medium">{value}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-dark-500 mt-2">
          Stima basata sui mod attivi. Risultati reali dipendono dalla scena e dalle impostazioni ENB.
        </p>
      </div>

      {/* Profiles */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-white/70 mb-3">Profili</h3>
        <div className="text-xs text-dark-400 space-y-1">
          <div className="flex justify-between">
            <span>Profili totali</span>
            <span className="text-white/70">{profiles.length}</span>
          </div>
          <div className="flex justify-between">
            <span>Download completati</span>
            <span className="text-white/70">{stats.completedDl}</span>
          </div>
          <div className="flex justify-between">
            <span>Dati scaricati</span>
            <span className="text-white/70">{stats.totalDlSizeGB.toFixed(1)} GB</span>
          </div>
        </div>
      </div>
    </div>
  )
}
