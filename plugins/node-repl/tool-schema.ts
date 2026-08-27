import { Schema as schema } from 'effect'

const {
  String: string,
  Boolean: boolean,
  Struct: struct,
  Record: record,
  Never: never,
  Literal: literal,
  optionalKey,
  annotate,
  Union: union
} = schema
const nonEmptyString = string.check(schema.isMinLength(1))

const replCode = nonEmptyString.pipe(
  annotate({
    description:
      'Plain Node.js source for the persistent REPL. Call the native `node_repl` tool directly with this source; do not wrap it in another tool call or interpreter.'
  })
)

export const replInput = struct({
  code: replCode
})
export type ReplInput = schema.Schema.Type<typeof replInput>

export const resetInput = record(string, never)
export type ResetInput = schema.Schema.Type<typeof resetInput>

const forceInput = boolean.pipe(
  annotate({
    description: 'Reinstall Playwright and Chromium even when the shared cache is already ready.'
  })
)

export const setupInput = struct({
  force: optionalKey(forceInput)
})
export type SetupInput = schema.Schema.Type<typeof setupInput>

const jobWithId = <const Action extends 'status' | 'wait' | 'cancel'>(action: Action) =>
  struct({
    action: literal(action),
    id: nonEmptyString
  })

export const jobInput = union([
  struct({ action: literal('list') }),
  jobWithId('status'),
  jobWithId('wait'),
  jobWithId('cancel')
])
export type JobInput = schema.Schema.Type<typeof jobInput>

export const textOutput = string
