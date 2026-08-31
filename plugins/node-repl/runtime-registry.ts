import { ReplRuntime } from './runtime.ts'
import type { RuntimeOptions } from './runtime-types.ts'

type RuntimeHolder = {
  runtime: ReplRuntime
  references: number
  disposeTimer?: NodeJS.Timeout
}

type RuntimeGlobal = typeof globalThis & {
  __opencodeNodeReplRuntimes?: Map<string, RuntimeHolder>
}

const RUNTIME_DISPOSE_GRACE_MS = 5000
const runtimeGlobal = globalThis as RuntimeGlobal
const runtimeRegistry: Map<string, RuntimeHolder> =
  runtimeGlobal.__opencodeNodeReplRuntimes ?? new Map<string, RuntimeHolder>()
runtimeGlobal.__opencodeNodeReplRuntimes = runtimeRegistry

export function acquireRuntime(
  options: RuntimeOptions,
  scriptDirectory: string
): { runtimeId: string; holder: RuntimeHolder } {
  const runtimeId = `${scriptDirectory}\0${JSON.stringify(options)}`
  let holder = runtimeRegistry.get(runtimeId)
  if (holder === undefined) {
    holder = {
      runtime: new ReplRuntime(options, scriptDirectory),
      references: 0
    }
    runtimeRegistry.set(runtimeId, holder)
  }

  if (holder.disposeTimer !== undefined) {
    clearTimeout(holder.disposeTimer)
    holder.disposeTimer = undefined
  }

  holder.references += 1
  return { runtimeId, holder }
}

export function releaseRuntime(runtimeId: string, holder: RuntimeHolder) {
  holder.references -= 1
  if (holder.references > 0 || holder.disposeTimer !== undefined) {
    return
  }

  holder.disposeTimer = setTimeout(() => {
    holder.disposeTimer = undefined
    if (holder.references > 0 || runtimeRegistry.get(runtimeId) !== holder) {
      return
    }

    runtimeRegistry.delete(runtimeId)
    void holder.runtime.dispose()
  }, RUNTIME_DISPOSE_GRACE_MS)
  holder.disposeTimer.unref()
}
