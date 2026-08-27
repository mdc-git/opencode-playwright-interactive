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
        { pattern: 'plugins/node-repl/index.ts', category: 'entry' },
        { pattern: 'plugins/node-repl/runtime.ts', category: 'core' },
        { pattern: 'plugins/node-repl/runtime-cache.ts', category: 'core' },
        { pattern: 'plugins/node-repl/runtime-controller.ts', category: 'core' },
        { pattern: 'plugins/node-repl/runtime-process.ts', category: 'core' },
        { pattern: 'plugins/node-repl/runtime-protocol.ts', category: 'core' },
        { pattern: 'plugins/node-repl/runtime-registry.ts', category: 'core' },
        { pattern: 'plugins/node-repl/runtime-types.ts', category: 'core' },
        { pattern: 'plugins/node-repl/tool-handler.ts', category: 'core' },
        { pattern: 'plugins/node-repl/tool-result.ts', category: 'core' },
        { pattern: 'plugins/node-repl/tool-schema.ts', category: 'core' },
        { pattern: 'plugins/node-repl/scripts/humanized-input.mjs', category: 'input' },
        { pattern: 'plugins/node-repl/scripts/humanized-input-actions.mjs', category: 'utils' },
        { pattern: 'plugins/node-repl/scripts/humanized-input-utils.mjs', category: 'utils' }
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
              from: { file: { categories: ['core'] } },
              allow: { to: { file: { categories: ['core'] } } }
            },
            {
              from: { file: { categories: ['input'] } },
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

  // Browser globals for Playwright page.evaluate() callbacks in input scripts
  {
    files: ['plugins/node-repl/scripts/humanized-input-*.mjs'],
    languageOptions: {
      globals: globals.browser
    }
  },

  // SDK-linked dependencies use the OpenCode beta dist-tag. Semver ranges on
  // 0.0.x prereleases can resolve unrelated builds.
  // effect stays exact to mirror the SDK's own pin.
  {
    files: ['package.json'],
    rules: {
      'package-json/dependency-version-range': [
        'error',
        { exceptions: ['@opencode-ai/plugin', '@opencode-ai/schema', 'effect'] }
      ],
      'package-json/no-dist-tag-dependencies': 'off'
    }
  }
])
