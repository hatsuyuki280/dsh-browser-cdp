/**
 * ego-browser cast-server — host half of the realtime watch panel.
 *
 * Bridges the client UI (/api/bcdp/*) to the ego-cast worker
 * (bin/cdp-cast-worker.mjs) that attaches to the agent's live browser and
 * streams screencast JPEGs. Everything the agent's own browser does is pushed;
 * this host route only *reads* the worker's loopback JSON. No navigation, no
 * writes, no host env changes — consistent with the plugin's read-only stance.
 *
 * Lifecycle: the worker is launched lazily (only once), on the first request,
 * when a live agent browser is expected. If no browser.json exists yet it
 * exits cleanly; we surface an empty spaces list so the panel says
 * "no live browser right now" instead of erroring.
 */
import { fileURLToPath } from 'node:url'
import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { EgoContext, RegisterRouteOptions, ResolvedConfig, WebServerLike } from './types.ts'
import type { SettingsBridge } from './settings.ts'
import type { FfmpegInstallationManager, FfmpegStatus } from './ffmpeg-installation.ts'
import type { LoginImportOptions, LoginImportReport } from './login-import.ts'
import { EGO_LINUX_CDP_URL } from './cdp-targets.ts'
import { BCDP_CDP_ENGINE } from './cdp/capabilities.ts'

const WORKER_BIN = fileURLToPath(new URL('../bin/cdp-cast-worker.mjs', import.meta.url))

// ── R1: activated CDP endpoint for the watch/stream worker ────────────────
// The cast worker is a separate long-lived process that attaches to the SAME
// browser the tools drive. It cannot read the host half's per-spawn env, so
// the resolved endpoint is handed to it explicitly: once as env when it
// starts, and again on every activation change (which also recycles it — see
// `setAttachEndpoint`). Same rules as for tools: nothing derived is persisted,
// and no resolved endpoint simply means "no remote attach" (the worker then
// behaves exactly as it did before R1).
let attachWsUrl: string | null = null
/** Lightpanda backend — engine of the attached endpoint, published next to it. */
let attachEngine: 'chrome' | 'lightpanda' | 'unknown' | null = null
/** Logger captured in initCastServer so module-level helpers can report. */
let castLogger: { info?: (message: string) => void; warn?: (message: string) => void } | undefined

/**
 * Publish the currently resolved endpoint for the worker. Called by the host
 * half whenever the ACTIVATED target changes (new target, new endpoint, or
 * mode switching away from remote). Returns true when the value actually
 * changed, which is the caller's signal that the worker must be recycled.
 * The engine rides along so a spawned worker gets its capability projection
 * via env (`BCDP_CDP_ENGINE`) instead of re-deriving it.
 */
export function setAttachEndpoint(wsUrl: string | null, engine: 'chrome' | 'lightpanda' | 'unknown' | null = null): boolean {
  const next = wsUrl && wsUrl !== '' ? wsUrl : null
  const nextEngine = next === null ? null : engine
  if (next === attachWsUrl && nextEngine === attachEngine) return false
  attachWsUrl = next
  attachEngine = nextEngine
  return true
}

/** The endpoint the worker should attach to right now (null = none). */
export function getAttachEndpoint(): string | null {
  return attachWsUrl
}

/** The engine of the attached endpoint (null = none attached). */
export function getAttachEngine(): 'chrome' | 'lightpanda' | 'unknown' | null {
  return attachEngine
}

/**
 * Stop a running worker so the next request respawns it with the new argv
 * seed (T2.4: an activation change must take effect on a live panel, not only
 * after a host restart). Kills only the pid WE spawned (per our namespaced state file) —
 * never a name-matched sweep, which previously took out the DSH subprocess
 * runner along with our own tree (issues #34 defect 2 / #40).
 */
export async function recycleWorker(reason: string): Promise<boolean> {
  const state = await knownWorkerState()
  if (state.pid === null || !isProcessAlive(state.pid)) return false
  try {
    process.kill(state.pid, 'SIGTERM')
  } catch {
    try {
      process.kill(state.pid, 'SIGKILL')
    } catch {
      return false
    }
  }
  castLogger?.info?.(`recycled cast worker (pid ${state.pid}) because ${reason}`)
  return true
}

export const EGO_SPACES_ROUTE = '/api/bcdp/spaces'
export const EGO_STREAM_ROUTE = '/api/bcdp/stream'
export const EGO_HEALTH_ROUTE = '/api/bcdp/health'
export const EGO_CLOSE_ROUTE = '/api/bcdp/close'
export const EGO_FLUSH_ROUTE = '/api/bcdp/flush'
export const EGO_RAISE_ROUTE = '/api/bcdp/raise'
export const EGO_MARKS_ROUTE = '/api/bcdp/marks'
export const EGO_PICK_ROUTE = '/api/bcdp/pick'
export const EGO_LOGIN_IMPORT_ROUTE = '/api/bcdp/login-import'
export const EGO_INPUT_ROUTE = '/api/bcdp/input'
export const EGO_WATCH_START_ROUTE = '/api/bcdp/watch/start'
export const EGO_WATCH_SWITCH_ROUTE = '/api/bcdp/watch/switch'
export const EGO_WATCH_STOP_ROUTE = '/api/bcdp/watch/stop'
export const EGO_WATCH_STATUS_ROUTE = '/api/bcdp/watch/status'
export const EGO_VIDEO_ROUTE = '/api/bcdp/video'
export const EGO_VIDEO_STATUS_ROUTE = '/api/bcdp/video/status'

// ── tool-call signal (auto-open sidebar Tab) ─────────────────────────────
// Module-level counter bumped by markEgoToolCall() from the tool execute
// path (src/index.ts: defineEgoTool). When a new tool call lands, we
// broadcast a `tool-call` SSE event to every connected watch-panel client
// so the sidebar auto-opens instantly — NO client-side polling needed.
// (Previously the client polled /api/bcdp/spaces every 2s to detect this;
//  that loop is now gone.) Process-local; resets to 0 on host restart,
// which is fine — the auto-open is a one-shot per session anyway.
let toolCallCount = 0
const sseClients = new Set<ServerResponse>()

/** Timestamp of the last bcdp_* tool call — the idle reaper's activity signal. */
let lastEgoActivity = 0
export function getLastEgoActivity(): number {
  return lastEgoActivity
}

// ── activity subscribers (tool-tier injection) ────────────────────────────
// The tier controller needs the same signal the reaper reads — "a bcdp_* call
// just happened" — but must not have to thread a callback through the nine
// `markEgoToolCall()` call sites in the tool bodies. One module-level fan-out
// keeps the tools oblivious to tiers.
const activityListeners = new Set<(sessionId?: string) => void>()

/**
 * Subscribe to "one bcdp_* call just landed".
 * @returns the unsubscribe function.
 */
export function onEgoActivity(cb: (sessionId?: string) => void): () => void {
  activityListeners.add(cb)
  return () => {
    activityListeners.delete(cb)
  }
}

export function markEgoToolCall(sessionId?: string): void {
  toolCallCount += 1
  lastEgoActivity = Date.now()
  // Tier fan-out: never let a listener throw into the tool's own result path.
  for (const cb of [...activityListeners]) {
    try {
      cb(sessionId)
    } catch {
      /* tier reapply is best-effort; the tool call stands */
    }
  }
  // Push the new count to every connected SSE client immediately. The event
  // payload carries the counter AND the calling session id (when the caller
  // supplied one): the client scopes its sidebar auto-open to that session, so
  // a background conversation's tool call lands in ITS OWN sidebar instead of
  // the one the user happens to be reading.
  const payload = sessionId === undefined || sessionId === ''
    ? { count: toolCallCount }
    : { count: toolCallCount, sessionId }
  const frame = `event: tool-call\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(frame)
    } catch {
      sseClients.delete(res)
    }
  }
}

function castStatePath(): string {
  // Mirror the ego-lite runtime state dir across platforms so we find the
  // worker's state file wherever it ran: Windows uses
  // %LOCALAPPDATA%\ego-lite-linux; POSIX uses $XDG_STATE_HOME (default
  // ~/.local/state)/ego-lite-linux. Honors EGO_LINUX_STATE_DIR overrides.
  // The FILE is plugin-namespaced (dsh-browser-cdp.cast.json): the upstream
  // dsh-ego-browser worker shares this dir under ego-cast.json, and
  // bridging to a foreign worker breaks every route we extended it with
  // (pick/marks/raise 404). Read ONLY our own file.
  const e = process.env
  const isWin = process.platform === 'win32'
  const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || '' : '/root')
  const stateHome = e.EGO_LINUX_STATE_DIR || (isWin
    ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`)
    : (e.XDG_STATE_HOME || `${home}/.local/state`))
  return stateHome.endsWith('ego-lite-linux')
    ? `${stateHome}/dsh-browser-cdp.cast.json`
    : `${stateHome}/ego-lite-linux/dsh-browser-cdp.cast.json`
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Proxy a worker loopback endpoint. Returns null when the worker is unreachable. */
async function proxyFrom(port: number, path: string): Promise<unknown> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

interface ProxyPostResult {
  status: number
  body: unknown
}

/** Proxy a POST with a JSON body to the worker. Returns status and body, or null when unreachable. */
export async function proxyPost(port: number, path: string, body: unknown, timeoutMs = 4000): Promise<ProxyPostResult | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: r.status, body: await r.json().catch(() => ({ ok: false, error: `worker returned ${r.status}` })) }
  } catch {
    return null
  }
}

/** Read a bounded network/console buffer from the live worker. */
export async function readWorkerDiagnostics(
  kind: 'network' | 'console',
  limit = 50,
  targetId?: string,
): Promise<Record<string, unknown> | null> {
  const state = await knownWorkerState()
  if (state.port === null) return null
  const query = new URLSearchParams({ kind, limit: String(limit) })
  if (targetId) query.set('targetId', targetId)
  const result = await proxyFrom(state.port, `/api/diagnostics?${query.toString()}`)
  return result !== null && typeof result === 'object' ? result as Record<string, unknown> : null
}

/** Ask the live worker to render the current page to PDF (base64 payload). */
export async function printWorkerPdf(options: {
  targetId?: string
  printBackground?: boolean
  scale?: number
  landscape?: boolean
  paperWidth?: number
  paperHeight?: number
}): Promise<ProxyPostResult | null> {
  const state = await knownWorkerState()
  if (state.port === null) return null
  return proxyPost(state.port, '/api/pdf', options, 30_000)
}

/**
 * Bridge the worker's SSE stream to the DSH watch panel.
 *
 * The host's webServer calls this as a plain HTTP handler and then returns, so
 * we write the `text/event-stream` headers, start consuming the worker's
 * /api/stream body, and forward every SSE line verbatim onto `res` from a
 * background loop. The connection stays open until the worker stream ends or
 * the client disconnects. If the worker is unreachable we still emit a valid
 * empty SSE stream (the panel stays quiet instead of erroring).
 *
 * Each `res` is also registered in the module-level `sseClients` set so
 * markEgoToolCall() can inject `tool-call` events directly into the live
 * stream (the sidebar auto-open signal), without the client polling.
 */
export function proxyWorkerStream(port: number, res: ServerResponse, path: string): () => void {
  let cancelled = false
  let ended = false
  const endOnce = (): void => {
    if (ended) return
    ended = true
    sseClients.delete(res)
    try {
      res.end()
    } catch {
      /* ignore */
    }
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(':ok\n\n')
  sseClients.add(res)
  // No worker to bridge (ensureWorker() returned null and the handler passed
  // the -1 sentinel): keep the SSE connection open and quiet so
  // markEgoToolCall() can still push `tool-call` events and EventSource does
  // not reconnect-loop. request() below would synchronously throw
  // ERR_SOCKET_BAD_PORT on port -1 and leave the response dangling, which the
  // webserver's last-resort guard turns into a bare connection destroy —
  // the browser then reports net::ERR_EMPTY_RESPONSE.
  if (!Number.isInteger(port) || port <= 0) {
    res.on('close', () => {
      sseClients.delete(res)
    })
    return () => {
      sseClients.delete(res)
    }
  }
  // Use node:http (not fetch) to consume the worker's SSE stream. fetch buffers
  // chunked responses in a way that delays/interleaves the first data chunks
  // under Node's undici, which the real-time frame pipeline cannot tolerate —
  // http.request streams them as they arrive and frames forward immediately.
  const up: ClientRequest = request(
    { host: '127.0.0.1', port, path, method: 'GET', headers: { accept: 'text/event-stream' } },
    (upRes: IncomingMessage) => {
      upRes.on('data', (chunk: Buffer) => {
        if (cancelled || ended) return
        try {
          if (!res.write(chunk)) {
            upRes.pause()
            res.once('drain', () => {
              if (!cancelled && !ended) upRes.resume()
            })
          }
        } catch {
          cancelled = true
          endOnce()
        }
      })
      upRes.on('end', endOnce)
      upRes.on('error', endOnce)
    },
  )
  up.on('error', endOnce)
  up.setTimeout(5000, () => {
    try {
      up.destroy()
    } catch {
      /* ignore */
    }
    endOnce()
  })
  up.end()
  const onClose = (): void => {
    cancelled = true
    sseClients.delete(res)
    try {
      up.destroy()
    } catch {
      /* ignore */
    }
  } // don't end res here; let worker stream close it
  res.on('close', onClose)
  return () => {
    cancelled = true
    sseClients.delete(res)
    try {
      up.destroy()
    } catch {
      /* ignore */
    }
  }
}

function proxyWorkerVideo(port: number, req: IncomingMessage, res: ServerResponse): void {
  const sourceUrl = new URL(req.url || EGO_VIDEO_ROUTE, 'http://dsh.internal')
  const generation = sourceUrl.searchParams.get('generation')
  const path = `/api/video/stream${generation ? `?generation=${encodeURIComponent(generation)}` : ''}`
  let upstream: ClientRequest
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    try {
      res.end()
    } catch {
      /* ignore */
    }
  }
  upstream = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { accept: 'video/mp4' } }, (upRes: IncomingMessage) => {
    res.writeHead(upRes.statusCode || 502, {
      'content-type': upRes.headers['content-type'] || 'application/octet-stream',
      'cache-control': 'no-store',
      ...(upRes.headers['x-ego-generation'] ? { 'x-ego-generation': upRes.headers['x-ego-generation'] } : {}),
      ...(upRes.headers['x-ego-backend'] ? { 'x-ego-backend': upRes.headers['x-ego-backend'] } : {}),
    })
    upRes.on('data', (chunk: Buffer) => {
      if (ended) return
      try {
        if (!res.write(chunk)) {
          upRes.pause()
          res.once('drain', () => {
            if (!ended) upRes.resume()
          })
        }
      } catch {
        upstream.destroy()
        end()
      }
    })
    upRes.on('end', end)
    upRes.on('error', end)
  })
  upstream.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'video worker unavailable' })
    else end()
  })
  upstream.setTimeout(5000, () => {
    try {
      upstream.destroy()
    } catch {
      /* ignore */
    }
    if (!res.headersSent) sendJson(res, 504, { ok: false, error: 'video worker timeout' })
    else end()
  })
  upstream.end()
  res.on('close', () => {
    ended = true
    try {
      upstream.destroy()
    } catch {
      /* ignore */
    }
  })
}

async function readJsonBody(req: IncomingMessage, maxBytes = 8192): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new Error('body too large')
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

interface WorkerState {
  port: number | null
  pid: number | null
}

/** Read the worker's { port, pid } from ego-cast.json, if any. */
async function knownWorkerState(): Promise<WorkerState> {
  try {
    const { readFile } = await import('node:fs/promises')
    const state = JSON.parse(await readFile(castStatePath(), 'utf8')) as { port?: unknown; pid?: unknown }
    return {
      port: typeof state.port === 'number' ? state.port : null,
      pid: typeof state.pid === 'number' ? state.pid : null,
    }
  } catch {
    return { port: null, pid: null }
  }
}

/** Is a process with this pid alive? (false for our own / empty / signals fail) */
function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0) // signal 0 = existence probe, no side effect
    return true
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return e && e.code === 'EPERM' // exists but not ours to signal
  }
}

interface CaptureConfigPayload {
  captureBackend: ResolvedConfig['captureBackend']
  ffmpegFallbackReason: string
  streamProfile: ResolvedConfig['streamProfile']
  cdpFps: number
  cdpQuality: number
  cdpMaxWidth: number
  cdpBackstopIntervalMs: number
  ffmpegFps: number
  ffmpegMaxWidth: number
  ffmpegBitrateKbps: number
  ffmpegEncoder: ResolvedConfig['ffmpegEncoder']
  ffmpegPath: string
  ffmpegResolvedPath: string
}

function captureConfig(cfg: ResolvedConfig, ffmpegManager: FfmpegInstallationManager | null): CaptureConfigPayload {
  const ffmpegStatus: FfmpegStatus | undefined = ffmpegManager?.status()
  const unavailable = cfg.captureBackend === 'ffmpeg' && !ffmpegStatus?.canSelectFfmpeg
  return {
    captureBackend: unavailable ? 'cdp' : cfg.captureBackend,
    ffmpegFallbackReason: unavailable ? (ffmpegStatus?.reason || 'FFmpeg is unavailable') : '',
    streamProfile: cfg.streamProfile,
    cdpFps: cfg.cdpFps,
    cdpQuality: cfg.cdpQuality,
    cdpMaxWidth: cfg.cdpMaxWidth,
    cdpBackstopIntervalMs: cfg.cdpBackstopIntervalMs,
    ffmpegFps: cfg.ffmpegFps,
    ffmpegMaxWidth: cfg.ffmpegMaxWidth,
    ffmpegBitrateKbps: cfg.ffmpegBitrateKbps,
    ffmpegEncoder: cfg.ffmpegEncoder,
    ffmpegPath: cfg.ffmpegPath,
    ffmpegResolvedPath: ffmpegStatus?.canSelectFfmpeg ? (ffmpegStatus.path || '') : '',
  }
}

type EnsureWorker = () => Promise<number | null>
type PushConfig = (cfg: ResolvedConfig) => Promise<void>

/**
 * Env handed to a spawned cast worker.
 *
 * Electron hosts (DSH Desktop): process.execPath is the Electron binary, so
 * children need ELECTRON_RUN_AS_NODE=1 or they boot as a second Electron app
 * (issue #42). Mirror of resolveEgoEnv's guard — inlined here because
 * cast-server cannot import from index.ts (circular import).
 *
 * R1 adds the resolved remote endpoint so the worker attaches to the SAME
 * browser the tools drive; without it, `resolveBrowser()` inside the worker
 * would fall back to reading a local browser.json that does not exist.
 */
function workerEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env }
  if ((process.versions as { electron?: string }).electron && base.ELECTRON_RUN_AS_NODE === undefined) {
    base.ELECTRON_RUN_AS_NODE = '1'
  }
  const ws = getAttachEndpoint()
  if (ws) base[EGO_LINUX_CDP_URL] = ws
  else delete base[EGO_LINUX_CDP_URL]
  // Lightpanda backend — the worker cannot read the host's attach cache, so
  // the projected engine travels as data; an absent value means "full
  // capabilities" (the pre-Lightpanda behavior).
  const engine = getAttachEngine()
  if (engine) base[BCDP_CDP_ENGINE] = engine
  else delete base[BCDP_CDP_ENGINE]
  return base
}

/** Ensure a single ego-cast worker is running (idempotent). Launches it via
 * ctx.subprocess. Re-spawns whenever the previous worker is found dead (its
 * pid no longer alive or its /api/health does not answer), so a crashed
 * worker is brought back without a host restart. Spawn is rate-limited to
 * avoid hot-looping while a headless container has no browser yet.
 */
function makeEnsureWorker(ctx: EgoContext, cfg: ResolvedConfig, ffmpegManager: FfmpegInstallationManager | null): EnsureWorker {
  let lastAttempt = 0
  async function launchedWorkerPort(): Promise<number | null> {
    const state = await knownWorkerState()
    if (state.pid === null || !isProcessAlive(state.pid)) return null
    const alive = await proxyFrom(state.port!, '/api/health')
    return alive ? state.port : null
  }
  return async function ensureWorker(): Promise<number | null> {
    const running = await launchedWorkerPort()
    if (running !== null) return running
    // Worker is dead or not yet up; spawn one, rate-limited.
    const now = Date.now()
    if (now - lastAttempt > 8000) {
      lastAttempt = now
      try {
        // Pass the current cast config to the worker as a JSON argv arg so it
        // starts with the right screencast parameters without needing an
        // extra round-trip POST. The worker reads process.argv[2].
        await ffmpegManager?.check({ configuredPath: cfg.ffmpegPath, requestedEncoder: cfg.ffmpegEncoder }).catch(() => null)
        const initCfg = JSON.stringify(captureConfig(cfg, ffmpegManager))
        const handle = ctx.subprocess.spawn({
          argv: [process.execPath, WORKER_BIN, initCfg],
          // cwd is required by the dsh-subprocess provider on DSH >= 0.1.5 —
          // omitting it throws inside spawn() and the catch below swallowed it
          // silently, making the watch panel never start (issue #34 defect 1).
          cwd: process.cwd(),
          env: workerEnv(),
          stdio: {
            stdin: { data: '' },
            stdout: { maxBytes: 8192 },
            stderr: { maxBytes: 4096 },
          },
          graceMs: 12_000,
        })
        handle.done.catch(() => null)
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const ready = await launchedWorkerPort()
          if (ready !== null) return ready
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return null
      } catch {
        return null
      }
    }
    return null
  }
}

/**
 * Push the current cast config to a running worker via POST /api/config.
 * Best-effort: if the worker is unreachable or the POST fails, the config
 * will take effect on the next worker spawn (argv seed). Called whenever the
 * settings layer reports a change.
 */
function makePushConfig(ensureWorker: EnsureWorker, ffmpegManager: FfmpegInstallationManager | null): PushConfig {
  let lastPush = ''
  return async function pushConfig(cfg: ResolvedConfig): Promise<void> {
    await ffmpegManager?.check({ configuredPath: cfg.ffmpegPath, requestedEncoder: cfg.ffmpegEncoder }).catch(() => null)
    const port = await ensureWorker()
    if (port === null) return
    const payload = JSON.stringify(captureConfig(cfg, ffmpegManager))
    // Dedupe: don't re-push identical config (settings onChange can fire
    // multiple times for a single logical edit).
    if (payload === lastPush) return
    lastPush = payload
    try {
      const result = await proxyPost(port, '/api/config', JSON.parse(payload))
      if (!result || result.status >= 400) throw new Error('worker config update failed')
    } catch {
      // worker may be mid-restart; the next ensureWorker will re-seed via argv
    }
  }
}

/**
 * Register the watch-panel routes. Call inside plugin apply() with the real
 * ctx; dispose is returned for ctx.effect cleanup.
 *
 * `bridge` is the settings bridge — its `onChange` is used to react to
 * live settings saves and push the new config to a running worker.
 */
export function initCastServer(
  ctx: EgoContext,
  cfg: ResolvedConfig,
  bridge: SettingsBridge,
  ffmpegManager: FfmpegInstallationManager | null,
  openAgentWindow: () => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: false, error: 'raise not supported by this host build' }),
  loginImport: (opts: LoginImportOptions) => Promise<LoginImportReport> = async () => ({ ok: false, error: 'login import not supported by this host build' }),
): void {
  const ensureWorker = makeEnsureWorker(ctx, cfg, ffmpegManager)
  const pushConfig = makePushConfig(ensureWorker, ffmpegManager)
  // The web shell exposes `webServer` — the only HTTP host surface the plugin
  // uses. It is NOT a required inject (TUI / headless hosts have none), so we
  // resolve it opportunistically via ctx.get('webServer'); if absent here there
  // is nothing to register, so exit cleanly.
  const rawServer = (ctx as EgoContext).get?.('webServer') as WebServerLike | undefined
  if (!rawServer || typeof rawServer.register !== 'function') {
    return
  }

  // ── trust fence for /api/bcdp/* ────────────────────────────────────────────
  // Exact-path routes match BEFORE the host's `/api` prefix trust-fence route,
  // so every handler below would otherwise answer unauthenticated requests.
  // A cookie *name* is not authentication: an arbitrary caller can invent
  // `dsh-auth-x=1`. Delegate to DSH's connection admission, which verifies the
  // authority-bound HMAC cookie and the Host/Origin fence in one place.
  const connection = (ctx as EgoContext & {
    get?: (name: string) => unknown
  }).get?.('connection') as {
    admit?: (req: IncomingMessage) => unknown
  } | undefined
  const isTrustedRequest = (req: IncomingMessage): boolean => {
    try {
      const admission = connection?.admit?.(req) as { rejection?: unknown } | undefined
      return admission !== undefined && admission.rejection === undefined
    } catch {
      return false
    }
  }
  const guardHandler = (handler: NonNullable<RegisterRouteOptions['handler']>) =>
    async (req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      if (!isTrustedRequest(req as IncomingMessage)) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"unauthorized"}')
        return
      }
      return handler(req, res)
    }
  // Scope the guard to THIS plugin's registrations only: never patch the host
  // webServer singleton in place — other plugins' routes registered through the
  // same service instance must keep their own (unguarded) semantics.
  const rawRegister = rawServer.register.bind(rawServer) as (opts: RegisterRouteOptions) => () => void
  const server = Object.assign(Object.create(Object.getPrototypeOf(rawServer)), rawServer, {
    register: (opts: RegisterRouteOptions) => rawRegister({
      ...opts,
      handler: opts.handler ? guardHandler(opts.handler) : opts.handler,
    }),
  })

  // Hot-push config changes to a running worker. The settings bridge fires
  // onChange whenever the user saves a new castFpsCap / screencastQuality /
  // screencastMaxWidth in the settings card.
  if (typeof bridge?.onChange === 'function') {
    const off = bridge.onChange(() => {
      pushConfig(cfg)
    })
    if (typeof off === 'function') {
      ctx.effect?.(() => () => {
        try {
          off()
        } catch {
          /* ignore */
        }
      })
    }
  }

  const disposeSpaces = server.register({
    kind: 'exact',
    path: EGO_SPACES_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) {
        return sendJson(res, 200, { ok: false, spaces: [], toolCallCount, reason: 'no live agent browser' })
      }
      const data = await proxyFrom(port, '/api/spaces')
      if (!data) return sendJson(res, 200, { ok: false, spaces: [], toolCallCount, reason: 'worker not ready' })
      // Attach the host-side tool-call counter (the worker doesn't know about
      // tool invocations; only the host's defineEgoTool path does).
      return sendJson(res, 200, { ...(data as Record<string, unknown>), toolCallCount })
    },
  })

  // GET /api/bcdp/stream — Server-Sent Events: real-time screencast frames and
  // the live tab/spaces list. The web shell supports exact HTTP routes and this
  // handler keeps the connection open for the worker->panel fan-out.
  const disposeStream = server.register({
    kind: 'exact',
    path: EGO_STREAM_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) {
        proxyWorkerStream(-1, res, '/api/stream')
        return
      }
      proxyWorkerStream(port, res, '/api/stream')
    },
  })

  // POST /api/bcdp/input — forward a watch-panel pointer/wheel intention to the
  // real agent page. Coordinates are already in browser CSS pixels (the panel
  // maps them). The web shell passes the raw body through to the worker.
  const disposeInput = server.register({
    kind: 'exact',
    path: EGO_INPUT_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      const result = await proxyPost(port, '/api/input', body)
      if (!result) return sendJson(res, 502, { ok: false, error: 'input worker unavailable' })
      return sendJson(res, result.status, result.body)
    },
  })

  // POST /api/bcdp/close — close a browser tab by targetId.
  const disposeClose = server.register({
    kind: 'exact',
    path: EGO_CLOSE_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      // Collect the request body (small JSON: { targetId }).
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      const targetId = typeof body.targetId === 'string' ? body.targetId : ''
      if (!targetId) return sendJson(res, 400, { ok: false, error: 'targetId required' })
      const result = await proxyPost(port, '/api/close', { targetId })
      if (!result) return sendJson(res, 502, { ok: false, error: 'close worker unavailable' })
      return sendJson(res, result.status, result.body)
    },
  })

  // POST /api/bcdp/marks — 阶段 3 / R4: set-of-marks capture (image + numbered
  // element map) through the worker's resident connection. Same trust fence and
  // forwarding shape as /api/bcdp/close.
  const disposeMarks = server.register({
    kind: 'exact',
    path: EGO_MARKS_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      const result = await proxyPost(port, '/api/marks', body, 20000)
      if (!result) return sendJson(res, 502, { ok: false, error: 'marks worker unavailable' })
      return sendJson(res, result.status, result.body)
    },
  })

  // 阶段 5 / R6 (T5.19): pick-mode control. POST forwards {enabled, targetId}
  // to the worker's resident-connection picker; GET polls the pick state the
  // panel observes (lastPick included); POST /click forwards the T5.1b
  // coordinate fallback. One registration, branched on method+path — the
  // worker exposes both on sibling paths.
  const disposePick = server.register({
    kind: 'exact',
    path: EGO_PICK_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      if (req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
        const result = await proxyPost(port, '/api/pick', body)
        if (!result) return sendJson(res, 502, { ok: false, error: 'pick worker unavailable' })
        return sendJson(res, result.status, result.body)
      }
      const result = await proxyFrom(port, '/api/pick')
      return sendJson(res, 200, result || { ok: false, state: 'idle', reason: 'worker not ready' })
    },
  })

  // T5.1b fallback — panel-sent viewport coordinates. Separate exact route so
  // matching never depends on the host's exact-path semantics.
  const disposePickClick = server.register({
    kind: 'exact',
    path: `${EGO_PICK_ROUTE}/click`,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      const result = await proxyPost(port, '/api/pick/click', body)
      if (!result) return sendJson(res, 502, { ok: false, error: 'pick worker unavailable' })
      return sendJson(res, result.status, result.body)
    },
  })

  // POST /api/bcdp/flush — force login cookies down to the disk profile.
  const disposeFlush = server.register({
    kind: 'exact',
    path: EGO_FLUSH_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      const result = await proxyPost(port, '/api/flush', {})
      if (!result) return sendJson(res, 502, { ok: false, error: 'flush worker unavailable' })
      return sendJson(res, result.status, result.body)
    },
  })

  // POST /api/bcdp/raise — pop the agent browser out as a REAL visible window
  // (issue #51): when the backing browser runs headless, the runtime's
  // `ego-browser --open` replaces it with a headed instance on the SAME
  // profile (tabs restore); when it is already visible, --open just raises
  // the window. The actual spawn is injected by the host plugin (it owns
  // egoBin + the env resolution).
  const disposeRaise = server.register({
    kind: 'exact',
    path: EGO_RAISE_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      try {
        const result = await openAgentWindow()
        return sendJson(res, result.ok ? 200 : 500, result)
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String((err as Error)?.message || err) })
      }
    },
  })

  // POST /api/bcdp/login-import — the settings card's entry point for the
  // login-cookie importer (issue #46). The heavy lifting (system browser
  // probe, ABE-safe CDP read, write into the agent browser) is injected by
  // the host plugin; the body mirrors bcdp_login_import's arguments.
  const disposeLoginImport = server.register({
    kind: 'exact',
    path: EGO_LOGIN_IMPORT_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      try {
        const result = await loginImport({
          source: (['chrome', 'edge', 'brave', 'auto'].includes(String(body.source)) ? String(body.source) : 'auto') as LoginImportOptions['source'],
          domains: Array.isArray(body.domains) ? (body.domains as unknown[]).map(String) : undefined,
          profile: typeof body.profile === 'string' && body.profile !== '' ? body.profile : undefined,
          closeSource: body.closeSource === true,
          dryRun: body.dryRun === true,
        })
        return sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String((err as Error)?.message || err) })
      }
    },
  })

  const disposeHealth = server.register({
    kind: 'exact',
    path: EGO_HEALTH_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 200, { ok: false })
      const h = await proxyFrom(port, '/api/health')
      return sendJson(res, 200, h || { ok: false })
    },
  })

  const watchRoutes: (() => void)[] = [
    [EGO_WATCH_START_ROUTE, '/api/watch/start'],
    [EGO_WATCH_SWITCH_ROUTE, '/api/watch/switch'],
    [EGO_WATCH_STOP_ROUTE, '/api/watch/stop'],
  ].map(([path, workerPath]) => server.register!({
    kind: 'exact', path,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 409, { ok: false, error: 'worker not ready' })
      const timeoutMs = workerPath === '/api/watch/start' || workerPath === '/api/watch/switch' ? 30000 : 4000
      const result = await proxyPost(port, workerPath, await readJsonBody(req).catch(() => ({})), timeoutMs)
      return result
        ? sendJson(res, result.status, result.body)
        : sendJson(res, 502, { ok: false, error: 'worker request failed' })
    },
  }))
  const disposeWatchStatus = server.register({
    kind: 'exact', path: EGO_WATCH_STATUS_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      const result = port === null ? null : await proxyFrom(port, '/api/watch/status')
      return sendJson(res, 200, result || { ok: false, state: 'idle', reason: 'worker not ready' })
    },
  })
  const disposeVideoStatus = server.register({
    kind: 'exact', path: EGO_VIDEO_STATUS_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      const result = port === null ? null : await proxyFrom(port, '/api/video/status')
      return sendJson(res, 200, result || { ok: false, state: 'idle', reason: 'worker not ready' })
    },
  })
  const disposeVideo = server.register({
    kind: 'exact', path: EGO_VIDEO_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 502, { ok: false, error: 'worker not ready' })
      proxyWorkerVideo(port, req, res)
    },
  })

  ctx.effect?.(() => () => {
    try { disposeSpaces() } catch { /* ignore */ }
    try { disposeStream() } catch { /* ignore */ }
    try { disposeInput() } catch { /* ignore */ }
    try { disposeClose() } catch { /* ignore */ }
    try { disposeMarks() } catch { /* ignore */ }
    try { disposePick() } catch { /* ignore */ }
    try { disposePickClick() } catch { /* ignore */ }
    try { disposeFlush() } catch { /* ignore */ }
    try { disposeRaise() } catch { /* ignore */ }
    try { disposeLoginImport() } catch { /* ignore */ }
    try { disposeHealth() } catch { /* ignore */ }
    for (const dispose of watchRoutes) try { dispose() } catch { /* ignore */ }
    try { disposeWatchStatus() } catch { /* ignore */ }
    try { disposeVideoStatus() } catch { /* ignore */ }
    try { disposeVideo() } catch { /* ignore */ }
  })
}
