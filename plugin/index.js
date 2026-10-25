/**
 * DSH × Excalidraw bridge — Host half.
 *
 * What it does:
 *  1. Runs a tiny loopback HTTP bridge (default 127.0.0.1:46231) that the
 *     companion Chrome extension long-polls for page operations and posts
 *     scene snapshots / start requests to.
 *  2. Registers Excalidraw tools on the calling Session so the agent can read
 *     the live scene, apply element operations inside the user's selected
 *     scope, and capture a PNG of the board.
 *  3. Starts a fresh DSH Session with an injected scene context when the user
 *     clicks the floating button on excalidraw.com.
 *  4. Serves a `/pending` long-poll the companion Client half uses to switch
 *     an already-open DSH window to the new Session.
 *
 * Everything is local: the bridge binds 127.0.0.1 only and never leaves the
 * machine. The extension identifies itself with a random client id.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const name = 'dsh-excalidraw-bridge'
export const inject = ['tools']

const DEFAULT_PORT = 46231
const PORT_ATTEMPTS = 20
const LONG_POLL_MS = 25_000
const CLIENT_STALE_MS = 45_000

/** Max scene elements serialized into the injected first prompt. */
const PROMPT_SCENE_LIMIT = 160

/* ------------------------------------------------------------------ *
 * Scene helpers
 * ------------------------------------------------------------------ */

const ELEMENT_KEYS = [
  'id', 'type', 'x', 'y', 'width', 'height', 'angle',
  'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle',
  'roughness', 'opacity', 'groupIds', 'frameId', 'roundness',
  'text', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'containerId',
  'points', 'startBinding', 'endBinding', 'boundElements', 'link', 'locked',
]

/** Compact one Excalidraw element for the prompt (keeps drawing-relevant fields). */
function compactElement(el) {
  const out = {}
  for (const key of ELEMENT_KEYS) {
    if (el[key] !== undefined) out[key] = el[key]
  }
  if (Array.isArray(out.points) && out.points.length > 40) {
    out.points = out.points.slice(0, 40).concat([['...', out.points.length - 40]])
  }
  return out
}

function bboxOf(elements) {
  const visible = elements.filter((el) => !el.isDeleted)
  if (visible.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of visible) {
    const w = el.width ?? 0
    const h = el.height ?? 0
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + Math.abs(w))
    maxY = Math.max(maxY, el.y + Math.abs(h))
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function typeCounts(elements) {
  const counts = {}
  for (const el of elements) {
    if (el.isDeleted) continue
    counts[el.type] = (counts[el.type] ?? 0) + 1
  }
  return counts
}

/* ------------------------------------------------------------------ *
 * Bridge
 * ------------------------------------------------------------------ */

class Bridge {
  constructor(ctx) {
    this.ctx = ctx
    this.port = Number(process.env.DSH_EXCALIDRAW_BRIDGE_PORT ?? 0) || DEFAULT_PORT
    this.server = undefined
    /** @type {Map<string, any>} clientId -> client record */
    this.clients = new Map()
    this.sessions = new Map()
    this.pendingOpens = []
    this.pendingSeq = 0
    this.waiters = new Set()
    this.clientWaiters = new Map()
    this.activePollers = new Set()
    /** @type {Map<string, any>} opId -> pending page operation */
    this.pendingOps = new Map()
    /** Last time a DSH Web GUI asked for pending session opens. */
    this.guiSeenAt = 0
  }

  async start() {
    let lastError
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
      const port = this.port + attempt
      const server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          try {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          } catch { /* socket already gone */ }
        })
      })
      server.keepAliveTimeout = 5_000
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
          })
        })
        this.server = server
        this.port = port
        try {
          this.ctx.logger('dsh-excalidraw').info(`bridge listening on http://127.0.0.1:${port}`)
        } catch { /* logger shape varies across Host versions; never fail boot for a log line */ }
        return () => this.stop()
      } catch (error) {
        lastError = error
        server.close()
      }
    }
    throw new Error(`dsh-excalidraw: cannot bind a loopback bridge port (${DEFAULT_PORT}..${DEFAULT_PORT + PORT_ATTEMPTS - 1}): ${String(lastError?.message ?? lastError)}`)
  }

  stop() {
    for (const waiter of this.clientWaiters.values()) waiter()
    this.clientWaiters.clear()
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
    if (this.server !== undefined) {
      this.server.close()
      this.server = undefined
    }
  }

  /* ---------------- clients ---------------- */

  client(clientId) {
    const record = this.clients.get(clientId)
    if (record === undefined) return undefined
    record.lastSeen = Date.now()
    return record
  }

  touch(payload) {
    const clientId = String(payload.clientId ?? '')
    if (clientId === '') return undefined
    let record = this.clients.get(clientId)
    if (record === undefined) {
      record = { clientId, queue: [], busy: false, lastSeen: Date.now() }
      this.clients.set(clientId, record)
    }
    record.lastSeen = Date.now()
    for (const key of ['tabId', 'url', 'title', 'version', 'pageId']) {
      if (payload[key] !== undefined) record[key] = payload[key]
    }
    return record
  }

  pickClient(preferredId) {
    const now = Date.now()
    const usable = (record) => record !== undefined && record.polled === true && now - record.lastSeen <= CLIENT_STALE_MS
    if (preferredId !== undefined && usable(this.clients.get(preferredId))) return this.clients.get(preferredId)
    let best
    for (const record of this.clients.values()) {
      if (!usable(record)) continue
      if (best === undefined || record.lastSeen > best.lastSeen) best = record
    }
    return best
  }

  hasFreshClient() {
    return this.pickClient() !== undefined
  }

  /* ---------------- page operations ---------------- */

  requestOp(clientId, type, payload = {}, timeoutMs = 20_000) {
    const client = this.pickClient(clientId)
    if (client === undefined) {
      return Promise.reject(new Error('没有连接到 Excalidraw 页面。请确认浏览器扩展已安装并在 excalidraw.com 页面刷新后启用。'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const op = { id, type, payload }
      this.pendingOps.set(id, op)
      const timer = setTimeout(() => {
        const at = client.queue.indexOf(op)
        if (at !== -1) client.queue.splice(at, 1)
        this.pendingOps.delete(id)
        reject(new Error(`Excalidraw 页面在 ${Math.round(timeoutMs / 1000)}s 内没有响应操作 "${type}"`))
      }, timeoutMs)
      op.resolve = (value) => { clearTimeout(timer); this.pendingOps.delete(id); resolve(value) }
      op.reject = (error) => { clearTimeout(timer); this.pendingOps.delete(id); reject(error) }
      client.queue.push(op)
      this.flushClient(client)
    })
  }

  flushClient(client) {
    const waiter = this.clientWaiters.get(client.clientId)
    if (waiter !== undefined && client.queue.length > 0) {
      this.clientWaiters.delete(client.clientId)
      this.activePollers.delete(client.clientId)
      waiter()
    }
  }

  waitOps(client, signal) {
    if (client.queue.length > 0) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        this.clientWaiters.delete(client.clientId)
        this.activePollers.delete(client.clientId)
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', done)
        resolve()
      }
      const timer = setTimeout(done, LONG_POLL_MS)
      this.clientWaiters.set(client.clientId, done)
      this.activePollers.add(client.clientId)
      signal?.addEventListener?.('abort', done, { once: true })
    })
  }

  takeOps(client) {
    const ops = client.queue.map((op) => ({ id: op.id, type: op.type, payload: op.payload }))
    client.queue.length = 0
    return ops
  }

  settleOp(payload) {
    const op = this.pendingOps.get(String(payload.id ?? ''))
    if (op === undefined) return false
    if (payload.ok === false) op.reject(new Error(String(payload.error ?? 'page operation failed')))
    else op.resolve(payload.value)
    return true
  }

  /* ---------------- pending GUI opens ---------------- */

  pushPendingOpen(sessionId) {
    this.pendingSeq += 1
    this.pendingOpens.push({ seq: this.pendingSeq, sessionId, time: Date.now() })
    if (this.pendingOpens.length > 20) this.pendingOpens.splice(0, this.pendingOpens.length - 20)
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
  }

  /** Whether a DSH Web GUI is currently polling for pending sessions. */
  hasGuiClient() {
    return this.waiters.size > 0 || Date.now() - this.guiSeenAt < 35_000
  }

  pendingSince(seq) {
    return this.pendingOpens.filter((entry) => entry.seq > seq)
  }

  async waitPending(seq, signal) {
    this.guiSeenAt = Date.now()
    const immediate = this.pendingSince(seq)
    if (immediate.length > 0) return immediate
    await new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done)
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', done)
        resolve()
      }
      const timer = setTimeout(done, LONG_POLL_MS)
      this.waiters.add(done)
      signal?.addEventListener?.('abort', done, { once: true })
    })
    return this.pendingSince(seq)
  }

  /* ---------------- session creation ---------------- */

  /** The workspaces a new board session can be created in. */
  workspaces() {
    const registry = this.ctx.get('workspaceRegistry')
    const workingDirectory = this.ctx.get('workingDirectory')
    let list = []
    try { list = registry?.list?.() ?? [] } catch { list = [] }
    const defaultPath = workingDirectory?.defaultDirectory
    return list.map((ws) => ({
      id: String(ws.id),
      path: String(ws.path ?? ''),
      title: String(ws.title ?? basename(ws.path ?? '') ?? ''),
      current: typeof defaultPath === 'string' && ws.path === defaultPath,
    }))
  }

  async startSession(context, request, clientId, options = {}) {
    const sessionController = this.ctx.get('sessionController')
    const workingDirectory = this.ctx.get('workingDirectory')
    if (sessionController === undefined) throw new Error('sessionController 服务不可用，无法创建会话')

    let workspaceId
    let cwd
    let workspaceInfo
    const wantedPath = process.env.DSH_EXCALIDRAW_WORKSPACE
    try {
      const workspaces = this.workspaces()
      const preferred = (options.workspaceId !== undefined
        ? workspaces.find((ws) => ws.id === String(options.workspaceId))
        : undefined) ??
        (wantedPath === undefined
          ? (workspaces.find((ws) => ws.current) ?? workspaces[0])
          : workspaces.find((ws) => ws.path === wantedPath))
      if (preferred !== undefined) {
        workspaceId = preferred.id
        workspaceInfo = preferred
      } else {
        cwd = workingDirectory?.defaultDirectory
      }
    } catch { /* fall through to the default cwd */ }

    const created = await sessionController.create(workspaceId === undefined ? { ...(cwd === undefined ? {} : { cwd }) } : { workspaceId })
    const sessionId = created.sessionId

    const scope = normalizeScope(context)
    this.sessions.set(sessionId, {
      clientId,
      scope,
      pageUrl: context?.url,
      workspace: workspaceInfo,
      startedAt: Date.now(),
    })

    // The board context is only sent together with the user's first message, so
    // merely opening the panel never starts a model turn.
    const firstMessage = typeof options.firstMessage === 'string' ? options.firstMessage.trim() : ''
    const prompt = buildPrompt(context, scope, firstMessage === '' ? undefined : firstMessage)
    if (firstMessage === '' && options.contextOnly !== true) {
      // No message yet: leave the session idle instead of triggering a turn.
    } else {
      await sessionController.prompt({
        requestId: `excalidraw-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, new AbortController().signal)
    }

    // Silent by default: the page's own chat panel is the primary surface. The
    // DSH window is switched only when the user explicitly asks for it.
    if (options.openInGui === true) this.pushPendingOpen(sessionId)
    return {
      sessionId,
      openedInClient: this.hasGuiClient(),
      authUrl: this.authUrl(),
      scope,
      workspace: workspaceInfo,
      started: firstMessage !== '' || options.contextOnly === true,
      silent: options.openInGui !== true,
    }
  }

  /** Register (or reuse) a workspace for an arbitrary directory path. */
  async createWorkspace(path) {
    const raw = String(path ?? '').trim()
    if (raw === '') throw new Error('目录路径不能为空')
    const registry = this.ctx.get('workspaceRegistry')
    if (registry?.create === undefined) throw new Error('workspaceRegistry 服务不可用')
    let info
    try {
      info = await stat(raw)
    } catch {
      throw new Error(`目录不存在或不可访问：${raw}`)
    }
    if (info.isDirectory() !== true) throw new Error(`不是目录：${raw}`)
    // An existing workspace for the same directory is reused instead of adding
    // a duplicate row to the DSH workspace list.
    const normalize = (value) => String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    const existing = this.workspaces().find((item) => normalize(item.path) === normalize(raw))
    if (existing !== undefined) return { workspace: existing, reused: true }
    let workspace
    try {
      workspace = await registry.create(raw)
    } catch (error) {
      throw new Error(`注册工作区失败：${String(error?.message ?? error)}`)
    }
    return {
      workspace: {
        id: String(workspace.id),
        path: String(workspace.path ?? raw),
        title: String(workspace.title ?? basename(raw) ?? ''),
        current: false,
      },
      reused: false,
    }
  }

  /** Add one chat message to an existing bridge-owned session. */
  async sendMessage(sessionId, text, scopeIds) {
    const sessionController = this.ctx.get('sessionController')
    if (sessionController === undefined) throw new Error('sessionController 服务不可用')
    const binding = this.sessions.get(sessionId)
    if (binding === undefined) throw new Error(`未知会话 ${sessionId}（可能已随 DSH 重启失效）`)
    if (Array.isArray(scopeIds)) {
      binding.scope = scopeIds.length > 0
        ? { kind: 'selection', ids: scopeIds.filter((id) => typeof id === 'string'), bbox: null }
        : { kind: 'all', ids: [], bbox: null }
    }
    await sessionController.prompt({
      requestId: `excalidraw-${randomUUID()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, new AbortController().signal)
    return { accepted: true, scope: binding.scope }
  }

  /**
   * Long-poll the session log for chat frames the page panel has not seen yet.
   * `inspect()` is cold-safe and reads committed events only; the panel shows a
   * "thinking" state from turn boundaries between polls.
   */
  async chatSince(sessionId, since, signal, verbose = false) {
    const sessionController = this.ctx.get('sessionController')
    if (sessionController === undefined) throw new Error('sessionController 服务不可用')
    if (this.sessions.get(sessionId) === undefined) throw new Error(`未知会话 ${sessionId}（可能已随 DSH 重启失效）`)
    const deadline = Date.now() + 20_000
    for (;;) {
      let inspection
      try {
        inspection = await sessionController.inspect(sessionId)
      } catch (error) {
        if (Date.now() > deadline || signal?.aborted) throw error
        await new Promise((resolve) => setTimeout(resolve, 400))
        continue
      }
      const events = Array.isArray(inspection?.events) ? inspection.events : []
      const frames = chatFrames(events, since, verbose)
      const running = isTurnRunning(events)
      if (frames.length > 0) return { frames, since: frames.at(-1).seq, running }
      if (Date.now() > deadline || signal?.aborted) return { frames: [], since, running }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  async openInGui(sessionId) {
    if (this.sessions.get(sessionId) === undefined) throw new Error(`未知会话 ${sessionId}`)
    this.pushPendingOpen(sessionId)
    return { opened: this.hasGuiClient(), authUrl: this.authUrl() }
  }

  /** Replace the modification scope of one bridge-owned session. */
  setScope(sessionId, ids) {
    const binding = this.sessions.get(sessionId)
    if (binding === undefined) throw new Error(`未知会话 ${sessionId}`)
    const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string')
    binding.scope = list.length > 0
      ? { kind: 'selection', ids: list, bbox: null }
      : { kind: 'all', ids: [], bbox: null }
    return { scope: binding.scope }
  }

  cancel(sessionId) {
    const sessionController = this.ctx.get('sessionController')
    if (sessionController === undefined) throw new Error('sessionController 服务不可用')
    return sessionController.cancel({ sessionId })
  }

  authUrl() {
    try {
      const connection = this.ctx.get('connection')
      const origin = this.ctx.get('webApp')?.getAdvertisedUrl?.()
      if (origin === undefined || connection?.authenticatedUrl === undefined) return undefined
      return connection.authenticatedUrl(origin)
    } catch {
      return undefined
    }
  }

  /* ---------------- HTTP ---------------- */

  async handle(req, res) {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/excalidraw')) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const route = url.pathname.slice('/excalidraw'.length) || '/'

    if (req.method === 'GET' && route === '/hello') {
      sendJson(res, 200, {
        ok: true,
        name: 'dsh-excalidraw',
        version: '0.1.0',
        port: this.port,
        clients: this.hasFreshClient(),
      })
      return
    }

    if (req.method === 'GET' && route === '/poll') {
      const client = this.touch({
        clientId: url.searchParams.get('clientId') ?? '',
        tabId: url.searchParams.get('tabId') ?? undefined,
      })
      if (client === undefined) {
        sendJson(res, 400, { ok: false, error: 'clientId required' })
        return
      }
      client.polled = true
      const signal = new AbortController()
      res.on('close', () => signal.abort())
      await this.waitOps(client, signal.signal)
      if (res.writableEnded || res.destroyed) return
      sendJson(res, 200, { ok: true, ops: this.takeOps(client), serverTime: Date.now() })
      return
    }

    if (req.method === 'POST' && route === '/result') {
      const body = await readJson(req)
      const ok = this.settleOp(body)
      sendJson(res, 200, { ok: true, settled: ok })
      return
    }

    if (req.method === 'POST' && route === '/hello') {
      const body = await readJson(req)
      const client = this.touch(body)
      sendJson(res, 200, { ok: true, clientId: client?.clientId, port: this.port })
      return
    }

    if (req.method === 'POST' && route === '/start') {
      const body = await readJson(req)
      this.touch(body)
      const result = await this.startSession(body.context ?? {}, body.request ?? {}, body.clientId, {
        openInGui: body.openInGui === true,
        workspaceId: body.workspaceId,
        firstMessage: typeof body.firstMessage === 'string' ? body.firstMessage : undefined,
        contextOnly: body.contextOnly === true,
      })
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (req.method === 'GET' && route === '/workspaces') {
      sendJson(res, 200, { ok: true, workspaces: this.workspaces() })
      return
    }

    if (req.method === 'POST' && route === '/message') {
      const body = await readJson(req)
      const text = String(body.text ?? '').trim()
      if (text === '') throw new Error('message text is empty')
      const result = await this.sendMessage(String(body.sessionId ?? ''), text, body.scope?.ids)
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (req.method === 'GET' && route === '/chat') {
      const sessionId = String(url.searchParams.get('sessionId') ?? '')
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      const verbose = url.searchParams.get('verbose') === '1'
      const signal = new AbortController()
      res.on('close', () => signal.abort())
      const result = await this.chatSince(sessionId, since, signal.signal, verbose)
      if (res.writableEnded || res.destroyed) return
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (req.method === 'POST' && route === '/workspace/create') {
      const body = await readJson(req)
      const result = await this.createWorkspace(body.path)
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (req.method === 'POST' && route === '/open') {
      const body = await readJson(req)
      const result = await this.openInGui(String(body.sessionId ?? ''))
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (req.method === 'POST' && route === '/interrupt') {
      const body = await readJson(req)
      this.cancel(String(body.sessionId ?? ''))
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && route === '/scope') {
      const body = await readJson(req)
      const result = this.setScope(String(body.sessionId ?? ''), body.ids)
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (req.method === 'GET' && route === '/pending') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      const signal = new AbortController()
      res.on('close', () => signal.abort())
      const events = await this.waitPending(since, signal.signal)
      if (res.writableEnded || res.destroyed) return
      sendJson(res, 200, { ok: true, events, cursor: this.pendingSeq })
      return
    }

    if (req.method === 'GET' && route === '/status') {
      sendJson(res, 200, {
        ok: true,
        clients: [...this.clients.values()].map((client) => ({
          clientId: client.clientId,
          url: client.url,
          title: client.title,
          lastSeen: client.lastSeen,
          fresh: Date.now() - client.lastSeen <= CLIENT_STALE_MS,
        })),
        sessions: [...this.sessions.entries()].map(([sessionId, value]) => ({ sessionId, ...value })),
        guiSeen: this.hasGuiClient(),
      })
      return
    }

    sendJson(res, 404, { ok: false, error: `unknown bridge route ${route}` })
  }
}

/* ------------------------------------------------------------------ *
 * Prompt + scope
 * ------------------------------------------------------------------ */

function normalizeScope(context) {
  const selection = context?.selection
  const ids = Array.isArray(selection?.ids) ? selection.ids.filter((id) => typeof id === 'string') : []
  if (ids.length > 0) {
    return {
      kind: 'selection',
      ids,
      bbox: bboxOf((context.elements ?? []).filter((el) => ids.includes(el.id))),
    }
  }
  return { kind: 'all', ids: [], bbox: null }
}

function buildPrompt(context, scope, firstMessage) {
  const hasFirstMessage = typeof firstMessage === 'string' && firstMessage.trim() !== ''
  const elements = Array.isArray(context?.elements) ? context.elements : []
  const selectedIds = new Set(scope.ids)
  const selected = elements.filter((el) => selectedIds.has(el.id) && !el.isDeleted)
  const viewport = context?.viewport ?? {}
  const counts = typeCounts(elements)
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)

  const sceneShown = elements.length <= PROMPT_SCENE_LIMIT ? elements : selected
  const sceneJson = JSON.stringify(
    sceneShown.filter((el) => !el.isDeleted).map(compactElement),
    null,
    0,
  )

  const scopeLine = scope.kind === 'selection'
    ? `用户当前只选中了 ${scope.ids.length} 个元素，所有修改只能落在这些元素上（新增内容也要贴近它们）。`
    : '用户没有选中任何元素，本次范围是整个画板。'

  const selectionText = selected.map((el) => {
    const label = el.type === 'text' ? `文本「${String(el.text ?? '').slice(0, 60)}」` : el.type
    return `- ${el.id} (${label}) x=${Math.round(el.x)}, y=${Math.round(el.y)}, ${Math.round(el.width)}×${Math.round(el.height)}`
  }).join('\n') || '- （无）'

  return [
    hasFirstMessage
      ? '你现在的身份是 Excalidraw 画板助手。用户从画板右下角的小聊天面板发来第一条消息，并附带了画板的当前状态。'
      : '你现在的身份是 Excalidraw 画板助手。用户刚刚在 https://excalidraw.com 上点击了「问 DSH」按钮，把画板的当前状态发给你，并为本次对话建立了 DSH 会话。',
    '',
    '## 画板快照（点击按钮那一刻的状态）',
    `- 页面: ${context?.url ?? 'https://excalidraw.com/'}`,
    context?.title ? `- 标题: ${context.title}` : undefined,
    context?.version ? `- Excalidraw 版本: ${context.version}` : undefined,
    `- 元素总数: ${total}${Object.keys(counts).length === 0 ? '' : `（${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('，')}）`}`,
    `- 可见区域: zoom=${viewport.zoom ?? 1}, scrollX=${Math.round(viewport.scrollX ?? 0)}, scrollY=${Math.round(viewport.scrollY ?? 0)}`,
    `- 画板背景: ${context?.appState?.viewBackgroundColor ?? '#ffffff'}`,
    '',
    '## 本次修改范围',
    scopeLine,
    scope.kind === 'selection' && scope.bbox !== null
      ? `- 范围包围盒: x=${Math.round(scope.bbox.x)}, y=${Math.round(scope.bbox.y)}, ${Math.round(scope.bbox.width)}×${Math.round(scope.bbox.height)}`
      : undefined,
    '### 范围内的元素',
    selectionText,
    '',
    '### 场景元素 JSON（已精简；完整数据请调用 excalidraw_get_scene）',
    '```json',
    sceneJson,
    '```',
    elements.length > PROMPT_SCENE_LIMIT
      ? `（场景较大，上面只列出范围内的元素；共 ${elements.length} 个元素，调用 excalidraw_get_scene 可读取全部。）`
      : undefined,
    '',
    '## 你可以调用的实时画板工具',
    '- `excalidraw_get_scene`：读取画板实时元素、选中项、视口。参数 `scope` = `"selection"`（默认，只读范围内）或 `"all"`。',
    '- `excalidraw_apply`：直接在画板上新增 / 修改 / 删除元素。参数 `ops` 为数组，例如：',
    '  - 新增矩形：`{"op":"add","element":{"type":"rectangle","x":100,"y":100,"width":200,"height":120,"strokeColor":"#1e1e1e"}}`',
    '  - 修改元素：`{"op":"update","id":"<元素id>","patch":{"backgroundColor":"#ffc9c9","fillStyle":"solid"}}`',
    '  - 删除元素：`{"op":"delete","ids":["<元素id>"]}`',
    '  新增元素时 type 可取 rectangle / ellipse / diamond / arrow / line / text / freedraw；文本要带 `text` 与 `fontSize`（建议 20）。坐标是画板坐标（scene 坐标，不是屏幕像素）。',
    '- `excalidraw_screenshot`：把画板（或范围内区域）导出为 PNG 文件并返回路径，你可以用 read_image 查看它来核对视觉效果。',
    '- `excalidraw_select`：在页面上高亮选中指定元素，方便用户确认。',
    '',
    '## 行为要求',
    hasFirstMessage
      ? '1. 先简要说明你看到的画面（1-2 句），然后直接完成用户下面的第一条要求。'
      : '1. 先用 1-2 句中文说明你看到的画面内容（结构、元素、大致布局），让用户确认上下文注入成功。',
    hasFirstMessage
      ? '2. 修改前先调用 excalidraw_screenshot 看一眼现状；修改后再截一次图自查；视觉不对就继续修。'
      : '2. 然后等待用户提出修改要求；在用户开口前不要修改画板。',
    '3. 严格遵守上面的「修改范围」：范围外的元素不要改，除非用户明确要求扩大范围。excalidraw_apply 会拒绝范围外 id 的修改。',
    '4. 用中文回复，简洁直接。',
    hasFirstMessage ? '' : undefined,
    hasFirstMessage ? '## 用户的第一条消息' : undefined,
    hasFirstMessage ? firstMessage : undefined,
  ].filter((line) => line !== undefined).join('\n')
}

/* ------------------------------------------------------------------ *
 * Chat projection (session log -> page chat frames)
 * ------------------------------------------------------------------ */

const INJECTION_PREFIX = '你现在的身份是 Excalidraw 画板助手'

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** Concatenate the text blocks of one message. */
function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Project committed session events after `since` into compact chat frames. */
function chatFrames(events, since, verbose = false) {
  const argsLimit = verbose ? 2000 : 240
  const resultLimit = verbose ? 4000 : 400
  const frames = []
  for (const event of events) {
    if (typeof event?.seq !== 'number' || event.seq <= since) continue
    const data = event.data ?? {}
    const time = typeof event.time === 'number' ? event.time : undefined
    switch (event.type) {
      case 'user/message': {
        const text = messageText(data.message)
        if (text === '') break
        if (text.startsWith(INJECTION_PREFIX)) {
          frames.push({ seq: event.seq, time, role: 'context', text: '已注入画板上下文（快照 + 修改范围）' })
          const marker = '\n## 用户的第一条消息\n'
          const at = text.indexOf(marker)
          if (at !== -1) {
            const userText = text.slice(at + marker.length).trim()
            if (userText !== '') frames.push({ seq: event.seq, time, role: 'user', text: userText })
          }
        } else {
          frames.push({ seq: event.seq, time, role: 'user', text })
        }
        break
      }
      case 'assistant/message': {
        const text = messageText(data.message)
        if (text !== '') frames.push({ seq: event.seq, time, role: 'assistant', text })
        break
      }
      case 'tool/call':
        frames.push({
          seq: event.seq,
          time,
          role: 'tool',
          toolName: String(data.name ?? ''),
          text: truncate(String(data.arguments ?? ''), argsLimit),
        })
        break
      case 'tool/result': {
        const text = messageText(data.message) || String(data.error?.message ?? '')
        frames.push({
          seq: event.seq,
          time,
          role: 'tool-result',
          text: truncate(text, resultLimit),
          isError: data.error !== undefined || data.message?.isError === true,
        })
        break
      }
      case 'turn/end': {
        const reason = data.reason
        if (reason?.kind === 'error') frames.push({ seq: event.seq, time, role: 'error', text: String(reason.error?.message ?? '本轮运行失败') })
        else if (reason?.kind === 'blocked') frames.push({ seq: event.seq, time, role: 'error', text: '本轮被拦截' })
        else frames.push({ seq: event.seq, time, role: 'status', state: 'idle', text: '' })
        break
      }
      case 'turn/start':
        frames.push({ seq: event.seq, time, role: 'status', state: 'running', text: '' })
        break
      default:
        break
    }
  }
  return frames
}

/** Whether the newest turn boundary is a start. */
function isTurnRunning(events) {
  let running = false
  for (const event of events) {
    if (event?.type === 'turn/start') running = true
    else if (event?.type === 'turn/end') running = false
  }
  return running
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJson(req, limit = 16 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/* ------------------------------------------------------------------ *
 * Tools
 *
 * The plugin deliberately imports nothing from shipped `@deepseek-ai/*`
 * packages: an installed bundle resolves bare specifiers from its own real
 * path, which is outside the DSH installation. The local `defineTool` below
 * compiles the same authoring DSL the shipped helper accepts into the raw JSON
 * Schema the Host tool registry expects (`parameters` / `output.schema`).
 * ------------------------------------------------------------------ */

const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])

function compileValueSchema(spec) {
  const node = {}
  if (spec.description !== undefined) node.description = spec.description
  if (spec.type === 'json') {
    // Author-only shorthand: any lossless JSON value.
    node.type = 'object'
    node.additionalProperties = true
    return node
  }
  if (!VALUE_TYPES.has(spec.type)) throw new Error(`unsupported schema type: ${String(spec.type)}`)
  node.type = spec.type
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  if (spec.const !== undefined) node.const = spec.const
  if (spec.type === 'array') node.items = compileValueSchema(spec.items ?? { type: 'object', additionalProperties: true })
  if (spec.type === 'object') {
    const properties = {}
    const required = []
    for (const [key, value] of Object.entries(spec.properties ?? {})) {
      properties[key] = compileValueSchema(value)
      if (value.required === true) required.push(key)
    }
    node.properties = properties
    if (required.length > 0) node.required = required
    node.additionalProperties = spec.additionalProperties ?? false
  }
  if (spec.type !== 'object' && spec.type !== 'array') {
    delete node.properties
  }
  return node
}

function compileParameterMap(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec ?? {})) {
    properties[key] = compileValueSchema(value)
    if (value.required === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: compileParameterMap(options.parameters),
    output: {
      schema: compileValueSchema(options.output.schema),
      render: options.output.render,
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    execute: options.execute,
  }
}

function textRender(fn) {
  return (_args, value) => [{ type: 'text', text: fn(value) }]
}

/**
 * The Host snapshots every tool result as lossless JSON, so drop `undefined`
 * fields and normalize non-finite numbers before returning.
 */
function jsonSafe(value) {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(jsonSafe).filter((item) => item !== undefined)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item)
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

function sessionIdOf(exec) {
  return exec?.agent?.session?.id
}

function toolContext(ctx, bridge, exec) {
  const sessionId = sessionIdOf(exec)
  const binding = sessionId === undefined ? undefined : bridge.sessions.get(sessionId)
  return {
    sessionId,
    binding,
    clientId: binding?.clientId,
    scope: binding?.scope,
  }
}

function assertInScope(toolCtx, ids) {
  const scope = toolCtx.scope
  if (scope === undefined || scope.kind !== 'selection') return
  const allowed = new Set(scope.ids)
  const outside = ids.filter((id) => !allowed.has(id))
  if (outside.length > 0) {
    throw new Error(`修改范围之外的元素被拒绝：${outside.join(', ')}。当前范围只有 ${[...allowed].length} 个元素（${[...allowed].join(', ')}）。如果用户明确要求修改范围外元素，请在调用时设置 scope:"all"。`)
  }
}

function excalidrawTools(ctx, bridge) {
  const getScene = defineTool({
    name: 'excalidraw_get_scene',
    description: 'Read the live Excalidraw board the user is drawing on: elements (with ids, geometry and styles), current selection, viewport and background. Use it whenever you need the current state instead of relying on the snapshot from when the conversation started. `scope:"selection"` (default) returns only the elements inside the current modification scope; `scope:"all"` returns every element.',
    parameters: {
      scope: { type: 'string', description: '"selection" (default) or "all"' },
      includeDeleted: { type: 'boolean', description: 'Include soft-deleted elements (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          selectedIds: { type: 'array', items: { type: 'string' }, required: true },
          elementCount: { type: 'number', required: true },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          viewport: { type: 'object', additionalProperties: true, required: true },
          appState: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: textRender((value) => `画板共 ${value.elementCount} 个元素（范围 ${value.scope}，选中 ${value.selectedIds.length} 个）。\n${JSON.stringify(value.elements, null, 1)}`),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const toolCtx = toolContext(ctx, bridge, exec)
      const fetched = await bridge.requestOp(toolCtx.clientId, 'scene.get', {
        includeDeleted: args.includeDeleted === true,
      })
      const all = Array.isArray(fetched.elements) ? fetched.elements : []
      const selectedIds = Array.isArray(fetched.selectedIds) ? fetched.selectedIds : []
      let elements = all
      if ((args.scope ?? 'selection') === 'selection') {
        const ids = toolCtx.scope?.kind === 'selection' ? toolCtx.scope.ids : selectedIds
        const wanted = new Set(ids)
        elements = all.filter((el) => wanted.has(el.id))
      }
      return jsonSafe({
        scope: args.scope ?? 'selection',
        selectedIds,
        elementCount: elements.length,
        elements: elements.map(compactElement),
        viewport: fetched.viewport ?? {},
        appState: {
          viewBackgroundColor: fetched.appState?.viewBackgroundColor,
          theme: fetched.appState?.theme,
          zoom: fetched.appState?.zoom,
        },
      })
    },
  })

  const apply = defineTool({
    name: 'excalidraw_apply',
    description: 'Apply element operations directly to the live Excalidraw board (add rectangle/ellipse/diamond/arrow/line/text, update geometry/style/text of an existing element, or delete elements). Coordinates are scene coordinates. By default operations on elements outside the user\'s current modification scope are rejected; pass scope:"all" only when the user explicitly asked to change something outside the selection.',
    parameters: {
      ops: {
        type: 'array',
        required: true,
        description: 'Operations: {op:"add",element:{type,x,y,width,height,...}} | {op:"update",id,patch:{...}} | {op:"delete",ids:[...]}',
        items: { type: 'object', additionalProperties: true },
      },
      scope: { type: 'string', description: '"selection" (default) or "all"' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'number', required: true },
          affectedIds: { type: 'array', items: { type: 'string' }, required: true },
          errors: { type: 'array', items: { type: 'string' }, required: true },
          elementCount: { type: 'number', required: true },
        },
      },
      render: textRender((value) => `已应用 ${value.applied} 个操作（影响 ${value.affectedIds.length} 个元素）。${value.errors.length > 0 ? `\n警告: ${value.errors.join('; ')}` : ''}`),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const toolCtx = toolContext(ctx, bridge, exec)
      const ops = Array.isArray(args.ops) ? args.ops : []
      if (ops.length === 0) throw new Error('ops 不能为空')
      if ((args.scope ?? 'selection') !== 'all') {
        const touched = []
        for (const op of ops) {
          if (op?.op === 'update' && typeof op.id === 'string') touched.push(op.id)
          if (op?.op === 'delete' && Array.isArray(op.ids)) touched.push(...op.ids.filter((id) => typeof id === 'string'))
        }
        assertInScope(toolCtx, touched)
      }
      const value = await bridge.requestOp(toolCtx.clientId, 'scene.apply', { ops }, 30_000)
      return jsonSafe({
        applied: Number(value?.applied ?? 0),
        affectedIds: Array.isArray(value?.affectedIds) ? value.affectedIds : [],
        errors: Array.isArray(value?.errors) ? value.errors.map(String) : [],
        elementCount: Number(value?.elementCount ?? 0),
      })
    },
  })

  const screenshot = defineTool({
    name: 'excalidraw_screenshot',
    description: 'Render the current Excalidraw board (or the selected region) to a PNG file and return its workspace path. Follow with read_image on that path to actually look at the drawing. Use it before and after visual changes.',
    parameters: {
      scope: { type: 'string', description: '"selection" (default, crops to the selected elements) or "viewport" (whole visible canvas)' },
      padding: { type: 'number', description: 'Extra scene-space padding around the crop (default 40).' },
      background: { type: 'string', description: 'Background color for the PNG (default "#ffffff").' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          scope: { type: 'string', required: true },
        },
      },
      render: textRender((value) => `已导出 PNG: ${value.path} (${value.width}×${value.height})。用 read_image 打开它查看。`),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const toolCtx = toolContext(ctx, bridge, exec)
      const shot = await bridge.requestOp(toolCtx.clientId, 'scene.png', {
        scope: args.scope ?? (toolCtx.scope?.kind === 'selection' ? 'selection' : 'viewport'),
        ids: toolCtx.scope?.kind === 'selection' ? toolCtx.scope.ids : undefined,
        padding: args.padding ?? 40,
        background: args.background ?? '#ffffff',
      }, 30_000)
      if (typeof shot?.dataUrl !== 'string' || !shot.dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error('页面没有返回有效的 PNG 数据')
      }
      const cwd = ctx.get('workingDirectory')?.get(exec.agent.session) ?? process.cwd()
      const dir = join(cwd, '.dsh-excalidraw', 'snapshots')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `board-${Date.now()}.png`)
      await writeFile(file, Buffer.from(shot.dataUrl.slice('data:image/png;base64,'.length), 'base64'))
      return { path: file, width: Number(shot.width ?? 0), height: Number(shot.height ?? 0), scope: args.scope ?? 'selection' }
    },
  })

  const select = defineTool({
    name: 'excalidraw_select',
    description: 'Select (highlight) elements on the user\'s Excalidraw board so the user can see exactly what you are about to change. Pass an empty ids array to clear the selection.',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Element ids to select.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selectedIds: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: textRender((value) => `已在画板上选中 ${value.selectedIds.length} 个元素。`),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const toolCtx = toolContext(ctx, bridge, exec)
      const value = await bridge.requestOp(toolCtx.clientId, 'selection.set', {
        ids: Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === 'string') : [],
      }, 10_000)
      return jsonSafe({ selectedIds: Array.isArray(value?.selectedIds) ? value.selectedIds : [] })
    },
  })

  const status = defineTool({
    name: 'excalidraw_status',
    description: 'Check whether the Excalidraw bridge is connected and report the current modification scope, page and element count. Cheap; use it if a board operation failed and you need to know the bridge state.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true },
          page: { type: 'object', additionalProperties: true, required: true },
          scope: { type: 'object', additionalProperties: true, required: true },
          elementCount: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value.connected
        ? `画板已连接（${value.page?.url ?? '未知页面'}，${value.elementCount} 个元素，范围=${value.scope?.kind}）。`
        : `画板未连接：${value.error ?? '没有打开的 excalidraw.com 页面'}`),
    },
    async execute(_args, exec) {
      const toolCtx = toolContext(ctx, bridge, exec)
      if (bridge.pickClient(toolCtx.clientId) === undefined) {
        return jsonSafe({ connected: false, page: {}, scope: toolCtx.scope ?? { kind: 'all', ids: [] }, elementCount: 0, error: '没有已连接的 Excalidraw 标签页' })
      }
      try {
        const value = await bridge.requestOp(toolCtx.clientId, 'page.status', {}, 5_000)
        return jsonSafe({
          connected: true,
          page: { url: value?.url, title: value?.title, version: value?.version },
          scope: toolCtx.scope ?? { kind: 'all', ids: [] },
          elementCount: Number(value?.elementCount ?? 0),
        })
      } catch (error) {
        return jsonSafe({ connected: false, page: {}, scope: toolCtx.scope ?? { kind: 'all', ids: [] }, elementCount: 0, error: String(error?.message ?? error) })
      }
    },
  })

  return { getScene, apply, screenshot, select, status }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const bridge = new Bridge(ctx)
  ctx.effect(() => bridge.start().then((dispose) => {
    try {
      ctx.logger?.('dsh-excalidraw')?.info?.(`bridge listening on http://127.0.0.1:${bridge.port}`)
    } catch { /* logging is best effort */ }
    return dispose
  }), 'excalidraw: bridge server')

  // The Client half long-polls `/excalidraw/pending` on the DSH Web origin, so
  // the same routes are also mounted on the Host web server. `ctx.inject` waits
  // for the optional service instead of silently skipping when it is not ready.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/excalidraw',
      handler: (req, res) => bridge.handle(req, res),
    }), 'excalidraw: gui routes')
  })

  const tools = excalidrawTools(ctx, bridge)
  for (const tool of Object.values(tools)) {
    ctx.effect(() => ctx.tools.register(tool), `excalidraw: tool ${tool.name}`)
  }
}
