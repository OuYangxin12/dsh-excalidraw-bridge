/**
 * Offline harness: mounts plugin/index.js against a stub Host context, then
 * exposes a debug HTTP API so a real browser extension can be driven without
 * the DSH process. Used only for development verification.
 *
 *   node tools/mock-bridge.mjs [--port 49771] [--debug 49790]
 */
import { createServer } from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as plugin from '../plugin/index.js'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const debugPort = Number(argOf('debug', '46190'))
const workspace = 'G:\\proj\\game-assis'

const tools = new Map()
const cleanups = []
const captured = { startRequests: [], prompts: [], sessions: [] }

const sessionController = {
  async create(request) {
    const sessionId = `session-mock-${captured.sessions.length + 1}`
    captured.sessions.push({ sessionId, request })
    return { sessionId }
  },
  async prompt(request) {
    captured.prompts.push(request)
    return { accepted: true }
  },
}

const services = {
  sessionController,
  workspaceRegistry: { list: () => [{ id: 'ws-mock', path: workspace }] },
  workingDirectory: { defaultDirectory: workspace, get: () => workspace },
  connection: { authenticatedUrl: (url) => `${url}?token=mock-token` },
  webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:59999' },
  webServer: {
    register() { return () => {} },
    getOrigin() { return 'http://127.0.0.1:0' },
  },
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') cleanups.push(dispose)
    return dispose
  },
  inject(_deps, callback) {
    return callback(ctx)
  },
  get(name) { return services[name] },
  tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  logger() { return { info() {}, warn() {}, error() {} } },
}

// Cordis exposes injected services as context properties too.
for (const [key, value] of Object.entries(services)) {
  if (!(key in ctx)) ctx[key] = value
}

plugin.apply(ctx)

// Wait until the bridge reports a port.
const candidatePorts = Array.from({ length: 20 }, (_, index) => 46231 + index)
  .concat(Array.from({ length: 10 }, (_, index) => 47321 + index))
const statusOf = async () => {
  for (const port of candidatePorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/excalidraw/hello`)
      if (response.ok) {
        const hello = await response.json()
        if (hello.name === 'dsh-excalidraw') return { port, hello }
      }
    } catch {}
  }
  return undefined
}

let bridgePort
for (let attempt = 0; attempt < 50 && bridgePort === undefined; attempt++) {
  const found = await statusOf()
  if (found !== undefined) bridgePort = found.port
  else await new Promise((resolve) => setTimeout(resolve, 100))
}
if (bridgePort === undefined) {
  console.error('mock-bridge: plugin did not start its bridge')
  process.exit(1)
}
console.log(`mock-bridge: plugin bridge on ${bridgePort}`)

// Fake agent context for tool execution.
const agent = { session: { id: 'session-mock-1', header: { cwd: workspace } } }
const execFor = (sessionId = 'session-mock-1') => ({
  agent: { session: { id: sessionId, header: { cwd: workspace } } },
  signal: AbortSignal.timeout(60_000),
})

const debug = createServer(async (req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (url.pathname === '/_state') {
      send(200, {
        ok: true,
        bridgePort,
        tools: [...tools.keys()],
        sessions: captured.sessions,
        startRequests: captured.startRequests,
        promptCount: captured.prompts.length,
        prompt: captured.prompts.at(-1)?.content?.[0]?.text,
      })
      return
    }
    if (url.pathname === '/_savePrompt') {
      const text = captured.prompts.at(-1)?.content?.[0]?.text ?? ''
      mkdirSync(join(workspace, 'research'), { recursive: true })
      const file = join(workspace, 'research', 'prompt-sample.md')
      writeFileSync(file, text, 'utf8')
      send(200, { ok: true, file, chars: text.length })
      return
    }
    if (url.pathname === '/_start' && req.method === 'POST') {
      const body = await readBody(req)
      captured.startRequests.push(body)
      send(200, { ok: true, forwarded: true })
      return
    }
    if (url.pathname === '/_tool' && req.method === 'POST') {
      const body = await readBody(req)
      const tool = tools.get(body.name)
      if (tool === undefined) {
        send(404, { ok: false, error: `unknown tool ${body.name}` })
        return
      }
      const value = await tool.execute(body.args ?? {}, execFor(body.sessionId))
      send(200, { ok: true, value })
      return
    }
    if (url.pathname === '/_scene') {
      const tool = tools.get('excalidraw_get_scene')
      const value = await tool.execute({ scope: 'all' }, execFor())
      send(200, { ok: true, value })
      return
    }
    send(404, { ok: false, error: 'not found' })
  } catch (error) {
    send(500, { ok: false, error: String(error?.message ?? error) })
  }
})

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

debug.listen(debugPort, '127.0.0.1', () => {
  console.log(`mock-bridge: debug API on http://127.0.0.1:${debugPort}`)
})

const shutdown = () => {
  debug.close()
  for (const dispose of cleanups.splice(0)) {
    try { dispose() } catch {}
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
