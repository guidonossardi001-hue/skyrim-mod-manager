import { readFile, writeFile, rename, rm, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { toLongPath } from '../install/extract'

// Per-instance INI manager (Skyrim.ini / SkyrimPrefs.ini). The hard requirement:
// NEVER rewrite these files wholesale — the user may have hand-tuned keys we don't
// know about. So this is a STRUCTURE-PRESERVING editor, not a parse→object→reserialize
// round-trip: it keeps every comment, blank line, key order and unknown key byte-for-byte,
// and only touches the exact keys a layer asks to set.
//
// Why not the `ini` npm package: it parses to a plain object and drops all comments and
// ordering on serialize — which would silently destroy a user's customized config. A
// line-oriented editor is the robust choice for "aggiorna senza corrompere".
//
// Three overlay levels, later wins (see applyIniSettings):
//   1. base      — clean defaults, seeded ONLY into a brand-new file.
//   2. settings  — the chosen quality template (Ultra / Performance / VR).
//   3. overrides — mod-required forced keys, injected into their exact section.

export type IniValue = string | number | boolean
/** section → key → value */
export type IniSections = Record<string, Record<string, IniValue>>
/** file name (e.g. 'Skyrim.ini') → sections */
export type IniFileMap = Record<string, IniSections>

export interface IniTemplate {
  name: string
  base?: IniFileMap // Level 1: seeded only into a fresh file (never clobbers user values)
  settings: IniFileMap // Level 2: quality-specific managed keys
}

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/

/**
 * Dialetto di serializzazione: lo stesso editor struttura-preservante serve sia gli INI di
 * Skyrim (booleano → 1/0, assegnazione `key=value`) sia il TOML di SSE Engine Fixes (booleano →
 * true/false, numeri nudi, stringhe quotate, assegnazione `key = value`). Iniettabile così
 * engineFixesConfig.ts riusa IniDocument senza duplicare la logica di preservazione.
 */
export interface IniDialect {
  serialize(v: IniValue): string
  /** Separatore scritto tra chiave e valore per le righe NUOVE/riscritte. */
  assign: string
}

/** Dialetto INI di Skyrim (comportamento storico, default di IniDocument). */
export const INI_DIALECT: IniDialect = {
  serialize: (v) => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v)),
  assign: '=',
}

/** Dialetto TOML (EngineFixes.toml): booleani letterali, numeri nudi, stringhe quotate. */
export const TOML_DIALECT: IniDialect = {
  serialize: (v) =>
    typeof v === 'boolean'
      ? v
        ? 'true'
        : 'false'
      : typeof v === 'number'
        ? String(v)
        : `"${String(v).replace(/([\\"])/g, '\\$1')}"`,
  assign: ' = ',
}

interface ParsedKv {
  indent: string
  key: string
  rest: string // everything after '=', used to salvage an inline comment
}

/** Parse a line as `key=value`, or null for section/comment/blank lines. */
function parseKv(line: string): ParsedKv | null {
  const t = line.trimStart()
  if (t === '' || t.startsWith(';') || t.startsWith('#') || t.startsWith('[')) return null
  const eq = line.indexOf('=')
  if (eq < 0) return null
  const indent = line.slice(0, line.length - t.length)
  const key = line.slice(indent.length, eq).trim()
  if (key === '') return null
  return { indent, key, rest: line.slice(eq + 1) }
}

interface SectionSpan {
  name: string
  header: number // index of the '[Name]' line, -1 for the pre-header global span
  start: number // first content line index (inclusive)
  end: number // one past the last content line (exclusive)
}

/** Ordered spans, including a leading global span (name '') for pre-header lines. */
function sectionSpans(lines: string[]): SectionSpan[] {
  const spans: SectionSpan[] = []
  let cur: SectionSpan = { name: '', header: -1, start: 0, end: lines.length }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SECTION_RE)
    if (m) {
      cur.end = i
      spans.push(cur)
      cur = { name: m[1].trim(), header: i, start: i + 1, end: lines.length }
    }
  }
  spans.push(cur)
  return spans
}

/**
 * In-memory model of an INI file as its raw lines. All mutations happen in place on
 * the line array, so anything not explicitly set is preserved exactly.
 */
export class IniDocument {
  private lines: string[]
  private readonly eol: string
  private readonly dialect: IniDialect

  constructor(text: string, dialect: IniDialect = INI_DIALECT) {
    this.dialect = dialect
    this.eol = text.includes('\r\n') ? '\r\n' : '\n'
    // Normalize to \n for splitting; a trailing newline yields a trailing '' element
    // which we keep so the re-joined output preserves the original final newline.
    this.lines = text.length === 0 ? [] : text.replace(/\r\n/g, '\n').split('\n')
  }

  /** Set section.key=value: replace in place, else insert into the section, else append the section. */
  setValue(section: string, key: string, value: IniValue): void {
    const val = this.dialect.serialize(value)
    const eq = this.dialect.assign
    const span = sectionSpans(this.lines).find((s) => s.name.toLowerCase() === section.toLowerCase())

    if (!span) {
      // Section absent → append a fresh block (blank separator if the file has content).
      if (this.lines.length && this.lines[this.lines.length - 1].trim() !== '') this.lines.push('')
      this.lines.push(`[${section}]`, `${key}${eq}${val}`)
      return
    }

    for (let i = span.start; i < span.end; i++) {
      const kv = parseKv(this.lines[i])
      if (kv && kv.key.toLowerCase() === key.toLowerCase()) {
        // Preserve the original key casing/indent and any inline comment after the value.
        const inline = kv.rest.match(/\s+[;#].*$/)
        this.lines[i] = `${kv.indent}${kv.key}${eq}${val}${inline ? inline[0] : ''}`
        return
      }
    }

    // Key absent in the section → insert after its last content line (before trailing blanks).
    let at = span.end
    while (at > span.start && this.lines[at - 1].trim() === '') at--
    this.lines.splice(at, 0, `${key}${eq}${val}`)
  }

  toString(): string {
    return this.lines.join(this.eol)
  }
}

function applyLayer(doc: IniDocument, sections: IniSections | undefined): void {
  if (!sections) return
  for (const [section, kv] of Object.entries(sections))
    for (const [key, value] of Object.entries(kv)) doc.setValue(section, key, value)
}

/**
 * Atomic write: write `<path>.tmp` then rename onto the target. A crash or failure
 * before the rename leaves the original file completely untouched (rename is the only
 * operation that mutates the real path, and it is atomic on NTFS). The tmp is cleaned
 * on any failure so a partial write never lingers.
 */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`
  try {
    await writeFile(toLongPath(tmp), content, 'utf8')
    await rename(toLongPath(tmp), toLongPath(path))
  } catch (e) {
    await rm(toLongPath(tmp), { force: true }).catch(() => {})
    throw e
  }
}

/**
 * Apply the layered INI settings to an instance/profile directory. For each managed
 * file it loads the existing content (preserving every user setting), overlays the
 * template then the mod-required overrides, and writes it back atomically.
 *
 * @param instanceDir profile directory that holds Skyrim.ini / SkyrimPrefs.ini
 * @param template    Level 1 (base, seeded only when the file is new) + Level 2 (settings)
 * @param overrides   Level 3: mod-required forced keys (win over the template)
 */
export async function applyIniSettings(
  instanceDir: string,
  template: IniTemplate,
  overrides: IniFileMap,
): Promise<void> {
  const files = new Set<string>([
    ...Object.keys(template.base ?? {}),
    ...Object.keys(template.settings ?? {}),
    ...Object.keys(overrides ?? {}),
  ])
  if (files.size) await mkdir(toLongPath(instanceDir), { recursive: true })

  for (const file of files) {
    const target = join(instanceDir, file)
    let doc: IniDocument
    if (existsSync(toLongPath(target))) {
      doc = new IniDocument(await readFile(toLongPath(target), 'utf8'))
    } else {
      // Fresh file: seed the Level-1 clean defaults, then overlay the rest.
      doc = new IniDocument('')
      applyLayer(doc, template.base?.[file])
    }
    applyLayer(doc, template.settings?.[file]) // Level 2
    applyLayer(doc, overrides?.[file]) // Level 3 wins
    await atomicWrite(target, doc.toString())
  }
}

/** Deep-merge two file→section→key maps (b wins). Used to fold optional overrides. */
export function mergeIniMaps(a: IniFileMap, b?: IniFileMap): IniFileMap {
  if (!b) return a
  const out: IniFileMap = {}
  for (const file of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const sections: IniSections = {}
    for (const src of [a[file], b[file]]) {
      if (!src) continue
      for (const [section, kv] of Object.entries(src)) {
        sections[section] = { ...(sections[section] ?? {}), ...kv }
      }
    }
    out[file] = sections
  }
  return out
}

/** Count of managed files a call to applyIniSettings would touch (for reporting). */
export function managedFileCount(template: IniTemplate, overrides: IniFileMap): number {
  return new Set<string>([
    ...Object.keys(template.base ?? {}),
    ...Object.keys(template.settings ?? {}),
    ...Object.keys(overrides ?? {}),
  ]).size
}
