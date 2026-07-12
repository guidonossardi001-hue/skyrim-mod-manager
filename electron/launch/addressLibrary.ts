// Rilevamento Address Library (prerequisito dei plugin SKSE). PURO: testabile senza fs.
//
// Naming reale dei database offset su Nexus (mod 32444):
//   • era SE  (runtime ≤ 1.5.97):  `version-1-5-97-0.bin`
//   • era AE  (runtime ≥ 1.6.x):   `versionlib-1-6-1170-0.bin`
// Il vecchio check accettava SOLO il pattern SE → "Address Library mancante" su installazioni
// AE perfettamente corrette (falso negativo che bloccava l'avvio al gate VerifyDependencies).

const BIN_RE = /^version(lib)?-[\d-]+\.bin$/i

/** true se il nome file è un database Address Library (naming SE O AE). */
export function isAddressLibraryBin(name: string): boolean {
  return BIN_RE.test(name)
}

/**
 * true se tra i .bin presenti ce n'è uno per la versione del runtime (es. gioco '1.6.1170.0' →
 * bin contenente '1-6-1170'). null quando non verificabile (versione gioco ignota o nessun bin):
 * il verdetto resta "presente ma versione non confermata", mai un blocco spurio.
 */
export function addressLibraryMatchesVersion(
  binNames: string[],
  gameVersion: string | null | undefined,
): boolean | null {
  if (!binNames.length || !gameVersion) return null
  const key = gameVersion.split('.').slice(0, 3).join('-') // '1.6.1170.0' → '1-6-1170'
  if (!/^\d+-\d+-\d+$/.test(key)) return null
  return binNames.some((n) => n.toLowerCase().includes(key))
}
