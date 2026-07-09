// Migrazione della chiave privata di firma (release_priv.pem) al formato SICURO:
//   in chiaro dentro il progetto  →  PKCS8 cifrata (AES-256-CBC) FUORI dal progetto.
//
// Equivalente Node di `python sign_manifest.py encrypt-key` (qui Python può non
// esserci). Il formato prodotto è interscambiabile: la cryptography di Python lo
// legge con load_pem_private_key(password=...) e viceversa.
//
// SAFETY: prima di suggerire la cancellazione dell'originale, esegue un roundtrip
// firma→verifica della copia cifrata CONTRO LA CHIAVE PUBBLICA PINNATA
// (docs/keys/release_pub.pem): se la verifica passa, la copia migrata è
// provatamente la chiave giusta e decifrabile.
//
// Uso:  node scripts/protect_release_key.mjs [--in PATH] [--out PATH]
//   --in   default: secrets/release_priv.pem (la copia storica in chiaro)
//   --out  default: $SKYRIM_RELEASE_PRIV_KEY_PATH
//                   oppure %USERPROFILE%\.skyrim-release-keys\release_priv.pem
//   passphrase: $SKYRIM_RELEASE_KEY_PASSPHRASE oppure prompt nascosto.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { createPrivateKey, createPublicKey, sign, verify, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import readline from 'node:readline'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// Prompt nascosto (l'input non viene mai mostrato né loggato).
function askHidden(question) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const write = rl._writeToOutput?.bind(rl)
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      res(answer)
    })
    rl._writeToOutput = (s) => {
      if (s.includes(question)) write?.(question)
    }
  })
}

async function getPassphrase() {
  if (process.env.SKYRIM_RELEASE_KEY_PASSPHRASE) return process.env.SKYRIM_RELEASE_KEY_PASSPHRASE
  const first = await askHidden('Nuova passphrase per la chiave privata: ')
  if (!first) {
    console.error('Passphrase vuota non ammessa.')
    process.exit(1)
  }
  const second = await askHidden('Conferma passphrase: ')
  if (first !== second) {
    console.error('Le passphrase non coincidono.')
    process.exit(1)
  }
  return first
}

const srcPath = resolve(arg('--in') ?? join(ROOT, 'secrets', 'release_priv.pem'))
const destPath = resolve(
  arg('--out') ??
    process.env.SKYRIM_RELEASE_PRIV_KEY_PATH ??
    join(homedir(), '.skyrim-release-keys', 'release_priv.pem'),
)

if (!existsSync(srcPath)) {
  console.error(`Chiave sorgente non trovata: ${srcPath}`)
  process.exit(1)
}
if (destPath.toLowerCase().startsWith(resolve(ROOT).toLowerCase())) {
  console.error(`RIFIUTATO: la destinazione (${destPath}) è DENTRO l'albero del progetto.`)
  process.exit(1)
}
if (existsSync(destPath)) {
  console.error(`RIFIUTATO: ${destPath} esiste già — non sovrascrivo una chiave di firma.`)
  process.exit(1)
}

const srcPem = readFileSync(srcPath)
if (srcPem.includes('ENCRYPTED')) {
  console.error(`${srcPath} risulta già cifrata: niente da fare.`)
  process.exit(1)
}

const passphrase = await getPassphrase()
const key = createPrivateKey(srcPem)
const encryptedPem = key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase })

mkdirSync(dirname(destPath), { recursive: true })
writeFileSync(destPath, encryptedPem)

// ── Roundtrip di sicurezza: la copia cifrata firma e la PUBBLICA PINNATA verifica ──
const reloaded = createPrivateKey({ key: readFileSync(destPath), passphrase })
const probe = randomBytes(64)
const sig = sign(null, probe, reloaded)
const pinnedPub = createPublicKey(readFileSync(join(ROOT, 'docs', 'keys', 'release_pub.pem')))
if (!verify(null, probe, pinnedPub, sig)) {
  unlinkSync(destPath) // niente copie orfane di chiavi sbagliate in giro
  console.error(
    'FAIL: la copia cifrata NON corrisponde alla chiave pubblica pinnata — originale NON toccato.',
  )
  process.exit(1)
}

console.log(`OK  chiave cifrata scritta e VERIFICATA → ${destPath}`)
console.log('')
console.log('Prossimi passi (manuali):')
console.log(`  1. Blinda i permessi del file (solo il tuo utente):`)
console.log(`       icacls "${destPath}" /inheritance:r /grant:r "%USERNAME%:F"`)
console.log(`  2. Rendi permanente la variabile d'ambiente:`)
console.log(`       setx SKYRIM_RELEASE_PRIV_KEY_PATH "${destPath}"`)
console.log(`  3. SOLO ORA cancella l'originale in chiaro:`)
console.log(`       del "${srcPath}"`)
