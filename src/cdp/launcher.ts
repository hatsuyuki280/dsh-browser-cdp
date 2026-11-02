/**
 * src/cdp/launcher.ts — M0.9 local browser launcher (stage 2b, T2.12–T2.15).
 *
 * Launches a locally installed Chrome/Chromium with an explicit debugging
 * port and a MANAGED profile directory, records the instance in
 * `launcher.json`, and reuses only instances it started itself (T2.13).
 * Everything side-effecting (fs / process / network / clock) is injectable,
 * so the unit tests run without a real Chrome (T2.17 fixtures).
 *
 * Design notes:
 * - The port is allocated up front with `net` (listen(0) → close → reuse),
 *   NOT `--remote-debugging-port=0` + DevToolsActivePort: T2.11 left the
 *   port-file mechanism unverified on Windows, and the design's documented
 *   fallback is an explicit port (design-cdp-local-launch.md §9).
 * - Stop is kill-tree (taskkill /T /F on win32): Browser.close needs a WS
 *   client in the host process where global WebSocket is not guaranteed.
 *   A short grace poll reports the process is really gone (T2.14).
 * - No reverse fallback: `local` mode failures never reach out to a remote
 *   endpoint, and vice versa (T2.16).
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── injectable IO ───────────────────────────────────────────────────────────

export interface LaunchIo {
  exists?: (path: string) => boolean
  readFile?: (path: string) => string
  writeFile?: (path: string, data: string) => void
  removeFile?: (path: string) => void
  isAlive?: (pid: number) => boolean
  killTree?: (pid: number) => void
  spawn?: (bin: string, args: readonly string[], env?: Record<string, string>) => { pid: number }
  fetchVersion?: (url: string) => Promise<{ ok: boolean }>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  makePort?: () => Promise<number>
}

const defaultIo = (): Required<LaunchIo> => ({
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, data) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, data, 'utf8')
  },
  removeFile: (path) => {
    try { rmSync(path) } catch { /* already gone */ }
  },
  isAlive: (pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  },
  killTree: (pid) => {
    if (process.platform === 'win32') {
      // taskkill with /T takes the whole Chrome child tree down (T2.14 ②).
      try { nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best-effort */ }
      return
    }
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  },
  spawn: (bin, args, env) => {
    const child: ChildProcess = nodeSpawn(bin, args, {
      detached: true,
      stdio: 'ignore',
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    })
    child.unref()
    return { pid: child.pid ?? 0 }
  },
  fetchVersion: async (url) => {
    const res = await fetch(url)
    return { ok: res.ok }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  makePort: async () => {
    const server = createServer()
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no port'))
      })
    })
    server.close()
    return port
  },
})

// ── binary discovery (T2.12) ────────────────────────────────────────────────

const PLATFORM_CANDIDATES: Record<string, readonly string[]> = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
}

export function discoverChromeBinary(explicit: string, platform: string, exists: (path: string) => boolean): string {
  if (explicit !== '') return exists(explicit) ? explicit : ''
  for (const candidate of PLATFORM_CANDIDATES[platform] ?? []) {
    if (exists(candidate)) return candidate
  }
  return ''
}

// ── args assembly (T2.12) ───────────────────────────────────────────────────

/** Flags the user must never smuggle into the managed launch. */
const BLOCKED_ARGS = [
  '--user-data-dir', '--remote-debugging-port', '--remote-allow-origins',
  '--no-startup-window', '--proxy-server', '--headless',
]

export function buildLaunchArgs(options: {
  userDataDir: string
  port: number
  headless: boolean
  chromeArgs?: string
}): string[] {
  const userArgs = (options.chromeArgs ?? '')
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter((arg) => arg !== '')
    .filter((arg) => !BLOCKED_ARGS.some((blocked) => arg === blocked || arg.startsWith(`${blocked}=`) || arg.startsWith(`${blocked} `)))
  return [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    // This fork uses legacy headless for the managed launcher: Chrome 153's
    // `--headless=new` plus `--in-process-gpu` SIGTRAPs on the restricted
    // Linux namespace, while legacy `--headless` + in-process GPU stays up.
    ...(options.headless ? ['--headless'] : []),
    ...userArgs,
  ]
}

// ── Lightpanda serve engine (managed, per-OS) ───────────────────────────────

export type LaunchEngine = 'chrome' | 'lightpanda'

/** Flags the user must never smuggle into a managed `lightpanda serve`. */
const LP_BLOCKED_ARGS = ['--host', '--port', '--address']

/**
 * Assemble `lightpanda serve --host 127.0.0.1 --port <port>` + user args.
 * No profile/headless flags exist on the serve CLI — nothing to block there.
 */
export function buildServeArgs(options: { port: number; lightpandaArgs?: string }): string[] {
  const tokens = (options.lightpandaArgs ?? '')
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter((arg) => arg !== '')
  const userArgs: string[] = []
  let skipNext = false
  for (const arg of tokens) {
    if (skipNext) { skipNext = false; continue }
    const blocked = LP_BLOCKED_ARGS.find((b) => arg === b || arg.startsWith(`${b}=`))
    if (blocked !== undefined) {
      // A bare managed flag swallows its value too (`--port 9223`).
      if (arg === blocked) skipNext = true
      continue
    }
    userArgs.push(arg)
  }
  return ['serve', '--host', '127.0.0.1', '--port', String(options.port), ...userArgs]
}

/**
 * win32 sentinel returned by `discoverLightpandaBinary`: Lightpanda has no
 * native Windows build, so the launch argv goes through `wsl.exe --` and the
 * binary lives inside the WSL2 filesystem (host `exists()` cannot see it —
 * the readiness gate is the real check).
 */
export const WSL_LAUNCH = 'wsl'

/**
 * Lightpanda discovery. unix: explicit → common install roots (the official
 * installer targets `~/.local/bin`) → bare PATH name. win32: the WSL sentinel
 * when `wsl.exe` exists (the serve runs inside the default distro).
 */
export function discoverLightpandaBinary(explicit: string, platform: string, exists: (path: string) => boolean): string {
  if (platform === 'win32') {
    return exists('C:/Windows/System32/wsl.exe') ? WSL_LAUNCH : ''
  }
  if (explicit !== '') return explicit
  const home = homedir()
  for (const candidate of [
    `/usr/local/bin/lightpanda`,
    `/usr/bin/lightpanda`,
    join(home, '.local', 'bin', 'lightpanda'),
    join(home, '.dsh', 'cache', 'dsh-browser-cdp', 'bin', 'lightpanda'),
  ]) {
    if (exists(candidate)) return candidate
  }
  return 'lightpanda'
}

/** Spawn argv for one engine on one platform. */
export function buildEngineArgv(options: {
  engine: LaunchEngine
  platform: string
  bin: string
  serveArgs: readonly string[]
}): readonly string[] {
  if (options.engine === 'lightpanda' && options.platform === 'win32' && options.bin === WSL_LAUNCH) {
    return ['wsl.exe', '--', 'lightpanda', ...options.serveArgs]
  }
  return [options.bin, ...options.serveArgs]
}

/** Env handed to a managed Lightpanda serve (telemetry opt-out; WSLENV carries it into WSL). */
export function lightpandaSpawnEnv(platform: string): Record<string, string> {
  const env: Record<string, string> = { LIGHTPANDA_DISABLE_TELEMETRY: 'true' }
  if (platform === 'win32') env.WSLENV = 'LIGHTPANDA_DISABLE_TELEMETRY/u'
  return env
}

// ── registry (T2.13 singleton) ──────────────────────────────────────────────

export interface LauncherRecord {
  pid: number
  port: number
  userDataDir: string
  endpoint: string
  startedAt: number
  /** Lightpanda backend — which engine this record owns. Absent on pre-Lightpanda rows = 'chrome'. */
  engine?: LaunchEngine
}

export function defaultLauncherStatePath(): string {
  return join(homedir(), '.dsh', 'cache', 'dsh-browser-cdp', 'launcher.json')
}

export function defaultManagedProfileDir(): string {
  // T2.15: never the user's daily Chrome profile.
  return join(homedir(), '.dsh', 'cache', 'dsh-browser-cdp', 'chrome-profile')
}

function readRecord(path: string, io: ReturnType<typeof defaultIo>): LauncherRecord | null {
  if (!io.exists(path)) return null
  try {
    const parsed = JSON.parse(io.readFile(path)) as Partial<LauncherRecord>
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null
    return {
      pid: parsed.pid,
      port: parsed.port,
      userDataDir: typeof parsed.userDataDir === 'string' ? parsed.userDataDir : '',
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      engine: parsed.engine === 'lightpanda' ? 'lightpanda' : 'chrome',
    }
  } catch {
    return null
  }
}

// ── launch / stop ───────────────────────────────────────────────────────────

export type LaunchOutcome =
  | { ok: true; reused: boolean; endpoint: string; pid: number; port: number }
  | { ok: false; code: 'chrome-not-found' | 'binary-not-found' | 'launch-exited' | 'not-ready' | 'spawn-failed'; message: string }

/**
 * Launch (or reuse) the managed local browser for ONE engine. The readiness
 * gate is the three-step check from T2.12: process alive → port responds →
 * `/json/version` returns 200. `timeoutMs` bounds the readiness wait
 * (default 20s).
 *
 * Engine exclusivity: the registry holds ONE managed instance — a record for
 * the OTHER engine is stopped first, so Chrome and Lightpanda never fight
 * over the singleton.
 */
export async function launchLocalBrowser(
  options: {
    engine?: LaunchEngine
    chromePath?: string
    chromeArgs?: string
    lightpandaPath?: string
    lightpandaArgs?: string
    localHeadless?: boolean
    userDataDir?: string
    statePath?: string
    timeoutMs?: number
    platform?: string
  },
  io?: LaunchIo,
): Promise<LaunchOutcome> {
  const ioImpl = { ...defaultIo(), ...(io ?? {}) }
  const now = ioImpl.now
  const sleep = ioImpl.sleep
  const statePath = options.statePath ?? defaultLauncherStatePath()
  const engine = options.engine === 'lightpanda' ? 'lightpanda' : 'chrome'
  const platform = options.platform ?? process.platform

  // T2.13 — reuse only OUR recorded instance, and only while it still answers
  // — and only when it is the SAME engine the caller asked for.
  const record = readRecord(statePath, ioImpl)
  if (record && record.engine !== engine && ioImpl.isAlive(record.pid)) {
    // Engine switch: the previous managed instance loses the singleton slot.
    ioImpl.killTree(record.pid)
    ioImpl.removeFile(statePath)
  }
  const live = readRecord(statePath, ioImpl)
  if (live && live.engine === engine && ioImpl.isAlive(live.pid) && (await ioImpl.fetchVersion(`http://127.0.0.1:${live.port}/json/version`)).ok) {
    return { ok: true, reused: true, endpoint: live.endpoint, pid: live.pid, port: live.port }
  }

  let bin: string
  let spawnEnv: Record<string, string> | undefined
  if (engine === 'lightpanda') {
    bin = discoverLightpandaBinary(options.lightpandaPath ?? '', platform, ioImpl.exists)
    if (bin === '') {
      return {
        ok: false,
        code: 'binary-not-found',
        message: 'wsl.exe not found — Lightpanda has no native Windows build. Install WSL2 (`wsl --install` as admin), then inside WSL: `curl -fsSL https://pkg.lightpanda.io/install.sh | bash`.',
      }
    }
    spawnEnv = lightpandaSpawnEnv(platform)
  } else {
    bin = discoverChromeBinary(options.chromePath ?? '', platform, ioImpl.exists)
    if (bin === '') {
      return { ok: false, code: 'chrome-not-found', message: 'No Chrome/Chromium/Edge binary found. Set chromePath in the settings panel.' }
    }
  }

  const userDataDir = options.userDataDir && options.userDataDir !== '' ? options.userDataDir : defaultManagedProfileDir()
  const port = await ioImpl.makePort()
  let spawnBin: string
  let args: readonly string[]
  if (engine === 'lightpanda') {
    // The port is only known after makePort — assemble the serve argv now.
    const full = buildEngineArgv({ engine, platform, bin, serveArgs: buildServeArgs({ port, lightpandaArgs: options.lightpandaArgs }) })
    spawnBin = full[0]!
    args = full.slice(1)
  } else {
    spawnBin = bin
    args = buildLaunchArgs({ userDataDir, port, headless: options.localHeadless === true, chromeArgs: options.chromeArgs })
  }

  let pid = 0
  try {
    pid = ioImpl.spawn(spawnBin, args as string[], spawnEnv).pid
  } catch (error) {
    return { ok: false, code: 'spawn-failed', message: String((error as Error).message ?? error) }
  }
  if (!pid) return { ok: false, code: 'spawn-failed', message: 'spawn returned no pid' }

  const endpoint = `http://127.0.0.1:${port}`
  const engineName = engine === 'lightpanda' ? 'lightpanda' : 'chrome'
  const deadline = now() + (options.timeoutMs ?? 20000)
  for (;;) {
    if (!ioImpl.isAlive(pid)) {
      return { ok: false, code: 'launch-exited', message: `${engineName} exited before opening the debugging port (pid ${pid})${engine === 'lightpanda' && platform === 'win32' ? ' — is lightpanda installed inside WSL? (`wsl` then `curl -fsSL https://pkg.lightpanda.io/install.sh | bash`)' : ''}` }
    }
    let versionOk = false
    try { versionOk = (await ioImpl.fetchVersion(`${endpoint}/json/version`)).ok } catch { /* not up yet */ }
    if (versionOk) break
    if (now() >= deadline) {
      ioImpl.killTree(pid)
      ioImpl.removeFile(statePath)
      return { ok: false, code: 'not-ready', message: `${engineName} did not answer ${endpoint}/json/version within the readiness window` }
    }
    await sleep(250)
  }

  ioImpl.writeFile(statePath, JSON.stringify({
    pid, port, userDataDir, endpoint, startedAt: now(),
    headless: options.localHeadless === true,
    engine,
  } satisfies LauncherRecord & { headless: boolean }, null, 2))
  return { ok: true, reused: false, endpoint, pid, port }
}

/**
 * Stop the managed instance: kill-tree, wait for the pid to disappear, drop
 * the registry entry. T2.14 — the reaper and plugin unmount both call this.
 * Lightpanda on win32 rides `wsl.exe`, and taskkill /T does not reach the
 * Linux-side process — add a targeted pkill of OUR serve argv as backstop.
 */
export async function stopLocalBrowser(
  options: { statePath?: string; graceMs?: number } = {},
  io?: LaunchIo,
): Promise<{ ok: boolean; code: string }> {
  const ioImpl = { ...defaultIo(), ...(io ?? {}) }
  const statePath = options.statePath ?? defaultLauncherStatePath()
  const record = readRecord(statePath, ioImpl)
  if (!record) return { ok: true, code: 'not-running' }
  if (ioImpl.isAlive(record.pid)) {
    ioImpl.killTree(record.pid)
    if (record.engine === 'lightpanda' && process.platform === 'win32') {
      try {
        nodeSpawn('wsl.exe', ['--', 'sh', '-c', `pkill -f 'lightpanda serve --host 127.0.0.1 --port ${record.port}' || true`], { stdio: 'ignore' }).unref()
      } catch { /* best-effort */ }
    }
    const deadline = ioImpl.now() + (options.graceMs ?? 5000)
    while (ioImpl.isAlive(record.pid) && ioImpl.now() < deadline) {
      await ioImpl.sleep(100)
    }
    if (ioImpl.isAlive(record.pid)) return { ok: false, code: 'stop-timeout' }
  }
  ioImpl.removeFile(statePath)
  return { ok: true, code: 'stopped' }
}

/** Is a managed local browser alive right now? (reaper + doctor helper) */
export function localBrowserInfo(statePath?: string, io?: LaunchIo): { endpoint: string; pid: number } | null {
  const ioImpl = { ...defaultIo(), ...(io ?? {}) }
  const record = readRecord(statePath ?? defaultLauncherStatePath(), ioImpl)
  if (!record || !ioImpl.isAlive(record.pid)) return null
  return { endpoint: record.endpoint, pid: record.pid }
}
