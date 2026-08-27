import { ReplController } from './runtime-controller.ts'
import { setupPlaywright as setupPlaywrightCache } from './runtime-cache.ts'
import { sweepStaleScratchDirs } from './runtime-process.ts'
import type {
  ExecuteOutcome,
  JobActionOutcome,
  RuntimeOptions,
  SessionId,
  WorkspaceDirectory
} from './runtime-types.ts'

export class ReplRuntime {
  private readonly controllers = new Map<SessionId, ReplController>()
  private disposed = false
  private readonly options: RuntimeOptions
  private readonly scriptDirectory: string

  constructor(options: RuntimeOptions, scriptDirectory: string) {
    this.options = options
    this.scriptDirectory = scriptDirectory
    sweepStaleScratchDirs().catch(() => undefined)
  }

  async execute(sessionID: SessionId, directory: WorkspaceDirectory, code: string) {
    if (this.disposed) {
      throw new Error('node_repl runtime is disposed')
    }

    let controller = this.controllers.get(sessionID)
    if (controller && !controller.matchesDirectory(directory)) {
      this.controllers.delete(sessionID)
      await controller.dispose()
      controller = undefined
    }

    if (!controller) {
      controller = new ReplController(sessionID, directory, this.options, this.scriptDirectory)
      this.controllers.set(sessionID, controller)
    }

    return controller.execute(code)
  }

  listJobs(sessionID: SessionId): JobActionOutcome {
    return { kind: 'list', jobs: this.controllers.get(sessionID)?.listJobs() ?? [] }
  }

  getJob(sessionID: SessionId, id: string): JobActionOutcome {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      throw new Error('Node.js REPL kernel was not initialized.')
    }

    return { kind: 'job', job: controller.getJob(id) }
  }

  async waitForJob(sessionID: SessionId, id: string): Promise<JobActionOutcome> {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      throw new Error('Node.js REPL kernel was not initialized.')
    }

    return { kind: 'job', job: await controller.waitForJob(id) }
  }

  async cancelJob(sessionID: SessionId, id: string): Promise<JobActionOutcome> {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      throw new Error('Node.js REPL kernel was not initialized.')
    }

    return { kind: 'job', job: await controller.cancelJob(id) }
  }

  async reset(sessionID: SessionId) {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      return false
    }

    this.controllers.delete(sessionID)
    await controller.dispose()
    return true
  }

  async dispose() {
    if (this.disposed) {
      return
    }

    this.disposed = true
    const disposals = Array.from(this.controllers.values(), async (controller) =>
      controller.disposeForShutdown()
    )
    this.controllers.clear()
    await Promise.allSettled(disposals)
  }

  async setupPlaywright(isForce = false) {
    return setupPlaywrightCache(this.options, isForce)
  }
}
