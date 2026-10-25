// End-to-end protocol test for extension/page.js (inject page.js first).
const results = {}

function call(type, payload, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const id = `test-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`timeout: ${type}`)), timeout)
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

// clear any scene saved by earlier runs
try {
  localStorage.removeItem('excalidraw')
  localStorage.removeItem('excalidraw-state')
  localStorage.removeItem('version-dataState')
} catch {}

results.status = await call('page.status', {})
results.scopeBefore = await call('scene.scope', {})

const add = await call('scene.apply', {
  ops: [
    { op: 'add', element: { type: 'rectangle', x: 80, y: 60, width: 220, height: 140, strokeColor: '#c92a2a', backgroundColor: '#ffe3e3', fillStyle: 'solid', roundness: { type: 3 } } },
    { op: 'add', element: { type: 'ellipse', x: 340, y: 80, width: 160, height: 110, strokeColor: '#1864ab', backgroundColor: '#d0ebff', fillStyle: 'solid' } },
    { op: 'add', element: { type: 'text', x: 90, y: 230, text: 'DSH 画板桥接测试', fontSize: 24, strokeColor: '#364fc7' } },
    { op: 'add', element: { type: 'arrow', x: 300, y: 130, width: 60, height: 10, points: [[0, 0], [60, 10]], strokeColor: '#2b8a3e', strokeWidth: 2 } },
  ],
})
results.add = add

const scene = await call('scene.get', {})
results.scene = {
  count: scene.elements.length,
  types: scene.elements.map((el) => el.type),
  viewport: scene.viewport,
  ready: scene.appReady,
}

const ids = scene.elements.map((el) => el.id)
results.selection = await call('selection.set', { ids: ids.slice(0, 2) })
results.scopeAfter = await call('scene.scope', {})

const update = await call('scene.apply', {
  ops: [
    { op: 'update', id: ids[0], patch: { backgroundColor: '#b2f2bb', strokeColor: '#2f9e44' } },
    { op: 'delete', ids: [ids[ids.length - 1]] },
  ],
})
results.update = update

const png = await call('scene.png', { scope: 'selection', ids: ids.slice(0, 2), padding: 30, background: '#ffffff' }, 20000)
results.png = { width: png.width, height: png.height, crop: png.crop, len: png.dataUrl?.length }
results.dataUrl = png.dataUrl
results.after = await call('scene.get', {})
results.afterCount = results.after.elements.length
delete results.after

return results
