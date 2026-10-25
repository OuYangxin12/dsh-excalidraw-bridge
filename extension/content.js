/**
 * DSH × Excalidraw — isolated content script.
 *
 * Adds a compact chat panel to excalidraw.com so the whole conversation happens
 * on the canvas page while DSH stays silent in the background. The DSH window is
 * opened only when the user asks for it from the panel.
 *
 * Responsibilities:
 *  - render the floating launcher + chat panel (shadow DOM, no page CSS bleed),
 *  - collect the board snapshot when a session starts,
 *  - relay page operations between the background worker and the MAIN-world
 *    page script,
 *  - poll chat frames and stream them into the panel.
 */

const HOST_ID = 'dsh-excalidraw-host'
const REQUEST_TIMEOUT = 30_000
const SESSION_KEY = 'dsh-exc:session'
const MAX_BUBBLES = 200

let sequence = 0
const pending = new Map()

/* ---------------------------------------------------------------- *
 * Page bridge (MAIN world)
 * ---------------------------------------------------------------- */

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data
  if (data === null || typeof data !== 'object' || data.__dshExc !== 'res') return
  const entry = pending.get(data.id)
  if (entry === undefined) return
  pending.delete(data.id)
  if (data.ok === true) entry.resolve(data.value)
  else entry.reject(new Error(typeof data.value === 'string' ? data.value : '页面操作失败'))
})

function pageRequest(type, payload, timeoutMs = REQUEST_TIMEOUT) {
  const id = `dsh-${Date.now()}-${++sequence}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('画板页面没有响应（可能还在加载）'))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    window.postMessage({ __dshExc: 'req', id, type, payload }, '*')
  })
}

/* ---------------------------------------------------------------- *
 * Background bridge
 * ---------------------------------------------------------------- */

async function sendBackground(message) {
  try {
    const response = await chrome.runtime.sendMessage(message)
    if (response === undefined || response === null) throw new Error('扩展后台没有响应')
    return response
  } catch (error) {
    throw new Error(`扩展后台不可用：${String(error?.message ?? error)}`)
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind !== 'dsh-exc-op') return undefined
  const op = message.op
  pageRequest(op.type, op.payload, 30_000)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }))
  return true
})

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Tiny markdown: escapes everything, then bold + inline code. */
function formatText(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
}

/* ---------------------------------------------------------------- *
 * Chat panel
 * ---------------------------------------------------------------- */

function createUi() {
  if (document.getElementById(HOST_ID) !== null) return
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'all: initial; position: fixed; right: 18px; bottom: 118px; z-index: 2147483000;'
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
      .launcher {
        display: flex; align-items: center; gap: 8px;
        padding: 9px 14px; border-radius: 999px; cursor: pointer; user-select: none;
        color: #fff; font-size: 13px; font-weight: 600; line-height: 1;
        background: linear-gradient(135deg, #3b6ef6 0%, #7a4bff 100%);
        box-shadow: 0 6px 20px rgba(43, 76, 196, .35), 0 1px 0 rgba(255,255,255,.25) inset;
        border: 1px solid rgba(255,255,255,.18);
        transition: transform .12s ease, box-shadow .12s ease;
      }
      .launcher:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(43,76,196,.45); }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 0 2px rgba(74,222,128,.25); }
      .dot[data-busy="1"] { background: #fbbf24; box-shadow: 0 0 0 2px rgba(251,191,36,.25); }
      .launcher[hidden], .panel[hidden] { display: none; }

      .panel {
        width: 360px; max-width: calc(100vw - 32px); height: 480px; max-height: calc(100vh - 140px);
        display: flex; flex-direction: column; overflow: hidden;
        background: rgba(23, 26, 33, .97); color: #e5e7eb;
        border: 1px solid rgba(255,255,255,.12); border-radius: 16px;
        box-shadow: 0 18px 50px rgba(0,0,0,.45); backdrop-filter: blur(10px);
        font-size: 13px; line-height: 1.45;
      }
      .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.09); }
      .title { font-weight: 700; font-size: 13px; letter-spacing: .2px; }
      .scope {
        margin-left: auto; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        padding: 3px 8px; border-radius: 999px; cursor: pointer; font-size: 11px;
        color: #c7d2fe; background: rgba(99,102,241,.18); border: 1px solid rgba(129,140,248,.35);
      }
      .iconbtn {
        width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer;
        border-radius: 7px; color: #cbd5e1; background: transparent; border: 1px solid transparent;
        font-size: 13px; line-height: 1;
      }
      .iconbtn:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.1); }

      .meta {
        display: flex; align-items: center; gap: 6px; padding: 6px 12px 8px;
        font-size: 11.5px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,.06);
      }
      .meta select {
        max-width: 190px; flex: 1; min-width: 0; padding: 3px 6px; border-radius: 7px; font: inherit;
        color: #e5e7eb; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.13); outline: none;
      }
      .meta select:disabled { opacity: .75; }
      .metatext { color: #c7d2fe; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .metahint { margin-left: auto; opacity: .8; white-space: nowrap; }

      .wsnew { display: flex; gap: 6px; padding: 0 12px 8px; align-items: center; }
      .wsnew[hidden] { display: none; }
      .wsnew input {
        flex: 1; min-width: 0; padding: 5px 8px; border-radius: 7px; font: inherit; font-size: 11.5px;
        color: #e5e7eb; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.15); outline: none;
      }
      .wsnew input:focus { border-color: rgba(129,140,248,.6); }
      .wsnew button {
        padding: 4px 8px; border-radius: 7px; cursor: pointer; font-size: 11.5px; color: #e5e7eb;
        background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14);
      }
      .wsnew .wsok { color: #bbf7d0; border-color: rgba(74,222,128,.35); background: rgba(74,222,128,.12); }

      .info { display: none; gap: 8px; align-items: center; padding: 6px 12px; font-size: 11px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,.06); flex-wrap: wrap; }
      .info[data-visible="1"] { display: flex; }
      .info .chip { padding: 2px 7px; border-radius: 999px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); }
      .info .copy { cursor: pointer; color: #c7d2fe; }
      .info .copy:hover { text-decoration: underline; }

      .panel.expanded {
        position: fixed; top: 0; right: 0; bottom: 0; width: 560px; max-width: 100vw;
        height: 100vh; max-height: 100vh; border-radius: 0; border-top: none; border-right: none; border-bottom: none;
      }
      .panel.expanded .messages { padding: 16px 18px; gap: 10px; }
      .panel.expanded .bubble { max-width: 92%; font-size: 13.5px; }
      .panel.expanded .tool-result { max-width: 100%; }
      .panel.expanded .tool, .panel.expanded .tool-result { font-size: 12px; }
      .time { margin-left: 6px; color: #64748b; font-size: 10px; }

      .messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; scrollbar-width: thin; }
      .row { display: flex; align-items: flex-end; gap: 4px; }
      .row.user { justify-content: flex-end; }
      .bubble { max-width: 86%; padding: 8px 10px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
      .user .bubble { background: linear-gradient(135deg, #3b6ef6, #6b4bff); color: #fff; border-bottom-right-radius: 4px; }
      .assistant .bubble { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.08); border-bottom-left-radius: 4px; }
      .bubble code { background: rgba(0,0,0,.35); padding: 1px 4px; border-radius: 4px; font-size: 12px; }
      .context, .system { align-self: center; color: #94a3b8; font-size: 11.5px; text-align: center; padding: 2px 6px; }
      .tool { align-self: flex-start; color: #93c5fd; font-size: 11.5px; font-family: ui-monospace, Consolas, monospace; }
      .tool-result { align-self: flex-start; color: #94a3b8; font-size: 11px; font-family: ui-monospace, Consolas, monospace; white-space: pre-wrap; max-width: 92%; }
      .tool-result[data-error="1"] { color: #fca5a5; }
      .errorbox { align-self: stretch; color: #fecaca; background: rgba(220,38,38,.14); border: 1px solid rgba(248,113,113,.3); border-radius: 10px; padding: 8px 10px; font-size: 12px; }
      .empty { color: #94a3b8; font-size: 12px; text-align: center; padding: 18px 8px; }

      .statusbar { display: none; align-items: center; gap: 8px; padding: 6px 12px; font-size: 11.5px; color: #fbbf24; border-top: 1px solid rgba(255,255,255,.06); }
      .statusbar[data-visible="1"] { display: flex; }
      .spinner { width: 10px; height: 10px; border-radius: 50%; border: 2px solid rgba(251,191,36,.3); border-top-color: #fbbf24; animation: spin .8s linear infinite; }
      .stop {
        margin-left: auto; cursor: pointer; color: #fca5a5; background: rgba(248,113,113,.12);
        border: 1px solid rgba(248,113,113,.3); border-radius: 7px; padding: 2px 8px; font-size: 11px;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      .composer { display: flex; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid rgba(255,255,255,.09); }
      textarea {
        flex: 1; resize: none; height: 44px; max-height: 120px; padding: 8px 10px; border-radius: 10px;
        background: rgba(255,255,255,.06); color: #e5e7eb; border: 1px solid rgba(255,255,255,.12);
        font: inherit; outline: none;
      }
      textarea:focus { border-color: rgba(129,140,248,.6); }
      .send {
        align-self: flex-end; height: 34px; padding: 0 14px; border-radius: 9px; cursor: pointer;
        color: #fff; font-weight: 600; border: none; background: linear-gradient(135deg, #3b6ef6, #6b4bff);
      }
      .send[disabled] { opacity: .5; cursor: default; }
    </style>
    <div class="wrap">
      <div class="launcher" role="button" tabindex="0">
        <span class="dot"></span>
        <span>DSH 画板助手</span>
      </div>
      <div class="panel" hidden>
        <div class="head">
          <span class="title">画板助手</span>
          <span class="scope" title="点击：用当前选中的元素更新修改范围">范围：整块画板</span>
          <button class="iconbtn expand" title="展开为侧边栏">⤢</button>
          <button class="iconbtn open" title="在 DSH 中打开这个会话">↗</button>
          <button class="iconbtn reset" title="开始新会话">⟳</button>
          <button class="iconbtn close" title="收起">✕</button>
        </div>
        <div class="meta">
          <span>工作区</span>
          <select class="workspace" title="新会话所在工作区（仅创建会话时生效）"></select>
          <span class="metatext" hidden></span>
          <span class="metahint">首次发送后才创建会话</span>
        </div>
        <div class="wsnew" hidden>
          <input class="wspath" placeholder="输入目录路径，例如 G:\proj\my-project" />
          <button class="wsok">添加</button>
          <button class="wscancel">取消</button>
        </div>
        <div class="info" data-visible="0"></div>
        <div class="messages"></div>
        <div class="statusbar"><span class="spinner"></span><span class="statustext">正在思考…</span><span class="stop">停止</span></div>
        <div class="composer">
          <textarea placeholder="想让 DSH 改什么？Enter 发送，Shift+Enter 换行"></textarea>
          <button class="send">发送</button>
        </div>
      </div>
    </div>
  `
  document.documentElement.appendChild(host)

  const el = {
    launcher: shadow.querySelector('.launcher'),
    dot: shadow.querySelector('.dot'),
    panel: shadow.querySelector('.panel'),
    scope: shadow.querySelector('.scope'),
    open: shadow.querySelector('.open'),
    reset: shadow.querySelector('.reset'),
    close: shadow.querySelector('.close'),
    messages: shadow.querySelector('.messages'),
    statusbar: shadow.querySelector('.statusbar'),
    statusText: shadow.querySelector('.statustext'),
    stop: shadow.querySelector('.stop'),
    textarea: shadow.querySelector('textarea'),
    send: shadow.querySelector('.send'),
    workspace: shadow.querySelector('.workspace'),
    metaText: shadow.querySelector('.metatext'),
    metaHint: shadow.querySelector('.metahint'),
    expand: shadow.querySelector('.expand'),
    wsNew: shadow.querySelector('.wsnew'),
    wsPath: shadow.querySelector('.wspath'),
    wsOk: shadow.querySelector('.wsok'),
    wsCancel: shadow.querySelector('.wscancel'),
    info: shadow.querySelector('.info'),
  }

  const state = {
    sessionId: (() => {
      try { return sessionStorage.getItem(SESSION_KEY) } catch { return null }
    })(),
    lastSeq: 0,
    busy: false,
    panelOpen: false,
    polling: false,
    creating: false,
    pendingSends: [],
    scopeIds: [],
    workspaces: [],
    workspaceId: null,
    workspaceLabel: (() => {
      try { return sessionStorage.getItem('dsh-exc:workspace') ?? '' } catch { return '' }
    })(),
    pendingUserEcho: null,
    expanded: (() => {
      try { return sessionStorage.getItem('dsh-exc:expanded') === '1' } catch { return false }
    })(),
    elementCount: 0,
    toolCalls: 0,
  }

  /* ------------------------- rendering ------------------------- */

  let bubbleCount = 0
  function pushNode(node) {
    el.messages.appendChild(node)
    bubbleCount += 1
    while (bubbleCount > MAX_BUBBLES) {
      const first = el.messages.firstElementChild
      if (first === null) break
      first.remove()
      bubbleCount -= 1
    }
    el.messages.scrollTop = el.messages.scrollHeight
  }

  function timeLabel(ts) {
    if (typeof ts !== 'number') return ''
    try {
      return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }

  function appendTime(row, ts) {
    if (!state.expanded) return
    const label = timeLabel(ts)
    if (label === '') return
    const span = document.createElement('span')
    span.className = 'time'
    span.textContent = label
    row.appendChild(span)
  }

  function addUser(text, ts) {
    const row = document.createElement('div')
    row.className = 'row user'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = text
    row.appendChild(bubble)
    appendTime(row, ts)
    pushNode(row)
  }

  function addAssistant(text, ts) {
    const row = document.createElement('div')
    row.className = 'row assistant'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.innerHTML = formatText(text)
    row.appendChild(bubble)
    appendTime(row, ts)
    pushNode(row)
  }

  function addSystem(text) {
    const node = document.createElement('div')
    node.className = 'system'
    node.textContent = text
    pushNode(node)
  }

  function addContext(text) {
    const node = document.createElement('div')
    node.className = 'context'
    node.textContent = text
    pushNode(node)
  }

  function addTool(name, args) {
    const node = document.createElement('div')
    node.className = 'tool'
    node.textContent = `🔧 ${name}${args ? ` ${String(args).slice(0, 120)}` : ''}`
    pushNode(node)
  }

  function addToolResult(text, isError) {
    const node = document.createElement('div')
    node.className = 'tool-result'
    if (isError) node.dataset.error = '1'
    node.textContent = text
    pushNode(node)
  }

  function addError(text) {
    const node = document.createElement('div')
    node.className = 'errorbox'
    node.textContent = text
    pushNode(node)
  }

  function clearMessages() {
    el.messages.replaceChildren()
    bubbleCount = 0
  }

  function renderFrame(frame) {
    switch (frame.role) {
      case 'user':
        if (state.pendingUserEcho === frame.text) {
          // Already rendered optimistically when the message was sent.
          state.pendingUserEcho = null
          break
        }
        addUser(frame.text, frame.time)
        break
      case 'assistant': addAssistant(frame.text, frame.time); break
      case 'context': addContext(frame.text); break
      case 'tool':
        state.toolCalls += 1
        addTool(frame.toolName, frame.text)
        break
      case 'tool-result': addToolResult(frame.text, frame.isError === true); break
      case 'error': addError(frame.text); break
      case 'status': break
      default: break
    }
    updateInfo()
  }

  function addInfoChip(text, className) {
    const chip = document.createElement('span')
    chip.className = className ? `chip ${className}` : 'chip'
    chip.textContent = text
    el.info.appendChild(chip)
    return chip
  }

  function updateInfo() {
    if (el.info === null) return
    el.info.dataset.visible = state.expanded && state.panelOpen ? '1' : '0'
    el.info.replaceChildren()
    const session = state.sessionId === null ? '会话未创建' : `会话 ${state.sessionId.slice(0, 16)}…`
    const sessionChip = addInfoChip(session, state.sessionId === null ? '' : 'copy')
    if (state.sessionId !== null) sessionChip.title = '点击复制完整会话 ID'
    addInfoChip(state.workspaceLabel !== '' ? `工作区 ${state.workspaceLabel}` : '工作区 默认')
    addInfoChip(`范围 ${state.scopeIds.length > 0 ? `${state.scopeIds.length} 个元素` : '整块画板'}`)
    addInfoChip(`画板 ${state.elementCount} 个元素`)
    addInfoChip(`工具调用 ${state.toolCalls}`)
    if (state.sessionId !== null) {
      const copy = addInfoChip(`复制 ID`)
      copy.style.cursor = 'pointer'
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(state.sessionId)
          copy.textContent = '已复制 ✓'
          setTimeout(() => { copy.textContent = '复制 ID' }, 1500)
        } catch {
          addSystem(state.sessionId)
        }
      })
    }
  }

  function applyExpanded(value) {
    state.expanded = value === true
    el.panel.classList.toggle('expanded', state.expanded)
    el.expand.textContent = state.expanded ? '⤡' : '⤢'
    el.expand.title = state.expanded ? '收起为小窗' : '展开为侧边栏'
    try { sessionStorage.setItem('dsh-exc:expanded', state.expanded ? '1' : '0') } catch { /* best effort */ }
    updateInfo()
  }

  function setBusy(busy) {
    state.busy = busy
    el.dot.dataset.busy = busy ? '1' : '0'
    el.statusbar.dataset.visible = busy ? '1' : '0'
    el.statusText.textContent = busy ? '正在思考…（可继续输入，会排在下一轮）' : '空闲'
  }

  function setScopeLabel(kind, count) {
    el.scope.textContent = kind === 'selection' ? `范围：选中 ${count} 个` : '范围：整块画板'
  }

  async function refreshScope() {
    try {
      const scope = await pageRequest('scene.scope', {}, 8_000)
      // The click on our own UI may have cleared Excalidraw's selection; fall
      // back to the selection captured just before that click.
      const current = Array.isArray(scope.ids) ? scope.ids : []
      const captured = scope.lastPointer && Array.isArray(scope.lastPointer.ids) ? scope.lastPointer.ids : []
      state.scopeIds = current.length > 0 ? current : captured
      state.elementCount = typeof scope.elementCount === 'number' ? scope.elementCount : 0
      setScopeLabel(state.scopeIds.length > 0 ? 'selection' : 'all', state.scopeIds.length)
      updateInfo()
      return { ...scope, ids: state.scopeIds }
    } catch {
      return undefined
    }
  }

  /* ------------------------- session lifecycle ------------------------- */

  function storeSession(sessionId) {
    state.sessionId = sessionId
    try {
      if (sessionId === null) {
        sessionStorage.removeItem(SESSION_KEY)
        sessionStorage.removeItem('dsh-exc:workspace')
      } else {
        sessionStorage.setItem(SESSION_KEY, sessionId)
        sessionStorage.setItem('dsh-exc:workspace', state.workspaceLabel ?? '')
      }
    } catch { /* storage is best effort */ }
    updateMeta()
  }

  function resetSession(message) {
    storeSession(null)
    state.lastSeq = 0
    state.workspaceLabel = ''
    state.toolCalls = 0
    setBusy(false)
    clearMessages()
    updateMeta()
    if (message) addSystem(message)
  }

  /* ------------------------- workspace picker ------------------------- */

  function updateMeta() {
    const active = state.sessionId !== null
    el.workspace.hidden = active
    el.metaText.hidden = !active
    el.metaHint.hidden = active
    if (active) el.metaText.textContent = state.workspaceLabel || '默认工作区'
    if (!active) el.workspace.disabled = state.creating
    if (active) el.wsNew.hidden = true
    updateInfo()
  }

  async function loadWorkspaces(selectId) {
    try {
      const [response, prefs] = await Promise.all([
        sendBackground({ kind: 'workspaces' }),
        sendBackground({ kind: 'prefs' }),
      ])
      const list = response?.ok === true && Array.isArray(response.workspaces) ? response.workspaces : []
      state.workspaces = list
      const wanted = typeof selectId === 'string'
        ? selectId
        : (typeof prefs?.workspaceId === 'string' ? prefs.workspaceId : undefined)
      const preferred = wanted === undefined ? undefined : list.find((item) => item.id === wanted)
      const chosen = preferred ?? list.find((item) => item.current) ?? list[0]
      state.workspaceId = chosen?.id ?? null
      el.workspace.replaceChildren()
      if (list.length === 0) {
        const option = document.createElement('option')
        option.textContent = '默认工作区'
        option.value = ''
        el.workspace.appendChild(option)
      } else {
        for (const item of list) {
          const option = document.createElement('option')
          option.value = item.id
          option.textContent = item.title || item.path || item.id
          option.title = item.path || item.title || item.id
          el.workspace.appendChild(option)
        }
      }
      const addOption = document.createElement('option')
      addOption.value = '__new__'
      addOption.textContent = '＋ 添加目录作为工作区…'
      el.workspace.appendChild(addOption)
      el.workspace.value = state.workspaceId ?? ''
      el.workspace.disabled = false
      updateMeta()
    } catch { /* workspace list is optional */ }
  }

  async function addWorkspaceFromPath() {
    const path = el.wsPath.value.trim()
    if (path === '') return
    el.wsOk.disabled = true
    try {
      const response = await sendBackground({ kind: 'workspaceCreate', path })
      if (response?.ok !== true) throw new Error(response?.error ?? '添加工作区失败')
      const created = response.workspace
      el.wsNew.hidden = true
      el.wsPath.value = ''
      await loadWorkspaces(created?.id)
      state.workspaceId = created?.id ?? state.workspaceId
      state.workspaceLabel = created?.title || created?.path || ''
      sendBackground({ kind: 'setPrefs', workspaceId: state.workspaceId }).catch(() => {})
      addSystem(`已添加工作区：${created?.title || created?.path || ''}`)
    } catch (error) {
      addSystem(String(error?.message ?? error))
    } finally {
      el.wsOk.disabled = false
    }
  }

  /** Create a session with the board context plus the user's first message. */
  async function createAndSend(text) {
    if (state.creating) {
      state.pendingSends.push(text)
      return
    }
    state.creating = true
    updateMeta()
    addUser(text, Date.now())
    state.pendingUserEcho = text
    setBusy(true)
    el.statusText.textContent = '正在创建会话并注入画板上下文…'
    try {
      const snapshot = await pageRequest('scene.get', {}, 25_000)
      if (snapshot.appReady === false) throw new Error('Excalidraw 还在加载，请稍后再试')
      state.elementCount = Array.isArray(snapshot.elements) ? snapshot.elements.filter((el) => !el.isDeleted).length : state.elementCount
      const scope = await refreshScope()
      const response = await sendBackground({
        kind: 'start',
        workspaceId: state.workspaceId ?? undefined,
        firstMessage: text,
        context: {
          url: snapshot.url,
          title: snapshot.title,
          version: snapshot.version,
          elements: Array.isArray(snapshot.elements) ? snapshot.elements : [],
          selection: { ids: Array.isArray(scope?.ids) ? scope.ids : [] },
          viewport: snapshot.viewport,
          appState: snapshot.appState,
        },
      })
      if (response?.ok !== true) throw new Error(response?.error ?? 'DSH 没有接受这次请求')
      state.creating = false
      state.pendingUserEcho = null
      state.workspaceLabel = response.workspace?.title || response.workspace?.path || ''
      storeSession(response.sessionId)
      state.lastSeq = 0
      setScopeLabel(response.scope?.kind === 'selection' ? 'selection' : 'all', response.scope?.ids?.length ?? 0)
      updateMeta()
      updateInfo()
      pollLoop()
    } catch (error) {
      state.creating = false
      state.pendingUserEcho = null
      updateMeta()
      setBusy(false)
      addError(String(error?.message ?? error))
    }
  }

  async function pollLoop() {
    if (state.polling) return
    state.polling = true
    try {
      while (state.panelOpen && state.sessionId !== null) {
        const sessionId = state.sessionId
        let response
        try {
          response = await sendBackground({ kind: 'chat', sessionId, since: state.lastSeq, verbose: state.expanded })
        } catch (error) {
          addError(String(error?.message ?? error))
          await sleep(2_000)
          continue
        }
        if (state.sessionId !== sessionId) break
        if (response?.ok !== true) {
          const error = String(response?.error ?? '')
          if (error.includes('未知会话')) {
            resetSession('DSH 已重启，之前的会话不在了；下次发送会创建新会话。')
            return
          }
          addError(error || '读取对话失败')
          await sleep(2_000)
          continue
        }
        const frames = Array.isArray(response.frames) ? response.frames : []
        for (const frame of frames) {
          renderFrame(frame)
          if (typeof frame.seq === 'number' && frame.seq > state.lastSeq) state.lastSeq = frame.seq
        }
        setBusy(response.running === true)
        if (frames.length === 0) await sleep(60)
      }
    } finally {
      state.polling = false
      setBusy(false)
    }
  }

  /* ------------------------- actions ------------------------- */

  async function openPanel() {
    el.launcher.hidden = true
    el.panel.hidden = false
    state.panelOpen = true
    applyExpanded(state.expanded)
    el.textarea.focus()

    await refreshScope()
    await loadWorkspaces()
    if (state.sessionId === null) {
      clearMessages()
      addSystem('在下方输入内容后才会创建 DSH 会话，不会自动消耗模型调用。')
      updateMeta()
      return
    }
    clearMessages()
    addSystem('正在恢复对话…')
    state.lastSeq = 0
    pollLoop()
  }

  function closePanel() {
    state.panelOpen = false
    el.panel.hidden = true
    el.launcher.hidden = false
    setBusy(false)
  }

  async function send() {
    const text = el.textarea.value.trim()
    if (text === '') return
    el.textarea.value = ''
    el.textarea.style.height = '44px'
    if (state.sessionId === null) {
      await createAndSend(text)
      return
    }
    addUser(text)
    setBusy(true)
    try {
      const response = await sendBackground({ kind: 'message', sessionId: state.sessionId, text })
      if (response?.ok !== true) throw new Error(response?.error ?? '发送失败')
      if (response.scope !== undefined) {
        setScopeLabel(response.scope.kind === 'selection' ? 'selection' : 'all', response.scope.ids?.length ?? 0)
      }
      pollLoop()
    } catch (error) {
      setBusy(false)
      addError(String(error?.message ?? error))
    }
  }

  async function updateScope() {
    const scope = await refreshScope()
    if (scope === undefined) {
      addSystem('没能读取当前选中范围')
      return
    }
    if (state.sessionId !== null) {
      try {
        const response = await sendBackground({ kind: 'scope', sessionId: state.sessionId, ids: state.scopeIds })
        if (response?.ok === true) {
          setScopeLabel(state.scopeIds.length > 0 ? 'selection' : 'all', state.scopeIds.length)
          addSystem(state.scopeIds.length > 0 ? `修改范围已更新为选中的 ${state.scopeIds.length} 个元素` : '修改范围已更新为整块画板')
        }
      } catch (error) {
        addSystem(String(error?.message ?? error))
      }
    }
  }

  async function openInDsh() {
    if (state.sessionId === null) {
      addSystem('还没有会话，先发一句话或等我连接画板。')
      return
    }
    try {
      const response = await sendBackground({ kind: 'open', sessionId: state.sessionId })
      if (response?.ok !== true) throw new Error(response?.error ?? '打开失败')
      addSystem(response.openedTab === true ? '已在新标签页打开 DSH 会话。' : '已在 DSH 窗口打开这个会话。')
    } catch (error) {
      addSystem(String(error?.message ?? error))
    }
  }

  async function interrupt() {
    if (state.sessionId === null) return
    try {
      await sendBackground({ kind: 'interrupt', sessionId: state.sessionId })
      addSystem('已请求停止本轮。')
    } catch (error) {
      addSystem(String(error?.message ?? error))
    }
  }

  /* ------------------------- wiring ------------------------- */

  el.launcher.addEventListener('click', (event) => {
    event.stopPropagation()
    openPanel()
  })
  el.launcher.addEventListener('pointerdown', (event) => event.stopPropagation(), true)
  el.close.addEventListener('click', closePanel)
  el.reset.addEventListener('click', () => {
    resetSession('已清空当前对话。下次发送时会创建新会话（也可以先选好工作区）。')
    loadWorkspaces()
  })
  el.open.addEventListener('click', openInDsh)
  el.scope.addEventListener('click', updateScope)
  el.stop.addEventListener('click', interrupt)
  el.send.addEventListener('click', send)
  el.textarea.addEventListener('input', () => {
    el.textarea.style.height = '44px'
    el.textarea.style.height = `${Math.min(120, el.textarea.scrollHeight)}px`
  })
  el.textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      send()
    }
  })
  el.panel.addEventListener('pointerdown', (event) => event.stopPropagation(), true)
  el.panel.addEventListener('wheel', (event) => event.stopPropagation(), true)

  // The textarea lives in a shadow root, so Excalidraw sees the retargeted host
  // element rather than an input and would treat keystrokes as canvas shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type, (event) => {
      if (typeof event.composedPath === 'function' && event.composedPath().includes(host)) {
        event.stopPropagation()
      }
    }, true)
  }

  el.workspace.addEventListener('change', () => {
    if (el.workspace.value === '__new__') {
      el.workspace.value = state.workspaceId ?? ''
      el.wsNew.hidden = false
      el.wsPath.focus()
      return
    }
    state.workspaceId = el.workspace.value === '' ? null : el.workspace.value
    sendBackground({ kind: 'setPrefs', workspaceId: state.workspaceId }).catch(() => {})
  })
  el.wsOk.addEventListener('click', addWorkspaceFromPath)
  el.wsCancel.addEventListener('click', () => {
    el.wsNew.hidden = true
    el.wsPath.value = ''
  })
  el.wsPath.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      addWorkspaceFromPath()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      el.wsNew.hidden = true
    }
  })
  el.expand.addEventListener('click', () => applyExpanded(!state.expanded))

  // Flush messages typed while the session was being created.
  const flushPending = () => {
    if (state.creating) return
    if (state.sessionId === null) {
      const next = state.pendingSends.shift()
      if (next !== undefined) createAndSend(next)
      return
    }
    if (state.pendingSends.length === 0) return
    const queued = state.pendingSends.splice(0)
    for (const text of queued) {
      addUser(text)
      sendBackground({ kind: 'message', sessionId: state.sessionId, text }).catch(() => {})
    }
    pollLoop()
  }
  setInterval(() => {
    if (state.pendingSends.length > 0) flushPending()
  }, 500)

  if (state.sessionId !== null) refreshScope()
}

/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */

async function boot() {
  if (window.top !== window) return
  createUi()
  try {
    await sendBackground({ kind: 'register' })
  } catch (error) {
    console.warn('[dsh-excalidraw] register failed:', error)
  }
  setInterval(() => {
    sendBackground({ kind: 'keepalive' }).catch(() => {})
  }, 15_000)
}

boot()
