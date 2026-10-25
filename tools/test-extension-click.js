// Drives the real extension in headless Chrome: add a small scene, select part
// of it, click the floating button, then report what the UI says.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function call(type, payload, timeout = 20000) {
  return new Promise((resolve, reject) => {
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
}

const out = { steps: [] }

// 1. Wait for the app + the extension UI.
for (let attempt = 0; attempt < 40; attempt++) {
  if (document.getElementById('dsh-excalidraw-host') !== null) break
  await sleep(500)
}
const host = document.getElementById('dsh-excalidraw-host')
out.hostPresent = host !== null
if (host === null) return out
const shadow = host.shadowRoot
const button = shadow.querySelector('.button')
const statusEl = shadow.querySelector('.status')
const scopeEl = shadow.querySelector('.scope')
out.scopeInitial = scopeEl.textContent

// 2. Draw a small scene through the page bridge, then select two elements.
const add = await call('scene.apply', {
  ops: [
    { op: 'add', element: { type: 'rectangle', x: 60, y: 50, width: 200, height: 120, strokeColor: '#c92a2a', backgroundColor: '#ffe3e3', fillStyle: 'solid', roundness: { type: 3 } } },
    { op: 'add', element: { type: 'ellipse', x: 300, y: 60, width: 150, height: 110, strokeColor: '#1864ab', backgroundColor: '#d0ebff', fillStyle: 'solid' } },
    { op: 'add', element: { type: 'text', x: 70, y: 200, text: '画板上下文注入测试', fontSize: 24, strokeColor: '#364fc7' } },
  ],
})
out.add = add
const scene = await call('scene.get', {})
const allIds = scene.elements.map((el) => el.id)
const selectedIds = allIds.slice(0, 2)
await call('selection.set', { ids: selectedIds })
out.selected = selectedIds
out.scopeBeforeClick = await call('scene.scope', {})
out.scopeLabelBeforeClick = scopeEl.textContent

// 3. Click the floating button and watch the status line.
button.click()
for (let attempt = 0; attempt < 60; attempt++) {
  await sleep(500)
  if (statusEl.dataset.visible === '1' && statusEl.textContent.length > 0) break
}
out.status = statusEl.textContent
out.statusTone = statusEl.dataset.tone
out.buttonLabel = shadow.querySelector('.label').textContent
out.buttonBusy = button.dataset.busy
out.scopeAfterClick = await call('scene.scope', {})
out.scopeLabel = scopeEl.textContent
return out
