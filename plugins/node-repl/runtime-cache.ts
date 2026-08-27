import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { boundedUtf8, doesExist, errorMessage, execFileAsync } from './runtime-process.ts'
import type { RuntimeOptions } from './runtime-types.ts'

const envKey = <const K extends string>(key: K): K => key

const PLAYWRIGHT_VERSION = '1.60.0'
const CAMOUFOX_VERSION = '0.12.0'
const CAMOUFOX_PACKAGE = 'camoufox-js'
const CAMOUFOX_INSTALL_DIR_NAME = 'camoufox'
const LOCK_STALE_MS = 15 * 60_000
const LOCK_TIMEOUT_MS = 10 * 60_000
const LOCK_POLL_MS = 250
const LOCK_RENEW_MS = 30_000

export function optionString(options: RuntimeOptions, key: keyof RuntimeOptions, fallback: string) {
  const value = options[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

export function optionStrings(options: RuntimeOptions, key: keyof RuntimeOptions) {
  const value = options[key]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}

function defaultCacheDirectory() {
  return join(homedir(), '.cache', 'opencode')
}

export function playwrightCacheDirectory(options: RuntimeOptions) {
  return optionString(options, 'playwrightCacheDir', join(defaultCacheDirectory(), 'playwright'))
}

export function replCacheDirectory(options: RuntimeOptions) {
  return optionString(options, 'replCacheDir', defaultCacheDirectory())
}

export function playwrightBrowserDirectory(options: RuntimeOptions) {
  return join(playwrightCacheDirectory(options), 'browsers')
}

async function readHeartbeatAge(heartbeatPath: string, lockPath: string) {
  try {
    const info = await stat(heartbeatPath)
    return Date.now() - info.mtimeMs
  } catch {
    // No heartbeat yet; fall back to the lock directory's own age.
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

// Cross-process mutex for the shared user cache. Multiple OpenCode services
// (or concurrent sessions) may run setup at the same time; npm installs,
// source patching and browser downloads must not interleave.
async function withCacheLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
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

async function run(command: string, args: string[], environment: NodeJS.ProcessEnv) {
  try {
    await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 10 * 60_000,
      maxBuffer: 1024 * 1024,
      env: environment
    })
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string }
    const output = [details.stdout, details.stderr].filter(Boolean).join('\n').trim()
    throw new Error(
      `Playwright setup failed: ${errorMessage(error)}${output === '' ? '' : `\n${boundedUtf8(output, 8192)}`}`,
      { cause: error }
    )
  }
}

function chromiumExecutableRelative(revision: string) {
  const folder = `chromium-${revision}`
  if (process.platform === 'darwin') {
    const sub = process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64'
    return join(
      folder,
      sub,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    )
  }

  if (process.platform === 'win32') {
    return join(folder, 'chrome-win64', 'chrome.exe')
  }

  return join(folder, process.arch === 'arm64' ? 'chrome-linux' : 'chrome-linux64', 'chrome')
}

async function isChromiumExecutablePresent(directory: string, browserDirectory: string) {
  try {
    const registry = JSON.parse(
      await readFile(join(directory, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')
    ) as {
      browsers?: Array<{ name?: string; revision?: string; browserRevision?: string }>
    }
    const chromium = registry.browsers?.find((browser) => browser?.name === 'chromium')
    const revision = chromium?.browserRevision ?? chromium?.revision
    if (revision === undefined) {
      return false
    }

    return await doesExist(join(browserDirectory, chromiumExecutableRelative(revision)))
  } catch {
    return false
  }
}

async function isCamoufoxReady(camoufoxDirectory: string) {
  return doesExist(join(camoufoxDirectory, 'version.json'))
}

type InstallConfig = {
  options: RuntimeOptions
  directory: string
  isForce: boolean
  environment: NodeJS.ProcessEnv
}

async function installPackages(config: InstallConfig) {
  const { options, directory, isForce, environment } = config
  const playwrightPackage = join(directory, 'node_modules', 'playwright', 'package.json')
  const playwrightCorePackage = join(directory, 'node_modules', 'playwright-core', 'package.json')
  const camoufoxPackage = join(directory, 'node_modules', CAMOUFOX_PACKAGE, 'package.json')
  const chromiumMarker = join(directory, `.chromium-${PLAYWRIGHT_VERSION}`)
  const camoufoxMarker = join(directory, `.camoufox-${CAMOUFOX_VERSION}`)
  const isPackageReady =
    (await isPackageMatch(playwrightPackage, 'playwright', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(playwrightCorePackage, 'playwright-core', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(camoufoxPackage, CAMOUFOX_PACKAGE, CAMOUFOX_VERSION))
  if (isForce || !isPackageReady) {
    await run(
      optionString(options, 'playwrightNpmPath', 'npm'),
      [
        'install',
        '--prefix',
        directory,
        `playwright@${PLAYWRIGHT_VERSION}`,
        `${CAMOUFOX_PACKAGE}@${CAMOUFOX_VERSION}`
      ],
      environment
    )
    await rm(chromiumMarker, { force: true })
    await rm(camoufoxMarker, { force: true })
  }

  const isAllReady =
    (await isPackageMatch(playwrightPackage, 'playwright', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(playwrightCorePackage, 'playwright-core', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(camoufoxPackage, CAMOUFOX_PACKAGE, CAMOUFOX_VERSION))
  if (!isAllReady) {
    throw new Error(
      `Playwright setup did not install playwright ${PLAYWRIGHT_VERSION} and ${CAMOUFOX_PACKAGE} ${CAMOUFOX_VERSION}`
    )
  }
}

async function isPackageMatch(file: string, name: string, version: string) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as { name?: string; version?: string }
    return value.name === name && value.version === version
  } catch {
    return false
  }
}

async function installChromium(config: InstallConfig, browserDirectory: string) {
  const { options, directory, isForce, environment } = config
  const chromiumMarker = join(directory, `.chromium-${PLAYWRIGHT_VERSION}`)
  const isMarkerReady =
    !isForce &&
    (await doesExist(chromiumMarker)) &&
    (await isChromiumExecutablePresent(directory, browserDirectory))
  if (isMarkerReady) {
    return
  }

  await run(
    optionString(options, 'playwrightNpxPath', 'npx'),
    ['--prefix', directory, 'playwright', 'install', 'chromium'],
    environment
  )
  if (!(await isChromiumExecutablePresent(directory, browserDirectory))) {
    throw new Error(`Chromium executable is missing from ${browserDirectory} after installation`)
  }

  await writeFile(chromiumMarker, '')
}

async function installCamoufox(config: InstallConfig, camoufoxDirectory: string) {
  const { options, directory, isForce, environment } = config
  const camoufoxMarker = join(directory, `.camoufox-${CAMOUFOX_VERSION}`)
  const isMarkerReady =
    !isForce && (await doesExist(camoufoxMarker)) && (await isCamoufoxReady(camoufoxDirectory))
  if (isMarkerReady) {
    return
  }

  await run(
    optionString(options, 'playwrightNpxPath', 'npx'),
    ['--prefix', directory, CAMOUFOX_PACKAGE, 'fetch'],
    environment
  )
  if (!(await isCamoufoxReady(camoufoxDirectory))) {
    throw new Error(`Camoufox is missing from ${camoufoxDirectory} after installation`)
  }

  await writeFile(camoufoxMarker, '')
}

export async function setupPlaywright(options: RuntimeOptions, isForce = false) {
  const directory = playwrightCacheDirectory(options)
  const browserDirectory = playwrightBrowserDirectory(options)
  const camoufoxDirectory = join(directory, CAMOUFOX_INSTALL_DIR_NAME)
  const environment = {
    ...process.env,
    [envKey('PLAYWRIGHT_BROWSERS_PATH')]: browserDirectory,
    [envKey('CAMOUFOX_INSTALL_DIR')]: camoufoxDirectory
  }
  await mkdir(directory, { recursive: true })
  await withCacheLock(join(directory, '.playwright-setup'), async () => {
    const config: InstallConfig = { options, directory, isForce, environment }
    await installPackages(config)
    await installChromium(config, browserDirectory)
    await installCamoufox(config, camoufoxDirectory)
  })
  return `Shared Playwright ${PLAYWRIGHT_VERSION}, Camoufox ${CAMOUFOX_VERSION} and their browsers are ready at ${directory}.`
}
