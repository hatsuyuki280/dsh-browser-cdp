import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildLaunchArgs, buildServeArgs, discoverChromeBinary, discoverLightpandaBinary, launchLocalBrowser, stopLocalBrowser, WSL_LAUNCH } from '../src/cdp/launcher.ts'

/** T2.12 — binary discovery is platform-table driven with explicit override. */
describe('launcher binary discovery', () => {
  const existsFor = (present: readonly string[]) => (p: string) => present.includes(p)
  it('prefers the explicit chromePath when it exists', () => {
    expect(discoverChromeBinary('C:/x/chrome.exe', 'win32', existsFor(['C:/x/chrome.exe']))).toBe('C:/x/chrome.exe')
  })
  it('returns empty when the explicit path does not exist (no silent guess)', () => {
    expect(discoverChromeBinary('C:/missing/chrome.exe', 'win32', existsFor([]))).toBe('')
  })
  it('walks the platform table in order', () => {
    expect(discoverChromeBinary('', 'linux', existsFor(['/usr/bin/chromium']))).toBe('/usr/bin/chromium')
    expect(discoverChromeBinary('', 'linux', existsFor([]))).toBe('')
  })
})

/** T2.12 — the managed launch strips forbidden user flags. */
describe('launcher args assembly', () => {
  it('adds port/profile/base flags and filters BLOCKED user args', () => {
    const args = buildLaunchArgs({
      userDataDir: 'C:/profile', port: 9333, headless: false,
      chromeArgs: '--lang=zh --user-data-dir=C:/evil --remote-debugging-port=1 --headless --proxy-server=x --force-dark',
    })
    expect(args).toContain('--remote-debugging-port=9333')
    expect(args).toContain('--user-data-dir=C:/profile')
    expect(args).toContain('--no-first-run')
    expect(args).toContain('--force-dark')
    expect(args.join(' ')).not.toContain('--user-data-dir=C:/evil')
    expect(args.join(' ')).not.toContain('--remote-debugging-port=1 --')
    expect(args.join(' ')).not.toContain('--headless')
    expect(args.join(' ')).not.toContain('--proxy-server')
  })
  it('honours localHeadless with the legacy headless flag', () => {
    const args = buildLaunchArgs({ userDataDir: 'p', port: 1, headless: true })
    expect(args).toContain('--headless')
    expect(args).not.toContain('--headless=new')
  })
})

/** T2.12/T2.13 — launch readiness + singleton reuse, all IO injected. */
describe('launcher lifecycle', () => {
  function fakeIo(options: { port?: number; pid?: number; failFirstProbes?: number; bin?: string } = {}) {
    const bin = options.bin ?? 'C:/x/chrome.exe'
    let probes = 0
    const calls: string[] = []
    const spawned: Array<{ bin: string; args: readonly string[] }> = []
    const state: Record<string, string> = {}
    const alive = new Set<number>([])
    const io = {
      exists: (p: string) => p in state || p === bin,
      readFile: (p: string) => state[p],
      writeFile: (p: string, d: string) => { state[p] = d },
      removeFile: (p: string) => { delete state[p] },
      isAlive: (pid: number) => alive.has(pid),
      killTree: (pid: number) => { alive.delete(pid); calls.push(`kill:${pid}`) },
      spawn: (bin: string, args: readonly string[]) => {
        const pid = options.pid ?? 4242
        spawned.push({ bin, args }); alive.add(pid); calls.push(`spawn:${bin}`)
        return { pid }
      },
      fetchVersion: async (url: string) => {
        probes += 1
        if (probes <= (options.failFirstProbes ?? 0)) return { ok: false }
        if (url.includes(String(options.port))) return { ok: true }
        return { ok: false }
      },
      now: (() => { let t = 1000; return () => (t += 300) })(),
      sleep: async () => undefined,
      makePort: async () => options.port ?? 9444,
    }
    return { io, spawned, calls, state }
  }

  it('launches, becomes ready, and records the singleton', async () => {
    const f = fakeIo({ port: 9444, pid: 4242 })
    const out = await launchLocalBrowser({ chromePath: 'C:/x/chrome.exe', localHeadless: true, statePath: 'C:/fake/launcher.json' }, f.io)
    expect(out).toMatchObject({ ok: true, reused: false, pid: 4242, port: 9444 })
    expect(f.spawned[0]!.args.join(' ')).toContain('--headless')
    expect(f.spawned[0]!.args.join(' ')).not.toContain('--headless=new')
    expect(f.state['C:/fake/launcher.json']).toContain('"pid": 4242')
  })

  it('reuses a live recorded instance instead of spawning again (T2.13)', async () => {
    const f = fakeIo({ port: 9444, pid: 4242 })
    const first = await launchLocalBrowser({ chromePath: 'C:/x/chrome.exe', statePath: 'C:/fake/launcher.json' }, f.io)
    expect(first.ok).toBe(true)
    const second = await launchLocalBrowser({ chromePath: 'C:/x/chrome.exe', statePath: 'C:/fake/launcher.json' }, f.io)
    expect(second).toMatchObject({ ok: true, reused: true, pid: 4242 })
    expect(f.spawned).toHaveLength(1)
  })

  it('reports launch-exited when chrome dies before the port answers', async () => {
    const f = fakeIo({ port: 9444, pid: 4242 })
    const io = { ...f.io, isAlive: () => false }
    const out = await launchLocalBrowser({ chromePath: 'C:/x/chrome.exe', statePath: 'C:/fake/launcher.json' }, io)
    expect(out).toMatchObject({ ok: false, code: 'launch-exited' })
  })

  it('reports not-ready past the deadline and kills the half-started tree', async () => {
    const f = fakeIo({ port: 9444, pid: 4242, failFirstProbes: 999 })
    const out = await launchLocalBrowser({ chromePath: 'C:/x/chrome.exe', statePath: 'C:/fake/launcher.json', timeoutMs: 1 }, f.io)
    expect(out).toMatchObject({ ok: false, code: 'not-ready' })
    expect(f.calls).toContain('kill:4242')
  })

  it('stop kills the recorded tree and drops the registry (T2.14)', async () => {
    const f = fakeIo({ port: 9444, pid: 4242 })
    await launchLocalBrowser({ chromePath: 'C:/x/chrome.exe', statePath: 'C:/fake/launcher.json' }, f.io)
    f.io.isAlive = () => false
    const stop = await stopLocalBrowser({ statePath: 'C:/fake/launcher.json' }, f.io)
    expect(stop).toMatchObject({ ok: true, code: 'stopped' })
    expect(f.io.exists('C:/fake/launcher.json')).toBe(false)
  })
})

/** Lightpanda backend — serve engine: discovery / argv / launch / exclusivity. */
describe('lightpanda managed serve', () => {
  const existsFor = (present: readonly string[]) => (p: string) => present.includes(p)
  function lpIo(options: { platform: string; onSpawn?: (bin: string, args: readonly string[], env?: Record<string, string>) => void; onKill?: () => void } ) {
    const state: Record<string, string> = {}
    const alive = new Set<number>()
    let probes = 0
    const io = {
      exists: (p: string) => options.platform === 'win32' || p === 'C:/x/chrome.exe' || p.endsWith('.json'), // wsl.exe on win32 / chrome fixture / registry
      readFile: (p: string) => state[p],
      writeFile: (p: string, d: string) => { state[p] = d },
      removeFile: (p: string) => { delete state[p] },
      isAlive: (pid: number) => alive.has(pid),
      killTree: (pid: number) => { alive.delete(pid); options.onKill?.() },
      spawn: (bin: string, args: readonly string[], env?: Record<string, string>) => {
        const pid = 4242
        alive.add(pid)
        options.onSpawn?.(bin, args, env)
        return { pid }
      },
      fetchVersion: async () => {
        probes += 1
        return { ok: probes > 1 } // first read = stale-record check (miss), second = readiness (hit)
      },
      now: (() => { let t = 1000; return () => (t += 300) })(),
      sleep: async () => undefined,
      makePort: async () => 9222,
    }
    return { io, statePath: 'launcher.json', readState: () => state['launcher.json'] }
  }

  it('builds serve args with managed host/port and filters managed user flags', () => {
    const args = buildServeArgs({ port: 9222, lightpandaArgs: '--server-timeout 30 --port 1 --host evil --address x' })
    expect(args).toEqual(['serve', '--host', '127.0.0.1', '--port', '9222', '--server-timeout', '30'])
  })
  it('discovers via wsl sentinel on win32 and install roots on unix', () => {
    expect(discoverLightpandaBinary('', 'win32', existsFor(['C:/Windows/System32/wsl.exe']))).toBe(WSL_LAUNCH)
    expect(discoverLightpandaBinary('', 'win32', existsFor([]))).toBe('')
    expect(discoverLightpandaBinary('/opt/lp', 'linux', existsFor([]))).toBe('/opt/lp')
    expect(discoverLightpandaBinary('', 'linux', existsFor([join(homedir(), '.local', 'bin', 'lightpanda')]))).toBe(join(homedir(), '.local', 'bin', 'lightpanda'))
    expect(discoverLightpandaBinary('', 'linux', existsFor([]))).toBe('lightpanda') // last resort: PATH
  })
  it('launches through wsl.exe on win32 with telemetry env and records the engine', async () => {
    const spawned: Array<{ bin: string; args: readonly string[]; env?: Record<string, string> }> = []
    const h = lpIo({ platform: 'win32', onSpawn: (bin, args, env) => { spawned.push({ bin, args, env }) } })
    const out = await launchLocalBrowser({ engine: 'lightpanda', platform: 'win32', statePath: h.statePath }, h.io)
    expect(out.ok).toBe(true)
    expect(spawned[0]!.bin).toBe('wsl.exe')
    expect(spawned[0]!.args).toEqual(['--', 'lightpanda', 'serve', '--host', '127.0.0.1', '--port', String(out.ok ? out.port : 0)])
    expect(spawned[0]!.env!['LIGHTPANDA_DISABLE_TELEMETRY']).toBe('true')
    expect(spawned[0]!.env!['WSLENV']).toBe('LIGHTPANDA_DISABLE_TELEMETRY/u')
    expect(JSON.parse(h.readState()).engine).toBe('lightpanda')
  })
  it('keeps the engine singleton: a live chrome record is displaced by a lightpanda launch', async () => {
    const calls: string[] = []
    const h = lpIo({ platform: 'linux', onSpawn: () => { calls.push('spawn') }, onKill: () => { calls.push('kill') } })
    await launchLocalBrowser({ engine: 'chrome', platform: 'linux', chromePath: 'C:/x/chrome.exe', statePath: h.statePath }, h.io)
    const out = await launchLocalBrowser({ engine: 'lightpanda', platform: 'linux', statePath: h.statePath }, h.io)
    expect(out.ok).toBe(true)
    expect(calls).toEqual(['spawn', 'kill', 'spawn'])
    expect(JSON.parse(h.readState()).engine).toBe('lightpanda')
  })
})
