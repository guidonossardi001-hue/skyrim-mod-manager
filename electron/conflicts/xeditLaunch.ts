// Lancio MIRATO di SSEEdit su un conflitto (CONFLICTS Fase 3) — parte pura.
//
// xEdit su un load order da ~2000 plugin carica in minuti e mangia GB di RAM. Per
// risolvere UN conflitto bastano i partecipanti: si genera un plugins.txt temporaneo
// con SOLO quei plugin attivi e si passa -P:<file> + -autoload (stesso meccanismo già
// verificato dal QAC runner: flag documentati in TES5Edit whatsnew.md 4.0.x, pattern
// PACT). I master ricorsivi mancanti li carica xEdit da solo.
//
// Nessun salto diretto a un FormID via CLI (non esiste flag documentato): si copia in
// clipboard un hint di ricerca (EDID se noto, altrimenti l'object index esadecimale)
// che l'utente incolla nella barra FormID/ricerca di xEdit.

export interface XeditConflictPlanInput {
  /** Flag gioco per xEdit (es. "SSE"), come qacRunner. */
  gameFlag: string
  dataPath: string
  /** Path del plugins.txt TEMPORANEO minimale (lo scrive il chiamante). */
  pluginsTxtPath: string
  /** Nomi file dei partecipanti in ordine di caricamento. */
  participants: string[]
  edid: string | null
  formKey: string
}

export interface XeditConflictPlan {
  args: string[]
  pluginsTxtContent: string
  /** Testo da mettere in clipboard per ritrovare il record dentro xEdit. */
  clipboardHint: string
}

/** Object index esadecimale dalla formKey (`origine|hex6`) — fallback dell'hint. */
export function objectIndexFromFormKey(formKey: string): string {
  const hex = formKey.split('|')[1] ?? ''
  return /^[0-9a-f]{1,6}$/.test(hex) ? hex.toUpperCase().padStart(6, '0') : ''
}

export function buildXeditConflictPlan(input: XeditConflictPlanInput): XeditConflictPlan {
  // Dedup case-insensitive preservando l'ordine (il DB è già lowercase-keyed, ma i
  // display name arrivano col case originale).
  const seen = new Set<string>()
  const plugins = input.participants.filter((n) => {
    const k = n.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return {
    args: ['-' + input.gameFlag, '-autoload', `-D:${input.dataPath}`, `-P:${input.pluginsTxtPath}`],
    // Formato plugins.txt SE: '*' = attivo, CRLF come scrive il gioco.
    pluginsTxtContent: plugins.map((n) => `*${n}`).join('\r\n') + '\r\n',
    clipboardHint: input.edid ?? objectIndexFromFormKey(input.formKey),
  }
}
