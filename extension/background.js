/**
 * DSH x Excalidraw - background service worker.
 *
 * Owns the connection to the local DSH bridge:
 *  - discovers the bridge port,
 *  - long-polls page operations for every open excalidraw.com tab and relays
 *    them to that tab's content script,
 *  - posts results back,
 *  - forwards the "start a DSH session" request and opens the DSH GUI when no
 *    already-open DSH client could take the session.
 */

const PORTS = Array.from({ length: 20 }, (_, index) => 46231 + index)
  .concat(Array.from({ length: 10 }, (_, index) => 47321 + index))
const POLL_TIMEOUT = 30_000
const OP_TIMEOUT = 35_000

/** @type {number | null} */
let bridgePort = null
/** @type {Map<number, {clientId: string, running: boolean}>} tabId -> poller state */
const pollers = new Map()
let installId = null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getInstallId() {
  if (installId !== null) return installId
  const stored = await chrome.storage.local.get('installId')
  installId = typeof stored.installId === 'string' && stored.installId.length > 0
    ? stored.installId
    : `dsh-${crypto.randomUUID()}`
  await chrome.storage.local.set({ installId })
  return installId
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function discoverPort(force = false) {
  if (bridgePort !== null && !force) return bridgePort
  for (const port of PORTS) {
    try {
      const hello = await fetchJson(`http://127.0.0.1:${port}/excalidraw/hello`, undefined, 800)
      if (hello?.ok === true && hello?.name === 'dsh-excalidraw') {
        bridgePort = port
        return port
      }
    } catch { /* try the next candidate */ }
  }
  bridgePort = null
  return null
}

async function bridgeUrl(path) {
  const port = await discoverPort()
  if (port === null) {
    throw new Error('没找到 DSH 画板桥接服务：请确认 DSH 正在运行，并且已安装 Excalidraw Bridge 插件')
  }
  return `http://127.0.0.1:${port}/excalidraw${path}`
}

async function clientIdFor(tabId) {
  const id = await getInstallId()
  return `${id}:${tabId}`
}

/* ---------------------------------------------------------------- *
 * Polling + operation dispatch
 * ---------------------------------------------------------------- */

function stopPolling(tabId) {
  const state = pollers.get(tabId)
  if (state !== undefined) {
    state.running = false
    pollers.delete(tabId)
  }
}

function startPolling(tabId) {
  if (pollers.has(tabId)) return
  const state = { clientId: `${installId ?? 'pending'}:${tabId}`, running: true }
  pollers.set(tabId, state)
  runPoller(tabId, state).catch(() => stopPolling(tabId))
}

async function runPoller(tabId, state) {
  state.clientId = await clientIdFor(tabId)
  while (state.running) {
    try {
      const url = await bridgeUrl(`/poll?clientId=${encodeURIComponent(state.clientId)}&tabId=${tabId}`)
      const payload = await fetchJson(url, undefined, POLL_TIMEOUT + 5_000)
      for (const op of payload?.ops ?? []) {
        if (!state.running) break
        const result = op.type === 'scene.png'
          ? await runOpInForeground(tabId, op)
          : await runPageOp(tabId, op)
        try {
          await fetchJson(await bridgeUrl('/result'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: state.clientId, id: op.id, ok: result.ok, value: result.value, error: result.error }),
          }, 8_000)
        } catch { /* result delivery is best effort; the host times the op out */ }
      }
    } catch {
      if (!state.running) return
      await sleep(1_500)
      // A restarted DSH host may listen on a different loopback port.
      await discoverPort(true)
    }
  }
}

async function runPageOp(tabId, op) {
  let timer
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { kind: 'dsh-exc-op', op }),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: '页面响应超时' }), OP_TIMEOUT) }),
    ])
    if (response === undefined || response === null) return { ok: false, error: '页面没有返回结果' }
    return response
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Chrome does not paint hidden tabs, so a PNG capture of a background
 * excalidraw tab would be stale. Briefly bring the tab forward, capture, then
 * hand focus back to the tab the user was on.
 */
async function runOpInForeground(tabId, op) {
  let previousActive
  let switched = false
  try {
    const tab = await chrome.tabs.get(tabId)
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
    if (active !== undefined && active.id !== tabId) {
      previousActive = active
      await chrome.tabs.update(tabId, { active: true })
      switched = true
      await sleep(300)
    }
    return await runPageOp(tabId, op)
  } catch {
    return runPageOp(tabId, op)
  } finally {
    if (switched && previousActive?.id !== undefined) {
      try { await chrome.tabs.update(previousActive.id, { active: true }) } catch { /* tab may be gone */ }
    }
  }
}

/* ---------------------------------------------------------------- *
 * Message router (content script)
 * ---------------------------------------------------------------- */

async function handleMessage(message, sender) {
  const tabId = sender?.tab?.id
  switch (message?.kind) {
    case 'register': {
      if (tabId === undefined) return { ok: false, error: 'no tab' }
      await getInstallId()
      startPolling(tabId)
      return { ok: true, polling: true }
    }
    case 'keepalive': {
      if (tabId !== undefined && !pollers.has(tabId)) startPolling(tabId)
      return { ok: true }
    }
    case 'status': {
      const port = await discoverPort()
      return { ok: true, connected: port !== null, port }
    }
    case 'start': {
      const clientId = tabId === undefined ? await getInstallId() : await clientIdFor(tabId)
      const url = await bridgeUrl('/start')
      const result = await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId,
          tabId,
          // The page chat panel is the primary surface: DSH stays in the
          // background unless the user explicitly asks to open it.
          openInGui: message.openInGui === true,
          workspaceId: message.workspaceId ?? undefined,
          firstMessage: typeof message.firstMessage === 'string' ? message.firstMessage : undefined,
          context: message.context ?? {},
          request: message.request ?? {},
        }),
      }, 40_000)
      const openHere = message.openInGui === true && result?.openedInClient !== true && typeof result.authUrl === 'string'
      if (openHere) {
        try { await chrome.tabs.create({ url: result.authUrl, active: true }) } catch { /* best effort */ }
      }
      return { ok: true, ...result, openedTab: openHere }
    }
    case 'workspaces': {
      const url = await bridgeUrl('/workspaces')
      const result = await fetchJson(url, undefined, 8_000)
      return { ok: true, ...result }
    }
    case 'prefs': {
      const stored = await chrome.storage.local.get('workspaceId')
      return { ok: true, workspaceId: typeof stored.workspaceId === 'string' ? stored.workspaceId : null }
    }
    case 'setPrefs': {
      if (typeof message.workspaceId === 'string') await chrome.storage.local.set({ workspaceId: message.workspaceId })
      else if (message.workspaceId === null) await chrome.storage.local.remove('workspaceId')
      return { ok: true }
    }
    case 'message': {
      const url = await bridgeUrl('/message')
      const result = await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: message.sessionId, text: message.text }),
      }, 20_000)
      return { ok: true, ...result }
    }
    case 'chat': {
      const query = new URLSearchParams({
        sessionId: String(message.sessionId),
        since: String(message.since ?? 0),
        verbose: message.verbose === true ? '1' : '0',
      })
      const url = await bridgeUrl(`/chat?${query.toString()}`)
      const result = await fetchJson(url, undefined, 30_000)
      return { ok: true, ...result }
    }
    case 'workspaceCreate': {
      const url = await bridgeUrl('/workspace/create')
      const result = await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: message.path }),
      }, 15_000)
      return { ok: true, ...result }
    }
    case 'open': {
      const url = await bridgeUrl('/open')
      const result = await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: message.sessionId }),
      }, 15_000)
      if (result?.opened !== true && typeof result.authUrl === 'string') {
        try { await chrome.tabs.create({ url: result.authUrl, active: true }) } catch { /* best effort */ }
        return { ok: true, ...result, openedTab: true }
      }
      return { ok: true, ...result, openedTab: false }
    }
    case 'interrupt': {
      const url = await bridgeUrl('/interrupt')
      await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: message.sessionId }),
      }, 10_000)
      return { ok: true }
    }
    case 'scope': {
      const url = await bridgeUrl('/scope')
      const result = await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: message.sessionId, ids: message.ids ?? [] }),
      }, 10_000)
      return { ok: true, ...result }
    }
    default:
      return { ok: false, error: `unknown message kind ${String(message?.kind)}` }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((value) => sendResponse(value))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }))
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => stopPolling(tabId))
chrome.runtime.onStartup.addListener(() => { discoverPort(true).catch(() => {}) })
chrome.runtime.onInstalled.addListener(() => { discoverPort(true).catch(() => {}) })
