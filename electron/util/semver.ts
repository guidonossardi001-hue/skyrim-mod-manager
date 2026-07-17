// Confronto versioni minimale e PURO (niente dipendenze, niente electron): usato dal
// check aggiornamenti del launcher. Non è un semver completo: componenti numeriche
// puntate, pre-release/build ignorati, malformato → mai "più nuovo" (nessun prompt spurio).

/**
 * true SOLO se `latest` è strettamente più nuovo di `current`. Il vecchio check era
 * `latest !== current`: un feed fermo a una release precedente (caso reale: latest.yml
 * a 1.0.0 con app 1.0.1) proponeva un DOWNGRADE come "Aggiornamento disponibile" a
 * ogni avvio del gioco.
 */
export function isNewerVersion(latest: string | null | undefined, current: string): boolean {
  if (!latest) return false
  const parse = (v: string): number[] | null => {
    const core = v.trim().replace(/^v/i, '').split(/[-+]/)[0]
    if (!/^\d+(\.\d+)*$/.test(core)) return null
    return core.split('.').map(Number)
  }
  const a = parse(latest)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}
