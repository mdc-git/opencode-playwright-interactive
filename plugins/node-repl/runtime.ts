import { ReplController } from './runtime-controller.ts'
import { sweepStaleScratchDirs } from './runtime-process.ts'
import type { JobInput } from './tool-schema.ts'
import type { RuntimeOptions, SessionId, WorkspaceDirectory } from './runtime-types.ts'

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

  private async controllerFor(sessionID: SessionId, directory: WorkspaceDirectory) {
    let controller = this.controllers.get(sessionID)
    if (controller && controller.directory !== directory) {
      this.controllers.delete(sessionID)
      await controller.dispose()
      controller = undefined
    }

    if (!controller) {
      controller = new ReplController(sessionID, directory, this.options, this.scriptDirectory)
      this.controllers.set(sessionID, controller)
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

  async job(sessionID: SessionId, input: JobInput) {
    if (input.action === 'list') {
      const controller = this.controllers.get(sessionID)
      if (!controller) {
        return []
      }

      return controller.listJobs()
    }

    const controller = this.controllers.get(sessionID)
    if (!controller) {
      throw new Error('Node.js REPL kernel was not initialized.')
    }

    return {
      status: () => controller.getJob(input.id),
      wait: async () => controller.waitForJob(input.id),
      cancel: async () => controller.cancelJob(input.id)
    }[input.action]()
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
      controller.dispose(true)
    )
    this.controllers.clear()
    await Promise.allSettled(disposals)
  }
}
