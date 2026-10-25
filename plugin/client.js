/**
 * DSH × Excalidraw bridge — Client half (runs inside the DSH Web GUI).
 *
 * The Host half records a "pending open" event whenever the user clicks the
 * floating button on excalidraw.com. This module long-polls the same Host for
 * those events and switches the already-open DSH window to the new Session, so
 * the user does not have to hunt for it in the sidebar.
 */
window.__ModuleLoader__.load({
  id: 'dsh-excalidraw-bridge',
  factory(require) {
    const STORAGE_KEY = 'dsh-excalidraw:opened'
    const MAX_AGE_MS = 3 * 60_000

    function readOpened() {
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY)
        const parsed = raw === null ? [] : JSON.parse(raw)
        return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [])
      } catch {
        return new Set()
      }
    }

    function writeOpened(opened) {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...opened].slice(-50)))
      } catch { /* storage is best effort */ }
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    return {
      inject: ['uiWorkspace'],
      apply(ctx) {
        const opened = readOpened()

        const open = async (sessionId) => {
          // Give the Workspace/Session stores a beat to learn the new row.
          await sleep(400)
          try {
            ctx.uiWorkspace.openSession(sessionId)
            opened.add(sessionId)
            writeOpened(opened)
          } catch (error) {
            console.warn('[dsh-excalidraw] could not open session', sessionId, error)
          }
        }

        ctx.effect(() => {
          let disposed = false
          let cursor = 0
          const run = async () => {
            while (!disposed) {
              try {
                const response = await fetch(`/excalidraw/pending?since=${cursor}`, { cache: 'no-store' })
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                const payload = await response.json()
                cursor = typeof payload?.cursor === 'number' ? payload.cursor : cursor
                for (const event of payload?.events ?? []) {
                  const sessionId = event?.sessionId
                  if (typeof sessionId !== 'string' || opened.has(sessionId)) continue
                  if (typeof event.time === 'number' && Date.now() - event.time > MAX_AGE_MS) continue
                  await open(sessionId)
                }
              } catch {
                if (disposed) return
                await sleep(3000)
              }
            }
          }
          run()
          return () => { disposed = true }
        }, 'dsh-excalidraw: pending session opener')
      },
    }
  },
})
