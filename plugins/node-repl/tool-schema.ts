export const replInput = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      minLength: 1,
      description:
        'Plain Node.js source for the persistent REPL. Call the native `node_repl` tool directly with this source; do not wrap it in another tool call or interpreter.'
    }
  },
  required: ['code'],
  additionalProperties: false
} as const
export type ReplInput = { code: string }

export const resetInput = { type: 'object', properties: {}, additionalProperties: false } as const
export type ResetInput = Record<string, never>

export const setupInput = {
  type: 'object',
  properties: {
    force: {
      type: 'boolean',
      description: 'Reinstall Playwright and Chromium even when the shared cache is already ready.'
    }
  },
  additionalProperties: false
} as const
export type SetupInput = { force?: boolean }

export const jobInput = {
  oneOf: [
    {
      type: 'object',
      properties: { action: { const: 'list' } },
      required: ['action'],
      additionalProperties: false
    },
    ...(['status', 'wait', 'cancel'] as const).map((action) => ({
      type: 'object',
      properties: {
        action: { const: action },
        id: { type: 'string', minLength: 1 }
      },
      required: ['action', 'id'],
      additionalProperties: false
    }))
  ]
} as const
export type JobInput = { action: 'list' } | { action: 'status' | 'wait' | 'cancel'; id: string }

export const textOutput = { type: 'string' } as const
