import { useState, useRef, useEffect } from 'react'
import {
  Play,
  ExternalLink,
  Info,
  Wrench,
  Zap,
  Globe,
  Download,
  Upload,
  FileCode,
  Copy,
  Check,
  RefreshCw,
  Database,
  Activity,
  AlertTriangle,
  Palette,
  X,
} from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { clsx } from 'clsx'
import { toast } from '@/lib/toast'
import type { VortexScanResult } from '@/types'

export default function Tools() {
  const { settings, exportLoadOrder, importFromMO2, checkAllUpdates, mods } = useAppStore()
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { success: boolean; message?: string }>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updateResult, setUpdateResult] = useState<{ checked: number; updates: number } | null>(null)
  const mo2ImportRef = useRef<HTMLInputElement>(null)

  // Vortex importer (read-only scan; catalog build + Pandora are explicit one-click steps)
  const [vortexScan, setVortexScan] = useState<VortexScanResult | null>(null)
  const [vortexBusy, setVortexBusy] = useState<'scan' | 'catalog' | 'pandora' | null>(null)

  // Masterlist LOOT reale: la status legge SOLO la cache locale (mai la rete) — sicuro da
  // chiamare al mount. Il refresh è invece sempre un'azione esplicita dell'utente.
  const [masterlistStatus, setMasterlistStatus] = useState<{
    ok: boolean
    cached: boolean
    pluginCount?: number
    groupCount?: number
    ruleCount?: number
    dirtyCount?: number
    fetchedAt?: string
  } | null>(null)
  const [masterlistRefreshing, setMasterlistRefreshing] = useState(false)

  useEffect(() => {
    window.api.masterlist.status().then(setMasterlistStatus)
  }, [])

  // Analizzatore crash log: sola lettura, nessuna azione sul gioco.
  const [crashEntries, setCrashEntries] = useState<{ name: string; path: string; mtimeMs: number; size: number }[]>([])
  const [crashDir, setCrashDir] = useState<string>('')
  const [crashBusy, setCrashBusy] = useState(false)
  const [crashResult, setCrashResult] = useState<Awaited<ReturnType<typeof window.api.crash.analyze>> | null>(null)

  useEffect(() => {
    window.api.crash.listRecent().then((r) => {
      if (r.ok) {
        setCrashEntries(r.entries ?? [])
        setCrashDir(r.dir ?? '')
      }
    })
  }, [])

  const analyzeCrash = async (path: string) => {
    setCrashBusy(true)
    setCrashResult(null)
    try {
      const res = await window.api.crash.analyze(path)
      setCrashResult(res)
      if (!res.ok) toast.error('Analisi crash log fallita', res.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Analisi crash log fallita', (e as Error).message)
    } finally {
      setCrashBusy(false)
    }
  }

  const pickAndAnalyzeCrash = async () => {
    const path = await window.api.fs.pickFile('Seleziona crash log', [{ name: 'Log', extensions: ['log', 'txt'] }])
    if (path) await analyzeCrash(path)
  }

  // Preflight DLL SKSE (T14): sola lettura, legge SOLO l'header PE — nessun codice del plugin
  // viene eseguito. Verifica compatibleVersions[] dichiarate vs la versione runtime del gioco.
  const [skseBusy, setSkseBusy] = useState(false)
  const [skseResult, setSkseResult] = useState<Awaited<ReturnType<typeof window.api.skse.preflightDlls>> | null>(null)
  const runSksePreflight = async () => {
    setSkseBusy(true)
    try {
      const r = await window.api.skse.preflightDlls()
      setSkseResult(r)
      if (!r.ok) toast.error('Preflight SKSE fallito', r.error ?? 'errore sconosciuto')
      else {
        const bad = (r.reports ?? []).filter((x) => x.verdict === 'incompatible')
        if (bad.length) toast.warning(`${bad.length} plugin SKSE incompatibili`, bad.map((b) => b.file.split(/[\\/]/).pop()).join(', '))
        else toast.success('Preflight SKSE ok', `${r.reports?.length ?? 0} plugin analizzati`)
      }
    } catch (e) {
      toast.error('Preflight SKSE fallito', (e as Error).message)
    } finally {
      setSkseBusy(false)
    }
  }

  // Validazione header ESP (T15): range FormID ESL + form43/44 informativo sui plugin deployati.
  const [espBusy, setEspBusy] = useState(false)
  const [espResult, setEspResult] = useState<Awaited<ReturnType<typeof window.api.plugin.validateEsp>> | null>(null)
  const runEspValidate = async () => {
    setEspBusy(true)
    try {
      const r = await window.api.plugin.validateEsp()
      setEspResult(r)
      if (!r.ok) toast.error('Validazione ESP fallita', r.error ?? 'errore sconosciuto')
      else {
        const bad = (r.reports ?? []).filter((x) => x.verdict === 'error')
        if (bad.length) toast.error(`${bad.length} plugin con FormID fuori range`, bad.map((b) => b.name).join(', '))
        else toast.success('Validazione ESP ok', `${r.reports?.length ?? 0} plugin controllati`)
      }
    } catch (e) {
      toast.error('Validazione ESP fallita', (e as Error).message)
    } finally {
      setEspBusy(false)
    }
  }

  // Preset INI derivati da BethINI Pie (T18): scrive nei file ini reali (Documents/My Games).
  const [bethiniFlavor, setBethiniFlavor] = useState<'bethini' | 'vanilla'>('bethini')
  const [bethiniTier, setBethiniTier] = useState<'poor' | 'low' | 'medium' | 'high' | 'ultra'>('medium')
  const [bethiniBusy, setBethiniBusy] = useState(false)
  const BETHINI_TIERS: Record<'bethini' | 'vanilla', string[]> = {
    bethini: ['poor', 'low', 'medium', 'high', 'ultra'],
    vanilla: ['low', 'medium', 'high', 'ultra'],
  }
  // Advisory hardware (sola lettura, mai un blocco): avvisa se il tier scelto eccede quanto
  // GPU/VRAM/RAM rilevati suggeriscono — l'utente può comunque procedere.
  const TIER_RANK = ['poor', 'low', 'medium', 'high', 'ultra']
  const [hardwareInfo, setHardwareInfo] = useState<Awaited<ReturnType<typeof window.api.system.detectHardware>> | null>(null)
  useEffect(() => {
    window.api.system?.detectHardware().then(setHardwareInfo).catch(() => setHardwareInfo(null))
  }, [])
  const tierExceedsHardware =
    !!hardwareInfo?.suggestedMaxTier && TIER_RANK.indexOf(bethiniTier) > TIER_RANK.indexOf(hardwareInfo.suggestedMaxTier)
  const applyBethiniPreset = async () => {
    const hwWarning = tierExceedsHardware
      ? `\n\n⚠ ATTENZIONE: il tier "${bethiniTier}" è sopra quanto il tuo hardware (${hardwareInfo?.gpuName ?? 'GPU non rilevata'}${hardwareInfo?.gpuVramGB ? `, ${hardwareInfo.gpuVramGB}GB VRAM` : ''}) suggerisce (consigliato: "${hardwareInfo?.suggestedMaxTier}"). Puoi comunque procedere.`
      : ''
    if (
      !window.confirm(
        `Applicare il preset "${bethiniFlavor} ${bethiniTier}"?\n\nScrive le chiavi Grass/Distant Detail/Shadow nei file ini reali (Skyrim.ini/SkyrimPrefs.ini in Documents/My Games) — il resto del file resta intatto.${hwWarning}`,
      )
    )
      return
    setBethiniBusy(true)
    try {
      const r = await window.api.ini.applyBethiniPreset(bethiniTier, bethiniFlavor)
      if (r.success) toast.success('Preset applicato', `${bethiniFlavor} ${bethiniTier}`)
      else toast.error('Applicazione preset fallita', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Applicazione preset fallita', (e as Error).message)
    } finally {
      setBethiniBusy(false)
    }
  }

  // Grass cache "autopilota" (T19): NON genera mai la cache senza il gioco reale in esecuzione
  // (25min-2,5h, crash attesi) — qui si lancia/supervisiona/rilancia, mai altro.
  const [grassStatus, setGrassStatus] = useState<Awaited<ReturnType<typeof window.api.grass.status>> | null>(null)
  const [grassBusy, setGrassBusy] = useState(false)
  const [grassProgress, setGrassProgress] = useState<{ attempt: number; status: string } | null>(null)
  const refreshGrassStatus = async () => setGrassStatus(await window.api.grass.status())
  useEffect(() => {
    refreshGrassStatus()
  }, [])
  useEffect(() => {
    const unsub = window.api.grass.onProgress((ev) => setGrassProgress(ev))
    return unsub
  }, [])
  const startGrassPrecache = async () => {
    if (
      !window.confirm(
        'Avviare il precache della grass cache?\n\nIl gioco verrà avviato realmente e può CRASHARE più volte durante il processo (normale, 25 minuti - 2,5 ore in totale): il launcher lo rilancia automaticamente finché NGIO non segnala la fine. Non chiudere il launcher durante l’operazione.',
      )
    )
      return
    setGrassBusy(true)
    setGrassProgress(null)
    try {
      const r = await window.api.grass.startPrecache()
      if (r.success && r.result) {
        if (r.result.completed) toast.success('Grass cache completata', r.result.reason)
        else toast.warning('Precache interrotto', r.result.reason)
      } else {
        toast.error('Avvio precache fallito', r.error ?? 'errore sconosciuto')
      }
    } catch (e) {
      toast.error('Avvio precache fallito', (e as Error).message)
    } finally {
      setGrassBusy(false)
      refreshGrassStatus()
    }
  }

  // Installer FOMOD headless (motore Vortex) + scelte del curatore della collection.
  const [fomodStatus, setFomodStatus] = useState<{
    total?: number
    applied?: number
    withChoices?: number
    choicesCached?: boolean
  } | null>(null)
  const [fomodBusy, setFomodBusy] = useState<'fetch' | 'apply' | null>(null)
  const [fomodProgress, setFomodProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [fomodReport, setFomodReport] = useState<Awaited<ReturnType<typeof window.api.fomod.applyAll>> | null>(null)

  const refreshFomod = async () => {
    const r = await window.api.fomod.scan()
    if (r.ok) setFomodStatus(r)
  }
  useEffect(() => {
    refreshFomod()
    const api = window.api as unknown as {
      on?: (ch: string, cb: (...a: unknown[]) => void) => unknown
      off?: (ch: string, cb: unknown) => void
    }
    if (!api.on) return
    const onP = (p?: { done: number; total: number; current: string }) => p && setFomodProgress(p)
    const w = api.on('fomod:progress', onP as (...a: unknown[]) => void)
    return () => api.off?.('fomod:progress', w)
  }, [])

  const fetchFomodChoices = async () => {
    setFomodBusy('fetch')
    try {
      const r = await window.api.fomod.fetchChoices()
      if (r.ok) {
        toast.success('Scelte del curatore scaricate', `${r.withChoices} mod con scelte FOMOD su ${r.mods} nel manifest`)
        await refreshFomod()
      } else toast.error('Download scelte fallito', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Download scelte fallito', (e as Error).message)
    } finally {
      setFomodBusy(null)
    }
  }

  const applyFomodAll = async () => {
    if (
      !window.confirm(
        'Applicare gli installer FOMOD a tutte le mod estratte?\n\nLe cartelle mod verranno ristrutturate nel layout finale (le varianti NON scelte vengono rimosse: un re-install richiede il re-download). Le scelte del curatore vengono usate dove disponibili, altrimenti i default dell\'autore.',
      )
    )
      return
    setFomodBusy('apply')
    setFomodReport(null)
    try {
      const r = await window.api.fomod.applyAll()
      setFomodReport(r)
      if (r.ok)
        toast.success(
          'FOMOD applicati',
          `${r.applied}/${r.processed} mod ristrutturate · ${r.defaultsUsed} coi default autore · ${r.failed?.length ?? 0} fallite`,
        )
      else toast.error('Applicazione FOMOD fallita', r.error ?? 'errore sconosciuto')
      await refreshFomod()
    } catch (e) {
      toast.error('Applicazione FOMOD fallita', (e as Error).message)
    } finally {
      setFomodBusy(null)
      setFomodProgress(null)
    }
  }

  // ESL-ify: libera slot FULL (max 254) flaggando light i plugin pure-override.
  const [eslStatus, setEslStatus] = useState<Awaited<ReturnType<typeof window.api.plugin.eslify>> | null>(null)
  const [eslBusy, setEslBusy] = useState<'scan' | 'apply' | null>(null)

  const eslRun = async (apply: boolean) => {
    const profileId = useAppStore.getState().activeProfileId
    if (!profileId) {
      toast.warning('Nessun profilo attivo', 'Seleziona un profilo prima')
      return
    }
    if (
      apply &&
      !window.confirm(
        `Flaggare light ${eslStatus?.slotsToFree ?? ''} plugin pure-override?\n\nModifica 4 byte dell'header di ciascun file (backup .smm-esl-bak accanto alla sorgente). Operazione standard e reversibile; sicura sui plugin senza record nuovi.`,
      )
    )
      return
    setEslBusy(apply ? 'apply' : 'scan')
    try {
      const r = await window.api.plugin.eslify(profileId, apply)
      setEslStatus(r)
      if (!r.ok) toast.error('ESL-ify fallito', r.error ?? 'errore sconosciuto')
      else if (apply)
        toast.success(
          `${r.flagged?.length ?? 0} plugin flaggati light`,
          r.error ?? 'Riesegui il Deploy: il budget slot ora rientra',
        )
      else if ((r.slotsToFree ?? 0) === 0) toast.success('Budget slot ok', `${r.budget?.full ?? '?'}/${r.budget?.maxFull ?? 254} FULL`)
      else toast.info(`${r.slotsToFree} slot da liberare`, `${r.eligible?.length ?? 0} candidati pure-override trovati`)
    } catch (e) {
      toast.error('ESL-ify fallito', (e as Error).message)
    } finally {
      setEslBusy(null)
    }
  }

  // BodySlide batch build headless: corpi, fisiche e outfit adattati al preset del curatore.
  const [bsStatus, setBsStatus] = useState<Awaited<ReturnType<typeof window.api.bodyslide.status>> | null>(null)
  const [bsPreset, setBsPreset] = useState<string>('')
  const [bsNudity, setBsNudity] = useState<'nude' | 'nevernude'>('nude')
  const [bsBusy, setBsBusy] = useState(false)
  const [bsProgress, setBsProgress] = useState<{ pass: number; passes: number; chunk: number; chunks: number; label: string } | null>(null)
  const [bsReport, setBsReport] = useState<Awaited<ReturnType<typeof window.api.bodyslide.build>> | null>(null)

  const refreshBodySlide = async () => {
    const s = await window.api.bodyslide.status()
    setBsStatus(s)
    // bsPreset resta '' = "Automatico" di default: il build lo mappa a undefined → preset
    // consigliato lato engine. L'utente non deve scegliere niente per far partire il batch.
  }
  useEffect(() => {
    refreshBodySlide()
    const api = window.api as unknown as {
      on?: (ch: string, cb: (...a: unknown[]) => void) => unknown
      off?: (ch: string, cb: unknown) => void
    }
    if (!api.on) return
    const onP = (p?: { pass: number; passes: number; chunk: number; chunks: number; label: string }) => p && setBsProgress(p)
    const w = api.on('bodyslide:progress', onP as (...a: unknown[]) => void)
    return () => api.off?.('bodyslide:progress', w)
  }, [])

  const openBodySlide = async () => {
    const profileId = useAppStore.getState().activeProfileId
    if (!profileId) {
      toast.warning('Nessun profilo attivo', 'Seleziona un profilo prima di aprire BodySlide')
      return
    }
    if (
      !window.confirm(
        'Aprire BodySlide per impostare il corpo a mano?\n\nScegli corpo/preset e usa "Build" o "Batch Build" dentro BodySlide: i mesh generati finiscono nella mod "BodySlide Output (generato)", non dentro il gioco. Al termine chiudi BodySlide e riesegui il Deploy.\n\nNon lanciare Deploy o altre build finché BodySlide è aperto.',
      )
    )
      return
    setBsBusy(true)
    try {
      const r = await window.api.bodyslide.open(profileId)
      if (r.ok) toast.success('BodySlide aperto', 'Costruisci il corpo, poi chiudi e riesegui il Deploy')
      else toast.error('Apertura BodySlide fallita', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Apertura BodySlide fallita', (e as Error).message)
    } finally {
      setBsBusy(false)
    }
  }

  const runBodySlideBuild = async () => {
    const profileId = useAppStore.getState().activeProfileId
    if (!profileId) {
      toast.warning('Nessun profilo attivo', 'Seleziona un profilo prima del build')
      return
    }
    const presetLabel = bsPreset || `automatico (${bsStatus?.defaultPreset ?? 'consigliato'})`
    const nudityLabel = bsNudity === 'nude' ? 'CORPI NUDI' : 'corpi nevernude (bra/mutande)'
    if (
      !window.confirm(
        `Batch build BodySlide col preset "${presetLabel}" · ${nudityLabel}?\n\nCostruisce corpi e TUTTI gli outfit della collection in automatico (può richiedere parecchi minuti). Non devi impostare nulla per i singoli gruppi. L'output va nella mod "BodySlide Output (generato)": al termine riesegui il Deploy per portarlo nel gioco.`,
      )
    )
      return
    setBsBusy(true)
    setBsReport(null)
    try {
      const r = await window.api.bodyslide.build(profileId, bsPreset || undefined, bsNudity)
      setBsReport(r)
      if (r.ok)
        toast.success('Batch build completato', `${r.filesBuilt} file generati · riesegui il Deploy per applicarli`)
      else toast.error('Batch build fallito', r.error ?? 'errore sconosciuto')
      await refreshBodySlide()
    } catch (e) {
      toast.error('Batch build fallito', (e as Error).message)
    } finally {
      setBsBusy(false)
      setBsProgress(null)
    }
  }

  // Preset ENB REALI: scan nelle mod estratte, apply nella root del gioco (backup+manifest).
  const [enbPresets, setEnbPresets] = useState<
    { modName: string; presetDir: string; label: string; files: number; hasCoreDll: boolean }[] | null
  >(null)
  const [enbBusy, setEnbBusy] = useState<'scan' | 'apply' | 'remove' | null>(null)

  const scanEnb = async () => {
    setEnbBusy('scan')
    try {
      const r = await window.api.enb.scan()
      setEnbPresets(r.presets)
      if (!r.presets.length) toast.info('Nessun preset ENB', 'Nessuna mod estratta contiene enbseries.ini/enblocal.ini')
      else toast.success(`${r.presets.length} preset ENB trovati`, 'Scegli quale applicare alla root del gioco')
    } catch (e) {
      toast.error('Scan ENB fallito', (e as Error).message)
    } finally {
      setEnbBusy(null)
    }
  }

  const applyEnb = async (presetDir: string, label: string) => {
    if (
      !window.confirm(
        `Applicare il preset ENB "${label}" alla root del gioco?\n\nGli originali preesistenti vengono salvati (.smm-enb-bak) e "Rimuovi preset ENB" ripristina tutto.`,
      )
    )
      return
    setEnbBusy('apply')
    try {
      const r = await window.api.enb.apply(presetDir, label)
      if (r.ok) {
        toast.success(
          'Preset ENB applicato',
          `${r.applied} file nella root del gioco · ${r.backedUp} originali salvati${r.removedPrevious ? ' · preset precedente rimosso' : ''}`,
        )
        if (!r.coreDllPresent)
          toast.warning(
            'Core ENB assente (d3d11.dll)',
            'Il preset non ha effetto senza il core: scaricalo da enbdev.com e metti d3d11.dll + d3dcompiler_46e.dll nella cartella del gioco',
          )
      } else toast.error('Apply ENB fallito', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Apply ENB fallito', (e as Error).message)
    } finally {
      setEnbBusy(null)
    }
  }

  const removeEnb = async () => {
    setEnbBusy('remove')
    try {
      const r = await window.api.enb.remove()
      if (r.ok) toast.success('Preset ENB rimosso', `${r.removed} file rimossi · ${r.restored} originali ripristinati`)
      else toast.error('Rimozione ENB fallita', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Rimozione ENB fallita', (e as Error).message)
    } finally {
      setEnbBusy(null)
    }
  }

  const refreshMasterlist = async () => {
    setMasterlistRefreshing(true)
    try {
      const res = await window.api.masterlist.refresh()
      if (res.ok) {
        setMasterlistStatus({ ...res, cached: true })
        toast.success(
          'Masterlist LOOT aggiornato',
          `${res.pluginCount ?? 0} plugin · ${res.ruleCount ?? 0} regole · ${res.dirtyCount ?? 0} entry dirty`,
        )
      } else {
        toast.error('Aggiornamento masterlist fallito', res.error ?? 'errore sconosciuto')
      }
    } catch (e) {
      toast.error('Aggiornamento masterlist fallito', (e as Error).message)
    } finally {
      setMasterlistRefreshing(false)
    }
  }

  const runVortexScan = async () => {
    setVortexBusy('scan')
    try {
      const res = await window.api.vortex.scan()
      setVortexScan(res)
      toast.success(
        `Vortex: ${res.mods.length} mod uniche`,
        `${res.collections.length} collezioni · ${res.duplicatesRemoved} doppioni rimossi`,
      )
    } catch (e) {
      toast.error('Scansione Vortex fallita', (e as Error).message)
    } finally {
      setVortexBusy(null)
    }
  }
  const buildVortexCatalog = async () => {
    setVortexBusy('catalog')
    try {
      const r = await window.api.vortex.buildCatalog()
      toast.success('catalog.json generato', `${r.total} mod → ${r.path}`)
    } catch (e) {
      toast.error('Generazione catalogo fallita', (e as Error).message)
    } finally {
      setVortexBusy(null)
    }
  }
  const runPandora = async () => {
    if (!settings.pandoraPath) {
      toast.warning('Pandora non configurato', 'Imposta il percorso in Impostazioni')
      return
    }
    if (!window.confirm('Pandora rigenererà i file di comportamento (behaviour) del gioco. Continuare?'))
      return
    setVortexBusy('pandora')
    try {
      const r = await window.api.tools.launchPandora()
      if (r.success) toast.success('Pandora avviato', 'Rigenerazione behaviour in corso')
      else toast.error('Pandora non avviato', r.error)
    } catch (e) {
      toast.error('Errore Pandora', (e as Error).message)
    } finally {
      setVortexBusy(null)
    }
  }

  const runTool = async (id: string, fn: () => Promise<{ success: boolean; error?: string }>) => {
    setRunning(id)
    try {
      const result = await fn()
      setResults((r) => ({ ...r, [id]: { success: result.success, message: result.error } }))
      if (result.success) toast.success(`${id.toUpperCase()} avviato`)
      else toast.error(`Errore ${id}`, result.error)
    } catch (e) {
      setResults((r) => ({ ...r, [id]: { success: false, message: String(e) } }))
    } finally {
      setRunning(null)
    }
  }

  const handleExport = (type: 'plugins' | 'modlist') => {
    const { pluginsTxt, modlistTxt } = exportLoadOrder()
    const text = type === 'plugins' ? pluginsTxt : modlistTxt
    const filename = type === 'plugins' ? 'plugins.txt' : 'modlist.txt'
    navigator.clipboard.writeText(text)
    setCopied(type)
    setTimeout(() => setCopied(null), 2000)
    toast.success(`${filename} copiato`, `${text.split('\n').length} righe negli appunti`)
  }

  const handleDownloadExport = (type: 'plugins' | 'modlist') => {
    const { pluginsTxt, modlistTxt } = exportLoadOrder()
    const text = type === 'plugins' ? pluginsTxt : modlistTxt
    const filename = type === 'plugins' ? 'plugins.txt' : 'modlist.txt'
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`${filename} scaricato`)
  }

  const handleMO2Import = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const result = await importFromMO2(text)
    toast.success('Import completato', `${result.imported} mod importate da MO2`)
    e.target.value = ''
  }

  const handleCheckAllUpdates = async () => {
    // The delta engine compares the installed snapshot against the latest ingested
    // manifest and needs no Nexus key; the key only matters for the legacy fallback.
    setCheckingUpdates(true)
    setUpdateResult(null)
    try {
      const result = await checkAllUpdates()
      setUpdateResult(result)
      if (result.updates > 0)
        toast.warning(`${result.updates} aggiornamenti disponibili`, `Controllate ${result.checked} mod`)
      else toast.success('Tutto aggiornato', `Controllate ${result.checked} mod`)
    } finally {
      setCheckingUpdates(false)
    }
  }

  // I percorsi degli exe sono risolti dal MAIN (settings store): il renderer chiede
  // solo QUALE tool avviare. Il check sul path serve unicamente per l'UX del messaggio.
  const TOOLS = [
    // NB: nessuna tile per Mod Organizer 2 — questo launcher È il mod manager (deploy
    // hardlink + plugins.txt di sistema + avvio via SKSE interno). Il percorso MO2 non è
    // nemmeno impostabile: la tile falliva sempre con "Percorso MO2 non configurato".
    {
      id: 'loot',
      name: 'LOOT',
      desc: 'Ordina automaticamente i plugin',
      color: '#4d7dff',
      icon: Zap,
      launch: () =>
        runTool('loot', () =>
          settings.lootPath
            ? window.api.tools.launchLOOT()
            : Promise.resolve({ success: false, error: 'Configura i percorsi nelle Impostazioni' }),
        ),
    },
    {
      id: 'sseedit',
      name: 'SSEEdit / xEdit',
      desc: 'Editor plugin .esp/.esm avanzato',
      color: '#ff6a2e',
      icon: Wrench,
      launch: () =>
        runTool('sseedit', () =>
          settings.sseeditPath
            ? window.api.tools.launchSSEEdit()
            : Promise.resolve({ success: false, error: 'Percorso SSEEdit non configurato' }),
        ),
    },
    {
      id: 'dyndolod',
      name: 'DynDOLOD',
      desc: 'LOD dinamici per alberi e distanze',
      color: '#4de0ff',
      icon: Globe,
      launch: () =>
        runTool('dyndolod', () =>
          settings.dyndolodPath
            ? window.api.tools.launchDynDOLOD()
            : Promise.resolve({ success: false, error: 'Percorso DynDOLOD non configurato' }),
        ),
    },
    {
      id: 'pandora',
      name: 'Pandora Behaviour',
      desc: 'Framework animazioni per MCO',
      color: '#ff80cc',
      icon: Zap,
      launch: () =>
        runTool('pandora', () =>
          settings.pandoraPath
            ? window.api.tools.launchPandora()
            : Promise.resolve({ success: false, error: 'Percorso Pandora non configurato' }),
        ),
    },
    {
      id: 'xlodgen',
      name: 'xLODGen',
      desc: 'LOD per terreni e oggetti statici',
      color: '#4dffaa',
      icon: Globe,
      url: 'https://stepmodifications.org/forum/topic/13451-xlodgen-terrain-lod-beta/',
    },
  ]

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h1 className="text-lg font-bold gradient-text-dragon" style={{ fontFamily: 'Cinzel, serif' }}>
        Strumenti Esterni
      </h1>

      {/* External tools grid */}
      <div className="grid grid-cols-2 gap-4">
        {TOOLS.map((tool) => {
          const Icon = tool.icon
          const result = results[tool.id]
          const isRunning = running === tool.id
          return (
            <div key={tool.id} className="card p-4 flex flex-col gap-2">
              <div className="flex items-start gap-3">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: `${tool.color}22` }}
                >
                  <Icon size={18} style={{ color: tool.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-white/90 text-sm">{tool.name}</h3>
                  <p className="text-xs text-dark-400 mt-0.5">{tool.desc}</p>
                </div>
              </div>
              {result && (
                <div
                  className={clsx(
                    'text-xs px-2 py-1 rounded',
                    result.success ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400',
                  )}
                >
                  {result.success ? '✓ Avviato' : `✗ ${result.message ?? 'Errore'}`}
                </div>
              )}
              <div className="flex gap-2 mt-auto">
                {tool.launch && (
                  <button
                    onClick={tool.launch}
                    disabled={isRunning}
                    className="btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
                    style={{ borderColor: tool.color + '44' }}
                  >
                    <Play size={12} style={{ color: tool.color }} />
                    {isRunning ? 'Avvio...' : 'Avvia'}
                  </button>
                )}
                {tool.url && (
                  <button
                    onClick={() => window.api.fs.openExternal(tool.url!)}
                    className="btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
                  >
                    <ExternalLink size={12} /> Download
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Export Load Order */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <FileCode size={15} className="text-soul-400" /> Export Load Order
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Esporta il load order in formato compatibile con MO2 e LOOT ({mods.length} mod).
        </p>
        <div className="grid grid-cols-2 gap-3">
          {(['plugins', 'modlist'] as const).map((type) => (
            <div key={type} className="space-y-2">
              <p className="text-xs font-semibold text-dark-300">
                {type === 'plugins' ? 'plugins.txt' : 'modlist.txt'}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleExport(type)}
                  className="btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
                >
                  {copied === type ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                  {copied === type ? 'Copiato!' : 'Copia'}
                </button>
                <button
                  onClick={() => handleDownloadExport(type)}
                  className="btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
                >
                  <Download size={12} /> Scarica
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Installer FOMOD headless (motore ufficiale Vortex): le mod estratte flat con
          ModuleConfig.xml vengono ristrutturate nel layout finale usando le SCELTE del
          curatore della collection (o i default dell'autore dove mancano). */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Wrench size={15} className="text-soul-400" /> Installer FOMOD (scelte collection)
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Le mod con installer FOMOD estratte "piatte" hanno gli asset dentro cartelle-opzione che il
          gioco ignora. Qui vengono ristrutturate col motore di Vortex: prima scarica le scelte del
          curatore, poi applica a tutte.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={fetchFomodChoices}
            disabled={fomodBusy !== null}
            className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <Download size={14} className={fomodBusy === 'fetch' ? 'animate-pulse' : ''} />
            {fomodBusy === 'fetch' ? 'Download…' : 'Scarica scelte del curatore'}
          </button>
          <button
            onClick={applyFomodAll}
            disabled={fomodBusy !== null || !fomodStatus?.total}
            className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg btn-primary disabled:opacity-50"
          >
            <Zap size={14} className={fomodBusy === 'apply' ? 'animate-pulse' : ''} />
            {fomodBusy === 'apply' ? 'Applicazione…' : `Applica a tutte (${(fomodStatus?.total ?? 0) - (fomodStatus?.applied ?? 0)})`}
          </button>
        </div>
        {fomodStatus && (
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-dark-300">
            <span>{fomodStatus.total ?? 0} mod con FOMOD</span>
            <span>·</span>
            <span className="text-green-400">{fomodStatus.applied ?? 0} già applicate</span>
            <span>·</span>
            <span>{fomodStatus.choicesCached ? `${fomodStatus.withChoices ?? 0} con scelte del curatore` : 'scelte del curatore NON ancora scaricate'}</span>
          </div>
        )}
        {fomodProgress && fomodBusy === 'apply' && (
          <div className="mt-3">
            <div className="flex justify-between text-xs text-dark-400 mb-1">
              <span className="truncate">{fomodProgress.current}</span>
              <span className="font-mono">{fomodProgress.done}/{fomodProgress.total}</span>
            </div>
            <div className="h-1.5 bg-dark-700 rounded-full overflow-hidden">
              <div
                className="progress-shimmer h-full rounded-full transition-all"
                style={{ width: fomodProgress.total ? `${(fomodProgress.done / fomodProgress.total) * 100}%` : '0%' }}
              />
            </div>
          </div>
        )}
        {fomodReport?.ok && ((fomodReport.failed?.length ?? 0) > 0 || (fomodReport.unsupported?.length ?? 0) > 0) && (
          <div className="mt-3 space-y-1 text-xs max-h-40 overflow-y-auto">
            {fomodReport.unsupported?.map((m) => (
              <p key={m} className="text-orange-300">
                {m}: installer non-XML (richiede intervento manuale)
              </p>
            ))}
            {fomodReport.failed?.map((f) => (
              <p key={f.mod} className="text-red-300">
                {f.mod}: {f.error}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* ESL-ify: il motore ha 254 slot FULL totali; i plugin pure-override (zero record
          nuovi) possono passare allo slot FE con un flag — pratica standard, qui verificata
          sul contenuto reale del file prima di toccare qualsiasi byte. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Zap size={15} className="text-orange-400" /> Slot plugin (ESL-ify)
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Se il deploy si blocca per "Troppi plugin FULL" (max 254), qui i patch <i>pure override</i>{' '}
          — zero record nuovi, verificato sul file — vengono flaggati light e passano nello slot FE
          (4096 posti). Backup <code className="text-void-400">.smm-esl-bak</code> accanto a ogni file.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => eslRun(false)} disabled={eslBusy !== null} className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50">
            <RefreshCw size={14} className={eslBusy === 'scan' ? 'animate-spin' : ''} />
            {eslBusy === 'scan' ? 'Analisi…' : 'Analizza budget slot'}
          </button>
          <button
            onClick={() => eslRun(true)}
            disabled={eslBusy !== null || !eslStatus?.ok || (eslStatus?.slotsToFree ?? 0) === 0}
            className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg btn-primary disabled:opacity-50"
          >
            <Zap size={14} className={eslBusy === 'apply' ? 'animate-pulse' : ''} />
            {eslBusy === 'apply' ? 'Flag in corso…' : `Libera ${eslStatus?.slotsToFree ?? ''} slot (flag light)`}
          </button>
        </div>
        {eslStatus?.ok && eslStatus.budget && (
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat label={`FULL su ${eslStatus.budget.maxFull}`} value={eslStatus.budget.full} />
            <Stat label="Light (slot FE)" value={eslStatus.budget.light} />
            <Stat label="Candidati pure-override" value={eslStatus.eligible?.length ?? 0} />
          </div>
        )}
        {eslStatus?.ok && (eslStatus.flagged?.length ?? 0) > 0 && (
          <div className="mt-3 space-y-1 text-xs max-h-32 overflow-y-auto">
            {eslStatus.flagged!.map((f) => (
              <p key={f.name} className="text-green-400">
                {f.name} → light
              </p>
            ))}
            <p className="text-dark-300">Riesegui il Deploy per applicare il nuovo budget.</p>
          </div>
        )}
        {eslStatus?.errors?.map((e) => (
          <p key={e} className="mt-2 text-xs text-red-300">
            {e}
          </p>
        ))}
      </div>

      {/* BodySlide batch build headless: corpi (CBBE/3BA), fisiche (pesi SMP/CBPC nei mesh) e
          TUTTI gli outfit adattati al preset — l'output è una mod generata che vince i
          conflitti al Deploy successivo (mai scritture in-place negli hardlink di Data). */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Activity size={15} className="text-pink-400" /> BodySlide — corpi, fisiche e outfit
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Costruisce i corpi e adatta <b>tutti</b> gli outfit della collection in automatico (batch headless
          con morph <code className="text-void-400">.tri</code> per RaceMenu/OStim). Lascia il preset su
          <b> Automatico</b> e premi Build: non serve impostare nulla per i singoli gruppi. Vuoi scegliere il
          corpo a mano? Usa <b>Apri BodySlide</b>. Richiede il Deploy già eseguito; al termine <b>riesegui il
          Deploy</b> per portare i mesh nel gioco.
        </p>

        {bsStatus && !bsStatus.ok && <p className="text-xs text-red-400 mb-3">{bsStatus.error}</p>}
        {bsStatus?.ok && (
          <>
            <div className="flex flex-wrap gap-2 mb-3 text-[11px]">
              <span className={clsx('px-2 py-1 rounded-lg border', bsStatus.exeFound ? 'border-green-900/50 bg-green-900/20 text-green-400' : 'border-red-900/50 bg-red-900/20 text-red-300')}>
                {bsStatus.exeFound ? 'BodySlide deployato' : 'BodySlide non deployato'}
              </span>
              <span className={clsx('px-2 py-1 rounded-lg border', bsStatus.deployed ? 'border-green-900/50 bg-green-900/20 text-green-400' : 'border-orange-900/50 bg-orange-900/20 text-orange-300')}>
                {bsStatus.deployed ? 'Deploy attivo' : 'Deploy assente'}
              </span>
              {([['Corpo CBBE/3BA', bsStatus.prereqs.body], ['CBPC', bsStatus.prereqs.cbpc], ['FSMP (HDT-SMP)', bsStatus.prereqs.fsmp], ['Scheletro XP32', bsStatus.prereqs.skeleton]] as const).map(
                ([label, ok]) => (
                  <span
                    key={label}
                    className={clsx('px-2 py-1 rounded-lg border', ok ? 'border-green-900/50 bg-green-900/20 text-green-400' : 'border-orange-900/50 bg-orange-900/20 text-orange-300')}
                    title={ok ? 'Presente e abilitata' : 'Mod non trovata tra le abilitate'}
                  >
                    {ok ? '✓' : '!'} {label}
                  </span>
                ),
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <Stat label="Progetti (.osp)" value={bsStatus.setsCount} />
              <Stat label="Gruppi outfit" value={bsStatus.groupCount} />
              <Stat label="Preset" value={bsStatus.presets.length} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={bsPreset}
                onChange={(e) => setBsPreset(e.target.value)}
                disabled={bsBusy || !bsStatus.presets.length}
                className="input-field text-xs py-1.5 max-w-xs"
                title="Automatico usa il preset consigliato (copre più outfit). Il pass HIMBO usa comunque il suo preset dedicato."
              >
                <option value="">
                  ⚡ Automatico — preset consigliato{bsStatus.defaultPreset ? ` (${bsStatus.defaultPreset})` : ''}
                </option>
                {bsStatus.presets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} — copre {p.coverage} gruppi
                  </option>
                ))}
              </select>
              {/* Nude vs nevernude: il corpo base è un outfit che scrive femalebody.nif; nude e
                  nevernude condividono file/gruppo, quindi l'app ricostruisce per ultimo la
                  variante scelta. Default NUDE. */}
              <div className="inline-flex rounded-lg border border-void-800 overflow-hidden text-xs">
                {(['nude', 'nevernude'] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setBsNudity(v)}
                    disabled={bsBusy}
                    className={clsx(
                      'px-2.5 py-1.5 transition-all disabled:opacity-50',
                      bsNudity === v ? 'bg-pink-500/25 text-pink-200' : 'bg-void-950/40 text-void-400 hover:text-white',
                    )}
                    title={v === 'nude' ? 'Corpi nudi (default)' : 'Corpi con bra/mutande (nevernude)'}
                  >
                    {v === 'nude' ? 'Nudo' : 'Nevernude'}
                  </button>
                ))}
              </div>
              <button
                onClick={runBodySlideBuild}
                disabled={bsBusy || !bsStatus.exeFound || !bsStatus.deployed}
                className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg btn-primary disabled:opacity-50"
              >
                <Zap size={14} className={bsBusy ? 'animate-pulse' : ''} />
                {bsBusy ? 'Build in corso…' : 'Batch build corpi + outfit'}
              </button>
              <button
                onClick={openBodySlide}
                disabled={bsBusy || !bsStatus.exeFound || !bsStatus.deployed}
                className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all disabled:opacity-50"
                title="Apri l'interfaccia di BodySlide per scegliere corpo e preset a mano. L'output resta isolato nella mod generata."
              >
                <Activity size={14} /> Apri BodySlide
              </button>
            </div>
            {bsProgress && bsBusy && (
              <div className="mt-3">
                <div className="flex justify-between text-xs text-dark-400 mb-1">
                  <span className="truncate">{bsProgress.label}</span>
                  <span className="font-mono">
                    pass {bsProgress.pass}/{bsProgress.passes} · lotto {bsProgress.chunk}/{bsProgress.chunks}
                  </span>
                </div>
                <div className="h-1.5 bg-dark-700 rounded-full overflow-hidden">
                  <div
                    className="progress-shimmer h-full rounded-full transition-all"
                    style={{
                      width: `${((bsProgress.pass - 1 + bsProgress.chunk / Math.max(1, bsProgress.chunks)) / Math.max(1, bsProgress.passes)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {bsReport && (
              <div className="mt-3 space-y-1 text-xs">
                {bsReport.passes.map((p) => (
                  <p key={p.label} className={p.failedChunks ? 'text-orange-300' : 'text-dark-300'}>
                    {p.label}: preset <span className="text-white/85">{p.preset}</span> · {p.groups} gruppi ·{' '}
                    {p.chunks - p.failedChunks}/{p.chunks} lotti ok
                  </p>
                ))}
                {bsReport.ok && (
                  <p className="text-green-400">
                    {bsReport.filesBuilt} file generati in "BodySlide Output (generato)" — riesegui il Deploy per applicarli.
                  </p>
                )}
                {!bsReport.ok && bsReport.error && <p className="text-red-300">{bsReport.error}</p>}
              </div>
            )}
          </>
        )}
      </div>

      {/* Preset ENB REALI (sostituisce il vecchio mock): scan nelle mod estratte, apply nella
          ROOT del gioco con backup+manifest — il deploy non copre i file fuori da Data. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Palette size={15} className="text-void-400" /> Preset ENB
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Cerca i preset ENB dentro le mod estratte e applicali alla <b>root del gioco</b> (enbseries.ini,
          enblocal.ini, cartelle enbseries/). Originali salvati e ripristinabili. Il core ENB
          (d3d11.dll) va scaricato a parte da enbdev.com.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={scanEnb} disabled={enbBusy !== null} className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50">
            <Palette size={14} className={enbBusy === 'scan' ? 'animate-pulse' : ''} />
            {enbBusy === 'scan' ? 'Ricerca…' : 'Cerca preset ENB'}
          </button>
          <button
            onClick={removeEnb}
            disabled={enbBusy !== null}
            className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg bg-red-950/40 text-red-300 hover:bg-red-900/50 transition-all disabled:opacity-50"
            title="Rimuove il preset applicato e ripristina gli originali dal manifest"
          >
            <X size={14} /> Rimuovi preset ENB
          </button>
        </div>
        {enbPresets && enbPresets.length > 0 && (
          <div className="mt-4 space-y-2">
            {enbPresets.map((p) => (
              <div
                key={p.presetDir}
                className="flex items-center gap-3 p-2.5 rounded-lg border border-dark-800 hover:border-dark-600 transition-all"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white/85 font-medium truncate">{p.label}</p>
                  <p className="text-xs text-dark-400">
                    {p.files} file{p.hasCoreDll ? ' · include d3d11.dll' : ''}
                  </p>
                </div>
                <button
                  onClick={() => applyEnb(p.presetDir, p.label)}
                  disabled={enbBusy !== null}
                  className="text-xs px-2.5 py-1 rounded-lg bg-void-900/40 text-void-300 hover:bg-void-800/60 transition-all disabled:opacity-50"
                >
                  Applica
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Check all updates */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <RefreshCw size={15} className="text-green-400" /> Controlla Aggiornamenti
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Verifica via Nexus API se ci sono aggiornamenti per tutte le mod installate. Richiede API Key.
        </p>
        <div className="flex items-center gap-4">
          <button
            onClick={handleCheckAllUpdates}
            disabled={checkingUpdates}
            className="btn-ghost flex items-center gap-2 text-sm"
          >
            <RefreshCw size={14} className={checkingUpdates ? 'animate-spin' : ''} />
            {checkingUpdates ? 'Controllo in corso...' : 'Controlla tutte'}
          </button>
          {updateResult && (
            <div
              className={clsx(
                'text-xs px-3 py-1.5 rounded-lg',
                updateResult.updates > 0
                  ? 'bg-orange-900/30 text-orange-300'
                  : 'bg-green-900/30 text-green-400',
              )}
            >
              {updateResult.updates > 0
                ? `${updateResult.updates} aggiornamenti su ${updateResult.checked} mod`
                : `Tutte le ${updateResult.checked} mod sono aggiornate`}
            </div>
          )}
        </div>
      </div>

      {/* Import from MO2 */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Upload size={15} className="text-orange-400" /> Import da MO2
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Importa una modlist esistente da Mod Organizer 2 (file{' '}
          <code className="text-void-400">modlist.txt</code>).
        </p>
        <input ref={mo2ImportRef} type="file" accept=".txt" onChange={handleMO2Import} className="hidden" />
        <button
          onClick={() => mo2ImportRef.current?.click()}
          className="btn-ghost flex items-center gap-2 text-sm"
        >
          <Upload size={14} /> Seleziona modlist.txt
        </button>
      </div>

      {/* Import from Vortex (read-only scan → catalog → Pandora, one-click & gated) */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Database size={15} className="text-soul-400" /> Import da Vortex (collezioni Nexus)
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Legge la staging folder di Vortex (<code className="text-void-400">…\Vortex\skyrimse\mods</code>),
          estrae modId/fileId dai <code className="text-void-400">collection.json</code>, deduplica e genera
          il catalogo. Solo lettura.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={runVortexScan}
            disabled={vortexBusy !== null}
            className="btn-ghost flex items-center gap-2 text-sm"
          >
            <Database size={14} className={vortexBusy === 'scan' ? 'animate-pulse' : ''} />
            {vortexBusy === 'scan' ? 'Scansione…' : 'Scansiona Vortex'}
          </button>
          <button
            onClick={buildVortexCatalog}
            disabled={vortexBusy !== null || !vortexScan}
            className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-40"
          >
            <Download size={14} /> {vortexBusy === 'catalog' ? 'Generazione…' : 'Genera catalog.json'}
          </button>
          <button
            onClick={runPandora}
            disabled={vortexBusy !== null}
            title="Rigenera i file di comportamento (azione che modifica il gioco)"
            className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg bg-orange-900/30 text-orange-300 hover:bg-orange-900/50 transition-all disabled:opacity-40"
          >
            <Activity size={14} className={vortexBusy === 'pandora' ? 'animate-pulse' : ''} /> Rigenera
            behaviour (Pandora)
          </button>
        </div>

        {vortexScan && (
          <div className="mt-4 text-xs space-y-2">
            <div className="flex flex-wrap gap-2">
              {vortexScan.collections.map((c) => (
                <span
                  key={c}
                  className="px-2 py-1 rounded-lg bg-dark-800/70 border border-dark-700 text-white/80"
                >
                  {c}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Mod uniche" value={vortexScan.mods.length} />
              <Stat label="Doppioni rimossi" value={vortexScan.duplicatesRemoved} />
              <Stat label="Cartelle staging" value={vortexScan.folderCount} />
            </div>
            <p className="text-dark-500">
              {vortexScan.mods.filter((m) => m.fileId != null).length} con fileId ·{' '}
              {vortexScan.mods.filter((m) => m.source === 'folder').length} da nome cartella · base resources:{' '}
              {vortexScan.mods.filter((m) => [17230, 32444, 106097].includes(m.modId)).length}
            </p>
          </div>
        )}

        <div className="mt-3 flex items-start gap-2 text-[11px] text-dark-500">
          <Info size={12} className="flex-shrink-0 mt-0.5 text-soul-400" />
          La scansione gira anche automaticamente all'avvio (read-only). Download/estrazione e Pandora restano
          azioni esplicite: l'app non scarica né modifica il gioco senza il tuo consenso.
        </div>
      </div>

      {/* Masterlist LOOT reale: regole after community-curate + rank di gruppo + CRC dirty-plugin,
          usate dal deploy per il load order e per segnalare i plugin da pulire con SSEEdit. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Zap size={15} className="text-blue-400" /> Masterlist LOOT
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Scarica il masterlist ufficiale (<code className="text-void-400">loot/skyrimse</code>): migliaia di
          regole di ordinamento e firme CRC dei plugin "sporchi" (ITM/UDR). Il deploy le legge SOLO dalla cache
          locale — mai una richiesta di rete durante il deploy stesso.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={refreshMasterlist}
            disabled={masterlistRefreshing}
            className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={masterlistRefreshing ? 'animate-spin' : ''} />
            {masterlistRefreshing ? 'Aggiornamento…' : 'Aggiorna masterlist'}
          </button>
        </div>
        {masterlistStatus?.cached ? (
          <div className="mt-4 grid grid-cols-4 gap-3 text-xs">
            <Stat label="Plugin" value={masterlistStatus.pluginCount ?? 0} />
            <Stat label="Gruppi" value={masterlistStatus.groupCount ?? 0} />
            <Stat label="Regole after" value={masterlistStatus.ruleCount ?? 0} />
            <Stat label="Firme dirty" value={masterlistStatus.dirtyCount ?? 0} />
          </div>
        ) : (
          masterlistStatus && <p className="mt-3 text-xs text-dark-500">Nessuna cache: premi "Aggiorna masterlist".</p>
        )}
        {masterlistStatus?.fetchedAt && (
          <p className="mt-2 text-[11px] text-dark-500">
            Ultimo aggiornamento: {new Date(masterlistStatus.fetchedAt).toLocaleString('it-IT')}
          </p>
        )}
      </div>

      {/* Analizzatore crash log: sola lettura, nessuna azione sul gioco. Euristica piccola e
          onesta (modulo colpevole dalla call stack) — non un database di pattern noti come
          Phostwood's Crash Log Analyzer, sempre affiancata dal report strutturato completo. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <AlertTriangle size={15} className="text-red-400" /> Analizza crash log
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Legge un crash log (Crash Logger SSE/AE/VR o Trainwreck) e prova a indicare il modulo
          probabilmente coinvolto dalla call stack. Sola lettura: nessuna modifica al gioco.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={pickAndAnalyzeCrash} disabled={crashBusy} className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50">
            <FileCode size={14} /> Sfoglia file…
          </button>
          {crashEntries.length > 0 && (
            <select
              disabled={crashBusy}
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) analyzeCrash(e.target.value)
                e.target.value = ''
              }}
              className="input-field text-xs py-1.5"
            >
              <option value="" disabled>
                Recenti in {crashDir}…
              </option>
              {crashEntries.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.name} — {new Date(c.mtimeMs).toLocaleString('it-IT')}
                </option>
              ))}
            </select>
          )}
        </div>

        {crashBusy && <p className="mt-4 text-xs text-dark-500">Analisi in corso…</p>}

        {crashResult && !crashResult.ok && (
          <p className="mt-4 text-xs text-red-400">{crashResult.error}</p>
        )}

        {crashResult?.ok && crashResult.report && (
          <div className="mt-4 space-y-3 text-xs">
            {!crashResult.report.recognized && (
              <p className="text-orange-400">File non riconosciuto come crash log Skyrim: mostro solo l'estratto grezzo.</p>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Plugin SKSE" value={crashResult.report.ssePlugins.length} />
              <Stat label="Plugin caricati" value={crashResult.report.plugins.length} />
              <Stat label="Frame call stack" value={crashResult.report.callStack.length} />
            </div>
            {crashResult.report.exceptionType && (
              <p className="text-dark-300">
                Eccezione: <span className="text-white/90">{crashResult.report.exceptionType}</span> in{' '}
                <span className="text-white/90">{crashResult.report.exceptionModule}</span>
                {crashResult.report.gameVersion && <> · {crashResult.report.gameVersion}</>}
              </p>
            )}
            {crashResult.analysis?.suggestions.map((s, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg bg-orange-900/20 border border-orange-900/40 px-3 py-2">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5 text-orange-400" />
                <span className="text-dark-200">{s}</span>
              </div>
            ))}
            {(crashResult.analysis?.knownPatterns?.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <p className="text-dark-400 font-semibold">
                  Firme note riconosciute{' '}
                  <span className="font-normal">(database derivato da Phostwood's Crash Log Analyzer)</span>:
                </p>
                {crashResult.analysis!.knownPatterns!.map((p) => (
                  <div key={p.id} className="rounded-lg bg-red-900/15 border border-red-900/40 px-3 py-2">
                    <p className="text-white/85 font-medium">
                      {p.label}{' '}
                      <span className="font-mono text-[10px] text-dark-400">[{p.matched.join(', ')}]</span>
                    </p>
                    <p className="text-dark-300 mt-0.5">{p.advice}</p>
                  </div>
                ))}
              </div>
            )}
            {crashResult.rawExcerpt && (
              <details className="mt-2">
                <summary className="cursor-pointer text-dark-400 hover:text-white/80">Estratto grezzo (prime righe)</summary>
                <pre className="mt-2 whitespace-pre-wrap break-all text-[10px] text-dark-400 bg-dark-900/60 rounded-lg p-3 max-h-64 overflow-y-auto">
                  {crashResult.rawExcerpt}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Preflight DLL SKSE (T14): sola lettura, legge SOLO l'header PE del plugin — nessun
          codice del plugin viene eseguito. Confronta compatibleVersions[] dichiarate vs il
          runtime del gioco, replicando la stessa logica dichiarativa che SKSE stesso usa. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Activity size={15} className="text-cyan-400" /> Preflight DLL SKSE
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Legge l'export <code className="text-void-400">SKSEPlugin_Version</code> di ogni plugin in{' '}
          <code className="text-void-400">Data/SKSE/Plugins</code> e lo confronta con la versione del gioco — prima
          del lancio, senza eseguire nulla del plugin.
        </p>
        <button onClick={runSksePreflight} disabled={skseBusy} className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50">
          <RefreshCw size={14} className={skseBusy ? 'animate-spin' : ''} /> {skseBusy ? 'Analisi…' : 'Scansiona plugin SKSE'}
        </button>
        {skseResult?.ok && (
          <div className="mt-4 space-y-1.5 text-xs">
            {skseResult.runtimeVersion && <p className="text-dark-500">Runtime gioco: {skseResult.runtimeVersion}</p>}
            {(skseResult.reports ?? []).length === 0 && <p className="text-dark-500">Nessun plugin SKSE trovato.</p>}
            {(skseResult.reports ?? [])
              .filter((r) => r.verdict !== 'ok')
              .map((r) => (
                <div
                  key={r.file}
                  className={clsx(
                    'rounded-lg px-3 py-2 border',
                    r.verdict === 'incompatible' && 'bg-red-900/15 border-red-900/40 text-red-300',
                    r.verdict === 'warning' && 'bg-orange-900/15 border-orange-900/40 text-orange-300',
                    r.verdict === 'unknown' && 'bg-dark-800/40 border-dark-700 text-dark-400',
                  )}
                >
                  <p className="font-medium text-white/85">{r.file.split(/[\\/]/).pop()}</p>
                  <p className="mt-0.5">{r.reason}</p>
                </div>
              ))}
            {(skseResult.reports ?? []).filter((r) => r.verdict === 'ok').length > 0 && (
              <p className="text-green-400">✓ {(skseResult.reports ?? []).filter((r) => r.verdict === 'ok').length} plugin compatibili</p>
            )}
          </div>
        )}
      </div>

      {/* Validazione header ESP (T15): range FormID ESL + form43/44 informativo, sui plugin
          realmente deployati nell'istanza attiva. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Database size={15} className="text-lime-400" /> Valida plugin ESP
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Controlla il range FormID dei plugin ESL/light (0x800-0xFFF, esteso a 0x001-0xFFF con header 1.71) e
          riporta il form-version (43/44) per informazione — mai bloccante.
        </p>
        <button onClick={runEspValidate} disabled={espBusy} className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50">
          <RefreshCw size={14} className={espBusy ? 'animate-spin' : ''} /> {espBusy ? 'Validazione…' : 'Valida plugin deployati'}
        </button>
        {espResult?.ok && (
          <div className="mt-4 space-y-1.5 text-xs">
            {(espResult.reports ?? []).length === 0 && <p className="text-dark-500">Nessun plugin deployato trovato.</p>}
            {(espResult.reports ?? [])
              .filter((r) => r.verdict === 'error')
              .map((r) => (
                <div key={r.name} className="rounded-lg px-3 py-2 border bg-red-900/15 border-red-900/40 text-red-300">
                  <p className="font-medium text-white/85">{r.name}</p>
                  <p className="mt-0.5">{r.reason}</p>
                </div>
              ))}
            {(espResult.reports ?? []).filter((r) => r.verdict === 'error').length === 0 && (
              <p className="text-green-400">✓ {(espResult.reports ?? []).length} plugin nel range valido</p>
            )}
          </div>
        )}
      </div>

      {/* Preset INI derivati da BethINI Pie (T18): Grass/Distant Detail/Shadow — scrive nei
          file ini reali (Documents/My Games), stessa firma dell'editor line-oriented usato dal
          Deploy (preserva commenti/ordine/chiavi non gestite). */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Palette size={15} className="text-pink-400" /> Preset INI (BethINI Pie)
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Applica valori Grass/Distant Detail/Shadow ricavati da BethINI Pie. "Bethini" sono i valori ottimizzati
          per performance; "Vanilla" replica i preset ufficiali low/medium/high/ultra di Bethesda.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={bethiniFlavor}
            onChange={(e) => {
              const f = e.target.value as 'bethini' | 'vanilla'
              setBethiniFlavor(f)
              if (!BETHINI_TIERS[f].includes(bethiniTier)) setBethiniTier('medium')
            }}
            className="input-field text-xs py-1.5"
          >
            <option value="bethini">Bethini (ottimizzato)</option>
            <option value="vanilla">Vanilla (ufficiale)</option>
          </select>
          <select value={bethiniTier} onChange={(e) => setBethiniTier(e.target.value as typeof bethiniTier)} className="input-field text-xs py-1.5">
            {BETHINI_TIERS[bethiniFlavor].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button onClick={applyBethiniPreset} disabled={bethiniBusy} className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50">
            <Check size={14} /> {bethiniBusy ? 'Applicazione…' : 'Applica preset'}
          </button>
        </div>
        {tierExceedsHardware && (
          <div className="flex items-start gap-2 rounded-lg bg-orange-900/15 border border-orange-900/40 px-3 py-2 mt-3 text-xs text-orange-300">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <span>
              Tier "{bethiniTier}" sopra quanto {hardwareInfo?.gpuName ?? 'la GPU rilevata'} suggerisce (consigliato:
              "{hardwareInfo?.suggestedMaxTier}"). Solo un avviso: puoi applicarlo comunque.
            </span>
          </div>
        )}
      </div>

      {/* Grass cache "autopilota" (T19): generare il contenuto della cache richiede
          INEVITABILMENTE il gioco reale in esecuzione (NGIO/GrassControl gira dentro il
          processo Skyrim) — qui si automatizza solo prerequisiti+lancio+supervisione+rilancio
          sui crash, mai la generazione stessa. Vedi electron/launch/grassCache.ts. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <RefreshCw size={15} className="text-emerald-400" /> Grass Cache — Autopilota
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Avvia il gioco e lo rilancia automaticamente sui crash attesi finché NGIO non completa il precache
          dell'erba (25 minuti - 2,5 ore). Non genera nulla senza il gioco reale in esecuzione — nessun tool
          headless per questo esiste allo stato dell'arte.
        </p>
        {grassStatus?.ok && (
          <div className="mb-4 grid grid-cols-3 gap-3 text-xs">
            <Stat label="File .cgid" value={grassStatus.summary?.totalFiles ?? 0} />
            <Stat label="Worldspace" value={Object.keys(grassStatus.summary?.byWorldspace ?? {}).length} />
            <Stat label="Marker attivo" value={grassStatus.prereqs?.markerPresent ? 1 : 0} />
          </div>
        )}
        {grassStatus?.ok && grassStatus.prereqs && !grassStatus.prereqs.ready && grassStatus.prereqs.issues.length > 0 && (
          <div className="mb-4 space-y-1.5 text-xs">
            {grassStatus.prereqs.issues.map((issue, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg bg-orange-900/20 border border-orange-900/40 px-3 py-2">
                <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-orange-400" />
                <span className="text-dark-200">{issue}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={startGrassPrecache} disabled={grassBusy} className="btn-primary flex items-center gap-2 text-sm disabled:opacity-50">
            <RefreshCw size={14} className={grassBusy ? 'animate-spin' : ''} /> {grassBusy ? 'In corso…' : 'Avvia autopilota'}
          </button>
          {grassStatus?.ok && grassStatus.prereqs?.markerPresent && !grassBusy && (
            <button
              onClick={async () => {
                await window.api.grass.clearMarker()
                refreshGrassStatus()
              }}
              className="btn-ghost flex items-center gap-2 text-sm"
              title="Rimuove il file marcatore senza avviare nulla (per ripartire da zero)"
            >
              <X size={13} /> Azzera marker
            </button>
          )}
        </div>
        {grassBusy && grassProgress && (
          <p className="mt-3 text-xs text-emerald-300">
            Tentativo {grassProgress.attempt} — {grassProgress.status}
          </p>
        )}
      </div>

      {/* Workflow guide */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-3 flex items-center gap-2 text-sm">
          <Info size={15} className="text-soul-400" /> Ordine di esecuzione consigliato
        </h3>
        <ol className="space-y-2">
          {[
            { n: 1, text: 'Installa tutte le mod tramite il Catalogo', color: '#7d4dff' },
            { n: 2, text: 'Esegui LOOT per ordinare i plugin', color: '#4d7dff' },
            { n: 3, text: 'Esegui Pandora Behaviour Engine per le animazioni', color: '#ff80cc' },
            { n: 4, text: 'Esegui xLODGen per i LOD del terreno', color: '#4dffaa' },
            { n: 5, text: 'Esegui DynDOLOD per i LOD degli alberi e oggetti', color: '#4de0ff' },
            { n: 6, text: 'Esegui il Deploy dalla Dashboard per collegare le mod al gioco', color: '#ff6a2e' },
            { n: 7, text: 'Batch build BodySlide (corpi/outfit sul preset), poi riesegui il Deploy', color: '#ff80cc' },
            { n: 8, text: 'Premi GIOCA: il launcher avvia Skyrim col suo SKSE interno', color: '#ff4500' },
          ].map(({ n, text, color }) => (
            <li key={n} className="flex items-center gap-3 text-sm text-dark-300">
              <span
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                style={{ background: color + '33', color }}
              >
                {n}
              </span>
              {text}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-dark-800/50 border border-dark-700 px-3 py-2">
      <div className="text-lg font-bold text-white">{value}</div>
      <div className="text-[11px] text-dark-400">{label}</div>
    </div>
  )
}
