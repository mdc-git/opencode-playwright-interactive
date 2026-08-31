import { spawn, type SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import {
  optionString,
  optionStrings,
  playwrightBrowserDirectory,
  playwrightCacheDirectory,
  replCacheDirectory
} from './runtime-cache.ts'
import {
  checkNode,
  errorMessage,
  hasChildClosed,
  hasChildExited,
  ignoreFailure
} from './runtime-process.ts'
import type {
  KernelProcess,
  RuntimeOptions,
  SessionId,
  WorkspaceDirectory
} from './runtime-types.ts'

type StartOptions = {
  sessionId: SessionId
  directory: WorkspaceDirectory
  options: RuntimeOptions
  scriptDirectory: string
  scratch: string
}

export async function gracefullyStopChild(child: KernelProcess) {
  if (hasChildExited(child)) {
    return
  }

  ignoreFailure(() => {
    child.stdin.end()
  })
  if (await hasChildClosed(child, 1500)) {
    return
  }

  ignoreFailure(() => {
    child.kill('SIGTERM')
  })
  if (await hasChildClosed(child, 1500)) {
    return
  }

  ignoreFailure(() => {
    child.kill('SIGKILL')
  })
  await hasChildClosed(child, 2000)
}

export async function startKernel(config: StartOptions) {
  const node = optionString(config.options, 'nodePath', 'node')
  await checkNode(node)
  const cacheDirectory = playwrightCacheDirectory(config.options)
  const kernelPath = join(config.scratch, 'kernel.cjs')
  await writeFile(kernelPath, await readFile(join(config.scriptDirectory, 'kernel.cjs'), 'utf8'))
  const moduleDirs = [
    ...optionStrings(config.options, 'nodeModuleDirs'),
    join(replCacheDirectory(config.options), 'node_modules'),
    join(cacheDirectory, 'node_modules')
  ]
  const nodePath = [...moduleDirs, ...(process.env.NODE_PATH?.split(delimiter) ?? [])]
    .filter(Boolean)
    .join(delimiter)
  const child = spawn(node, ['--no-warnings', kernelPath], {
    cwd: config.directory,
    env: Object.fromEntries([
      ...Object.entries(process.env),
      ['NODE_PATH', nodePath],
      ['PLAYWRIGHT_BROWSERS_PATH', playwrightBrowserDirectory(config.options)],
      ['CAMOUFOX_INSTALL_DIR', join(cacheDirectory, 'camoufox')],
      ['NODE_REPL_INTERNAL_SESSION_ID', config.sessionId],
      ['NODE_REPL_INTERNAL_TMP_DIR', config.scratch],
      ['NODE_REPL_INTERNAL_SCRIPT_DIR', config.scriptDirectory]
    ]),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'] as SpawnOptions['stdio']
  }) as KernelProcess
  await once(child, 'spawn').catch((error: unknown) => {
    throw new Error(`Failed to start node_repl kernel: ${errorMessage(error)}`)
  })
  await writeFile(
    join(config.scratch, 'owner.json'),
    JSON.stringify({
      servicePid: process.pid,
      kernelPid: child.pid,
      createdAt: new Date().toISOString()
    })
  ).catch(() => undefined)
  return child
}
