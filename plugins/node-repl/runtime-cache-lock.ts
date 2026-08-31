import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import process from 'node:process'

const LOCK_STALE_MS = 15 * 60_000
const LOCK_TIMEOUT_MS = 10 * 60_000
const LOCK_POLL_MS = 250
const LOCK_RENEW_MS = 30_000

async function readHeartbeatAge(heartbeatPath: string, lockPath: string) {
  try {
    const info = await stat(heartbeatPath)
    return Date.now() - info.mtimeMs
  } catch {
    return stat(lockPath)
      .then((info) => Date.now() - info.mtimeMs)
      .catch(() => LOCK_STALE_MS + 1)
  }
}

async function waitForStaleLock(lockPath: string, heartbeatPath: string, start: number) {
  if (Date.now() - start > LOCK_TIMEOUT_MS) {
    throw new Error(
      `Timed out waiting for the node_repl setup lock ${lockPath}; another process may be installing. Remove it manually if the holder is gone.`
    )
  }

  const heartbeatAge = await readHeartbeatAge(heartbeatPath, lockPath)
  if (heartbeatAge > LOCK_STALE_MS) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
  } else {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, LOCK_POLL_MS)
    })
  }
}

async function acquireCacheLock(lockPath: string, heartbeatPath: string) {
  const start = Date.now()
  const attempt = async (): Promise<void> => {
    try {
      await mkdir(lockPath)
      await writeFile(heartbeatPath, `${process.pid} ${Date.now()}\n`, 'utf8').catch(
        () => undefined
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw error
      }

      await waitForStaleLock(lockPath, heartbeatPath, start)
      await attempt()
    }
  }

  await attempt()
}

export async function withCacheLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`
  const heartbeatPath = `${lockPath}/heartbeat`
  await acquireCacheLock(lockPath, heartbeatPath)
  const heartbeat = setInterval(() => {
    writeFile(heartbeatPath, `${process.pid} ${Date.now()}\n`, 'utf8').catch(() => undefined)
  }, LOCK_RENEW_MS)
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
  }
}
