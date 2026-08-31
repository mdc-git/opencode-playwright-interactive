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

  private async disposeController(sessionID: SessionId, controller: ReplController) {
    this.controllers.delete(sessionID)
    await controller.dispose()
  }

  private async matchingController(sessionID: SessionId, directory: WorkspaceDirectory) {
    const existing = this.controllers.get(sessionID)
    if (!existing || existing.matchesDirectory(directory)) {
      return existing
    }

    await this.disposeController(sessionID, existing)
    return undefined
  }

  private async controllerFor(sessionID: SessionId, directory: WorkspaceDirectory) {
    let controller = await this.matchingController(sessionID, directory)
    if (!controller) {
      controller = new ReplController(sessionID, directory, this.options, this.scriptDirectory)
      this.controllers.set(sessionID, controller)
    }

    return controller
  }

  private existingController(sessionID: SessionId) {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      throw new Error('Node.js REPL kernel was not initialized.')
    }

    return controller
  }

  async execute(sessionID: SessionId, directory: WorkspaceDirectory, code: string) {
    if (this.disposed) {
      throw new Error('node_repl runtime is disposed')
    }

    const controller = await this.controllerFor(sessionID, directory)
    return controller.execute(code)
  }

  listJobs(sessionID: SessionId): JobActionOutcome {
    return { kind: 'list', jobs: this.controllers.get(sessionID)?.listJobs() ?? [] }
  }

  getJob(sessionID: SessionId, id: string): JobActionOutcome {
    return { kind: 'job', job: this.existingController(sessionID).getJob(id) }
  }

  async waitForJob(sessionID: SessionId, id: string): Promise<JobActionOutcome> {
    return { kind: 'job', job: await this.existingController(sessionID).waitForJob(id) }
  }

  async cancelJob(sessionID: SessionId, id: string): Promise<JobActionOutcome> {
    return { kind: 'job', job: await this.existingController(sessionID).cancelJob(id) }
  }

  async reset(sessionID: SessionId) {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      return false
    }

    await this.disposeController(sessionID, controller)
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
