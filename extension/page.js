/**
 * DSH × Excalidraw — MAIN-world page script.
 *
 * Runs inside excalidraw.com before the app boots. It:
 *  - reaches the live Excalidraw `App` instance through the React fiber of the
 *    interactive canvas (`fiber.memoizedProps.app`),
 *  - serves an internal postMessage protocol for the content script
 *    (scene snapshot, element operations, selection, PNG capture),
 *  - never mutates the DOM and never runs unless asked.
 */
;(() => {
  if (window.__DSH_EXCALIDRAW_PAGE__) return
  window.__DSH_EXCALIDRAW_PAGE__ = true

  const CHANNEL = 'dsh-excalidraw'

  /**
   * Selection captured on the last pointerdown that was not on our own UI.
   * Clicking the extension's floating button/panel can clear Excalidraw's
   * selection before the content script reads it, so the scope snapshot is
   * taken one event earlier.
   */
  let lastPointerSelection = []
  let lastPointerSelectionAt = 0

  window.addEventListener('pointerdown', (event) => {
    try {
      lastPointerSelection = selectedIds()
      lastPointerSelectionAt = Date.now()
    } catch { /* app not ready yet */ }
  }, true)

  /* ---------------------------------------------------------------- *
   * App discovery
   * ---------------------------------------------------------------- */

  let cachedApp

  function fiberOf(node) {
    if (node === null || typeof node !== 'object') return undefined
    for (const key of Object.keys(node)) {
      if (key.startsWith('__reactFiber$')) return node[key]
    }
    return undefined
  }

  function isApp(value) {
    return value !== null && typeof value === 'object' &&
      typeof value.updateScene === 'function' &&
      typeof value.getSceneElements === 'function' &&
      typeof value.getAppState === 'function' &&
      (value.api === undefined || value.api.isDestroyed?.() !== true)
  }

  function findApp() {
    if (isApp(cachedApp) && cachedApp.getAppState !== undefined) {
      const canvas = document.querySelector('.excalidraw canvas')
      if (canvas === null || document.contains(canvas)) return cachedApp
    }
    const roots = [
      document.querySelector('canvas.excalidraw__canvas.interactive'),
      document.querySelector('.excalidraw-container'),
      document.querySelector('.excalidraw'),
      document.querySelector('canvas'),
      document.getElementById('root'),
    ]
    for (const root of roots) {
      let fiber = fiberOf(root)
      let guard = 0
      while (fiber && guard++ < 300) {
        const props = fiber.memoizedProps
        const candidates = [props?.app, props?.value, fiber.stateNode]
        for (const candidate of candidates) {
          if (isApp(candidate)) {
            cachedApp = candidate
            return candidate
          }
        }
        fiber = fiber.return
      }
    }
    return undefined
  }

  function api() {
    const app = findApp()
    if (app === undefined) throw new Error('还没有找到 Excalidraw 应用实例（页面可能仍在加载）')
    return app.api ?? app
  }

  function appState() {
    const app = findApp()
    const state = app.getAppState ? app.getAppState() : app.state
    return state ?? {}
  }

  function pageInfo() {
    const version =
      document.querySelector('meta[name="version"]')?.getAttribute('content') ??
      window.__EXCALIDRAW_SHA__ ??
      null
    return {
      url: location.href,
      title: document.title,
      version,
      appReady: findApp() !== undefined,
    }
  }

  /* ---------------------------------------------------------------- *
   * Scene snapshot
   * ---------------------------------------------------------------- */

  function selectedIds() {
    const state = appState()
    const record = state.selectedElementIds ?? {}
    const editing = state.editingTextElement
    const ids = Object.keys(record).filter((id) => record[id])
    if (editing?.id && !ids.includes(editing.id)) ids.push(editing.id)
    return ids
  }

  function viewport() {
    const state = appState()
    return {
      scrollX: state.scrollX ?? 0,
      scrollY: state.scrollY ?? 0,
      zoom: state.zoom?.value ?? 1,
      offsetLeft: state.offsetLeft ?? 0,
      offsetTop: state.offsetTop ?? 0,
      width: state.width ?? window.innerWidth,
      height: state.height ?? window.innerHeight,
    }
  }

  function sceneSnapshot(options = {}) {
    const handle = api()
    const elements = options.includeDeleted === true
      ? handle.getSceneElementsIncludingDeleted()
      : handle.getSceneElements()
    const state = appState()
    return {
      ...pageInfo(),
      elements: elements.map((el) => ({ ...el })),
      selectedIds: selectedIds(),
      viewport: viewport(),
      appState: {
        viewBackgroundColor: state.viewBackgroundColor,
        theme: state.theme,
        gridSize: state.gridSize,
        frameRendering: state.frameRendering,
        selectedGroupIds: state.selectedGroupIds,
        activeTool: state.activeTool?.type,
      },
    }
  }

  function bboxOf(elements) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const el of elements) {
      if (el.isDeleted) continue
      minX = Math.min(minX, el.x)
      minY = Math.min(minY, el.y)
      maxX = Math.max(maxX, el.x + Math.abs(el.width ?? 0))
      maxY = Math.max(maxY, el.y + Math.abs(el.height ?? 0))
    }
    if (!Number.isFinite(minX)) return null
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }

  /* ---------------------------------------------------------------- *
   * Element creation / mutation
   * ---------------------------------------------------------------- */

  function randomInt() {
    return Math.floor(Math.random() * 2 ** 31)
  }

  function now() {
    return Date.now()
  }

  function baseElement(type, input) {
    const x = Number(input.x ?? 0)
    const y = Number(input.y ?? 0)
    const width = Math.abs(Number(input.width ?? (type === 'text' ? 200 : 160)))
    const height = Math.abs(Number(input.height ?? (type === 'text' ? 30 : 100)))
    const element = {
      id: input.id ?? (crypto.randomUUID ? crypto.randomUUID() : `el-${randomInt()}`),
      type,
      x,
      y,
      width,
      height,
      angle: Number(input.angle ?? 0),
      strokeColor: input.strokeColor ?? '#1e1e1e',
      backgroundColor: input.backgroundColor ?? 'transparent',
      fillStyle: input.fillStyle ?? 'solid',
      strokeWidth: Number(input.strokeWidth ?? 2),
      strokeStyle: input.strokeStyle ?? 'solid',
      roughness: Number(input.roughness ?? 1),
      opacity: Number(input.opacity ?? 100),
      groupIds: Array.isArray(input.groupIds) ? input.groupIds : [],
      frameId: input.frameId ?? null,
      roundness: input.roundness ?? (['rectangle', 'diamond', 'ellipse'].includes(type) ? { type: 3 } : null),
      seed: Number(input.seed ?? randomInt()),
      version: 1,
      versionNonce: randomInt(),
      updated: now(),
      isDeleted: false,
      boundElements: null,
      link: input.link ?? null,
      locked: input.locked === true,
      customData: input.customData,
    }
    if (type === 'text') {
      element.text = String(input.text ?? '')
      element.originalText = String(input.text ?? '')
      element.fontSize = Number(input.fontSize ?? 20)
      element.fontFamily = Number(input.fontFamily ?? 1)
      element.textAlign = input.textAlign ?? 'left'
      element.verticalAlign = input.verticalAlign ?? 'top'
      element.containerId = null
      element.lineHeight = 1.25
      element.width = input.width !== undefined ? width : Math.max(20, (element.text.length || 1) * element.fontSize * 0.6)
      element.height = input.height !== undefined ? height : element.fontSize * 1.25
    }
    if (type === 'line' || type === 'arrow' || type === 'freedraw') {
      const points = Array.isArray(input.points) && input.points.length >= 2
        ? input.points
        : [[0, 0], [width, height]]
      element.points = points.map((point) => [Number(point[0] ?? 0), Number(point[1] ?? 0)])
      const xs = element.points.map((p) => p[0])
      const ys = element.points.map((p) => p[1])
      element.width = Math.max(...xs) - Math.min(...xs)
      element.height = Math.max(...ys) - Math.min(...ys)
      if (type === 'arrow') {
        element.startBinding = null
        element.endBinding = null
        element.startArrowhead = input.startArrowhead ?? null
        element.endArrowhead = input.endArrowhead ?? 'arrow'
        element.lastCommittedPoint = element.points[element.points.length - 1]
      }
      element.lastCommittedPoint = element.points[element.points.length - 1]
    }
    return element
  }

  function changed(element) {
    return {
      ...element,
      version: Number(element.version ?? 0) + 1,
      versionNonce: randomInt(),
      updated: now(),
    }
  }

  function applyOps(ops) {
    const handle = api()
    const visible = handle.getSceneElements()
    const all = handle.getSceneElementsIncludingDeleted()
    const byId = new Map(all.map((el) => [el.id, el]))
    let applied = 0
    const affectedIds = []
    const errors = []

    for (const op of ops) {
      try {
        if (op?.op === 'add') {
          const type = String(op.element?.type ?? 'rectangle')
          const next = baseElement(type, op.element ?? {})
          if (next.isDeleted === false) {
            byId.set(next.id, next)
            affectedIds.push(next.id)
            applied++
          }
        } else if (op?.op === 'update') {
          const id = String(op.id ?? '')
          const current = byId.get(id)
          if (current === undefined) {
            errors.push(`update: 找不到元素 ${id}`)
            continue
          }
          const patch = { ...(op.patch ?? {}) }
          delete patch.id
          delete patch.type
          delete patch.isDeleted
          const next = changed({ ...current, ...patch })
          byId.set(id, next)
          affectedIds.push(id)
          applied++
        } else if (op?.op === 'delete') {
          const ids = Array.isArray(op.ids) ? op.ids.map(String) : []
          for (const id of ids) {
            const current = byId.get(id)
            if (current === undefined) {
              errors.push(`delete: 找不到元素 ${id}`)
              continue
            }
            if (current.isDeleted) continue
            byId.set(id, changed({ ...current, isDeleted: true }))
            affectedIds.push(id)
            applied++
          }
        } else {
          errors.push(`未知操作: ${JSON.stringify(op)}`)
        }
      } catch (error) {
        errors.push(String(error?.message ?? error))
      }
    }

    if (applied > 0) {
      // Keep the original array order and append new elements at the end.
      const nextElements = []
      const emitted = new Set()
      for (const el of all) {
        const next = byId.get(el.id)
        if (next === undefined) nextElements.push(el)
        else {
          nextElements.push(next)
          emitted.add(el.id)
        }
      }
      for (const [id, el] of byId) {
        if (!emitted.has(id)) nextElements.push(el)
      }
      handle.updateScene({ elements: nextElements, captureUpdate: 'IMMEDIATELY' })
      handle.refresh?.()
    }

    return {
      applied,
      affectedIds: [...new Set(affectedIds)],
      errors,
      elementCount: api().getSceneElements().length,
      selectedIds: selectedIds(),
    }
  }

  /**
   * Wait for the app's next paint, but never block on a hidden/background tab:
   * `requestAnimationFrame` does not fire for hidden documents, so race it
   * against a short timer.
   */
  function nextFrames(timeoutMs = 350) {
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        setTimeout(resolve, 0)
      }
      const timer = setTimeout(done, timeoutMs)
      const raf = window.requestAnimationFrame ?? ((callback) => setTimeout(callback, 16))
      raf(() => raf(done))
    })
  }

  async function setSelection(ids) {
    const handle = api()
    const wanted = Array.isArray(ids) ? ids.map(String) : []
    if (handle.selection !== undefined) {
      if (wanted.length === 0) handle.selection.clear()
      else handle.selection.select(wanted)
    } else {
      handle.updateScene({ appState: { selectedElementIds: Object.fromEntries(wanted.map((id) => [id, true])) } })
    }
    handle.refresh?.()
    await nextFrames()
    return { selectedIds: selectedIds() }
  }

  /* ---------------------------------------------------------------- *
   * PNG capture
   * ---------------------------------------------------------------- */

  async function screenshot(options = {}) {
    const handle = api()
    // Let the app flush its paint after the last mutation before reading pixels.
    await nextFrames()
    const state = appState()
    const view = viewport()
    const staticCanvas = document.querySelector('canvas.excalidraw__canvas.static')
    if (staticCanvas === null) throw new Error('找不到画布 canvas（页面可能仍在加载）')

    const cssWidth = staticCanvas.getBoundingClientRect().width || staticCanvas.clientWidth
    const dpr = cssWidth > 0 ? staticCanvas.width / cssWidth : window.devicePixelRatio || 1

    const background = options.background ?? state.viewBackgroundColor ?? '#ffffff'
    let crop
    if ((options.scope ?? 'viewport') === 'selection') {
      const ids = new Set(Array.isArray(options.ids) ? options.ids.map(String) : [])
      const selected = handle.getSceneElements().filter((el) => ids.has(el.id) && !el.isDeleted)
      const bbox = bboxOf(selected.length > 0 ? selected : handle.getSceneElements())
      const padding = Number(options.padding ?? 40)
      if (bbox === null) throw new Error('画板是空的，没有可以截图的区域')
      const x = (bbox.x + view.scrollX) * view.zoom + view.offsetLeft - padding
      const y = (bbox.y + view.scrollY) * view.zoom + view.offsetTop - padding
      const width = bbox.width * view.zoom + padding * 2
      const height = bbox.height * view.zoom + padding * 2
      crop = {
        x: Math.max(0, Math.floor(x)),
        y: Math.max(0, Math.floor(y)),
        width: Math.ceil(Math.min(width, cssWidth - Math.max(0, x))),
        height: Math.ceil(Math.min(height, (staticCanvas.height / dpr) - Math.max(0, y))),
      }
      if (crop.width <= 0 || crop.height <= 0) {
        throw new Error('选中的元素不在当前可视区域内，请先在画板上滚动/缩放到它们，或改用 scope:"viewport"')
      }
    } else {
      crop = { x: 0, y: 0, width: cssWidth, height: staticCanvas.height / dpr }
    }

    const px = {
      x: Math.round(crop.x * dpr),
      y: Math.round(crop.y * dpr),
      width: Math.round(crop.width * dpr),
      height: Math.round(crop.height * dpr),
    }
    const output = document.createElement('canvas')
    output.width = Math.max(1, px.width)
    output.height = Math.max(1, px.height)
    const context = output.getContext('2d')
    context.fillStyle = background
    context.fillRect(0, 0, output.width, output.height)
    context.drawImage(staticCanvas, px.x, px.y, px.width, px.height, 0, 0, px.width, px.height)

    const dataUrl = output.toDataURL('image/png')
    return {
      dataUrl,
      width: output.width,
      height: output.height,
      crop,
      viewport: view,
      background,
    }
  }

  /* ---------------------------------------------------------------- *
   * Protocol
   * ---------------------------------------------------------------- */

  async function handle(type, payload) {
    switch (type) {
      case 'page.status': {
        const handleApp = findApp()
        const elements = handleApp === undefined ? [] : handleApp.getSceneElements()
        return { ...pageInfo(), elementCount: elements.length, selectedCount: selectedIds().length }
      }
      case 'scene.get':
        return sceneSnapshot(payload ?? {})
      case 'scene.scope': {
        const handleApp = findApp()
        const elements = handleApp === undefined ? [] : handleApp.getSceneElements()
        const ids = selectedIds()
        const selected = elements.filter((el) => ids.includes(el.id) && !el.isDeleted)
        // Clicking the extension UI may clear Excalidraw's selection before the
        // content script reads it, so report the selection captured just before
        // that click as well.
        const lastPointer = Date.now() - lastPointerSelectionAt < 20_000
          ? { ids: lastPointerSelection, at: lastPointerSelectionAt }
          : null
        return {
          ids,
          count: ids.length,
          bbox: bboxOf(selected),
          types: selected.map((el) => el.type),
          elementCount: elements.length,
          lastPointer,
        }
      }
      case 'scene.apply':
        return applyOps(Array.isArray(payload?.ops) ? payload.ops : [])
      case 'selection.set':
        return setSelection(payload?.ids)
      case 'scene.png':
        return screenshot(payload ?? {})
      case 'page.ping':
        return { ...pageInfo(), ready: findApp() !== undefined }
      default:
        throw new Error(`未知操作: ${type}`)
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data
    if (data === null || typeof data !== 'object') return
    if (data.__dshExc !== 'req' || typeof data.id !== 'string') return
    const respond = (ok, value) => {
      window.postMessage({ __dshExc: 'res', channel: CHANNEL, id: data.id, ok, value }, '*')
    }
    Promise.resolve()
      .then(() => handle(data.type, data.payload))
      .then((value) => respond(true, value))
      .catch((error) => respond(false, String(error?.message ?? error)))
  })

  // Lazy app warm-up: the fiber is present as soon as the interactive canvas mounts.
  const warm = () => {
    if (findApp() !== undefined) return true
    return false
  }
  if (!warm()) {
    const timer = setInterval(() => {
      if (warm()) clearInterval(timer)
    }, 1000)
    setTimeout(() => clearInterval(timer), 60_000)
  }
})()
