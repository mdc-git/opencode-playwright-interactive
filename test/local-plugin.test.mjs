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

async function readServerUrl(server) {
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
  } finally {
    clearTimeout(timeout)
    abort.abort()
    lines.close()
  }
}

async function api(base, requestPath, options = {}) {
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 10_000)
  try {
    const response = await fetch(new URL(requestPath, base), {
      ...options,
      headers: { authorization, 'content-type': 'application/json', ...options.headers },
      signal: abort.signal
    })
    if (!response.ok) {
      throw new Error(`OpenCode API request failed (${response.status}): ${await response.text()}`)
    }

    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForLocalPlugin(base, directory, deadline = Date.now() + 10_000) {
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const abort = new AbortController()
      const requestTimeout = setTimeout(() => abort.abort(), 2000)
      try {
        const endpoint = new URL('/api/plugin', base)
        endpoint.searchParams.set('location[directory]', directory)
        const response = await fetch(endpoint, { headers: { authorization }, signal: abort.signal })
        if (response.ok) {
          const body = await response.json()
          const plugin = body.data.find(({ id }) => id === 'local.node_repl')
          if (plugin) {
            clearInterval(timer)
            clearTimeout(timeout)
            resolve(plugin)
          }
        }
      } catch (error) {
        clearInterval(timer)
        clearTimeout(timeout)
        reject(error)
      } finally {
        clearTimeout(requestTimeout)
      }
    }

    const timer = setInterval(poll, 100)
    const timeout = setTimeout(
      () => {
        clearInterval(timer)
        reject(new Error('Timed out waiting for local.node_repl'))
      },
      Math.max(0, deadline - Date.now())
    )
    poll()
  })
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
  if (server.exitCode !== null || server.signalCode !== null) {
    return
  }

  server.kill('SIGTERM')
  if (await waitForClose(server, 2000)) {
    return
  }

  server.kill('SIGKILL')
  await waitForClose(server, 2000)
}

function startServer(project, root) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith('OPENCODE_') &&
        !['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMPDIR', 'TMP', 'TEMP'].includes(name)
    )
  )
  return spawn(process.env.OPENCODE_BIN ?? 'opencode2', ['serve', '--stdio', '--port', '0'], {
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
    stdio: ['pipe', 'pipe', 'ignore']
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

    server = startServer(project, root)
    const base = await readServerUrl(server)
    const session = await api(base, '/api/session', {
      method: 'POST',
      body: JSON.stringify({ location: { directory: project } })
    })
    assert.ok(session.data.id)

    const plugin = await waitForLocalPlugin(base, project)
    assert.equal(plugin.state.status, 'active')
    assert.equal(plugin.source.type, 'local')
    assert.equal(plugin.source.path, path.join(pluginDirectory, 'index.ts'))
  } finally {
    if (server) {
      await stopServer(server)
    }

    await rm(root, { recursive: true, force: true })
  }
})
