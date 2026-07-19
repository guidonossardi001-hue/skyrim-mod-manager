// Identità globale di un record attraverso il load order (CONFLICTS Fase 1) — PURO.
//
// Un FormID nel FILE è relativo al plugin: il byte alto è l'indice nella lista MAST
// dell'header TES4 (< masters.length = il record vive nello spazio di quel master:
// override o injection; >= masters.length = record PROPRIO del plugin). La chiave
// globale NON usa l'indice di load order (cambia ad ogni riordino) ma la coppia
// stabile (file di ORIGINE lowercase, object index).
//
// Mask dell'object index: 24 bit per un'origine full, 12 bit se l'origine vive nello
// spazio light (slot FE, regola engine SE 1.6: estensione .esl forza light a prescindere
// dal flag — stessa regola di espParser.isMasterSpace). Nei file ben formati gli upper
// bit dei riferimenti a master light sono già zero: il mask a 12 bit è una difesa
// contro file sporchi, mai applicata a origini full (collasserebbe record distinti).
//
// NB: se un plugin cambia stato light DOPO che un dipendente è stato indicizzato, le
// chiavi cache del dipendente possono divergere solo quando gli upper bit erano sporchi
// (caso patologico); l'indice si riallinea alla prima rescansione del dipendente.

export interface FormKeyContext {
  /** Nome file del plugin che CONTIENE il record. */
  pluginName: string
  /** Master del plugin nell'ordine dei subrecord MAST dell'header TES4. */
  masters: string[]
  /** Lookup flag light per nome file (case-insensitive); undefined = sconosciuto → mask 24 bit. */
  isLight: (pluginName: string) => boolean | undefined
}

export interface ResolvedFormKey {
  /** Chiave globale stabile: `<origine lowercase>|<object index esadecimale>`. */
  key: string
  /** Nome file di origine del record (il plugin stesso per i record propri). */
  origin: string
  /** true = record nello spazio proprio del plugin (nuovo, non override). */
  isOwn: boolean
  objectIndex: number
}

/** Spazio light effettivo per l'ENGINE: .esl forza light, altrimenti decide il flag TES4. */
export function isLightSpace(name: string, headerLight: boolean | undefined): boolean {
  if (name.toLowerCase().endsWith('.esl')) return true
  return headerLight === true
}

export function resolveFormKey(formId: number, ctx: FormKeyContext): ResolvedFormKey {
  const masterIndex = formId >>> 24
  const isOwn = masterIndex >= ctx.masters.length
  const origin = isOwn ? ctx.pluginName : ctx.masters[masterIndex]
  const light = isLightSpace(origin, ctx.isLight(origin))
  const objectIndex = light ? formId & 0xfff : formId & 0xffffff
  return {
    key: `${origin.toLowerCase()}|${objectIndex.toString(16).padStart(6, '0')}`,
    origin,
    isOwn,
    objectIndex,
  }
}
