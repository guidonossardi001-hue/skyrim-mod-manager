import { useState } from 'react'
import { ChevronRight, ChevronDown, ExternalLink } from 'lucide-react'

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
- SKSE64 per AE installato nella cartella del gioco (nessun Mod Organizer 2: questo launcher gestisce mod, load order e deploy da solo e avvia SEMPRE via SKSE interno)
- Account Nexus Mods (Premium fortemente consigliato: sblocca il download automatico dell'intera coda; senza, ogni mod richiede il click manuale "Mod Manager Download" su Nexus)
- Spazio libero adeguato alla collezione scelta (l'app calcola e blocca in anticipo se il disco non basta)

**Passi iniziali**
1. Apri **Impostazioni**, incolla la tua **API Key Nexus Mods** e clicca "Verifica"; premi "Rileva Automaticamente" per i percorsi (Skyrim AE viene trovato da solo dal registro Steam)
2. Vai al **Catalogo** e importa una collezione Nexus (campo "Slug o URL Collection Nexus", es. \`nexusmods.com/games/skyrimspecialedition/collections/<slug>\`) oppure aggiungi mod singole
3. Premi **Installa tutto**: download → estrazione → installazione partono in coda automaticamente
4. In **Strumenti**: se la collezione ha mod con installer FOMOD, "Scarica scelte del curatore" poi "Applica a tutte"; se ci sono preset ENB, "Cerca preset ENB" poi "Applica"
5. Vai in **Deploy** e premi **Deploy**: collega le mod nella cartella Data del gioco (hardlink, reversibile con Purge) e genera il load order da solo (motore LOOT interno)
6. Se la collezione usa OStim/animazioni custom, esegui **Pandora Behaviour Engine** da Strumenti (parte in automatico, senza interazione)
7. Premi **GIOCA**: il launcher avvia SKSE64 direttamente, nessun passaggio manuale

**Ordine di installazione consigliato**
Framework → Bug Fix → Corpo/Skin → NPC → Grafica → Combat → Gameplay → Animazioni → UI → Adult → Patch (il motore di load order interno lo applica da solo sui master reali dei plugin)
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
    title: '🔧 Ordine di Esecuzione — Da fare dopo ogni modifica alla lista mod',
    content: `
**1. Installer FOMOD (Strumenti)**
   - Le mod con più varianti (texture 1K/2K, CBBE/HIMBO, patch opzionali) vanno ristrutturate col motore FOMOD interno
   - "Scarica scelte del curatore" (se hai importato una Collection) poi "Applica a tutte"
   - Senza questo passo gli asset restano in cartelle-opzione invisibili al gioco

**2. Conflitti (pagina Conflitti)**
   - "Analizza conflitti reali" mostra ogni sovrascrittura file con vincitore/perdente
   - "Inverti precedenza" per cambiare chi vince, SENZA disattivare alcuna mod
   - Il budget slot plugin (254 full / 4096 light) è mostrato qui: oltre soglia il Deploy si blocca

**3. Deploy**
   - Collega (hardlink) le mod abilitate nella cartella Data del gioco
   - Genera da solo il load order corretto (motore LOOT interno: legge i master REALI di ogni plugin + la masterlist community, non serve LOOT esterno)
   - "Purge" riporta la Data del gioco a vanilla in un click (reversibile)

**4. Preset ENB (Strumenti)**
   - "Cerca preset ENB" nelle mod estratte, "Applica" li copia nella ROOT del gioco (non Data)
   - Il core ENB (d3d11.dll) va scaricato a parte da enbdev.com — non ridistribuibile nelle collection

**5. Pandora Behaviour Engine (Strumenti)**
   - OBBLIGATORIO se la collezione usa OStim/animazioni custom — senza, T-pose e crash
   - Parte in automatico (headless), nessuna interazione richiesta

**6. xLODGen / DynDOLOD** (opzionali, tool esterni da configurare in Impostazioni se disponibili)
   - LOD terreno/alberi — non ancora automatizzabili da questo launcher

**7. GIOCA**
   - Avvio ESCLUSIVAMENTE tramite SKSE64 interno al launcher — non serve né è supportato Mod Organizer 2
   - Se il gioco crasha, il launcher analizza da solo l'ultimo crash log e mostra il modulo probabile colpevole (Strumenti → Analizza crash log)
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
**Il gioco crasha all'avvio o durante il gioco**
1. Il launcher rileva da solo il crash dopo un GIOCA riuscito e mostra un avviso col modulo probabile colpevole — apri **Strumenti → Analizza crash log** per il report completo (call stack, plugin SKSE caricati, load order)
2. Verifica che SKSE64 sia la versione corretta per AE (1.6.x) — il gate d'avvio lo controlla già prima di lasciarti giocare
3. Controlla che Address Library sia presente (naming AE: \`versionlib-*.bin\`) — anche questo è nel gate d'avvio
4. Se il crash indica una mod specifica, disattivala e ri-fai Deploy per isolare il problema

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
