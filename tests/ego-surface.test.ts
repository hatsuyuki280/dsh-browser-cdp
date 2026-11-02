import { describe, it, expect } from "vitest";
import { apply } from "../src/index.ts";
import { SENTINEL } from "../src/util.ts";

/**
 * 脚本拼装单测：不真跑浏览器，只把每个工具生成的 heredoc 脚本截获下来，断言其
 * 含预期的 SDK 调用与守卫文案（见 findings P0-1..P0-5）。做法是给 `apply()` 喂
 * 一个假宿主，让 `subprocess.spawn` 记下 stdin 的脚本内容并回一段带 SENTINEL 的
 * 成功负载，`execute()` 即可 resolve，而脚本本身被 `spawned` 抓到。
 */
const mountCapturing = (config: Record<string, unknown> = {}) => {
  // 强制全量挂载，否则 lazy 默认只注册 core+escape，act/wait 的句柄不存在。
  config = { toolInjection: "always", ...config };
  let lastScript = "";
  // 罐头负载可切换：tracker 的 closed() 只在 done=true 时复位，断言该路径
  // 需要一份带 done 的负载。
  let payload: Record<string, unknown> = { ok: true, captured: true };
  const handles = new Map<string, any>();
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) });
  const ctx: any = {
    tools: {
      register: (tool: any) => {
        handles.set(tool.name, tool);
        return () => {};
      },
    },
    subprocess: {
      spawn: (req: any) => {
        lastScript = req?.stdio?.stdin?.data ?? "";
        // 回一段哨兵成功负载，让 runEgoScript 走 ok 分支；断言只看 lastScript。
        const text = SENTINEL + JSON.stringify(payload);
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: reader(text), stderr: reader("") },
        };
      },
    },
    on: () => () => {},
    effect: (fn: () => unknown) => { try { fn(); } catch { /* 替身不为难子模块 */ } },
    logger: { info() {}, warn() {}, error() {} },
  };
  apply(ctx, config as never);
  const run = async (name: string, args: Record<string, unknown>) => {
    const value = await handles.get(name).execute(args, {});
    return { script: lastScript, value };
  };
  return { run, handles, setPayload: (p: Record<string, unknown>) => { payload = p } };
};

describe("schema budget (the ≤+15% gate from the plan)", () => {
  /**
   * 挂载级口径：每个工具的 `description.length + JSON.stringify(parameters).length`。
   * 这是一次性测量（1.3.2 的 38 工具基线 = 20,951）后固化的天花板，不是精确值断言——
   * 目的是让「顺手加一句描述」不能悄悄把常驻 schema 面撑大。
   * 24,094 = 20,951 × 1.15；1.3.2 实测 41 工具为 24,035（+14.72%）。
   * 1.5.0 三族合并（wait 5→1、space 3→1、escape 2→1）后为 34 工具 / 22,224
   * 字符（净省 1,869），天花板**未上调**。
   */
  const CEILING = 24_094;
  const schemaChars = (t: any) =>
    String(t?.description ?? "").length + JSON.stringify(t?.parameters ?? {}).length;

  it("all 35 tools registered together stay under the +15% schema ceiling", () => {
    const { handles } = mountCapturing({ layaKey: "k" });
    const sizes = [...handles.values()].map(schemaChars);
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(sizes.length).toBe(35);
    expect(total, `schema total ${total} > ceiling ${CEILING}`).toBeLessThanOrEqual(CEILING);
  });
});

describe("bcdp_tab script assembly", () => {
  it("op=list calls browser.listTabs and maps the SDK tab shape", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_tab", { op: "list" });
    expect(script).toContain("browser.listTabs()");
    expect(script).toContain("targetId: t.targetId");
    // SDK 的 listTabs 没有 openedBy 字段——不得凭空出现。
    expect(script).not.toContain("openedBy");
  });

  it("op=new calls browser.openOrReuseTab with the url", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_tab", { op: "new", url: "https://example.com" });
    expect(script).toContain("browser.openOrReuseTab(");
    expect(script).toContain("https://example.com");
  });

  it("op=close carries the last-tab guard", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_tab", { op: "close", target: "abc123" });
    expect(script).toContain("browser.closeTab(");
    expect(script).toContain("__tabs.length <= 1");
    expect(script).toContain("refusing to close the last tab");
  });

  it("op=switch resolves target via listTabs, exact targetId then URL substring", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_tab", { op: "switch", target: "abc123" });
    expect(script).toContain("x.targetId ===");
    expect(script).toContain("(x.url || '').includes(");
    expect(script).toContain("browser.switchTab(");
  });

  it("an illegal op returns ok:false without spawning a browser call", async () => {
    const { run } = mountCapturing();
    const { value } = await run("bcdp_tab", { op: "nope" });
    expect(value.ok).toBe(true); // canned payload — the guard lives in the script
    const { script } = await run("bcdp_tab", { op: "nope" });
    expect(script).toContain("op must be one of");
  });
});

describe("bcdp_space script assembly (merged 3→1)", () => {
  it("op=list calls taskSpaces.list()", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_space", { op: "list" });
    expect(script).toContain("taskSpaces.list()");
  });

  it("op=open uses useOrCreate and reports the resolved id/name", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_space", { op: "open", name: "alpha" });
    expect(script).toContain("taskSpaces.useOrCreate(");
    expect(script).toContain("alpha");
    expect(script).toContain("task.id");
    expect(script).toContain("task.name");
    // open 不需要 preamble 里的真实 tab（它自己就是建空间的入口）。
    expect(script).not.toContain("browser.listTabs()");
  });

  it("op=close calls taskSpaces.complete with the keep flag", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_space", { op: "close", name: "alpha", keep: true });
    expect(script).toContain("taskSpaces.complete(");
    expect(script).toContain("keep: true");
    expect(script).toContain("target space was not agent-owned");
  });

  it("op=handoff calls taskSpaces.handOff and does NOT probe page.info (P0-5 hard-stop)", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_space", { op: "handoff", name: "default" });
    expect(script).toContain("taskSpaces.handOff(");
    // handOff 之后同脚本内不得再碰 page.*，否则触发运行时硬停。
    expect(script).not.toContain("page.info");
  });

  it("op=takeover calls taskSpaces.takeOver then page.info", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_space", { op: "takeover", name: "default" });
    expect(script).toContain("taskSpaces.takeOver(");
    expect(script).toContain("page.info()");
  });

  it("an illegal op returns ok:false with an actionable reason", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_space", { op: "claim" });
    expect(script).toContain("op must be one of open|close|list|handoff|takeover");
  });
});

/**
 * 合并后 open/close/list/handoff/takeover 共用一个工具名，`afterExecute` 再也
 * 不能按工具名分派 tracker —— 必须按 `op`。这三条用例直接观察「后续工具解析到的
 * 默认空间」，也就是 tracker 的**唯一用户可见效应**；若分派退回按工具名，这里会
 * 全线失败（这正是 R1 想要的护栏）。
 */
describe("bcdp_space tracker dispatch is op-based (R1)", () => {
  const defaultSpaceOfNextCall = async (
    prepare: (h: ReturnType<typeof mountCapturing>) => Promise<void>,
  ): Promise<string> => {
    const h = mountCapturing();
    await prepare(h);
    const { script } = await h.run("bcdp_wait", { op: "selector", selector: ".probe" });
    const m = /taskSpaces\.useOrCreate\(([^)]*)\)/.exec(script);
    return m ? m[1] : "<none>";
  };

  it("op=open records the opened space for later calls", async () => {
    const got = await defaultSpaceOfNextCall(async (h) => {
      await h.run("bcdp_space", { op: "open", name: "alpha" });
    });
    expect(got).toBe('"alpha"');
  });

  it("op=close resets the slot to the default space when done", async () => {
    const got = await defaultSpaceOfNextCall(async (h) => {
      await h.run("bcdp_space", { op: "open", name: "alpha" });
      h.setPayload({ ok: true, done: true });
      await h.run("bcdp_space", { op: "close", name: "alpha" });
      h.setPayload({ ok: true, captured: true });
    });
    expect(got).toBe('"default"');
  });

  it("a space= argument selects that space for later calls", async () => {
    const got = await defaultSpaceOfNextCall(async (h) => {
      await h.run("bcdp_snapshot", { space: "beta" });
    });
    expect(got).toBe('"beta"');
  });
});

describe("bcdp_wait script assembly (merged 5→1)", () => {
  it("op=duration waits a fixed ms and needs no task space / real tab", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_wait", { op: "duration", ms: 250 });
    expect(script).toContain("page.waitForTimeout(250)");
    expect(script).toContain("waitedMs");
    // 与合并前的 bcdp_wait 一致：duration 不加 preamble。
    expect(script).not.toContain("taskSpaces.useOrCreate");
    expect(script).not.toContain("browser.listTabs()");
  });

  it("op=selector waits for the selector with the requested state", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_wait", { op: "selector", selector: ".results", state: "hidden" });
    expect(script).toContain("page.waitForSelector(");
    expect(script).toContain(".results");
    expect(script).toContain("hidden");
    // 选择性 op 必须带 preamble（选区 + 真实 tab）。
    expect(script).toContain("taskSpaces.useOrCreate");
    expect(script).toContain("browser.listTabs()");
  });

  it("op=url waits for navigation and reports the final url", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_wait", { op: "url", pattern: "/login?done" });
    expect(script).toContain("page.waitForURL(");
    expect(script).toContain("/login?done");
    expect(script).toContain("page.url()");
  });

  it("op=response fetches the body only when body=text|json", async () => {
    const withBody = await (async () => {
      const { run } = mountCapturing();
      return (await run("bcdp_wait", { op: "response", url: "/api/search", body: "json" })).script;
    })();
    expect(withBody).toContain("page.waitForResponse(");
    expect(withBody).toContain("__res.json()");
    expect(withBody).toContain("body: __body");

    const withoutBody = await (async () => {
      const { run } = mountCapturing();
      return (await run("bcdp_wait", { op: "response", url: "/api/search" })).script;
    })();
    expect(withoutBody).not.toContain("__res.json()");
    expect(withoutBody).not.toContain("body: __body");
  });

  it("op=load calls waitForLoadState (soft-fail: reads the return value + reason)", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_wait", { op: "load", state: "networkidle" });
    expect(script).toContain("page.waitForLoadState(");
    expect(script).toContain("networkidle");
    expect(script).toContain("!!__ok");
    // 失败要可归因：ok:false 必须带含超时的 reason。
    expect(script).toContain("load state not reached within");
  });

  it("op=function calls waitForFunction with the safeEvalWrap'd expression", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_wait", { op: "function", expression: "1===1" });
    expect(script).toContain("page.waitForFunction(");
    expect(script).toContain("1===1");
    expect(script).toContain("!!__v");
    // P0-2 / E：超时 resolve false（不抛错），故 reason 只能由返回值分支给出；
    // 表达式必须在页内被 safeEvalWrap 包裹，否则 DOM/window 返回值会撞 SDK 的
    // "Object reference chain is too long"。
    expect(script).toContain("expression never became truthy");
    expect(script).not.toMatch(/try\s*\{[\s\S]*waitForFunction/);
    // preserveFalsy：包装后仍要保留假值原样返回，否则 __v === false 分支失效。
    // 这行守卫只出现在 preserveFalsy=true 的包裹里，正好锁住"不许退回默认包裹"。
    expect(script).toContain("if (!__v) return __v;");
  });

  it("op=request calls waitForRequest wrapped in try/catch (it throws on timeout, P0-2)", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_wait", { op: "request", url: "/api/x" });
    expect(script).toContain("page.waitForRequest(");
    expect(script).toContain("/api/x");
    expect(script).toMatch(/try\s*\{[\s\S]*waitForRequest[\s\S]*catch/);
  });

  it("op=event is fixed to 'download' (other event names throw, P0-3)", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_wait", { op: "event" });
    expect(script).toContain("page.waitForEvent(");
    expect(script).toContain("'download'");
  });

  it("op=function with no expression returns ok:false without touching the page", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_wait", { op: "function", expression: "" });
    expect(script).toContain("expression is required for op=function");
    expect(script).not.toContain("page.waitForFunction");
  });

  it("missing required params are attributable per op", async () => {
    for (const [args, needle] of [
      [{ op: "selector" }, "selector is required for op=selector"],
      [{ op: "url" }, "pattern is required for op=url"],
      [{ op: "response" }, "url is required for op=response"],
      [{ op: "request" }, "url is required for op=request"],
    ] as const) {
      const { run } = mountCapturing();
      const { script } = await run("bcdp_wait", args);
      expect(script).toContain(needle);
    }
  });

  it("an unknown op is rejected with the full op list", async () => {
    const { run } = mountCapturing();
    const { script } = await run("bcdp_wait", { op: "nope" });
    expect(script).toContain("op must be one of duration|selector|url|response|load|function|request|event");
  });
});
