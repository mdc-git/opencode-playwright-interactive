import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

const repository = path.resolve(import.meta.dirname, '..')
const password = 'node-repl-test-password'
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
function withServerDiagnostics(message, diagnostics) {
  return [message, diagnostics.stderr === '' ? '' : `Server stderr:\n${diagnostics.stderr}`]
    .filter(Boolean)
    .join('\n')
}

async function readServerUrl(server, diagnostics) {
  const lines = createInterface({ input: server.stdout })
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 10_000)
  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: abort.signal }),
      once(server, 'error', { signal: abort.signal }).then(([error]) => {
        throw error
      }),
      once(server, 'exit', { signal: abort.signal }).then(([code, signal]) => {
        throw new Error(`OpenCode server exited before readiness (${code ?? `signal=${signal}`})`)
      })
    ])
    return JSON.parse(line).url
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(withServerDiagnostics(message, diagnostics), { cause: error })
  } finally {
    clearTimeout(timeout)
    abort.abort()
    lines.close()
  }
}

async function api(base, requestPath, diagnostics, options = {}) {
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 10_000)
  try {
    const response = await fetch(new URL(requestPath, base), {
      ...options,
      headers: { authorization, 'content-type': 'application/json', ...options.headers },
      signal: abort.signal
    })
    if (!response.ok) {
      throw new Error(
        withServerDiagnostics(
          `OpenCode API request failed (${response.status}): ${await response.text()}`,
          diagnostics
        )
      )
    }

    return response.status === 204 ? undefined : await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function awaitActivation(base, directory, diagnostics) {
  return api(
    base,
    `/api/plugin/await-activation?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    diagnostics,
    { method: 'POST', body: '{}' }
  )
}

function pluginTimeoutError(diagnostics, statuses, plugins) {
  const failures = plugins.filter(({ state }) => state?.status === 'failed')
  return new Error(
    withServerDiagnostics(
      [
        'Timed out waiting for local.node_repl',
        statuses.length > 0 ? `Poll results: ${statuses.slice(-10).join(', ')}` : '',
        failures.length > 0 ? `Plugin failures: ${JSON.stringify(failures)}` : ''
      ]
        .filter(Boolean)
        .join('\n'),
      diagnostics
    )
  )
}

function isActivePlugin(plugin) {
  return plugin?.state?.status === 'active'
}

async function waitForLocalPlugin(base, directory, diagnostics, deadline = Date.now() + 10_000) {
  return new Promise((resolve, reject) => {
    const statuses = []
    let plugins = []
    const poll = async () => {
      const result = await pollLocalPlugin(base, directory)
      if (result.plugins.length > 0) {
        plugins = result.plugins
      }

      if (isActivePlugin(result.plugin)) {
        clearInterval(timer)
        clearTimeout(timeout)
        resolve(result.plugin)
        return
      }

      if (result.status) {
        statuses.push(result.status)
      }
    }

    const timer = setInterval(poll, 100)
    const timeout = setTimeout(
      () => {
        clearInterval(timer)
        reject(pluginTimeoutError(diagnostics, statuses, plugins))
      },
      Math.max(0, deadline - Date.now())
    )
    poll()
  })
}

async function pollLocalPlugin(base, directory) {
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 5000)
  try {
    const endpoint = new URL('/api/plugin', base)
    endpoint.searchParams.set('location[directory]', directory)
    const response = await fetch(endpoint, { headers: { authorization }, signal: abort.signal })
    if (!response.ok) {
      return { plugins: [], status: `HTTP ${response.status}` }
    }

    const body = await response.json()
    const plugins = body.data
    return { plugins, plugin: plugins.find(({ id }) => id === 'local.node_repl') }
  } catch (error) {
    return { plugins: [], status: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForClose(server, milliseconds) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return true
  }

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), milliseconds)
  try {
    await once(server, 'close', { signal: abort.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
    abort.abort()
  }
}

async function stopServer(server) {
  server.kill('SIGTERM')
  if (await waitForClose(server, 2000)) {
    return
  }

  server.kill('SIGKILL')
  await waitForClose(server, 2000).then((closed) => {
    if (!closed) {
      throw new Error('OpenCode server did not exit after SIGKILL')
    }
  })
}

function startServer(project, root) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith('OPENCODE_') &&
        name !== 'NODE_OPTIONS' &&
        !['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMPDIR', 'TMP', 'TEMP'].includes(name)
    )
  )
  const diagnostics = { stderr: '' }
  const server = spawn(
    process.env.OPENCODE_BIN ?? 'opencode2',
    ['serve', '--stdio', '--port', '0'],
    {
      cwd: project,
      env: {
        ...inherited,
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        HOMEDRIVE: '',
        HOMEPATH: path.join(root, 'home'),
        OPENCODE_CONFIG_CONTENT: '{}',
        OPENCODE_CONFIG_DIR: path.join(root, 'config'),
        OPENCODE_DB: path.join(root, 'opencode.db'),
        OPENCODE_TEST_HOME: root,
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_PASSWORD: password,
        TMPDIR: path.join(root, 'tmp'),
        TMP: path.join(root, 'tmp'),
        TEMP: path.join(root, 'tmp'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_STATE_HOME: path.join(root, 'state')
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  server.stderr.setEncoding('utf8')
  server.stderr.on('data', (chunk) => {
    diagnostics.stderr = `${diagnostics.stderr}${chunk}`.slice(-16_384)
  })
  return { server, diagnostics }
}

async function assertPluginRegistrations(base, directory, diagnostics) {
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const location = encodeURIComponent(directory)
        const [{ data: commands }, { data: skills }] = await Promise.all([
          api(base, `/api/command?location%5Bdirectory%5D=${location}`, diagnostics),
          api(base, `/api/skill?location%5Bdirectory%5D=${location}`, diagnostics)
        ])
        if (
          commands.some(({ name }) => name === 'playwright') &&
          skills.some(({ id }) => id === 'playwright-interactive')
        ) {
          clearInterval(timer)
          clearTimeout(timeout)
          resolve()
        }
      } catch {}
    }

    const timer = setInterval(poll, 100)
    const timeout = setTimeout(() => {
      clearInterval(timer)
      reject(
        new Error(withServerDiagnostics('Timed out waiting for plugin registrations', diagnostics))
      )
    }, 10_000)
    poll()
  })
}

test('loads the local plugin in a standalone session from a temp project', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'opencode-playwright-interactive-'))
  let server
  try {
    const project = path.join(root, 'project')
    const pluginDirectory = path.join(repository, '.opencode')
    await mkdir(project, { recursive: true })
    await mkdir(path.join(root, 'tmp'), { recursive: true })
    await writeFile(
      path.join(project, 'opencode.jsonc'),
      `${JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        plugins: [pluginDirectory]
      })}\n`
    )
    const started = startServer(project, root)
    server = started.server
    const base = await readServerUrl(server, started.diagnostics)
    const session = await api(base, '/api/session', started.diagnostics, {
      method: 'POST',
      body: JSON.stringify({ location: { directory: project } })
    })
    assert.ok(session.data.id)
    await awaitActivation(base, project, started.diagnostics)
    const plugin = await waitForLocalPlugin(base, project, started.diagnostics)
    assert.equal(plugin.state.status, 'active')
    assert.equal(plugin.source.type, 'local')
    assert.equal(plugin.source.path, path.join(pluginDirectory, 'index.ts'))
    await assertPluginRegistrations(base, project, started.diagnostics)
  } finally {
    try {
      if (server) {
        await stopServer(server)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
