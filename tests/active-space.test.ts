import { describe, it, expect } from "vitest";
import {
  createActiveSpaceTracker,
  runWithStaleSpaceRetry,
  runWithTabRevive,
  isTabStuckFailure,
  createSessionSpaceTracker,
  deriveSlotDefaultName,
  sessionSpaceToken,
  attachSessionHint,
  ATTACH_SESSION_HINT,
  GLOBAL_SESSION_KEY,
} from "../src/index.ts";

describe("active ego task space", () => {
  it("routes omitted-space calls to the most recently opened space", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "open bilibili" }, { ok: true, id: 45, name: "open bilibili" });
    expect(tracker.current()).toBe(45);
  });

  it("tracks explicit selection and resets after closing the active space", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.selected("research");
    expect(tracker.current()).toBe("research");
    tracker.closed("research", true);
    expect(tracker.current()).toBe("dsh-agent");
  });

  it("resets an ID-backed active space when closed by its name", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "task" }, { ok: true, id: 45, name: "task" });
    tracker.closed("task", true);
    expect(tracker.current()).toBe("dsh-agent");
  });

  it("resetToName drops a stale numeric id back to the remembered name", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "task" }, { ok: true, id: 45, name: "task" });
    expect(tracker.current()).toBe(45);
    tracker.resetToName();
    expect(tracker.current()).toBe("task");
  });

  it("resetToName falls back to the default space when no name is known", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.selected(7);
    tracker.resetToName();
    expect(tracker.current()).toBe("dsh-agent");
  });
});

// ── stale-space retry (browser restart wipes the runtime's space table) ────

function fakeSubprocess(behavior: Array<{ exitCode: number | null; stdout?: string; stderr?: string }>) {
  let calls = 0;
  const mk = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) });
  return {
    spawn() {
      const b = behavior[Math.min(calls++, behavior.length - 1)];
      return {
        done: Promise.resolve({ exitCode: b.exitCode, signal: null }),
        collected: { stdout: mk(b.stdout ?? ""), stderr: mk(b.stderr ?? "") },
      };
    },
    get calls() { return calls; },
  };
}

const fakeCfg = (
  tracker: ReturnType<typeof createActiveSpaceTracker>,
  extra: Record<string, unknown> = {},
) => ({
  // R7 — runEgoScript builds its argv from this prefix (shape-aware).
  egoBin: "x", egoArgvPrefix: ["node", "x"], graceMs: 5000, maxOutputBytes: 4096,
  configuredDefaultSpace: "dsh-agent", spaceTracker: tracker,
  get defaultSpace() { return tracker.current() },
  ...extra,
}) as never;

const fakeCtx = (subprocess: unknown) => ({ subprocess }) as never;
const fakeExec = {} as never;

describe("runWithStaleSpaceRetry", () => {
  it("retries once with the space NAME after a stale numeric id failure", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "task" }, { ok: true, id: 3, name: "task" });
    const subprocess = fakeSubprocess([
      { exitCode: 1, stderr: "Error: task space not found: 3" },
      { exitCode: 0, stdout: "@@DSH_RESULT@@{\"ok\":true}" },
    ]);
    const built: string[] = [];
    const result = await runWithStaleSpaceRetry(fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => {
      built.push(String(tracker.current()));
      return "script";
    });
    expect(result.ok).toBe(true);
    expect(subprocess.calls).toBe(2);
    expect(built).toEqual(["3", "task"]); // first attempt used the stale id, retry used the name
    expect(tracker.current()).toBe("task");
  });

  it("does not retry unrelated failures", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "task" }, { ok: true, id: 3, name: "task" });
    const subprocess = fakeSubprocess([{ exitCode: 1, stderr: "some other error" }]);
    const result = await runWithStaleSpaceRetry(fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => "script");
    expect(result.ok).toBe(false);
    expect(subprocess.calls).toBe(1);
    expect(tracker.current()).toBe(3);
  });

  it("does not retry a stale-NAME failure (space genuinely gone)", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    const subprocess = fakeSubprocess([{ exitCode: 1, stderr: "Error: task space not found: research" }]);
    const result = await runWithStaleSpaceRetry(fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => "script");
    expect(result.ok).toBe(false);
    expect(subprocess.calls).toBe(1);
  });

  // A relaunched browser keeps the endpoint but mints a NEW browser id, so the
  // cached ws dead-ends. This signature is deliberately NOT one of the
  // cold-start signs, so withWarmupRetry does not burn attempts on it — the
  // re-probe below is the only thing that can recover it.
  it("re-probes the link and retries once after a dead cached ws", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    const subprocess = fakeSubprocess([
      { exitCode: 1, stderr: "Error: failed to connect to CDP endpoint: ws://127.0.0.1:9222/devtools/page/A" },
      { exitCode: 0, stdout: "@@DSH_RESULT@@{\"ok\":true}" },
    ]);
    let probes = 0;
    const result = await runWithStaleSpaceRetry(
      fakeCtx(subprocess),
      fakeCfg(tracker, { refreshAttach: async () => { probes++; return true; } }),
      fakeExec,
      () => "script",
    );
    expect(probes).toBe(1);
    expect(result.ok).toBe(true);
    expect(subprocess.calls).toBe(2);
  });

  it("re-probes and retries when the runtime says CDP channel is not open", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    const subprocess = fakeSubprocess([
      // "CDP channel is not open" is also a cold-start signature, so the normal
      // warmup gets three attempts before the stale-attach re-probe is needed.
      { exitCode: 1, stderr: "Error: CDP channel is not open" },
      { exitCode: 1, stderr: "Error: CDP channel is not open" },
      { exitCode: 1, stderr: "Error: CDP channel is not open" },
      { exitCode: 0, stdout: "@@DSH_RESULT@@{\"ok\":true}" },
    ]);
    let probes = 0;
    const result = await runWithStaleSpaceRetry(
      fakeCtx(subprocess),
      fakeCfg(tracker, { refreshAttach: async () => { probes++; return true; } }),
      fakeExec,
      () => "script",
    );
    expect(probes).toBe(1);
    expect(result.ok).toBe(true);
    expect(subprocess.calls).toBe(4);
  });

  it("does not retry a connect failure when the re-probe found no new endpoint", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    const subprocess = fakeSubprocess([
      { exitCode: 1, stderr: "Error: failed to connect to CDP endpoint: ws://127.0.0.1:9222/devtools/page/A" },
      { exitCode: 0, stdout: "@@DSH_RESULT@@{\"ok\":true}" },
    ]);
    const result = await runWithStaleSpaceRetry(
      fakeCtx(subprocess),
      fakeCfg(tracker, { refreshAttach: async () => false }),
      fakeExec,
      () => "script",
    );
    expect(result.ok).toBe(false);
    expect(subprocess.calls).toBe(1); // no spinning: nothing moved, so nothing retried
  });
});

// ── F: navigate tab-revive watchdog (a wedged/absent tab, not a cold start) ──

describe("runWithTabRevive", () => {
  const stuck = { exitCode: 1, stderr: "Error: no active tab to attach session" };
  const ok = { exitCode: 0, stdout: '@@DSH_RESULT@@{"ok":true,"page":{}}' };

  it("isTabStuckFailure matches tab-wedge signatures but not a plain cold start", () => {
    expect(isTabStuckFailure({ ok: false, error: "no active tab to attach session", stdout: "", stderr: "" })).toBe(true);
    expect(isTabStuckFailure({ ok: false, error: "navigation timed out after 20000ms", stdout: "", stderr: "" })).toBe(true);
    expect(isTabStuckFailure({ ok: false, error: "ego-browser exited with code 1", stdout: "", stderr: "some other error" })).toBe(false);
  });

  it("revives once and retries when the tab is stuck, tagging recoveredFrom", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    // first navigate fails stuck → revive script → retry succeeds.
    const subprocess = fakeSubprocess([stuck, ok, ok]);
    const { result, recoveredFrom } = await runWithTabRevive(
      fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => "navigate-script",
    );
    expect(result.ok).toBe(true);
    expect(recoveredFrom).toBeTruthy();
    expect(recoveredFrom).toContain("no active tab");
    // exactly one revive in between: first attempt + revive + retry = 3 spawns.
    expect(subprocess.calls).toBe(3);
  });

  it("returns recoveredFrom:null and spawns once on the normal path", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    const subprocess = fakeSubprocess([ok]);
    const { result, recoveredFrom } = await runWithTabRevive(
      fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => "navigate-script",
    );
    expect(result.ok).toBe(true);
    expect(recoveredFrom).toBeNull();
    expect(subprocess.calls).toBe(1);
  });

  it("does NOT revive an unrelated (non-tab) failure — hard cap respected", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    const subprocess = fakeSubprocess([{ exitCode: 1, stderr: "TypeError: something else broke" }]);
    const { result, recoveredFrom } = await runWithTabRevive(
      fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => "navigate-script",
    );
    expect(result.ok).toBe(false);
    expect(recoveredFrom).toBeNull();
    expect(subprocess.calls).toBe(1);
  });

  it("caps at ONE revive — a second stuck attempt is returned verbatim, not looped", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    // every attempt stuck; fakeSubprocess clamps to the last behavior.
    const subprocess = fakeSubprocess([stuck]);
    const { result, recoveredFrom } = await runWithTabRevive(
      fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => "navigate-script",
    );
    expect(result.ok).toBe(false);
    // first + revive + one retry, then STOP (hard cap 1) = 3 spawns, not more.
    expect(subprocess.calls).toBe(3);
    expect(recoveredFrom).toContain("no active tab");
  });
});

// ── C: :auto per-session derivation (task_7 — both modes) ──────────────────

describe("deriveSlotDefaultName (:auto expansion, C)", () => {
  it("expands :auto to dsh-agent-<sid8> in isolated-sandbox mode", () => {
    expect(deriveSlotDefaultName({ defaultSpace: ":auto", isolateSpaces: true }, "sess-1234567890")).toBe("dsh-agent-sess-123");
  });
  // v1.6.0: session isolation is the DEFAULT, so the sentinel is honoured in
  // persistent mode too — space NAMING is orthogonal to profile persistence
  // (isolateSpaces only decides disk-profile vs in-memory sandbox).
  it("expands :auto the same way in persistent mode (isolation is the default)", () => {
    expect(deriveSlotDefaultName({ defaultSpace: ":auto", isolateSpaces: false }, "sess-1234567890")).toBe("dsh-agent-sess-123");
  });
  it("keeps the global (no-session) slot on 'default' in either mode", () => {
    expect(deriveSlotDefaultName({ defaultSpace: ":auto", isolateSpaces: true }, GLOBAL_SESSION_KEY)).toBe("default");
    expect(deriveSlotDefaultName({ defaultSpace: ":auto", isolateSpaces: false }, GLOBAL_SESSION_KEY)).toBe("default");
  });
  it("passes a non-:auto configured name through verbatim (opt-in to a shared slot)", () => {
    expect(deriveSlotDefaultName({ defaultSpace: "research", isolateSpaces: true }, "sess-1")).toBe("research");
    expect(deriveSlotDefaultName({ defaultSpace: "research", isolateSpaces: false }, "sess-1")).toBe("research");
    expect(deriveSlotDefaultName({ defaultSpace: "default", isolateSpaces: false }, "sess-1")).toBe("default");
  });
});

// ── v1.6.0 regression: a real DSH sessionId must NOT collapse to 'session-' ──
//
// The old derivation was `sessionKey.slice(0, 8)`. Real DSH ids look like
// `session-52adc205-3251-…`, so that yielded the literal `session-` for EVERY
// session and all sessions shared one space — silently defeating isolation.
describe("sessionSpaceToken (prefix-collapse regression)", () => {
  it("strips the `session-` prefix so real DSH ids separate", () => {
    expect(sessionSpaceToken("session-52adc205-3251-4fb4-8db0-716d56053365")).toBe("52adc205");
    expect(sessionSpaceToken("session-11111111-aaaa-bbbb-cccc-dddddddddddd")).toBe("11111111");
  });
  it("gives two different DSH sessions two different tokens", () => {
    const a = sessionSpaceToken("session-52adc205-3251-4fb4-8db0-716d56053365");
    const b = sessionSpaceToken("session-9f3e7711-0000-1111-2222-333344445555");
    expect(a).not.toBe(b);
  });
  it("never returns the bare prefix (the historical failure mode)", () => {
    for (const id of [
      "session-52adc205-3251-4fb4-8db0-716d56053365",
      "session-abc",
      "s",
      "",
    ]) {
      expect(sessionSpaceToken(id)).not.toBe("session-");
    }
  });
  it("uses a short id as-is, and only a degenerate id hashes", () => {
    // Short ids stay readable AND distinct.
    expect(sessionSpaceToken("alpha")).toBe("alpha");
    expect(sessionSpaceToken("alpha")).not.toBe(sessionSpaceToken("beta"));
    // An id that sanitizes to nothing still yields a deterministic 8-hex token.
    const empty1 = sessionSpaceToken("");
    const empty2 = sessionSpaceToken("");
    expect(empty1).toBe(empty2);
    expect(empty1).toMatch(/^[0-9a-f]{8}$/);
  });
  it("produces a space-name-safe token (alphanumerics/hyphens, at most 8 chars)", () => {
    for (const id of ["session-52adc205-3251-4fb4-8db0-716d56053365", "weird id!!with spaces", "session-x"]) {
      const tok = sessionSpaceToken(id);
      expect(tok).toMatch(/^[A-Za-z0-9-]+$/);
      expect(tok.length).toBeLessThanOrEqual(8);
      expect(tok.length).toBeGreaterThan(0);
    }
    // A real DSH id consumes the full 8 chars.
    expect(sessionSpaceToken("session-52adc205-3251-4fb4-8db0-716d56053365")).toHaveLength(8);
  });
});

// ── B: session-keyed slots (task_11 resetToName scope, task_12 isolation) ───

describe("createSessionSpaceTracker", () => {
  const mk = () =>
    createSessionSpaceTracker((key) => deriveSlotDefaultName({ defaultSpace: ":auto", isolateSpaces: true }, key));

  it("isolates two sessions' active spaces (task_12)", () => {
    const t = mk();
    t.setCurrentSession("alpha");
    expect(t.current()).toBe("dsh-agent-alpha"); // derived from sid
    t.opened({ name: "vid" }, { ok: true, id: 7, name: "vid" });
    expect(t.current()).toBe(7);

    t.setCurrentSession("beta");
    expect(t.current()).toBe("dsh-agent-beta"); // fresh slot, no bleed from alpha
    t.selected("notes");
    expect(t.current()).toBe("notes");

    t.setCurrentSession("alpha");
    expect(t.current()).toBe(7); // alpha's slot untouched by beta
  });

  it("routes no-session calls through the __global__ slot (backward compat)", () => {
    const t = mk();
    expect(t.current()).toBe("default");
    t.selected("x");
    expect(t.current()).toBe("x");
    t.setCurrentSession(undefined);
    expect(t.current()).toBe("x"); // still the global slot
  });

  it("resetToName only touches the current session slot (task_11)", () => {
    const t = mk();
    t.setCurrentSession("alpha");
    t.opened({ name: "task" }, { ok: true, id: 3, name: "task" });
    t.setCurrentSession("beta");
    t.opened({ name: "other" }, { ok: true, id: 9, name: "other" });
    // Beta restarts its space; reset must drop BETA to its name, not alpha's.
    t.resetToName();
    expect(t.current()).toBe("other");
    t.setCurrentSession("alpha");
    expect(t.current()).toBe(3); // alpha keeps the stale numeric id untouched
  });
});

// ── G: heredoc attach-session escape hint (task_3) ─────────────────────────

describe("attachSessionHint (G)", () => {
  it("appends the useOrCreate guidance when the signature is present", () => {
    const hinted = attachSessionHint("boom: no active tab to attach session");
    expect(hinted).toContain("no active tab to attach session");
    expect(hinted).toContain(ATTACH_SESSION_HINT);
    expect(hinted).toContain("taskSpaces.useOrCreate");
  });
  it("is idempotent — never double-appends the hint", () => {
    const once = attachSessionHint("no active tab to attach session");
    expect(attachSessionHint(once)).toBe(once);
  });
  it("leaves unrelated errors untouched", () => {
    expect(attachSessionHint("TypeError: nope")).toBe("TypeError: nope");
    expect(attachSessionHint(undefined)).toBe("");
  });
});
