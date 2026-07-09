import { useState } from 'react'
import { BookOpen, ChevronRight, ChevronDown, ExternalLink } from 'lucide-react'

interface DocSection {
  id: string
  title: string
  content: string
  links?: { label: string; url: string }[]
}

const DOCS: DocSection[] = [
  {
    id: 'primo-avvio',
    title: '🚀 Guida al Primo Avvio',
    content: `
**Prerequisiti**
- Skyrim Anniversary Edition installato su Steam (non in C:\\Program Files)
- Mod Organizer 2 installato
- Account Nexus Mods (gratuito, premium consigliato per download veloci)
- ~300 GB di spazio libero su SSD NVMe

**Passi iniziali**
1. Apri **Impostazioni** e configura tutti i percorsi (Skyrim AE, MO2, LOOT, SSEEdit, DynDOLOD)
2. Incolla la tua **API Key Nexus Mods** e clicca "Verifica"
3. Vai al **Catalogo** e aggiungi le mod al profilo partendo dalle ESSENZIALI
4. Usa **Strumenti → LOOT** per ordinare i plugin
5. Esegui **Pandora Behaviour Engine** per le animazioni
6. Esegui **DynDOLOD** per i LOD
7. Avvia il gioco tramite **MO2**

**Ordine di installazione consigliato**
Framework → Bug Fix → Corpo/Skin → NPC → Grafica → Combat → Gameplay → Animazioni → UI → Adult → Patch
    `,
    links: [
      { label: 'Nexus Mods API Keys', url: 'https://www.nexusmods.com/users/myaccount?tab=api' },
      { label: 'SKSE64 per AE', url: 'https://skse.silverlock.org/' },
    ],
  },
  {
    id: 'filosofia',
    title: '📖 Filosofia della Modlist',
    content: `
**Obiettivo**
Creare la versione "definitiva" di Skyrim AE: più bella, più profonda, più moderna — ma sempre riconoscibile come Skyrim.

**Cosa manteniamo**
- Storia vanilla completa
- Tutte le quest originali e DLC (Dawnguard, Dragonborn, Hearthfire)
- Tutti i contenuti Anniversary Edition
- Equilibrio del gioco di base

**Stile grafico: 50% Anime / 50% Fantasy Realistico**
Inspirato a: One Piece, Genshin Impact, Granblue Fantasy, Tales of Arise
- Personaggi con volti anime stilizzati ma credibili
- Capelli anime HD con fisica
- Occhi anime grandi e colorati
- Effetti magici spettacolari con colori vivaci
- Ambientazioni luminose e fantasy

**Combattimento**
Sistema action RPG moderno con MCO, SCAR, Valhalla Combat. Schivate, combo, animazioni fluide. Stile Tales of Arise.
    `,
  },
  {
    id: 'performance',
    title: '⚡ Ottimizzazione Prestazioni',
    content: `
**Hardware di riferimento**
- GPU: AMD RX 9070 XT (16 GB VRAM)
- CPU: Ryzen 7 7800X3D
- RAM: 16 GB DDR5
- Storage: SSD NVMe

**Impostazioni ENB consigliate**
- Usare Rudy ENB in modalità "Performance"
- Disabilitare: Ambient Occlusion, DOF se non necessario
- Abilitare: Bloom, Lens Flare, HDR

**SSE Display Tweaks (settings)**
- FPSLimit = 61 (evita tearing con vsync)
- FullscreenMode = Borderless
- Resolution = 1920x1080

**Erba e vegetazione**
- No Grass in Objects: ESSENZIALE per evitare stuttering outdoor
- Grass density: 60-80 (trovare bilanciamento visivo/fps)

**Target realistico**
Con questa configurazione hardware e la modlist completa (~230 GB):
- Esterno: 55-65 FPS con ENB medio
- Interni/Dungeon: 75-100 FPS
- Città: 45-60 FPS (il collo di bottiglia)
    `,
  },
  {
    id: 'ordine-esecuzione',
    title: '🔧 Ordine di Esecuzione Strumenti',
    content: `
**Da eseguire dopo ogni modifica alla lista mod:**

1. **LOOT** — Ordina automaticamente i plugin (.esp/.esm)
   - Risolve i problemi di load order
   - Segnala conflitti e master mancanti

2. **Pandora Behaviour Engine** — Genera i comportamenti animazione
   - Va eseguito DOPO aver installato MCO, SCAR, e tutte le mod animazione
   - Output: cartella "Pandora_Engine"

3. **xLODGen** — LOD terreno (opzionale ma consigliato)
   - Genera terrain LOD per distanze
   - Tempo: 20-40 minuti

4. **DynDOLOD** — LOD alberi e oggetti
   - Genera LOD dinamici per alberi, edifici, ecc.
   - Usare preset "Medium" per performance ottimali
   - Tempo: 30-60 minuti

5. **BodySlide** — Adatta outfit al preset corpo
   - Eseguire "Build Morphs" per tutti gli outfit
   - Scegliere il tuo preset CBBE 3BA

6. **Avvio tramite MO2** — MAI avviare SKSE direttamente
    `,
  },
  {
    id: 'adult',
    title: '🔞 Contenuti Adulti (Privato)',
    content: `
**Framework adulti inclusi**
- OStim Standalone: Framework principale
- Amorous Adventures PLUS: Quest romantic vanilla-friendly
- OBody Configuration Menu: Gestione corpo NPC

**Note importanti**
- Tutti i contenuti sono per USO PRIVATO
- L'integrazione è progettata per non rompere la storia vanilla
- Il sistema relazioni si integra con dialoghi esistenti
- Ispirazione: Licentia NEXT (stabilità + gameplay completo)

**Installazione**
OStim richiede: SKSE64 + SkyUI + CBBE 3BA + OBody NG
Installare in quest'ordine: CBBE → CBBE 3BA → OBody → OStim Standalone → Amorous Adventures

**Compatibilità**
La modlist è progettata per essere stabile. I contenuti adulti non interferiscono con:
- Main quest
- Quest DLC
- Companion quest
- Anniversary Edition content
    `,
  },
  {
    id: 'risoluzione-problemi',
    title: '🛠 Risoluzione Problemi Comuni',
    content: `
**Il gioco crasha all'avvio**
1. Controlla Crash Logger (Documents/My Games/Skyrim Special Edition/SKSE/Crash Logger)
2. Verifica che SKSE64 sia la versione corretta per AE (1.6.x)
3. Controlla che Address Library sia aggiornata
4. Rimuovi mod una ad una per isolare il problema

**NPC con facce nere (black face bug)**
- Causato da conflitti nei file .esp che modificano gli NPC
- Soluzione: SSEEdit → cerca conflitti sulle raze degli NPC
- O ri-esporta i face data con CK/CKit

**Stuttering outdoor**
1. Verifica che "No Grass in Objects" sia attivo
2. Riduci la densità dell'erba nelle impostazioni
3. Riduce il preset DynDOLOD da "High" a "Medium"
4. Verifica pagefile Windows (minimo 20 GB)

**Animazioni rotte (T-pose)**
- Pandora Behaviour Engine non è stato eseguito
- Rimuovi la cartella "Pandora_Engine" e riesegui Pandora

**Performance scadenti in città**
- Normale: le città sono CPU-bound
- Usa "BethINI Pie" per ottimizzare settings .ini
- Disattiva ELFX nelle città se si usa ENB pesante
    `,
  },
]

// Render inline **bold** segments inside a line of documentation text.
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? (
      <strong key={i} className="font-semibold text-white/80">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  )
}

export default function Docs() {
  const [open, setOpen] = useState<string | null>('primo-avvio')

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl">
      <h1 className="text-lg font-bold gradient-text-void mb-6" style={{ fontFamily: 'Cinzel, serif' }}>
        Documentazione
      </h1>

      <div className="space-y-2">
        {DOCS.map((doc) => (
          <div key={doc.id} className="card overflow-hidden">
            <button
              onClick={() => setOpen(open === doc.id ? null : doc.id)}
              className="w-full flex items-center gap-3 p-4 text-left hover:bg-white/3 transition-colors"
            >
              <span className="flex-1 font-medium text-white/85 text-sm">{doc.title}</span>
              {open === doc.id ? (
                <ChevronDown size={16} className="text-dark-400 flex-shrink-0" />
              ) : (
                <ChevronRight size={16} className="text-dark-400 flex-shrink-0" />
              )}
            </button>

            {open === doc.id && (
              <div className="px-4 pb-4 border-t border-dark-800">
                <div className="mt-3 text-sm text-dark-300 leading-relaxed whitespace-pre-line">
                  {doc.content.split('\n').map((line, i) => {
                    const trimmed = line.trim()
                    if (trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.length > 4) {
                      return (
                        <p key={i} className="font-semibold text-white/80 mt-3 mb-1">
                          {trimmed.slice(2, -2)}
                        </p>
                      )
                    }
                    if (trimmed.startsWith('- ')) {
                      return (
                        <p key={i} className="ml-3 text-dark-300">
                          • {renderInline(trimmed.slice(2))}
                        </p>
                      )
                    }
                    if (/^\d+\./.test(trimmed)) {
                      return (
                        <p key={i} className="ml-3 text-dark-300">
                          {renderInline(trimmed)}
                        </p>
                      )
                    }
                    return trimmed ? <p key={i}>{renderInline(trimmed)}</p> : <div key={i} className="h-1" />
                  })}
                </div>

                {doc.links && doc.links.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {doc.links.map((link) => (
                      <button
                        key={link.url}
                        onClick={() => window.api.fs.openExternal(link.url)}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-soul-900/30 text-soul-400 hover:bg-soul-900/50 transition-colors"
                      >
                        <ExternalLink size={11} />
                        {link.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
