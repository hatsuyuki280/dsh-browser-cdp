/**
 * ego-browser �?DSH integration plugin for the ego browser
 * (MIT; provenance and third-party notices in THIRD_PARTY_NOTICES.md).
 *
 * ego is a Chromium browser built for AI agents: agents work in isolated
 * "task spaces" that inherit your real login state without stealing your tabs.
 * The official connection layer is the `ego-browser` CLI: `ego-browser nodejs`
 * reads a JS heredoc on stdin and runs it in a Node runtime with page-driving
 * facades preloaded (page/browser/taskSpaces/site/fetch, raw cdp).
 *
 * This plugin turns that CLI into structured HARNESS tools. Every action tool
 * builds a small script from its arguments, pipes it to `ego-browser nodejs`
 * through ctx.subprocess, and parses the result payload. Scripts target the
 * shared harness facade surface (preloaded by the ego-browser runtime itself):
 * taskSpaces.useOrCreate / .complete, browser.openOrReuseTab, page.info(),
 * page.snapshot(), page.evaluate(), page.waitForTimeout(), page.screenshot(),
 * page.locator(...).click()/.fill(), page.mouse.click(x, y), and the raw cdp().
 * Output is reported through console.log with a sentinel payload.
 *
 * Runtime requirements:
 *   - the `ego-browser` command on PATH (ego lite app, or the
 *     `ego-browser-v2` npm package; Node >= 22), and
 *   - a reachable ego browser (the app is macOS-only today; Linux is on
 *     the ego roadmap).
 *
 * == 文件内部结构（改动前先看 docs/ARCH.md�?=
 *   顶部常量     : SENTINEL / HUMAN_CHECK_PROBE / 默认�? *   withEgoLock  : 全插件互斥锁（工具串行，防争浏览器）
 *   chrome/env   : Chrome 探测 / 环境自适应
 *   runEgoScript : 脚本执行引擎 + 哨兵解析 + 冷启动重�? *   defineEgoTool: t() 工具封装基座（自动加�?+ 重试�? *   registerActionTools   : 大部�?bcdp_* 工具（用 t() 逐个注册�? *   registerHelpAndDoctor : bcdp_help/doctor/script/captcha
 *   EGO_HELP_INDEX / HUMAN_CHECK_PROBE : 工具索引文案 / 人机验证探针
 * 加工具：�?registerActionTools �?reg(t({...}))，并同步 EGO_HELP_INDEX，跑 npm run build�? */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importLoginCookies } from './login-import.ts'
import { initCastServer, initCastWorker, ensureCastWorker, markEgoToolCall, getLastEgoActivity, onEgoActivity, setAttachEndpoint, recycleWorker, readWorkerDiagnostics, printWorkerPdf, requestWatchOpen } from './cast-server.ts'
import { registerEgoBrowserGateway } from './gateway.ts'
import { EGO_HELP_INDEX } from './help.ts'
import { HUMAN_CHECK_PROBE } from './captcha.ts'
import { Config as ConfigSchema, resolveConfig, judgeSettingsOf, EGO_CLI_BLOCKED, CHROME_BLOCKED, filterArgs, DEFAULT_SPACE, AUTO_SPACE_SENTINEL } from './config.ts'
import { installSettingsAuto, registerSettingsBridge } from './settings.ts'
import { BATCH_ORDER, createTierInjector, judgeConfigured, TIER_MEMBERS, toolAllowed, unknownTieredTools, type TierInjector, type TierPolicy } from './toolTiers.ts'
import { getSharedFfmpegInstallationManager } from './ffmpeg-installation.ts'
import { SENTINEL, j, str, num, bool, readAll, SAFE_FN, safeEvalWrap } from './util.ts'
import {
  EGO_LINUX_CDP_URL,
  decideAttach,
  defaultAttachCache,
  emptyAttachState,
  refreshAttach,
  resolveEffectiveLink,
  attachMatchesLink,
  sanitizeLinks,
  type AttachDecision,
  type AttachState,
  type EffectiveLink,
  EGO_CLI_KIND,
  LP_KIND,
} from './cdp-targets.ts'
import { createSubprocessCliIo, mergeCliOutput, resolveCliBinary, spawnArgvFor, type SpawnShape } from './cdp/cli-link.ts'
import { assembleSystemOneBody, buildJudgeRuntime, describeJudge, sendJudge } from './jev/client.ts'
import { makeJudgeEffects } from './jev/effects.ts'
import { runAttempt } from './jev/attempt.ts'
import { DEFAULT_BUDGETS, runLoop } from './jev/loop.ts'
import { buildRound, serializeLaya } from './jev/pipe.ts'
import { chaptersOf } from './jev/frame.ts'
import type { IntentSpec } from './jev/prompt.ts'
import type { Frame } from './jev/frame.ts'
import type { EgoContext, JudgeSettings, RawConfig, ResolvedConfig, SubprocessService, ToolExec, WebServerLike, BrowserLink, CdpMode, LightpandaLink } from './types.ts'

export const name = 'dsh-browser-cdp'
// Platform-aware host services: the web shell exposes `webServer`, other Web
// hosts expose `httpServer`. To keep activation platform-agnostic (TUI /
// headless hosts have neither), neither is a required inject �?the /api/bcdp/*
// watch routes are registered opportunistically via ctx.get('webServer') and
// guarded, so a GUI-less host is a safe no-op. The bcdp_* tools depend only on
// tools + subprocess, present in every host.
export const inject = ['tools', 'subprocess', 'settings']
// Schemastery schema for the composition entry and the declarative settings
// page. Re-exported from config.ts so the cordis loader validates the
// composition layer and (0.1.7) projects the `.volatile()` fields into the
// auto-generated settings form �?no registration call involved.
export const Config = ConfigSchema

/**
 * defineTool's option type recurses through schemastery's `InferObject` and
 * trips TS2321 (excessive stack depth). The option shapes are proven by the
 * original JS, so we cast through `any` at the call sites instead of
 * instantiating the recursive generic.
 */
type DefineToolOpts = any
type ToolHandle = ReturnType<typeof defineTool>

// ── constants ───────────────────────────────────────────────────────────────
/** Vendored ego-linux CLI shipped inside this plugin (runtime/ego-linux/bin/). */
const VENDORED_EGO_BIN = fileURLToPath(
  new URL('../runtime/ego-linux/bin/ego-browser.mjs', import.meta.url),
)
const DEFAULT_EGO_BIN = VENDORED_EGO_BIN
// DEFAULT_SPACE + AUTO_SPACE_SENTINEL now come from ./config.ts so the schema
// default, resolveConfig fold, and the tracker share one definition (A/C).
// C's derived per-session name keeps the historical `dsh-agent-` prefix �?it is
// a distinct generated pattern, not the named-slot default.
const AUTO_SPACE_PREFIX = 'dsh-agent-'
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_GRACE_MS = 15_000
const TOOL_TIMEOUT_MS = 120_000

export interface ActiveSpaceTracker {
  current(): string | number
  opened(args: { name?: string | number }, result: { id?: string | number; name?: string; done?: boolean; [key: string]: unknown }): void
  selected(space: string | number): void
  closed(space: string | number, done: boolean): void
  /** Drop a stale numeric id back to the remembered space name (or default). */
  resetToName(): void
}

/** Build the script that runs the probe and emits a sentinel payload. */
function humanCheckScript(space: string | number): string {
  return (
    `${useSpace(space)}${ensureRealTab()}` +
    `let __hc = null\n` +
    `try { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}) } catch { __hc = null }\n` +
    `console.log('${SENTINEL}' + JSON.stringify({ ok: true, humanCheck: __hc }))\n`
  )
}

export function createActiveSpaceTracker(defaultSpace: string | number = DEFAULT_SPACE): ActiveSpaceTracker {
  let activeSpace: string | number = defaultSpace
  let activeName: string | null = typeof defaultSpace === 'string' ? defaultSpace : null
  return {
    current: () => activeSpace,
    opened: (args, result) => {
      activeName = result?.name ?? str(args?.name, defaultSpace as string) ?? null
      activeSpace = result?.id ?? activeName ?? defaultSpace
    },
    selected: (space) => {
      if (space !== undefined && space !== '') {
        activeSpace = space
        activeName = typeof space === 'string' ? space : null
      }
    },
    closed: (space, done) => {
      if (done && (String(space) === String(activeSpace) || (activeName !== null && String(space) === String(activeName)))) {
        activeSpace = defaultSpace
        activeName = typeof defaultSpace === 'string' ? defaultSpace : null
      }
    },
    // A browser restart resets the runtime's space table, leaving the
    // remembered NUMERIC id dangling �?the runtime then hard-fails every
    // tool with "task space not found: N" until the user manually reopens a
    // space. Falling back to the space's NAME lets useOrCreate recreate it.
    resetToName: () => {
      activeSpace = activeName ?? defaultSpace
    },
  }
}

/**
 * B �?the session-keyed form of the tracker. Two DSH agents driving the same
 * browser each get their own slot, so "the most recently opened space" for one
 * agent never bleeds into the other. The public surface is identical to
 * `createActiveSpaceTracker` (every method routes to the CURRENT session's
 * slot), so `runWithStaleSpaceRetry` / `afterExecute` need no per-call-site
 * change �?only `setCurrentSession` is injected once per execute, inside the
 * already-global `withEgoLock` (which keeps the slot choice race-free).
 *
 * `defaultNameFor(sessionKey)` resolves the fallback slot name for a session �? * this is where C's `:auto` �?`dsh-agent-<sid8>` derivation lives. It is a
 * closure over the live config, so a volatile `defaultSpace` / `isolateSpaces`
 * edit is reflected on the NEXT freshly-created slot.
 */
export interface SessionSpaceTracker extends ActiveSpaceTracker {
  setCurrentSession(id: string | undefined): void
  currentSession(): string | undefined
}

export const GLOBAL_SESSION_KEY = '__global__'

/**
 * C — resolve the fallback slot name for a session.
 *
 * v1.6.0 — SESSION ISOLATION IS THE DEFAULT. `defaultSpace` ships as `:auto`,
 * so a call that omits `space` lands in a per-session task space
 * `dsh-agent-<sid8>` instead of the shared `default` slot. The sentinel is
 * honoured regardless of `isolateSpaces`, because space NAMING and PROFILE
 * persistence are two different axes: `isolateSpaces` only decides whether the
 * browser profile lives on disk or in an in-memory sandbox.
 *
 * A caller that deliberately wants the shared slot sets `defaultSpace` to a
 * named value (e.g. `default`) or passes `space: 'default'` on a call — the
 * tracker then pins that session to it. Calls carrying NO session id always
 * fall back to the named shared slot so pre-existing behaviour keeps working.
 * Any other configured value passes through verbatim.
 * @internal exported for tests
 */
export function deriveSlotDefaultName(
  rc: { defaultSpace: string; isolateSpaces: boolean },
  sessionKey: string,
): string {
  const name = rc.defaultSpace
  if (name === AUTO_SPACE_SENTINEL) {
    if (sessionKey === GLOBAL_SESSION_KEY) return DEFAULT_SPACE
    return AUTO_SPACE_PREFIX + sessionSpaceToken(sessionKey)
  }
  return name
}

/**
 * A stable, space-name-safe 8-char token for a DSH session id.
 *
 * DSH session ids look like `session-52adc205-3251-…`, so the old
 * `slice(0, 8)` yielded the literal `session-` for EVERY session — silently
 * collapsing all sessions into one space, i.e. exactly the failure this
 * feature exists to prevent. The known prefix is stripped and
 * hyphens kept, other non-alphanumerics dropped, then sliced to 8; a short id
 * is used as-is (still unique), and only a degenerate/empty id falls back to a
 * deterministic FNV-1a hash so the name is never empty.
 * @internal exported for tests
 */
export function sessionSpaceToken(sessionId: string): string {
  // Keep hyphens (a space name may contain them, and it stays readable);
  // drop everything else so the token is always a legal space name.
  const bare = sessionId.replace(/^session-/, '').replace(/[^A-Za-z0-9-]/g, '')
  if (bare.length > 0) return bare.slice(0, 8)
  // An empty/degenerate id still needs a non-empty, deterministic token.
  let h = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i += 1) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0').slice(0, 8)
}

export function createSessionSpaceTracker(
  defaultNameFor: (sessionKey: string) => string | number = () => DEFAULT_SPACE,
): SessionSpaceTracker {
  interface Slot { activeSpace: string | number; activeName: string | null }
  const slots = new Map<string, Slot>()
  let sessionKey: string = GLOBAL_SESSION_KEY
  let session: string | undefined
  const slotOf = (key: string): Slot => {
    let s = slots.get(key)
    if (!s) {
      const def = defaultNameFor(key)
      s = { activeSpace: def, activeName: typeof def === 'string' ? def : null }
      slots.set(key, s)
    }
    return s
  }
  // Slots are keyed by session id; the number of concurrent agents is small and
  // bounded, so retention (no eviction) is intentional �?a WeakMap over string
  // keys is impossible and a LRU would drop a paused agent's remembered space.
  const withSlot = (fn: (s: Slot, def: string | number) => void): void => {
    const s = slotOf(sessionKey)
    fn(s, defaultNameFor(sessionKey))
  }
  return {
    setCurrentSession: (id) => {
      session = id
      sessionKey = id ?? GLOBAL_SESSION_KEY
    },
    currentSession: () => session,
    current: () => slotOf(sessionKey).activeSpace,
    opened: (args, result) => {
      withSlot((s, def) => {
        s.activeName = result?.name ?? str(args?.name, def as string) ?? null
        s.activeSpace = result?.id ?? s.activeName ?? def
      })
    },
    selected: (space) => {
      if (space !== undefined && space !== '') {
        withSlot((s) => {
          s.activeSpace = space
          s.activeName = typeof space === 'string' ? space : null
        })
      }
    },
    closed: (space, done) => {
      withSlot((s, def) => {
        if (done && (String(space) === String(s.activeSpace) || (s.activeName !== null && String(space) === String(s.activeName)))) {
          s.activeSpace = def
          s.activeName = typeof def === 'string' ? def : null
        }
      })
    },
    resetToName: () => {
      withSlot((s, def) => { s.activeSpace = s.activeName ?? def })
    },
  }
}

// ── serialization ───────────────────────────────────────────────────────────
/**
 * The bundled runtime host is a single persistent browser shared by every tool call;
 * concurrent tool executions would race on the same task space / tabs. All
 * bcdp_* executions are therefore serialized through one in-process lock. This
 * guards against concurrent tool calls within this plugin instance; separate
 * harness sessions sharing the same browser remain unsupported (host-level).
 */
let egoLockChain: Promise<unknown> = Promise.resolve()
function withEgoLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = egoLockChain.then(
    () => fn(),
    () => fn(),
  ) as Promise<T>
  egoLockChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ── environment self-adaptation ──────────────────────────────────────────────
/**
 * Build the env handed to `ego-browser nodejs` spawns.
 *
 * The vendored ego-linux CLI reads EGO_LINUX_CHROME (bare Chrome binary/wrapper
 * path) and EGO_LINUX_HEADLESS (=1 to run headless) from the process env. When a
 * host does not set them �?the common case on root / Docker / CI boxes �?Chrome
 * silently fails to start, and consumers see a 20s `DevTools port` timeout.
 *
 * This function makes the plugin self-sufficient WITHOUT touching the host or
 * other plugins:
 *
 *  - It is a pure function: only reads the current process env, never mutates
 *    it, never writes files, and returns a fresh env to pass to the one spawn.
 *  - It INCREMENTALLY FILLS GAPS: it uses `??` on every value, so an env var the
 *    user already set is always respected and never overridden ("user wins").
 *  - It only compensates for missing pieces, so behavior on a correctly set-up
 *    host is byte-for-byte identical to before.
 *  - It is idempotent: the same env yields the same result every call.
 *  - An opt-out switch EGO_BROWSER_AUTO_ADAPT (set to "0"/"false"/"no") restores
 *    the original "inherit host env verbatim" behavior.
 */
/** 阶段 10 �?the render worker: the ONLY thing that can see a page. */
const RENDER_WORKER_BIN = fileURLToPath(new URL('../bin/cdp-render-worker.mjs', import.meta.url))
const BUNDLED_WRAPPER = fileURLToPath(
  new URL('../bin/cdp-chrome-wrapper.sh', import.meta.url),
)
const IS_WIN = process.platform === 'win32'
const AUTO_ADAPT_OFF = /^(0|false|no)$/i.test(
  process.env.EGO_BROWSER_AUTO_ADAPT ?? '',
)
const COMMON_CHROME_BINS = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/google-chrome',
]
/** Windows registry-free probe of the usual install dirs (no subprocess). */
function windowsChromeCandidates(): string[] {
  const pf = process.env.ProgramFiles
  const pfx86 = process.env['ProgramFiles(x86)']
  const local = process.env.LOCALAPPDATA
  const base =
    local ||
    `${process.env.USERPROFILE || process.env.HOME || ''}\\AppData\\Local`
  const b = (p: string | undefined): string | undefined => (p ? p.replace(/\\+$/, '') : p)
  const out = [
    b(pf) + '\\Google\\Chrome\\Application\\chrome.exe',
    b(pfx86) + '\\Google\\Chrome\\Application\\chrome.exe',
    b(local) + '\\Google\\Chrome\\Application\\chrome.exe',
    b(pf) + '\\Microsoft\\Edge\\Application\\msedge.exe',
    b(pfx86) + '\\Microsoft\\Edge\\Application\\msedge.exe',
    b(local) + '\\Microsoft\\Edge\\Application\\msedge.exe',
    b(pfx86) + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    b(local) + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ]
  return out.filter(Boolean) as string[]
}
/** Find a usable Chrome binary by scanning PATH + common fixed locations. */
export function findChromeBinary(): string | undefined {
  if (process.env.EGO_LINUX_CHROME) {
    return process.env.EGO_LINUX_CHROME
  }
  // Windows: probe install dirs first, then walk PATH with %PATHEXT%.
  if (IS_WIN) {
    for (const p of windowsChromeCandidates()) {
      try {
        if (existsSync(p)) {
          return p
        }
      } catch {
        // fall through
      }
    }
    const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .filter(Boolean)
      .map((e) =>
        e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
      )
    const dirs = (process.env.PATH ?? '')
      .split(';')
      .map((d) => d.replace(/^"|"$/g, ''))
      .filter(Boolean)
    for (const dir of dirs) {
      for (const name of ['chrome', 'msedge', 'brave']) {
        for (const ext of exts) {
          try {
            const p = `${dir}\\${name}${ext}`
            if (existsSync(p)) {
              return p
            }
          } catch {
            // fall through
          }
        }
      }
    }
    return undefined
  }
  // POSIX: absolute + PATH walk.
  for (const name of COMMON_CHROME_BINS) {
    if (name.includes('/')) {
      try {
        if (existsSync(name)) {
          return name
        }
      } catch {
        // fall through
      }
    } else {
      for (const dir of (process.env.PATH ?? '').split(':')) {
        if (!dir) {
          continue
        }
        const p = `${dir}/${name}`
        try {
          if (existsSync(p)) {
            return p
          }
        } catch {
          // fall through
        }
      }
    }
  }
  return undefined
}
/** Root detection only makes sense on POSIX; Windows doesn't gate on sandbox. */
function isPosixRoot(platform: NodeJS.Platform = process.platform): boolean {
  const uid = process.getuid?.()
  return typeof uid === 'number' && uid === 0 && platform !== 'win32'
}
/** No display server �?headless is required (Linux/macOS headless servers). */
function isHeadlessDetected(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  // Windows and macOS always have a desktop session; only Linux headless servers need to run the backing browser headless.
  if (platform === 'win32' || platform === 'darwin') {
    return false
  }
  return env.DISPLAY === undefined || env.DISPLAY === ''
}
/**
 * Build the env handed to `ego-browser nodejs` spawns. See the block comment
 * above ("environment self-adaptation") for the design contract.
 *
 * Platform/env are injectable for testing; production calls use process defaults.
 */
export function resolveEgoEnv(cfg: Partial<ResolvedConfig>, { platform = process.platform, baseEnv = process.env }: { platform?: NodeJS.Platform; baseEnv?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  if (AUTO_ADAPT_OFF) {
    // New switch explicitly disabled: original behavior, inherit verbatim.
    return baseEnv
  }
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  // Electron hosts (DSH Desktop): process.execPath is the Electron binary, and
  // every spawn below passes this explicit env �?without ELECTRON_RUN_AS_NODE=1
  // the child boots as a second Electron app instead of running the script
  // (empty stderr, no @@DSH_RESULT@@ sentinel; issue #42). User-set value wins.
  if ((process.versions as { electron?: string }).electron && env.ELECTRON_RUN_AS_NODE === undefined) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  const chrome = findChromeBinary()
  // Settings-configured chrome path (highest priority after user-set env).
  // An empty string means "auto-detect" �?skip so the platform branches below
  // can run.
  const configChrome = cfg?.chromePath
  if (env.EGO_LINUX_CHROME === undefined && configChrome) {
    env.EGO_LINUX_CHROME = configChrome
  }
  // Root / Docker / CI: Chrome refuses to run without --no-sandbox. The
  // wrapper execs the real binary with --no-sandbox (EGO_LINUX_CHROME takes a
  // bare path, so a wrapper is required). Never override a user-set value.
  if (env.EGO_LINUX_CHROME === undefined && isPosixRoot(platform) && chrome) {
    env.EGO_LINUX_CHROME = BUNDLED_WRAPPER
  }
  // Windows: no --no-sandbox needed (Windows Chrome has no sandbox gate), and
  // the bundled wrapper is a POSIX shell script that cannot run here. Pass the
  // binary path directly so the vendored runtime (which uses POSIX `which`)
  // doesn't have to resolve it itself.
  if (env.EGO_LINUX_CHROME === undefined && platform === 'win32' && chrome) {
    env.EGO_LINUX_CHROME = chrome
  }
  // Headless servers (no DISPLAY) must run the backing browser headless.
  if (env.EGO_LINUX_HEADLESS === undefined && isHeadlessDetected(platform, env)) {
    env.EGO_LINUX_HEADLESS = '1'
  }
  // User-configured extra Chrome args (settings field `chromeArgs`). Bridge to
  // EGO_LINUX_EXTRA_ARGS, which the vendored runtime's launch() spreads into
  // the Chrome argv. A user-set env var wins (escape hatch for power users).
  // The value is the RAW string; the runtime tokenizes + filters it so the
  // same blocklist applies on both sides of the boundary.
  const configChromeArgs = cfg?.chromeArgs
  if (env.EGO_LINUX_EXTRA_ARGS === undefined && typeof configChromeArgs === 'string' && configChromeArgs.trim() !== '') {
    env.EGO_LINUX_EXTRA_ARGS = configChromeArgs
  }
  if (env.EGO_ISOLATE_SPACES === undefined && cfg?.isolateSpaces !== undefined) {
    env.EGO_ISOLATE_SPACES = cfg.isolateSpaces ? '1' : '0'
  }
  // ── R1: point the runtime at the ACTIVATED CDP target ───────────────────
  // `resolveEgoEnv` stays synchronous (every spawn site calls it inline), so
  // it reads the attach cache that the host refreshes whenever settings
  // change �?see the `triggerCdpRefresh` wiring in apply(). The cache, not
  // this function, owns the probe; this function only applies the decision.
  const decision = decideCdpAttach(cfg)
  if (decision.kind === 'inject') {
    env[EGO_LINUX_CDP_URL] = decision.wsUrl
  } else if (decision.kind === 'local' && cfg.cdpMode === 'local' && env[EGO_LINUX_CDP_URL] === undefined) {
    // Local mode's managed launcher has a live ws URL in the attach cache.
    // The vendored ego runtime reads EGO_LINUX_CDP_URL; without this bridge
    // local mode starts a browser for the panel but page tools still read a
    // stale browser.json (the exact "CDP channel is not open" failure).
    const local = defaultAttachCache.get()
    if (local.status === 'ready' && local.endpointSource === 'local' && local.wsUrl !== '') {
      env[EGO_LINUX_CDP_URL] = local.wsUrl
    }
  }
  // ── R4: cursor HUD material (drawn into screenshots by the runtime) ─────
  if (env.EGO_LINUX_CURSOR === undefined && cfg?.cursorHud !== undefined) {
    env.EGO_LINUX_CURSOR = cfg.cursorHud ? '1' : '0'
  }
  if (env.EGO_LINUX_CURSOR_NAME === undefined && typeof cfg?.cursorName === 'string' && cfg.cursorName !== '') {
    env.EGO_LINUX_CURSOR_NAME = cfg.cursorName
  }
  return env
}

/**
 * The channel that owns routing right now: `resolveEffectiveLink` over the
 * CURRENT config (activation first, sequence order as the visible fallback),
 * plus the attach cache SCOPED to that link. After any links event
 * (enable/activation toggle, reorder, add, remove) the async refresh may still
 * be probing; a cache row describing the PREVIOUS owner must not leak its
 * linkKind/cliPath/wsUrl into the new channel's spawn decisions.
 */
export function effectiveChannel(cfg: Partial<ResolvedConfig>): { effective: EffectiveLink | null; attach: AttachState } {
  const effective = resolveEffectiveLink(cfg.links ?? [], cfg.activeTargetId ?? '')
  const live = defaultAttachCache.get()
  const attach = effective && attachMatchesLink(live, effective.link) ? live : emptyAttachState()
  return { effective, attach }
}

/**
 * Read the attach decision for the CURRENTLY configured mode/activation.
 * Pure over (cfg, cache) — the decision table itself lives in cdp-targets.ts.
 */
export function decideCdpAttach(cfg: Partial<ResolvedConfig>): AttachDecision {
  const { effective, attach } = effectiveChannel(cfg)
  return decideAttach({
    mode: cfg?.cdpMode ?? 'auto',
    hasActive: effective !== null,
    status: attach.status,
    wsUrl: attach.wsUrl,
    code: attach.code,
    message: attach.message,
    allowLocalFallback: Boolean(cfg?.allowLocalFallback),
    // Config is the source of truth for the remote switch — the cache copy can
    // lag one refresh behind a toggle.
    remoteDisabled: cfg?.remoteEnabled === false,
    // The decision table needs the EFFECTIVE kind (activation or priority
    // fallback), never a kind left over in the cache by a previous owner.
    ...(effective ? { linkKind: effective.link.kind } : {}),
    // M0.9 launcher (stage 2b) is wired: an authorized fallback launches a
    // managed local browser inside refreshAttach (async path), so the sync
    // decision table just needs to know the capability exists.
    localLauncherReady: true,
  })
}

/**
 * Gating helper for every browser-driving spawn. Returns a human-readable
 * reason when the call must NOT reach the runtime, or null when it may
 * proceed. `local` decisions always pass: that is the explicit escape hatch
 * the user asked for.
 */
export function cdpAttachError(cfg: Partial<ResolvedConfig>): string | null {
  const decision = decideCdpAttach(cfg)
  if (decision.kind === 'error') return `${decision.code}: ${decision.message}`
  return null
}
function describeStderr(stderr: string): string {
  const tail = stderr.trim()
  return tail === ''
    ? ''
    : `\n--- ego-browser stderr (tail) ---\n${tail.slice(-2000)}`
}
function describeSpawnFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (
    /ENOENT|spawn .* ENOENT|not found|could not load|cannot find module/i.test(
      msg,
    )
  ) {
    return (
      'ego-browser CLI could not be started. For the vendored runtime, make sure a Chrome/Chromium is reachable (PATH, or set EGO_LINUX_CHROME; root users need a --no-sandbox wrapper, see AGENTS.md). To use an official host instead, set egoBin to your `ego-browser` command. ' +
      msg
    )
  }
  return `failed to start ego-browser: ${msg}`
}
/**
 * Error signatures that indicate a TRANSIENT browser cold-start / channel
 * not-yet-ready problem rather than a real defect. The bundled runtime host is a
 * single persistent Chromium that cold-starts on the first tool call of a
 * session; a probe that arrives while the DevTools/CDP channel is still
 * coming up can fail with one of these. Such failures are safe to retry
 * briefly (the browser keeps warming up in the background). Anything else
 * must pass through immediately �?never mask a genuine error.
 */
const COLD_START_SIGNS = [
  /CDP channel is not open/i,
  /DevTools.*(port|timeout|active)/i,
  /could not connect to/i,
  /browser (was |is )?not (reachable|running|ready)/i,
  /target.*(closed|not found|detached|crashed)/i,
  /ECONNREFUSED/i,
]
function isColdStartError(message: string): boolean {
  return COLD_START_SIGNS.some((re) => re.test(message))
}
interface WarmupResult {
  ok: boolean
  error?: string
  value?: unknown
  stdout: string
  stderr: string
}
/**
 * Run `fn` (a per-call `ego-browser` spawn) up to `tries` times with a short
 * backoff, retrying ONLY when the failure matches a transient cold-start
 * signature. Real errors return on their first occurrence so they are never
 * masked. Each retry re-spawns a fresh process, which is exactly what lets a
 * warmed-up browser connect on a later attempt.
 */
async function withWarmupRetry(fn: () => Promise<WarmupResult>, { tries = 3, baseDelayMs = 600 }: { tries?: number; baseDelayMs?: number } = {}): Promise<WarmupResult> {
  let last: WarmupResult | undefined
  for (let i = 0; i < tries; i++) {
    const result = await fn()
    if (result.ok || !isColdStartError(result.error ?? '')) {
      return result
    }
    last = result
    if (i < tries - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * (i + 1)),
      )
    }
  }
  return last!
}
/**
 * Run an ego script, recovering once from a stale space pointer: a browser
 * restart wipes the runtime's space table, so the tracker's remembered numeric
 * id dangles and the runtime hard-fails with "task space not found: N".
 * Reset the tracker to the space's name (useOrCreate recreates it) and retry.
 */
/**
 * Idle reaper decision (issue #47), pure for tests. Reaps only when the
 * feature is on AND at least one bcdp_* call has ever happened (a never-used
 * browser is not running anyway).
 * @internal exported for tests
 */
export function shouldReapBrowser(nowMs: number, lastActivityMs: number, idleTimeoutMin: number): boolean {
  if (!(idleTimeoutMin > 0) || !(lastActivityMs > 0)) return false
  return nowMs - lastActivityMs > idleTimeoutMin * 60_000
}

/**
 * Pop the agent browser out as a REAL visible window (issue #51). The
 * runtime's `--open` subcommand replaces a headless instance with a headed
 * one on the same profile (tabs restore) or just raises the existing window.
 * `--open` is on the runtimeArgs blocklist only because USER-supplied args
 * must not steal the window �?here it is an explicit user action from the
 * watch panel. --open stops+relaunches when headless, so give it real time.
 */
async function openAgentWindow(ctx: EgoContext, cfg: EgoRuntimeConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const gate = cdpAttachError(cfg)
    if (gate) return { ok: false, error: gate }
    // R4/F11 �?an `ego-cli` link drives the ego lite window the user already
    // has open and can see. There is no headless instance to pop out, and the
    // native CLI does not implement `--open`. Succeed explicitly (with a log)
    // instead of spawning a command that would fail.
    if (effectiveChannel(cfg).effective?.link.kind === EGO_CLI_KIND) {
      ctx.logger?.info?.('dsh-browser-cdp: ego-cli: browser already visible, skipping --open')
      return { ok: true }
    }
    const handle = ctx.subprocess.spawn({
      argv: [...cfg.egoArgvPrefix, '--open'],
      cwd: process.cwd(),
      env: resolveEgoEnv(cfg),
      stdio: {
        stdin: { data: '' },
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 25_000,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) {
      const stderr = readAll(handle.collected.stderr).trim()
      return { ok: false, error: stderr || `ego-browser --open exited with code ${outcome.exitCode}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: describeSpawnFailure(err) }
  }
}

/** @internal exported for tests */
export async function runWithStaleSpaceRetry(  ctx: EgoContext,
  cfg: EgoRuntimeConfig,
  exec: ExecLike,
  buildScript: () => string,
  graceOverrideMs?: number,
): Promise<WarmupResult> {
  let result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs))
  if (!result.ok && /task space not found: \d+/.test(result.error ?? '')) {
    cfg.spaceTracker.resetToName()
    result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs))
  }
  // A relaunched browser keeps the endpoint but mints a new browser id, so the
  // cached ws dead-ends. Re-probe the same links once and retry before failing.
  if (!result.ok && CDP_CONNECT_FAIL_RE.test(result.error ?? '')) {
    const refreshed = await cfg.refreshAttach?.()
    if (refreshed === true) {
      result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs))
    }
  }
  return result
}

/**
 * F — navigate self-heal. A page whose renderer/main thread is wedged makes
 * `page.goto`/`page.reload` hang until the subprocess times out, and the SAME
 * stuck target is re-selected on the next call, so a plain retry never helps.
 * This revives the tab FIRST (open a fresh blank target, then close the wedged
 * active one — order matters: closing last would trip the last-tab guard and
 * leave the dead tab in place), then retries buildScript exactly once.
 *
 * Hard cap is one revive: a second hung attempt is returned verbatim rather
 * than looping, so a genuine error is never masked by tab churn.
 * @internal exported for tests
 */
export const TAB_STUCK_RE = /no active tab|navigation (?:timed out|timeout)|page\.goto[\s\S]*timeout|timed out after \d+ms|net::ERR_|waiting for (?:document|load) timed out|TimeoutError|target closed/i

/**
 * A dead cached ws (the browser was relaunched behind the SAME endpoint) surfaces
 * as this one runtime message — see `runtime/ego-linux/src/transport.mjs`. It is
 * deliberately NOT folded into `TAB_STUCK_RE`: the fix is a re-probe of the link,
 * not a tab swap, so the two recoveries must stay distinguishable.
 */
export const CDP_CONNECT_FAIL_RE = /failed to connect to CDP endpoint|CDP channel is not open/i

/** True when a failed run looks like a wedged/absent tab rather than a cold start. */
export function isTabStuckFailure(result: WarmupResult): boolean {
  const hay = `${result.error ?? ''}\n${result.stderr ?? ''}`
  return TAB_STUCK_RE.test(hay)
}

/** Heredoc that swaps the stuck target for a fresh blank one (see runWithTabRevive). */
function tabReviveScript(): string {
  return (
    `const __before = await browser.listTabs()\n` +
    `const __stuck = __before.find(t => t.active) ?? __before[0]\n` +
    `await browser.openOrReuseTab('about:blank', { wait: true, timeout: 8000 })\n` +
    `if (__stuck) { await browser.closeTab(__stuck.targetId) }\n` +
    `console.log('${SENTINEL}' + JSON.stringify({ ok: true, revived: true, closed: __stuck?.targetId ?? null }))\n`
  )
}

/**
 * @internal exported for tests. Returns the final WarmupResult plus what it
 * recovered from (null on the normal path, so the tool result always carries
 * a `recoveredFrom` field the model can see).
 */
export async function runWithTabRevive(
  ctx: EgoContext,
  cfg: EgoRuntimeConfig,
  exec: ExecLike,
  buildScript: () => string,
  graceOverrideMs?: number,
): Promise<{ result: WarmupResult; recoveredFrom: string | null }> {
  const first = await runWithStaleSpaceRetry(ctx, cfg, exec, buildScript, graceOverrideMs)
  if (first.ok || !isTabStuckFailure(first)) return { result: first, recoveredFrom: null }
  const recoveredFrom = (first.error ?? first.stderr ?? 'tab stuck').trim().slice(0, 500)
  await runEgoScript(ctx.subprocess, tabReviveScript(), exec, cfg, graceOverrideMs)
  const retried = await runWithStaleSpaceRetry(ctx, cfg, exec, buildScript, graceOverrideMs)
  return { result: retried, recoveredFrom }
}
/**
 * Find the last line carrying the sentinel and JSON-parse its payload.
 *
 * Fallback: `bcdp_script` (with verbatim:true) runs user-authored heredocs, which
 * tool descriptions tell the model to "end with console.log(JSON.stringify(...))"
 * �?without the sentinel prefix. A script written to that instruction used to
 * succeed and still be reported as a failure ("no @@DSH_RESULT@@ payload"), so
 * when no sentinel line exists we accept the last line that parses as a JSON
 * object. The sentinel still wins whenever it is present (it marks the payload
 * deliberately, across any amount of surrounding log noise).
 *
 * @internal exported for tests
 */
export function parseSentinel(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i]!.indexOf(SENTINEL)
    if (idx === -1) continue
    const payload = lines[i]!.slice(idx + SENTINEL.length).trim()
    try {
      return JSON.parse(payload) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  // Sentinel absent (or its line was malformed): accept a bare JSON object.
  // Depth-scanned rather than line-scanned, because console.log(JSON.stringify(x,
  // null, 2)) �?the most natural thing to write �?spans many lines, and the
  // earlier line-based fallback silently missed it.
  return lastJsonObject(stdout)
}

/**
 * The last balanced `{...}` run in `text` that parses as a JSON object.
 *
 * Tracks double-quoted strings (JSON's only string syntax) so braces inside a
 * string value do not unbalance the scan. Invalid candidates are skipped, not
 * fatal: log noise before the payload is common.
 *
 * A candidate must begin its own line (leading whitespace is fine). That keeps
 * pretty-printed payloads working while refusing an object merely mentioned in
 * prose: `[warn] retrying {"attempt":2}` must not become the result, because a
 * silently wrong payload is worse than no payload at all.
 */
function lastJsonObject(text: string): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (c !== '}') continue
    if (depth === 0) continue
    depth -= 1
    if (depth !== 0 || start < 0) continue
    // Only whitespace may sit between the line start and the opening brace.
    let p = start - 1
    while (p >= 0 && (text[p] === ' ' || text[p] === '\t' || text[p] === '\r')) p -= 1
    const atLineStart = p < 0 || text[p] === '\n'
    try {
      const parsed = atLineStart ? (JSON.parse(text.slice(start, i + 1)) as unknown) : null
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        best = parsed as Record<string, unknown>
      }
    } catch {
      /* not a JSON object literal; keep the previous best */
    }
    start = -1
  }
  return best
}

/** R2/R3 �?sentinel + payload for the `bcdp_status` facade probe. @internal exported for tests */
export const STATUS_FACADE_SENTINEL = '__BCDP_STATUS__'
/** @internal exported for tests �?the exact heredoc the status probe runs. */
export const STATUS_FACADE_SCRIPT =
  `console.log(${JSON.stringify(STATUS_FACADE_SENTINEL)} + JSON.stringify({ ` +
  'taskSpaces: typeof taskSpaces, browser: typeof browser, page: typeof page }))\n'

export interface StatusFacades {
  taskSpaces: string
  browser: string
  page: string
}

/**
 * Parse the facade payload the status probe prints; `undefined` if absent.
 * @internal exported for tests
 */
export function parseStatusFacades(stdout: string): StatusFacades | undefined {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i]!.indexOf(STATUS_FACADE_SENTINEL)
    if (idx === -1) continue
    const payload = lines[i]!.slice(idx + STATUS_FACADE_SENTINEL.length).trim()
    try {
      const parsed = JSON.parse(payload) as Partial<StatusFacades>
      return {
        taskSpaces: typeof parsed.taskSpaces === 'string' ? parsed.taskSpaces : 'undefined',
        browser: typeof parsed.browser === 'string' ? parsed.browser : 'undefined',
        page: typeof parsed.page === 'string' ? parsed.page : 'undefined',
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * R7 �?is the old dsh-ego-browser plugin installed anywhere under this DSH home?
 *
 * Reported (never enforced): the two plugins can coexist now that tool names
 * and routes no longer overlap, but both driving ONE local ego browser would
 * fight over the same task spaces, and that plugin's handoff API has no
 * ownership check. A warning is the honest limit of what we can do here.
 */
export function findUpstreamPluginInstall(
  home: string = process.env.HOME || process.env.USERPROFILE || homedir(),
): string {
  const profiles = `${home}/.dsh/profiles`
  try {
    for (const profile of readdirSync(profiles)) {
      const dir = `${profiles}/${profile}/node_modules/dsh-ego-browser`
      if (existsSync(dir)) return dir
    }
  } catch {
    /* no profiles directory: nothing to report */
  }
  return ''
}

/** The live runtime config object built in apply() (getters read the settings bridge). */
interface EgoRuntimeConfig {
  /** Re-probe the active CDP link; true when it produced a NEW endpoint. */
  refreshAttach?: () => Promise<boolean>
  egoBin: string
  configuredDefaultSpace: string | number
  spaceTracker: SessionSpaceTracker
  readonly activeSpace: string | number
  // A/C — mirrors ResolvedConfig.defaultSpace so EgoRuntimeConfig keeps
  // satisfying initCastServer(cfg: ResolvedConfig) (see the structural-mirror
  // note by the judge fields). The live per-session value is `activeSpace`.
  readonly defaultSpace: string
  maxOutputBytes: number
  graceMs: number
  readonly chromePath: string
  readonly captureBackend: ResolvedConfig['captureBackend']
  readonly streamProfile: ResolvedConfig['streamProfile']
  readonly cdpFps: number
  readonly cdpQuality: number
  readonly cdpMaxWidth: number
  readonly cdpBackstopIntervalMs: number
  readonly ffmpegFps: number
  readonly ffmpegMaxWidth: number
  readonly ffmpegBitrateKbps: number
  readonly ffmpegEncoder: ResolvedConfig['ffmpegEncoder']
  readonly ffmpegPath: string
  readonly githubMirror: string
  readonly runtimeArgs: string
  readonly idleTimeoutMin: number
  readonly chromeArgs: string
  readonly isolateSpaces: boolean
  // ── 工具分级注入（src/toolTiers.ts）───────────────────────────────
  readonly toolInjection: ResolvedConfig['toolInjection']
  readonly toolBrowse: boolean
  readonly toolExtended: boolean
  readonly toolEscape: boolean
  readonly toolJudge: boolean
  readonly sessionScopedPulse: boolean
  // ── R1/R7: connection sequence + activation ─────────────────────────────
  readonly links: BrowserLink[]
  /** R7 �?extra `ego-cli` rows that sanitize dropped (local-only singleton). */
  readonly droppedEgoCli: number
  /**
   * R7 �?shape-aware argv prefix for the ego CLI. `[node, <file>]` for the
   * bundled port / `ego-browser-v2`, `[<file>]` for a real executable (the
   * macOS app-bundle helper). Computed from the attach cache, which knows the
   * probed shape.
   */
  readonly egoArgvPrefix: string[]
  readonly activeTargetId: string
  readonly cdpMode: CdpMode
  readonly cdpProbeTimeoutMs: number
  // ── R4: screenshot material toggles ─────────────────────────────────────
  readonly cursorHud: boolean
  readonly cursorName: string
  // ── M0.9 local launcher (optional) ──────────────────────────────────────
  readonly allowLocalFallback: boolean
  readonly legacyEgoToolNames: boolean
  readonly localHeadless: boolean
  readonly remoteEnabled: boolean
  readonly localUserDataDir: string
  /** 探测冷启动闸门（默认关）：关 = ego-cli 探测绝不拉起背后的浏览器。 */
  readonly allowProbeColdStart: boolean
  /** Lightpanda backend �?extra `lightpanda serve` args for managed `lightpanda` rows. */
  readonly lightpandaArgs: string
  // ── 阶段 10: JEV/Laya judge (design-jev-pipeline.md) ────────────────────
  //
  // Listed field-by-field rather than as one `JudgeSettings` object, for a
  // STRUCTURAL reason and not a stylistic one: `EgoRuntimeConfig` hand-mirrors
  // `ResolvedConfig`, and several consumers (`initCastServer`) still take a
  // `ResolvedConfig`. Adding fields here in any other shape makes this type stop
  // satisfying that one. The duplication is the pre-existing design; this stage
  // follows it rather than quietly changing the contract under another module.
  readonly jevUrl: string
  readonly jevKey: string
  readonly jevModel: string
  readonly layaUrl: string
  readonly layaKey: string
  readonly layaModel: string
  readonly judgePrefer: string
  readonly jevChunkSize: number
  readonly jevMaxImageBytes: number
  readonly jevHistoryLimit: number
  readonly jevArchiveImage: boolean
  readonly jevEvaluate: boolean
  readonly jevStepBudget: number
  readonly jevWallMs: number
}

interface ExecLike {
  signal?: AbortSignal
}

/** 常驻级工具看到的工具分级视图（活动脉�?+ 活动�?+ 当前注入面）�?*/
interface TierView {
  pulse: (sessionId?: string) => void
  active: () => boolean
  surface: () => { live: string[]; sealed: string[] }
}

/**
 * R1 �?argv for one tool run. Single source of truth for the `--sdk-path`
 * injection: `bcdp_status` and `runEgoScript` must probe/run under the exact
 * same conditions, otherwise "available" and "actually works" diverge again.
 * @internal exported for tests
 */
export function buildEgoToolArgv(
  prefix: readonly string[],
  attach: { linkKind?: string; sdkPath?: string },
  runtimeArgs: string,
): string[] {
  const extraCliArgs = filterArgs(runtimeArgs, EGO_CLI_BLOCKED)
  // Only an `ego-cli` link that proved the flag works has a non-empty sdkPath
  // (see the R-1 guard in cdp-targets); empty always means "do not inject".
  const sdkArgs =
    attach.linkKind === EGO_CLI_KIND && (attach.sdkPath ?? '') !== ''
      ? ['--sdk-path', attach.sdkPath as string]
      : []
  return [...prefix, 'nodejs', ...sdkArgs, ...extraCliArgs]
}

async function runEgoScript(subprocess: SubprocessService, script: string, exec: ExecLike, cfg: EgoRuntimeConfig, graceOverrideMs?: number): Promise<WarmupResult> {
  let handle
  try {
    // R1 �?an `ego-cli` link that opted into `useSdkPath` must get the same
    // `--sdk-path` injection the probe used. Without it the native CLI has no
    // `taskSpaces`/`browser`/`page` facade and every script dies on line 1.
    const { attach } = effectiveChannel(cfg)
    handle = subprocess.spawn({
      // Run through the node interpreter so the vendored CLI needs no +x bit.
      argv: buildEgoToolArgv(cfg.egoArgvPrefix, attach, cfg.runtimeArgs ?? ''),
      cwd: process.cwd(),
      env: resolveEgoEnv(cfg),
      stdio: {
        stdin: { data: script },
        stdout: {
          maxBytes: cfg.maxOutputBytes,
          spill: { maxBytes: cfg.maxOutputBytes },
        },
        stderr: {
          maxBytes: cfg.maxOutputBytes,
          spill: { maxBytes: cfg.maxOutputBytes },
        },
      },
      graceMs: Number.isFinite(graceOverrideMs) && graceOverrideMs! > 0
        ? graceOverrideMs!
        : cfg.graceMs,
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    })
  } catch (err) {
    return {
      ok: false,
      error: describeSpawnFailure(err),
      stdout: '',
      stderr: '',
    }
  }
  let outcome
  try {
    outcome = await handle.done
  } catch (err) {
    return {
      ok: false,
      error: describeSpawnFailure(err),
      stdout: '',
      stderr: '',
    }
  }
  const stdout = readAll(handle.collected.stdout)
  const stderr = readAll(handle.collected.stderr)
  if (exec.signal !== undefined && exec.signal.aborted) {
    return {
      ok: false,
      error: 'ego-browser tool aborted (harness timeout or cancellation)',
      stdout,
      stderr,
    }
  }
  if (outcome.exitCode !== 0) {
    // When run through the node interpreter, a missing CLI surfaces as a
    // module-load failure with exit 1 instead of a spawn error �?normalize it
    // to the same clear "CLI not available" message.
    const missingModule = /Cannot find module|MODULE_NOT_FOUND/i.test(stderr)
    return {
      ok: false,
      error: missingModule
        ? describeSpawnFailure(new Error(`node could not load ${cfg.egoBin}`))
        : `ego-browser exited with ${
            outcome.exitCode !== null
              ? `code ${outcome.exitCode}`
              : `signal ${String(outcome.signal)}`
          }${describeStderr(stderr)}`,
      stdout,
      stderr,
    }
  }
  const value = parseSentinel(mergeCliOutput({ stdout, stderr }))
  // A script that prints ordinary output and no payload has still run: the
  // sentinel only enriches the result, so the exit code above stays the
  // authority on success. `value` may legitimately be undefined (see toolPayload).
  return { ok: true, value, stdout, stderr }
}
// ── tool plumbing ───────────────────────────────────────────────────────────
/** How much raw stdout a tool may hand back when a script emitted no JSON. */
const TOOL_RAW_STDOUT_MAX = 4000
/**
 * The payload a bcdp_* tool returns for a successful run.
 *
 * Dropping `undefined` straight into the tool result would show the model an
 * empty outcome for a script that actually ran, so fall back to the (bounded)
 * raw stdout plus a note naming the reason. Structured tools always emit a
 * sentinel payload and never take this branch.
 */
function toolPayload(result: WarmupResult): unknown {
  if (result.value !== undefined) return result.value
  return {
    ok: true,
    stdout: (result.stdout ?? '').trim().slice(0, TOOL_RAW_STDOUT_MAX),
    note: 'no JSON payload on stdout; raw output returned',
  }
}
/** JS snippet that pins an action tool to one task space. */
const useSpace = (name: string | number): string =>
  `const task = await taskSpaces.useOrCreate(${j(name)})\n`
/**
 * JS snippet that makes the harness act on a real page tab.
 *
 * The Linux host (PR #234 ego-linux) does not reliably persist "current tab"
 * across CLI invocations: a fresh process sometimes resolves page actions
 * against a blank/stale tab. Selecting the first non-blank tab in the space
 * before acting makes cross-process tool calls deterministic.
 */
const ensureRealTab = (): string =>
  `const __tabs = await browser.listTabs()\n` +
  `const __real = __tabs.find(t => !t.url.startsWith('about:') && !t.url.startsWith('chrome://')) ?? __tabs[0]\n` +
  `if (__real) await browser.switchTab(__real.targetId)\n`
/**
 * G �?a raw heredoc (`bcdp_script` with verbatim:true) that touches `page.*` without
 * first selecting a task space dies with the runtime's "no active tab to attach
 * session". Structured bcdp_* tools never hit this because each wraps its body
 * in `useSpace(...)` + `ensureRealTab()`; a hand-written heredoc has no such
 * preamble. Detect the signature and append a one-line how-to-fix, so the error
 * names the escape (call `taskSpaces.useOrCreate(name)` first) instead of
 * leaving the model to rediscover it.
 * @internal exported for tests
 */
export const ATTACH_SESSION_HINT =
  'hint: call `await taskSpaces.useOrCreate(name)` (and `browser.switchTab(...)` if the space has no real tab) before using page.* in a raw heredoc — structured bcdp_* tools do this for you.'
export function attachSessionHint(errorText: string | undefined): string {
  const t = errorText ?? ''
  if (!/no active tab to attach session/.test(t)) return t
  return t.includes(ATTACH_SESSION_HINT) ? t : `${t}\n${ATTACH_SESSION_HINT}`
}

function renderText(_args: unknown, value: unknown): unknown[] {
  const v = value as Record<string, unknown> | null
  if (
    v !== null &&
    typeof v === 'object' &&
    v.ok === true &&
    typeof v.text === 'string'
  ) {
    return [{ type: 'text', text: v.text }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}
const commonOutputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
  },
}

/**
 * The calling session id �?the scope the client's sidebar auto-open binds to.
 * Read structurally (`exec.agent` is typed `unknown` in this plugin's own
 * seam); a call with no initiating agent simply leaves the open unscoped.
 */
function callingSessionId(exec: ToolExec | undefined): string | undefined {
  const agent = exec?.agent as { session?: { id?: unknown } } | undefined
  const id = agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

interface EgoToolOptions {
  name: string
  description: string
  parameters: Record<string, unknown>
  buildScript: (args: Record<string, unknown>) => string
  afterExecute?: (args: Record<string, unknown>, value: unknown) => void
  /** F: wrap this tool's run in the tab-revive watchdog and tag recoveredFrom. */
  tabRevive?: boolean
  /** Lightpanda backend �?return a blocking reason (or null to allow) checked BEFORE any runtime spawn. */
  gate?: (args: Record<string, unknown>) => string | null
}

function defineEgoTool(ctx: EgoContext, cfg: EgoRuntimeConfig, opts: EgoToolOptions): ToolHandle {
  return defineTool({
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    output: {
      schema: commonOutputSchema,
      render: renderText,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (args: Record<string, unknown>, exec: ToolExec) =>
      withEgoLock(async () => {
        // Signal the client to auto-open the sidebar Tab on the first bcdp_*
        // tool call. markEgoToolCall() bumps a host-side counter surfaced via
        // /api/bcdp/spaces; the LivePreviewController transitions on 0 �?>0 and
        // calls betterSidebar.openTab(). Idempotent: the client's transition
        // guard means only the first call per session opens the Tab.
        cfg.spaceTracker.setCurrentSession(callingSessionId(exec)); markEgoToolCall(callingSessionId(exec))
        // Capability gate: a tool whose dependency face the attached engine
        // cannot satisfy fails HERE �?structured and immediate �?instead of
        // hanging inside the runtime until a timeout.
        if (typeof opts.gate === 'function') {
          const blocked = opts.gate(args)
          if (blocked !== null && blocked !== '') return { ok: false, text: blocked }
        }
        // Stale-space recovery (browser restart wiped the space table) is
        // handled inside runWithStaleSpaceRetry; the cold-start retry is one
        // level deeper.
        if (opts.tabRevive) {
          // F: navigate-specific watchdog — revive a wedged tab once and tag
          // the outcome so the model sees whether recovery fired.
          const { result, recoveredFrom } = await runWithTabRevive(ctx, cfg, exec, () => opts.buildScript(args))
          if (!result.ok) throw new Error(recoveredFrom ? `${result.error}\n${recoveredFrom}` : result.error)
          if (result.value && typeof result.value === 'object') (result.value as Record<string, unknown>).recoveredFrom = recoveredFrom
          if (typeof opts.afterExecute === 'function') opts.afterExecute(args, result.value)
          return toolPayload(result)
        }
        const result = await runWithStaleSpaceRetry(ctx, cfg, exec, () => opts.buildScript(args))
        if (!result.ok) throw new Error(result.error)
        if (typeof opts.afterExecute === 'function') opts.afterExecute(args, result.value)
        // Value is JSON.parse output of our own payload �?fits the tool JSON contract.
        return toolPayload(result)
      }),
    presentCall: () => ({
      card: 'generic',
      title: opts.name,
      kind: 'other',
      rawInput: null,
    }),
  } as unknown as DefineToolOpts)
}

// ── 临时能力探针（计划 bcdp-session-scoped-tiers Phase 0；取证后整块删除）─────
// 目的：证实第三方插件 fiber 能否看到宿主的 agent 作用域能力（`tools.restrict` /
// `agent/created` / `agent.ctx`）。宿主源码里有这些 API 不等于插件能用到。
type ScopeProbe = {
  restrictType: string
  onType: string
  agentsSvc: string
  agentCount: number
  createdEvents: number
  agentHasCtx: string
  agentCtxRestrict: string
  agentCtxTools: string
  error: string
}
const scopeProbe: ScopeProbe = {
  restrictType: 'n/a', onType: 'n/a', agentsSvc: 'n/a', agentCount: -1, createdEvents: 0,
  agentHasCtx: 'n/a', agentCtxRestrict: 'n/a', agentCtxTools: 'n/a', error: '',
}

/** Inspect one agent handle (host-side shape varies) and remember what we reached. */
function probeAgent(agent: any): void {
  if (agent == null) return
  scopeProbe.agentHasCtx = String(agent.ctx != null)
  scopeProbe.agentCtxTools = typeof agent?.ctx?.tools
  scopeProbe.agentCtxRestrict = typeof agent?.ctx?.tools?.restrict
}

/** Install the probe once per mount: capability types + live agent enumeration + lifecycle event. */
function installScopeProbe(ctx: EgoContext): void {
  try {
    const anyCtx = ctx as any
    scopeProbe.restrictType = typeof anyCtx?.tools?.restrict
    scopeProbe.onType = typeof anyCtx?.on
    const agents = typeof anyCtx.get === 'function' ? anyCtx.get('agents') : undefined
    scopeProbe.agentsSvc = agents == null ? 'absent' : 'present'
    if (agents != null) {
      const list =
        typeof agents.roots === 'function' ? agents.roots()
          : typeof agents.list === 'function' ? agents.list() : []
      scopeProbe.agentCount = Array.isArray(list) ? list.length : -2
      probeAgent(Array.isArray(list) ? list[0] : undefined)
    }
    if (scopeProbe.onType === 'function') {
      const off = anyCtx.on('agent/created', (payload: any) => {
        scopeProbe.createdEvents += 1
        probeAgent(payload?.agent ?? payload)
      })
      ctx.effect?.(() => (typeof off === 'function' ? off : () => undefined))
    }
  } catch (err) {
    scopeProbe.error = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)
  }
}

/** One-line render for the doctor report. */
function scopeProbeLine(): string {
  return 'scope probe: ' +
    `tools.restrict=${scopeProbe.restrictType} ctx.on=${scopeProbe.onType} agentsSvc=${scopeProbe.agentsSvc}` +
    ` agentCount=${scopeProbe.agentCount} agentCreatedEvents=${scopeProbe.createdEvents}` +
    ` agentHasCtx=${scopeProbe.agentHasCtx} agent.ctx.tools=${scopeProbe.agentCtxTools}` +
    ` agent.ctx.tools.restrict=${scopeProbe.agentCtxRestrict}` +
    (scopeProbe.error !== '' ? ` error=${scopeProbe.error}` : '')
}

// ── plugin entry ────────────────────────────────────────────────────────────
export function apply(ctx: EgoContext, config: RawConfig = {}): void {
  installScopeProbe(ctx)
  // Install the config bridge first: the composition entry handed to apply()
  // feeds every field into cfg via getters (volatile fields arrive as live
  // refs and are dereferenced per read), so each spawn sees the latest value
  // without re-registration. A plain-field change remounts the plugin and
  // rebuilds this bridge from a fresh apply(); a volatile-only change is
  // delivered through the bridge's onChange (loader/volatile-update).
  // 跨版�?0.1.2/0.1.5 �?installSection 代际,0.1.7+/0.2.0 走声明式 volatile(installEgoBrowserSettings 内部判定)
  const bridge = installSettingsAuto(ctx, config)
  const ffmpegManager = getSharedFfmpegInstallationManager()
  const initialFfmpegConfig = resolveConfig(bridge.source() as RawConfig)
  void ffmpegManager.check({ configuredPath: initialFfmpegConfig.ffmpegPath, requestedEncoder: initialFfmpegConfig.ffmpegEncoder }).catch(() => {
    /* ignore */
  })

  // B/C �?session-keyed tracker. `defaultNameFor` closes over the LIVE config
  // so a volatile `defaultSpace` / `isolateSpaces` edit is reflected on the
  // next freshly-created slot; C's `:auto` �?`dsh-agent-<sid8>` derivation only
  // fires in isolated-sandbox mode (persistent mode collapses to the single
  // named slot, protecting login reuse).
  const spaceTracker = createSessionSpaceTracker((sessionKey) =>
    deriveSlotDefaultName(resolveConfig(bridge.source() as RawConfig), sessionKey),
  )
  // Late-bound handle on the attach re-probe: `cfg` is built before
  // `triggerCdpRefresh` exists, so the retry path reaches it through this ref
  // (assigned right after the IIFE). Undefined until then = "nothing to re-probe",
  // which resolves to a plain `false` and therefore never retries.
  let triggerCdpRef: (() => Promise<boolean>) | undefined
  const cfg: EgoRuntimeConfig = {
    // Re-probe the active link on a dead cached ws (browser relaunched). Read
    // through a late-bound ref: `triggerCdpRefresh` is declared further down in
    // apply(), so closing over it directly here would hit the TDZ.
    refreshAttach: () => triggerCdpRef?.() ?? Promise.resolve(false),
    egoBin:
      typeof config.egoBin === 'string' && config.egoBin !== ''
        ? config.egoBin
        : DEFAULT_EGO_BIN,
    // A �?read the folded default live off the bridge (task_5: GUI edits to the
    // volatile field take effect on the next read, no remount). resolveConfig
    // keeps `:auto` verbatim; the tracker is what knows the sessionId + mode.
    get configuredDefaultSpace() { return resolveConfig(bridge.source() as RawConfig).defaultSpace },
    spaceTracker,
    get defaultSpace() { return resolveConfig(bridge.source() as RawConfig).defaultSpace },
    get activeSpace() { return this.spaceTracker.current() },
    maxOutputBytes: (config.maxOutputBytes as number | undefined) ?? DEFAULT_MAX_OUTPUT_BYTES,
    graceMs: (config.graceMs as number | undefined) ?? DEFAULT_GRACE_MS,
    // Live getter: reads from the settings bridge so GUI edits take effect on
    // the next spawn without restarting the plugin.
    get chromePath() {
      return resolveConfig(bridge.source() as RawConfig).chromePath
    },
    get captureBackend() { return resolveConfig(bridge.source() as RawConfig).captureBackend },
    get streamProfile() { return resolveConfig(bridge.source() as RawConfig).streamProfile },
    get cdpFps() { return resolveConfig(bridge.source() as RawConfig).cdpFps },
    get cdpQuality() { return resolveConfig(bridge.source() as RawConfig).cdpQuality },
    get cdpMaxWidth() { return resolveConfig(bridge.source() as RawConfig).cdpMaxWidth },
    get cdpBackstopIntervalMs() { return resolveConfig(bridge.source() as RawConfig).cdpBackstopIntervalMs },
    get ffmpegFps() { return resolveConfig(bridge.source() as RawConfig).ffmpegFps },
    get ffmpegMaxWidth() { return resolveConfig(bridge.source() as RawConfig).ffmpegMaxWidth },
    get ffmpegBitrateKbps() { return resolveConfig(bridge.source() as RawConfig).ffmpegBitrateKbps },
    get ffmpegEncoder() { return resolveConfig(bridge.source() as RawConfig).ffmpegEncoder },
    get ffmpegPath() { return resolveConfig(bridge.source() as RawConfig).ffmpegPath },
    get githubMirror() { return resolveConfig(bridge.source() as RawConfig).githubMirror },
    // User-defined extra CLI args (see src/config.ts). Live getters so GUI
    // edits take effect on the next spawn / next browser cold start.
    get runtimeArgs() { return resolveConfig(bridge.source() as RawConfig).runtimeArgs },
    get chromeArgs() { return resolveConfig(bridge.source() as RawConfig).chromeArgs },
    get isolateSpaces() { return resolveConfig(bridge.source() as RawConfig).isolateSpaces },
    get idleTimeoutMin() { return resolveConfig(bridge.source() as RawConfig).idleTimeoutMin },
    get toolInjection() { return resolveConfig(bridge.source() as RawConfig).toolInjection },
    get toolBrowse() { return resolveConfig(bridge.source() as RawConfig).toolBrowse },
    get toolExtended() { return resolveConfig(bridge.source() as RawConfig).toolExtended },
    get toolEscape() { return resolveConfig(bridge.source() as RawConfig).toolEscape },
    get toolJudge() { return resolveConfig(bridge.source() as RawConfig).toolJudge },
    get sessionScopedPulse() { return resolveConfig(bridge.source() as RawConfig).sessionScopedPulse },
    // ── R1: CDP sequence + activation ────────────────────────────────────
    get links() { return resolveConfig(bridge.source() as RawConfig).links },
    // Read from the RAW source on purpose: the drop count only exists before
    // resolveConfig folds the sequence, so it cannot come from `links`.
    get droppedEgoCli() {
      const raw = bridge.source() as RawConfig
      return sanitizeLinks(raw.links ?? raw.cdpTargets).droppedEgoCli
    },
    // R7 �?the CLI argv prefix follows the PROBED link: an `ego-cli` link
    // knows its path and spawn shape; everything else keeps the vendored
    // runtime behind the node interpreter.
    get egoArgvPrefix() {
      // Follows the EFFECTIVE channel, cross-checked against the probed cache
      // (same link id): the ego CLI path applies only while the cache actually
      // describes the ego-cli link that owns routing, so a stale row left by a
      // previous owner can never keep hijacking the spawn argv.
      const { effective, attach } = effectiveChannel(this)
      if (effective?.link.kind === EGO_CLI_KIND && attach.cliPath) {
        return spawnArgvFor((attach.cliShape === 'node' ? 'node' : 'direct') as SpawnShape, attach.cliPath, [])
      }
      return [process.execPath, this.egoBin]
    },
    get activeTargetId() { return resolveConfig(bridge.source() as RawConfig).activeTargetId },
    get cdpMode() { return resolveConfig(bridge.source() as RawConfig).cdpMode },
    get cdpProbeTimeoutMs() { return resolveConfig(bridge.source() as RawConfig).cdpProbeTimeoutMs },
    get cursorHud() { return resolveConfig(bridge.source() as RawConfig).cursorHud },
    get cursorName() { return resolveConfig(bridge.source() as RawConfig).cursorName },
    get allowLocalFallback() { return resolveConfig(bridge.source() as RawConfig).allowLocalFallback },
    get legacyEgoToolNames() { return resolveConfig(bridge.source() as RawConfig).legacyEgoToolNames },
    get localHeadless() { return resolveConfig(bridge.source() as RawConfig).localHeadless },
    get remoteEnabled() { return resolveConfig(bridge.source() as RawConfig).remoteEnabled },
    get localUserDataDir() { return resolveConfig(bridge.source() as RawConfig).localUserDataDir },
    get lightpandaArgs() { return resolveConfig(bridge.source() as RawConfig).lightpandaArgs },
    get allowProbeColdStart() { return resolveConfig(bridge.source() as RawConfig).allowProbeColdStart },
    // ── 阶段 10: JEV/Laya judge ─────────────────────────────────────────
    // `judgeSettingsOf` is resolved once per read and deconstructed, so the
    // "which keys does the judge need" decision lives in ONE place (config.ts)
    // while the type stays structural-compatible with ResolvedConfig.
    get jevUrl() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).jevUrl },
    get jevKey() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).jevKey },
    get jevModel() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).jevModel },
    get layaUrl() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).layaUrl },
    get layaKey() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).layaKey },
    get layaModel() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).layaModel },
    get judgePrefer() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).prefer },
    get jevChunkSize() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).chunkSize },
    get jevMaxImageBytes() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).maxImageBytes },
    get jevHistoryLimit() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).historyLimit },
    get jevArchiveImage() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).archiveImage },
    get jevEvaluate() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).evaluate },
    get jevStepBudget() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).stepBudget },
    get jevWallMs() { return judgeSettingsOf(resolveConfig(bridge.source() as RawConfig)).wallMs },
  }
  // ── 工具分级注入 ──────────────────────────────────────────────────────
  // 以前挂载时一次性把 41 �?bcdp_* 工具注册进宿主工具表，每个会话每一轮都�?  // schema 成本（实�?desc+params �?25.6K 字符），而不碰浏览器的会话一个也用不上�?  // 现在把「谁能出现在模型面前」交�?src/toolTiers.ts 的策略，注册时机由这�?  // 控制器执行：封印 = 反注册（从工具列表消失），不是执行期拒绝——与
  // prime-memory 的工具组封印同式�?
  let browserActive = false
  // ── Per-session depth tracking ──────────────────────────────────────────
  // When sessionScopedPulse is ON: each session's pulse advances only its own
  // depth; the global browseBatchDepth (which drives tierAllowed/registration)
  // is the MAX across all sessions. Visibility isolation requires host-level
  // restrict; without it, registration stays process-wide but per-session
  // idle sealing still works correctly.
  const sessionDepth = new Map<string, number>()
  let browseBatchDepth = 0

  /** Compute max depth from all tracked sessions, or 0 if none. */
  const maxSessionDepth = (): number => {
    let m = 0
    for (const d of sessionDepth.values()) if (d > m) m = d
    return m
  }

  const tiers: TierInjector = createTierInjector({
    register: (tool) => {
      const dispose = ctx.tools.register(tool) as unknown as () => void
      // Cordis lifecycle: unregister the tool when the plugin unmounts.
      ctx.effect?.(() => dispose)
      return dispose
    },
    policy: () => ({
      injection: cfg.toolInjection,
      toolBrowse: cfg.toolBrowse,
      toolExtended: cfg.toolExtended,
      toolEscape: cfg.toolEscape,
      toolJudge: cfg.toolJudge,
      judgeConfigured: judgeConfigured({ jevKey: cfg.jevKey, layaKey: cfg.layaKey }),
      active: browserActive,
      batchDepth: browseBatchDepth,
    }),
    logger: ctx.logger,
  })

  /**
   * Apply per-session restrict to hide globally-registered tools that exceed
   * the calling agent's own depth. Best-effort: silently no-ops when the host
   * does not expose agent-scoped restriction (plugin fiber is not an agent scope).
   */
  const tryRestrictSession = (sessionId: string | undefined): void => {
    if (!cfg.sessionScopedPulse || !sessionId) return
    // Attempt via ctx.tools.restrict (host API).
    try {
      const depth = sessionDepth.get(sessionId) ?? 0
      const allowed = new Set<string>()
      // core always visible
      for (const n of TIER_MEMBERS.core) allowed.add(n)
      // Build a session-local policy: this session's own depth/active
      const pol: TierPolicy = {
        injection: cfg.toolInjection,
        toolBrowse: cfg.toolBrowse,
        toolExtended: cfg.toolExtended,
        toolEscape: cfg.toolEscape,
        toolJudge: cfg.toolJudge,
        judgeConfigured: judgeConfigured({ jevKey: cfg.jevKey, layaKey: cfg.layaKey }),
        active: depth > 0,
        batchDepth: depth,
      }
      // Only restrict among tools that are ALREADY globally registered;
      // the filter hides those this session hasn't earned.
      for (const name of tiers.surface().live) {
        if (toolAllowed(name, pol)) allowed.add(name)
      }
      const restrictFn = (ctx.tools as unknown as Record<string, unknown>).restrict
      if (typeof restrictFn === 'function') {
        (restrictFn as (f: { allow: string[] }) => void)({ allow: [...allowed] })
      }
    } catch {
      // Restrict unavailable from plugin fiber scope; degrade silently.
    }
  }

  /**
   * Activity pulse: advance browse batch depth. When sessionScopedPulse is ON
   * and a sessionId is given, only that session's depth advances; the global
   * depth = max across sessions drives tier registration. Without restrict
   * support the effect is still beneficial for per-session sealAfterReap.
   */
  const pulseActivity = (sessionId?: string): void => {
    const before = browseBatchDepth
    browserActive = true
    if (cfg.sessionScopedPulse && sessionId) {
      const cur = Math.min(BATCH_ORDER.length, (sessionDepth.get(sessionId) ?? 0) + 1)
      sessionDepth.set(sessionId, cur)
      browseBatchDepth = Math.max(browseBatchDepth, maxSessionDepth())
    } else {
      browseBatchDepth = Math.min(BATCH_ORDER.length, browseBatchDepth + 1)
    }
    if (before !== browseBatchDepth) tiers.reapply()
    if (cfg.sessionScopedPulse && sessionId) tryRestrictSession(sessionId)
  }
  // markEgoToolCall fires the activity listener with sessionId
  {
    const offActivity = onEgoActivity(pulseActivity)
    ctx.effect?.(() => offActivity)
  }
  /**
   * Seal: idle reaper resets depths. With sessionScopedPulse, only sessions
   * whose last activity exceeded the timeout are sealed; when ALL are idle the
   * global depth drops to 0 (same observable behaviour as before).
   */
  const sealAfterReap = (): void => {
    if (cfg.toolInjection !== 'lazy' || !browserActive) return
    if (cfg.sessionScopedPulse && sessionDepth.size > 0) {
      // All sessions idle → reset global; individual session reset handled by
      // per-session timestamps in the reaper (simplified: bulk reset here).
      sessionDepth.clear()
      browseBatchDepth = 0
    } else {
      browseBatchDepth = 0
    }
    browserActive = false
    tiers.reapply()
  }
  const tierView: TierView = {
    pulse: pulseActivity,
    active: () => browserActive,
    surface: () => tiers.surface(),
  }
  const reg = (tool: ToolHandle): void => {
    tiers.offer(tool)
    // T8.5: optional ego_* aliases for scripts written before the bcdp_*
    // rename. Off by default; the old names collide with the upstream
    // ego-browser plugin, so enabling this IS the opt-in to that conflict.
    // The alias follows its bcdp_* twin's tier (tierOfTool is prefix-agnostic).
    if (cfg.legacyEgoToolNames && typeof tool.name === 'string' && tool.name.startsWith('bcdp_')) {
      const alias = { ...tool, name: 'ego_' + tool.name.slice('bcdp_'.length) } as ToolHandle
      try {
        tiers.offer(alias)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-browser-cdp: legacy alias ${alias.name} not registered: ${(error as Error).message}`)
      }
    }
  }
  registerEgoStatus(ctx, cfg, reg, tierView)
  registerAuthFlush(ctx, cfg, reg)
  registerLoginImport(ctx, cfg, reg)
  registerActionTools(ctx, cfg, reg)
  registerHelpAndDoctor(ctx, cfg, reg, tierView)
  // 注入面与分级表自检：出现表上没登记的名�?= 它落到了默认 extended，lazy 模式
  // 下会被悄悄延后注入。测试拦在前面，这条 warn 负责漏网时看得见�?
  {
    const s = tiers.surface()
    const unlisted = unknownTieredTools([...s.live, ...s.sealed])
    if (unlisted.length > 0) {
      ctx.logger?.warn?.(`dsh-browser-cdp: tools missing from the tier table (defaulted to power): ${unlisted.join(' ')}`)
    }
    ctx.logger?.info?.(
      `dsh-browser-cdp: tool surface ${s.live.length}/${s.live.length + s.sealed.length}` +
      ` (injection=${cfg.toolInjection}, switches browse=${cfg.toolBrowse ? 'open' : 'sealed'}` +
      ` extended=${cfg.toolExtended ? 'open' : 'sealed'} escape=${cfg.toolEscape ? 'open' : 'sealed'}` +
      ` judge=${cfg.toolJudge ? 'open' : 'sealed'},` +
      ` judgeConfigured=${judgeConfigured({ jevKey: cfg.jevKey, layaKey: cfg.layaKey })})`,
    )
  }
  // 设置页翻 toolInjection / toolBrowse / toolExtended / toolEscape / toolJudge �?volatile 热更 �?当场重算注入�?  // （与 prime-memory �?applyToolSeals 同式：不需要重启插件）�?
bridge.onChange(() => tiers.reapply())

  // ── R1: CDP attach cache �?the bridge between settings and every spawn ────
  // `resolveEgoEnv` is synchronous and reads `defaultAttachCache`, so the cache
  // must be kept current. We re-probe the ACTIVATED target whenever settings
  // change (and once on startup). A changed resolved endpoint is pushed into
  // the cast worker via `setAttachEndpoint`, which returns true only when the
  // value actually moved �?that is the signal to recycle the worker so the live
  // panel re-attaches to the same browser the tools now drive. No resolved
  // endpoint (local mode / nothing activated / unreachable) means "no remote
  // attach": the worker behaves exactly as before R1.
  const triggerCdpRefresh = (() => {
    let inFlight = false
    let pending = false
    /** Last ws handed to the worker; a differ means the browser was relaunched. */
    let lastAttachWs: string | null = null
    /** Last channel owner (id|reason); a differ is logged so takeovers are visible. */
    let lastOwnerKey: string | null = null
    /** True when this pass actually moved the resolved endpoint. */
    let changed = false
    const run = async (): Promise<boolean> => {
      if (inFlight) {
        pending = true
        return changed
      }
      inFlight = true
      changed = false
      try {
        const resolved = resolveConfig(bridge.source() as RawConfig)
        // Re-confirm the top-priority channel FIRST: activation if usable,
        // else the first enabled link in sequence order. Every links event
        // (enable/activation toggle, reorder, add, remove) lands here through
        // bridge.onChange, and the owner change is logged — never silent.
        const owner = resolveEffectiveLink(resolved.links, resolved.activeTargetId)
        const ownerKey = owner ? `${owner.link.id}|${owner.reason}` : 'none'
        if (ownerKey !== lastOwnerKey) {
          lastOwnerKey = ownerKey
          ctx.logger?.info?.(
            owner
              ? `dsh-browser-cdp: channel owner: ${owner.link.label} [${owner.link.id}] (${owner.reason}${owner.demotedId ? `, over ${owner.demotedId}` : ''})`
              : 'dsh-browser-cdp: channel owner: none (no enabled link owns routing)',
          )
        }
        const attach = await refreshAttach({
          targets: resolved.links,
          activeTargetId: resolved.activeTargetId,
          mode: resolved.cdpMode,
          timeoutMs: resolved.cdpProbeTimeoutMs,
          cache: defaultAttachCache,
          // T2.15/T2.16 �?M0.9 launcher wired: an authorized fallback now
          // launches a managed local browser instead of erroring out.
          fallback: {
            enabled: resolved.allowLocalFallback === true,
            chromePath: resolved.chromePath,
            chromeArgs: resolved.chromeArgs,
            localHeadless: resolved.localHeadless,
            userDataDir: resolved.localUserDataDir,
          },
          remoteEnabled: resolved.remoteEnabled,
          useLauncher: true,
          // 探测冷启动闸门（默认关）：关 = ego-cli 探测绝不把背后的浏览器拉起来，
          // 挂载/改设置不再弹浏览器窗口；首个真实 bcdp_* 调用才冷启动。
          cliProbeColdStart: resolved.allowProbeColdStart === true,
          // Lightpanda backend �?managed-serve extra args for `lightpanda` rows.
          lightpandaArgs: resolved.lightpandaArgs,
          // R7 �?the local ego CLI link probes through the host subprocess
          // service, and gets our bundled harness only when it opts in.
          cliIo: createSubprocessCliIo(ctx.subprocess),
          sdkPath: fileURLToPath(new URL('../runtime/ego-browser/dist/out/index.js', import.meta.url)),
          bundledCli: VENDORED_EGO_BIN,
        })
        const ws = attach.status === 'ready' && attach.wsUrl !== '' ? attach.wsUrl : null
        // A browser restart keeps the same endpoint but mints a NEW browser id, so
        // the cached ws goes stale while the endpoint string stays valid: record
        // the differ even when nothing downstream needed to act on it.
        if (ws !== null && ws !== lastAttachWs) lastAttachWs = ws
        if (setAttachEndpoint(ws, attach.status === 'ready' ? attach.engine ?? 'unknown' : null)) {
          changed = true
          void recycleWorker('cdp activation change').catch(() => null)
        }
      } catch {
        /* best-effort: a failed probe must never break the settings apply */
      } finally {
        inFlight = false
        if (pending) {
          pending = false
          void run()
        }
      }
      return changed
    }
    return (): Promise<boolean> => run()
  })()
  triggerCdpRef = triggerCdpRefresh
  bridge.onChange(() => void triggerCdpRefresh())
  // Initial probe so the first bcdp_* call attaches without waiting for a change.
  void triggerCdpRefresh()
  // Drop stale attach state when the plugin unmounts; a fresh mount starts clean.
  ctx.effect?.(() => () => {
    defaultAttachCache.reset()
  })
  // The diagnostics/PDF worker is independent of the optional HTTP watch host;
  // initialize it unconditionally so headless profiles can start it on demand.
  initCastWorker(ctx, resolveConfig(bridge.source() as RawConfig), ffmpegManager)
  // Realtime watch-panel host routes (/api/bcdp/*). Guarded: only meaningful
  // when the host exposes an HTTP server (web surface); headless safe-no-op.
  // The host service is `webServer` on the web shell (current runner). We only
  // reach for `webServer` here (declared in inject) so a strict-inject host
  // never trips on an undeclared `httpServer` read. [restored 2026-08-13: the
  // earlier disable dropped both the webServer inject and this registration,
  // killing the bottom-right live browser view. Plain-string `webServer`
  // inject resolves through fiber.store and is fully supported by cordis.]
  // [0.1.2 migration 2026-08-28] the strict service resolver returns undefined
  // for an UNDECLARED service, so the old `ctx.get?.('webServer')` guard was
  // silently undefined and the /api/bcdp/* watch routes were never installed �?  // the watch panel had no data endpoints (sidebar tab showed the empty state
  // forever, zero errors). The official optional-service pattern is a nested
  // inject: the callback runs only once the service is available, and no-ops
  // on hosts without a web server (TUI / headless stay tools-only).
  ctx.inject?.(['webServer'], (wctx) => {
    try {
      initCastServer(
        wctx as EgoContext,
        cfg,
        bridge,
        ffmpegManager,
        () => openAgentWindow(ctx, cfg),
        (opts) => importLoginCookies(opts, { subprocess: ctx.subprocess }),
      )
    } catch (err) {
      ctx.logger?.warn?.(
        `dsh-browser-cdp: cast server init failed: ${(err as Error)?.message ?? err}`,
      )
    }
    // Runtime capability gateway (/bcdp/api/cdp-status | cdp-probe |
    // ffmpeg-status | ffmpeg-check | ffmpeg-install) �?serves the browser
    // half's capability polling. 0.1.7: the config get/set pair is retired �?    // config writes go through the declarative settings form (configForms).
    // Same webServer the cast server uses; guarded so a headless host without
    // webServer is a no-op.
    try {
      registerEgoBrowserGateway(wctx as EgoContext, bridge, ffmpegManager, {
        // 会话 �?工作�?picks 目录（workspaceRegistry 按会话解析；无注�?        // 工作区或多个候选时返回 undefined，网关给 409 不猜）。同
        // dsh-paste-dock �?resolveWorkspaceDir 语义�?
        resolveDir: (sessionId: string | undefined) => {
          try {
            const registry = (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined) as
              | { list(): { path: string; sessionIds: readonly string[] }[] }
              | undefined
            const workspaces = (registry ? registry.list() : []) ?? []
            if (workspaces.length === 0) return undefined
            if (sessionId) {
              const owned = workspaces.find((w) => w.sessionIds.includes(sessionId))
              if (owned) return owned.path + '/picks'
            }
            if (workspaces.length === 1) return workspaces[0].path + '/picks'
            return undefined
          } catch {
            return undefined
          }
        },
      })
    } catch (err) {
      ctx.logger?.warn?.(
        `dsh-browser-cdp: capability gateway init failed: ${(err as Error)?.message ?? err}`,
      )
    }
    // 设置桥（老线数据臂，session-guard settings-bridge 同式）：�?.1.5 �?    // configForms，client 设置卡走 /api/dsh-browser-cdp/settings/* 读写宿主
    // settings 服务。rc.1+ 上路由无害冗余（卡仍走原�?configForms 臂）�?
    try {
      registerSettingsBridge(wctx, ctx)
    } catch (err) {
      ctx.logger?.warn?.(
        `dsh-browser-cdp: settings bridge init failed: ${(err as Error)?.message ?? err}`,
      )
    }
  })
  // Idle reaper (issue #47, opt-in via the idleTimeoutMin setting): the
  // backing Chromium is a singleton that otherwise only stops on --stop or
  // host teardown �?measured at ~425 MB idle. After N minutes without an
  // bcdp_* call, gracefully --stop it; the next bcdp_* call cold-starts it
  // (2-4s). Watching the panel does NOT count as activity (documented in the
  // setting hint). Runs on a 60s interval; cleanup clears the timer.
  ctx.effect?.(() => {
    if (cfg.idleTimeoutMin <= 0) return
    let reapedFor = 0 // the activity timestamp we already reaped for
    const timer = setInterval(() => {
      void (async () => {
        try {
          const last = getLastEgoActivity()
          if (!shouldReapBrowser(Date.now(), last, cfg.idleTimeoutMin)) return
          if (last <= reapedFor) return // already reaped for this idle stretch
          // R4/F3 �?NEVER send `--stop` to an `ego-cli` link: that browser is
          // the user's own daily instance, not an agent-owned one. The command
          // is currently an unknown no-op on the native CLI, but "fixing" it
          // would kill the user's browser �?an explicit non-goal, not a TODO.
          if (effectiveChannel(cfg).effective?.link.kind === EGO_CLI_KIND) {
            reapedFor = last
            ctx.logger?.info?.('dsh-browser-cdp: idle reaper skipped: ego-cli owns the user\'s browser (never --stop it)')
            return
          }
          // T2.14 �?a locally launched managed browser reaps by pid, not CLI.
          try {
            const { localBrowserInfo, stopLocalBrowser } = await import('./cdp/launcher.ts')
            if (localBrowserInfo()) {
              await stopLocalBrowser()
              ctx.logger?.info?.('dsh-browser-cdp: idle reaper stopped the locally launched browser')
            }
          } catch { /* launcher reap is best-effort */ }
          // Only reap when the state file says a browser is up. A stale
          // browser.json makes --stop a harmless no-op, so no pid liveness
          // check is needed here.
          const e = process.env
          const isWin = process.platform === 'win32'
          const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || '' : homedir())
          const stateDir =
            e.EGO_LINUX_STATE_DIR ||
            (isWin
              ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + '\\ego-lite-linux'
              : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`)
          const { readFile } = await import('node:fs/promises')
          try {
            await readFile(`${stateDir}/browser.json`, 'utf8')
          } catch {
            return // no state file �?no browser �?nothing to reap
          }
          reapedFor = last
          ctx.logger?.info?.(`dsh-browser-cdp: idle reaper stopping the backing browser after ${cfg.idleTimeoutMin}min without bcdp_* activity`)
          const handle = ctx.subprocess.spawn({
            argv: [process.execPath, cfg.egoBin, '--stop'],
            cwd: process.cwd(),
            env: resolveEgoEnv(cfg),
            stdio: {
              stdin: { data: '' },
              stdout: { maxBytes: 1024 },
              stderr: { maxBytes: 1024 },
            },
            graceMs: 8_000,
          })
          handle.done.catch(() => null)
          // 分级注入：闲置回收即收面——把注入面收回常驻的 `bcdp_status`，下一次活动再铺开。
          sealAfterReap()
        } catch {
          // never let the reaper throw
        }
      })()
    }, 60_000)
    return () => clearInterval(timer)
  }, 'dsh-browser-cdp: idle reaper')
  // Graceful teardown: stop the persistent browser when the plugin unmounts.
  // CRITICAL: this must be fire-and-forget, NOT awaited. Awaiting `--stop`
  // (which asks the browser to graceful-close, ~seconds) stalls the host process
  // teardown when DSH is killed/restarted. With a self-healing guard that kills
  // web and expects the old process to exit promptly before restarting it, a
  // slow/frozen browser here hangs the restart forever ("waiting to restart").
  // Losing in-memory login cookies on a dirty shutdown beats a restart that
  // never completes �?the clean path still flushes cookies on a graceful DSH
  // close, and bcdp_auth_flush exists for explicit persistence.
  ctx.effect?.(() => {
    try {
      // R4/F3 �?teardown must not stop an `ego-cli` link's browser either: it
      // is the user's own ego lite instance and outlives this plugin.
      if (effectiveChannel(cfg).effective?.link.kind === EGO_CLI_KIND) {
        ctx.logger?.info?.('dsh-browser-cdp: teardown skipped --stop: ego-cli owns the user\'s browser')
        return
      }
      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, cfg.egoBin, '--stop'],
        cwd: process.cwd(),
        env: resolveEgoEnv(cfg),
        stdio: {
          stdin: { data: '' },
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        // Keep it short; never let this outlive the host's own teardown budget.
        // But DO give the graceful stop enough time (>= the runtime's
        // Browser.close + waitForProcessExit window) so the browser merges its
        // cookie journal into the on-disk profile before DSH is gone �?that is
        // what keeps logins across a restart (the bundled runtime's behavior).
        graceMs: 8_000,
      })
      // Fire and forget: do NOT return this promise from the effect cleanup.
      handle.done.catch(() => {
        /* ignore */      })
    } catch {
      // never let teardown throw
    }
  })
  ctx.logger?.info?.(
    `dsh-browser-cdp: mounted (egoBin=${cfg.egoBin}, defaultSpace=${cfg.activeSpace})`,
  )
}
/** `bcdp_status` probes the SAME channel work uses: a `nodejs` heredoc. */
function registerEgoStatus(ctx: EgoContext, cfg: EgoRuntimeConfig, reg: (tool: ToolHandle) => void, tiers: TierView): void {
  reg(
    defineTool({
      name: 'bcdp_status',
      description:
        'Drive the shared CDP browser (ego runtime): probe the CLI, and unlock the rest of the bcdp_* tools — under lazy injection only this tool is resident, so call it first for any browsing task (open a page, fill a form, screenshot, read, or attach your own Chrome/Edge over CDP). A bcdp_* tool missing from your list is sealed by tiering, not broken.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            available: { type: 'boolean', required: true },
            path: { type: 'string' },
            exitCode: { type: 'integer' },
            facades: {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskSpaces: { type: 'string' },
                browser: { type: 'string' },
                page: { type: 'string' },
              },
            },
          },
        },
        render: renderText,
      },
      // facade probe only inspects the globals the SDK harness injects
      // (taskSpaces/browser/page); it neither starts nor waits for a browser.
      // Measured ~300ms, so 15s is already a generous ceiling. Do NOT raise it
      // for browser cold-start �?that concern does not apply to this probe.
      timeoutMs: 15_000,
      execute: async (_args: Record<string, unknown>, exec: ToolExec) => {
        // Per-session pulse: pass callingSessionId so sessionScopedPulse can
        // advance only this session's depth. Falls back to process-level when
        // sessionId is undefined (non-agent caller or feature off).
        tiers.pulse(callingSessionId(exec))
        return withEgoLock(async () => {
          try {
            const { attach } = effectiveChannel(cfg)
            // R1 �?probe with the exact argv real tool runs use, so "available"
            // means "a bcdp_* call would work", not "some other command worked".
            const handle = ctx.subprocess.spawn({
              argv: buildEgoToolArgv(cfg.egoArgvPrefix, attach, cfg.runtimeArgs ?? ''),
              cwd: process.cwd(),
              env: resolveEgoEnv(cfg),
              stdio: {
                stdin: { data: STATUS_FACADE_SCRIPT },
                stdout: { maxBytes: 4096 },
                stderr: { maxBytes: 4096 },
              },
              graceMs: 15_000,
            })
            const outcome = await handle.done
            const facades = parseStatusFacades(
              mergeCliOutput({
                stdout: readAll(handle.collected.stdout),
                stderr: readAll(handle.collected.stderr),
              }),
            )
            return {
              ok: true,
              available:
                outcome.exitCode === 0 &&
                facades?.taskSpaces === 'object' &&
                facades?.browser === 'object',
              path: attach.cliPath ?? cfg.egoBin,
              exitCode: outcome.exitCode,
              ...(facades ? { facades } : {}),
            }
          } catch (err) {
            return {
              ok: true,
              available: false,
              path: '',
              exitCode: null,
              error: describeSpawnFailure(err),
            }
          }
        })
      },
      presentCall: () => ({
        card: 'generic',
        title: 'bcdp_status',
        kind: 'other',
        rawInput: null,
      }),
    } as unknown as DefineToolOpts),
  )
}
/** `bcdp_auth_flush` �?force persistent login cookies down to the disk profile. */
function registerAuthFlush(ctx: EgoContext, cfg: EgoRuntimeConfig, reg: (tool: ToolHandle) => void): void {
  reg(
    defineTool({
      name: 'bcdp_auth_flush',
      description:
        'Force all persistent login cookies in the agent browser to be written to the on-disk profile. Call this after login (or before ending a browsing task) so the login survives a later DSH/browser restart �?Chrome only flushes cookies to disk on graceful close, this nudges it to persist them now.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            total: { type: 'integer' },
            flushed: { type: 'integer' },
            /** Lightpanda backend �?set when the engine has no Storage.flushCookies (nothing was persisted). */
            degraded: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: renderText,
      },
      timeoutMs: 10_000,
      execute: async () =>
        withEgoLock(async () => {
          try {
            const { readFile } = await import('node:fs/promises')
            // Mirror the ego-cast worker's state-dir discovery so the flush
            // tool actually finds the worker's state file on every platform
            // (cast-worker.mjs) uses %LOCALAPPDATA%\ego-lite-linux on Windows
            // and $XDG_STATE_HOME/ego-lite-linux on POSIX; this used to hardcode
            // `$HOME/.local/state` which resolves to a dead path on Windows and
            // made bcdp_auth_flush report "no live ego-cast worker" there.
            const e = process.env
            const isWin = process.platform === 'win32'
            const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || '' : homedir())
            const stateDir =
              e.EGO_LINUX_STATE_DIR ||
              (isWin
                ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + '\\ego-lite-linux'
                : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`)
            let port: number | null = null
            try {
              const state = JSON.parse(
                await readFile(`${stateDir}/dsh-browser-cdp.cast.json`, 'utf8'),
              ) as { port?: unknown }
              port = typeof state.port === 'number' ? state.port : null
            } catch {
              port = null
            }
            if (port === null)
              return {
                ok: false,
                error: 'no live ego-cast worker (browser not running)',
              }
            const r = await fetch(`http://127.0.0.1:${port}/api/flush`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              signal: AbortSignal.timeout(8000),
            })
            const jbody = await r.json() as { ok?: boolean; total?: number; flushed?: number; error?: string }
            // Lightpanda backend �?the worker's Storage.flushCookies call is
            // already best-effort (errors swallowed inside the worker), so on
            // that engine this tool would return a fake `ok: true` while having
            // persisted nothing. Report the degraded truth instead.
            const degraded = defaultAttachCache.get().engine === 'lightpanda'
            return {
              ok: !!jbody.ok && !degraded,
              total: jbody.total ?? 0,
              flushed: jbody.flushed ?? 0,
              ...(degraded ? { degraded: true, error: 'engine-unsupported: Lightpanda has no Storage.flushCookies �?cookies persist only while the engine process is alive' } : {}),
              ...(!degraded && jbody.error !== undefined ? { error: jbody.error } : {}),
            }
          } catch (err) {
            return { ok: false, error: String((err as Error)?.message || err) }
          }
        }),
      presentCall: () => ({
        card: 'generic',
        title: 'bcdp_auth_flush',
        kind: 'other',
        rawInput: null,
      }),
    } as unknown as DefineToolOpts),
  )
}
/** `bcdp_login_import` �?copy login cookies from the system browser (issue #46). */
function registerLoginImport(ctx: EgoContext, cfg: EgoRuntimeConfig, reg: (tool: ToolHandle) => void): void {
  reg(
    defineTool({
      name: 'bcdp_login_import',
      description:
        'Import login cookies from the system browser (Chrome/Edge/Brave) into the agent browser via CDP passthrough, so sites open logged in. Run dryRun first, then import explicit domains; logins persist in the profile. Cookie values are never shown.',
      parameters: {
        source: { type: 'string', description: 'chrome | edge | brave | auto (default auto).' },
        domains: { type: 'json', description: 'Domains to import, e.g. ["bilibili.com"] (subdomains included). Omit = all cookies; prefer an explicit list.' },
        profile: { type: 'string', description: 'Source profile dir, e.g. "Default" (default: first profile).' },
        closeSource: { type: 'boolean', description: 'true = gracefully close a running source browser first (tabs restore); false = return an actionable error (default).' },
        dryRun: { type: 'boolean', description: 'true = report what would be imported; write nothing.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            source: { type: 'string' },
            profile: { type: 'string' },
            dryRun: { type: 'boolean' },
            totalRead: { type: 'integer' },
            matched: { type: 'integer' },
            written: { type: 'integer' },
            domains: { type: 'json' },
            /** Set when the tool gracefully quit the running source browser first (issue #1-�? was returned but undeclared). */
            closedSource: { type: 'boolean' },
            /** Set when the source cookie store lost rows during the session and was restored from the pre-boot backup. */
            restoredFromBackup: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: renderText,
      },
      timeoutMs: 60_000,
      execute: async (args: Record<string, unknown>) =>
        withEgoLock(async () => {
          try {
            const domains = Array.isArray(args.domains) ? (args.domains as unknown[]).map(String) : undefined
            const source = typeof args.source === 'string' && args.source !== '' ? args.source : 'auto'
            if (!['chrome', 'edge', 'brave', 'auto'].includes(source)) {
              return { ok: false, error: `invalid source "${source}" �?expected chrome|edge|brave|auto` }
            }
            return await importLoginCookies(
              {
                source: source as 'chrome' | 'edge' | 'brave' | 'auto',
                domains,
                profile: typeof args.profile === 'string' && args.profile !== '' ? args.profile : undefined,
                closeSource: args.closeSource === true,
                dryRun: args.dryRun === true,
              },
              { subprocess: ctx.subprocess },
            )
          } catch (err) {
            return { ok: false, error: String((err as Error)?.message || err) }
          }
        }),
      presentCall: () => ({
        card: 'generic',
        title: 'bcdp_login_import',
        kind: 'other',
        rawInput: null,
      }),
    } as unknown as DefineToolOpts),
  )
}
function registerDiagnosticsTool(ctx: EgoContext, cfg: EgoRuntimeConfig, reg: (tool: ToolHandle) => void): void {
  reg(
    defineTool({
      name: 'bcdp_diagnostics',
      description:
        'Read recent network requests or console/page errors from the current CDP browser, or render the current page to PDF. This is an optional diagnostic tool (toolExtended): use kind=network|console before guessing why a page failed; use kind=pdf to save a PDF and return its local path.',
      parameters: {
        kind: { type: 'string', required: true, description: 'network | console | pdf' },
        limit: { type: 'number', description: 'For network/console: newest entries to return (1-300, default 50).' },
        targetId: { type: 'string', description: 'Optional CDP target id; defaults to the worker active target.' },
        path: { type: 'string', description: 'For pdf: output path. Defaults to ~/.dsh/browser-cdp-pdfs/page-<timestamp>.pdf.' },
        printBackground: { type: 'boolean', description: 'For pdf: print CSS backgrounds (default true).' },
        scale: { type: 'number', description: 'For pdf: scale 0.1-2 (default browser value).' },
        landscape: { type: 'boolean', description: 'For pdf: landscape orientation.' },
      },
      output: { schema: commonOutputSchema, render: renderText },
      timeoutMs: 60_000,
      execute: async (args: Record<string, unknown>, exec: ToolExec) =>
        withEgoLock(async () => {
          cfg.spaceTracker.setCurrentSession(callingSessionId(exec))
          markEgoToolCall(callingSessionId(exec))
          const kind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : ''
          const targetId = typeof args.targetId === 'string' && args.targetId.trim() !== '' ? args.targetId.trim() : undefined
          if (kind === 'network' || kind === 'console') {
            const rawLimit = Number(args.limit)
            const limit = Number.isFinite(rawLimit) ? Math.min(300, Math.max(1, Math.floor(rawLimit))) : 50
            const result = await readWorkerDiagnostics(kind, limit, targetId)
            if (result === null) {
              return { ok: false, kind, error: 'browser worker is not running — call bcdp_status or a browser tool first' }
            }
            return result
          }
          if (kind === 'pdf') {
            const result = await printWorkerPdf({
              ...(targetId ? { targetId } : {}),
              printBackground: args.printBackground !== false,
              ...(typeof args.scale === 'number' ? { scale: args.scale } : {}),
              ...(typeof args.landscape === 'boolean' ? { landscape: args.landscape } : {}),
            })
            if (result === null) return { ok: false, kind, error: 'browser worker is not running — call bcdp_status or a browser tool first' }
            const body = result.body as { ok?: unknown; data?: unknown; targetId?: unknown; error?: unknown }
            if (result.status !== 200 || body.ok !== true || typeof body.data !== 'string') {
              return { ok: false, kind, error: typeof body.error === 'string' ? body.error : `PDF worker returned ${result.status}` }
            }
            const out = typeof args.path === 'string' && args.path.trim() !== ''
              ? resolve(args.path.trim())
              : join(homedir(), '.dsh', 'browser-cdp-pdfs', `page-${Date.now()}.pdf`)
            const bytes = Buffer.from(body.data, 'base64')
            await mkdir(dirname(out), { recursive: true })
            await writeFile(out, bytes)
            return {
              ok: true,
              kind,
              path: out,
              bytes: bytes.length,
              ...(typeof body.targetId === 'string' ? { targetId: body.targetId } : targetId ? { targetId } : {}),
            }
          }
          return { ok: false, error: 'kind must be network, console, or pdf' }
        }),
      presentCall: () => ({ card: 'generic', title: 'bcdp_diagnostics', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )
}

/** The structured action tools that drive `ego-browser nodejs`. */
function registerActionTools(ctx: EgoContext, cfg: EgoRuntimeConfig, reg: (tool: ToolHandle) => void): void {
  reg(
    defineTool({
      name: 'bcdp_watch',
      description:
        'Open the live CDP watch tab in the sidebar on demand. Ordinary bcdp_* calls keep it collapsed; use this when the user should watch the page in real time.',
      parameters: {},
      output: { schema: commonOutputSchema, render: renderText },
      timeoutMs: 15_000,
      execute: async (_args: Record<string, unknown>, exec: ToolExec) => {
        const sessionId = callingSessionId(exec)
        markEgoToolCall(sessionId)
        requestWatchOpen(sessionId)
        // Start the worker before the navigation, so network/console history
        // is captured for the page the user is about to watch.
        await ensureCastWorker()
        return { ok: true, opened: true }
      },
      presentCall: () => ({ card: 'generic', title: 'bcdp_watch', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )
  registerDiagnosticsTool(ctx, cfg, reg)
  const t = (opts: EgoToolOptions): ToolHandle => defineEgoTool(ctx, cfg, {
    ...opts,
    afterExecute: (args, result) => {
      if (!result || (result as Record<string, unknown>).ok === false) return
      // open/close/list/handoff/takeover now live in ONE tool, so the tool
      // NAME no longer reveals which slot transition happened — dispatch by op.
      const a = args as { op?: unknown; name?: unknown; space?: unknown }
      const op = typeof a?.op === 'string' ? a.op.trim() : ''
      if (opts.name === 'bcdp_space' && op === 'open') {
        cfg.spaceTracker.opened(args as { name?: string | number }, result as { id?: string | number; name?: string; done?: boolean })
      } else if (opts.name === 'bcdp_space' && op === 'close') {
        cfg.spaceTracker.closed(a.name as string | number, (result as { done?: boolean }).done as boolean)
      } else if (a && a.space !== undefined && a.space !== '') {
        cfg.spaceTracker.selected(a.space as string | number)
      }
      opts.afterExecute?.(args, result)
    },
  })
  const spaceParam = {
    type: 'string',
    description:
      'Task-space name or numeric id; defaults to the most recently opened or explicitly selected space.',
  }
  reg(
    t({
      name: 'bcdp_space',
      description:
        "Task space: op=open (or reuse) | close | list | handoff | takeover. Omitting `space` targets THIS session's own space (dsh-agent-<sessionId8>), so concurrent sessions never share or hijack each other's browsing context — this is the default and needs no setup. To reuse ONE shared slot across sessions, pass `space: 'default'` (or op=open with name='default') deliberately; do NOT create numbered spaces like #4/#5. The browser profile (logins) persists on disk across restarts unless isolateSpaces is on; if a page needs login, prompt the user to log in manually. handoff yields control to the human (stop driving until they hand back); takeover resumes agent control.",
      parameters: {
        op: {
          type: 'string',
          required: true,
          description: '"open" | "close" | "list" | "handoff" | "takeover".',
        },
        name: {
          type: 'string',
          description: "op=open/close: task-space name. Omit to use this session's own space (dsh-agent-<sessionId8>); pass 'default' only when you deliberately want the ONE shared slot. op=handoff/takeover: default = this session's space.",
        },
        keep: {
          type: 'boolean',
          description: 'op=close: keep the live page open (default false: close it).',
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const send = (expr: string): string =>
          `console.log('${SENTINEL}' + JSON.stringify(${expr}))\n`
        const op = str(args.op, '').trim()
        const name = str(args.name, str(args.space, cfg.activeSpace))
        if (op === 'open') {
          return `${useSpace(str(args.name, cfg.activeSpace))}` +
            send(`{ ok: true, op: 'open', id: task.id ?? null, name: task.name ?? ${j(str(args.name, cfg.activeSpace))} }`)
        }
        if (op === 'close') {
          return `const res = await taskSpaces.complete(${j(name)}, { keep: ${bool(args.keep, false)} })\n` +
            send(`{ ok: true, op: 'close', done: !!res.done, skipped: !!res.skipped, reason: res.skipped ? ${j('target space was not agent-owned')} : null }`)
        }
        if (op === 'list') {
          return `const __sp = await taskSpaces.list()\n` +
            send(`{ ok: true, op: 'list', spaces: __sp.map(s => ({ id: s.id ?? null, name: s.name ?? null, ownership: s.ownership ?? null })) }`)
        }
        if (op === 'handoff') {
          // After handoff the human owns the space; any page.* call in THIS same
          // script would hit the runtime's hard-stop. Emit the result and stop —
          // do not probe page.info() here (see findings P0-5).
          return `${useSpace(name)}const __h = await taskSpaces.handOff(${j(name)})\n` +
            send(`{ ok: true, op: 'handoff', name: ${j(name)}, done: !!__h.done, skipped: __h.skipped ?? null, hint: 'user now has control; ask them to confirm before calling op=takeover' }`)
        }
        if (op === 'takeover') {
          return `await taskSpaces.takeOver(${j(name)})\n` +
            `const __info = await page.info()\n` +
            send(`{ ok: true, op: 'takeover', name: ${j(name)}, page: __info }`)
        }
        return send(`{ ok: false, reason: ${j('bcdp_space: op must be one of open|close|list|handoff|takeover')} }`)
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_snapshot',
      description:
        'Read the current page as text: the full-page semantic tree annotated with [ref=N, loc=...] selectors that bcdp_click / bcdp_fill can target. To target across calls prefer a `loc=` over `@N`: a loc is stable, a ref is renumbered every snapshot.',
      parameters: {
        space: spaceParam,
        scope: {
          type: 'string',
          description:
            "scope: 'full_page' (default) | 'only_within_viewport'; 'subtree' captures only `root`'s subtree.",
        },
        root: {
          type: 'string',
          description:
            "scope='subtree': the node to capture - a `loc=` token (stable across calls) or a ref like '@12' from a fresh snapshot.",
        },
      },
      buildScript: (args) => {
        const scope = str(args.scope, '')
        const send = (expr: string): string =>
          `console.log('${SENTINEL}' + JSON.stringify(${expr}))\n`
        // includeStableLocator makes the SDK emit `loc=css:/loc=role:/loc=href:`
        // tokens per node (SDK snapshot() wrapper default; snapshotRaw passes
        // them through). Unlike [ref=N] �?which the native engine renumbers
        // every call AND whose refMap is reset by the one-shot subprocess each
        // bcdp_* spawn pays into �?a loc is stable ACROSS calls, so cross-call
        // targeting should prefer it. See README "稳定定位 (loc vs ref)".
        const SNAP_OPTS = 'includeStableLocator: true'
        // subtree mode: resolve the caller's root against a FRESH full snapshot,
        // because the SDK demands a numeric backendNodeId. The root may be a ref
        // (@N) OR a stable loc (`loc=css:…` / `loc=role:…` / `loc:href:…`) �?loc
        // wins over ref when both are given, and loc survives a new subprocess.
        if (scope === 'subtree') {
          const rootArg = str(args.root, '').trim()
          if (rootArg === '') return send(`{ ok: false, reason: 'bcdp_snapshot: root (a ref such as @N, or a loc=css:�? is required for scope=subtree' }`)
          // Resolve backendNodeId from either a loc or an @ref. The `loc` field
          // on a ref carries the value WITHOUT the `loc=` prefix; `unstable`
          // means the engine could not derive a stable selector, so skip it.
          const resolver =
            `((raw, refs) => {\n` +
            `  const want = raw.replace(/^loc=/, '').trim()\n` +
            `  if (want !== '' && want !== 'unstable') {\n` +
            `    const byLoc = refs.find(r => r.loc != null && String(r.loc).replace(/^loc=/, '') === want)\n` +
            `    if (byLoc && byLoc.backendNodeId != null) return byLoc.backendNodeId\n` +
            `  }\n` +
            `  const id = raw.replace(/^@/, '').trim()\n` +
            `  const byRef = refs.find(r => String(r.refId) === id)\n` +
            `  return byRef ? byRef.backendNodeId ?? null : null\n` +
            `})(${j(rootArg)}, s.refs ?? [])`
          return (
            `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
            `let s = await page.snapshotRaw({ ${SNAP_OPTS} })\n` +
            `let tries = 0\n` +
            `while (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = await page.snapshotRaw({ ${SNAP_OPTS} }); tries++ }\n` +
            `const __bn = ${resolver}\n` +
            `if (__bn === null) { ${send(`{ ok: false, root: ${j(rootArg)}, reason: 'subtree root not present in the current snapshot; take a fresh full snapshot and use a loc= (survives across calls) or a ref @N from it' }`)} }\n` +
            `else { const sub = await page.snapshotRaw({ scope: 'subtree', root: __bn, ${SNAP_OPTS} }); const stext = sub.content ?? '';\n` +
            `console.log('${SENTINEL}' + JSON.stringify(stext === ''\n` +
            `  ? { ok: false, root: ${j(rootArg)}, backendNodeId: __bn, text: stext, reason: 'subtree capture came back empty' }\n` +
            `  : { ok: true, root: ${j(rootArg)}, backendNodeId: __bn, text: stext, tries })) }\n`
          )
        }
        const call =
          scope === ''
            ? `await page.snapshotRaw({ ${SNAP_OPTS} })`
            : `await page.snapshotRaw({ scope: ${j(scope)}, ${SNAP_OPTS} })`
        // The host can return an empty DOM capture right after a navigation;
        // retry briefly so a mid-load snapshot does not come back empty.
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `let s = ${call}\n` +
          `let tries = 0\n` +
          `while (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = ${call}; tries++ }\n` +
          `const text = s.content ?? ''\n` +
          // Distinguish a genuinely empty page from a failed/empty capture:
          // signal ok:false when no content came back after all retries, so
          // callers never mistake a dead capture for a legitimate blank page.
          `console.log('${SENTINEL}' + JSON.stringify(text === ''\n` +
          `  ? { ok: false, text, tries, reason: 'snapshot returned no content after retries (page may be blank, still loading, or the browser dropped)' }\n` +
          `  : { ok: true, text, tries }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_navigate',
      description:
        'Open a URL in the task space, or switch to the existing tab for it (prefer reuse over duplicates). Waits for document load, returns page info.',
      tabRevive: true,
      parameters: {
        url: {
          type: 'string',
          required: true,
          description: 'Absolute URL to open (omit if reload).',
        },
        reload: {
          type: 'boolean',
          description: 'Reload the current tab (no url needed).',
        },
        ignoreCache: {
          type: 'boolean',
          description: 'With reload: bypass cache.',
        },
        wait: {
          type: 'boolean',
          description: 'Wait for document load (default true).',
        },
        timeout: {
          type: 'number',
          description: 'Load wait timeout in ms (default 20000).',
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const u = str(args.url, '')
        // Reload branch first: it is the one call shape that must work with no
        // url at all. page.reload resolves the load-state boolean (never
        // throws on timeout), so `wait` only gates whether we bother waiting.
        if (bool(args.reload, false)) {
          return (
            `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
            `const __ok = await page.reload({ ignoreCache: ${bool(args.ignoreCache, false)}, waitUntil: ${j(bool(args.wait, true) ? 'load' : 'commit')}, timeout: ${num(args.timeout, 20_000)} })\n` +
            `const pginfo = await page.info()\n` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, reloaded: true, loaded: __ok !== false, page: pginfo }))\n`
          )
        }
        // Schema marks url required, but never silently navigate to a
        // hard-coded example page on a non-conforming empty value �?report
        // back an actionable failure instead.
        if (u === '') {
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reused: false, page: null, reason: 'bcdp_navigate: url is required' }))\n`
        }
        // Reuse the current tab in this task space (select a real tab, then
        // navigate IN PLACE via page.goto) instead of opening a new tab every
        // time. This keeps the agent's tab count small across a task. If a
        // tab already shows the exact URL, we switch to it; otherwise we
        // navigate the active tab so we don't pile up tabs.
        // NOTE: ensureRealTab() already declares `__tabs`, so reuse it.
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `const __existing = __tabs.find(t => t.url.split('#')[0] === ${j(
            u.split('#')[0],
          )})\n` +
          `const tab = __existing ? await browser.switchTab(__existing.targetId) : await page.goto(${j(
            u,
          )}, { wait: ${bool(args.wait, true)}, timeout: ${num(
            args.timeout,
            20_000,
          )} })\n` +
          `const pginfo = await page.info()\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, reused: !!__existing, page: pginfo }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_click',
      description:
        'Click an element: CSS/xpath/loc/ref selector, or viewport x+y coordinates.',
      parameters: {
        selector: { type: 'string', description: 'CSS/xpath/loc/ref=N from bcdp_snapshot; required unless x,y.' },
        x: { type: 'number', description: 'Viewport x for a coordinate click.' },
        y: { type: 'number', description: 'Viewport y for a coordinate click.' },
        label: { type: 'string', description: 'Short action label, e.g. "click submit".' },
        double: { type: 'boolean', description: 'Double-click instead of single.' },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.selector, '')
        const x = args.x as number | undefined
        const y = args.y as number | undefined
        if (sel === '' && !(typeof x === 'number' && typeof y === 'number')) {
          throw new Error(
            'bcdp_click: provide either `selector` (CSS/xpath/loc/ref from bcdp_snapshot) or both `x` and `y` viewport coordinates',
          )
        }
        const dbl = bool(args.double, false)
        let action
        if (sel !== '') {
          const labelOpt =
            str(args.label, '') !== ''
              ? `{ label: ${j(str(args.label, ''))} }`
              : ''
          action = dbl
            ? `await page.locator(${j(sel)}).dblclick(${labelOpt})`
            : `await page.locator(${j(sel)}).click(${labelOpt})`
        } else {
          action = dbl
            ? `await page.mouse.dblclick(${x}, ${y})`
            : `await page.mouse.click(${x}, ${y})`
        }
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `${action}\n` +
          `const pginfo = await page.info()\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, double: ${dbl}, page: pginfo }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_fill',
      description:
        'Type text into an input field. Target with a CSS selector, xpath=..., loc=..., or ref=N from bcdp_snapshot.',
      parameters: {
        selector: {
          type: 'string',
          required: true,
          description:
            'CSS selector, xpath=..., loc=..., or ref=N for the input.',
        },
        text: {
          type: 'string',
          required: true,
          description: 'Text to type into the field.',
        },
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
        `await page.locator(${j(str(args.selector, ''))}).fill(${j(
          str(args.text, ''),
        )})\n` +
        `const pginfo = await page.info()\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`,
    }),
  )
  reg(
    t({
      name: 'bcdp_js',
      description:
        'Evaluate a JavaScript expression in the current page and return its JSON-serializable value (e.g. "document.title", "document.querySelectorAll(\'a\').length"). One expression only; multi-step: use bcdp_script; raw protocol: use bcdp_cdp.',
      parameters: {
        expression: {
          type: 'string',
          required: true,
          description: 'JavaScript expression string to evaluate in the page.',
        },
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
        `${SAFE_FN}` +
        `const result = await page.evaluate(${j(safeEvalWrap(str(args.expression, '')))})\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`,
    }),
  )
  reg(
    t({
      name: 'bcdp_cdp',
      description:
        'Issue a raw CDP command on the page target, e.g. cdp("Page.handleJavaScriptDialog", { accept: true }). Prefer a structured tool when one exists; page JS belongs to bcdp_js.',
      parameters: {
        method: {
          type: 'string',
          required: true,
          description: 'CDP method name, e.g. Page.handleJavaScriptDialog.',
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'CDP method parameters object.',
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const params = args.params
        const call =
          params !== undefined && params !== null
            ? `await cdp(${j(str(args.method, ''))}, ${j(params)})`
            : `await cdp(${j(str(args.method, ''))})`
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `${SAFE_FN}` +
          `const result = ${call}\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_screenshot',
      description:
        'Capture a screenshot of the current page (or of a single element if selector is given). Returns the file path of the saved PNG, which you can then read with a vision/image tool.',
      parameters: {
        selector: {
          type: 'string',
          description:
            'Optional CSS selector of an element to screenshot instead of the whole page.',
        },
        path: {
          type: 'string',
          description: 'Optional absolute output path for the PNG.',
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.selector, '')
        const pth = str(args.path, '')
        const shot =
          sel !== ''
            ? `await page.locator(${j(sel)}).screenshot(${pth ? `{ path: ${j(pth)} }` : ''})`
            : `await page.screenshot(${pth ? `{ path: ${j(pth)} }` : ''})`
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `const path = ${shot}\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_page_info',
      description:
        'Return the current page info: url, title, viewport size (w, h), scroll offsets (sx, sy), device metrics (pw, ph), and whether a native dialog is open. Also reports `humanCheck` �?whether a CAPTCHA / human-verification challenge is detected on the page (so the agent can alert the user to complete it).',
      parameters: {
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
        `const pginfo = await page.info()\n` +
        `let __hc = null\n` +
        `try { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}).catch(() => null); } catch { __hc = null }\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo, humanCheck: __hc }))\n`,
    }),
  )
  reg(
    t({
      name: 'bcdp_tab',
      description:
        'Manage tabs: op=list|current|new|switch|close. new opens/reuses a tab at url; switch/close take a `target` (targetId or URL substring). Will not close the last tab.',
      parameters: {
        op: {
          type: 'string',
          required: true,
          description: '"list" | "current" | "new" | "switch" | "close".',
        },
        url: {
          type: 'string',
          description: 'Absolute URL for op=new (reuses a matching tab).',
        },
        target: {
          type: 'string',
          description: 'targetId or URL substring for switch / close.',
        },
        wait: {
          type: 'boolean',
          description: 'op=new: wait for load (default true).',
        },
        timeout: {
          type: 'number',
          description: 'op=new: load timeout ms (default 20000).',
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const send = (expr: string): string =>
          `console.log('${SENTINEL}' + JSON.stringify(${expr}))\n`
        const op = str(args.op, '').trim()
        const head = useSpace(str(args.space, cfg.activeSpace))
        if (op === 'list') {
          return head +
            `const __tabs = await browser.listTabs()\n` +
            send(`{ ok: true, tabs: __tabs.map(t => ({ targetId: t.targetId, title: t.title, url: t.url, active: !!t.active, index: t.index })) }`)
        }
        if (op === 'current') {
          return head +
            `const __cur = await browser.currentTab()\n` +
            send(`{ ok: true, tab: __cur }`)
        }
        if (op === 'new') {
          const u = str(args.url, '')
          if (u === '') return send(`{ ok: false, reason: 'bcdp_tab: url is required for op=new' }`)
          return head +
            `const __t = await browser.openOrReuseTab(${j(u)}, { wait: ${bool(args.wait, true)}, timeout: ${num(args.timeout, 20_000)} })\n` +
            send(`{ ok: true, tab: __t }`)
        }
        if (op === 'switch' || op === 'close') {
          const t = str(args.target, '')
          if (t === '') return send(`{ ok: false, reason: ${j('bcdp_tab: target (targetId or URL substring) is required for op=' + op)} }`)
          // Two-way hit: exact targetId first, else a URL substring match.
          const find =
            `const __tabs = await browser.listTabs()\n` +
            `const __t = __tabs.find(x => x.targetId === ${j(t)}) ?? __tabs.find(x => (x.url || '').includes(${j(t)}))\n`
          if (op === 'switch') {
            return head + find +
              `if (!__t) { ${send(`{ ok: false, reason: 'bcdp_tab: no tab matches switch target ' + ${j(t)} }`)} }\n` +
              `else { await browser.switchTab(__t.targetId); const pginfo = await page.info(); ${send(`{ ok: true, tab: { ...__t, active: true }, page: pginfo }`)} }\n`
          }
          // close: never drop the last tab (a space with zero tabs strands the harness).
          return head + find +
            `if (!__t) { ${send(`{ ok: false, reason: 'bcdp_tab: no tab matches close target ' + ${j(t)} }`)} }\n` +
            `else if (__tabs.length <= 1) { ${send(`{ ok: false, reason: 'refusing to close the last tab: open another tab first' }`)} }\n` +
            `else { const __closed = await browser.closeTab(__t.targetId); const __after = await browser.listTabs(); ${send(`{ ok: true, closed: __closed, count: __after.length, tabs: __after.map(t => ({ targetId: t.targetId, url: t.url, active: !!t.active })) }`)} }\n`
        }
        return send(`{ ok: false, reason: ${j('bcdp_tab: op must be one of list|current|new|switch|close')} }`)
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_wait',
      description:
        "Wait. op=duration (fixed ms) | selector (element appears/disappears) | url (navigation) | response (network reply) | load (page load state) | function (in-page expression becomes truthy) | request (network request) | event (a download). selector takes `selector` + optional `state` (visible|attached|hidden|detached); url takes `pattern`; response takes `url` + optional `body` (none|text|json); load takes `state` (load|domcontentloaded|networkidle); function takes `expression`; request takes `url`. `timeout` in ms (default 10000; page-level ops load/function/request/event default 30000). Every op except duration accepts `space`.",
      parameters: {
        op: {
          type: 'string',
          required: true,
          description: '"duration" | "selector" | "url" | "response" | "load" | "function" | "request" | "event".',
        },
        ms: { type: 'number', description: 'op=duration: milliseconds to wait (default 1000).' },
        selector: {
          type: 'string',
          description: "op=selector: CSS selector to wait for, e.g. '.results' or '[data-id=done]'.",
        },
        state: {
          type: 'string',
          description: 'op=selector: "visible" (default) | "attached" | "hidden" | "detached". op=load: "load" (default) | "domcontentloaded" | "networkidle".',
        },
        pattern: {
          type: 'string',
          description: "op=url: URL/glob to match (e.g. '/login?done', 'https://*/post/*', or a /regex/).",
        },
        url: {
          type: 'string',
          description: "op=response: URL/glob/regex, e.g. '/api/search'. op=request: URL substring / glob / regex.",
        },
        body: { type: 'string', description: "op=response: 'none' (default) | 'text' | 'json'." },
        expression: {
          type: 'string',
          description: 'op=function: in-page JS expression evaluated until truthy.',
        },
        timeout: {
          type: 'number',
          description: 'Wait in ms (default 10000; page-level ops default 30000).',
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const send = (expr: string): string =>
          `console.log('${SENTINEL}' + JSON.stringify(${expr}))\n`
        const op = str(args.op, '').trim()
        // 两档默认值与合并前一致：普通 op 10s，页面级 op 30s。
        const asked = num(args.timeout, 0)
        const to = asked > 0 ? asked : 10_000
        const pageTo = asked > 0 ? asked : 30_000
        const head = `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}`
        if (op === 'duration') {
          // duration 不需要真实 tab（与合并前的 bcdp_wait 一致），故不带 head。
          const ms = Math.max(0, num(args.ms, 1000))
          return `await page.waitForTimeout(${ms})\n` +
            send(`{ ok: true, op: 'duration', waitedMs: ${ms} }`)
        }
        if (op === 'selector') {
          const sel = str(args.selector, '').trim()
          if (sel === '') return send(`{ ok: false, op: 'selector', waited: false, reason: 'bcdp_wait: selector is required for op=selector' }`)
          return head +
            `await page.waitForSelector(${j(sel)}, { state: ${j(
              str(args.state, 'visible'),
            )}, timeout: ${to} })\n` +
            send(`{ ok: true, op: 'selector', waited: true, selector: ${j(sel)}, state: ${j(str(args.state, 'visible'))} }`)
        }
        if (op === 'url') {
          const p = str(args.pattern, '').trim()
          if (p === '') return send(`{ ok: false, op: 'url', reached: false, reason: 'bcdp_wait: pattern is required for op=url' }`)
          return head +
            `const __ok = await page.waitForURL(${j(p)}, { timeout: ${to} }).catch(() => false)\n` +
            `const __u = await page.url()\n` +
            send(`{ ok: !!__ok, op: 'url', reached: !!__ok, url: __u }`)
        }
        if (op === 'response') {
          const u = str(args.url, '').trim()
          if (u === '') return send(`{ ok: false, op: 'response', reason: 'bcdp_wait: url is required for op=response' }`)
          const mode = str(args.body, 'none')
          const wantBody = mode === 'text' || mode === 'json'
          return head +
            `const __res = await page.waitForResponse(${j(u)}, { timeout: ${to} })\n` +
            `${wantBody ? `const __body = ${mode === 'json' ? 'await __res.json().catch(()=>null)' : 'await __res.text().catch(()=>null)'}\n` : ''}` +
            send(`{ ok: true, op: 'response', url: __res.url(), status: __res.status()${wantBody ? ', body: __body' : ''} }`)
        }
        if (op === 'load') {
          // waitForLoadState RESOLVES true/false (never throws on timeout).
          return head +
            `const __ok = await page.waitForLoadState(${j(str(args.state, 'load'))}, { timeout: ${pageTo} })\n` +
            send(`{ ok: !!__ok, op: 'load', state: ${j(str(args.state, 'load'))}, reason: __ok ? null : 'timed out: load state not reached within ${pageTo}ms' }`)
        }
        if (op === 'function') {
          const expr = str(args.expression, '').trim()
          if (expr === '') return send(`{ ok: false, op: 'function', reason: 'bcdp_wait: expression is required for op=function' }`)
          // waitForFunction RESOLVES the truthy value or false (never throws on
          // timeout). The expression is wrapped IN-PAGE (safeEvalWrap,
          // preserveFalsy) so a truthy cyclic/DOM/global handle degrades to a
          // string before it crosses the CDP boundary (see findings P0-2 / E).
          return head +
            `const __v = await page.waitForFunction(${j(safeEvalWrap(expr, true))}, undefined, { timeout: ${pageTo} })\n` +
            send(`{ ok: !!__v, op: 'function', value: __v === false ? null : __v, reason: __v === false ? 'timed out: expression never became truthy within ${pageTo}ms' : null }`)
        }
        if (op === 'request') {
          const u = str(args.url, '').trim()
          if (u === '') return send(`{ ok: false, op: 'request', reason: 'bcdp_wait: url is required for op=request' }`)
          // waitForRequest THROWS "timed out after Nms" — wrap it.
          return head +
            `try { const __req = await page.waitForRequest(${j(u)}, { timeout: ${pageTo} })\n` +
            send(`{ ok: true, op: 'request', url: __req.url(), method: __req.method() }`) +
            `} catch (e) { ${send(`{ ok: false, op: 'request', reason: String(e && e.message || e) }`)} }\n`
        }
        if (op === 'event') {
          // waitForEvent supports ONLY "download"; it throws on timeout.
          return head +
            `try { const __ev = await page.waitForEvent('download', { timeout: ${pageTo} })\n` +
            `const __p = await __ev.path().catch(() => null)\n` +
            send(`{ ok: true, op: 'event', event: 'download', suggestedFilename: __ev.suggestedFilename(), url: __ev.url(), path: __p }`) +
            `} catch (e) { ${send(`{ ok: false, op: 'event', reason: String(e && e.message || e) }`)} }\n`
        }
        return send(`{ ok: false, reason: ${j('bcdp_wait: op must be one of duration|selector|url|response|load|function|request|event')} }`)
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_key',
      description:
        "Press a key/combo ('Enter', 'Tab', 'Control+a', 'Escape') or type text character-by-character.",
      parameters: {
        key: { type: 'string', description: "Key/combo: 'Enter', 'Control+c', 'ArrowDown', 'F5' (ignored when text is given)." },
        text: { type: 'string', description: 'Type this text instead (keyboard.type).' },
        via: { type: 'string', description: "text mode: 'type' (default, per-character) | 'insert' (keyboard.insertText, faster for long strings)." },
        space: spaceParam,
      },
      buildScript: (args) => {
        const txt = str(args.text, '')
        const k = str(args.key, '').trim()
        if (txt !== '') {
          const method = str(args.via, 'type') === 'insert' ? 'insertText' : 'type'
          return (
            `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
            `await page.keyboard.${method}(${j(txt)})\n` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, typed: ${j(txt)} }))\n`
          )
        }
        if (k === '')
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_key: provide key or text to type' }))\n`
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `await page.keyboard.press(${j(k)})\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, key: ${j(k)} }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_hover',
      description:
        'Move the pointer over an element (CSS selector / ref) or to viewport coordinates. Triggers CSS :hover, dropdowns and mouseenter handlers.',
      parameters: {
        selector: {
          type: 'string',
          description: 'CSS selector, xpath=..., loc=..., or ref=N for the element.',
        },
        x: { type: 'number', description: 'Viewport x (only with y).' },
        y: { type: 'number', description: 'Viewport y (only with x).' },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.selector, '')
        const hasXY = typeof args.x === 'number' && typeof args.y === 'number'
        if (sel === '' && !hasXY)
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_hover: provide selector or both x and y' }))\n`
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          (sel !== ''
            ? `await page.locator(${j(sel)}).hover()\n`
            : `await page.mouse.move(${args.x}, ${args.y})\n`) +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_read_element',
      description:
        'Read one element: text, HTML, value, an attribute, or visible/enabled/count.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector of the target.' },
        what: { type: 'string', description: "'text' (default) | 'html' | 'value' | 'attribute' | 'visible' | 'enabled' | 'count'." },
        attribute: { type: 'string', description: 'Attribute name when what=attribute.' },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.selector, '').trim()
        const what = str(args.what, 'text')
        if (sel === '')
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_read_element: selector is required' }))\n`
        const selExpr = `page.locator(${j(sel)})`
        let expr
        switch (what) {
          case 'html': expr = `await ${selExpr}.innerHTML()`; break
          case 'value': expr = `await ${selExpr}.inputValue()`; break
          case 'attribute': expr = `await ${selExpr}.getAttribute(${j(str(args.attribute, ''))})`; break
          case 'visible': expr = `await ${selExpr}.isVisible()`; break
          case 'enabled': expr = `await ${selExpr}.isEnabled()`; break
          case 'count': expr = `await ${selExpr}.count()`; break
          default: expr = `await ${selExpr}.textContent()`
        }
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `${SAFE_FN}` +
          `const __v = ${expr}\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, what: ${j(what)}, selector: ${j(
            sel,
          )}, value: safe(__v) }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_select',
      description:
        'Choose an option in a <select> dropdown by value, label, or index (a single value or an array for multi-select).',
      parameters: {
        selector: {
          type: 'string',
          required: true,
          description: 'CSS selector of the <select> element.',
        },
        value: {
          type: 'json',
          description:
            "The option: a string value/label, or {value:'..'}, {label:'..'}, {index:n}, or an array of these for multi-select.",
        },
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
        `await page.locator(${j(str(args.selector, ''))}).selectOption(${j(
          args.value ?? '',
        )})\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, select: ${j(
          str(args.selector, ''),
        )} }))\n`,
    }),
  )
  reg(
    t({
      name: 'bcdp_drag',
      description:
        'Drag an element to a target (Playwright dragTo) or drag the pointer through coordinates. Use for sliders, sortable rows, and drag-drop zones.',
      parameters: {
        from: {
          type: 'string',
          description: 'CSS selector of the element to drag from.',
        },
        to: {
          type: 'string',
          description: 'CSS selector of the drop target (used with from).',
        },
        points: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Alternative: a flat list of [x1,y1,x2,y2,...] viewport coordinates to drag the mouse through.',
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const pts = Array.isArray(args.points)
          ? (args.points as unknown[]).map(Number).filter((n) => Number.isFinite(n))
          : []
        const hasEl =
          str(args.from, '') !== '' && str(args.to, '') !== ''
        if (!hasEl && pts.length < 4)
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_drag: provide from+to selectors, or at least 4 points (x1,y1,x2,y2)' }))\n`
        const action = hasEl
          ? `await page.locator(${j(str(args.from, ''))}).dragTo(page.locator(${j(
              str(args.to, ''),
            )}))\n`
          : `const __pts = ${j(pts)}\nconst __coords=[];for(let __i=0;__i<__pts.length;__i+=2){__coords.push([__pts[__i],__pts[__i+1]])}\nawait page.mouse.drag(__coords)\n`
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          action +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_scroll',
      description:
        'Scroll the page: by pixel deltas (wheel), or bring an element into view (scrollIntoView).',
      parameters: {
        deltaX: { type: 'number', description: 'Horizontal scroll delta (wheel) in px.' },
        deltaY: { type: 'number', description: 'Vertical scroll delta (wheel) in px.' },
        selector: {
          type: 'string',
          description: 'CSS selector to scroll into view (primary if given).',
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const hasSelector = str(args.selector, '') !== ''
        const hasDelta = Number.isFinite(args.deltaX) || Number.isFinite(args.deltaY)
        if (!hasSelector && !hasDelta)
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_scroll: provide deltaX/deltaY or a selector' }))\n`
        const action = hasSelector
          ? `await page.locator(${j(str(args.selector, ''))}).scrollIntoViewIfNeeded()\n`
          : `await page.mouse.wheel(${num(args.deltaX, 0)}, ${num(
              args.deltaY,
              300,
            )})\n`
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          action +
          `const __p = await page.info()\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, scrollX: __p.sx ?? null, scrollY: __p.sy ?? null }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_upload',
      description:
        'Set files on a file <input> element (path-driven). Use to upload a dataset/attachment from a local path.',
      parameters: {
        selector: {
          type: 'string',
          required: true,
          description: 'CSS selector of the <input type=file> element.',
        },
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path of the file(s) to upload on this machine.',
        },
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
        `await page.locator(${j(str(args.selector, ''))}).setInputFiles(${j(
          str(args.path, ''),
        )})\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, upload: ${j(
          str(args.selector, ''),
        )} }))\n`,
    }),
  )
  reg(
    t({
      name: 'bcdp_download',
      description:
        'Wait for a download triggered by the current action, then return its saved path. Trigger with triggerSelector or triggerScript; optionally copy to savePath.',
      parameters: {
        triggerSelector: { type: 'string', description: 'CSS selector of the button/link whose click starts the download.' },
        triggerScript: { type: 'string', description: 'JS snippet that triggers the download (runs before waiting).' },
        savePath: { type: 'string', description: 'Absolute path to also copy the file to.' },
        timeout: { type: 'number', description: 'Wait timeout in ms (default 30000).' },
        space: spaceParam,
      },
      // Lightpanda backend �?the engine never fires Page.downloadWillBegin/
      // downloadProgress, so `page.waitForEvent('download')` would just hang
      // until the timeout. Fail fast with the engine-aware reason instead.
      gate: () =>
        defaultAttachCache.get().engine === 'lightpanda'
          ? 'engine-unsupported: the attached browser is Lightpanda, which has no Page download events �?bcdp_download cannot capture files on this engine. Trigger the download another way (e.g. fetch() the URL in-page and return the bytes).'
          : null,
      buildScript: (args) => {
        const sel = str(args.triggerSelector, '')
        const script = str(args.triggerScript, '')
        const savePath = str(args.savePath, '')
        const timeout = num(args.timeout, 30000)
        const trigger =
          sel !== ''
            ? `await page.locator(${j(sel)}).click()\n`
            : script !== ''
              ? `await page.evaluate(() => { ${script} })\n`
              : '/* no trigger given �?the download may be started by an earlier navigation */\n'
        const save =
          savePath !== ''
            ? `const __final = await __dl.saveAs(${j(savePath)}).catch(()=>null)\n`
            : `const __final = await __dl.path().catch(()=>null)\n`
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `const __dlPromise = page.waitForEvent('download', { timeout: ${timeout} })\n` +
          trigger +
          `const __dl = await __dlPromise\n` +
          `const __name = typeof __dl.suggestedFilename === 'function' ? __dl.suggestedFilename() : null\n` +
          `const __url = typeof __dl.url === 'function' ? __dl.url() : null\n` +
          save +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path: __final, suggestedFilename: __name, url: __url }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_check',
      description:
        'Check (tick) or uncheck a checkbox/radio element. Does nothing if already in the desired state.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector of the checkbox/radio.' },
        checked: { type: 'boolean', description: 'true=check (default), false=uncheck.' },
        space: spaceParam,
      },
      buildScript: (args) => {
        const chk = bool(args.checked, true)
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `await page.locator(${j(str(args.selector, ''))}).${chk ? 'check' : 'uncheck'}()\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, checked: ${chk} }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_dialog',
      description:
        'Accept or dismiss a native browser dialog (alert/confirm/prompt), optionally supplying text for a prompt. Use right after the action that triggers the dialog.',
      parameters: {
        accept: { type: 'boolean', description: 'true=Accept/OK (default), false=Dismiss/Cancel.' },
        text: { type: 'string', description: 'Text to type into a prompt dialog.' },
        space: spaceParam,
      },
      buildScript: (args) => {
        const accept = bool(args.accept, true)
        const text = str(args.text, '')
        const params = `{ accept: ${accept}${
          text !== '' ? `, promptText: ${j(text)}` : ''
        } }`
        // Do NOT run any page.evaluate here: while a dialog is showing the page
        // JS is paused, so a Runtime.evaluate would hang. handleJavaScriptDialog
        // is a CDP command and works even under a blocking dialog.
        return (
          `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` +
          `const __r = await cdp("Page.handleJavaScriptDialog", ${params}).catch((e) => ({ error: String(e) }))\n` +
          `const __ok = !!(__r && !__r.error)\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, handled: __ok, accept: ${accept}, error: __r?.error ?? null }))\n`
        )
      },
    }),
  )
  reg(
    t({
      name: 'bcdp_http',
      description:
        "Make an HTTP request and return status + body. Default runs in the page's browser context; mode=server uses Node-side fetch.server (may crash on the vendored ego-linux Windows runtime, so prefer browser mode). To render a page use bcdp_navigate; server mode is not bound by page CORS.",
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute URL to request.' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        headers: { type: 'object', additionalProperties: true, description: "Request headers, e.g. { 'Content-Type': 'application/json' }." },
        body: { type: 'string', description: 'Request body (POST/PUT).' },
        timeout: { type: 'number', description: 'Timeout in ms (default 20000).' },
        mode: { type: 'string', description: "'browser' (default) or 'server' (Node-side fetch)." },
        credentials: { type: 'string', description: "Browser mode: 'include' sends the profile's cookies cross-origin; 'omit'/'same-origin' also accepted. Default: engine default." },
        space: spaceParam,
      },
      buildScript: (args) => {
        const opts: Record<string, unknown> = {
          method: str(args.method, 'GET'),
          headers: args.headers && typeof args.headers === 'object' ? args.headers : {},
          timeout: num(args.timeout, 20000),
        }
        if (str(args.body, '') !== '') opts.body = str(args.body, '')
        const mode = str(args.mode, 'browser')
        // issue #1 (feature ask): let browser-mode requests carry the profile's
        // login cookies cross-origin. Whitelisted values only �?anything else
        // stays exactly the pre-existing behavior (field absent = engine default).
        const cred = str(args.credentials, '')
        if (mode !== 'server' && (cred === 'include' || cred === 'omit' || cred === 'same-origin')) opts.credentials = cred
        const pre = mode === 'server' ? '' : `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}`
        return (
          `${pre}${SAFE_FN}` +
          `const __r = await fetch.${mode === 'server' ? 'server' : 'browser'}(${j(
            str(args.url, ''),
          )}, ${j(opts)})\n` +
          `const __status = typeof __r.status !== "undefined" ? __r.status : 200\n` +
          `let __body = null\n` +
          `try { __body = typeof __r.text === "function" ? await __r.text() : (typeof __r === "string" ? __r : JSON.stringify(safe(__r))) } catch { __body = null }\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, mode: ${j(mode)}, status: __status, body: __body, url: ${j(
            str(args.url, ''),
          )} }))\n`
        )
      },
    }),
  )
}

// ── bcdp_help: built-in tool / category index ───────────────────────────────
/** Register bcdp_help / bcdp_doctor / bcdp_script. */
function registerHelpAndDoctor(ctx: EgoContext, cfg: EgoRuntimeConfig, reg: (tool: ToolHandle) => void, tiers: TierView): void {
  reg(
    defineTool({
      name: 'bcdp_captcha',
      description:
        'Check the current page for a human-verification (CAPTCHA) challenge �?reCAPTCHA / hCaptcha / Cloudflare / Turnstile �?and return { detected, kind }. If detected=true, ALERT THE USER that they must complete the verification in the \'ego lite - agent\' browser window (it is the same live session shown in the watch panel), then continue after they have.',
      parameters: {
        space: { type: 'string', description: 'Task-space name or numeric id; defaults to the configured defaultSpace.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            detected: { type: 'boolean', required: true },
            kind: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            /** Lightpanda backend —知情元数据: the probe is DOM-based, so detection works unchanged. */
            engine: { type: 'string' },
            rendering: { type: 'string' },
          },
        },
        render: renderText,
      },
      timeoutMs: 15_000,
      execute: async (args: Record<string, unknown>, exec: ToolExec) =>
        withEgoLock(async () => {
          cfg.spaceTracker.setCurrentSession(callingSessionId(exec)); markEgoToolCall(callingSessionId(exec))
          const result = await runWithStaleSpaceRetry(
            ctx,
            cfg,
            { signal: exec?.signal } as ToolExec,
            () => humanCheckScript(str(args.space, cfg.activeSpace)),
          )
          if (!result.ok)
            return { ok: false, detected: false, kind: null, error: result.error }
          const p = (parseSentinel(mergeCliOutput(result)) || {}) as Record<string, unknown>
          const hc = p.humanCheck as { detected?: boolean; kind?: string } | undefined
          return {
            ok: true,
            detected: !!hc?.detected,
            kind: hc?.kind ?? null,
            ...(defaultAttachCache.get().engine === 'lightpanda' ? { engine: 'lightpanda', rendering: 'text' } : {}),
          }
        }),
      presentCall: () => ({ card: 'generic', title: 'bcdp_captcha', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )
  reg(
    defineTool({
      name: 'bcdp_help',
      description:
        'Query the built-in ego-browser tool guide. `topic` may be a category (overview/tools/navigate/observe/input/keyboard-mouse/form/wait/network/login/script/doctor) or a specific tool name (e.g. bcdp_click). Returns the matching usage notes. Call this when unsure which eyebrow tool to use. If a bcdp_* tool is missing from your list, ask topic=injection.',
      parameters: {
        topic: {
          type: 'string',
          description:
            'Category or tool name to look up; omitted/all returns the overview index.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            topic: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      timeoutMs: 10_000,
      execute: async (args: Record<string, unknown>, exec: ToolExec) => {
        // help 已属 act 批，能被调用说明活动已发生；此处 pulse 只推进批次深度（幂等）。
        tiers.pulse(callingSessionId(exec))
        const q = str(args.topic, '').trim().toLowerCase()
        const key = Object.prototype.hasOwnProperty.call(EGO_HELP_INDEX, q) ? q : ''
        const text = key
          ? EGO_HELP_INDEX[key]!
          : (q
              ? `未找�?topic "${q}"。可�? ` +
                Object.keys(EGO_HELP_INDEX)
                  .filter((k) => k !== 'overview')
                  .join(', ') +
                '\n\noverview: ' +
                EGO_HELP_INDEX.overview
              : EGO_HELP_INDEX.overview)
        return { ok: true, topic: q || 'overview', text }
      },
      presentCall: () => ({ card: 'generic', title: 'bcdp_help', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )
  reg(
    defineTool({
      name: 'bcdp_doctor',
      description:
        'Preflight the ego-browser environment: vendored runtime present, Chrome/Edge/Brave candidates, state dir, CDP/browser.json, ego-cast worker, task spaces. Run first when the browser fails to start (update, reboot, port conflict) or before a long session.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true }, report: { type: 'string', required: true } },
        },
        render: renderText,
      },
      timeoutMs: 25_000,
      execute: async (_args: Record<string, unknown>, exec: ToolExec) => {
        // doctor 同样视为一次浏览器活动，推进批次深度。
        tiers.pulse(callingSessionId(exec))
        const lines: string[] = []
        // 工具注入面：每个开关的当前状态与实际注册了多少工具，一行说完�?
        {
          const s = tiers.surface()
          const key = judgeConfigured({ jevKey: cfg.jevKey, layaKey: cfg.layaKey })
          lines.push(
            `tool injection: mode=${cfg.toolInjection}` +
            ` browse=${cfg.toolBrowse ? 'open' : 'sealed'} extended=${cfg.toolExtended ? 'open' : 'sealed'}` +
            ` escape=${cfg.toolEscape ? 'open' : 'sealed'}` +
            ` judge=${cfg.toolJudge ? 'open' : 'sealed'} judgeKey=${key ? 'set' : 'none'}` +
            ` active=${tiers.active() ? 'yes' : 'no'} �?live ${s.live.length} / sealed ${s.sealed.length}`,
          )
        }
        lines.push(scopeProbeLine())
        // vendored runtime
        lines.push(`egoBin: ${cfg.egoBin}`)
        try { lines.push(`egoBin exists: ${existsSync(cfg.egoBin)}`) } catch { lines.push('egoBin exists: n/a') }
        // Chrome candidates
        const chrome = findChromeBinary()
        const configured = cfg.chromePath
        if (configured) {
          lines.push(`browser binary: ${configured} (from settings)`)
        } else {
          lines.push(`browser binary: ${chrome || '(none found �?set chromePath in settings, or set EGO_LINUX_CHROME, or install Chrome/Edge/Brave)'}`)
        }
        // User-configured extra CLI args (effective after filtering). ego-CLI
        // args take effect on the next bcdp_* call; Chrome args only on the next
        // browser cold start (the browser is a singleton �?run `ego-browser
        // --stop` or restart DSH to relaunch).
        const cliArgs = filterArgs(cfg.runtimeArgs ?? '', EGO_CLI_BLOCKED)
        const chrArgs = filterArgs(cfg.chromeArgs ?? '', CHROME_BLOCKED)
        lines.push(`runtimeArgs (effective): ${cliArgs.length ? cliArgs.join(' ') : '(none)'}`)
        // T2.16/T2.18 — attach provenance + the remote switch, in the doctor.
        const attachNow = defaultAttachCache.get()
        // Channel ownership: which link owns routing right now and WHY — an
        // activated entry that is disabled/gone shows the priority fallback
        // that took over instead of silently routing somewhere.
        const channel = effectiveChannel(cfg)
        lines.push(
          `channel: ${channel.effective
            ? `${channel.effective.link.label} [${channel.effective.link.id}] (${channel.effective.reason}${channel.effective.demotedId ? `, over ${channel.effective.demotedId}` : ''})`
            : '(none — activate a link or enable one)'}`,
        )
        lines.push(`remote CDP: ${cfg.remoteEnabled === false ? 'DISABLED by switch (sequence preserved)' : 'enabled'}`)
        lines.push(`attach: ${attachNow.status}${attachNow.endpointSource ? ` (source: ${attachNow.endpointSource})` : ''}${attachNow.endpoint ? ` @ ${attachNow.endpoint}` : ''}`)
        // ── Lightpanda backend: engine, degradation list, per-OS install hint ──
        if (attachNow.engine !== undefined) {
          lines.push(`engine: ${attachNow.engine}`)
        }
        if (attachNow.engine === 'lightpanda') {
          lines.push('degraded on this engine: live view (no screencast) · panel pick (no Overlay/bindingCalled) · bcdp_download (no Page download events) · screenshots are PNG text-renders · auth_flush is a no-op')
        }
        if (attachNow.engine === 'lightpanda' || process.platform === 'win32') {
          lines.push(
            process.platform === 'win32'
              ? 'lightpanda on win32: no native build �?use WSL2: `wsl --install` (admin), then inside WSL: `curl -fsSL https://pkg.lightpanda.io/install.sh | bash` + `lightpanda serve --host 127.0.0.1 --port 9222`; WSL2 maps the port to Windows localhost, then add http://127.0.0.1:9222 as a CDP endpoint. Docker alternative: `docker run -d -p 127.0.0.1:9222:9222 lightpanda/browser:nightly`.'
              : 'lightpanda (linux/macOS): `curl -fsSL https://pkg.lightpanda.io/install.sh | bash` (installs to ~/.local/bin) then `lightpanda serve --host 127.0.0.1 --port 9222`.',
          )
        }
        // ── R7: connection kinds, the local CLI, and the conflict guard ────
        const kindCount = (kind: string): number => cfg.links.filter((link) => link.kind === kind).length
        const dropped = cfg.droppedEgoCli
        lines.push(`links: ${cfg.links.length} (cdp ${kindCount('cdp')}, ego-cli ${kindCount(EGO_CLI_KIND)}, lightpanda ${kindCount(LP_KIND)})${dropped > 0 ? ` �?${dropped} extra ego-cli row(s) dropped (local-only singleton)` : ''}`)
        // Lightpanda backend �?managed-serve row status + the quick-trial vs
        // headed-backstop positioning, in the doctor where confusion gets solved.
        if (kindCount(LP_KIND) > 0) {
          const lpRow = cfg.links.find((link) => link.kind === LP_KIND) as LightpandaLink | undefined
          lines.push(`lightpanda row: servePath=${lpRow?.servePath === undefined || lpRow.servePath === '' ? '(auto: PATH �?~/.local/bin; win32 via WSL2)' : lpRow.servePath} �?headless quick-trial engine; headed kinds (CDP / local Chrome / ego CLI) are the manual-fallback backstop`)
        }
        // Resolve the CLI for real (no process is spawned for resolution) so the
        // doctor reports what a call would actually launch, not what was probed.
        const cliLink = cfg.links.find((link) => link.kind === EGO_CLI_KIND)
        if (cliLink && cliLink.kind === EGO_CLI_KIND) {
          const resolved = resolveCliBinary({ cliPath: cliLink.cliPath, bundled: VENDORED_EGO_BIN }, createSubprocessCliIo(ctx.subprocess))
          lines.push(resolved.ok
            ? `cli: ${resolved.path} (${resolved.origin}${attachNow.cliShape ? `, shape ${attachNow.cliShape}` : ''})`
            : `cli: (missing) �?${resolved.message}`)
        }
        const toolCount = ((EGO_HELP_INDEX['tools'] ?? '').match(/bcdp_/g) ?? []).length
        const legacy = cfg.legacyEgoToolNames === true
        lines.push(`naming: ${toolCount} bcdp_* tools; legacy ego_* aliases ${legacy ? 'ON (mutually exclusive with the old dsh-ego-browser plugin)' : 'OFF (coexists with the old dsh-ego-browser plugin)'}`)
        const upstream = findUpstreamPluginInstall()
        if (upstream !== '') {
          lines.push(`conflict: old dsh-ego-browser installed at ${upstream} �?only one plugin should drive the local ego browser (they would share its task spaces)`)
        }
        lines.push(`chromeArgs (effective, next cold start): ${chrArgs.length ? chrArgs.join(' ') : '(none)'}`)
        // state dir + runtime state
        const isWin = process.platform === 'win32'
        const e = process.env
        const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || '' : homedir())
        const stateDir =
          e.EGO_LINUX_STATE_DIR ||
          (isWin
            ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + '\\ego-lite-linux'
            : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`)
        lines.push(`state dir: ${stateDir} (exists: ${existsSync(stateDir)})`)
        const bjson = `${stateDir}/browser.json`
        let browserReport = 'browser.json: (none �?agent browser not running)'
        if (existsSync(bjson)) {
          try {
            const { readFile } = await import('node:fs/promises')
            const b = JSON.parse(await readFile(bjson, 'utf8')) as { port?: unknown; pid?: number; headless?: unknown }
            const alive = b.pid ? await (async () => { try { process.kill(b.pid!, 0); return true } catch (x) { return (x as NodeJS.ErrnoException)?.code === 'EPERM' } })() : false
            browserReport = `browser.json: port=${b.port} pid=${b.pid} alive=${alive} headless=${b.headless}`
          } catch (err) {
            browserReport = `browser.json: unreadable (${(err as Error)?.message})`
          }
        }
        lines.push(browserReport)
        // task spaces
        const tjson = `${stateDir}/task-spaces.json`
        if (existsSync(tjson)) {
          try {
            const { readFile } = await import('node:fs/promises')
            const t = JSON.parse(await readFile(tjson, 'utf8')) as { spaces?: unknown[] }
            lines.push(`task spaces: ${(t.spaces || []).length}`)
          } catch { /* ignore */ }
        }
        lines.push('headless override: ' + (e.EGO_LINUX_HEADLESS ? 'yes (' + e.EGO_LINUX_HEADLESS + ')' : 'no'))
        lines.push('npm/node: ' + process.version)
        // ── 阶段 10: the judgement chain, in the doctor because a judge that
        // silently skips every hop is the single hardest failure to diagnose
        // from a tool's output alone. Reporting the chain here means one command
        // separates "the page had no candidates" from "nothing could answer".
        {
          const judge = judgeCfg()
          const runtime = buildJudgeRuntime(judge, { now: () => Date.now() })
          const ready = describeJudge(runtime).filter((line) => line.includes('ready')).length
          lines.push(`judge: ${runtime.order.join(' -> ')} (${ready} http hop(s) ready)`)
          lines.push(`judge jev: ${judge.jevUrl === '' ? 'not configured' : `${judge.jevUrl} key=${judge.jevKey === '' ? 'MISSING' : 'set'}`}`)
          lines.push(`judge laya: ${judge.layaUrl} key=${judge.layaKey === '' ? 'MISSING (hop will be SKIPPED)' : 'set'}`)
          lines.push(`judge budgets: chunk=${judge.chunkSize} steps=${judge.stepBudget} wall=${judge.wallMs}ms imageBytes=${judge.maxImageBytes === 0 ? 'unbounded' : judge.maxImageBytes}`)
          lines.push(`judge worker: ${existsSync(RENDER_WORKER_BIN) ? RENDER_WORKER_BIN : `MISSING at ${RENDER_WORKER_BIN}`}`)
        }
        return { ok: true, report: lines.join('\n') }
      },
      presentCall: () => ({ card: 'generic', title: 'bcdp_doctor', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )
  reg(
    (() => {
      const def = defineTool({
        name: 'bcdp_script',
        description:
          'Run an arbitrary `ego-browser nodejs` heredoc script in ONE invocation (page/…locator/browser/taskSpaces/site/fetch/cdp preloaded), and return structured {ok, stdout, stderr, result, durationMs, timedOut}. Use for a full multi-step browser task as a single script. The task space is selected and a real (non-blank) tab activated for you before your script runs, so page.* works directly. Set verbatim:true to run the body verbatim with no preamble (the retired bcdp_cli behaviour). For a single page expression use bcdp_js. These scripts expose the vendored SDK (`taskSpaces`, `page.locator()`, global `cdp()`, `fetch.browser|server`) �?NOT the official docs\' `taskSpace()` / `page.click()`.',
        parameters: {
          script: {
            type: 'string',
            required: true,
            description:
              'Full JS script body. You may end with console.log(JSON.stringify(payload)) �?bare or prefixed with the sentinel �?and it is returned as `result`. Without one, `output` still carries everything the script printed.',
          },
          timeoutMs: { type: 'integer', description: 'Per-run timeout in ms (default plugin grace).' },
          verbatim: {
            type: 'boolean',
            description:
              'Run the body verbatim with NO preamble (no task-space selection, no real-tab activation) — the retired bcdp_cli behaviour. Default false prepends the preamble so page.* works directly. In verbatim mode select the space yourself (`await taskSpaces.useOrCreate(name)`) before touching page.*.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              stdout: { type: 'string', required: true },
              stderr: { type: 'string' },
              output: {
                type: 'string',
                description:
                  'Merged stdout+stderr text of the CLI run. The ego CLI writes script output to stderr on Windows, so read this when `stdout` looks empty.',
              },
              result: { type: 'json' },
              durationMs: { type: 'integer' },
              timedOut: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
          render: renderText,
        },
        timeoutMs: TOOL_TIMEOUT_MS,
        execute: async (args: Record<string, unknown>, exec: ToolExec) => {
          cfg.spaceTracker.setCurrentSession(callingSessionId(exec)); markEgoToolCall(callingSessionId(exec))
          // Honor the documented per-run timeout override (integer ms). Falls
          // back to the plugin's default grace when absent/invalid.
          const timeoutMs =
            typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
              ? args.timeoutMs
              : undefined
          const start = Date.now()
          // bcdp_script (when verbatim is false) is the "just give me a working page"
          // entry point, so it carries the same preamble every structured tool
          // does: pick the task space, then activate a real (non-blank) tab.
          // Without it a plain `page.evaluate(...)` body dies with
          // "Task space not selected" �?which reads as a plugin failure.
          // A body that already selects its own space keeps it: useOrCreate is
          // idempotent by name, so the preamble is skipped when the script
          // mentions taskSpaces.useOrCreate itself.
          // verbatim:true reproduces the retired bcdp_cli: the body runs with NO
          // preamble, so the caller owns task-space selection.
          const verbatimMode = bool(args.verbatim, false)
          const preamble = (body: string): string => {
            if (verbatimMode) return body
            if (/taskSpaces\s*\.\s*useOrCreate\s*\(/.test(body)) return body
            return `${useSpace(cfg.activeSpace)}${ensureRealTab()}${body}`
          }
          const result = await runWithStaleSpaceRetry(
            ctx, cfg, exec, () => preamble(str(args.script, '')), timeoutMs,
          )
          const durationMs = Date.now() - start
          if (!result.ok)
            return {
              ok: false,
              stdout: result.stdout,
              stderr: result.stderr,
              output: attachSessionHint(mergeCliOutput(result)),
              durationMs,
              timedOut: false,
              error: attachSessionHint(result.error),
            }
          const parsed = parseSentinel(mergeCliOutput(result))
          return {
            ok: true,
            stdout: result.stdout,
            stderr: result.stderr,
            output: mergeCliOutput(result),
            result: parsed ?? null,
            durationMs,
            timedOut: false,
          }
        },
        presentCall: () => ({ card: 'generic', title: 'bcdp_script', kind: 'other', rawInput: null }),
      } as unknown as DefineToolOpts)
      return def
    })(),
  )

  // ── 阶段 10: JEV/Laya judge tools ────────────────────────────────────────
  //
  // Four HOST-SIDE tools (defineTool, not t()): the judge call is an HTTP
  // request from this Node process, not a script inside the ego runtime. The
  // browser-facing half still goes through the render worker, which is the only
  // holder of a CDP channel.

  /**
   * The judge settings, read live off the runtime config.
   *
   * Assembled field-by-field here rather than carried as one object on `cfg`,
   * because `EgoRuntimeConfig` must stay structurally assignable to
   * `ResolvedConfig` (see the interface note) and a nested object would break
   * that. Each field is a live getter, so a settings edit lands on the next call.
   */
  const judgeCfg = (): JudgeSettings => ({
    jevUrl: cfg.jevUrl,
    jevKey: cfg.jevKey,
    jevModel: cfg.jevModel,
    layaUrl: cfg.layaUrl,
    layaKey: cfg.layaKey,
    layaModel: cfg.layaModel,
    prefer: cfg.judgePrefer,
    chunkSize: cfg.jevChunkSize,
    maxImageBytes: cfg.jevMaxImageBytes,
    historyLimit: cfg.jevHistoryLimit,
    archiveImage: cfg.jevArchiveImage,
    evaluate: cfg.jevEvaluate,
    stepBudget: cfg.jevStepBudget,
    wallMs: cfg.jevWallMs,
  })

  /** Build the intent from tool args. Hints stay hints �?never selectors. */
  const intentFrom = (args: Record<string, unknown>): IntentSpec => {
    const hints = str(args.hints, '')
    const criteria = str(args.successCriteria, '')
    const stops = str(args.stopConditions, '')
    return {
      goal: str(args.goal, ''),
      kind: (str(args.kind, 'other') || 'other') as IntentSpec['kind'],
      targetHints: hints === '' ? [] : hints.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
      successCriteria: criteria === '' ? [] : criteria.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
      stopConditions: stops === '' ? [] : stops.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
      // Recorded so a misjudgement can be attributed later: an intent a USER
      // typed and one a rule inferred are not equally trustworthy.
      source: 'user',
    }
  }

  /** The judge runtime, rebuilt per call so a settings edit takes effect now. */
  const judgeRuntimeOf = () =>
    buildJudgeRuntime(judgeCfg(), {
      // The injected clock is the real one here; only tests inject otherwise.
      now: () => Date.now(),
    })

  /**
   * The effects, bound to this plugin's worker + the live attach cache.
   *
   * `wsUrl` comes from the attach cache, which is the same source the panel's
   * badge reads. When it is empty there is no live browser and EVERY jev tool
   * must say so rather than failing later with a confusing worker error.
   */
  const effectsOf = (judge: ReturnType<typeof judgeRuntimeOf>, onFrame?: (frame: Frame) => void) => {
    const { attach } = effectiveChannel(cfg)
    return makeJudgeEffects({
      subprocess: ctx.subprocess,
      workerPath: RENDER_WORKER_BIN,
      wsUrl: attach.wsUrl,
      targetId: attach.targetId,
      ...(attach.engine === undefined ? {} : { engine: attach.engine }),
      judge,
      maxImageBytes: cfg.jevMaxImageBytes,
      candidateLimit: cfg.jevChunkSize,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }),
      ...(onFrame === undefined ? {} : { onFrame }),
    })
  }

  /** The browser must be attached before any frame exists. Shared by 3 tools. */
  const attachGate = (): string => {
    const { attach } = effectiveChannel(cfg)
    if (attach.wsUrl === '') {
      return (
        'no live browser: the activated link has no CDP endpoint yet. ' +
        'Run bcdp_status (or bcdp_doctor) to attach, then retry. ' +
        `(attach status=${attach.status}${attach.code === '' ? '' : `, code=${attach.code}`})`
      )
    }
    return ''
  }

  reg(
    defineTool({
      name: 'bcdp_jev_status',
      description:
        'Report the JEV/Laya judgement chain WITHOUT calling anything: which hops are configured, which will be skipped and why, thresholds, budgets, and the browser attach state. Run this first when judging fails.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
        },
        render: renderText,
      },
      timeoutMs: 10_000,
      execute: async (_args: Record<string, unknown>, exec: ToolExec) => {
        cfg.spaceTracker.setCurrentSession(callingSessionId(exec)); markEgoToolCall(callingSessionId(exec))
        const judge = judgeCfg()
        const runtime = judgeRuntimeOf()
        const { attach } = effectiveChannel(cfg)
        const lines: string[] = [
          'judgement chain (priority order):',
          ...describeJudge(runtime),
          '',
          `prefer (raw)      : ${judge.prefer}`,
          `prefer (parsed)   : ${runtime.order.join(' -> ')}`,
          `jev               : ${judge.jevUrl === '' ? '(not configured)' : judge.jevUrl} model=${judge.jevModel} key=${judge.jevKey === '' ? 'MISSING' : 'set'}`,
          `laya              : ${judge.layaUrl} model=${judge.layaModel} key=${judge.layaKey === '' ? 'MISSING' : 'set'}`,
          '',
          `chunk ceiling     : ${judge.chunkSize} candidates`,
          `image budget      : ${judge.maxImageBytes === 0 ? 'unbounded (measured default)' : `${judge.maxImageBytes} B`}`,
          `history depth     : ${judge.historyLimit}`,
          `archive image     : ${judge.archiveImage ? 'embedded' : 'metadata only'}`,
          `loop budgets      : steps=${judge.stepBudget} wall=${judge.wallMs}ms captures=${DEFAULT_BUDGETS.captures}`,
          '',
          `browser attach    : ${attach.wsUrl === '' ? `NOT ATTACHED (status=${attach.status}${attach.code === '' ? '' : `, code=${attach.code}`})` : `${attach.endpoint} (${attach.endpointSource ?? 'unknown'})`}`,
        ]
        if (judge.layaKey === '') {
          // Called out explicitly because it is the single most common reason
          // judging returns nothing: an absent key is a GUARANTEED 401, so the
          // hop is skipped instead of tried, and silence looks like a dead server.
          lines.push(
            '',
            'laya has no key, so that hop is SKIPPED �?the chain is running on the offline rule hop alone.',
            'laya-api has no anonymous branch, so a keyless call is a guaranteed 401; skipping it is deliberate.',
            '',
            'To bring laya up locally:',
            '  1. start the sidecar (it serves 8000, and JevLoop\'s 7789 is a different tool):',
            '       ENGINE=laya LAYA_PRELOAD=true LAYA_DEVICE=cpu uvicorn laya_api.main:app',
            '     with ALLOW_DEV_LOGIN=true you can sign in without Google.',
            '  2. open http://localhost:8000, create an API key (it is shown once, format laya_...).',
            '  3. paste it into this panel\'s Laya key field and save.',
          )
        }
        return { ok: true, text: lines.join('\n') }
      },
      presentCall: () => ({ card: 'generic', title: 'bcdp_jev_status', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )

  reg(
    defineTool({
      name: 'bcdp_jev_ask',
      description:
        'Assemble the JEV/Laya judgement request for the current page + intent; return it (dryRun) or send it.',
      parameters: {
        goal: { type: 'string', required: true, description: 'What we are trying to accomplish.' },
        kind: { type: 'string', description: 'navigate | extract | fill | click | verify | other.' },
        hints: { type: 'string', description: 'Target hint per line; never a selector.' },
        successCriteria: { type: 'string', description: 'Success condition per line.' },
        stopConditions: { type: 'string', description: 'Stop condition per line.' },
        dryRun: { type: 'boolean', description: 'Assemble only, do not send (default true).' },
        includeImage: { type: 'boolean', description: 'Also return the base64 frame (default false).' },
        maxCandidates: { type: 'integer', description: 'Candidate ceiling for this call.' },
        round: { type: 'string', description: "'control' | 'chapter' | 'pick' (default control)." },
        chapter: { type: 'string', description: "Chapter key for a 'pick' round, e.g. form#1." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
        },
        render: renderText,
      },
      timeoutMs: 60_000,
      execute: async (args: Record<string, unknown>, exec: ToolExec) => {
        cfg.spaceTracker.setCurrentSession(callingSessionId(exec)); markEgoToolCall(callingSessionId(exec))
        const blocked = attachGate()
        if (blocked !== '') return { ok: false, text: blocked }
        const goal = str(args.goal, '')
        if (goal === '') return { ok: false, text: 'bcdp_jev_ask: goal is required' }

        const judge = judgeCfg()
        const runtime = judgeRuntimeOf()
        const effects = effectsOf(runtime)
        let frame: Frame
        try {
          frame = (await effects.capture()).frame
        } catch (error) {
          return { ok: false, text: `capture failed: ${error instanceof Error ? error.message : String(error)}` }
        }

        const maxCandidates = num(args.maxCandidates, judge.chunkSize)
        const asked = str(args.round, 'control')
        const roundKind = asked === 'chapter' || asked === 'pick' ? asked : 'control'
        const chapterKey = str(args.chapter, '')
        let round: ReturnType<typeof buildRound>
        try {
          round = buildRound({
            frame,
            intent: intentFrom(args),
            round: roundKind,
            ...(chapterKey === '' ? {} : { chapterKey }),
            config: {
              chunkSize: maxCandidates,
              maxImageBytes: judge.maxImageBytes,
              historyLimit: judge.historyLimit,
              archiveImageBudget: judge.archiveImage ? 1 : 0,
              model: judge.layaModel,
            },
          })
        } catch (error) {
          return { ok: false, text: `could not assemble the ${roundKind} round: ${error instanceof Error ? error.message : String(error)}` }
        }

        // Show the body for the hop that would actually take it, so a preview
        // cannot disagree with the request.
        const firstHttp = runtime.order.find((name) => name === 'jev' || name === 'laya')
        const assembland = firstHttp === undefined
          ? null
          : assembleSystemOneBody(
              { state: round.state, questions: round.questions, model: firstHttp === 'jev' ? judge.jevModel : judge.layaModel },
              { name: firstHttp, baseUrl: firstHttp === 'jev' ? judge.jevUrl : judge.layaUrl },
            )

        const chaptersInFrame = chaptersOf(frame.dom.nodes)
        const lines: string[] = [
          `round      : ${round.round}`,
          `frame      : ${frame.frameId}  ${frame.viewport.width}x${frame.viewport.height} @${frame.viewport.devicePixelRatio}x`,
          `page       : ${frame.target.url}`,
          `candidates : ${frame.dom.nodes.length}${frame.dom.truncated ? ' (TRUNCATED)' : ''}`,
          `chapters   : ${chaptersInFrame.length}  ${chaptersInFrame.map((c) => `${c.key}(${c.nodes.length})`).join(' ')}`,
          `image      : ${frame.image === null ? 'none' : `${frame.image.format} ${frame.image.bytes} B q=${frame.image.quality ?? '-'}${frame.image.overBudget ? ' OVER BUDGET' : ''}`}`,
          `chunk plan : total=${round.plan.chunkTotal} size=${round.plan.chunkSize} reason=${round.plan.reason}`,
          `questions  : ${Object.keys(round.questions).join(', ')}`,
        ]
        if (round.round === 'pick' && chapterKey === '') {
          lines.push(
            '',
            'note: this pick round was assembled WITHOUT a chapter filter, so it offers every candidate in the chunk.',
            'During a real run the loop asks the chapter question first and then restricts the pick to that section —',
            'which is what keeps both questions inside a stricter threshold bucket.',
          )
        }
        if (round.issues.length > 0) {
          lines.push(`ISSUES     : ${round.issues.map((issue) => `${issue.code}(${issue.questionId})`).join(', ')}  <- must be fixed before sending`)
        }
        if (assembland !== null) {
          lines.push(`POST       : ${assembland.url}`)
          lines.push('', '── assembled request body (exactly the three allowed keys) ──', JSON.stringify(assembland.body, null, 2))
        } else {
          lines.push('', '(no HTTP hop configured �?only the rule hop is available)')
        }

        if (bool(args.dryRun, true)) {
          lines.push('', 'dryRun: nothing was sent.')
          return { ok: true, text: lines.join('\n') }
        }

        const answer = await sendJudge(runtime, { questions: round.questions, state: round.state })
        lines.push(
          '',
          '── answer ──',
          `provider   : ${answer.provider}${answer.degraded ? ' (DEGRADED)' : ''} model=${answer.model} ${answer.latencyMs}ms`,
          `chain      : ${answer.chain.join(' -> ') || '(none)'}`,
          `trace      : ${answer.trace.join(' | ') || '(none)'}`,
          `answers    : ${JSON.stringify(answer.answers)}`,
        )
        if (answer.missing.length > 0) lines.push(`MISSING    : ${answer.missing.join(', ')}`)
        if (answer.dropped.length > 0) lines.push(`DROPPED    : ${answer.dropped.join(', ')}`)
        if (judge.archiveImage) lines.push('', `(archive image omitted from this report: ${frame.image?.dataBase64.length ?? 0} base64 chars)`)
        if (bool(args.includeImage, false) && frame.image !== null) {
          lines.push('', '── frame image (base64) ──', frame.image.dataBase64)
        }
        lines.push('', `── Laya archive bundle (${serializeLaya(round).length} chars) ──`, 'write it with bcdp_script if you need it on disk')
        return { ok: true, text: lines.join('\n') }
      },
      presentCall: () => ({ card: 'generic', title: 'bcdp_jev_ask', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )

  reg(
    defineTool({
      name: 'bcdp_jev_frame',
      description:
        'Capture one judgement FRAME from the current page: numbered interactive candidates plus a budgeted screenshot. Inspect this to see exactly what a judge would be shown.',
      parameters: {
        limit: { type: 'integer', description: 'Candidate ceiling (default: the configured chunk size).' },
        maxBytes: { type: 'integer', description: 'Screenshot byte budget; 0 = unbounded (default).' },
        showCandidates: { type: 'boolean', description: 'List every numbered candidate (default true).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
        },
        render: renderText,
      },
      timeoutMs: 60_000,
      execute: async (args: Record<string, unknown>, exec: ToolExec) => {
        cfg.spaceTracker.setCurrentSession(callingSessionId(exec)); markEgoToolCall(callingSessionId(exec))
        const blocked = attachGate()
        if (blocked !== '') return { ok: false, text: blocked }
        const judge = judgeCfg()
        const effects = makeJudgeEffects({
          subprocess: ctx.subprocess,
          workerPath: RENDER_WORKER_BIN,
          wsUrl: defaultAttachCache.get().wsUrl,
          targetId: defaultAttachCache.get().targetId,
          engine: defaultAttachCache.get().engine,
          judge: judgeRuntimeOf(),
          maxImageBytes: num(args.maxBytes, judge.maxImageBytes),
          candidateLimit: num(args.limit, judge.chunkSize),
          now: () => Date.now(),
          sleep: async () => {},
        })
        let frame: Frame
        try {
          frame = (await effects.capture()).frame
        } catch (error) {
          return { ok: false, text: `capture failed: ${error instanceof Error ? error.message : String(error)}` }
        }
        const lines: string[] = [
          `frameId    : ${frame.frameId}`,
          `page       : ${frame.target.url}`,
          `target     : ${frame.target.targetId}`,
          `viewport   : ${frame.viewport.width}x${frame.viewport.height} @${frame.viewport.devicePixelRatio}x scroll(${frame.viewport.scrollX},${frame.viewport.scrollY})`,
          `image      : ${frame.image === null ? 'none' : `${frame.image.format} ${frame.image.bytes} B (${(frame.image.bytes / 1024).toFixed(1)} KiB) q=${frame.image.quality ?? '-'}`}`,
          `budget     : ${frame.image === null || frame.image.maxBytes === 0 ? 'unbounded' : frame.image.maxBytes + ' B'}${frame.image?.overBudget === true ? '  *** OVER BUDGET ***' : ''}`,
          `candidates : ${frame.dom.nodes.length} of ${frame.dom.total}${frame.dom.truncated ? ' (TRUNCATED)' : ''}`,
        ]
        if (defaultAttachCache.get().engine === 'lightpanda') {
          // Lightpanda backend —知情元数据: the PNG is a TEXT-level layout
          // render (no pixel engine), so visual fidelity differs from Chrome.
          lines.push(`engine     : lightpanda (rendering: text �?screenshot fidelity differs from Chrome)`)
        }
        if (frame.image?.overBudget === true) {
          // Reported rather than hidden: a caller that set a budget must be able
          // to tell "I got what I asked for" from "I got the closest thing".
          lines.push('', 'The image exceeded the byte budget even at floor quality. Raise jevMaxImageBytes, or accept it and let the count drive chunking.')
        }
        if (bool(args.showCandidates, true)) {
          lines.push('', '── candidates (the judge answers with these numbers) ──')
          for (const node of frame.dom.nodes) {
            lines.push(`${node.n}. ${node.role} "${node.name}" [${node.container}]`)
          }
        }
        lines.push('', 'note: rects are NOT carried on this path (the AX tree has none) �?the executor re-measures before any action.')
        return { ok: true, text: lines.join('\n') }
      },
      presentCall: () => ({ card: 'generic', title: 'bcdp_jev_frame', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )

  reg(
    defineTool({
      name: 'bcdp_jev_run',
      description:
        'Run the JEV loop for one goal; returns a step trace.',
      parameters: {
        goal: { type: 'string', required: true, description: 'The goal, in your own words.' },
        kind: { type: 'string', description: 'navigate | extract | fill | click | verify | other.' },
        hints: { type: 'string', description: 'Target hint per line (never a selector).' },
        successCriteria: { type: 'string', description: 'Success condition per line; required for done.' },
        stopConditions: { type: 'string', description: 'Stop condition per line.' },
        stepBudget: { type: 'integer', description: 'Max judgement rounds (default settings).' },
        wallMs: { type: 'integer', description: 'Wall-clock ceiling in ms (default settings).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
        },
        render: renderText,
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      execute: async (args: Record<string, unknown>, exec: ToolExec) => {
        cfg.spaceTracker.setCurrentSession(callingSessionId(exec)); markEgoToolCall(callingSessionId(exec))
        const blocked = attachGate()
        if (blocked !== '') return { ok: false, text: blocked }
        const goal = str(args.goal, '')
        if (goal === '') return { ok: false, text: 'bcdp_jev_run: goal is required' }

        const judge = judgeCfg()
        const runtime = judgeRuntimeOf()
        const intent = intentFrom(args)
        const effects = effectsOf(runtime)
        const started = Date.now()
        const result = await runLoop({
          intent,
          effects,
          budgets: {
            ...DEFAULT_BUDGETS,
            steps: num(args.stepBudget, judge.stepBudget),
            wallMs: num(args.wallMs, judge.wallMs),
          },
          pipe: {
            chunkSize: judge.chunkSize,
            maxImageBytes: judge.maxImageBytes,
            historyLimit: judge.historyLimit,
            archiveImageBudget: judge.archiveImage ? 1 : 0,
            model: judge.jevModel,
          },
        })

        const lines: string[] = [
          `status     : ${result.status.toUpperCase()}${result.exhaustedKind === undefined ? '' : ` (${result.exhaustedKind})`}`,
          `reason     : ${result.reason}`,
          `steps      : ${result.steps.length}  elapsed=${Date.now() - started}ms  degraded=${result.degraded}`,
          `remaining  : steps=${result.remaining.steps} judge=${result.remaining.judge} captures=${result.remaining.captures} wall=${result.remaining.wallMs}ms`,
        ]
        if (effects.lastError() !== '') lines.push(`lastError  : ${effects.lastError()}`)
        if (intent.successCriteria.length === 0 && result.status === 'done') {
          lines.push('', 'WARNING: this run reported `done` with NO successCriteria, so the claim could only be checked against the goal text. Add criteria for a trustworthy verdict.')
        }
        lines.push('', '── steps ──')
        if (result.steps.length === 0) lines.push('(none)')
        for (const step of result.steps) {
          lines.push(
            `${String(step.index).padStart(3)}. ${step.control.padEnd(20)} n=${String(step.n).padStart(3)} ${step.action.padEnd(7)} ${step.ok ? 'ok  ' : 'FAIL'} ${step.provider}${step.degraded ? '*' : ' '} ${step.note}`,
          )
        }
        if (result.excluded.length > 0) {
          lines.push('', `ruled out: ${result.excluded.join(', ')}  (these are no longer OFFERED to the judge)`)
        }
        return { ok: true, text: lines.join('\n') }
      },
      presentCall: () => ({ card: 'generic', title: 'bcdp_jev_run', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )

  reg(
    defineTool({
      name: 'bcdp_jev_attempt',
      description:
        "Open a URL and let the decision model attempt one goal: each round it picks from the page's DOM candidates plus `end`, up to N actions. Returns a receipt; verify yourself via bcdp_cdp/bcdp_screenshot (a receipt is a report, not proof).",
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute URL to open.' },
        goal: { type: 'string', required: true, description: 'The goal, in your own words.' },
        successCriteria: { type: 'string', description: 'Success condition per line; helps the model decide when to stop.' },
        maxActions: { type: 'integer', description: 'Action budget (default 5, max 20).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
        },
        render: renderText,
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      execute: async (args: Record<string, unknown>, exec: ToolExec) => {
        cfg.spaceTracker.setCurrentSession(callingSessionId(exec)); markEgoToolCall(callingSessionId(exec))
        const blocked = attachGate()
        if (blocked !== '') return { ok: false, text: blocked }
        const url = str(args.url, '')
        const goal = str(args.goal, '')
        if (url === '') return { ok: false, text: 'bcdp_jev_attempt: url is required' }
        if (goal === '') return { ok: false, text: 'bcdp_jev_attempt: goal is required' }
        const maxActions = Math.min(20, Math.max(1, num(args.maxActions, 5)))

        const judge = judgeCfg()
        const runtime = judgeRuntimeOf()
        const effects = effectsOf(runtime)
        const criteria = str(args.successCriteria, '')
        const intent: IntentSpec = {
          goal,
          kind: 'click',
          targetHints: [],
          successCriteria: criteria === '' ? [] : criteria.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
          stopConditions: [],
          source: 'user',
        }

        const started = Date.now()
        const nav = await effects.navigate(url)
        if (!nav.ok) return { ok: false, text: `bcdp_jev_attempt: navigation failed �?${nav.error ?? 'unknown error'}` }

        const result = await runAttempt({ intent, effects, maxActions })

        const lines: string[] = [
          `status     : ${result.status.toUpperCase()}  actions=${result.actions.length}/${maxActions}`,
          `reason     : ${result.reason}`,
          `page       : ${result.lastUrl || nav.url}`,
          `elapsed    : ${Date.now() - started}ms  candidates(last round)=${result.candidates}`,
          `verify via : bcdp_cdp / bcdp_screenshot on targetId=${effects.frames().at(-1)?.target.targetId ?? 'unknown'} �?the receipt is a report, not a proof`,
        ]
        if (effects.lastError() !== '') lines.push(`lastError  : ${effects.lastError()}`)
        lines.push('', result.actions.length === 0 ? '── actions ──  (none)' : '── actions ──')
        for (const step of result.actions) {
          lines.push(
            `${String(step.index).padStart(3)}. n=${String(step.n).padStart(3)} ${step.ok ? 'ok  ' : 'FAIL'} top=${step.top.toFixed(2)} ${step.provider}${step.degraded ? '*' : ' '} ${step.label}${step.anchor === undefined ? '' : `  [${step.anchor}]`}`,
          )
        }
        if (result.status === 'ended') {
          lines.push('', 'The model ENDED BY ITSELF. Check the page state through CDP before treating the goal as achieved.')
        }
        if (result.status === 'exhausted') {
          lines.push('', 'The action budget ran out WITHOUT the model ending. Raise maxActions, or take over via CDP tools.')
        }
        return { ok: true, text: lines.join('\n') }
      },
      presentCall: () => ({ card: 'generic', title: 'bcdp_jev_attempt', kind: 'other', rawInput: null }),
    } as unknown as DefineToolOpts),
  )
}

