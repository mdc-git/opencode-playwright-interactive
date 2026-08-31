import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { access, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import type { KernelProcess } from './runtime-types.ts'

type ExecFileResult = { stdout: string; stderr: string }

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function boundedUtf8(value: string, maxBytes: number) {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) {
    return value
  }

  return bytes
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\u{FFFD}$/v, '')
}

export async function execFileAsync(
  command: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }
) {
  return new Promise<ExecFileResult>((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error instanceof Error ? error : new Error('Child process failed', { cause: error }))
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

export async function doesExist(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const MIN_NODE_VERSION = [22, 0, 0] as const
const checkedNodes = new Map<string, Promise<void>>()

function parseVersion(value: string) {
  const match = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/v.exec(value.trim())
  if (!match) {
    throw new Error(`Unable to parse Node version: ${value.trim()}`)
  }

  const { major, minor, patch } = match.groups ?? {}
  return [Number(major), Number(minor), Number(patch)] as const
}

function compareVersionPart(actual: number, minimum: number) {
  if (actual > minimum) {
    return 1
  }

  if (actual < minimum) {
    return -1
  }

  return 0
}

function versionGreaterThan(actual: readonly number[], minimum: readonly number[]) {
  for (const [index, element] of minimum.entries()) {
    const comparison = compareVersionPart(actual[index], element)
    if (comparison !== 0) {
      return comparison > 0
    }
  }

  return false
}

export async function checkNode(path: string) {
  let check = checkedNodes.get(path)
  if (!check) {
    check = (async () => {
      let stdout: string
      try {
        ;({ stdout } = await execFileAsync(path, ['--version'], {
          encoding: 'utf8',
          timeout: 5000
        }))
      } catch (error) {
        throw new Error(`Failed to start Node runtime at "${path}": ${errorMessage(error)}`, {
          cause: error
        })
      }

      const actual = parseVersion(stdout)
      if (!versionGreaterThan(actual, MIN_NODE_VERSION)) {
        throw new Error(
          `node_repl requires Node >${MIN_NODE_VERSION.join('.')}; "${path}" is ${actual.join('.')}`
        )
      }
    })()
    checkedNodes.set(path, check)
  }

  return check
}

export async function terminateChild(child: KernelProcess) {
  if (hasChildExited(child)) {
    return
  }

  try {
    child.stdin.end()
  } catch {
    /*
    Stdin already closed
    */
  }

  if (await hasChildClosed(child, 1200)) {
    return
  }

  try {
    child.kill('SIGKILL')
  } catch {
    /*
    Already exited
    */
  }

  await hasChildClosed(child, 1000)
}

export async function hasChildClosed(child: KernelProcess, ms: number) {
  return new Promise<boolean>((resolve) => {
    if (hasChildExited(child)) {
      resolve(true)
      return
    }

    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolve(hasChildExited(child))
    }, ms)
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }

    child.once('close', onClose)
  })
}

export function hasChildExited(child: KernelProcess) {
  return child.exitCode !== null || child.signalCode !== null
}

const SCRATCH_PREFIX = 'opencode-node-repl-'
const OWNERLESS_SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000
let isStaleSweepStarted = false

async function readOwnerPid(directory: string): Promise<number | undefined> {
  try {
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')) as {
      servicePid?: number
    }
    return typeof owner.servicePid === 'number' ? owner.servicePid : undefined
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function didSweepOwnedDir(directory: string, removed: string[]) {
  const servicePid = await readOwnerPid(directory)
  if (servicePid === undefined) {
    return false
  }

  if (isProcessAlive(servicePid)) {
    return true
  }

  await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  removed.push(directory)
  return true
}

async function sweepOwnerlessDir(directory: string) {
  try {
    const info = await stat(directory)
    if (Date.now() - info.mtimeMs > OWNERLESS_SCRATCH_MAX_AGE_MS) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch {
    /*
    Already gone
    */
  }
}

async function sweepScratchDirectory(directory: string, removed: string[]) {
  const isHandled = await didSweepOwnedDir(directory, removed)
  if (!isHandled) {
    await sweepOwnerlessDir(directory)
  }
}

async function sweepScratchEntry(entry: string, removed: string[]) {
  if (!entry.startsWith(SCRATCH_PREFIX)) {
    return
  }

  const directory = join(tmpdir(), entry)
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) {
      return
    }

    await sweepScratchDirectory(directory, removed)
  } catch {
    // Entry vanished or is unreadable; nothing to sweep.
  }
}

async function sweepScratchEntries(entries: string[], removed: string[]) {
  let chain = Promise.resolve()
  for (const entry of entries) {
    chain = chain.then(async () => sweepScratchEntry(entry, removed))
  }

  return chain
}

export async function sweepStaleScratchDirs() {
  if (isStaleSweepStarted) {
    return
  }

  isStaleSweepStarted = true
  let entries: string[]
  try {
    entries = await readdir(tmpdir())
  } catch {
    return
  }

  const removed: string[] = []
  await sweepScratchEntries(entries, removed)

  if (removed.length === 0) {
    return
  }

  setTimeout(() => {
    for (const directory of removed) {
      rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 3000).unref()
}
