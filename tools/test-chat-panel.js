// Drives the in-page chat panel with the lazy-create flow: opening the panel
// must NOT create a session or start a model turn; the first send does.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const out = { steps: [] }
for (let attempt = 0; attempt < 60; attempt++) {
  if (document.getElementById('dsh-excalidraw-host') !== null) break
  await sleep(500)
}
const host = document.getElementById('dsh-excalidraw-host')
out.hostPresent = host !== null
if (host === null) return out
const shadow = host.shadowRoot
const launcher = shadow.querySelector('.launcher')
const panel = shadow.querySelector('.panel')
const messages = shadow.querySelector('.messages')
const scopeChip = shadow.querySelector('.scope')
const workspaceSelect = shadow.querySelector('.workspace')
const textarea = shadow.querySelector('textarea')
const sendBtn = shadow.querySelector('.send')
const statusbar = shadow.querySelector('.statusbar')

const call = (type, payload, timeout = 20000) => new Promise((resolve, reject) => {
  const id = `t-${Math.random().toString(36).slice(2)}`
  const timer = setTimeout(() => reject(new Error(`timeout ${type}`)), timeout)
  const listener = (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data || data.__dshExc !== 'res' || data.id !== id) return
    window.removeEventListener('message', listener)
    clearTimeout(timer)
    if (data.ok) resolve(data.value)
    else reject(new Error(String(data.value)))
  }
  window.addEventListener('message', listener)
  window.postMessage({ __dshExc: 'req', id, type, payload }, '*')
})

await call('scene.apply', {
  ops: [
    { op: 'add', element: { type: 'rectangle', x: 80, y: 60, width: 260, height: 140, strokeColor: '#c92a2a', backgroundColor: '#ffe3e3', fillStyle: 'solid' } },
    { op: 'add', element: { type: 'text', x: 100, y: 230, text: '聊天面板测试', fontSize: 24, strokeColor: '#364fc7' } },
  ],
})
const all = await call('scene.get', {})
await call('selection.set', { ids: [all.elements[0].id] })
await sleep(800)

// Open the panel: must be silent (no session, no model turn).
launcher.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
launcher.click()
await sleep(3000)
out.panelOpen = panel !== null && !panel.hasAttribute('hidden')
out.scopeAfterOpen = scopeChip?.textContent
out.workspaceOptions = [...(workspaceSelect?.options ?? [])].map((option) => ({ value: option.value, text: option.textContent }))
out.workspaceDisabled = workspaceSelect?.disabled === true
out.statusVisibleAfterOpen = statusbar?.dataset.visible ?? '0'
out.messagesAfterOpen = [...messages.children].map((node) => ({ cls: node.className, text: (node.textContent ?? '').slice(0, 200) }))
out.sessionCreatedOnOpen = !(out.statusVisibleAfterOpen === '0')

// Expand into the sidebar and check the info strip.
shadow.querySelector('.expand')?.click()
await sleep(500)
out.expanded = panel.classList.contains('expanded')
const info = shadow.querySelector('.info')
out.infoVisible = info?.dataset.visible === '1'
out.infoChips = [...(info?.children ?? [])].map((node) => node.textContent)

// Add an existing directory as a workspace through the "＋ 添加目录" option.
workspaceSelect.value = '__new__'
workspaceSelect.dispatchEvent(new Event('change', { bubbles: true }))
await sleep(200)
const wsNew = shadow.querySelector('.wsnew')
out.wsNewVisible = wsNew?.hidden === false
shadow.querySelector('.wspath').value = 'G:\\proj\\game-assis'
shadow.querySelector('.wsok').click()
for (let attempt = 0; attempt < 20; attempt++) {
  await sleep(250)
  if (wsNew?.hidden === true) break
}
out.wsNewHiddenAfterAdd = wsNew?.hidden === true
out.workspaceValueAfterAdd = workspaceSelect.value
out.addedWorkspaceLabel = [...workspaceSelect.options].find((option) => option.value === workspaceSelect.value)?.textContent
out.messagesAfterAdd = [...messages.children].map((node) => ({ cls: node.className, text: (node.textContent ?? '').slice(0, 200) }))

// First send creates the session with the board context.
textarea.value = '用一句话说画板上有哪些元素，不要改动画板。'
textarea.dispatchEvent(new Event('input', { bubbles: true }))
sendBtn.click()

const snapshot = () => [...messages.children].map((node) => ({ cls: node.className, text: (node.textContent ?? '').slice(0, 300) }))
let replySeen = false
for (let attempt = 0; attempt < 150; attempt++) {
  await sleep(1000)
  const nodes = snapshot()
  if (nodes.some((node) => node.cls.includes('assistant'))) { replySeen = true; break }
  if (nodes.some((node) => node.cls.includes('errorbox'))) break
}
out.replySeen = replySeen
out.workspaceAfterCreate = workspaceSelect?.hidden === true ? shadow.querySelector('.metatext')?.textContent : null
out.infoAfterCreate = [...(shadow.querySelector('.info')?.children ?? [])].map((node) => node.textContent)
out.messagesFinal = snapshot()
return out
