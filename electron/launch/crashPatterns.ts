// Database di firme note per i crash log di Skyrim SE/AE — DERIVATO da
// "Phostwood's Skyrim Crash Log Analyzer" (https://github.com/Phostwood/crash-analyzer,
// GPL-3.0; qui un SUBSET curato e tradotto delle categorie rilevanti per questa
// collection, con consigli ricollegati alle azioni DEL LAUNCHER). Progetto a uso
// privato del singolo utente (nessuna distribuzione): l'attribuzione resta d'obbligo
// morale e di tracciabilità. Integrare/aggiornare firme: vedi js/crashIndicatorsMap.js
// nel repo upstream.
//
// PURO: matching case-insensitive di substring sul TESTO GREZZO del log (le firme
// possono comparire in call stack, registri, relevant objects o moduli — cercare
// ovunque è esattamente ciò che fa l'analizzatore upstream).

export interface CrashPatternCategory {
  id: string
  label: string
  /** Substring cercate nel log (case-insensitive). Basta UN match per accendere la categoria. */
  signatures: string[]
  /** Consiglio azionabile, riferito dove possibile alle azioni del launcher. */
  advice: string
  /** Priorità di ordinamento nel report (1 = più alta). */
  priority: number
  /** true = da mostrare solo se è l'UNICA categoria (sintomo generico, non causa). */
  weakAlone?: boolean
}

export const CRASH_PATTERN_CATEGORIES: CrashPatternCategory[] = [
  {
    id: 'nvidia-driver',
    label: 'Driver NVIDIA',
    signatures: ['nvwgf2umx.dll', 'nvlddmkm.sys', 'nvoglv64.dll', 'nvwgf2um.dll', 'nvapi64.dll', 'nvgpucomp64.dll'],
    advice:
      'Crash nel driver NVIDIA (noto per questa collection). Aggiorna il driver con installazione PULITA (DDU se recidivo); disattiva overlay (GeForce Experience/Discord) e overclock GPU. Se avviene sempre in aree specifiche, sospetta anche mesh/texture rotte in quelle celle.',
    priority: 2,
  },
  {
    id: 'amd-driver',
    label: 'Driver AMD',
    signatures: ['amdxx64.dll', 'amdxc64.dll', 'atikmdag.sys', 'atidxx64.dll', 'amd_ags_x64.dll'],
    advice:
      'Crash nel driver AMD. Aggiorna il driver con installazione pulita; disattiva overlay e overclock. Con Community Shaders attivo, verifica di avere l’ultima versione di CS compatibile con la tua GPU.',
    priority: 2,
  },
  {
    id: 'memoria',
    label: 'Memoria / VRAM',
    signatures: ['memory allocation failed', 'out of memory', 'bad_alloc', 'd6ddda', 'not enough memory', 'virtual memory'],
    advice:
      'Allocazione memoria fallita (RAM o VRAM). Imposta il pagefile gestito da Windows (o 20+ GB fisso), chiudi app in background e, se ricorrente, riduci i preset texture. Con 4K su GPU sotto i 10 GB di VRAM il rischio è concreto.',
    priority: 1,
  },
  {
    id: 'behaviour',
    label: 'Behaviour / Animazioni',
    signatures: ['hkbbehaviorgraph', 'hkbcharacter', 'hkbclipgenerator', 'hkbstatemachine', '0_master.hkb', 'behaviorgraph'],
    advice:
      'Crash nel sistema behaviour Havok: quasi sempre behaviour non rigenerati dopo cambi alle mod di animazione. Rilancia "Rigenera behaviour (Pandora)" da Strumenti e riesegui il Deploy (l’output Pandora è una mod generata).',
    priority: 1,
  },
  {
    id: 'fisiche',
    label: 'Fisiche (HDT-SMP/CBPC)',
    signatures: ['hdtsmp64.dll', 'cbp.dll', 'skee64.dll', 'hdtSMPFramework', 'smpdebug'],
    advice:
      'Crash nelle fisiche (FSMP/CBPC) o in RaceMenu/skee. Verifica che FSMP sia la build per la tua versione di gioco; outfit SMP con xml rotti possono crashare all’equip: se succede con un outfit specifico, disattiva quella mod. skee64: controlla RaceMenu aggiornato.',
    priority: 1,
  },
  {
    id: 'mesh',
    label: 'Mesh (.nif)',
    signatures: ['.nif', 'ninode', 'bsfadenode', 'bstrishape', 'nigeometry', 'bsdynamictrishape'],
    advice:
      'Crash su una mesh. Se il log cita un file .nif, individua la mod che lo fornisce (pagina Conflitti → cerca il percorso) e disattivala o reinstallala. Dopo un batch BodySlide incompleto, rilancia il build dalla card Strumenti.',
    priority: 3,
  },
  {
    id: 'texture',
    label: 'Texture (.dds)',
    signatures: ['.dds', 'bslightingshaderproperty', 'texturedb', 'niSourceTexture'.toLowerCase()],
    advice:
      'Crash su una texture. Texture corrotta o in formato non valido: se il log cita un .dds, individua la mod che lo fornisce e reinstallala. Verifica anche la VRAM (vedi categoria Memoria se presente).',
    priority: 4,
  },
  {
    id: 'papyrus',
    label: 'Script Papyrus',
    signatures: ['papyrus', 'vmstack', 'skyrimvm', 'bsscript'],
    advice:
      'Coinvolto il motore script. Da solo raramente è la causa: controlla Documents/My Games/.../Logs/Script per stack dump ripetuti. Non aumentare i limiti Papyrus in ini: maschera il problema.',
    priority: 5,
    weakAlone: true,
  },
  {
    id: 'kernelbase',
    label: 'KERNELBASE (sintomo)',
    signatures: ['kernelbase.dll'],
    advice:
      'KERNELBASE è quasi sempre il SINTOMO (eccezione propagata), non la causa: guarda le altre categorie rilevate e i frame sopra nel call stack. Noto e dichiarato dal curatore per questa collection.',
    priority: 8,
    weakAlone: true,
  },
  {
    id: 'community-shaders',
    label: 'Community Shaders / upscaler',
    signatures: ['communityshaders.dll', 'community shaders', 'upscaler.dll', 'skyrimupscaler', 'streamline', 'nvngx'],
    advice:
      'Crash in Community Shaders o nell’upscaler (noto per questa collection, fix del curatore attesi in R160). Riprova l’avvio (spesso sporadico); se ricorrente al primo avvio, elimina la cartella Data/ShaderCache e lascia ricompilare.',
    priority: 2,
  },
  {
    id: 'engine-fixes',
    label: 'SSE Engine Fixes / allocatore',
    signatures: ['tbbmalloc.dll', 'enginefixes'],
    advice:
      'Coinvolto l’allocatore di SSE Engine Fixes. Verifica che la Part 2 (d3dx9_42/tbb dll nella ROOT del gioco) sia della versione giusta e che MemoryManager non sia in conflitto con altri gestori memoria.',
    priority: 3,
  },
  {
    id: 'save-corruption',
    label: 'Salvataggio',
    signatures: ['bgssaveloadmanager', 'saveload', 'bgssavegamebuffer'],
    advice:
      'Crash durante salvataggio/caricamento: possibile save al limite o dipendente da mod rimosse. Usa il Save Doctor (preflight) per il diff plugin del save; prova un save precedente o una nuova partita di test.',
    priority: 3,
  },
  {
    id: 'alt-tab-display',
    label: 'Display / alt-tab',
    signatures: ['dxgi.dll', 'd3d11.dll', 'dwmapi'],
    advice:
      'Crash nello stack di presentazione DirectX: tipico su alt-tab o cambio risoluzione con overlay attivi. Con SSE Display Tweaks usa borderless (mai exclusive fullscreen) e disattiva gli overlay.',
    priority: 6,
    weakAlone: true,
  },
]

export interface CrashPatternMatch {
  id: string
  label: string
  matched: string[]
  advice: string
  priority: number
}

/** Match delle categorie sul testo grezzo del log. Ordina per priorità, filtra i weakAlone se soli. */
export function matchCrashPatterns(rawLogText: string): CrashPatternMatch[] {
  const text = rawLogText.toLowerCase()
  const hits: CrashPatternMatch[] = []
  for (const cat of CRASH_PATTERN_CATEGORIES) {
    const matched = cat.signatures.filter((s) => text.includes(s.toLowerCase()))
    if (matched.length) hits.push({ id: cat.id, label: cat.label, matched, advice: cat.advice, priority: cat.priority })
  }
  hits.sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label))
  // Categorie "sintomo" da sole non aiutano: mostrale solo accanto ad altre più specifiche.
  const strong = hits.filter((h) => !CRASH_PATTERN_CATEGORIES.find((c) => c.id === h.id)?.weakAlone)
  return strong.length ? hits : hits.slice(0, 1)
}
