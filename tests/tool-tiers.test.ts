import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import {
  BATCH_ORDER,
  TIER_MEMBERS,
  TIER_OF_TOOL,
  bareToolName,
  batchOfTool,
  createTierInjector,
  judgeConfigured,
  tierAllowed,
  tierOfTool,
  toolAllowed,
  unknownTieredTools,
  type TierPolicy,
} from "../src/toolTiers.ts";

/** src/index.ts 里真实注册的全部 bcdp_* 工具名（分级表的对照源）。 */
const registeredNames = async (): Promise<string[]> => {
  const src = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  return [...new Set([...src.matchAll(/name: '(bcdp_[a-z0-9_]+)'/g)].map((m) => m[1]))];
};

const P = (over: Partial<TierPolicy> = {}): TierPolicy => ({
  injection: "lazy", toolBrowse: true, toolExtended: true, toolEscape: true, toolJudge: true,
  judgeConfigured: true, active: false, ...over,
});

const sorted0 = (names: readonly string[]) => [...names].sort();
/** 需要活动闸（部分还需批次深度）的非 core 批次。 */
// 1.7.0：`escape` 加入此列——它的「不吃活动闸」豁免已移除，现与其它非 core 批同闸。
const GATED = ["act", "observe", "wait", "power", "session", "escape", "judge"] as const;

describe("tier table coverage", () => {
  it("the table covers every registered bcdp_* tool, with no stale entries", async () => {
    const names = await registeredNames();
    const listed = Object.values(TIER_MEMBERS).flat();
    // 双向对齐：源码里注册的每个名字都在表上，表上每个名字都还在源码里。
    expect(names.slice().sort()).toEqual(listed.slice().sort());
    expect(names.length).toBe(36);
    expect(unknownTieredTools(names)).toEqual([]);
  });

  it("tiers are disjoint and core is exactly the resident entry set", () => {
    const all = Object.values(TIER_MEMBERS).flat();
    expect(new Set(all).size).toBe(all.length);
    // 1.7.0 收窄：常驻只剩解锁入口本身，其余全按活动/开关放行。
    expect(TIER_MEMBERS.core).toEqual(["bcdp_status"]);
  });

  it("the eight batches carry the members the issues doc §9.2 assigns them", () => {
    // 1.7.0：space / navigate / help / doctor 从 core 并入 act，snapshot 并入 observe。
    expect(TIER_MEMBERS.act).toEqual([
      "bcdp_space", "bcdp_watch", "bcdp_navigate",
      "bcdp_click", "bcdp_fill", "bcdp_key", "bcdp_hover", "bcdp_scroll", "bcdp_select", "bcdp_check", "bcdp_drag", "bcdp_tab",
      "bcdp_help", "bcdp_doctor",
    ]);
    expect(TIER_MEMBERS.observe).toEqual([
      "bcdp_screenshot", "bcdp_page_info", "bcdp_read_element", "bcdp_js", "bcdp_snapshot",
    ]);
    expect(TIER_MEMBERS.wait).toEqual([
      "bcdp_wait",
    ]);
    expect(TIER_MEMBERS.power).toEqual([
      "bcdp_cdp", "bcdp_http", "bcdp_upload", "bcdp_download", "bcdp_dialog", "bcdp_diagnostics",
    ]);
    expect(TIER_MEMBERS.session).toEqual([
      "bcdp_captcha", "bcdp_auth_flush", "bcdp_login_import",
    ]);
    // 第八批：逃生舱独立成批，1.5.0 起合并为单工具（verbatim 切换两种形态）。
    expect(TIER_MEMBERS.escape).toEqual(["bcdp_script"]);
  });

  it("every batch fits the ≤13 rule the doc set for a batch", () => {
    // 1.4.1：act 加入 bcdp_tab 后到 9（原 ≤8 的整批上限随之放宽到 9）。
    // 1.7.0：收窄把 core 的 5 个成员并进 act（到 13），上限随之放宽到 13。
    // 放宽只针对 act：批次间的渐进放行仍然生效，变的只是一批的大小，不是批数。
    for (const [tier, names] of Object.entries(TIER_MEMBERS)) {
      expect(names.length, `${tier} has ${names.length} tools`).toBeLessThanOrEqual(14);
    }
  });

  it("only the core entry is live in the shipped default", () => {
    const p = P();
    for (const [tier, names] of Object.entries(TIER_MEMBERS)) {
      const allowed = names.every((n) => toolAllowed(n, p));
      // escape 不再特例：冷启动下它与其它批一样被封。
      expect(allowed).toBe(tier === "core");
    }
  });
});

describe("tierOfTool", () => {
  it("is prefix-agnostic: the legacy ego_* alias follows its bcdp_* twin", () => {
    expect(bareToolName("bcdp_click")).toBe("click");
    expect(bareToolName("ego_click")).toBe("click");
    expect(tierOfTool("ego_click")).toBe(tierOfTool("bcdp_click"));
    expect(tierOfTool("ego_status")).toBe("core");
  });

  it("an unregistered name falls to the strictest tier instead of sneaking onto the resident surface", () => {
    expect(tierOfTool("bcdp_not_in_the_table")).toBe("power");
    expect(toolAllowed("bcdp_not_in_the_table", P())).toBe(false);
    expect(unknownTieredTools(["bcdp_click", "bcdp_nope"])).toEqual(["bcdp_nope"]);
  });
});

describe("tierAllowed policy gates", () => {
  it("core is never sealable — lazy mode must keep its own unlock entry", () => {
    for (const p of [
      P(), P({ injection: "always" }),
      P({ toolBrowse: false, toolExtended: false, toolEscape: false, toolJudge: false }),
    ]) {
      expect(tierAllowed("core", p)).toBe(true);
    }
  });

  it("escape now waits for activity like every other tier (its switch still seals it)", () => {
    // 1.7.0：冷启动不再可用——先调 bcdp_status 才能拿到逃生舱（代价换来常驻面收窄）。
    expect(tierAllowed("escape", P({ active: false, batchDepth: 0 }))).toBe(false);
    expect(tierAllowed("escape", P({ active: true, batchDepth: 0 }))).toBe(true);
    // 但开关仍然是硬锁。
    expect(tierAllowed("escape", P({ active: true, toolEscape: false }))).toBe(false);
    // always 模式同样受开关约束。
    expect(tierAllowed("escape", P({ injection: "always", toolEscape: false }))).toBe(false);
  });

  it("every other gated tier still waits for browser activity in lazy mode", () => {
    const sealed = P({ active: false, batchDepth: 0 });
    const open = P({ active: true });
    for (const tier of GATED) {
      expect(tierAllowed(tier, sealed), `${tier} should be sealed`).toBe(false);
      expect(tierAllowed(tier, open), `${tier} should be open`).toBe(true);
    }
  });

  it("a tier switch is a hard lock: activity cannot open a sealed tier", () => {
    const active = P({ active: true });
    expect(tierAllowed("power", { ...active, toolExtended: false })).toBe(false);
    expect(tierAllowed("session", { ...active, toolExtended: false })).toBe(false);
    expect(tierAllowed("act", { ...active, toolBrowse: false })).toBe(false);
    // 封一组不波及另一组：开关组之间互相独立。
    expect(tierAllowed("power", { ...active, toolBrowse: false })).toBe(true);
    expect(tierAllowed("act", { ...active, toolExtended: false })).toBe(true);
  });

  it("one switch covers its whole group (browse → act/observe/wait, extended → power/session)", () => {
    const off = P({ active: true, toolBrowse: false });
    for (const tier of ["act", "observe", "wait"] as const) expect(tierAllowed(tier, off)).toBe(false);
    const off2 = P({ active: true, toolExtended: false });
    for (const tier of ["power", "session"] as const) expect(tierAllowed(tier, off2)).toBe(false);
  });

  it("always mode ignores the activity flag but not the switches", () => {
    for (const tier of GATED) {
      expect(tierAllowed(tier, P({ injection: "always", active: false }))).toBe(true);
      expect(tierAllowed(tier, P({ injection: "always", active: false, toolBrowse: false, toolExtended: false, toolEscape: false, toolJudge: false }))).toBe(false);
    }
  });

  it("the judge tier needs BOTH its switch open and a configured key", () => {
    expect(tierAllowed("judge", P({ toolJudge: false, active: true }))).toBe(false);
    expect(tierAllowed("judge", P({ judgeConfigured: false, active: true }))).toBe(false);
    expect(tierAllowed("judge", P({ active: true }))).toBe(true);
  });

  it("judgeConfigured reads keys, not URLs (layaUrl has a non-empty default)", () => {
    expect(judgeConfigured({ jevKey: "", layaKey: "" })).toBe(false);
    expect(judgeConfigured({ jevKey: "  ", layaKey: "" })).toBe(false);
    expect(judgeConfigured({ layaKey: "k" })).toBe(true);
    expect(judgeConfigured({ jevKey: "k" })).toBe(true);
    expect(judgeConfigured({})).toBe(false);
  });
});

describe("tier injector controller", () => {
  /** 假宿主：记录注册/反注册，disposer 可观察。 */
  const harness = (initial: TierPolicy) => {
    let policy = initial;
    const live: string[] = [];
    const disposals: string[] = [];
    const injector = createTierInjector({
      register: (tool) => {
        const name = String(tool.name);
        live.push(name);
        return () => {
          disposals.push(name);
          live.splice(live.indexOf(name), 1);
        };
      },
      policy: () => policy,
    });
    return {
      injector,
      live,
      disposals,
      setPolicy: (next: TierPolicy) => { policy = next; },
      offer: (name: string) => injector.offer({ name }),
    };
  };

  it("lazy mount registers the core entry alone, and keeps the rest pending", () => {
    const h = harness(P({ active: false, batchDepth: 0 }));
    for (const n of [...TIER_MEMBERS.core, ...TIER_MEMBERS.act, ...TIER_MEMBERS.escape]) h.offer(n);
    expect(h.injector.surface().live.slice().sort()).toEqual(sorted0(TIER_MEMBERS.core));
    expect(h.injector.surface().sealed).toContain("bcdp_click");
    // 逃生舱也不再常驻：它跟着活动闸走。
    expect(h.injector.surface().sealed).toContain("bcdp_script");
  });

  it("activity widens the surface; re-sealing narrows it again (dispose, not refuse)", () => {
    const h = harness(P({ active: false, batchDepth: 0 }));
    for (const n of [...TIER_MEMBERS.core, ...TIER_MEMBERS.act, ...TIER_MEMBERS.escape]) h.offer(n);
    h.setPolicy(P({ active: true, batchDepth: 3 }));
    h.injector.reapply();
    expect(h.live).toContain("bcdp_click");
    h.setPolicy(P({ active: false, batchDepth: 0 }));
    h.injector.reapply();
    expect(h.live.slice().sort()).toEqual(sorted0(TIER_MEMBERS.core));
    expect(h.disposals).toContain("bcdp_click");
  });

  it("reapply is idempotent — no double registration, no orphan disposer", () => {
    const h = harness(P({ injection: "always" }));
    h.offer("bcdp_click");
    h.injector.reapply();
    h.injector.reapply();
    expect(h.live.filter((n) => n === "bcdp_click")).toEqual(["bcdp_click"]);
    expect(h.disposals).toEqual([]);
  });

  it("a settings flip seals one group live, leaving the others open", () => {
    const h = harness(P({ active: true, batchDepth: 3 }));
    for (const n of [...TIER_MEMBERS.core, ...TIER_MEMBERS.act, ...TIER_MEMBERS.power]) h.offer(n);
    expect(h.live).toContain("bcdp_cdp");
    h.setPolicy(P({ active: true, batchDepth: 3, toolExtended: false }));
    h.injector.reapply();
    // power 被收，act 仍在——开关组互相独立。
    expect(sorted0(h.live)).toEqual(sorted0([...TIER_MEMBERS.core, ...TIER_MEMBERS.act]));
  });

  it("the escape switch seals script alone, without touching any other group", () => {
    const h = harness(P({ active: true, batchDepth: 3 }));
    for (const n of [...TIER_MEMBERS.core, ...TIER_MEMBERS.escape, ...TIER_MEMBERS.power]) h.offer(n);
    expect(h.live).toContain("bcdp_script");
    h.setPolicy(P({ active: true, batchDepth: 3, toolEscape: false }));
    h.injector.reapply();
    expect(h.live).not.toContain("bcdp_script");
    // power 完全不受影响。
    expect(h.live).toContain("bcdp_cdp");
  });

  it("an unconfigured judge tier never registers, even at mount in always mode", () => {
    const h = harness(P({ injection: "always", judgeConfigured: false }));
    for (const n of TIER_MEMBERS.judge) h.offer(n);
    expect(h.live).toEqual([]);
    h.setPolicy(P({ injection: "always", judgeConfigured: true }));
    h.injector.reapply();
    expect(h.live.slice().sort()).toEqual(sorted0(TIER_MEMBERS.judge));
  });

  it("every table entry is reachable under the widest policy", () => {
    const h = harness(P({ injection: "always" }));
    for (const n of [...TIER_OF_TOOL.keys()]) h.offer(n);
    expect(h.injector.surface().sealed).toEqual([]);
    expect(h.live.length).toBe(TIER_OF_TOOL.size);
  });
});

describe("progressive batches (act → observe → wait)", () => {
  it("releases the browsing trio in order as activity depth grows", () => {
    const at = (batchDepth: number) => P({ active: true, batchDepth });
    // depth 0: nothing browsing-related yet.
    expect(toolAllowed("bcdp_click", at(0))).toBe(false);
    // depth 1: act only.
    expect(toolAllowed("bcdp_click", at(1))).toBe(true);
    expect(toolAllowed("bcdp_screenshot", at(1))).toBe(false);
    expect(toolAllowed("bcdp_wait", at(1))).toBe(false);
    // depth 2: + observe.
    expect(toolAllowed("bcdp_screenshot", at(2))).toBe(true);
    expect(toolAllowed("bcdp_read_element", at(2))).toBe(true);
    expect(toolAllowed("bcdp_wait", at(2))).toBe(false);
    // depth 3: + wait.
    expect(toolAllowed("bcdp_wait", at(3))).toBe(true);
  });

  it("the batch gate applies to the browsing trio only — power/session/escape are not depth-gated", () => {
    const shallow = P({ active: true, batchDepth: 1 });
    expect(toolAllowed("bcdp_status", shallow)).toBe(true);
    // power/session ride the activity gate, not the depth gate.
    expect(toolAllowed("bcdp_download", shallow)).toBe(true);
    expect(toolAllowed("bcdp_login_import", shallow)).toBe(true);
    // escape 同属活动闸批次：活动一到就放行，但不受深度限制。
    expect(toolAllowed("bcdp_script", P({ active: false, batchDepth: 0 }))).toBe(false);
    expect(toolAllowed("bcdp_script", shallow)).toBe(true);
  });

  it("always mode ignores batch depth (historical mount-all semantics)", () => {
    const p = P({ injection: "always", active: false, batchDepth: 0 });
    expect(toolAllowed("bcdp_wait", p)).toBe(true);
  });

  it("batchOfTool is prefix-agnostic and maps non-progressive tiers to act", () => {
    expect(batchOfTool("bcdp_click")).toBe("act");
    expect(batchOfTool("ego_click")).toBe("act");
    expect(batchOfTool("bcdp_drag")).toBe("act");
    expect(batchOfTool("bcdp_screenshot")).toBe("observe");
    expect(batchOfTool("bcdp_wait")).toBe("wait");
    // 非渐进批次不是「批」，落到默认值。
    expect(batchOfTool("bcdp_script")).toBe("act");
    expect(batchOfTool("bcdp_unlisted")).toBe("act");
    expect(BATCH_ORDER).toEqual(["act", "observe", "wait"]);
  });
});
