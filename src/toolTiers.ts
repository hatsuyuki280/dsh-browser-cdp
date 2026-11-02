// src/toolTiers.ts — 工具分级注入策略（纯函数，无宿主依赖）
//
// 动机：插件挂载时一次性注册 34 个 bcdp_* 工具，每个会话每一轮都要为它们付
// schema 成本（AST 实测 description+parameters ≈ 18.8K 字符 ≈ 5.4K token），
// 而绝大多数会话根本不碰浏览器。这里把「哪些工具在什么条件下允许出现在模型面
// 前」收成一处策略，注册时机交给 index.ts 的控制器执行。
//
// 八批（见 ego-browser-cdp-issues.md §9.2）：
//   core     常驻：只留 bcdp_status —— 它是 lazy 模式唯一的解锁入口（调用即置活动并
//            推进批次）。永不封印、也不给开关：把它封了，模型在「工具不在列表」时
//            就连自救入口都没有。诊断/指南/空间/导航/读页面已移入 act / observe 批。
//   act      动手：click / fill / key / select / check / hover / scroll / drag / tab。
//   observe  看结果：screenshot / page_info / read_element / js。
//   wait     等待：wait / wait_for_selector / wait_for_url / wait_for_response / wait_page。
//   power    重量级：raw CDP / http / upload / download / dialog。
//   session  登录态：captcha / auth_flush / login_import。
//   escape   逃生舱：script（verbatim:true 即原 cli 的裸 heredoc 行为）。与其它非 core 批同样要活动闸（见下）。
//   judge    评审链（bcdp_jev_*）：除解锁外还要求评审**已配置**。
//
// act / observe / wait 三批按顺序渐进放行（一次活动放一批），因为它们的使用
// 时机高度重叠（点完要看、看完要点），拆成三个用户开关只会让人永远全开。
//
// escape 仍独立成批，但「不吃活动闸」的豁免已移除：
//   它单独占 ≈1,620 字符/轮（比收窄后的常驻面还大三倍），而 lazy 下模型只要先调
//   一次 bcdp_status 就能拿到它——牺牲的不是逃生能力，只是「冷启动直接写脚本」这一步。
//   保留独立开关（toolEscape）是为了让用户仍能显式把它要回来。
//   cli 与 script 原是同一 heredoc 运行时的两种返回形态（script 多 duration/
//   timedOut），1.5.0 已合并为单个 bcdp_script：verbatim:true 走裸 heredoc，
//   默认走带 preamble 的形态。
//
// 旋钮（全 volatile，且带 schema `.default()`——表单描述符与生效值必须同源，
// 否则面板显示一个值、运行时用另一个值）：
//   toolInjection  'lazy'（默认）| 'always'（历史行为：挂载即全量）
//   toolBrowse     act + observe + wait
//   toolExtended   power + session
//   toolEscape     escape（script）
//   toolJudge      judge
//   ON = 开放注册、OFF = 封印（从模型工具列表移除）——与 prime-memory 的
//   「工具封印」同一形状。`core` 级不参与封印，无开关。
// judge 级除开关外还要求配了 Key（否则只能回答「未配置」）。
export type ToolTier = 'core' | 'act' | 'observe' | 'wait' | 'power' | 'session' | 'escape' | 'judge'

const CORE = [
  'bcdp_status',
] as const
const ACT = [
  'bcdp_space',
  'bcdp_watch',
  'bcdp_navigate',
  'bcdp_click',
  'bcdp_fill',
  'bcdp_key',
  'bcdp_hover',
  'bcdp_scroll',
  'bcdp_select',
  'bcdp_check',
  'bcdp_drag',
  'bcdp_tab',
  'bcdp_help',
  'bcdp_doctor',
] as const
const OBSERVE = [
  'bcdp_screenshot',
  'bcdp_page_info',
  'bcdp_read_element',
  'bcdp_js',
  'bcdp_snapshot',
] as const
const WAIT = [
  'bcdp_wait',
] as const
const POWER = [
  'bcdp_cdp',
  'bcdp_http',
  'bcdp_upload',
  'bcdp_download',
  'bcdp_dialog',
  'bcdp_diagnostics',
] as const
const SESSION = [
  'bcdp_captcha',
  'bcdp_auth_flush',
  'bcdp_login_import',
] as const
const ESCAPE = [
  'bcdp_script',
] as const
const JUDGE = [
  'bcdp_jev_status',
  'bcdp_jev_ask',
  'bcdp_jev_frame',
  'bcdp_jev_run',
  'bcdp_jev_attempt',
] as const

export type ToolInjection = 'always' | 'lazy'

/** 工具名 → 分级。`ego_*` 旧名（legacyEgoToolNames 别名）与 bcdp_* 同名同组。 */
export const TIER_OF_TOOL: ReadonlyMap<string, ToolTier> = new Map<string, ToolTier>(
  ([
    ['core', CORE], ['act', ACT], ['observe', OBSERVE], ['wait', WAIT],
    ['power', POWER], ['session', SESSION], ['escape', ESCAPE], ['judge', JUDGE],
  ] as const).flatMap(([tier, names]) => names.map((n) => [n, tier] as const)),
)

/** 分级成员表（测试与文档用）。 */
export const TIER_MEMBERS: Readonly<Record<ToolTier, readonly string[]>> = {
  core: CORE,
  act: ACT,
  observe: OBSERVE,
  wait: WAIT,
  power: POWER,
  session: SESSION,
  escape: ESCAPE,
  judge: JUDGE,
}

/** 去掉 `bcdp_`/`ego_` 前缀后的裸名，便于策略表保持前缀无关。 */
export const bareToolName = (name: string): string => name.replace(/^(?:bcdp|ego)_/, '')

// ── 注入批次 ────────────────────────────────────────────────────────────────
//
// `toolBrowse` 一个开关管着 act → observe → wait 三批：一次浏览器活动先放出
// 「能动手」的一批，再放出「能看结果」的一批，最后才是「等待」类。批次只是
// 注入时机，不是新的用户开关。其余批次不参与渐进放行。
export type ToolBatch = 'act' | 'observe' | 'wait'

/** 批次放行顺序（索引即 rank）。 */
export const BATCH_ORDER: readonly ToolBatch[] = ['act', 'observe', 'wait']

/** 某工具的注入批次；非渐进制分级一律归 'act'（前缀无关）。 */
export const batchOfTool = (name: string): ToolBatch => {
  const tier = tierOfTool(name)
  return (BATCH_ORDER as readonly string[]).includes(tier) ? (tier as ToolBatch) : 'act'
}

/**
 * 工具所属分级。未登记的名字落到 `power`（最严的一档：宁可等活动解锁，也不
 * 让新工具悄悄回到常驻面）；调用方应当在启动时打一条 warn，见
 * `unknownTieredTools`。分级表漂移由 `tests/tool-tiers.test.ts` 的覆盖率断言
 * 兜住，这里只是运行期兜底。
 */
export function tierOfTool(name: string): ToolTier {
  const bare = bareToolName(name)
  for (const [known, tier] of TIER_OF_TOOL) {
    if (bareToolName(known) === bare) return tier
  }
  return 'power'
}

/** 名单里所有查不到分级登记的工具名（启动自检 / 测试用）。 */
export const unknownTieredTools = (names: readonly string[]): string[] =>
  names.filter((n) => !([...TIER_OF_TOOL.keys()].some((k) => bareToolName(k) === bareToolName(n))))

/**
 * 评审链是否「已配置」：至少有一个可用的 key。`layaUrl` 有默认值（sidecar
 * 本机 8000），所以 URL 非空说明不了任何事——只有 key 才是配置证据。
 * 两个 hop 独立可达，任一有 key 就算配置（见 config.ts 的 jev/laya 分离说明）。
 */
export const judgeConfigured = (c: { jevKey?: string; layaKey?: string }): boolean =>
  (c.jevKey ?? '').trim() !== '' || (c.layaKey ?? '').trim() !== ''

/** 注入策略的一次读取快照（全部来自 volatile 活引用，每次重读）。 */
export interface TierPolicy {
  injection: ToolInjection
  /** 开关组：true = 开放注册，false = 封印。`core` 级不在此列（不可封印）。 */
  toolBrowse: boolean
  toolExtended: boolean
  toolEscape: boolean
  toolJudge: boolean
  judgeConfigured: boolean
  /** 本插件挂载以来是否发生过浏览器活动（bcdp_* 调用）。 */
  active: boolean
  /**
   * act/observe/wait 已放行的批次数（0–3，按 act → observe → wait 顺序）。
   * 缺省 = 全部放行：既有调用方与测试不必感知批次（`always` 模式也忽略它）。
   */
  batchDepth?: number
}

/** 某级开关的当前极性；`core` 恒开放。 */
export const tierOpen = (tier: ToolTier, p: TierPolicy): boolean => {
  switch (tier) {
    case 'core': return true
    case 'act':
    case 'observe':
    case 'wait': return p.toolBrowse
    case 'power':
    case 'session': return p.toolExtended
    case 'escape': return p.toolEscape
    case 'judge': return p.toolJudge
  }
}

/**
 * 该分级此刻是否允许注册。
 *
 * 四条独立闸，任一不过即封印：
 * ① 本级开关（见 tierOpen）；
 * ② 评审级额外要求已配 Key（没 Key 的 `bcdp_jev_*` 只能回「未配置」）；
 * ③ 活动闸：`lazy` 下非 core 级要等活动，`always` 下不设时机闸；
 * ④ 批次闸：只在 act/observe/wait 三批上按 batchDepth 递增放行。
 *
 * depth=0 时连 act 也被封，所以唯一常驻的 `bcdp_status` 必须既置 active 又推进
 * depth，否则 lazy 模式下没有任何解锁路径（决策与收益见
 * `.agents/plans/bcdp-core-narrowing/`）。
 *
 * `escape` 的「不吃③」豁免已移除：现在它与其它非 core 批同样等活动。豁免时期的
 * 理由是「结构化工具没覆盖时手里没逃生手段」，而现在该手段需要先调 `bcdp_status`
 * 才能拿到——代价是 ≈1,620 字符/轮，换为常驻面收窄的主要一块。
 */
export function tierAllowed(tier: ToolTier, p: TierPolicy): boolean {
  if (tier === 'core') return true
  if (!tierOpen(tier, p)) return false
  if (tier === 'judge' && !p.judgeConfigured) return false
  if (p.injection === 'always') return true
  if (tier === 'act' || tier === 'observe' || tier === 'wait') {
    // 活动闸在前、批次闸在后：没有活动时三批全封印，深度缺省值不得绕过活动。
    if (!p.active) return false
    const depth = p.batchDepth ?? BATCH_ORDER.length
    return BATCH_ORDER.indexOf(tier) < depth
  }
  return p.active
}

/** 某工具此刻是否允许注册（名字 → 分级 → 策略）。 */
export const toolAllowed = (name: string, p: TierPolicy): boolean => tierAllowed(tierOfTool(name), p)

// ── 注入控制器 ──────────────────────────────────────────────────────────────
//
// 与 prime-memory 的工具组封印同式：**封印 = 从模型工具列表消失（反注册），
// 不是执行期拒绝**。注册面变化即时生效（宿主每轮重新装配工具表），所以设置页
// 翻开关或一次浏览器活动都能当场扩大/收窄面，无需重启插件。
//
// 控制器不认识宿主：`register` 由调用方注入（返回 disposer），策略经 `policy()`
// 每次重读活引用。这让它能脱离 Cordis 单测。

/** 一个已定义的工具句柄（`defineTool` 产物）；这里只读它的 `name`。 */
export interface TierToolLike {
  name?: unknown
}

export interface TierInjectorOptions {
  /** 真正交给宿主的注册调用；返回反注册的 disposer。 */
  register(tool: TierToolLike): () => void
  /** 当前策略快照（每次 reapply 重读，绝不缓存）。 */
  policy(): TierPolicy
  logger?: { info?: (m: string) => void; warn?: (m: string) => void }
  /** 日志前缀，默认 `dsh-browser-cdp`。 */
  label?: string
}

export interface TierInjector {
  /** 登记一个工具并按当前策略尝试注册（不允许则挂着，等 reapply）。 */
  offer(tool: TierToolLike): void
  /** 策略变了（设置热更 / 活动解锁 / 闲置回收）：补齐该注册的、收回该封印的。幂等。 */
  reapply(): void
  /** 当前注入面（测试与 doctor 用）。 */
  surface(): { live: string[]; sealed: string[] }
}

export function createTierInjector(o: TierInjectorOptions): TierInjector {
  const label = o.label ?? 'dsh-browser-cdp'
  /** 全部已登记工具，插入序。 */
  const all = new Map<string, TierToolLike>()
  /** 此刻注册在宿主上的工具 → disposer。 */
  const live = new Map<string, () => void>()
  /** 无名字的工具（不该出现，兜底直注不误伤既有行为）。 */
  let anon = 0

  const reapply = (): void => {
    const p = o.policy()
    const added: string[] = []
    const removed: string[] = []
    for (const [name, tool] of all) {
      const allowed = toolAllowed(name, p)
      if (allowed && !live.has(name)) {
        live.set(name, o.register(tool))
        added.push(name)
      } else if (!allowed && live.has(name)) {
        live.get(name)?.()
        live.delete(name)
        removed.push(name)
      }
    }
    if (added.length > 0) o.logger?.info?.(`${label}: 工具注入 +${added.length} (${added.join(' ')})`)
    if (removed.length > 0) o.logger?.warn?.(`${label}: 工具封印 -${removed.length} (${removed.join(' ')})`)
  }

  return {
    offer(tool) {
      const name = typeof tool?.name === 'string' ? tool.name : ''
      if (name === '') {
        anon += 1
        live.set(`#anon${anon}`, o.register(tool))
        return
      }
      all.set(name, tool)
      reapply()
    },
    reapply,
    surface() {
      return { live: [...live.keys()], sealed: [...all.keys()].filter((n) => !live.has(n)) }
    },
  }
}
