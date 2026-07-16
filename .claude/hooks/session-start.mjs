import { execSync } from 'node:child_process'

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const branch = sh('git rev-parse --abbrev-ref HEAD') || '(sconosciuto)'
const status = sh('git status --short') || '(pulito, niente da committare)'
const log = sh('git log --oneline -8') || '(nessun commit)'

const context = [
  `Branch corrente: ${branch}`,
  '',
  'Modifiche non committate (git status --short):',
  status,
  '',
  'Ultimi 8 commit:',
  log,
  '',
  'ATTENZIONE — affidabilita\' dei file di stato narrativi (TODO.md, TASKS.md, ' +
    'RISK_MATRIX.md, GO_NO_GO.md, CHANGELOG.md, SESSION_STATE.md, ROADMAP.md, ' +
    'MOD_CATALOG.md): sono scritti a mano da sessioni precedenti e possono essere ' +
    'disallineati dal codice reale. Gia\' verificato piu\' volte: voci segnate ' +
    '"aperte/backlog" in quei file erano gia\' risolte nel codice (es. gate di ' +
    "consenso nxm://, hash-gating dei download). Prima di trattare una voce di quei " +
    'file come vera o di consigliare un fix basato su di essa, verificare contro ' +
    "git log/grep sul codice reale, non fidarsi del testo da solo. AUTO_LOG.md " +
    "invece e' generato automaticamente ad ogni commit (post-commit hook) ed e' " +
    'sempre accurato per definizione.',
].join('\n')

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  })
)
