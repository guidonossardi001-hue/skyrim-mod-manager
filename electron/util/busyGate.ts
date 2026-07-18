// Gate anti-concorrenza per le operazioni PESANTI che mutano modsRoot/Data (deploy, FOMOD
// apply-all, batch build BodySlide, ESL-ify apply): senza serializzazione, due IPC lanciate
// insieme (doppio click prima che la UI disabiliti i bottoni, o una seconda finestra) possono
// interlacciare le loro scritture — rename FOMOD a metà mentre il deploy legge la stessa
// cartella, o un ESL-ify che flagga un plugin mentre il deploy lo sta hardlinkando.
// Un singolo lock cooperativo a livello processo, mai un mutex di sistema: basta che TUTTI i
// chiamanti passino da qui.

let busyLabel: string | null = null

/** true = acquisito; false = un'altra operazione pesante è già in corso. */
export function tryAcquireBusyGate(label: string): boolean {
  if (busyLabel) return false
  busyLabel = label
  return true
}

export function releaseBusyGate(): void {
  busyLabel = null
}

export function currentBusyLabel(): string | null {
  return busyLabel
}
