import { useState } from 'react'
import { FolderOpen, Save, Key, CheckCircle, XCircle, ScrollText, Wand2, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { SEVENZIP_LICENSE, THIRD_PARTY_LICENSES } from '@/data/licenses'

interface SevenZipStatus {
  checking: boolean
  exists: boolean
  valid: boolean
  version: string | null
}

export default function Settings() {
  const { settings, updateSettings } = useAppStore()
  const [local, setLocal] = useState({ ...settings })
  const [nexusValidating, setNexusValidating] = useState(false)
  const [nexusValid, setNexusValid] = useState<boolean | null>(null)
  const [sevenZip, setSevenZip] = useState<SevenZipStatus | null>(null)
  const [saved, setSaved] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [detectMsg, setDetectMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Auto-detect game + tool paths (Steam registry + filesystem scan). Populates only
  // what it finds and persists it; missing tools stay blank (silent fallback).
  const runAutoDetect = async () => {
    const api = window.api as unknown as {
      settings?: {
        autoDetect?: () => Promise<{ ok: boolean; applied?: Record<string, string>; error?: string }>
      }
    }
    if (!api?.settings?.autoDetect) {
      setDetectMsg({ ok: false, text: "Disponibile solo nell'app desktop." })
      return
    }
    setDetecting(true)
    setDetectMsg(null)
    try {
      const r = await api.settings.autoDetect()
      if (!r.ok) {
        setDetectMsg({ ok: false, text: `Rilevamento fallito: ${r.error ?? ''}` })
        return
      }
      const applied = r.applied ?? {}
      const keys = Object.keys(applied)
      if (keys.length) setLocal((l) => ({ ...l, ...applied }))
      setDetectMsg({
        ok: true,
        text: keys.length
          ? `Rilevati e salvati ${keys.length}: ${keys.join(', ')}`
          : 'Nessun percorso rilevato automaticamente.',
      })
    } catch (e) {
      setDetectMsg({ ok: false, text: `Errore: ${(e as Error).message}` })
    } finally {
      setDetecting(false)
    }
  }

  const pickDir = async (field: keyof typeof local, title: string) => {
    const path = await window.api.fs.pickDirectory(title)
    if (path) setLocal((l) => ({ ...l, [field]: path }))
  }

  const pickFile = async (field: keyof typeof local, title: string) => {
    const path = await window.api.fs.pickFile(title, [{ name: 'Eseguibile', extensions: ['exe'] }])
    if (path) setLocal((l) => ({ ...l, [field]: path }))
  }

  const validateNexus = async () => {
    if (!local.nexusApiKey) return
    setNexusValidating(true)
    const r = await window.api.nexus.validateKey(local.nexusApiKey)
    setNexusValid(r.success)
    setNexusValidating(false)
  }

  // Validate (or auto-detect, when path is omitted) the 7-Zip binary. Auto-detection
  // fills in the resolved path so it gets persisted on Save.
  const checkSevenZip = async (path?: string) => {
    setSevenZip({ checking: true, exists: false, valid: false, version: null })
    const r = await window.api.tools.validate7z(path)
    if (r.path && r.path !== local.sevenZipPath) setLocal((l) => ({ ...l, sevenZipPath: r.path! }))
    setSevenZip({ checking: false, exists: r.exists, valid: r.valid, version: r.version })
  }

  const pickSevenZip = async () => {
    const path = await window.api.fs.pickFile('Seleziona 7z.exe', [{ name: '7-Zip', extensions: ['exe'] }])
    if (path) {
      setLocal((l) => ({ ...l, sevenZipPath: path }))
      checkSevenZip(path)
    }
  }

  const save = async () => {
    try {
      await updateSettings(local)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setDetectMsg({ ok: false, text: `Salvataggio fallito: ${(e as Error).message}` })
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl space-y-6">
      <h1 className="text-lg font-bold gradient-text-void" style={{ fontFamily: 'Cinzel, serif' }}>
        Impostazioni
      </h1>

      {/* Nexus API */}
      <Section title="Nexus Mods API">
        <div className="space-y-3">
          <div>
            <label className="text-xs text-dark-300 mb-1 block">Chiave API Nexus Mods</label>
            <div className="flex gap-2">
              <input
                type="password"
                value={local.nexusApiKey ?? ''}
                onChange={(e) => setLocal((l) => ({ ...l, nexusApiKey: e.target.value }))}
                placeholder="Incolla la tua API key da Nexus Mods..."
                className="input-field flex-1"
              />
              <button
                onClick={validateNexus}
                disabled={nexusValidating}
                className="btn-ghost flex items-center gap-2 px-3"
              >
                <Key size={14} />
                {nexusValidating ? 'Verifica...' : 'Verifica'}
              </button>
              {nexusValid === true && <CheckCircle size={18} className="text-green-400 self-center" />}
              {nexusValid === false && <XCircle size={18} className="text-red-400 self-center" />}
            </div>
            <p className="text-xs text-dark-500 mt-1">
              Ottieni la tua API key da{' '}
              <span className="text-soul-400">nexusmods.com → Account → API Keys</span>
            </p>
          </div>

          <label className="flex items-start gap-3 cursor-pointer select-none pt-1">
            <input
              type="checkbox"
              checked={local.nexusEnabled === true}
              onChange={(e) => setLocal((l) => ({ ...l, nexusEnabled: e.target.checked }))}
              className="mt-0.5 accent-soul-500"
            />
            <span className="text-xs text-dark-300">
              <span className="font-semibold text-dark-100">Abilita download reali da Nexus (Premium)</span>
              <br />
              Attiva il provider HTTP e la risoluzione dei <code>download_link</code>. Richiede chiave valida
              e account <span className="text-soul-400">Nexus Premium</span> per il download diretto/massivo.
              Con questa spenta l'app resta in modalità sicura (mock), senza traffico verso Nexus.
            </span>
          </label>
        </div>
      </Section>

      {/* Remote catalog (delta updates) */}
      <Section title="Catalogo aggiornamenti (delta)">
        <div>
          <label className="text-xs text-dark-300 mb-1 block">URL catalogo firmato (HTTPS)</label>
          <input
            type="text"
            value={local.catalogUrl ?? ''}
            onChange={(e) => setLocal((l) => ({ ...l, catalogUrl: e.target.value }))}
            placeholder="https://.../catalog.remote.signed.json — vuoto = artefatto incluso"
            className="input-field w-full"
          />
          <p className="text-xs text-dark-500 mt-1">
            Se impostato, la pagina Aggiornamenti scarica il catalogo via HTTPS da un host consentito e ne
            verifica la firma Ed25519 (fail-closed). Vuoto → usa il catalogo firmato incluso nell'app.
          </p>
        </div>
      </Section>

      {/* 7-Zip (archive extraction) */}
      <Section title="Estrazione archivi (7-Zip)">
        <div className="space-y-2">
          <div
            className="flex items-start gap-2 rounded-lg p-2.5"
            style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)' }}
          >
            <CheckCircle size={14} className="text-green-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-dark-300">
              <strong className="text-white/80">7-Zip incluso nell'app:</strong> <code>.7z</code>,{' '}
              <code>.zip</code> <em>e</em> <code>.rar</code>
              (anche multi-GB) si estraggono nativamente, <strong>senza configurazione</strong>. Il campo
              sotto è <strong>opzionale</strong>: se imposti un 7-Zip di sistema, viene usato come interprete
              primario per i <code>.rar</code>.
            </p>
          </div>
          <label className="text-xs text-dark-300 mb-1 block">
            7-Zip di sistema (7z.exe) — opzionale (override per i <code>.rar</code>)
          </label>
          <div className="flex gap-2">
            {/* placeholder come stringa JS: nell'attributo JSX nudo il rolldown-scanner di
                vite 8 legge "\7" come octal escape deprecato e fallisce il dep-scan a ogni boot. */}
            <input
              type="text"
              value={local.sevenZipPath ?? ''}
              onChange={(e) => {
                setLocal((l) => ({ ...l, sevenZipPath: e.target.value }))
                setSevenZip(null)
              }}
              placeholder={'C:\\Program Files\\7-Zip\\7z.exe'}
              className="input-field flex-1"
            />
            <button onClick={pickSevenZip} className="btn-ghost flex items-center gap-2 px-3">
              <FolderOpen size={14} /> Sfoglia
            </button>
            <button
              onClick={() => checkSevenZip(undefined)}
              className="btn-ghost px-3"
              title="Cerca 7-Zip nei percorsi di installazione standard"
            >
              Rileva
            </button>
            <button
              onClick={() => checkSevenZip(local.sevenZipPath)}
              disabled={sevenZip?.checking}
              className="btn-ghost px-3"
            >
              {sevenZip?.checking ? 'Verifica…' : 'Verifica'}
            </button>
            {sevenZip &&
              !sevenZip.checking &&
              (sevenZip.valid ? (
                <CheckCircle size={18} className="text-green-400 self-center flex-shrink-0" />
              ) : (
                <XCircle size={18} className="text-red-400 self-center flex-shrink-0" />
              ))}
          </div>

          {sevenZip && !sevenZip.checking && sevenZip.valid && (
            <p className="text-xs text-green-400/80">
              7-Zip valido{sevenZip.version ? ` (v${sevenZip.version})` : ''} ✓
            </p>
          )}
          {sevenZip && !sevenZip.checking && !sevenZip.valid && (
            <p className="text-xs text-red-400">
              {sevenZip.exists
                ? 'Il file esiste ma non sembra un 7-Zip valido.'
                : '7z.exe non trovato a questo percorso.'}
            </p>
          )}

          <p className="text-xs text-dark-500 mt-1">
            Non serve installare nulla: i <code>.rar</code> usano il 7-Zip completo incluso. Configura un
            7-Zip di sistema solo se vuoi una versione specifica —{' '}
            <span className="text-soul-400">Rileva</span> trova automaticamente{' '}
            <code>C:\Program Files\7-Zip\7z.exe</code>.
          </p>
        </div>
      </Section>

      {/* Paths */}
      <Section title="Percorsi Gioco e Strumenti">
        <div className="mb-4 flex items-center gap-3 flex-wrap">
          <button
            onClick={runAutoDetect}
            disabled={detecting}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 transition-all"
            style={{ background: 'linear-gradient(90deg,#7d4dff,#4d7dff)' }}
          >
            {detecting ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
            {detecting ? 'Rilevamento…' : 'Rileva Automaticamente'}
          </button>
          {detectMsg && (
            <span className={`text-xs ${detectMsg.ok ? 'text-green-400' : 'text-orange-400/90'}`}>
              {detectMsg.text}
            </span>
          )}
          <span className="text-[11px] text-dark-500 basis-full">
            Legge il registro Steam per la cartella Skyrim e scansiona le posizioni comuni per
            MO2/LOOT/SSEEdit/DynDOLOD/xLODGen/7-Zip/Pandora. I tool non trovati restano vuoti.
          </span>
        </div>
        {(
          [
            ['gamePath', 'Cartella Skyrim Anniversary Edition', 'dir', 'Seleziona cartella Skyrim AE'],
            ['mo2Path', 'Mod Organizer 2 (ModOrganizer.exe)', 'file', 'Seleziona ModOrganizer.exe'],
            [
              'modsPath',
              'Cartella mod (MO2 \\mods) — destinazione installazione',
              'dir',
              'Seleziona la cartella mods di MO2',
            ],
            ['lootPath', 'LOOT (LOOT.exe)', 'file', 'Seleziona LOOT.exe'],
            ['sseeditPath', 'SSEEdit (SSEEdit.exe)', 'file', 'Seleziona SSEEdit.exe'],
            ['dyndolodPath', 'DynDOLOD (DynDOLODx64.exe)', 'file', 'Seleziona DynDOLODx64.exe'],
            ['xlodgenPath', 'xLODGen (xLODGen.exe)', 'file', 'Seleziona xLODGen.exe'],
            ['pandoraPath', 'Pandora Behaviour Engine (Pandora.exe)', 'file', 'Seleziona Pandora.exe'],
          ] as [keyof typeof local, string, 'dir' | 'file', string][]
        ).map(([field, label, type, title]) => (
          <PathRow
            key={field}
            label={label}
            value={(local[field] as string) ?? ''}
            onChange={(v) => setLocal((l) => ({ ...l, [field]: v }))}
            onBrowse={() => (type === 'dir' ? pickDir(field, title) : pickFile(field, title))}
          />
        ))}
      </Section>

      {/* Automation */}
      <Section title="Automazione">
        <div className="space-y-3">
          {(
            [
              ['autoSort', "Ordina plugin automaticamente con LOOT dopo l'installazione"],
              ['checkConflicts', 'Rileva conflitti tra mod automaticamente'],
              ['autoBackup', 'Backup automatico profilo prima di modifiche importanti'],
            ] as [keyof typeof local, string][]
          ).map(([field, label]) => (
            <label key={field} className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={local[field] as boolean}
                onChange={(e) => setLocal((l) => ({ ...l, [field]: e.target.checked }))}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-dark-300">{label}</span>
            </label>
          ))}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-dark-300 mb-1 block">Thread paralleli</label>
              <input
                type="number"
                min={1}
                max={16}
                value={local.downloadThreads}
                onChange={(e) => setLocal((l) => ({ ...l, downloadThreads: parseInt(e.target.value) || 1 }))}
                className="input-field w-full"
              />
            </div>
            <div>
              <label
                className="text-xs text-dark-300 mb-1 block"
                title="Tentativi automatici prima di marcare un download come fallito"
              >
                Retry per download
              </label>
              <input
                type="number"
                min={0}
                max={10}
                value={local.downloadRetries ?? 3}
                onChange={(e) => setLocal((l) => ({ ...l, downloadRetries: parseInt(e.target.value) || 0 }))}
                className="input-field w-full"
              />
            </div>
            <div>
              <label
                className="text-xs text-dark-300 mb-1 block"
                title="Errori consecutivi oltre i quali la coda viene sospesa"
              >
                Soglia errori coda
              </label>
              <input
                type="number"
                min={1}
                max={500}
                value={local.errorThreshold ?? 50}
                onChange={(e) => setLocal((l) => ({ ...l, errorThreshold: parseInt(e.target.value) || 1 }))}
                className="input-field w-full"
              />
            </div>
          </div>

          <div>
            <label
              className="text-xs text-dark-300 mb-1 block"
              title="Il mass-installer seleziona automaticamente la variante di risoluzione di ogni mod: 2K = archivi più leggeri (meno spazio su disco), 4K = qualità massima. Fallback automatico se la variante scelta non esiste."
            >
              Qualità texture (mass-install)
            </label>
            <select
              value={local.textureQualityProfile ?? '4K'}
              onChange={(e) =>
                setLocal((l) => ({ ...l, textureQualityProfile: e.target.value as '2K' | '4K' }))
              }
              className="input-field w-full"
            >
              <option value="2K">2K — più leggero (risparmia spazio)</option>
              <option value="4K">4K — qualità massima</option>
            </select>
          </div>
          <label
            className="flex items-start gap-3 cursor-pointer select-none pt-1"
            title="Se una mod ha una traduzione italiana mappata, il mass-installer la scarica e la sovrappone nella stessa cartella (Fase B) sullo stesso slot di coda. Fail-soft: se la traduzione fallisce, la mod resta installata in inglese."
          >
            <input
              type="checkbox"
              checked={local.enableAutoTranslate !== false}
              onChange={(e) => setLocal((l) => ({ ...l, enableAutoTranslate: e.target.checked }))}
              className="mt-0.5 accent-soul-500"
            />
            <span className="text-sm text-dark-200">
              Applica automaticamente le traduzioni ITA (overlay a due fasi)
              <span className="block text-xs text-dark-400">
                Fail-soft: se la traduzione non è disponibile, la mod resta installata in inglese.
              </span>
            </span>
          </label>
        </div>
      </Section>

      {/* Language */}
      <Section title="Lingua">
        <div>
          <label className="text-xs text-dark-300 mb-1 block">Lingua interfaccia</label>
          <select
            value={local.language}
            onChange={(e) => setLocal((l) => ({ ...l, language: e.target.value as 'it' | 'en' }))}
            className="input-field w-40"
          >
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </select>
        </div>
      </Section>

      {/* Third-party licenses */}
      <Section title="Licenze di terze parti">
        <p className="text-xs text-dark-400">
          Questa applicazione include software di terze parti.{' '}
          <strong className="text-white/70">7-Zip</strong> è distribuito sotto{' '}
          <strong className="text-white/70">GNU LGPL</strong> con la{' '}
          <strong className="text-white/70">restrizione unRAR</strong>; la sua licenza completa è riprodotta
          qui sotto come richiesto dai termini di ridistribuzione.
        </p>

        <div className="flex flex-wrap gap-2">
          {THIRD_PARTY_LICENSES.map((l) => (
            <span
              key={l.name}
              title={l.note}
              className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-dark-800/70 border border-dark-700"
            >
              <span className="text-white/80">{l.name}</span>
              <span className="text-dark-500">·</span>
              <span className="text-void-300">{l.license}</span>
            </span>
          ))}
        </div>

        <div
          className="rounded-lg border border-dark-700 overflow-hidden"
          style={{ background: 'rgba(10,10,12,0.6)' }}
        >
          <div className="px-3 py-2 border-b border-dark-800 flex items-center gap-2 text-xs text-dark-300">
            <ScrollText size={13} className="text-soul-400" /> 7-Zip — Licenza completa (GNU LGPL + unRAR +
            BSD-3)
          </div>
          <pre
            tabIndex={0}
            aria-label="Testo licenza 7-Zip"
            className="text-[11px] leading-relaxed text-dark-300 font-mono p-3 max-h-72 overflow-y-auto whitespace-pre-wrap"
          >
            {SEVENZIP_LICENSE}
          </pre>
        </div>
        <p className="text-xs text-dark-500">
          Il testo integrale è incluso anche come file <code>7-Zip-License.txt</code> accanto al binario
          distribuito.
        </p>
      </Section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button onClick={save} className="btn-primary flex items-center gap-2">
          <Save size={14} />
          Salva Impostazioni
        </button>
        {saved && (
          <div className="flex items-center gap-1.5 text-green-400 text-sm">
            <CheckCircle size={14} />
            Salvato!
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4 space-y-4">
      <h3 className="text-sm font-semibold text-white/70 border-b border-dark-800 pb-2">{title}</h3>
      {children}
    </div>
  )
}

function PathRow({
  label,
  value,
  onChange,
  onBrowse,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onBrowse: () => void
}) {
  return (
    <div>
      <label className="text-xs text-dark-400 mb-1 block">{label}</label>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Percorso non configurato..."
          className="input-field flex-1 font-mono text-xs"
        />
        <button onClick={onBrowse} className="btn-ghost flex items-center gap-1.5 px-3 flex-shrink-0">
          <FolderOpen size={13} />
          Sfoglia
        </button>
      </div>
    </div>
  )
}
