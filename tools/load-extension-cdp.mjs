// Try to load an unpacked extension into a running Chrome via the CDP
// Extensions domain (Chrome 135+). Usage:
//   node tools/load-extension-cdp.mjs <port> <extensionDir>
const port = Number(process.argv[2] ?? 9334)
const dir = process.argv[3]
if (!dir) {
  console.error('usage: load-extension-cdp.mjs <port> <extensionDir>')
  process.exit(2)
}

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let nextId = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id === undefined) {
    if (message.method?.startsWith('Extensions.')) console.log('event', message.method, JSON.stringify(message.params))
    return
  }
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(`${message.error.message}`))
  else entry.resolve(message.result)
})
const send = (method, params = {}) => {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

try {
  try {
    await send('Extensions.enable')
  } catch (error) {
    console.log('Extensions.enable failed:', error.message)
  }
  const result = await send('Extensions.loadUnpacked', { path: dir })
  console.log('loaded:', JSON.stringify(result))
} catch (error) {
  console.log('ERROR:', error.message)
  process.exitCode = 1
} finally {
  ws.close()
}
