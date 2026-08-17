import { defineConfig } from 'eslint/config'
import eslintConfigXo from 'eslint-config-xo'
import sonarjs from 'eslint-plugin-sonarjs'
import boundaries from 'eslint-plugin-boundaries'
import globals from 'globals'

export default defineConfig([
  ...eslintConfigXo({
    space: true,
    semicolon: false,
    prettier: 'compat',
    gitignore: import.meta.url
  }),

  {
    ignores: ['node_modules/**', '.opencode/**']
  },

  {
    files: ['**/*.{ts,mjs,js}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module'
    },
    settings: {
      'import-x/resolver': {
        typescript: true
      },
      'boundaries/files': [
        { pattern: 'plugins/js-repl/index.ts', category: 'entry' },
        { pattern: 'plugins/js-repl/runtime.ts', category: 'core' },
        { pattern: 'plugins/js-repl/scripts/stealth-runtime.mjs', category: 'stealth' },
        { pattern: 'plugins/js-repl/scripts/stealth-aria.mjs', category: 'utils' },
        { pattern: 'plugins/js-repl/scripts/stealth-input.mjs', category: 'utils' },
        { pattern: 'plugins/js-repl/scripts/stealth-profile-store.mjs', category: 'store' },
        { pattern: 'plugins/js-repl/scripts/stealth-utils.mjs', category: 'utils' }
      ]
    },
    plugins: {
      sonarjs,
      boundaries
    },
    rules: {
      // ESLint complexity metrics
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'max-lines-per-function': ['error', 60],

      // SonarJS cognitive complexity
      'sonarjs/cognitive-complexity': ['error', 12],

      // Import cycle detection
      'import-x/no-cycle': 'error',

      // Architectural dependency rules
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            {
              from: { file: { categories: ['entry'] } },
              allow: { to: { file: { categories: ['core'] } } }
            },
            {
              from: { file: { categories: ['stealth'] } },
              allow: { to: { file: { categories: ['store', 'utils'] } } }
            },
            {
              from: { file: { categories: ['store'] } },
              allow: { to: { file: { categories: ['utils'] } } }
            },
            {
              from: { file: { categories: ['utils'] } },
              allow: { to: { file: { categories: ['utils'] } } }
            }
          ]
        }
      ]
    }
  },

  // Browser globals for Playwright page.evaluate() callbacks in stealth scripts
  {
    files: ['plugins/js-repl/scripts/stealth-*.mjs'],
    languageOptions: {
      globals: globals.browser
    }
  }
])
