import { spawn, type SpawnOptions } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'
import {
  optionString,
  optionStrings,
  playwrightBrowserDirectory,
  playwrightCacheDirectory,
  replCacheDirectory
} from './runtime-cache.ts'
import { checkNode, hasChildExited } from './runtime-process.ts'
import type {
  KernelMessage,
  KernelProcess,
  RuntimeOptions,
  SessionId,
  WorkspaceDirectory
} from './runtime-types.ts'

const envKey = <const K extends string>(key: K): K => key

type KernelCallbacks = {
  onMessage: (message: KernelMessage) => void
  onWriteError: (error: unknown) => void
  onFailure: (error: Error) => void
  onClose: (error: Error) => void
}

type KernelControllerOptions = {
  sessionId: SessionId
  directory: WorkspaceDirectory
  options: RuntimeOptions
  scriptDirectory: string
  callbacks: KernelCallbacks
}

type KernelStartup = { child: KernelProcess; wasRestarted: boolean }

export abstract class KernelControllerBase {
  protected readonly sessionId: SessionId
  protected readonly directory: WorkspaceDirectory
  protected readonly options: RuntimeOptions
  protected readonly scriptDirectory: string
  protected readonly callbacks: KernelCallbacks
  protected child?: KernelProcess
  protected reader?: ReadLineInterface
  protected stderrTail: string[] = []
  protected stderrFragment = ''
  protected scratch?: string
  protected kernelGeneration = 0
  protected stopping?: Promise<void>
  protected starting?: Promise<KernelStartup>

  constructor({
    sessionId,
    directory,
    options,
    scriptDirectory,
    callbacks
  }: KernelControllerOptions) {
    this.sessionId = sessionId
    this.directory = directory
    this.options = options
    this.scriptDirectory = scriptDirectory
    this.callbacks = callbacks
  }

  private async prepareKernel(node: string) {
    this.scratch ??= await mkdtemp(join(tmpdir(), 'opencode-node-repl-'))
    const { scratch } = this
    const source = await readFile(join(this.scriptDirectory, 'kernel.cjs'), 'utf8')
    const kernelPath = join(scratch, 'kernel.cjs')
    await writeFile(kernelPath, source)
    this.stderrTail = []
    this.stderrFragment = ''
    return { node, kernelPath, scratch }
  }

  private buildSpawnOptions(): SpawnOptions {
    const moduleDirs = [
      ...optionStrings(this.options, 'nodeModuleDirs'),
      join(replCacheDirectory(this.options), 'node_modules'),
      join(playwrightCacheDirectory(this.options), 'node_modules')
    ]
    const nodePath = [...moduleDirs, ...(process.env.NODE_PATH?.split(delimiter) ?? [])]
      .filter(Boolean)
      .join(delimiter)
    return {
      cwd: this.directory,
      env: {
        ...process.env,
        [envKey('NODE_PATH')]: nodePath,
        [envKey('PLAYWRIGHT_BROWSERS_PATH')]: playwrightBrowserDirectory(this.options),
        [envKey('CAMOUFOX_INSTALL_DIR')]: join(playwrightCacheDirectory(this.options), 'camoufox'),
        [envKey('NODE_REPL_INTERNAL_SESSION_ID')]: this.sessionId,
        [envKey('NODE_REPL_INTERNAL_TMP_DIR')]: this.scratch,
        [envKey('NODE_REPL_INTERNAL_SCRIPT_DIR')]: this.scriptDirectory
      },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'] as SpawnOptions['stdio']
    }
  }

  private async waitForSpawn(child: KernelProcess) {
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError)
        resolve()
      }

      const onError = (error: Error) => {
        child.off('spawn', onSpawn)
        reject(new Error(`Failed to start node_repl kernel: ${error.message}`))
      }

      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  protected abstract handleLine(child: KernelProcess, line: string): void
  protected abstract handleStderr(chunk: string): void
  protected abstract handleKernelWriteError(child: KernelProcess, error: unknown): void
  protected abstract handleClose(
    child: KernelProcess,
    code: number | undefined,
    signal: NodeJS.Signals | undefined
  ): void
  protected abstract fail(child: KernelProcess, error: Error): void

  protected async ensure(): Promise<KernelStartup> {
    if (this.child && !hasChildExited(this.child)) {
      return { child: this.child, wasRestarted: false }
    }

    const node = optionString(this.options, 'nodePath', 'node')
    await checkNode(node)
    const { kernelPath, scratch } = await this.prepareKernel(node)
    const wasRestarted = this.kernelGeneration > 0
    const child = spawn(
      node,
      ['--no-warnings', kernelPath],
      this.buildSpawnOptions()
    ) as KernelProcess
    await this.waitForSpawn(child)
    this.kernelGeneration += 1
    this.child = child
    await writeFile(
      join(scratch, 'owner.json'),
      JSON.stringify({
        servicePid: process.pid,
        kernelPid: child.pid,
        createdAt: new Date().toISOString()
      })
    ).catch(() => undefined)
    child.stdout.resume()
    this.reader = createInterface({ input: child.stdio[3], crlfDelay: Infinity })
    this.reader.on('line', (line) => {
      this.handleLine(child, line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.handleStderr(chunk)
    })
    child.stdin.on('error', (error) => {
      this.handleKernelWriteError(child, error)
    })
    child.once('close', (code, signal) => {
      this.handleClose(child, code ?? undefined, signal ?? undefined)
    })
    child.once('error', (error) => {
      this.fail(child, new Error(`node_repl kernel process error: ${error.message}`))
    })
    return { child, wasRestarted }
  }
}
