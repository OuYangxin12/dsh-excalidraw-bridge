// Minimal headless-Chrome CDP runner (no dependencies; Node's global WebSocket).
// Usage: node tools/cdp.mjs --url https://excalidraw.com/ --script probe.js [--wait 6000] [--json out.json]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const url = arg('url', 'about:blank')
const scriptPath = arg('script')
const waitMs = Number(arg('wait', '6000'))
const port = Number(arg('port', '9333'))
const keep = args.includes('--keep')
const connect = args.includes('--connect')
const extensionPath = arg('extension')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profileDir = path.join(os.tmpdir(), `dsh-cdp-${process.pid}`)
fs.mkdirSync(profileDir, { recursive: true })

const chromeArgs = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--no-sandbox',
  '--window-size=' + arg('window-size', '1280,900'),
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
]
if (extensionPath === undefined) chromeArgs.push('--disable-extensions')
else chromeArgs.push(`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`)
chromeArgs.push('about:blank')

const chrome = connect ? undefined : spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore'] })

async function waitFor(fn, timeoutMs, interval = 200) {
  const start = Date.now()
  let lastError
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn()
      if (value !== undefined) return value
    } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`)
}

async function getJson(urlPath) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`)
  if (!response.ok) throw new Error(`${urlPath} -> ${response.status}`)
  return response.json()
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry !== undefined) {
          this.pending.delete(message.id)
          if (message.error) entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`))
          else entry.resolve(message.result)
        }
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.nextId
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
}

try {
  await waitFor(async () => (await getJson('/json/version')).webSocketDebuggerUrl, 15000)
  const targets = await waitFor(async () => {
    const list = await getJson('/json/list')
    return list.some((t) => t.type === 'page') ? list : undefined
  }, 10000)
  const targetMatch = arg('target-match')
  const page = targets.find((t) => t.type === 'page' && (targetMatch === undefined || t.url.includes(targetMatch)))
  if (page === undefined) throw new Error(`no page target matching ${targetMatch}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const viewport = arg('viewport')
  let viewportSize
  if (viewport !== undefined) {
    const [width, height] = viewport.split('x').map(Number)
    viewportSize = { width, height }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })
  }
  if (url !== 'about:blank') {
    await cdp.send('Page.navigate', { url })
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs))

  const injectPath = arg('inject')
  if (injectPath !== undefined) {
    const source = fs.readFileSync(injectPath, 'utf8')
    const injected = await cdp.send('Runtime.evaluate', {
      expression: source,
      awaitPromise: false,
      returnByValue: true,
    })
    if (injected.exceptionDetails) {
      console.error('INJECT EXCEPTION:', JSON.stringify(injected.exceptionDetails, null, 2))
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  if (scriptPath !== undefined) {
    const source = fs.readFileSync(scriptPath, 'utf8')
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${source} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      console.error('EVAL EXCEPTION:', JSON.stringify(result.exceptionDetails, null, 2))
      process.exitCode = 1
    } else {
      const outFile = arg('out')
      if (outFile !== undefined) {
        fs.writeFileSync(outFile, JSON.stringify(result.result?.value, null, 2))
        console.log(`wrote ${outFile}`)
      } else {
        console.log(JSON.stringify(result.result?.value, null, 2))
      }
    }
  }
  const shotPath = arg('screenshot')
  if (shotPath !== undefined) {
    const shot = await cdp.send('Page.captureScreenshot', viewportSize === undefined
      ? { format: 'png' }
      : {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: viewportSize.width, height: viewportSize.height, scale: 1 },
        })
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log(`screenshot ${shotPath}`)
  }
  if (!keep) {
    ws.close()
    chrome?.kill()
  }
} catch (error) {
  console.error('ERROR:', error)
  process.exitCode = 1
  try { chrome?.kill() } catch {}
}
