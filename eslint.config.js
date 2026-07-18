// ESLint 9 flat config — baseline PRAGMATICA:
// regole recommended (JS + TypeScript + React Hooks), con le violazioni di solo
// stile declassate a warning così la CI parte verde sul codice esistente e le
// regole si stringono in seguito. Prettier gestisce la formattazione (le regole
// di stile in conflitto sono disattivate da eslint-config-prettier).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  // Output di build, dati pesanti e artifact: mai lintati.
  {
    ignores: [
      'node_modules/**', 'dist/**', 'dist-electron/**', 'dist-smoke/**',
      'release/**', 'data/**', 'resources/**', 'docs/**', 'secrets/**',
      '*.config.js', '*.config.ts', 'vite.*.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  // ── Renderer React (src/) ────────────────────────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
    },
  },

  // ── Processo main Electron + script (Node) ──────────────────────────────────
  {
    files: ['electron/**/*.ts', 'scripts/**/*.{ts,mjs}', '.claude/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ── Baseline pragmatica condivisa ────────────────────────────────────────────
  {
    rules: {
      // Il codice esistente usa `as unknown as X` ai confini IPC/DB e catch vuoti
      // deliberati (best-effort I/O): warning, non errori bloccanti.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': ['warn', { allowShortCircuit: true, allowTernary: true }],
    },
  },

  // I test usano pattern (expect().toThrow, cast di comodo) che non vanno lintati
  // con la stessa severità del codice di produzione.
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
