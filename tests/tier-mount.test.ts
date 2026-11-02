import { describe, it, expect } from "vitest";
import { apply } from "../src/index.ts";
import { TIER_MEMBERS, batchOfTool } from "../src/toolTiers.ts";

/** 渐进放行的三批（act → observe → wait），按批次筛成员。 */
const browseBatch = (batch: "act" | "observe" | "wait") =>
  [...TIER_MEMBERS.act, ...TIER_MEMBERS.observe, ...TIER_MEMBERS.wait].filter((n) => batchOfTool(n) === batch);

/** 常驻面 = core（1.7.0 收窄后只剩 `bcdp_status`；escape 不再特例常驻）。 */
const RESIDENT = () => [...TIER_MEMBERS.core];

/**
 * 触发一次浏览器活动：调 `bcdp_status`。
 *
 * 1.7.0 收窄后 `bcdp_help` / `bcdp_doctor` 已属 act 批，冷启动下不在场，
 * 不能再用作活动源；`bcdp_status` 是唯一常驻、且调用即置 active 并推进批次深度的入口。
 */
const pulse = async (m: { handles: Map<string, any> }): Promise<void> => {
  await m.handles.get("bcdp_status").execute({}, {});
};

/** 一次活动后（depth=1）应有的面：core + act 批 + power + session + escape。 */
const AFTER_ONE_PULSE = () => [
  ...RESIDENT(), ...browseBatch("act"), ...TIER_MEMBERS.power, ...TIER_MEMBERS.session, ...TIER_MEMBERS.escape,
];

/**
 * 两次活动后（depth=2）应有的面：再加 observe 批，wait 仍封。
 *
 * `bcdp_doctor` 自身也 pulse（预检同样视为浏览器活动），所以「status + doctor」
 * 是两次活动，不是一次。
 */
const AFTER_TWO_PULSES = () => [
  ...AFTER_ONE_PULSE(), ...browseBatch("observe"),
];

/**
 * 分级注入的挂载级验证：真的走一遍 `apply()`，用最小宿主替身观察注册面。
 *
 * 只喂 `apply()` 用到的面：`tools.register` / `subprocess.spawn` / `on` /
 * `effect` / `logger`。刻意不提供 `inject`，让 cast server 与网关整段走
 * 宿主缺席的 no-op 分支（TUI/headless 同形），测试就不会碰到 SSE/worker。
 */
const mount = (config: Record<string, unknown> = {}) => {
  const live: string[] = [];
  /** 已注册工具句柄，按名字取回以便直接调用 execute。 */
  const handles = new Map<string, any>();
  const volatileHandlers = new Set<(paths: string[]) => void>();
  const teardown: Array<() => void> = [];
  const ctx: any = {
    tools: {
      register: (tool: any) => {
        live.push(tool.name);
        handles.set(tool.name, tool);
        return () => {
          const i = live.indexOf(tool.name);
          if (i >= 0) live.splice(i, 1);
        };
      },
    },
    subprocess: {
      // 立即失败的 spawn：不起真进程、不产生副作用，但会及时释放 withEgoLock——
      // 否则首个 execute 永久持锁，后续 execute（如 bcdp_doctor）只能排队等死。
      // 失败文本故意不匹配 cold-start / CDP 连接签名，所以不会诱发额外重试。
      spawn: () => ({
        done: Promise.resolve({ exitCode: 1, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
        },
      }),
    },
    on: (_event: string, fn: (paths: string[]) => void) => {
      volatileHandlers.add(fn);
      return () => volatileHandlers.delete(fn);
    },
    effect: (fn: () => unknown) => {
      try {
        const d = fn();
        // cordis 语义：立刻执行 fn，把返回的 disposer 留到卸载时——不能当场调用，
        // 否则刚注册的工具会被立即反注册。
        if (typeof d === "function") teardown.push(d as () => void);
      } catch {
        /* 替身不为难子模块的挂载失败 */
      }
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  apply(ctx, config as never);
  return {
    live,
    handles,
    /** 插件卸载：跑掉所有 effect disposer（工具应全部反注册）。 */
    unmount: () => { for (const d of teardown.splice(0)) d(); },
    /** 模拟设置页 volatile 热更（loader/volatile-update）。 */
    emitVolatileUpdate: () => {
      for (const fn of [...volatileHandlers]) fn(["dsh-browser-cdp.toolDepth"]);
    },
  };
};

const sorted = (names: readonly string[]) => [...names].sort();

/**
 * 注入面的真实字符成本：只算模型看到的那个子集（name + description + parameters，
 * 函数被 JSON 剔除）。比源码 AST 估算更接近挂载级口径。
 */
const faceChars = (live: string[], handles: Map<string, any>): number =>
  live.reduce((sum, n) => {
    const t = handles.get(n);
    return sum + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length;
  }, 0);

describe("tool tier injection at mount", () => {
  it("the shipped default is lazy: the core entry alone, nothing else", () => {
    const { live } = mount();
    // 1.7.0：`bcdp_status` 是唯一常驻工具，也是唯一的解锁入口。
    expect(sorted(live)).toEqual(sorted(RESIDENT()));
    expect(live).toEqual(["bcdp_status"]);
    // 逃生舱不再常驻：要先调一次 status 才能拿到它。
    expect(live).not.toContain("bcdp_script");
    expect(live).not.toContain("bcdp_click");
  });

  it("the resident surface stays inside the token budget (≤600 chars)", () => {
    const { live, handles } = mount();
    const chars = faceChars(live, handles);
    console.log(`FACE default: ${live.length} tool(s), ${chars} chars`);
    expect(chars).toBeLessThanOrEqual(600);
  });

  it("the three injection faces are ordered (README figures)", async () => {
    const m = mount();
    const atDefault = faceChars(m.live, m.handles);
    await pulse(m);
    const afterOne = faceChars(m.live, m.handles);
    await pulse(m);
    await pulse(m);
    const atFullBrowse = faceChars(m.live, m.handles);
    console.log(`FACE default=${atDefault} onePulse=${afterOne} threePulses=${atFullBrowse} tools=${m.live.length}`);
    // 单调性：活动只能把面铺开，不会反而收小。
    expect(afterOne).toBeGreaterThan(atDefault);
    expect(atFullBrowse).toBeGreaterThan(afterOne);
    // 全量档（always + 配了评审 Key）：README 的 35 件数字以此为准。
    const full = mount({ toolInjection: "always", layaKey: "k" });
    expect(full.live.length).toBe(35);
    console.log(`FACE full=${faceChars(full.live, full.handles)} tools=35`);
    // 分批 schema（README 表格数据）：同一个序列化口径。
    const perTool = new Map<string, number>(
      full.live.map((n) => [n, JSON.stringify({ name: n, description: full.handles.get(n).description, parameters: full.handles.get(n).parameters }).length]),
    );
    for (const [tier, names] of Object.entries(TIER_MEMBERS)) {
      const chars = names.reduce((s, n) => s + (perTool.get(n) ?? 0), 0);
      console.log(`TIER ${tier}=${chars} n=${names.length}`);
    }
  });

  it("always mode restores the historical timing (minus the keyless judge tier)", () => {
    const { live } = mount({ toolInjection: "always" });
    expect(sorted(live)).toEqual(sorted([
      ...TIER_MEMBERS.core, ...TIER_MEMBERS.act, ...TIER_MEMBERS.observe, ...TIER_MEMBERS.wait,
      ...TIER_MEMBERS.power, ...TIER_MEMBERS.session, ...TIER_MEMBERS.escape,
    ]));
    expect(live).not.toContain("bcdp_jev_run");
  });

  it("always + a configured judge key = all 35 on the surface", () => {
    const { live } = mount({ toolInjection: "always", layaKey: "k" });
    expect(live.length).toBe(35);
    expect(sorted(live)).toEqual(sorted(Object.values(TIER_MEMBERS).flat()));
  });

  it("the first bcdp_status call releases the act batch (no browser needed)", async () => {
    const m = mount();
    expect(sorted(m.live)).toEqual(sorted(RESIDENT()));
    await pulse(m);
    // 批次模型：一次活动只放出 act 批；observe/wait 仍封印。escape 现在也跟着活动走。
    expect(sorted(m.live)).toEqual(sorted(AFTER_ONE_PULSE()));
    expect(m.live).toContain("bcdp_click");
    expect(m.live).toContain("bcdp_script");
    expect(m.live).not.toContain("bcdp_screenshot");
    expect(m.live).not.toContain("bcdp_wait");
    // 活动之后仍未配 Key：评审级依旧不来。
    expect(m.live).not.toContain("bcdp_jev_ask");
  });

  it("each further activity releases the next browsing batch (act → observe → wait)", async () => {
    const m = mount();
    await pulse(m); // depth 1
    expect(m.live).toContain("bcdp_click");
    expect(m.live).not.toContain("bcdp_screenshot");
    await pulse(m); // depth 2
    expect(m.live).toContain("bcdp_screenshot");
    expect(m.live).not.toContain("bcdp_wait");
    await pulse(m); // depth 3
    expect(m.live).toContain("bcdp_wait");
    expect(sorted(m.live)).toEqual(sorted([
      ...TIER_MEMBERS.core, ...TIER_MEMBERS.act, ...TIER_MEMBERS.observe, ...TIER_MEMBERS.wait,
      ...TIER_MEMBERS.power, ...TIER_MEMBERS.session, ...TIER_MEMBERS.escape,
    ]));
  });

  it("one switch group can be sealed alone, live, without touching the others", async () => {
    const config: Record<string, unknown> = { toolInjection: "lazy" };
    const m = mount(config);
    // 1.7.0：doctor 已属 act 批，冷启动不在场——先调一次常驻的 status 解锁。
    await pulse(m);
    const report = await m.handles.get("bcdp_doctor").execute({}, {});
    // 两次活动（status + doctor 各自 pulse）：depth=2，core + act + observe + power + session + escape。
    expect(m.live.length).toBe(AFTER_TWO_PULSES().length);
    expect(m.live).toContain("bcdp_screenshot");
    expect(m.live).not.toContain("bcdp_wait");
    // 开关状态必须在 doctor 里可见，否则用户不知道自己被封印了什么。
    expect(String(report.report)).toMatch(/tool injection: mode=lazy browse=open extended=open escape=open judge=open/);
    // doctor 自己也算一次活动，所以此刻 depth=2：live = core+act+observe+power+session+escape = 29，封 wait+judge = 6。
    expect(String(report.report)).toMatch(/live 29 \/ sealed 6/);
    config.toolExtended = false;
    m.emitVolatileUpdate();
    // power/session 被收，act / observe 批与 escape 仍在。
    expect(sorted(m.live)).toEqual(sorted([
      ...RESIDENT(), ...browseBatch("act"), ...browseBatch("observe"), ...TIER_MEMBERS.escape,
    ]));
    expect(m.live).toContain("bcdp_click");
    expect(m.live).not.toContain("bcdp_download");
  });

  it("the escape switch is the only way to lose script, and it costs nothing else", () => {
    const config: Record<string, unknown> = { toolInjection: "always" };
    const m = mount(config);
    expect(m.live).toContain("bcdp_script");
    config.toolEscape = false;
    m.emitVolatileUpdate();
    expect(m.live).not.toContain("bcdp_script");
    // 其它批次一个不少。
    expect(m.live).toContain("bcdp_click");
    expect(m.live).toContain("bcdp_cdp");
    // 35 − escape 1 − judge 5（always 下仍无 Key，评审级照旧封印）。
    expect(m.live.length).toBe(35 - 1 - 5);
  });

  it("judge tools appear the moment a key is configured (volatile reapply, no remount)", () => {
    const config: Record<string, unknown> = { toolInjection: "always", layaKey: "" };
    const m = mount(config);
    expect(m.live).not.toContain("bcdp_jev_run");
    config.layaKey = "k";
    m.emitVolatileUpdate();
    expect(m.live).toContain("bcdp_jev_run");
  });

  it("the legacy ego_* alias follows its bcdp_* twin's tier", () => {
    const { live } = mount({ legacyEgoToolNames: true });
    expect(live).toContain("ego_status");
    // 1.7.0：escape 不再常驻，所以 ego_script 冷启动也被封；ego_click 属 act，同样不在场。
    expect(live).not.toContain("ego_script");
    expect(live).not.toContain("ego_click");
  });

  it("unmounting the plugin unregisters everything that is live", async () => {
    const m = mount();
    await pulse(m);
    expect(m.live.length).toBeGreaterThan(0);
    m.unmount();
    expect(m.live).toEqual([]);
  });
});
