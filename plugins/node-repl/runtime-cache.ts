import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { withCacheLock } from './runtime-cache-lock.ts'
import { boundedUtf8, doesExist, errorMessage, execFileAsync } from './runtime-process.ts'
import type { RuntimeOptions } from './runtime-types.ts'

const envKey = <const K extends string>(key: K): K => key

const PLAYWRIGHT_VERSION = '1.60.0'
const CAMOUFOX_VERSION = '0.12.0'
const CAMOUFOX_PACKAGE = 'camoufox-js'
const CAMOUFOX_INSTALL_DIR_NAME = 'camoufox'

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
    return chromiumMacExecutable(folder)
  }

  if (process.platform === 'win32') {
    return join(folder, 'chrome-win64', 'chrome.exe')
  }

  return join(folder, process.arch === 'arm64' ? 'chrome-linux' : 'chrome-linux64', 'chrome')
}

function chromiumMacExecutable(folder: string) {
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

type BrowserRegistryEntry = { name?: string; revision?: string; browserRevision?: string }

function chromiumEntryRevision(entry: BrowserRegistryEntry | undefined) {
  return entry?.browserRevision ?? entry?.revision
}

async function readChromiumRevision(directory: string) {
  const registry = JSON.parse(
    await readFile(join(directory, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')
  ) as { browsers?: BrowserRegistryEntry[] }
  const chromium = registry.browsers?.find((browser) => browser?.name === 'chromium')
  return chromiumEntryRevision(chromium)
}

async function isChromiumExecutablePresent(directory: string, browserDirectory: string) {
  try {
    const revision = await readChromiumRevision(directory)
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

async function arePackagesReady(directory: string) {
  const playwrightPackage = join(directory, 'node_modules', 'playwright', 'package.json')
  const playwrightCorePackage = join(directory, 'node_modules', 'playwright-core', 'package.json')
  const camoufoxPackage = join(directory, 'node_modules', CAMOUFOX_PACKAGE, 'package.json')
  return (
    (await isPackageMatch(playwrightPackage, 'playwright', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(playwrightCorePackage, 'playwright-core', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(camoufoxPackage, CAMOUFOX_PACKAGE, CAMOUFOX_VERSION))
  )
}

async function installPackages(config: InstallConfig) {
  const { options, directory, isForce, environment } = config
  const chromiumMarker = join(directory, `.chromium-${PLAYWRIGHT_VERSION}`)
  const camoufoxMarker = join(directory, `.camoufox-${CAMOUFOX_VERSION}`)
  const isPackageReady = await arePackagesReady(directory)
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

  const isAllReady = await arePackagesReady(directory)
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

async function isMarkerReady(marker: string, isForce: boolean, isReady: () => Promise<boolean>) {
  return !isForce && (await doesExist(marker)) && (await isReady())
}

async function installAndMark(
  config: InstallConfig,
  spec: { marker: string; args: string[]; isReady: () => Promise<boolean>; missing: string }
) {
  const { options, environment } = config
  await run(optionString(options, 'playwrightNpxPath', 'npx'), spec.args, environment)
  if (!(await spec.isReady())) {
    throw new Error(spec.missing)
  }

  await writeFile(spec.marker, '')
}

async function installChromium(config: InstallConfig, browserDirectory: string) {
  const { directory, isForce } = config
  const chromiumMarker = join(directory, `.chromium-${PLAYWRIGHT_VERSION}`)
  const isChromiumReady = async () => isChromiumExecutablePresent(directory, browserDirectory)
  if (await isMarkerReady(chromiumMarker, isForce, isChromiumReady)) {
    return
  }

  await installAndMark(config, {
    marker: chromiumMarker,
    args: ['--prefix', directory, 'playwright', 'install', 'chromium'],
    isReady: isChromiumReady,
    missing: `Chromium executable is missing from ${browserDirectory} after installation`
  })
}

async function installCamoufox(config: InstallConfig, camoufoxDirectory: string) {
  const { directory, isForce } = config
  const camoufoxMarker = join(directory, `.camoufox-${CAMOUFOX_VERSION}`)
  const isCamoufoxInstalled = async () => isCamoufoxReady(camoufoxDirectory)
  if (await isMarkerReady(camoufoxMarker, isForce, isCamoufoxInstalled)) {
    return
  }

  await installAndMark(config, {
    marker: camoufoxMarker,
    args: ['--prefix', directory, CAMOUFOX_PACKAGE, 'fetch'],
    isReady: isCamoufoxInstalled,
    missing: `Camoufox is missing from ${camoufoxDirectory} after installation`
  })
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
