import { f as stopLocalBrowser, l as launchLocalBrowser } from "./launcher-Vz8i9ylT.js";
import { createRequire } from "node:module";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { constants, createReadStream, createWriteStream, existsSync, readdirSync } from "node:fs";
import { access, chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { isIP } from "node:net";
import z from "@deepseek-ai/schemastery";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

//#region src/worker/cdp-client.ts
var CdpClient = class {
	ws;
	nextId;
	pending;
	events;
	constructor(ws) {
		this.ws = ws;
		this.nextId = 0;
		this.pending = /* @__PURE__ */ new Map();
		this.events = /* @__PURE__ */ new Map();
		ws.addEventListener("message", (event) => this.#handleMessage(event));
		const close = () => this.#rejectPending(/* @__PURE__ */ new Error("CDP connection closed"));
		ws.addEventListener("close", close, { once: true });
		ws.addEventListener("error", close, { once: true });
	}
	#handleMessage(event) {
		let message;
		try {
			message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
		} catch {
			return;
		}
		if (message.id && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				const error = new Error(message.error.message || `CDP error ${message.error.code}`);
				error.code = message.error.code;
				error.data = message.error.data;
				pending.reject(error);
			} else pending.resolve(message.result || {});
			return;
		}
		if (!message.method) return;
		for (const handler of this.events.get(message.method) || []) try {
			handler(message.params || {}, message.sessionId);
		} catch {}
	}
	#rejectPending(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
	call(method, params = {}, sessionId, timeoutMs = 6e3) {
		const id = ++this.nextId;
		const payload = {
			id,
			method,
			params
		};
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolve$1, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(/* @__PURE__ */ new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: resolve$1,
				reject,
				timer
			});
			try {
				this.ws.send(JSON.stringify(payload));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	on(method, handler) {
		if (!this.events.has(method)) this.events.set(method, /* @__PURE__ */ new Set());
		this.events.get(method).add(handler);
		return () => {
			this.events.get(method)?.delete(handler);
		};
	}
};

//#endregion
//#region src/login-import.ts
const execFile$1 = promisify(execFile);
/** All candidate (exe, profile) pairs for the platform — existence NOT checked. */
function chromiumCandidates(env = process.env, platform = process.platform) {
	if (platform === "win32") {
		const la = env.LOCALAPPDATA || "";
		const pf = env["ProgramFiles"] || "C:\\Program Files";
		const pfx = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
		return [
			{
				id: "chrome",
				label: "Google Chrome",
				exePath: `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
				userDataDir: `${la}\\Google\\Chrome\\User Data`
			},
			{
				id: "chrome",
				label: "Google Chrome",
				exePath: `${pfx}\\Google\\Chrome\\Application\\chrome.exe`,
				userDataDir: `${la}\\Google\\Chrome\\User Data`
			},
			{
				id: "edge",
				label: "Microsoft Edge",
				exePath: `${pfx}\\Microsoft\\Edge\\Application\\msedge.exe`,
				userDataDir: `${la}\\Microsoft\\Edge\\User Data`
			},
			{
				id: "edge",
				label: "Microsoft Edge",
				exePath: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
				userDataDir: `${la}\\Microsoft\\Edge\\User Data`
			},
			{
				id: "brave",
				label: "Brave",
				exePath: `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
				userDataDir: `${la}\\BraveSoftware\\Brave-Browser\\User Data`
			}
		];
	}
	if (platform === "darwin") {
		const home$1 = env.HOME || "";
		return [{
			id: "chrome",
			label: "Google Chrome",
			exePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			userDataDir: `${home$1}/Library/Application Support/Google/Chrome`
		}, {
			id: "edge",
			label: "Microsoft Edge",
			exePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			userDataDir: `${home$1}/Library/Application Support/Microsoft Edge`
		}];
	}
	const home = env.HOME || "";
	return [
		{
			id: "chrome",
			label: "Google Chrome",
			exePath: "/usr/bin/google-chrome",
			userDataDir: `${home}/.config/google-chrome`
		},
		{
			id: "chrome",
			label: "Chromium",
			exePath: "/usr/bin/chromium",
			userDataDir: `${home}/.config/chromium`
		},
		{
			id: "edge",
			label: "Microsoft Edge",
			exePath: "/usr/bin/microsoft-edge",
			userDataDir: `${home}/.config/microsoft-edge`
		},
		{
			id: "brave",
			label: "Brave",
			exePath: "/usr/bin/brave-browser",
			userDataDir: `${home}/.config/BraveSoftware/Brave-Browser`
		}
	];
}
/** Candidates that actually exist on disk (exe + Local State present). */
function detectSystemBrowsers(env = process.env, platform = process.platform) {
	const seen = /* @__PURE__ */ new Set();
	return chromiumCandidates(env, platform).filter((b) => {
		if (seen.has(b.exePath)) return false;
		seen.add(b.exePath);
		return existsSync(b.exePath) && existsSync(join(b.userDataDir, "Local State"));
	});
}
function profilesFromLocalState(localStateJson, userDataDir) {
	try {
		const cache = JSON.parse(localStateJson).profile?.info_cache || {};
		const profileJoin = (base, name$1) => base.includes("\\") ? win32.join(base, name$1) : join(base, name$1);
		const out = Object.entries(cache).map(([dirName, info]) => ({
			dir: profileJoin(userDataDir, dirName),
			dirName,
			name: info && typeof info.name === "string" && info.name || dirName
		}));
		return out.length ? out : [{
			dir: profileJoin(userDataDir, "Default"),
			dirName: "Default",
			name: "Default"
		}];
	} catch {
		return [{
			dir: join(userDataDir, "Default"),
			dirName: "Default",
			name: "Default"
		}];
	}
}
/** Domain filter: "bilibili.com" matches ".bilibili.com" and any subdomain. */
function cookieMatchesDomains(cookieDomain, domains) {
	if (!domains || domains.length === 0) return true;
	const host = String(cookieDomain || "").replace(/^\./, "").toLowerCase();
	return domains.some((raw) => {
		const d = String(raw || "").replace(/^\./, "").trim().toLowerCase();
		return d !== "" && (host === d || host.endsWith("." + d));
	});
}
/** Convert a CDP Network.Cookie to a Storage.setCookies CookieParam. */
function toCookieParam(c) {
	if (!c || typeof c.name !== "string" || c.name === "" || typeof c.value !== "string" || typeof c.domain !== "string" || c.domain === "") return null;
	const p = {
		name: c.name,
		value: c.value,
		domain: c.domain,
		path: typeof c.path === "string" && c.path !== "" ? c.path : "/",
		secure: !!c.secure,
		httpOnly: !!c.httpOnly
	};
	if (c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None") p.sameSite = c.sameSite;
	if (!c.session && typeof c.expires === "number" && c.expires > 0) p.expires = c.expires;
	return p;
}
/** First line of DevToolsActivePort is the port number. */
function parseDevToolsActivePort(text) {
	const line = String(text || "").split(/\r?\n/)[0]?.trim();
	const n = Number(line);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}
function resolveEgoStateDir(env = process.env, platform = process.platform) {
	const home = env.HOME || env.USERPROFILE || "";
	if (env.EGO_LINUX_STATE_DIR) return env.EGO_LINUX_STATE_DIR;
	return platform === "win32" ? (env.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${env.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`;
}
async function connectCdp(wsUrl, timeoutMs) {
	const WsImpl = globalThis.WebSocket;
	if (!WsImpl) throw new Error("global WebSocket is unavailable (Node >= 22 required)");
	const ws = new WsImpl(wsUrl);
	await new Promise((resolve$1, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`CDP websocket open timed out: ${wsUrl}`)), timeoutMs);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve$1();
		}, { once: true });
		ws.addEventListener("error", () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error(`CDP websocket connect failed: ${wsUrl}`));
		}, { once: true });
	});
	return {
		client: new CdpClient(ws),
		close: () => {
			try {
				ws.close();
			} catch {}
		}
	};
}
async function browserWsUrl(port, retries = 2) {
	for (let attempt = 0;; attempt++) try {
		const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3e3) });
		if (!r.ok) throw new Error(`/json/version HTTP ${r.status} on port ${port}`);
		const j$1 = await r.json();
		if (!j$1.webSocketDebuggerUrl) throw new Error("browser did not expose webSocketDebuggerUrl");
		return j$1.webSocketDebuggerUrl;
	} catch (err) {
		const nm = err?.name;
		const timedOut = nm === "TimeoutError" || nm === "AbortError";
		const refused = err instanceof TypeError;
		if ((timedOut || refused) && attempt < retries) {
			await sleep(500);
			continue;
		}
		if (timedOut) throw new Error(`/json/version on port ${port} timed out after ${retries + 1} attempts`);
		if (refused) throw new Error(`DevTools HTTP endpoint unreachable on port ${port} after ${retries + 1} attempts (connection refused — the browser may have exited right after publishing the port)`);
		throw err;
	}
}
function sleep(ms) {
	return new Promise((resolve$1) => setTimeout(resolve$1, ms));
}
/**
* Is the source browser currently running ON THE TARGET PROFILE? For a real
* source (default profile) that means instances WITHOUT --user-data-dir; for
* an override/synthetic profile it means instances whose command line names
* THAT directory. Only main processes count (renderer/GPU helpers carry
* --type= and follow the main process).
*/
async function sourceBrowserPids(browserExe, userDataDir = null, platform = process.platform) {
	const exeBase = basename(browserExe);
	try {
		if (platform === "win32") {
			const filter = userDataDir ? `$_.CommandLine -match [regex]::Escape('--user-data-dir=${userDataDir}') -or $_.CommandLine -match [regex]::Escape('--user-data-dir="${userDataDir}"')` : `$_.CommandLine -notmatch '--user-data-dir='`;
			const ps = [
				`Get-CimInstance Win32_Process -Filter "Name='${exeBase}'"`,
				`| Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' -and (${filter}) }`,
				`| Select-Object -ExpandProperty ProcessId`
			].join(" ");
			const { stdout: stdout$1 } = await execFile$1("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(ps, "utf16le").toString("base64")
			], { timeout: 1e4 });
			return String(stdout$1).split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
		}
		const { stdout } = await execFile$1("pgrep", ["-x", exeBase.replace(/\.exe$/, "")], { timeout: 1e4 }).catch(() => ({ stdout: "" }));
		return String(stdout).split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
	} catch {
		return [];
	}
}
/**
* Gracefully close the source browser on its default profile: WM_CLOSE to the
* main process(es) (helpers follow on their own), then wait for exit.
* The ego agent browser (different --user-data-dir) is never touched.
*/
async function closeSourceBrowser(browserExe, platform = process.platform) {
	try {
		const pids = await sourceBrowserPids(browserExe, null, platform);
		if (pids.length === 0) return true;
		if (platform === "win32") for (const pid of pids) await execFile$1("taskkill", ["/PID", String(pid)], { timeout: 8e3 }).catch(() => null);
		else for (const pid of pids) try {
			process.kill(pid, "SIGTERM");
		} catch {}
		const deadline = Date.now() + 15e3;
		while (Date.now() < deadline) {
			if ((await sourceBrowserPids(browserExe, null, platform)).length === 0) return true;
			await sleep(500);
		}
		return false;
	} catch {
		return false;
	}
}
/** Count v10/v20 encrypted-value markers in a cookie DB (0 = wiped/plain). */
function countEncryptionMarkers(buf) {
	const s = typeof buf === "string" ? buf : buf.toString("latin1");
	let n = 0;
	for (let i = 0; i < s.length - 3; i++) {
		const t = s.slice(i, i + 3);
		if (t === "v10" || t === "v20") n++;
	}
	return n;
}
/** Best-effort snapshot of the cookie store before we boot the profile. */
async function backupCookieStore(profileDir, backupRoot) {
	const src = join(profileDir, "Network", "Cookies");
	if (!existsSync(src)) return null;
	try {
		const dir = join(backupRoot, `backup-${Date.now()}`);
		await mkdir(dir, { recursive: true });
		const { copyFile: copyFile$1, readdir: readdir$1 } = await import("node:fs/promises");
		await copyFile$1(src, join(dir, "Cookies"));
		try {
			await copyFile$1(src + "-journal", join(dir, "Cookies-journal"));
		} catch {}
		const markers = countEncryptionMarkers(await readFile(src));
		try {
			const entries = (await readdir$1(backupRoot)).filter((e) => e.startsWith("backup-")).sort();
			for (const old of entries.slice(0, Math.max(0, entries.length - 3))) await rm(join(backupRoot, old), {
				recursive: true,
				force: true
			}).catch(() => null);
		} catch {}
		return {
			dir,
			markers
		};
	} catch {
		return null;
	}
}
/** If the store lost its encrypted rows during our session, restore the backup. */
async function restoreIfWiped(profileDir, backup) {
	if (!backup || backup.markers === 0) return false;
	const src = join(profileDir, "Network", "Cookies");
	try {
		if (countEncryptionMarkers(await readFile(src)) > 0) return false;
		const { copyFile: copyFile$1 } = await import("node:fs/promises");
		await copyFile$1(join(backup.dir, "Cookies"), src);
		try {
			await copyFile$1(join(backup.dir, "Cookies-journal"), src + "-journal");
		} catch {}
		return true;
	} catch {
		return false;
	}
}
const BATCH = 200;
async function importLoginCookies(opts, deps) {
	const timeoutMs = opts.timeoutMs ?? 2e4;
	let browser;
	if (opts.browserOverride) browser = opts.browserOverride;
	else {
		const browsers = detectSystemBrowsers();
		if (browsers.length === 0) return {
			ok: false,
			error: "no system Chromium browser found (looked for Chrome/Edge/Brave profile + binary)"
		};
		const wanted = !opts.source || opts.source === "auto" ? null : opts.source;
		browser = wanted ? browsers.find((b) => b.id === wanted) : browsers[0];
		if (!browser) return {
			ok: false,
			error: `source "${wanted}" not found on this machine; detected: ${browsers.map((b) => b.id).join(", ")}`
		};
	}
	let profile$1;
	try {
		const profiles = profilesFromLocalState(await readFile(join(browser.userDataDir, "Local State"), "utf8"), browser.userDataDir);
		profile$1 = (opts.profile ? profiles.find((p) => p.dirName === opts.profile || p.name === opts.profile) : void 0) || profiles[0];
		if (opts.profile && !profiles.some((p) => p.dirName === profile$1.dirName)) return {
			ok: false,
			error: `profile "${opts.profile}" not found in ${browser.label}; available: ${profiles.map((p) => p.dirName).join(", ")}`
		};
	} catch (err) {
		return {
			ok: false,
			error: `cannot read ${browser.label} Local State: ${err?.message || err}`
		};
	}
	let closedSource = false;
	let srcHandle = null;
	let exited = null;
	let tempCdp = null;
	let egoCdp = null;
	let linkDir = null;
	let backup = null;
	let pendingReport = null;
	try {
		if ((await sourceBrowserPids(browser.exePath, opts.browserOverride ? browser.userDataDir : null)).length > 0) {
			if (opts.browserOverride) return {
				ok: false,
				error: "an instance is already running on the override profile — close it and retry"
			};
			if (!opts.closeSource) return {
				ok: false,
				error: `${browser.label} is running — fully quit it (check the system tray) and retry, or call with closeSource=true to let the tool close it gracefully for you (windows restore on next launch)`
			};
			if (!await closeSourceBrowser(browser.exePath)) return {
				ok: false,
				error: `failed to close ${browser.label} automatically — quit it manually and retry`
			};
			closedSource = true;
		}
		backup = await backupCookieStore(profile$1.dir, join(opts.stateDir || resolveEgoStateDir(), "login-import-backups"));
		linkDir = join(tmpdir(), `ego-login-import-${process.pid}-${Date.now()}`);
		await symlink(browser.userDataDir, linkDir, process.platform === "win32" ? "junction" : "dir");
		if (process.platform === "win32") {
			const ps = [
				`Get-CimInstance Win32_Process -Filter "Name='${basename(browser.exePath)}'"`,
				`| Where-Object { $_.CommandLine -match 'ego-login-import-' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' }`,
				`| Select-Object -ExpandProperty ProcessId`
			].join(" ");
			const drainDeadline = Date.now() + 12e3;
			let leftover = [];
			while (Date.now() < drainDeadline) {
				try {
					const { stdout } = await execFile$1("powershell.exe", [
						"-NoProfile",
						"-NonInteractive",
						"-EncodedCommand",
						Buffer.from(ps, "utf16le").toString("base64")
					], { timeout: 8e3 });
					leftover = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
					if (leftover.length === 0) break;
				} catch {
					break;
				}
				await sleep(600);
			}
			if (leftover.length > 0) {
				for (const line of leftover) {
					const pid = Number(line);
					if (Number.isInteger(pid) && pid > 0) await execFile$1("taskkill", [
						"/PID",
						String(pid),
						"/F"
					], { timeout: 5e3 }).catch(() => null);
				}
				await sleep(1500);
			}
		}
		let port = null;
		for (let attempt = 0; attempt < 2 && port === null && exited === null; attempt++) {
			if (attempt > 0) {
				await sleep(6e3);
				try {
					await rm(linkDir, { force: true });
				} catch {}
				linkDir = join(tmpdir(), `ego-login-import-${process.pid}-${Date.now()}-r1`);
				await symlink(browser.userDataDir, linkDir, process.platform === "win32" ? "junction" : "dir");
			}
			const portFile = join(linkDir, "DevToolsActivePort");
			await rm(portFile, { force: true }).catch(() => null);
			srcHandle = deps.subprocess.spawn({
				argv: [
					browser.exePath,
					"--headless=new",
					`--user-data-dir=${linkDir}`,
					`--profile-directory=${profile$1.dirName}`,
					"--remote-debugging-port=0",
					"--no-first-run",
					"--no-default-browser-check",
					"--disable-background-networking",
					"--disable-sync",
					"--hide-crash-restore-bubble",
					"about:blank"
				],
				cwd: browser.userDataDir,
				env: { ...process.env },
				stdio: {
					stdin: { data: "" },
					stdout: { maxBytes: 2048 },
					stderr: { maxBytes: 4096 }
				},
				graceMs: 8e3
			});
			srcHandle.done.catch(() => null);
			exited = null;
			srcHandle.done.then((r) => {
				exited = r;
			}, () => {
				exited = {
					exitCode: null,
					signal: null
				};
			});
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline && port === null) {
				if (exited !== null) break;
				try {
					port = parseDevToolsActivePort(await readFile(portFile, "utf8"));
					if (port !== null) break;
				} catch {}
				await sleep(250);
			}
		}
		const earlyExit = exited;
		if (port === null && earlyExit !== null) {
			let tail = "";
			try {
				tail = srcHandle?.collected?.stderr?.readFrom(0).text ?? "";
			} catch {}
			tail = tail.slice(-500);
			return {
				ok: false,
				closedSource,
				error: `${browser.label} headless instance exited early (code=${earlyExit.exitCode ?? "null"}, signal=${earlyExit.signal ?? "none"})${tail ? `: ${tail}` : ""} — a lingering background instance may have swallowed the throwaway debug port`
			};
		}
		if (port === null) return {
			ok: false,
			closedSource,
			error: `${browser.label} headless instance did not expose a DevTools port within ${timeoutMs}ms (another instance may be holding the profile)`
		};
		tempCdp = await connectCdp(await browserWsUrl(port), 5e3);
		let all = [];
		for (let attempt = 0; attempt < 8; attempt++) {
			const got = await tempCdp.client.call("Storage.getCookies");
			all = Array.isArray(got.cookies) ? got.cookies : [];
			if (all.length > 0 || attempt === 7) break;
			await sleep(800);
		}
		const matched = all.filter((c) => cookieMatchesDomains(c.domain, opts.domains || []));
		const byDomain = /* @__PURE__ */ new Map();
		for (const c of matched) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1);
		const domainStats = [...byDomain.entries()].map(([domain, cookies]) => ({
			domain,
			cookies
		})).sort((a, b) => b.cookies - a.cookies);
		if (opts.dryRun) {
			pendingReport = {
				ok: true,
				source: browser.label,
				profile: profile$1.dirName,
				dryRun: true,
				closedSource,
				totalRead: all.length,
				matched: matched.length,
				written: 0,
				domains: domainStats
			};
			return pendingReport;
		}
		const stateDir = opts.stateDir || resolveEgoStateDir();
		let egoPort;
		try {
			const bj = JSON.parse(await readFile(join(stateDir, "browser.json"), "utf8"));
			if (typeof bj.port !== "number" || bj.port <= 0) throw new Error("no port in browser.json");
			egoPort = bj.port;
		} catch {
			return {
				ok: false,
				closedSource,
				error: "agent browser is not running (no browser.json) — call ego_status or any ego_* tool first, then retry the import"
			};
		}
		egoCdp = await connectCdp(await browserWsUrl(egoPort), 5e3);
		const params = matched.map(toCookieParam).filter((p) => p !== null);
		let written = 0;
		for (let i = 0; i < params.length; i += BATCH) {
			await egoCdp.client.call("Storage.setCookies", { cookies: params.slice(i, i + BATCH) });
			written += Math.min(BATCH, params.length - i);
		}
		pendingReport = {
			ok: true,
			source: browser.label,
			profile: profile$1.dirName,
			dryRun: false,
			closedSource,
			totalRead: all.length,
			matched: matched.length,
			written,
			domains: domainStats
		};
		return pendingReport;
	} catch (err) {
		return {
			ok: false,
			error: String(err?.message || err)
		};
	} finally {
		try {
			tempCdp?.close();
		} catch {}
		try {
			egoCdp?.close();
		} catch {}
		if (tempCdp) try {
			await tempCdp.client.call("Browser.close", {}, void 0, 2e3);
		} catch {}
		if (srcHandle) {
			try {
				await Promise.race([srcHandle.done, sleep(25e3)]);
			} catch {}
			if (process.platform === "win32" && linkDir) try {
				const ps = [
					`Get-CimInstance Win32_Process -Filter "Name='${basename(browser.exePath)}'"`,
					`| Where-Object { $_.CommandLine -match 'ego-login-import-' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' }`,
					`| Select-Object -ExpandProperty ProcessId`
				].join(" ");
				const { stdout } = await execFile$1("powershell.exe", [
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					Buffer.from(ps, "utf16le").toString("base64")
				], { timeout: 8e3 });
				for (const line of String(stdout).split(/\r?\n/)) {
					const pid = Number(line.trim());
					if (Number.isInteger(pid) && pid > 0) await execFile$1("taskkill", [
						"/PID",
						String(pid),
						"/F"
					], { timeout: 5e3 }).catch(() => null);
				}
				if (String(stdout).trim()) await Promise.race([srcHandle.done, sleep(5e3)]);
			} catch {}
		}
		if (linkDir) try {
			await rm(linkDir, { force: true });
		} catch {}
		if (await restoreIfWiped(profile$1.dir, backup)) {
			if (pendingReport) pendingReport.restoredFromBackup = true;
		}
	}
}

//#endregion
//#region src/cdp/endpoint.ts
/**
* src/cdp/endpoint.ts — M0.1: CDP endpoint resolution.
*
* One job: turn whatever the user typed into a `ws://` URL a session can dial,
* and NEVER guess. `http(s)://host:port` goes through `GET /json/version` →
* `webSocketDebuggerUrl` (dial-direct for `ws(s)://…`). Every failure path
* returns a structured code, because a typo must not degrade into an opaque
* network error three layers down.
*
* Acceptance (decomposition.md `M0.1`): only `ws` leaves this module; timeout
* and illegal scheme each carry their own code. Pure apart from the injectable
* `fetchVersion` — fixtures use fixed data and never touch a real clock or
* network, and the error codes are contract (the client maps them to i18n), so
* they are not renamed casually.
*/
const ENDPOINT_SCHEMES = [
	"http",
	"https",
	"ws",
	"wss"
];
const DEFAULT_DISCOVERY_TIMEOUT_MS = 3e3;
/**
* Validate + normalize a user-supplied endpoint string.
*
* Accepts `http(s)://host[:port]` (needs `/json/version` discovery) and
* `ws(s)://…` (dial-direct). Anything else, including a bare `host:port`, is
* rejected with an explicit code — guessing a scheme here would turn a typo
* into a confusing network-level failure later.
*/
function normalizeEndpoint(raw) {
	if (typeof raw !== "string") return {
		ok: false,
		code: "invalid-endpoint",
		message: "endpoint must be a string"
	};
	const trimmed$1 = raw.trim();
	if (trimmed$1 === "") return {
		ok: false,
		code: "empty-endpoint",
		message: "endpoint is empty"
	};
	let url;
	try {
		url = new URL(trimmed$1);
	} catch {
		return {
			ok: false,
			code: "invalid-endpoint",
			message: `endpoint is not a valid URL: ${trimmed$1}`
		};
	}
	const scheme = url.protocol.replace(/:$/, "");
	if (!ENDPOINT_SCHEMES.includes(scheme)) return {
		ok: false,
		code: "invalid-scheme",
		message: `endpoint scheme must be http, https, ws or wss (got "${url.protocol}")`
	};
	if (url.hostname === "") return {
		ok: false,
		code: "invalid-endpoint",
		message: `endpoint has no host: ${trimmed$1}`
	};
	return {
		ok: true,
		endpoint: url.origin + url.pathname.replace(/\/+$/, ""),
		scheme
	};
}
/**
* Resolve an endpoint to a `ws://` URL.
*
* `ws(s)://` is returned unchanged (already a dial target, so there is nothing
* to discover and a wrong guess is impossible). `http(s)://` is probed over
* `/json/version`; the discovered uuid changes every time the remote browser
* restarts, so callers persist the value the user typed, never this.
*/
async function discoverWebSocketUrl(raw, options = {}) {
	const now = options.now ?? (() => Date.now());
	const started = now();
	const elapsed = () => Math.max(0, now() - started);
	const check = normalizeEndpoint(raw);
	if (!check.ok) return {
		ok: false,
		code: check.code,
		message: check.message,
		latencyMs: 0
	};
	if (check.scheme === "ws" || check.scheme === "wss") return {
		ok: true,
		endpoint: check.endpoint,
		scheme: check.scheme,
		wsUrl: check.endpoint,
		browser: "",
		protocolVersion: "",
		latencyMs: 0
	};
	const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS;
	const target = `${check.endpoint}/json/version`;
	const signal = AbortSignal.timeout(timeoutMs);
	try {
		const response = await (options.fetchVersion ?? ((url, init) => fetch(url, { signal: init.signal })))(target, { signal });
		if (!response.ok) return {
			ok: false,
			code: "http-status",
			message: `${target} answered HTTP ${response.status}`,
			latencyMs: elapsed()
		};
		let payload;
		try {
			payload = await response.json();
		} catch {
			return {
				ok: false,
				code: "bad-json",
				message: `${target} did not return JSON`,
				latencyMs: elapsed()
			};
		}
		const wsUrl = typeof payload.webSocketDebuggerUrl === "string" ? payload.webSocketDebuggerUrl : "";
		if (wsUrl === "") return {
			ok: false,
			code: "no-ws-url",
			message: `${target} did not return a webSocketDebuggerUrl (not a DevTools endpoint?)`,
			latencyMs: elapsed()
		};
		return {
			ok: true,
			endpoint: check.endpoint,
			scheme: check.scheme,
			wsUrl,
			browser: typeof payload.Browser === "string" ? payload.Browser : "",
			protocolVersion: typeof payload["Protocol-Version"] === "string" ? payload["Protocol-Version"] : "",
			latencyMs: elapsed()
		};
	} catch (error) {
		const err = error;
		const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
		return {
			ok: false,
			code: timedOut ? "probe-timeout" : "probe-failed",
			message: timedOut ? `no answer from ${target} within ${timeoutMs}ms` : `endpoint unreachable: ${err?.message ?? String(error)}`,
			latencyMs: elapsed()
		};
	}
}

//#endregion
//#region src/cdp/capabilities.ts
/**
* Recognize the engine from `/json/version`'s `Browser` field
* (`"Lightpanda/0.4.1"`, `"Chrome/153.0.0.0"`, `"Edg/153.0.0.0"`, …).
* Empty or unrecognized → `'unknown'` (never guesses).
*/
function engineOf(browserField) {
	const value = typeof browserField === "string" ? browserField.trim() : "";
	if (value === "") return "unknown";
	if (value.startsWith("Lightpanda/")) return "lightpanda";
	if (value.startsWith("Chrome/") || value.startsWith("Chromium")) return "chrome";
	if (value.startsWith("Edg/") || value.startsWith("Microsoft Edge ")) return "chrome";
	return "unknown";
}
const FULL = {
	engine: "chrome",
	screencast: true,
	overlay: true,
	bindingCalled: true,
	imageFormat: "jpeg",
	loadEvent: true,
	downloadEvents: true,
	browserClose: true
};
/**
* The capability projection per engine. `chrome` / `unknown` → full
* capabilities (bit-for-bit today's behavior); `lightpanda` → the analysis
* (docs/plans/2026-10-04-lightpanda-backend-analysis.md §7) projection.
*/
function capabilitiesFor(engine) {
	if (engine === "lightpanda") return {
		engine: "lightpanda",
		screencast: false,
		overlay: false,
		bindingCalled: false,
		imageFormat: "png",
		loadEvent: false,
		downloadEvents: false,
		browserClose: false
	};
	return {
		...FULL,
		engine
	};
}
/**
* Env key the host half sets when spawning the cast / render workers
* (mirrors `EGO_LINUX_CDP_URL`'s injection pattern in cast-server). The child
* processes cannot see the host's attach cache, so the projected engine id
* travels as data — the host decides once, children only read.
*/
const BCDP_CDP_ENGINE = "BCDP_CDP_ENGINE";

//#endregion
//#region src/cdp/cli-link.ts
/** Upstream's own macOS location for the real CLI (verbatim, from its e2e runner). */
const MACOS_APP_BUNDLE_CLI = "/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser";
/** The sentinel the readiness heredoc prints; its absence means "not usable". */
const CLI_READY_SENTINEL = "__BCDP_CLI_READY__";
/** How long the opportunistic `--status` fast path may take before we ignore it. */
const CLI_STATUS_TIMEOUT_MS = 2e3;
/**
* Build a PATH lookup that honours Windows' PATHEXT.
*
* The separator and the list delimiter follow the SIMULATED platform, not the
* running one: `node:path`'s `join`/`delimiter` are host-dependent, so a
* darwin/linux lookup running on Windows would otherwise build
* `dir\ego-browser` and find nothing.
*/
function makeWhich(platform, env, exists) {
	const isWin = platform === "win32";
	const sep$1 = isWin ? "\\" : "/";
	const dirs = (env.PATH ?? "").split(isWin ? ";" : ":").filter((dir) => dir !== "");
	const exts = isWin ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "") : [""];
	const joinFor = (dir, file) => `${dir.replace(/[\\/]+$/, "")}${sep$1}${file}`;
	return (name$1) => {
		if (name$1 === "") return "";
		for (const dir of dirs) for (const ext of exts) {
			const candidate = joinFor(dir, name$1 + ext);
			if (exists(candidate)) return candidate;
		}
		return "";
	};
}
/**
* Resolve the CLI to launch. An explicit path that does not exist is an ERROR
* rather than a silent skip to the next candidate — silently driving a
* different browser than the one the user named would be worse than failing.
*/
function resolveCliBinary(input, io) {
	const explicit = (input.cliPath ?? "").trim();
	if (explicit !== "") {
		if (io.exists(explicit)) return {
			ok: true,
			path: explicit,
			origin: "explicit",
			code: "",
			message: ""
		};
		return {
			ok: false,
			path: explicit,
			origin: "",
			code: "cli-not-found",
			message: `the configured CLI path does not exist: ${explicit}`
		};
	}
	const onPath = io.which("ego-browser");
	if (onPath !== "") return {
		ok: true,
		path: onPath,
		origin: "path",
		code: "",
		message: ""
	};
	if (io.platform === "darwin" && io.exists(MACOS_APP_BUNDLE_CLI)) return {
		ok: true,
		path: MACOS_APP_BUNDLE_CLI,
		origin: "app-bundle",
		code: "",
		message: ""
	};
	if (input.bundled !== "" && io.exists(input.bundled)) return {
		ok: true,
		path: input.bundled,
		origin: "bundled",
		code: "",
		message: ""
	};
	return {
		ok: false,
		path: "",
		origin: "",
		code: "cli-not-found",
		message: "no ego CLI found: put `ego-browser` on PATH (ego lite onboarding does this), set cliPath, or keep the bundled runtime in place"
	};
}
/** File-extension hint for the FIRST spawn attempt. Never the final word. */
function preferredShape(cliPath) {
	return /\.(mjs|cjs|js)$/i.test(cliPath) ? "node" : "direct";
}
/** argv for one shape. `rest` is appended after the shape's own prefix. */
function spawnArgvFor(shape, cliPath, rest) {
	return shape === "node" ? [
		process.execPath,
		cliPath,
		...rest
	] : [cliPath, ...rest];
}
/** A spawn failure that means "this shape is wrong", not "the CLI is broken". */
function isShapeClassSpawnError(code) {
	return code === "EACCES" || code === "ENOEXEC" || code === "ENOENT";
}
const DEFAULT_PROBE_TIMEOUT_MS = 2e4;
function looksLikeUnknownSdkFlag(text) {
	return /unknown option.*sdk-path|unrecognized option.*sdk-path|invalid option.*sdk-path/i.test(text);
}
/** Parse `--status` output. Loose on purpose: only the boolean `running` matters. */
function parseCliStatus(stdout) {
	const text = stdout.trim();
	if (text === "" || text[0] !== "{") return { ok: false };
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed.running !== "boolean") return { ok: false };
		return {
			ok: true,
			running: parsed.running
		};
	} catch {
		return { ok: false };
	}
}
/**
* R4 — the ego CLI may route the embedded runtime's output to either stream.
* 0.6.0.16 on Windows sends everything (console.log, process.stdout.write and
* our sentinels) to stderr and leaves stdout empty, so every sentinel/facade
* reader must look at both. stdout goes first: when a CLI writes to both, the
* authoritative payload stays where it always was.
* @internal exported for tests
*/
function mergeCliOutput(result) {
	if (result.stdout === "") return result.stderr;
	if (result.stderr === "") return result.stdout;
	return `${result.stdout}\n${result.stderr}`;
}
/**
* Probe one link end to end: resolve → pick a working shape → (optionally)
* read `--status` → confirm with a real heredoc round-trip.
*
* Failure codes are disjoint so the caller can print something actionable:
*  - `cli-not-found`      nothing to launch
*  - `cli-not-executable` both shapes refused to start it
*  - `cli-probe-timeout`  the heredoc probe ran out of time
*  - `cli-probe-failed`   it ran but did not reach our sentinel
*/
async function probeCliLink(input, io) {
	const started = io.now();
	const resolve$1 = resolveCliBinary(input, io);
	if (!resolve$1.ok) return {
		ok: false,
		code: "cli-not-found",
		message: resolve$1.message,
		cliPath: resolve$1.path,
		origin: "",
		shape: "",
		latencyMs: 0
	};
	const cliPath = resolve$1.path;
	const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
	const order = preferredShape(cliPath) === "node" ? ["node", "direct"] : ["direct", "node"];
	let shape = "";
	let lastShapeMessage = "";
	let statusRun;
	for (const candidate of order) {
		const attempt = await io.run({
			argv: spawnArgvFor(candidate, cliPath, ["--status"]),
			stdin: "",
			timeoutMs: CLI_STATUS_TIMEOUT_MS
		});
		if (attempt.spawnErrorCode === void 0 || !isShapeClassSpawnError(attempt.spawnErrorCode)) {
			shape = candidate;
			statusRun = attempt;
			break;
		}
		lastShapeMessage = `${candidate} spawn failed: ${attempt.spawnErrorCode}`;
	}
	if (shape === "") return {
		ok: false,
		code: "cli-not-executable",
		message: `the ego CLI at ${cliPath} could not be started in either form (${lastShapeMessage})`,
		cliPath,
		origin: resolve$1.origin,
		shape: "",
		latencyMs: Math.max(0, io.now() - started)
	};
	let running;
	if (statusRun && statusRun.exitCode === 0 && !statusRun.timedOut) {
		const parsed = parseCliStatus(mergeCliOutput(statusRun));
		if (parsed.ok) running = parsed.running;
	}
	if (input.coldStart === false && running !== true) return {
		ok: true,
		code: "",
		message: "",
		cliPath,
		origin: resolve$1.origin,
		shape,
		heredocSkipped: true,
		...running === void 0 ? {} : { running },
		latencyMs: Math.max(0, io.now() - started)
	};
	const sdkArgs = input.useSdkPath === true && (input.sdkPath ?? "") !== "" ? ["--sdk-path", input.sdkPath] : [];
	const script = `console.log(${JSON.stringify(CLI_READY_SENTINEL)}, typeof taskSpaces, typeof browser)\n`;
	const runHeredoc = (extra) => io.run({
		argv: spawnArgvFor(shape, cliPath, ["nodejs", ...extra]),
		stdin: script,
		timeoutMs
	});
	let warning;
	let result = await runHeredoc(sdkArgs);
	if (sdkArgs.length > 0 && looksLikeUnknownSdkFlag(result.stdout + result.stderr)) {
		warning = "this ego CLI does not support --sdk-path; retried with the CLI's own harness";
		result = await runHeredoc([]);
	}
	const latencyMs = Math.max(0, io.now() - started);
	const base = {
		cliPath,
		origin: resolve$1.origin,
		shape,
		latencyMs,
		...warning ? { warning } : {},
		...running === void 0 ? {} : { running }
	};
	if (result.timedOut) return {
		ok: false,
		code: "cli-probe-timeout",
		message: `the ego CLI did not answer within ${timeoutMs}ms`,
		...base
	};
	if (result.spawnErrorCode !== void 0) return {
		ok: false,
		code: "cli-not-executable",
		message: `spawn failed: ${result.spawnErrorCode}`,
		...base
	};
	const facadeMatch = (/* @__PURE__ */ new RegExp(`${CLI_READY_SENTINEL} (\\w+) (\\w+)`)).exec(mergeCliOutput(result));
	const facadesOk = input.useSdkPath !== true || facadeMatch?.[1] === "object" && facadeMatch?.[2] === "object";
	if (result.exitCode !== 0 || !mergeCliOutput(result).includes(CLI_READY_SENTINEL) || !facadesOk) {
		const tail = (result.stderr || result.stdout).trim().slice(-400);
		const facadeNote = facadesOk ? "" : `; the SDK harness did not expose the facade (taskSpaces=${facadeMatch?.[1] ?? "undefined"}, browser=${facadeMatch?.[2] ?? "undefined"})`;
		return {
			ok: false,
			code: "cli-probe-failed",
			message: `the ego CLI ran but did not reach the readiness sentinel (exit ${String(result.exitCode)})${facadeNote}${tail ? `: ${tail}` : ""}`,
			...base
		};
	}
	return {
		ok: true,
		code: "",
		message: "",
		...base
	};
}
function readAll$2(reader) {
	if (!reader) return "";
	try {
		return reader.readFrom(0).text;
	} catch {
		return "";
	}
}
/**
* The production `CliLinkIo`: PATH lookup + `existsSync` here, process spawn
* through the host's subprocess service.
*/
function createSubprocessCliIo(subprocess) {
	return {
		platform: process.platform,
		exists: (path) => {
			try {
				return existsSync(path);
			} catch {
				return false;
			}
		},
		which: makeWhich(process.platform, process.env, (path) => {
			try {
				return existsSync(path);
			} catch {
				return false;
			}
		}),
		now: () => Date.now(),
		run: async (request$1) => {
			const startedAt = Date.now();
			const spec = {
				argv: [...request$1.argv],
				cwd: process.cwd(),
				stdio: {
					stdin: { data: request$1.stdin },
					stdout: { maxBytes: 64 * 1024 },
					stderr: { maxBytes: 64 * 1024 }
				},
				graceMs: request$1.timeoutMs
			};
			try {
				const handle = subprocess.spawn(spec);
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
				}, request$1.timeoutMs);
				const outcome = await handle.done;
				clearTimeout(timer);
				return {
					exitCode: outcome.exitCode,
					stdout: readAll$2(handle.collected.stdout),
					stderr: readAll$2(handle.collected.stderr),
					...timedOut ? { timedOut: true } : {},
					latencyMs: Date.now() - startedAt
				};
			} catch (err) {
				const code = err?.code;
				return {
					exitCode: null,
					stdout: "",
					stderr: err instanceof Error ? err.message : String(err),
					...typeof code === "string" ? { spawnErrorCode: code } : {},
					latencyMs: Date.now() - startedAt
				};
			}
		}
	};
}

//#endregion
//#region src/cdp-targets.ts
/** Env var the vendored ego runtime reads to attach to an existing browser. */
const EGO_LINUX_CDP_URL = "EGO_LINUX_CDP_URL";
/** Hard ceiling on the sequence length (UI + payload sanity, not semantics). */
const MAX_TARGETS = 32;
/**
* R7 — the local-only link kind. Its VALUE is a discriminator, not an
* identifier: nothing in our surface is named after it (the upstream plugin
* owns `ego_*` tool names, `ego_browser_settings`, `/api/ego/*`, …).
*/
const EGO_CLI_KIND = "ego-cli";
/** Default panel label for an ego-cli link (no endpoint to fall back to). */
const EGO_CLI_LABEL = "本机 ego CLI";
/**
* Lightpanda backend — the managed-serve link kind (headless quick-trial
* engine; headed kinds are the manual-fallback backstop). Local-only
* singleton, same rules as `ego-cli`.
*/
const LP_KIND = "lightpanda";
/** Default panel label for a lightpanda link. */
const LP_LABEL = "Lightpanda（受管）";
/**
* Build a stable target id. `randomUUID` is available on every supported
* host (Node >= 22); the fallback exists only because cheap and steady beats
* clever in a hot path that also runs inside tests.
*/
function newTargetId() {
	const cryptoObj = globalThis.crypto;
	if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
	return `t-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
/** Coerce one unknown-shaped sequence entry into a `BrowserLink`, or null when unusable. */
function coerceLink(raw) {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw;
	const base = {
		id: typeof rec.id === "string" && rec.id.trim() !== "" ? rec.id.trim() : newTargetId(),
		enabled: rec.enabled === void 0 ? true : Boolean(rec.enabled),
		note: typeof rec.note === "string" ? rec.note : ""
	};
	const label = typeof rec.label === "string" ? rec.label.trim() : "";
	if (rec.kind === EGO_CLI_KIND) {
		const cliPath = typeof rec.cliPath === "string" ? rec.cliPath.trim() : "";
		return {
			...base,
			kind: EGO_CLI_KIND,
			label: label === "" ? EGO_CLI_LABEL : label,
			cliPath,
			useSdkPath: true
		};
	}
	if (rec.kind === LP_KIND) {
		const servePath = typeof rec.servePath === "string" ? rec.servePath.trim() : "";
		return {
			...base,
			kind: LP_KIND,
			label: label === "" ? LP_LABEL : label,
			servePath
		};
	}
	const endpoint = normalizeEndpoint(rec.endpoint);
	if (!endpoint.ok) return null;
	return {
		...base,
		kind: "cdp",
		label: label === "" ? endpoint.endpoint : label,
		endpoint: endpoint.endpoint
	};
}
/**
* Sanitize the persisted sequence. Dirty data is expected here (a hand-edited
* profile config on the settings page, older schema, unknown keys) so the rule
* is DROP, never throw: every surviving entry is usable, duplicate ids get
* fresh ones so ordering/activation stay unambiguous, and the `ego-cli` /
* `lightpanda` singletons keep the FIRST entry of their kind (dropping the
* rest and counting them for the doctor).
*/
function sanitizeLinks(raw, max = MAX_TARGETS) {
	if (!Array.isArray(raw)) return {
		links: [],
		droppedEgoCli: 0,
		droppedLightpanda: 0,
		droppedInvalid: 0
	};
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	let droppedEgoCli = 0;
	let droppedLightpanda = 0;
	let droppedInvalid = 0;
	let sawEgoCli = false;
	let sawLightpanda = false;
	for (const entry of raw) {
		const link = coerceLink(entry);
		if (!link) {
			droppedInvalid += 1;
			continue;
		}
		if (link.kind === EGO_CLI_KIND) {
			if (sawEgoCli) {
				droppedEgoCli += 1;
				continue;
			}
			sawEgoCli = true;
		}
		if (link.kind === LP_KIND) {
			if (sawLightpanda) {
				droppedLightpanda += 1;
				continue;
			}
			sawLightpanda = true;
		}
		if (seen.has(link.id)) link.id = newTargetId();
		seen.add(link.id);
		out.push(link);
		if (out.length >= max) break;
	}
	return {
		links: out,
		droppedEgoCli,
		droppedLightpanda,
		droppedInvalid
	};
}
function findLink(links, id) {
	if (id === "") return null;
	return links.find((link) => link.id === id) ?? null;
}
/**
* The link that owns routing RIGHT NOW — re-derived on every links event
* (enable/activation toggle, reorder, add, remove).
*
* Activation wins while it is usable. The moment an event leaves
* `activeTargetId` pointing at a disabled or missing entry, the FIRST enabled
* link in sequence order takes over — the sequence order IS the priority
* order. An EMPTY activation stays "nothing activated" (explicit off) instead
* of silently adopting a link the user never activated.
*/
function resolveEffectiveLink(links, activeTargetId) {
	if (activeTargetId === "") return null;
	const activated = findLink(links, activeTargetId);
	if (activated && activated.enabled) return {
		link: activated,
		reason: "activated"
	};
	const fallback = links.find((link) => link.enabled);
	if (!fallback) return null;
	return {
		link: fallback,
		reason: "priority-fallback",
		demotedId: activeTargetId
	};
}
/**
* True when an attach cache row describes THIS link (same id, and for a cdp
* link the same endpoint string). After a links event the async refresh may
* still be probing the new owner; a cache row describing the PREVIOUS owner
* must not leak its linkKind/cliPath/wsUrl into the new channel's decisions —
* that leak is how a deactivated ego-cli kept driving every bcdp_* call.
*/
function attachMatchesLink(attach, link) {
	if (attach.targetId !== link.id) return false;
	return link.kind !== "cdp" || attach.endpoint === link.endpoint;
}
/**
* Resolve one endpoint to a browser websocket URL.
*
* Thin adapter over M0.1's `discoverWebSocketUrl`: the resolution logic lives
* in `src/cdp/endpoint.ts`, while `ProbeOutcome` stays the shape the settings
* page's per-target probe already speaks — its codes are contract, so they are
* mapped one-to-one rather than re-derived here.
*/
async function probeEndpoint(endpoint, options = {}) {
	const result = await discoverWebSocketUrl(endpoint, {
		timeoutMs: options.timeoutMs,
		fetchVersion: options.fetchVersion,
		now: options.now
	});
	if (!result.ok) return {
		ok: false,
		code: result.code,
		message: result.message,
		latencyMs: result.latencyMs
	};
	return {
		ok: true,
		code: "ok",
		message: "",
		wsUrl: result.wsUrl,
		engine: engineOf(result.browser),
		latencyMs: result.latencyMs
	};
}
function emptyAttachState() {
	return {
		status: "idle",
		mode: "auto",
		targetId: "",
		endpoint: "",
		wsUrl: "",
		code: "",
		message: "",
		latencyMs: 0,
		resolvedAt: 0
	};
}
/**
* Decide how the next `bcdp_*` call attaches.
*
* The rules are deliberately narrow and each branch is a VISIBLE outcome:
*
* - `mode=local`  → hand back to local control (explicit user choice).
* - `ego-cli`     → the CLI owns its browser; inject nothing.
* - no activation → error, never a silent local cold start (spec §3.2).
* - resolved      → inject the ws URL.
* - not resolved  → error. The ONLY path to a local browser from here is an
*                   explicit `allowLocalFallback` AND a working launcher.
*/
function decideAttach(input) {
	if (input.mode === "local") return {
		kind: "local",
		message: "local mode: using local browser control"
	};
	if (input.mode === "remote" && (input.linkKind === EGO_CLI_KIND || input.linkKind === LP_KIND)) return {
		kind: "error",
		code: "mode-kind-mismatch",
		message: input.linkKind === LP_KIND ? "cdpMode=remote requires a CDP endpoint link, but the activated link is the local Lightpanda serve. Activate a CDP link, or switch cdpMode to auto." : "cdpMode=remote requires a CDP endpoint link, but the activated link is the local ego CLI. Activate a CDP link, or switch cdpMode to auto."
	};
	if (input.hasActive && input.linkKind === EGO_CLI_KIND) {
		if (input.status === "ready") return {
			kind: "cli",
			message: input.message || "local ego CLI ready"
		};
		if (input.status === "idle" || input.status === "probing") return {
			kind: "error",
			code: "endpoint-unresolved",
			message: "The local ego CLI has not been probed yet. Wait for the probe to finish and retry the call."
		};
		return {
			kind: "error",
			code: input.code === "" ? "cli-probe-failed" : input.code,
			message: input.message === "" ? "the local ego CLI is not available" : input.message
		};
	}
	if (input.hasActive && input.linkKind === LP_KIND) {
		if (input.status === "ready" && input.wsUrl !== "") return {
			kind: "inject",
			wsUrl: input.wsUrl,
			targetId: "",
			source: "remote"
		};
		if (input.status === "idle" || input.status === "probing") return {
			kind: "error",
			code: "endpoint-unresolved",
			message: "The Lightpanda serve has not been probed yet. Wait for the probe to finish and retry the call."
		};
		return {
			kind: "error",
			code: input.code === "" ? "lightpanda-not-ready" : input.code,
			message: input.message === "" ? "the managed Lightpanda serve is not available" : input.message
		};
	}
	if (input.remoteDisabled) return {
		kind: "error",
		code: "remote-disabled",
		message: "Remote CDP is disabled by the remoteEnabled switch (the target sequence is preserved). Flip the switch back on, or set cdpMode=local to use a local browser."
	};
	if (!input.hasActive) return {
		kind: "error",
		code: "no-active-target",
		message: "No activated CDP target. Configure a target sequence and activate one in the dsh-browser-cdp settings panel, or set cdpMode=local to use a local browser explicitly."
	};
	if (input.status === "ready" && input.wsUrl !== "") return {
		kind: "inject",
		wsUrl: input.wsUrl,
		targetId: "",
		source: "remote"
	};
	if (input.status === "idle" || input.status === "probing") return {
		kind: "error",
		code: "endpoint-unresolved",
		message: "Activated CDP endpoint has not been probed yet. Wait for the probe to finish and retry the call."
	};
	const detail = input.message === "" ? input.code || "unreachable" : `${input.code}: ${input.message}`.replace(/^:\s*/, "");
	if (input.allowLocalFallback && !input.localLauncherReady) return {
		kind: "error",
		code: "local-launcher-unavailable",
		message: `Activated CDP endpoint is unreachable (${detail}) and local fallback is enabled, but the built-in local launcher is not available in this build. Fix the endpoint or set cdpMode=local.`
	};
	return {
		kind: "error",
		code: input.mode === "remote" ? "remote-unreachable" : "endpoint-unreachable",
		message: `Activated CDP endpoint is unreachable (${detail}). Not falling back to a local browser. Fix/replace the endpoint, pick another target, or enable allowLocalFallback to make the fallback explicit.`
	};
}
function createAttachCache() {
	let state = emptyAttachState();
	return {
		get: () => state,
		patch: (next) => {
			state = {
				...state,
				...next
			};
			return state;
		},
		reset: () => {
			state = emptyAttachState();
		}
	};
}
/** Process-wide attach cache the host half reads synchronously at spawn time. */
const defaultAttachCache = createAttachCache();
/**
* R7 — publish the readiness of an `ego-cli` link.
*
* There is no endpoint here and nothing is injected: the CLI owns its browser,
* so the only question is whether the CLI itself can be launched and driven.
* A CLI that answers while its backing browser is down still counts as ready —
* the first real call cold-starts the browser, which is normal for this kind —
* and is tagged `cli-launch` so the panel can say so instead of claiming a
* live browser.
*/
async function refreshCliAttach(input, cache, suggested, link, now) {
	const base = {
		...suggested,
		targetId: link.id,
		endpoint: "",
		wsUrl: "",
		linkKind: EGO_CLI_KIND
	};
	const io = input.cliIo;
	if (!io) return cache.patch({
		...base,
		status: "unreachable",
		code: "cli-io-missing",
		message: "the host did not provide CLI IO for the local ego CLI link",
		resolvedAt: now()
	});
	const probe = await probeCliLink({
		cliPath: link.cliPath,
		bundled: input.bundledCli ?? "",
		useSdkPath: link.useSdkPath === true,
		sdkPath: input.sdkPath ?? "",
		timeoutMs: input.timeoutMs,
		coldStart: input.cliProbeColdStart
	}, io);
	if (!probe.ok) return cache.patch({
		...base,
		status: "unreachable",
		code: probe.code,
		message: probe.message,
		cliPath: probe.cliPath,
		cliShape: probe.shape,
		latencyMs: probe.latencyMs,
		resolvedAt: now()
	});
	const coldStart = probe.running === false;
	return cache.patch({
		...base,
		status: "ready",
		endpointSource: coldStart ? "cli-launch" : "cli",
		code: "",
		message: probe.warning ?? (coldStart ? "local ego CLI reachable; the backing browser is not running yet and will start on the first call" : probe.heredocSkipped === true ? "local ego CLI ready; heredoc probe skipped (allowProbeColdStart off) — the SDK harness check runs with the first call" : "local ego CLI ready"),
		cliPath: probe.cliPath,
		cliShape: probe.shape,
		sdkPath: link.useSdkPath === true && probe.warning === void 0 ? input.sdkPath ?? "" : "",
		latencyMs: probe.latencyMs,
		resolvedAt: now()
	});
}
/**
* Lightpanda backend — ensure the managed serve for an activated `lightpanda`
* row, then probe its endpoint. The launcher owns launch/reuse/exclusivity
* (a live managed Chrome loses the singleton slot to the serve and vice
* versa); `engine` is stamped from the ROW — the source the user picked — and
* `/json/version`'s `Browser: Lightpanda/…` merely re-confirms it.
*/
async function refreshLightpandaAttach(input, cache, suggested, link, now) {
	const base = {
		...suggested,
		targetId: link.id,
		endpoint: "",
		wsUrl: "",
		linkKind: LP_KIND
	};
	const launch = await launchLocalBrowser({
		engine: "lightpanda",
		lightpandaPath: link.servePath ?? "",
		lightpandaArgs: input.lightpandaArgs
	}, input.launcherIo);
	if (!launch.ok) return cache.patch({
		...base,
		status: "unreachable",
		code: launch.code,
		message: launch.message,
		resolvedAt: now()
	});
	const probe = await probeEndpoint(launch.endpoint, {
		timeoutMs: input.timeoutMs,
		now
	});
	return cache.patch({
		...base,
		status: probe.ok && probe.wsUrl ? "ready" : "unreachable",
		endpoint: launch.endpoint,
		wsUrl: probe.wsUrl ?? "",
		engine: "lightpanda",
		code: probe.ok ? "" : probe.code,
		message: probe.ok ? launch.reused ? "lightpanda serve reused" : "lightpanda serve launched" : `lightpanda serve is up but its endpoint did not answer: ${probe.message}`,
		latencyMs: probe.latencyMs,
		resolvedAt: now(),
		endpointSource: launch.reused ? "local" : "local-launch"
	});
}
/**
* Re-probe the activated target and publish the outcome into the cache.
*
* `local` mode short-circuits: there is nothing to probe and nothing to write,
* which is exactly why switching to `local` must also invalidate any previously
* injected remote (callers see a fresh state, not a stale one).
*/
async function refreshAttach(input) {
	const cache = input.cache ?? defaultAttachCache;
	const now = input.now ?? (() => Date.now());
	const previous = cache.get();
	const suggested = {
		...emptyAttachState(),
		mode: input.mode,
		status: input.mode === "local" ? "local" : "idle",
		linkKind: void 0,
		cliPath: void 0,
		cliShape: void 0,
		sdkPath: "",
		endpointSource: void 0,
		engine: void 0
	};
	if (input.mode === "local") {
		suggested.targetId = "";
		suggested.endpoint = "";
		suggested.resolvedAt = now();
		if (input.useLauncher) {
			const launch = await launchLocalBrowser({
				chromePath: input.fallback?.chromePath,
				chromeArgs: input.fallback?.chromeArgs,
				localHeadless: input.fallback?.localHeadless,
				userDataDir: input.fallback?.userDataDir
			}, input.launcherIo);
			if (launch.ok) {
				const localProbe = await probeEndpoint(launch.endpoint, {
					timeoutMs: input.timeoutMs,
					now
				});
				if (localProbe.ok && localProbe.wsUrl) return cache.patch({
					...suggested,
					status: "ready",
					endpoint: launch.endpoint,
					wsUrl: localProbe.wsUrl,
					engine: localProbe.engine,
					code: "",
					message: launch.reused ? "local mode: reused managed browser" : "local mode: managed browser launched",
					latencyMs: localProbe.latencyMs,
					endpointSource: "local"
				});
				return cache.patch({
					...suggested,
					status: "unreachable",
					engine: void 0,
					code: "local-launch-not-ready",
					message: `managed local browser launched but its endpoint did not answer: ${localProbe.message}`
				});
			}
			return cache.patch({
				...suggested,
				status: "unreachable",
				engine: void 0,
				code: `local-${launch.code}`,
				message: launch.message
			});
		}
		return cache.patch(suggested);
	}
	const target = resolveEffectiveLink(input.targets, input.activeTargetId)?.link ?? null;
	if (!target) return cache.patch({
		...suggested,
		status: "no-active",
		targetId: input.activeTargetId,
		endpoint: "",
		wsUrl: "",
		code: input.remoteEnabled === false ? "remote-disabled" : "no-active-target",
		message: input.remoteEnabled === false ? "remote CDP is disabled by the remoteEnabled switch; the target sequence is preserved and can be re-enabled at any time" : input.activeTargetId === "" ? "no activated target in the sequence" : "the activated entry is disabled or gone and no enabled link can take over; enable a link, activate one, or set cdpMode=local",
		resolvedAt: now()
	});
	if (input.remoteEnabled === false && target.kind !== EGO_CLI_KIND && target.kind !== LP_KIND) return cache.patch({
		...suggested,
		status: "no-active",
		targetId: input.activeTargetId,
		endpoint: "",
		wsUrl: "",
		code: "remote-disabled",
		message: "remote CDP is disabled by the remoteEnabled switch; the target sequence is preserved and can be re-enabled at any time",
		resolvedAt: now()
	});
	if (target.kind === EGO_CLI_KIND) return refreshCliAttach(input, cache, suggested, target, now);
	if (target.kind === LP_KIND) return refreshLightpandaAttach(input, cache, suggested, target, now);
	const sameTarget = previous.targetId === target.id && previous.endpoint === target.endpoint;
	const suggestedProbe = {
		...suggested,
		targetId: target.id,
		endpoint: target.endpoint,
		status: "probing",
		code: "",
		message: "",
		wsUrl: sameTarget ? previous.wsUrl : "",
		latencyMs: sameTarget ? previous.latencyMs : 0
	};
	cache.patch(suggestedProbe);
	const outcome = await probeEndpoint(target.endpoint, {
		timeoutMs: input.timeoutMs,
		now,
		...input.fetchVersion ? { fetchVersion: input.fetchVersion } : {}
	});
	if (outcome.ok && outcome.wsUrl) return cache.patch({
		status: "ready",
		wsUrl: outcome.wsUrl,
		engine: outcome.engine,
		endpointSource: "remote",
		code: "",
		message: "",
		latencyMs: outcome.latencyMs,
		resolvedAt: now()
	});
	if (input.fallback?.enabled) {
		const launch = await launchLocalBrowser({
			chromePath: input.fallback.chromePath,
			chromeArgs: input.fallback.chromeArgs,
			localHeadless: input.fallback.localHeadless,
			userDataDir: input.fallback.userDataDir
		});
		if (launch.ok) {
			const localProbe = await probeEndpoint(launch.endpoint, {
				timeoutMs: input.timeoutMs,
				now
			});
			if (localProbe.ok && localProbe.wsUrl) return cache.patch({
				status: "ready",
				wsUrl: localProbe.wsUrl,
				engine: localProbe.engine,
				endpoint: launch.endpoint,
				code: "",
				message: "local fallback launched (activated endpoint unreachable)",
				latencyMs: localProbe.latencyMs,
				resolvedAt: now(),
				endpointSource: "local-fallback"
			});
			await stopLocalBrowser();
			return cache.patch({
				status: "unreachable",
				wsUrl: "",
				engine: void 0,
				code: "local-launch-not-ready",
				message: `local fallback browser launched but its endpoint did not answer: ${localProbe.message}`,
				latencyMs: outcome.latencyMs,
				resolvedAt: now()
			});
		}
		return cache.patch({
			status: "unreachable",
			wsUrl: "",
			code: `local-${launch.code}`,
			message: launch.message,
			latencyMs: outcome.latencyMs,
			resolvedAt: now()
		});
	}
	return cache.patch({
		status: "unreachable",
		wsUrl: "",
		engine: outcome.ok ? outcome.engine : void 0,
		code: outcome.code,
		message: outcome.message,
		latencyMs: outcome.latencyMs,
		resolvedAt: now()
	});
}

//#endregion
//#region src/cast-server.ts
const WORKER_BIN = fileURLToPath(new URL("../bin/cdp-cast-worker.mjs", import.meta.url));
let attachWsUrl = null;
/** Lightpanda backend — engine of the attached endpoint, published next to it. */
let attachEngine = null;
/** Logger captured in initCastServer so module-level helpers can report. */
let castLogger;
/** Late-bound worker starter so diagnostics/PDF work before any watch tab. */
let ensureWorkerRef;
/**
* Publish the currently resolved endpoint for the worker. Called by the host
* half whenever the ACTIVATED target changes (new target, new endpoint, or
* mode switching away from remote). Returns true when the value actually
* changed, which is the caller's signal that the worker must be recycled.
* The engine rides along so a spawned worker gets its capability projection
* via env (`BCDP_CDP_ENGINE`) instead of re-deriving it.
*/
function setAttachEndpoint(wsUrl, engine = null) {
	const next = wsUrl && wsUrl !== "" ? wsUrl : null;
	const nextEngine = next === null ? null : engine;
	if (next === attachWsUrl && nextEngine === attachEngine) return false;
	attachWsUrl = next;
	attachEngine = nextEngine;
	return true;
}
/** The endpoint the worker should attach to right now (null = none). */
function getAttachEndpoint() {
	return attachWsUrl;
}
/** The engine of the attached endpoint (null = none attached). */
function getAttachEngine() {
	return attachEngine;
}
/**
* Stop a running worker so the next request respawns it with the new argv
* seed (T2.4: an activation change must take effect on a live panel, not only
* after a host restart). Kills only the pid WE spawned (per our namespaced state file) —
* never a name-matched sweep, which previously took out the DSH subprocess
* runner along with our own tree (issues #34 defect 2 / #40).
*/
async function recycleWorker(reason) {
	const state = await knownWorkerState();
	if (state.pid === null || !isProcessAlive$1(state.pid)) return false;
	try {
		process.kill(state.pid, "SIGTERM");
	} catch {
		try {
			process.kill(state.pid, "SIGKILL");
		} catch {
			return false;
		}
	}
	castLogger?.info?.(`recycled cast worker (pid ${state.pid}) because ${reason}`);
	return true;
}
const EGO_SPACES_ROUTE = "/api/bcdp/spaces";
const EGO_STREAM_ROUTE = "/api/bcdp/stream";
const EGO_HEALTH_ROUTE = "/api/bcdp/health";
const EGO_CLOSE_ROUTE = "/api/bcdp/close";
const EGO_FLUSH_ROUTE = "/api/bcdp/flush";
const EGO_RAISE_ROUTE = "/api/bcdp/raise";
const EGO_MARKS_ROUTE = "/api/bcdp/marks";
const EGO_PICK_ROUTE = "/api/bcdp/pick";
const EGO_LOGIN_IMPORT_ROUTE = "/api/bcdp/login-import";
const EGO_INPUT_ROUTE = "/api/bcdp/input";
const EGO_WATCH_START_ROUTE = "/api/bcdp/watch/start";
const EGO_WATCH_SWITCH_ROUTE = "/api/bcdp/watch/switch";
const EGO_WATCH_STOP_ROUTE = "/api/bcdp/watch/stop";
const EGO_WATCH_STATUS_ROUTE = "/api/bcdp/watch/status";
const EGO_VIDEO_ROUTE = "/api/bcdp/video";
const EGO_VIDEO_STATUS_ROUTE = "/api/bcdp/video/status";
let toolCallCount = 0;
const sseClients = /* @__PURE__ */ new Set();
/** Timestamp of the last bcdp_* tool call — the idle reaper's activity signal. */
let lastEgoActivity = 0;
function getLastEgoActivity() {
	return lastEgoActivity;
}
const activityListeners = /* @__PURE__ */ new Set();
/**
* Subscribe to "one bcdp_* call just landed".
* @returns the unsubscribe function.
*/
function onEgoActivity(cb) {
	activityListeners.add(cb);
	return () => {
		activityListeners.delete(cb);
	};
}
function markEgoToolCall(sessionId) {
	toolCallCount += 1;
	lastEgoActivity = Date.now();
	for (const cb of [...activityListeners]) try {
		cb(sessionId);
	} catch {}
	const payload = sessionId === void 0 || sessionId === "" ? { count: toolCallCount } : {
		count: toolCallCount,
		sessionId
	};
	const frame = `event: tool-call\ndata: ${JSON.stringify(payload)}\n\n`;
	for (const res of sseClients) try {
		res.write(frame);
	} catch {
		sseClients.delete(res);
	}
}
/**
* Explicit "show the live view" signal. Ordinary bcdp_* calls never open the
* sidebar tab; the agent asks for it only when the user needs to watch.
*/
function requestWatchOpen(sessionId) {
	const payload = sessionId === void 0 || sessionId === "" ? {
		count: toolCallCount,
		open: true
	} : {
		count: toolCallCount,
		sessionId,
		open: true
	};
	const frame = `event: tool-call\ndata: ${JSON.stringify(payload)}\n\n`;
	for (const res of sseClients) try {
		res.write(frame);
	} catch {
		sseClients.delete(res);
	}
}
function castStatePath() {
	const e = process.env;
	const isWin = process.platform === "win32";
	const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : "/root");
	if (e.EGO_LINUX_STATE_DIR) return `${e.EGO_LINUX_STATE_DIR}/dsh-browser-cdp.cast.json`;
	return `${isWin ? e.LOCALAPPDATA || `${home}\\AppData\\Local` : e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux/dsh-browser-cdp.cast.json`;
}
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
/** Proxy a worker loopback endpoint. Returns null when the worker is unreachable. */
async function proxyFrom(port, path) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4e3) });
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	}
}
/** Proxy a POST with a JSON body to the worker. Returns status and body, or null when unreachable. */
async function proxyPost(port, path, body, timeoutMs = 4e3) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
		return {
			status: r.status,
			body: await r.json().catch(() => ({
				ok: false,
				error: `worker returned ${r.status}`
			}))
		};
	} catch {
		return null;
	}
}
/** Read a bounded network/console buffer from the live worker. */
async function readWorkerDiagnostics(kind, limit = 50, targetId) {
	const port = ensureWorkerRef ? await ensureWorkerRef() : (await knownWorkerState()).port;
	if (port === null) return null;
	const query = new URLSearchParams({
		kind,
		limit: String(limit)
	});
	if (targetId) query.set("targetId", targetId);
	const result = await proxyFrom(port, `/api/diagnostics?${query.toString()}`);
	return result !== null && typeof result === "object" ? result : null;
}
/** Ask the live worker to render the current page to PDF (base64 payload). */
async function printWorkerPdf(options) {
	const port = ensureWorkerRef ? await ensureWorkerRef() : (await knownWorkerState()).port;
	if (port === null) return null;
	return proxyPost(port, "/api/pdf", options, 3e4);
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
function proxyWorkerStream(port, res, path) {
	let cancelled = false;
	let ended = false;
	const endOnce = () => {
		if (ended) return;
		ended = true;
		sseClients.delete(res);
		try {
			res.end();
		} catch {}
	};
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
		"x-accel-buffering": "no"
	});
	res.write(":ok\n\n");
	sseClients.add(res);
	if (!Number.isInteger(port) || port <= 0) {
		res.on("close", () => {
			sseClients.delete(res);
		});
		return () => {
			sseClients.delete(res);
		};
	}
	const up = request({
		host: "127.0.0.1",
		port,
		path,
		method: "GET",
		headers: { accept: "text/event-stream" }
	}, (upRes) => {
		upRes.on("data", (chunk) => {
			if (cancelled || ended) return;
			try {
				if (!res.write(chunk)) {
					upRes.pause();
					res.once("drain", () => {
						if (!cancelled && !ended) upRes.resume();
					});
				}
			} catch {
				cancelled = true;
				endOnce();
			}
		});
		upRes.on("end", endOnce);
		upRes.on("error", endOnce);
	});
	up.on("error", endOnce);
	up.setTimeout(5e3, () => {
		try {
			up.destroy();
		} catch {}
		endOnce();
	});
	up.end();
	const onClose = () => {
		cancelled = true;
		sseClients.delete(res);
		try {
			up.destroy();
		} catch {}
	};
	res.on("close", onClose);
	return () => {
		cancelled = true;
		sseClients.delete(res);
		try {
			up.destroy();
		} catch {}
	};
}
function proxyWorkerVideo(port, req, res) {
	const generation = new URL(req.url || EGO_VIDEO_ROUTE, "http://dsh.internal").searchParams.get("generation");
	const path = `/api/video/stream${generation ? `?generation=${encodeURIComponent(generation)}` : ""}`;
	let upstream;
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		try {
			res.end();
		} catch {}
	};
	upstream = request({
		host: "127.0.0.1",
		port,
		path,
		method: "GET",
		headers: { accept: "video/mp4" }
	}, (upRes) => {
		res.writeHead(upRes.statusCode || 502, {
			"content-type": upRes.headers["content-type"] || "application/octet-stream",
			"cache-control": "no-store",
			...upRes.headers["x-ego-generation"] ? { "x-ego-generation": upRes.headers["x-ego-generation"] } : {},
			...upRes.headers["x-ego-backend"] ? { "x-ego-backend": upRes.headers["x-ego-backend"] } : {}
		});
		upRes.on("data", (chunk) => {
			if (ended) return;
			try {
				if (!res.write(chunk)) {
					upRes.pause();
					res.once("drain", () => {
						if (!ended) upRes.resume();
					});
				}
			} catch {
				upstream.destroy();
				end();
			}
		});
		upRes.on("end", end);
		upRes.on("error", end);
	});
	upstream.on("error", () => {
		if (!res.headersSent) sendJson(res, 502, {
			ok: false,
			error: "video worker unavailable"
		});
		else end();
	});
	upstream.setTimeout(5e3, () => {
		try {
			upstream.destroy();
		} catch {}
		if (!res.headersSent) sendJson(res, 504, {
			ok: false,
			error: "video worker timeout"
		});
		else end();
	});
	upstream.end();
	res.on("close", () => {
		ended = true;
		try {
			upstream.destroy();
		} catch {}
	});
}
async function readJsonBody$1(req, maxBytes = 8192) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		bytes += chunk.length;
		if (bytes > maxBytes) throw new Error("body too large");
		chunks.push(Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
/** Read the worker's { port, pid } from ego-cast.json, if any. */
async function knownWorkerState() {
	try {
		const { readFile: readFile$1 } = await import("node:fs/promises");
		const state = JSON.parse(await readFile$1(castStatePath(), "utf8"));
		return {
			port: typeof state.port === "number" ? state.port : null,
			pid: typeof state.pid === "number" ? state.pid : null
		};
	} catch {
		return {
			port: null,
			pid: null
		};
	}
}
/** Is a process with this pid alive? (false for our own / empty / signals fail) */
function isProcessAlive$1(pid) {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const e = err;
		return e && e.code === "EPERM";
	}
}
function captureConfig(cfg, ffmpegManager) {
	const ffmpegStatus = ffmpegManager?.status();
	const unavailable = cfg.captureBackend === "ffmpeg" && !ffmpegStatus?.canSelectFfmpeg;
	return {
		captureBackend: unavailable ? "cdp" : cfg.captureBackend,
		ffmpegFallbackReason: unavailable ? ffmpegStatus?.reason || "FFmpeg is unavailable" : "",
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
		ffmpegResolvedPath: ffmpegStatus?.canSelectFfmpeg ? ffmpegStatus.path || "" : ""
	};
}
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
function workerEnv() {
	const base = { ...process.env };
	if (process.versions.electron && base.ELECTRON_RUN_AS_NODE === void 0) base.ELECTRON_RUN_AS_NODE = "1";
	const ws = getAttachEndpoint();
	if (ws) base[EGO_LINUX_CDP_URL] = ws;
	else delete base[EGO_LINUX_CDP_URL];
	const engine = getAttachEngine();
	if (engine) base[BCDP_CDP_ENGINE] = engine;
	else delete base[BCDP_CDP_ENGINE];
	return base;
}
/**
* Initialize the worker starter independently of the HTTP watch routes.
* Headless profiles have no `webServer`, but bcdp_diagnostics/PDF still need
* the worker; web profiles reuse this same starter from initCastServer.
*/
function initCastWorker(ctx, cfg, ffmpegManager) {
	ensureWorkerRef ??= makeEnsureWorker(ctx, cfg, ffmpegManager);
}
/** Start the worker now (e.g. before a navigate) so diagnostics has history. */
async function ensureCastWorker() {
	return ensureWorkerRef ? ensureWorkerRef() : null;
}
/** Ensure a single ego-cast worker is running (idempotent). Launches it via
* ctx.subprocess. Re-spawns whenever the previous worker is found dead (its
* pid no longer alive or its /api/health does not answer), so a crashed
* worker is brought back without a host restart. Spawn is rate-limited to
* avoid hot-looping while a headless container has no browser yet.
*/
function makeEnsureWorker(ctx, cfg, ffmpegManager) {
	let lastAttempt = 0;
	async function launchedWorkerPort() {
		const state = await knownWorkerState();
		if (state.pid === null || !isProcessAlive$1(state.pid)) return null;
		return await proxyFrom(state.port, "/api/health") ? state.port : null;
	}
	return async function ensureWorker() {
		const running = await launchedWorkerPort();
		if (running !== null) return running;
		const now = Date.now();
		if (now - lastAttempt > 8e3) {
			lastAttempt = now;
			try {
				await ffmpegManager?.check({
					configuredPath: cfg.ffmpegPath,
					requestedEncoder: cfg.ffmpegEncoder
				}).catch(() => null);
				const initCfg = JSON.stringify(captureConfig(cfg, ffmpegManager));
				ctx.subprocess.spawn({
					argv: [
						process.execPath,
						WORKER_BIN,
						initCfg
					],
					cwd: process.cwd(),
					env: workerEnv(),
					stdio: {
						stdin: { data: "" },
						stdout: { maxBytes: 8192 },
						stderr: { maxBytes: 4096 }
					},
					graceMs: 12e3
				}).done.catch(() => null);
				const deadline = Date.now() + 8e3;
				while (Date.now() < deadline) {
					const ready = await launchedWorkerPort();
					if (ready !== null) return ready;
					await new Promise((resolve$1) => setTimeout(resolve$1, 100));
				}
				return null;
			} catch {
				return null;
			}
		}
		return null;
	};
}
/**
* Push the current cast config to a running worker via POST /api/config.
* Best-effort: if the worker is unreachable or the POST fails, the config
* will take effect on the next worker spawn (argv seed). Called whenever the
* settings layer reports a change.
*/
function makePushConfig(ensureWorker, ffmpegManager) {
	let lastPush = "";
	return async function pushConfig(cfg) {
		await ffmpegManager?.check({
			configuredPath: cfg.ffmpegPath,
			requestedEncoder: cfg.ffmpegEncoder
		}).catch(() => null);
		const port = await ensureWorker();
		if (port === null) return;
		const payload = JSON.stringify(captureConfig(cfg, ffmpegManager));
		if (payload === lastPush) return;
		lastPush = payload;
		try {
			const result = await proxyPost(port, "/api/config", JSON.parse(payload));
			if (!result || result.status >= 400) throw new Error("worker config update failed");
		} catch {}
	};
}
/**
* Register the watch-panel routes. Call inside plugin apply() with the real
* ctx; dispose is returned for ctx.effect cleanup.
*
* `bridge` is the settings bridge — its `onChange` is used to react to
* live settings saves and push the new config to a running worker.
*/
function initCastServer(ctx, cfg, bridge, ffmpegManager, openAgentWindow$1 = async () => ({
	ok: false,
	error: "raise not supported by this host build"
}), loginImport = async () => ({
	ok: false,
	error: "login import not supported by this host build"
})) {
	initCastWorker(ctx, cfg, ffmpegManager);
	const ensureWorker = ensureWorkerRef;
	const pushConfig = makePushConfig(ensureWorker, ffmpegManager);
	const rawServer = ctx.get?.("webServer");
	if (!rawServer || typeof rawServer.register !== "function") return;
	const connection = ctx.get?.("connection");
	const isTrustedRequest = (req) => {
		try {
			const admission = connection?.admit?.(req);
			return admission !== void 0 && admission.rejection === void 0;
		} catch {
			return false;
		}
	};
	const guardHandler = (handler) => async (req, resRaw) => {
		const res = resRaw;
		if (!isTrustedRequest(req)) {
			res.statusCode = 401;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end("{\"ok\":false,\"error\":\"unauthorized\"}");
			return;
		}
		return handler(req, res);
	};
	const rawRegister = rawServer.register.bind(rawServer);
	const server = Object.assign(Object.create(Object.getPrototypeOf(rawServer)), rawServer, { register: (opts) => rawRegister({
		...opts,
		handler: opts.handler ? guardHandler(opts.handler) : opts.handler
	}) });
	if (typeof bridge?.onChange === "function") {
		const off = bridge.onChange(() => {
			pushConfig(cfg);
		});
		if (typeof off === "function") ctx.effect?.(() => () => {
			try {
				off();
			} catch {}
		});
	}
	const disposeSpaces = server.register({
		kind: "exact",
		path: EGO_SPACES_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 200, {
				ok: false,
				spaces: [],
				toolCallCount,
				reason: "no live agent browser"
			});
			const data = await proxyFrom(port, "/api/spaces");
			if (!data) return sendJson(res, 200, {
				ok: false,
				spaces: [],
				toolCallCount,
				reason: "worker not ready"
			});
			return sendJson(res, 200, {
				...data,
				toolCallCount
			});
		}
	});
	const disposeStream = server.register({
		kind: "exact",
		path: EGO_STREAM_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) {
				proxyWorkerStream(-1, res, "/api/stream");
				return;
			}
			proxyWorkerStream(port, res, "/api/stream");
		}
	});
	const disposeInput = server.register({
		kind: "exact",
		path: EGO_INPUT_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const result = await proxyPost(port, "/api/input", await readJsonBody$1(req).catch(() => ({})));
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "input worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeClose = server.register({
		kind: "exact",
		path: EGO_CLOSE_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const body = await readJsonBody$1(req).catch(() => ({}));
			const targetId = typeof body.targetId === "string" ? body.targetId : "";
			if (!targetId) return sendJson(res, 400, {
				ok: false,
				error: "targetId required"
			});
			const result = await proxyPost(port, "/api/close", { targetId });
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "close worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeMarks = server.register({
		kind: "exact",
		path: EGO_MARKS_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const result = await proxyPost(port, "/api/marks", await readJsonBody$1(req).catch(() => ({})), 2e4);
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "marks worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposePick = server.register({
		kind: "exact",
		path: EGO_PICK_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			if (req.method === "POST") {
				const result = await proxyPost(port, "/api/pick", await readJsonBody$1(req).catch(() => ({})));
				if (!result) return sendJson(res, 502, {
					ok: false,
					error: "pick worker unavailable"
				});
				return sendJson(res, result.status, result.body);
			}
			return sendJson(res, 200, await proxyFrom(port, "/api/pick") || {
				ok: false,
				state: "idle",
				reason: "worker not ready"
			});
		}
	});
	const disposePickClick = server.register({
		kind: "exact",
		path: `${EGO_PICK_ROUTE}/click`,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const result = await proxyPost(port, "/api/pick/click", await readJsonBody$1(req).catch(() => ({})));
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "pick worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeFlush = server.register({
		kind: "exact",
		path: EGO_FLUSH_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const result = await proxyPost(port, "/api/flush", {});
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "flush worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeRaise = server.register({
		kind: "exact",
		path: EGO_RAISE_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			try {
				const result = await openAgentWindow$1();
				return sendJson(res, result.ok ? 200 : 500, result);
			} catch (err) {
				return sendJson(res, 500, {
					ok: false,
					error: String(err?.message || err)
				});
			}
		}
	});
	const disposeLoginImport = server.register({
		kind: "exact",
		path: EGO_LOGIN_IMPORT_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const body = await readJsonBody$1(req).catch(() => ({}));
			try {
				const result = await loginImport({
					source: [
						"chrome",
						"edge",
						"brave",
						"auto"
					].includes(String(body.source)) ? String(body.source) : "auto",
					domains: Array.isArray(body.domains) ? body.domains.map(String) : void 0,
					profile: typeof body.profile === "string" && body.profile !== "" ? body.profile : void 0,
					closeSource: body.closeSource === true,
					dryRun: body.dryRun === true
				});
				return sendJson(res, result.ok ? 200 : 400, result);
			} catch (err) {
				return sendJson(res, 500, {
					ok: false,
					error: String(err?.message || err)
				});
			}
		}
	});
	const disposeHealth = server.register({
		kind: "exact",
		path: EGO_HEALTH_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 200, { ok: false });
			return sendJson(res, 200, await proxyFrom(port, "/api/health") || { ok: false });
		}
	});
	const watchRoutes = [
		[EGO_WATCH_START_ROUTE, "/api/watch/start"],
		[EGO_WATCH_SWITCH_ROUTE, "/api/watch/switch"],
		[EGO_WATCH_STOP_ROUTE, "/api/watch/stop"]
	].map(([path, workerPath]) => server.register({
		kind: "exact",
		path,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 409, {
				ok: false,
				error: "worker not ready"
			});
			const timeoutMs = workerPath === "/api/watch/start" || workerPath === "/api/watch/switch" ? 3e4 : 4e3;
			const result = await proxyPost(port, workerPath, await readJsonBody$1(req).catch(() => ({})), timeoutMs);
			return result ? sendJson(res, result.status, result.body) : sendJson(res, 502, {
				ok: false,
				error: "worker request failed"
			});
		}
	}));
	const disposeWatchStatus = server.register({
		kind: "exact",
		path: EGO_WATCH_STATUS_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			return sendJson(res, 200, (port === null ? null : await proxyFrom(port, "/api/watch/status")) || {
				ok: false,
				state: "idle",
				reason: "worker not ready"
			});
		}
	});
	const disposeVideoStatus = server.register({
		kind: "exact",
		path: EGO_VIDEO_STATUS_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			return sendJson(res, 200, (port === null ? null : await proxyFrom(port, "/api/video/status")) || {
				ok: false,
				state: "idle",
				reason: "worker not ready"
			});
		}
	});
	const disposeVideo = server.register({
		kind: "exact",
		path: EGO_VIDEO_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 502, {
				ok: false,
				error: "worker not ready"
			});
			proxyWorkerVideo(port, req, res);
		}
	});
	ctx.effect?.(() => () => {
		try {
			disposeSpaces();
		} catch {}
		try {
			disposeStream();
		} catch {}
		try {
			disposeInput();
		} catch {}
		try {
			disposeClose();
		} catch {}
		try {
			disposeMarks();
		} catch {}
		try {
			disposePick();
		} catch {}
		try {
			disposePickClick();
		} catch {}
		try {
			disposeFlush();
		} catch {}
		try {
			disposeRaise();
		} catch {}
		try {
			disposeLoginImport();
		} catch {}
		try {
			disposeHealth();
		} catch {}
		for (const dispose of watchRoutes) try {
			dispose();
		} catch {}
		try {
			disposeWatchStatus();
		} catch {}
		try {
			disposeVideoStatus();
		} catch {}
		try {
			disposeVideo();
		} catch {}
	});
}

//#endregion
//#region src/config.ts
const backend = z.union([
	"auto",
	"cdp",
	"ffmpeg"
]);
const profile = z.union([
	"low",
	"balanced",
	"high"
]);
const cdpMode = z.union([
	"auto",
	"local",
	"remote"
]);
const toolInjection = z.union(["lazy", "always"]);
const DEFAULT_SPACE = "default";
const AUTO_SPACE_SENTINEL = ":auto";
const encoder = z.union([
	"auto",
	"software",
	"h264_mf",
	"h264_nvenc",
	"h264_qsv",
	"h264_amf",
	"h264_videotoolbox",
	"h264_vaapi"
]);
const Config$1 = z.object({
	isolateSpaces: z.boolean().description("Space isolation: false = persistent profile (keep logins across restarts); true = isolated sandbox.").volatile(),
	defaultSpace: z.string().description("Task space used when an bcdp_* call omits `space`. Default `:auto` = derive a per-session space `dsh-agent-<sessionId8>`, so concurrent sessions never share or hijack each other's browsing context. Set a fixed name (e.g. `default`) to reuse ONE shared slot across sessions — pass `space: \"default\"` on a single call for the same effect. Note this only names spaces; whether the browser profile itself persists is controlled by isolateSpaces.").volatile(),
	idleTimeoutMin: z.number().min(0).max(1440).step(1).description("Auto-stop the backing browser after N minutes without an bcdp_* call (0 = off). Relaunches on demand at the next call.").volatile(),
	chromePath: z.string().description("Path to Chrome/Chromium. Empty = auto-detect.").volatile(),
	captureBackend: backend.description("Capture backend: auto, cdp, or ffmpeg.").volatile(),
	streamProfile: profile.description("Capture quality profile.").volatile(),
	cdpFps: z.number().min(5).max(30).step(1).description("CDP preview FPS.").volatile(),
	cdpQuality: z.number().min(1).max(100).step(1).description("CDP JPEG quality.").volatile(),
	cdpMaxWidth: z.number().min(320).max(1920).step(40).description("CDP frame max width.").volatile(),
	cdpBackstopIntervalMs: z.number().min(1e3).max(1e4).step(100).description("CDP recovery screenshot interval.").volatile(),
	ffmpegFps: z.number().min(5).max(30).step(1).description("FFmpeg video FPS.").volatile(),
	ffmpegMaxWidth: z.number().min(320).max(1920).step(40).description("FFmpeg video max width.").volatile(),
	ffmpegBitrateKbps: z.number().min(500).max(2e4).step(250).description("FFmpeg target video bitrate in kbps.").volatile(),
	ffmpegEncoder: encoder.description("FFmpeg H.264 encoder.").volatile(),
	ffmpegPath: z.string().description("Custom FFmpeg path. Empty = detect PATH or managed install.").volatile(),
	githubMirror: z.string().description("HTTPS base replacing https://github.com for managed downloads.").volatile(),
	runtimeArgs: z.string().description("Extra args appended to the vendored runtime argv. Takes effect on the next bcdp_* call.").volatile(),
	chromeArgs: z.string().description("Extra args appended to the Chrome launch argv. Takes effect on the next browser cold start (the browser is a singleton).").volatile(),
	links: z.array(z.union([
		z.object({
			kind: z.string(),
			id: z.string(),
			label: z.string(),
			endpoint: z.string(),
			enabled: z.boolean(),
			note: z.string(),
			probeStatus: z.union([
				"unknown",
				"ok",
				"error"
			]),
			probeLatencyMs: z.number(),
			probeError: z.string(),
			probeCode: z.string(),
			probeAt: z.number(),
			probeEngine: z.union([
				"chrome",
				"lightpanda",
				"unknown"
			])
		}),
		z.object({
			kind: z.string(),
			id: z.string(),
			label: z.string(),
			cliPath: z.string(),
			useSdkPath: z.boolean().description("Deprecated: ALWAYS treated as true since v1.7.1-rc.5 — the native ego CLI has no taskSpaces facade, so without the bundled harness every call fails. Kept in the row shape so old profiles still validate; a stored false is healed on read."),
			enabled: z.boolean(),
			note: z.string(),
			probeStatus: z.union([
				"unknown",
				"ok",
				"error"
			]),
			probeLatencyMs: z.number(),
			probeError: z.string(),
			probeCode: z.string(),
			probeAt: z.number(),
			probeEngine: z.union([
				"chrome",
				"lightpanda",
				"unknown"
			])
		}),
		z.object({
			kind: z.string(),
			id: z.string(),
			label: z.string(),
			servePath: z.string(),
			enabled: z.boolean(),
			note: z.string(),
			probeStatus: z.union([
				"unknown",
				"ok",
				"error"
			]),
			probeLatencyMs: z.number(),
			probeError: z.string(),
			probeCode: z.string(),
			probeAt: z.number(),
			probeEngine: z.union([
				"chrome",
				"lightpanda",
				"unknown"
			])
		})
	])).description("Ordered connection sequence: CDP endpoints and (at most one) local ego CLI link. The ACTIVATED entry receives every bcdp_* call; if the activation points at a disabled or removed entry, the FIRST enabled link in this order takes over (logged and shown by bcdp_doctor). Order IS the priority order.").volatile(),
	activeTargetId: z.string().description("Id of the activated entry in links. Empty = nothing activated (no silent adoption). A disabled/removed entry here falls back to the first enabled link in order.").volatile(),
	cdpMode: cdpMode.description("auto = use the activated target and never start a local browser silently; remote = only ever connect to the activated target; local = always use local browser control.").volatile(),
	cdpProbeTimeoutMs: z.number().min(200).max(3e4).step(100).description("Timeout for one CDP endpoint probe (http endpoints answer /json/version)."),
	cursorHud: z.boolean().description("Draw the agent cursor HUD into screenshots."),
	cursorName: z.string().description("Name label shown in the cursor HUD."),
	allowLocalFallback: z.boolean().description("auto mode may fall back to launching a local browser when the activated target is unreachable. Off by default: the fallback must be explicit.").volatile(),
	legacyEgoToolNames: z.boolean().description("ALSO register the tools under their old ego_* names for scripts written before the bcdp_* rename. Off by default; mutually exclusive with installing the upstream ego-browser plugin (same tool names)."),
	toolInjection: toolInjection.default("lazy").description("lazy = keep only bcdp_status resident (it is the unlock entry: the rest are injected after the first bcdp_* activity, and the idle reaper seals them back); always = register every allowed tool at mount (the historical behaviour).").volatile(),
	toolBrowse: z.boolean().default(true).description("Basic browsing tiers — act + observe + wait (19 tools: space / navigate / click / fill / key / hover / scroll / select / check / drag / tab / help / doctor / screenshot / page_info / read_element / js / snapshot / wait). Internally released in three waves. Off = sealed: removed from the model tool list.").volatile(),
	toolExtended: z.boolean().default(true).description("Extended tiers — power + session (8 tools: raw CDP / http / upload / download / dialog / captcha / auth_flush / login_import). Off = sealed even after browser activity.").volatile(),
	toolEscape: z.boolean().default(true).description("Escape-hatch tier (1 tool: script — run an arbitrary heredoc with page/browser/taskSpaces/fetch/cdp preloaded; verbatim:true reproduces the old bare-heredoc cli behaviour). Sealed until browser activity like every other non-core tier: call bcdp_status first, then it appears. Off = sealed.").volatile(),
	toolJudge: z.boolean().default(true).description("Judgement tier (5 bcdp_jev_* tools). On still requires a JEV or Laya key: without one they can only answer \"not configured\", so they stay sealed anyway.").volatile(),
	sessionScopedPulse: z.boolean().default(true).description("Per-session unlock: when on, calling bcdp_status in session A only unlocks tools for session A — other sessions stay at their own depth. When off, any session's unlock is process-wide (historical behaviour). Falls back to off when the host does not expose agent-scoped tool restriction.").volatile(),
	localHeadless: z.boolean().description("Run the locally launched browser headless."),
	remoteEnabled: z.boolean().description("Master switch for REMOTE attach. Off = the configured target sequence is preserved but inert (nothing probes or connects remotely); flip back on any time. Does not affect cdpMode=local.").volatile(),
	allowProbeColdStart: z.boolean().description("Allow the ego-cli readiness probe to cold-start the backing browser. Off (default): the probe never launches the browser — when --status cannot prove the browser is already up, the heredoc round-trip is skipped and the browser starts on the first real bcdp_* call instead (no browser window at plugin startup). On: the probe verifies the SDK harness up front, which may launch the browser.").volatile(),
	localUserDataDir: z.string().description("Profile dir for the locally launched browser. Empty = managed dir; never point at your daily Chrome profile."),
	lightpandaArgs: z.string().description("Extra args appended to a managed `lightpanda serve` argv. --host/--port are managed and cannot be overridden.").volatile(),
	castFpsCap: z.number().min(0).max(60).step(1),
	screencastQuality: z.number().min(1).max(100).step(1),
	screencastMaxWidth: z.number().min(320).max(1920).step(40),
	backstopIntervalMs: z.number().min(200).max(1e4).step(100),
	jevUrl: z.string().description("JEV judge base URL, no path. Leave EMPTY: JEV cannot currently be registered, so the hop would only ever be skipped. Add it (and jev to the hop order) when registration opens.").volatile(),
	jevKey: z.string().description("Bearer key for the JEV judge. Empty = the jev hop is skipped (never sent, so no 401 round trip).").volatile(),
	jevModel: z.string().description("Model name sent in the request body.").volatile(),
	layaUrl: z.string().description("Laya judge base URL. The sidecar serves 8000; 7789 is a different tool and will not answer.").volatile(),
	layaKey: z.string().description("Bearer key for the Laya judge. REQUIRED: laya-api has no anonymous branch, so a keyless call is a guaranteed 401.").volatile(),
	layaModel: z.string().description("Model name sent to the Laya judge.").volatile(),
	judgePrefer: z.string().description("Judgement hop order, comma separated. Defaults to \"laya,rule\" because JEV cannot currently be registered. Unknown names are dropped; the terminal refusal hop cannot be removed.").volatile(),
	jevChunkSize: z.number().min(1).max(255).step(1).description("Candidate ceiling per judgement round. Bound to the probability threshold bucket, so raising it also tightens the gate.").volatile(),
	jevMaxImageBytes: z.number().min(0).step(1024).description("Frame byte budget. 0 = unbounded, which is the measured default: a full-page JPEG was 137 KiB, so chunking for bytes alone slices static pages for nothing.").volatile(),
	jevHistoryLimit: z.number().min(0).max(20).step(1).description("How many recent steps the judge is shown. Recency beats completeness in a loop.").volatile(),
	jevArchiveImage: z.boolean().description("Embed the base64 screenshot in the archived Laya bundle. Off by default: a bundle that always carries hundreds of KiB is a bundle nobody keeps.").volatile(),
	jevEvaluate: z.boolean().description("After every action, ask the judge whether the step actually advanced: inprogress / done / fail. inprogress continues silently; done is checked against successCriteria; fail hands back to the model for recovery (reload, re-capture, ...). Costs one judgement call per action.").volatile(),
	jevStepBudget: z.number().min(1).max(200).step(1).description("Judgement rounds allowed in one bcdp_jev_run before it stops as exhausted.").volatile(),
	jevWallMs: z.number().min(1e3).max(36e5).step(1e3).description("Wall-clock ceiling for one bcdp_jev_run, in ms.").volatile()
});
/** True when the value is a live volatile reference rather than plain data. */
function isVolatileRef(value) {
	return typeof value === "object" && value !== null && typeof value.get === "function";
}
/**
* Shallow-copy a raw config entry, replacing every live volatile reference
* with its current snapshot. 0.1.7 delivers volatile-only changes as ref
* updates (no plugin remount), so every read path must deref before the
* plain-value `typeof` gates in `resolveConfig` can see real data.
*/
function derefVolatileConfig(config) {
	const out = {};
	for (const [key, value] of Object.entries(config)) out[key] = isVolatileRef(value) ? value.get() : value;
	return out;
}
/**
* Flags the user must NOT put in `runtimeArgs`: these runtime subcommands
* exit before the heredoc runs (--status/--stop/--help/...) or steal the
* browser window (--open), so appending them would break every bcdp_* tool.
* `--headless` is managed by EGO_LINUX_HEADLESS; `--sdk-path` is allowed.
*/
const EGO_CLI_BLOCKED = new Set([
	"--status",
	"--stop",
	"--open",
	"--spaces",
	"--spaces-daemon",
	"--prune-spaces",
	"--import-chrome-profile",
	"--install-desktop-entry",
	"--help",
	"-h"
]);
/**
* Flags the user must NOT put in `chromeArgs`: these are managed by the
* launcher / EGO_LINUX_PROXY and overriding them would break CDP control,
* profile isolation, or the proxy bypass list. `--proxy-server` should go
* through EGO_LINUX_PROXY (which also sets the bypass list).
*/
const CHROME_BLOCKED = new Set([
	"--user-data-dir",
	"--remote-debugging-port",
	"--remote-allow-origins",
	"--headless",
	"--no-startup-window",
	"--proxy-server",
	"--proxy-bypass-list"
]);
/**
* Shell-like tokenizer for user-supplied arg strings. Handles single/double
* quotes and backslash escapes; bare whitespace separates tokens. Returns []
* for empty/whitespace-only input. Used for both `runtimeArgs` and `chromeArgs`
* (mirrored in runtime/ego-linux/src/chrome.mjs for the Chrome side, since the
* runtime must not import from src/).
*/
function tokenizeArgs(input) {
	if (typeof input !== "string") return [];
	const out = [];
	let cur = "";
	let i = 0;
	let quote = null;
	while (i < input.length) {
		const c = input[i];
		if (quote) {
			if (c === "\\") {
				const next = input[i + 1];
				if (next !== void 0) {
					cur += next;
					i += 2;
					continue;
				}
			} else if (c === quote) {
				quote = null;
				i += 1;
				continue;
			}
			cur += c;
			i += 1;
			continue;
		}
		if (c === "\"" || c === "'") {
			quote = c;
			i += 1;
			continue;
		}
		if (c === "\\") {
			const next = input[i + 1];
			if (next !== void 0) {
				cur += next;
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}
		if (c === " " || c === "	" || c === "\n" || c === "\r") {
			if (cur !== "") {
				out.push(cur);
				cur = "";
			}
			i += 1;
			continue;
		}
		cur += c;
		i += 1;
	}
	if (cur !== "") out.push(cur);
	return out;
}
/**
* Split a raw arg string into tokens, dropping any token (and, for `--flag
* value` pairs, its value) that appears in `blocked`. A "blocked" token with a
* `=` attached (e.g. `--headless=new`) is also dropped. Returns the surviving
* tokens. Exposed for tests and for the runtime to mirror.
*/
function filterArgs(raw, blocked) {
	const tokens = tokenizeArgs(raw);
	const kept = [];
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		const key = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
		if (blocked.has(key)) {
			if (!tok.includes("=") && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) i += 1;
			continue;
		}
		kept.push(tok);
	}
	return kept;
}
const finiteIn = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
function oneOf(value, values, fallback) {
	return typeof value === "string" && values.includes(value) ? value : fallback;
}
/**
* A non-string (undefined, null, a number from a hand-edited row) becomes ''.
*
* Trimmed as well, because these values come from a settings panel that a user
* pastes URLs into, and `" http://…"` is a URL that fails to parse while looking
* perfectly fine in the field.
*/
const trimmed = (value) => typeof value === "string" ? value.trim() : "";
/**
* Pick out the judge-facing settings.
*
* `prefer` is passed through UNFILTERED on purpose, matching how `runtimeArgs`
* is handled: a saved preference is stored raw and filtered at the call site, so
* a later change to the legal hop list cannot retroactively mangle what the user
* typed. The filtering (and the rule that the terminal refusal hop cannot be
* removed) lives in `src/jev/client.ts`, where it is unit-tested.
*/
function judgeSettingsOf(config) {
	return {
		jevUrl: config.jevUrl,
		jevKey: config.jevKey,
		jevModel: config.jevModel,
		layaUrl: config.layaUrl,
		layaKey: config.layaKey,
		layaModel: config.layaModel,
		prefer: config.judgePrefer,
		chunkSize: config.jevChunkSize,
		maxImageBytes: config.jevMaxImageBytes,
		historyLimit: config.jevHistoryLimit,
		archiveImage: config.jevArchiveImage,
		evaluate: config.jevEvaluate,
		stepBudget: config.jevStepBudget,
		wallMs: config.jevWallMs
	};
}
/**
* 分级开关的默认极性 = 开放。只有显式的假值才是封印：`undefined`（用户从没碰
* 过表单）与手改 YAML 写出的 `'false'` / `0` 都得认，否则一个空字段就会把
* 14 个工具静默封掉。prime-memory 的 `v.toolRoom !== false` 同式，只是这里把
* 手改形状一并接住。
*/
const tierOpenByDefault = (value) => !(value === false || value === "false" || value === 0);
function resolveConfig(config = {}) {
	config = derefVolatileConfig(config);
	const legacyFps = finiteIn(config.castFpsCap, 0, 60) ? config.castFpsCap === 0 ? 20 : Math.max(5, Math.min(30, config.castFpsCap)) : 20;
	const selectedProfile = oneOf(config.streamProfile, [
		"low",
		"balanced",
		"high"
	], "balanced");
	const profileDefaults = selectedProfile === "low" ? {
		fps: 15,
		width: 960,
		bitrateKbps: 2e3
	} : selectedProfile === "high" ? {
		fps: 30,
		width: 1600,
		bitrateKbps: 8e3
	} : {
		fps: 20,
		width: 1280,
		bitrateKbps: 4e3
	};
	return {
		chromePath: typeof config.chromePath === "string" ? config.chromePath : "",
		captureBackend: oneOf(config.captureBackend, [
			"auto",
			"cdp",
			"ffmpeg"
		], "auto"),
		streamProfile: selectedProfile,
		cdpFps: finiteIn(config.cdpFps, 5, 30) ? config.cdpFps : legacyFps,
		cdpQuality: finiteIn(config.cdpQuality, 1, 100) ? config.cdpQuality : finiteIn(config.screencastQuality, 1, 100) ? config.screencastQuality : 55,
		cdpMaxWidth: finiteIn(config.cdpMaxWidth, 320, 1920) ? config.cdpMaxWidth : finiteIn(config.screencastMaxWidth, 320, 1920) ? config.screencastMaxWidth : 960,
		cdpBackstopIntervalMs: finiteIn(config.cdpBackstopIntervalMs, 1e3, 1e4) ? config.cdpBackstopIntervalMs : finiteIn(config.backstopIntervalMs, 200, 1e4) ? Math.max(1e3, config.backstopIntervalMs) : 3e3,
		ffmpegFps: finiteIn(config.ffmpegFps, 5, 30) ? config.ffmpegFps : profileDefaults.fps,
		ffmpegMaxWidth: finiteIn(config.ffmpegMaxWidth, 320, 1920) ? config.ffmpegMaxWidth : profileDefaults.width,
		ffmpegBitrateKbps: finiteIn(config.ffmpegBitrateKbps, 500, 2e4) ? config.ffmpegBitrateKbps : profileDefaults.bitrateKbps,
		ffmpegEncoder: oneOf(config.ffmpegEncoder, [
			"auto",
			"software",
			"h264_mf",
			"h264_nvenc",
			"h264_qsv",
			"h264_amf",
			"h264_videotoolbox",
			"h264_vaapi"
		], "auto"),
		ffmpegPath: typeof config.ffmpegPath === "string" ? config.ffmpegPath : "",
		githubMirror: typeof config.githubMirror === "string" ? config.githubMirror : "",
		runtimeArgs: typeof config.runtimeArgs === "string" ? config.runtimeArgs : typeof config.egoCliArgs === "string" ? config.egoCliArgs : "",
		chromeArgs: typeof config.chromeArgs === "string" ? config.chromeArgs : "",
		isolateSpaces: typeof config.isolateSpaces === "boolean" ? config.isolateSpaces : config.isolateSpaces === "true" || config.isolateSpaces === "1" || config.isolateSpaces === 1,
		defaultSpace: typeof config.defaultSpace === "string" && config.defaultSpace.trim() !== "" ? config.defaultSpace.trim() : AUTO_SPACE_SENTINEL,
		idleTimeoutMin: finiteIn(config.idleTimeoutMin, 0, 1440) ? config.idleTimeoutMin : 0,
		links: sanitizeLinks(config.links ?? config.cdpTargets).links.map(normalizeProbeState),
		activeTargetId: typeof config.activeTargetId === "string" ? config.activeTargetId : "",
		cdpMode: oneOf(config.cdpMode, [
			"auto",
			"local",
			"remote"
		], "auto"),
		cdpProbeTimeoutMs: finiteIn(config.cdpProbeTimeoutMs, 200, 3e4) ? config.cdpProbeTimeoutMs : 3e3,
		cursorHud: config.cursorHud === void 0 ? true : Boolean(config.cursorHud),
		cursorName: typeof config.cursorName === "string" && config.cursorName.trim() !== "" ? config.cursorName : "DeepSeek",
		allowLocalFallback: config.allowLocalFallback === void 0 ? false : Boolean(config.allowLocalFallback),
		legacyEgoToolNames: Boolean(config.legacyEgoToolNames),
		toolInjection: oneOf(config.toolInjection, ["lazy", "always"], "lazy"),
		toolBrowse: tierOpenByDefault(config.toolBrowse),
		toolExtended: tierOpenByDefault(config.toolExtended),
		toolEscape: tierOpenByDefault(config.toolEscape),
		toolJudge: tierOpenByDefault(config.toolJudge),
		sessionScopedPulse: tierOpenByDefault(config.sessionScopedPulse),
		localHeadless: config.localHeadless === void 0 ? false : Boolean(config.localHeadless),
		localUserDataDir: typeof config.localUserDataDir === "string" ? config.localUserDataDir : "",
		lightpandaArgs: trimmed(config.lightpandaArgs),
		remoteEnabled: config.remoteEnabled === void 0 ? true : Boolean(config.remoteEnabled),
		allowProbeColdStart: config.allowProbeColdStart === true || config.allowProbeColdStart === "true",
		jevUrl: trimmed(config.jevUrl),
		jevKey: trimmed(config.jevKey),
		jevModel: trimmed(config.jevModel) === "" ? "jev" : trimmed(config.jevModel),
		layaUrl: trimmed(config.layaUrl) === "" ? "http://127.0.0.1:8000" : trimmed(config.layaUrl),
		layaKey: trimmed(config.layaKey),
		layaModel: trimmed(config.layaModel) === "" ? "laya" : trimmed(config.layaModel),
		judgePrefer: trimmed(config.judgePrefer) === "" ? "laya,rule" : trimmed(config.judgePrefer),
		jevChunkSize: finiteIn(config.jevChunkSize, 1, 255) ? config.jevChunkSize : 20,
		jevMaxImageBytes: finiteIn(config.jevMaxImageBytes, 0, 512 * 1024 * 1024) ? config.jevMaxImageBytes : 0,
		jevHistoryLimit: finiteIn(config.jevHistoryLimit, 0, 20) ? config.jevHistoryLimit : 5,
		jevArchiveImage: config.jevArchiveImage === void 0 ? false : Boolean(config.jevArchiveImage),
		jevEvaluate: config.jevEvaluate === void 0 ? true : Boolean(config.jevEvaluate),
		jevStepBudget: finiteIn(config.jevStepBudget, 1, 200) ? config.jevStepBudget : 20,
		jevWallMs: finiteIn(config.jevWallMs, 1e3, 36e5) ? config.jevWallMs : 12e4
	};
}
/**
* Fill the per-link probe fields so downstream code (panel badge, doctor
* output) can read them without a null-check ladder. Generic over the link
* union so the discriminating `kind` (and every kind-specific field) survives.
*/
function normalizeProbeState(link) {
	return {
		...link,
		probeStatus: link.probeStatus === "ok" || link.probeStatus === "error" ? link.probeStatus : "unknown",
		probeLatencyMs: typeof link.probeLatencyMs === "number" && Number.isFinite(link.probeLatencyMs) ? link.probeLatencyMs : 0,
		probeError: typeof link.probeError === "string" ? link.probeError : "",
		probeCode: typeof link.probeCode === "string" ? link.probeCode : "",
		probeAt: typeof link.probeAt === "number" && Number.isFinite(link.probeAt) ? link.probeAt : 0,
		probeEngine: link.probeEngine === "chrome" || link.probeEngine === "lightpanda" ? link.probeEngine : "unknown"
	};
}

//#endregion
//#region src/gateway.ts
/** HTTP route prefix owning every ego-browser API request. */
const API_PREFIX = "/bcdp/api";
/**
* Register the `/bcdp/api` HTTP route on the host's web server.
*
* The route reads/writes the `ego-browser` settings namespace in-process
* through the bridge + `ctx.settings`. The settings service is optional:
* when absent, `get` degrades to the entry source and `set` returns a
* clear error.
*/
function registerEgoBrowserGateway(ctx, bridge, ffmpegManager, picks) {
	ctx.effect?.(() => {
		const webServer = ctx.get?.("webServer");
		if (!webServer || typeof webServer.register !== "function") return;
		return webServer.register({
			kind: "prefix",
			path: API_PREFIX,
			handler: async (reqRaw, resRaw) => {
				const req = reqRaw;
				const res = resRaw;
				if (req.method !== "POST") {
					writeJson(res, 405, envelopeError("method-not-allowed", "POST only"));
					return;
				}
				const origin = req.headers.origin;
				if (origin) {
					let originHost;
					try {
						originHost = new URL(origin).host;
					} catch {
						writeJson(res, 400, envelopeError("invalid-origin", "invalid Origin header"));
						return;
					}
					if (!req.headers.host || originHost !== req.headers.host) {
						writeJson(res, 403, envelopeError("origin-not-allowed", "same-origin requests only"));
						return;
					}
				}
				if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					writeJson(res, 415, envelopeError("content-type-not-supported", "application/json required"));
					return;
				}
				const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
				const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(`${API_PREFIX}/`.length) : void 0;
				if (method === void 0 || method.includes("/")) {
					writeJson(res, 404, envelopeError("not-found", "unknown ego-browser API method"));
					return;
				}
				try {
					const body = await readJsonBody(req);
					if (method === "get") {
						const config = resolveConfig(bridge.source());
						writeJson(res, 200, envelopeOk({
							config,
							ffmpegStatus: ffmpegManager ? await ffmpegManager.check({
								configuredPath: config.ffmpegPath,
								requestedEncoder: config.ffmpegEncoder
							}) : null
						}));
					} else if (method === "set") writeJson(res, 410, {
						ok: false,
						error: {
							code: "GONE",
							message: "config writes moved to the 0.1.7 settings form"
						}
					});
					else if (method === "ffmpeg-status") writeJson(res, 200, envelopeOk({ ffmpegStatus: ffmpegManager?.status() || null }));
					else if (method === "ffmpeg-check") {
						const config = resolveConfig(bridge.source());
						writeJson(res, 200, envelopeOk({ ffmpegStatus: await ffmpegManager?.check({
							configuredPath: config.ffmpegPath,
							requestedEncoder: config.ffmpegEncoder
						}) || null }));
					} else if (method === "ffmpeg-install") {
						const config = resolveConfig(bridge.source());
						const githubMirror = typeof body.githubMirror === "string" ? body.githubMirror : config.githubMirror;
						const ffmpegStatus = ffmpegManager?.startInstall({
							githubMirror,
							configuredPath: config.ffmpegPath,
							requestedEncoder: config.ffmpegEncoder
						});
						writeJson(res, 200, envelopeOk({ ffmpegStatus: ffmpegStatus || null }));
					} else if (method === "cdp-status") writeJson(res, 200, envelopeOk({ attach: defaultAttachCache.get() }));
					else if (method === "cdp-refresh") {
						const cfg = resolveConfig(bridge.source());
						const attach = await refreshAttach({
							targets: cfg.links,
							activeTargetId: cfg.activeTargetId,
							mode: cfg.cdpMode,
							timeoutMs: cfg.cdpProbeTimeoutMs,
							cache: defaultAttachCache,
							cliIo: createSubprocessCliIo(ctx.subprocess),
							sdkPath: fileURLToPath(new URL("../runtime/ego-browser/dist/out/index.js", import.meta.url)),
							bundledCli: fileURLToPath(new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url)),
							lightpandaArgs: cfg.lightpandaArgs
						});
						if (setAttachEndpoint(attach.status === "ready" && attach.wsUrl !== "" ? attach.wsUrl : null, attach.status === "ready" ? attach.engine ?? "unknown" : null)) recycleWorker("cdp manual refresh").catch(() => null);
						writeJson(res, 200, envelopeOk({ attach }));
					} else if (method === "cdp-probe") {
						const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
						if (endpoint === "") {
							writeJson(res, 400, envelopeError("invalid-endpoint", "endpoint is required"));
							return;
						}
						writeJson(res, 200, envelopeOk({ outcome: await probeEndpoint(endpoint, { timeoutMs: typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) ? body.timeoutMs : void 0 }) }));
					} else if (method === "picks-save") {
						const picksSession = typeof body.session === "string" ? body.session : void 0;
						const picksDir0 = picks ? picks.resolveDir(picksSession) : void 0;
						if (!picksDir0) {
							writeJson(res, 409, envelopeError("no-workspace", "no registered workspace resolves for this session"));
							return;
						}
						const saveBody = body;
						const block = typeof saveBody.block === "string" ? saveBody.block : "";
						if (block === "") {
							writeJson(res, 400, envelopeError("invalid-block", "block is required"));
							return;
						}
						const file = typeof saveBody.file === "string" && /^[A-Za-z0-9._-]+\.json$/.test(saveBody.file) ? saveBody.file : `picks-${Date.now()}.json`;
						const dir = picksDir0;
						await mkdir(dir, { recursive: true });
						const target = resolve(dir, file);
						if (!target.startsWith(resolve(dir))) {
							writeJson(res, 400, envelopeError("invalid-path", "path escapes the picks dir"));
							return;
						}
						await writeFile(target, block, "utf8");
						writeJson(res, 200, envelopeOk({
							path: target,
							file
						}));
					} else if (method === "picks-load") {
						const loadSession = typeof body.session === "string" ? body.session : void 0;
						const loadDir0 = picks ? picks.resolveDir(loadSession) : void 0;
						if (!loadDir0) {
							writeJson(res, 409, envelopeError("no-workspace", "no registered workspace resolves for this session"));
							return;
						}
						const loadBody = body;
						const file = typeof loadBody.file === "string" && /^[A-Za-z0-9._-]+\.json$/.test(loadBody.file) ? loadBody.file : "";
						if (file === "") {
							writeJson(res, 400, envelopeError("invalid-file", "file is required"));
							return;
						}
						try {
							writeJson(res, 200, envelopeOk({ content: await readFile(resolve(loadDir0, file), "utf8") }));
						} catch (error) {
							writeJson(res, 404, envelopeError("not-found", error instanceof Error ? error.message : String(error)));
						}
					} else writeJson(res, 404, envelopeError("not-found", `unknown ego-browser API method "${method}"`));
				} catch (error) {
					const e = error;
					const message = e instanceof Error ? e.message : String(error);
					writeJson(res, e?.code === "ffmpeg-unavailable" ? 409 : e?.code === "ffmpeg-mirror-invalid" ? 400 : 500, envelopeError(e?.code || "internal", message));
				}
			}
		});
	}, "ego-browser: /bcdp/api routes");
}
/** Read and parse a JSON body from a node:http request. */
async function readJsonBody(req, maxBytes = 16384) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {};
	return JSON.parse(text);
}
/** Write a JSON response envelope. */
function writeJson(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(json);
}
/** Build a success envelope. */
function envelopeOk(value) {
	return {
		ok: true,
		value
	};
}
/** Build an error envelope. */
function envelopeError(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}

//#endregion
//#region src/help.ts
/**
* src/help.ts — tool index copy (EGO_HELP_INDEX).
*
* Pure data module: the `topic` lookup table for the bcdp_help tool. When you
* add/change a tool, remember to sync an entry here or bcdp_help won't find it.
*/
const EGO_HELP_INDEX = {
	overview: "CDP 浏览器代理：结构化浏览器工具。导航/交互/观察/表单/网络/等待/键鼠皆有专项工具，另提供 bcdp_help(本索引)、bcdp_doctor(体检)、bcdp_script(自由脚本逃生舱；verbatim:true 为裸 heredoc)。连接与激活见 topic=links。If a bcdp_* tool is missing from your list, read topic=injection first: tools are tiered and only core stays resident. 分类见: tools / navigate / observe / input / keyboard-mouse / form / wait / network / login / script / doctor / lightpanda / injection。用 `topic` 查询，或直接给工具名。",
	tools: "工具清单: bcdp_status, bcdp_space(+op:open/close/list/handoff/takeover), bcdp_watch, bcdp_snapshot, bcdp_navigate, bcdp_tab, bcdp_click(+double), bcdp_fill, bcdp_js, bcdp_cdp, bcdp_screenshot(+selector), bcdp_page_info, bcdp_wait(+op:duration/selector/url/response/load/function/request/event), bcdp_key(+text/type/insert), bcdp_hover, bcdp_read_element, bcdp_select, bcdp_drag, bcdp_scroll, bcdp_upload, bcdp_check, bcdp_dialog, bcdp_download, bcdp_http, bcdp_captcha, bcdp_auth_flush, bcdp_login_import, bcdp_diagnostics(+kind:network/console/pdf), bcdp_help, bcdp_doctor, bcdp_script(+verbatim), bcdp_jev_status, bcdp_jev_frame, bcdp_jev_attempt, bcdp_jev_ask, bcdp_jev_run。",
	links: "连接序列（设置面板）：有序列表，顺序即优先级，被激活的一项驱动每一次 bcdp_* 调用。两种类型——CDP 端点（注入 EGO_LINUX_CDP_URL，指向已开调试端口的浏览器）与 本机 ego CLI（不注入端点，由本机 ego CLI 直接驱动 ego 浏览器；仅限本机，全局至多一条）。cdpMode: auto=按激活项；remote=仅接受 CDP 端点；local=受管本地启动器。cdpMode=remote 与「本机 ego CLI」组合会显式报 mode-kind-mismatch。remoteEnabled 只管远端 CDP，不影响本机 CLI 连接。",
	navigate: "bcdp_navigate: 打开URL或切tab(同任务复用当前tab)。bcdp_wait op=url: 等跳转(登录/分页)。",
	observe: "bcdp_snapshot: 整页语义树(带[ref]/loc供点击); bcdp_page_info: url/标题/视口/滚动/对话框/人机验证; bcdp_read_element: 读单元素文本/HTML/值/属性/可见性/计数; bcdp_screenshot(+selector): 整页或元素截图。",
	input: "bcdp_click(selector/坐标, double双击); bcdp_fill(填框); bcdp_key(press组合键 或 text连续键入); bcdp_check(勾选/取消); bcdp_select(下拉); bcdp_upload(文件上传); bcdp_dialog(接受/取消JS对话框)。",
	"keyboard-mouse": "bcdp_key: 键盘(press/text); bcdp_hover: 悬停; bcdp_drag: 拖拽(元素或坐标); bcdp_scroll: 滚轮/滚到元素; bcdp_click: 点击/双击。",
	form: "bcdp_fill 填输入框; bcdp_select 下拉; bcdp_check checkbox/radio; bcdp_upload 文件; bcdp_key 回车/Tab导航; bcdp_dialog 处理提交弹窗。",
	wait: "bcdp_wait 一个工具八个 op：duration(固定毫秒); selector(等元素出现/消失, 可带 state); url(等跳转); response(等网络响应, body=text|json 可读体); load(等加载状态); function(页内表达式变真); request(等请求); event(等下载)。",
	network: "bcdp_http: 发HTTP请求(默认浏览器上下文 fetch.browser, mode=server走Node fetch.server); bcdp_wait op=response: 等并读接口响应; bcdp_diagnostics kind=network: 读最近请求/响应(方法/URL/状态/类型/耗时/失败原因)。",
	watch: "bcdp_watch: 显式打开侧边栏实时观察 Tab。默认普通 bcdp_* 调用不会自动展开；当用户需要实时观看页面/接管输入时调用。",
	diagnostics: "bcdp_diagnostics: 可选诊断工具(kind=network|console|pdf)。network/console 读取当前 target 的最近事件(1-300 条，默认 50)，用于排查接口、页面报错和控制台错误；pdf 用 Page.printToPDF 保存当前页到本地并返回 path。network/console 需要 worker 正在运行；targetId 可省略(默认为 worker active target)。",
	download: "bcdp_download: 等下载事件并落到指定路径(triggerSelector/triggerScript + 可选 savePath)。",
	captcha: "bcdp_captcha: 检测页面人机验证(CAPTCHA)并返回{detected,kind}; 检测到请让用户去 ego 浏览器完成; bcdp_page_info 也附带 humanCheck。",
	login: "bcdp_auth_flush: 把登录cookie落盘到ego profile; 观察窗登录引导条+『已登录,保存』按钮触发同一动作。bcdp_login_import: 从系统浏览器(Chrome/Edge/Brave)按域名导入登录cookie(source/domains/dryRun; 先dryRun看可导入项; ego浏览器须已在运行)。",
	script: "bcdp_script: 原样运行任意内置运行时 heredoc 脚本(page/browser/taskSpaces/site/fetch/cdp预载)。默认加 preamble(选区+激活真实 tab)并额外返回 duration/timedOut; verbatim:true 则完全原样、无 preamble(原 bcdp_cli 行为, 需自行 taskSpaces.useOrCreate)。",
	doctor: "bcdp_doctor: 体检环境（浏览器候选、vendored runtime、状态目录、CDP端口、任务空间、引擎与降级清单）；首行附工具注入面快照。",
	injection: "SEALED TOOLS — read this first when a bcdp_* tool you expect is missing from your tool list. Under toolInjection=lazy (the default) only bcdp_status stays registered — it is the unlock entry: calling it re-opens the other batches for this session. Every other batch (act / observe / wait / power / session / escape / judge) is deregistered until browser activity re-opens them; an idle reaper pass or a restart seals them again. Missing from the list = sealed, not broken, and not a wrong name. Fix: call bcdp_status (it counts as browser activity), then retry the tool. A call made before that fails with \"unknown tool\" at the harness level, before this plugin sees it. To keep all 34 resident instead, set toolInjection=always in the profile config. —— 以下为原说明：工具分级注入（不是工具，是出现时机）：34 个 bcdp_* 分八批——core（只 bcdp_status 一个：常驻且是解锁入口，不给开关）/ act（空间/导航/点击填写键鼠拖拽/tab 标签管理/指南/预检，13 个）/ observe（截图/页面信息/读取/js/snapshot，5 个）/ wait（bcdp_wait 全 op，1 个）/ power（裸CDP/HTTP/上传/下载/对话框，5 个）/ session（验证码/登录落盘/登录导入，3 个）/ escape（script 逃生舱，1 个）/ judge（bcdp_jev_*，5 个）——1+13+5+1+5+3+1+5=34。设置旋钮（全 volatile）：toolInjection = lazy（默认，只常驻 bcdp_status，首次 bcdp_* 调用后按批次铺开）/ always（挂载即全量，历史行为）；toolBrowse（act+observe+wait=19，内部按 act→observe→wait 三波放行）/ toolExtended（power+session=8）/ toolEscape（script=1）/ toolJudge（judge=5）四把开关——开 = 开放注册，关 = 该批从工具列表移除（core 级不给开关，封了就没解锁入口）；judge 级即使开了仍需配 JEV/Laya Key。**1.7.0 起 escape 与其它非 core 批同闸**：script 不再冷启动可用——先调 bcdp_status 即可拿到它；要回到「始终可达」，设 toolInjection=always。封印 = 从工具列表里反注册，不是执行期报错；lazy 下闲置回收会把扩展面收回。**若某个 bcdp_* 工具不在你的工具列表里**：它被分级封印了——先跑常驻的 bcdp_status（它算浏览器活动，会把面铺开），或让用户在设置页「工具封印」里打开对应档位的开关；别猜测不存在的工具名。",
	lightpanda: "Lightpanda 作为后端（无头文本渲染引擎，beta）：设置面板「添加 Lightpanda（受管）」——受管 serve 行（本机单例，插件负责拉起/复用/停止；win32 经 WSL2，linux/mac 本机直装），激活后 probe 自动识别 engine 并全链降级；也可用普通 CDP 端点接已自起的 serve（http://127.0.0.1:9222）。**有头/无头与顺序语义**：CDP 端点/本机 Chrome/ego CLI 是有头类型——可人工兜底（手动输账号、过验证码），是兜底主力；Lightpanda 是无头类型——无法人工介入，只适合快速试验。顺序即优先级：把 Lightpanda 排在前面 = 快速场景优先用它；排在有头类型后面 = 有头兜底优先，Lightpanda 实际不会被启用。安装——linux/macOS：`curl -fsSL https://pkg.lightpanda.io/install.sh | bash`（装入 ~/.local/bin，确保 PATH 含它），`lightpanda serve --host 127.0.0.1 --port 9222`；Windows：无原生版，用 WSL2（管理员 `wsl --install`，WSL 内同上；WSL2 自动把端口映射到宿主 localhost）或 Docker（`docker run -d -p 127.0.0.1:9222:9222 lightpanda/browser:nightly`）。可用：navigate/js/click/fill/key/snapshot(AX树)/http/login_import 等；降级：截图=PNG 文本渲染（jev 输出带 engine/rendering 元数据）；关闭：观察窗实时画面、面板点选、bcdp_download（调用即结构化报错）、auth_flush（返回 degraded）",
	judge: "JEV/Laya 判定（阶段 10）：机械采集「截图 + 编号 DOM + 意图 + 操作进度」→ 组装问题 → 取选择 → 执行 → 验证。判定器只能回传编号，绝不给选择器（幻觉选择器在结构上不可能）。四件套：bcdp_jev_status（先跑这个：判定链可用性 + 配置体检，不发任何请求）/ bcdp_jev_frame（采一帧，看判定器会看到什么）/bcdp_jev_ask（组装请求体；dryRun 默认 true，可指定 round=control|chapter|pick|evaluate 逐级看）/ bcdp_jev_run（跑循环，返回逐步 trace）。bcdp_jev_attempt（平的尝试循环）：给 url + goal，开页后每轮选项 = DOM 候选 + end 项，判定模型在 maxActions（默认 5）预算内行动或自选 end 结束，回执含每步 anchor；判定上下文只走 DOM 树文本（模型不读截图），完成后你用 bcdp_cdp/bcdp_screenshot 按 targetId 自行核验——回执是报告不是证明。**三级缩小**：control（要不要动手，固定 5 项）→ chapter（哪个章节，按 AX 容器聚簇）→ pick（章节内哪个编号 + 风险度）。分章节不是装饰：阈值按候选数分桶，把 20 选 1 拆成「几选 1 × 几选 1」会让两轮都落在更严的桶里。单章节时不问章节轮。**判定上下文是隔离的**：只允许 INTENT / PROGRESS / FRAME / HISTORY 四段，**绝不带 agent 会话 session 前缀**；多出任何一段都会在组装时直接抛错（不靠约定，靠断言）。PROGRESS 由循环自己机械生成，不让模型写（模型写的进度是第二个人幻觉通道）。**评估开关 jevEvaluate（默认开）**：每步执行后判定器再判进度 inprogress/done/fail；fail 或「未验真的 done」不猜下一步，直接 escalate——带有序 RecoveryOption（reload 排第一，因陈旧渲染会藏住已写入的确认），交回你来恢复或停手。被操作元素会保留 class 等定位特征（只剥离检视器外壳 token）随 escalate 回传，便于恢复。**默认链路是 laya -> rule**：JEV 目前无法注册，所以默认不写它；将来可用时把 jev 加回跳序并填 URL 即可。不可用的跳**跳过不调用**（laya-api 强制鉴权无匿名分支，缺 key 必然 401），每一跳的跳过与失败都记进 trace，绝不静默回落；refuse 是结果不是异常。阈值一律用选中项概率 top（不是 confidence：后者是归一化熵，2 选 1 与 20 选 1 不可比）。设置面板键：layaUrl/layaKey/layaModel（laya 端口 8000，不是 7789）、judgePrefer、jevChunkSize、jevMaxImageBytes、jevHistoryLimit、jevArchiveImage、jevStepBudget、jevWallMs；jevUrl/jevKey/jevModel 留空即可（JEV 未开放注册）。"
};

//#endregion
//#region src/captcha.ts
/**
* src/captcha.ts — human-verification (CAPTCHA) detection probe.
*
* Standalone data module: HUMAN_CHECK_PROBE is a string that gets serialized
* into a `page.evaluate` call to identify reCAPTCHA / hCaptcha / Turnstile /
* Cloudflare / generic captcha. When changing probe heuristics, note that
* bin/cdp-cast-worker.mjs (now src/worker/cdp-cast-worker.ts) has a similar
* probe (HUMAN_PROBE_JS) — the two must stay in sync.
*/
const HUMAN_CHECK_PROBE = `(() => {
  const sel = [
    'iframe[src*="recaptcha"]', '.g-recaptcha', '[data-sitekey]',
    '.h-captcha', 'iframe[src*="hcaptcha"]',
    '.cf-turnstile', 'iframe[src*="turnstile"]',
    'iframe[src*="cloudflare"]', '#challenge-form', '.challenge-form',
    '#captcha', '.captcha'
  ].join(',');
  const el = document.querySelector(sel);
  if (el) {
    const html = (el.outerHTML || '') + (el.closest('body') && el.closest('body').innerHTML ? '' : '');
    const s = String(html);
    if (/recaptcha|g-recaptcha/i.test(s)) return { detected: true, kind: 'recaptcha' };
    if (/hcaptcha|h-captcha/i.test(s)) return { detected: true, kind: 'hcaptcha' };
    if (/turnstile|cf-turnstile/i.test(s)) return { detected: true, kind: 'turnstile' };
    if (/cloudflare|challenge-form/i.test(s)) return { detected: true, kind: 'cloudflare' };
    return { detected: true, kind: 'captcha' };
  }
  const txt = (document.body ? document.body.innerText || '' : '').slice(0, 120000);
  const lower = txt.toLowerCase();
  if (/verify you are human|your activity looks unusual|captcha|i.?m not a robot|人机验证|安全验证|我是人类|验证码|滑块验证|拖动滑块|点击.*验证/.test(lower)) {
    return { detected: true, kind: 'captcha' };
  }
  return { detected: false, kind: null };
})()`;

//#endregion
//#region src/settings.ts
/**
* Wrap the `apply()` composition entry into a live config source.
*
* `source()` dereferences volatile fields on EVERY call, so consumers that
* re-read per operation (the `cfg` getters) always see the latest user-layer
* values without any re-registration. `onChange()` listeners are notified
* once per `loader/volatile-update`; the subscription is disposed with the
* plugin fiber.
*/
function installEgoBrowserSettings(ctx, config) {
	const listeners = /* @__PURE__ */ new Set();
	const notify = () => {
		for (const listener of [...listeners]) listener();
	};
	const disposeUpdate = ctx.on?.("loader/volatile-update", () => notify());
	ctx.effect?.(() => () => {
		disposeUpdate?.();
	});
	return {
		source: () => derefVolatileConfig(config),
		onChange: (cb) => {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		}
	};
}
function installSettingsAuto(ctx, config) {
	const legacySettings = ctx.settings;
	const legacyModule = (() => {
		try {
			return createRequire(import.meta.url)("@deepseek-ai/dsh-settings");
		} catch {
			return;
		}
	})();
	if (typeof legacyModule?.installSettingsSection === "function" && typeof legacyModule?.settingsNamespace === "function") {
		const listeners = /* @__PURE__ */ new Set();
		let current = derefVolatileConfig(config);
		const notify = () => {
			for (const listener of [...listeners]) listener();
		};
		const ns = legacyModule.settingsNamespace("dsh-browser-cdp");
		legacyModule.installSettingsSection(ctx, ns, Config$1, current, {
			setSource: (source) => {
				current = derefVolatileConfig((typeof source === "function" ? source() : source) ?? {});
			},
			onChange: () => {
				notify();
			}
		});
		return {
			source: () => current,
			onChange: (cb) => {
				listeners.add(cb);
				return () => {
					listeners.delete(cb);
				};
			}
		};
	}
	if (legacySettings && typeof legacySettings.installSection === "function") {
		const listeners = /* @__PURE__ */ new Set();
		let current = derefVolatileConfig(config);
		const notify = () => {
			for (const listener of [...listeners]) listener();
		};
		legacySettings.installSection(ctx, "dsh-browser-cdp", Config$1, current, {
			setSource: (source) => {
				current = derefVolatileConfig((typeof source === "function" ? source() : source) ?? {});
			},
			onChange: () => {
				notify();
			}
		});
		return {
			source: () => current,
			onChange: (cb) => {
				listeners.add(cb);
				return () => {
					listeners.delete(cb);
				};
			}
		};
	}
	return installEgoBrowserSettings(ctx, config);
}
const SETTINGS_BRIDGE_NS = "dsh-browser-cdp";
function bridgeSendJson(res, code, body) {
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(JSON.stringify(body));
}
function bridgeReadJson(req) {
	return new Promise((resolve$1, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buf.length;
			if (size > 256 * 1024) {
				reject(/* @__PURE__ */ new Error("bridge body too large"));
				if (typeof req.resume === "function") req.resume();
				return;
			}
			chunks.push(buf);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (raw === "") {
				resolve$1({});
				return;
			}
			try {
				resolve$1(JSON.parse(raw));
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
		req.on("error", reject);
	});
}
function bridgeDescribeNs(svc, ns) {
	return svc.describe({ redactSecrets: true }).find((d) => d.ns === ns);
}
/**
* 注册 /api/dsh-browser-cdp/settings/{describe,mutate} 两端点（kind:'exact'）。
* 宿主 settings 服务经惰性 ctx.get 取（cordis get 永不 throw；服务未解析时
* describe 回 settings-unavailable，client 桥按瞬态重试）。webServer 缺席的
* 宿主（TUI/headless）整段 no-op。
*/
function registerSettingsBridge(wctx, ctx) {
	const ws = wctx;
	if (!ws || typeof ws.register !== "function") return;
	const c = ctx;
	const getSettingsSvc = () => {
		try {
			return typeof c?.get === "function" ? c.get("settings") : void 0;
		} catch {
			return;
		}
	};
	ws.register({
		kind: "exact",
		path: `/api/${SETTINGS_BRIDGE_NS}/settings/describe`,
		handler: (req, res) => {
			if (req.method !== "POST") {
				bridgeSendJson(res, 405, {
					ok: false,
					code: "method-not-allowed"
				});
				return;
			}
			const svc = getSettingsSvc();
			if (!svc || typeof svc.describe !== "function") {
				bridgeSendJson(res, 200, {
					ok: false,
					code: "settings-unavailable",
					message: "settings service not resolved yet"
				});
				return;
			}
			try {
				const descriptor = bridgeDescribeNs(svc, SETTINGS_BRIDGE_NS);
				if (descriptor === void 0) {
					bridgeSendJson(res, 200, {
						ok: false,
						code: "ns-not-registered",
						message: `settings namespace "${SETTINGS_BRIDGE_NS}" is not registered`
					});
					return;
				}
				bridgeSendJson(res, 200, {
					ok: true,
					value: {
						descriptor,
						writable: svc.writable !== false
					}
				});
			} catch (e) {
				bridgeSendJson(res, 200, {
					ok: false,
					code: "internal",
					message: e instanceof Error ? e.message : String(e)
				});
			}
		}
	});
	ws.register({
		kind: "exact",
		path: `/api/${SETTINGS_BRIDGE_NS}/settings/mutate`,
		handler: (req, res) => {
			if (req.method !== "POST") {
				bridgeSendJson(res, 405, {
					ok: false,
					code: "method-not-allowed"
				});
				return;
			}
			const svc = getSettingsSvc();
			if (!svc || typeof svc.mutate !== "function") {
				bridgeSendJson(res, 200, {
					ok: false,
					code: "settings-unavailable",
					message: "settings service mutate not available"
				});
				return;
			}
			bridgeReadJson(req).then((body) => {
				const ops = body?.ops;
				if (!(Array.isArray(ops) && ops.every((op) => op !== null && typeof op === "object" && (op.op === "set" || op.op === "unset")))) {
					bridgeSendJson(res, 200, {
						ok: false,
						code: "settings-rejected",
						message: "malformed bridge mutate ops"
					});
					return;
				}
				const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : void 0;
				Promise.resolve(svc.mutate(SETTINGS_BRIDGE_NS, ops, expectedRevision)).then(() => {
					const descriptor = bridgeDescribeNs(svc, SETTINGS_BRIDGE_NS);
					if (descriptor === void 0) {
						bridgeSendJson(res, 200, {
							ok: false,
							code: "internal",
							message: `namespace "${SETTINGS_BRIDGE_NS}" disposed after mutate`
						});
						return;
					}
					bridgeSendJson(res, 200, {
						ok: true,
						value: { descriptor }
					});
				}).catch((e) => {
					const msg = e instanceof Error ? e.message : String(e);
					bridgeSendJson(res, 200, e instanceof Error && /conflict|revision/i.test(msg) ? {
						ok: false,
						code: "settings-conflict",
						message: msg
					} : {
						ok: false,
						code: "internal",
						message: msg
					});
				});
			}).catch((e) => {
				bridgeSendJson(res, 200, {
					ok: false,
					code: "bad-request",
					message: e instanceof Error ? e.message : String(e)
				});
			});
		}
	});
}

//#endregion
//#region src/toolTiers.ts
const CORE = ["bcdp_status"];
const ACT = [
	"bcdp_space",
	"bcdp_watch",
	"bcdp_navigate",
	"bcdp_click",
	"bcdp_fill",
	"bcdp_key",
	"bcdp_hover",
	"bcdp_scroll",
	"bcdp_select",
	"bcdp_check",
	"bcdp_drag",
	"bcdp_tab",
	"bcdp_help",
	"bcdp_doctor"
];
const OBSERVE = [
	"bcdp_screenshot",
	"bcdp_page_info",
	"bcdp_read_element",
	"bcdp_js",
	"bcdp_snapshot"
];
const WAIT = ["bcdp_wait"];
const POWER = [
	"bcdp_cdp",
	"bcdp_http",
	"bcdp_upload",
	"bcdp_download",
	"bcdp_dialog",
	"bcdp_diagnostics"
];
const SESSION = [
	"bcdp_captcha",
	"bcdp_auth_flush",
	"bcdp_login_import"
];
const ESCAPE = ["bcdp_script"];
const JUDGE = [
	"bcdp_jev_status",
	"bcdp_jev_ask",
	"bcdp_jev_frame",
	"bcdp_jev_run",
	"bcdp_jev_attempt"
];
/** 工具名 → 分级。`ego_*` 旧名（legacyEgoToolNames 别名）与 bcdp_* 同名同组。 */
const TIER_OF_TOOL = new Map([
	["core", CORE],
	["act", ACT],
	["observe", OBSERVE],
	["wait", WAIT],
	["power", POWER],
	["session", SESSION],
	["escape", ESCAPE],
	["judge", JUDGE]
].flatMap(([tier, names]) => names.map((n) => [n, tier])));
/** 分级成员表（测试与文档用）。 */
const TIER_MEMBERS = {
	core: CORE,
	act: ACT,
	observe: OBSERVE,
	wait: WAIT,
	power: POWER,
	session: SESSION,
	escape: ESCAPE,
	judge: JUDGE
};
/** 去掉 `bcdp_`/`ego_` 前缀后的裸名，便于策略表保持前缀无关。 */
const bareToolName = (name$1) => name$1.replace(/^(?:bcdp|ego)_/, "");
/** 批次放行顺序（索引即 rank）。 */
const BATCH_ORDER = [
	"act",
	"observe",
	"wait"
];
/**
* 工具所属分级。未登记的名字落到 `power`（最严的一档：宁可等活动解锁，也不
* 让新工具悄悄回到常驻面）；调用方应当在启动时打一条 warn，见
* `unknownTieredTools`。分级表漂移由 `tests/tool-tiers.test.ts` 的覆盖率断言
* 兜住，这里只是运行期兜底。
*/
function tierOfTool(name$1) {
	const bare = bareToolName(name$1);
	for (const [known, tier] of TIER_OF_TOOL) if (bareToolName(known) === bare) return tier;
	return "power";
}
/** 名单里所有查不到分级登记的工具名（启动自检 / 测试用）。 */
const unknownTieredTools = (names) => names.filter((n) => ![...TIER_OF_TOOL.keys()].some((k) => bareToolName(k) === bareToolName(n)));
/**
* 评审链是否「已配置」：至少有一个可用的 key。`layaUrl` 有默认值（sidecar
* 本机 8000），所以 URL 非空说明不了任何事——只有 key 才是配置证据。
* 两个 hop 独立可达，任一有 key 就算配置（见 config.ts 的 jev/laya 分离说明）。
*/
const judgeConfigured = (c) => (c.jevKey ?? "").trim() !== "" || (c.layaKey ?? "").trim() !== "";
/** 某级开关的当前极性；`core` 恒开放。 */
const tierOpen = (tier, p) => {
	switch (tier) {
		case "core": return true;
		case "act":
		case "observe":
		case "wait": return p.toolBrowse;
		case "power":
		case "session": return p.toolExtended;
		case "escape": return p.toolEscape;
		case "judge": return p.toolJudge;
	}
};
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
function tierAllowed(tier, p) {
	if (tier === "core") return true;
	if (!tierOpen(tier, p)) return false;
	if (tier === "judge" && !p.judgeConfigured) return false;
	if (p.injection === "always") return true;
	if (tier === "act" || tier === "observe" || tier === "wait") {
		if (!p.active) return false;
		const depth = p.batchDepth ?? BATCH_ORDER.length;
		return BATCH_ORDER.indexOf(tier) < depth;
	}
	return p.active;
}
/** 某工具此刻是否允许注册（名字 → 分级 → 策略）。 */
const toolAllowed = (name$1, p) => tierAllowed(tierOfTool(name$1), p);
function createTierInjector(o) {
	const label = o.label ?? "dsh-browser-cdp";
	/** 全部已登记工具，插入序。 */
	const all = /* @__PURE__ */ new Map();
	/** 此刻注册在宿主上的工具 → disposer。 */
	const live = /* @__PURE__ */ new Map();
	/** 无名字的工具（不该出现，兜底直注不误伤既有行为）。 */
	let anon = 0;
	const reapply = () => {
		const p = o.policy();
		const added = [];
		const removed = [];
		for (const [name$1, tool] of all) {
			const allowed = toolAllowed(name$1, p);
			if (allowed && !live.has(name$1)) {
				live.set(name$1, o.register(tool));
				added.push(name$1);
			} else if (!allowed && live.has(name$1)) {
				live.get(name$1)?.();
				live.delete(name$1);
				removed.push(name$1);
			}
		}
		if (added.length > 0) o.logger?.info?.(`${label}: 工具注入 +${added.length} (${added.join(" ")})`);
		if (removed.length > 0) o.logger?.warn?.(`${label}: 工具封印 -${removed.length} (${removed.join(" ")})`);
	};
	return {
		offer(tool) {
			const name$1 = typeof tool?.name === "string" ? tool.name : "";
			if (name$1 === "") {
				anon += 1;
				live.set(`#anon${anon}`, o.register(tool));
				return;
			}
			all.set(name$1, tool);
			reapply();
		},
		reapply,
		surface() {
			return {
				live: [...live.keys()],
				sealed: [...all.keys()].filter((n) => !live.has(n))
			};
		}
	};
}

//#endregion
//#region src/ffmpeg-manifest.ts
const BTBN_TAG = "autobuild-2026-08-17-13-05";
const BTBN_BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;
const STATIC_BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
const FFMPEG_MANIFEST = Object.freeze({
	"win32-x64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 170641412,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-win64-gpl.zip`,
		sha256: "423d30b197e52e20e0702278a30bc63e006cc383c968935874c4c13dda9eb299",
		executableName: "ffmpeg.exe",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i
	}),
	"win32-arm64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 116275753,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-winarm64-gpl.zip`,
		sha256: "451d181c0774f19dc7c30711911f3aad4f4ee4feb1cecb7b5efc1b895e093c67",
		executableName: "ffmpeg.exe",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i
	}),
	"linux-x64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 127977972,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linux64-gpl.tar.xz`,
		sha256: "646080fba1f295446fdf35fbdd4bad6ab934a30f9fcb86f3e96ad50eaff06c82",
		executableName: "ffmpeg",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg$/
	}),
	"linux-arm64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 109615592,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linuxarm64-gpl.tar.xz`,
		sha256: "7cda2218fe0107e449631eb6b850146a4522ebf4ed13733010d0aada9858b119",
		executableName: "ffmpeg",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg$/
	}),
	"darwin-x64": Object.freeze({
		provider: "evermeet",
		buildId: "ffmpeg-static-b6.1.1",
		archiveType: "gzip",
		size: 25296431,
		url: `${STATIC_BASE}/ffmpeg-darwin-x64.gz`,
		sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
		executableName: "ffmpeg"
	}),
	"darwin-arm64": Object.freeze({
		provider: "osxexperts",
		buildId: "ffmpeg-static-b6.1.1",
		archiveType: "gzip",
		size: 19246198,
		url: `${STATIC_BASE}/ffmpeg-darwin-arm64.gz`,
		sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
		executableName: "ffmpeg"
	})
});
function platformManifest(platform = process.platform, arch = process.arch) {
	return FFMPEG_MANIFEST[`${platform}-${arch}`] ?? null;
}
function rewriteGithubUrl(url, mirror = "") {
	if (!mirror || !url.startsWith("https://github.com/")) return url;
	let parsed;
	try {
		parsed = new URL(mirror);
	} catch {
		throw codedError$2("ffmpeg-mirror-invalid", "GitHub mirror must be a valid HTTPS URL");
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw codedError$2("ffmpeg-mirror-invalid", "GitHub mirror must be an HTTPS base URL without credentials, query, or fragment");
	return `${parsed.toString().replace(/\/+$/, "")}${url.slice(18)}`;
}
function codedError$2(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

//#endregion
//#region src/ffmpeg-probe.ts
function runFfmpegProbe(path, argv, { spawn: spawn$1 = spawn, timeoutMs = 3e3 } = {}) {
	return new Promise((resolve$1) => {
		let child;
		let output = "";
		let settled = false;
		const finish$1 = (ok) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve$1({
				ok,
				output
			});
		};
		try {
			child = spawn$1(path, argv, {
				shell: false,
				windowsHide: true,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
		} catch {
			resolve$1({
				ok: false,
				output
			});
			return;
		}
		child.stdout?.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.once("error", () => finish$1(false));
		child.once("exit", (code) => finish$1(code === 0));
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
			finish$1(false);
		}, timeoutMs);
	});
}
async function probeFfmpeg(path, { platform = process.platform, env = process.env, spawn: spawn$1 = spawn, requestedEncoder = "auto" } = {}) {
	const versionResult = await runFfmpegProbe(path, ["-version"], { spawn: spawn$1 });
	if (!versionResult.ok) throw codedError$1("ffmpeg-not-executable", `FFmpeg is not executable: ${path}`);
	const version = versionResult.output.split(/\r?\n/, 1)[0] || "FFmpeg";
	if (platform === "win32") {
		const support = await runFfmpegProbe(path, [
			"-hide_banner",
			"-h",
			"filter=gfxcapture"
		], { spawn: spawn$1 });
		if (!support.ok || !/Filter gfxcapture\b/.test(support.output)) throw codedError$1("ffmpeg-gfxcapture-unavailable", "FFmpeg does not support Windows gfxcapture");
	} else if (platform === "darwin") {
		const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn: spawn$1 });
		if (!devices.ok || !/avfoundation/i.test(devices.output)) throw codedError$1("ffmpeg-capture-input-unavailable", "FFmpeg does not support avfoundation capture");
	} else if (platform === "linux") {
		if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) throw codedError$1("ffmpeg-platform-unsupported", "Wayland capture is not supported");
		const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn: spawn$1 });
		if (!devices.ok || !/x11grab/i.test(devices.output)) throw codedError$1("ffmpeg-capture-input-unavailable", "FFmpeg does not support x11grab capture");
	}
	const encoders = requestedEncoder === "auto" ? platform === "win32" ? [
		"h264_mf",
		"h264_nvenc",
		"h264_qsv",
		"h264_amf",
		"libx264"
	] : platform === "darwin" ? ["h264_videotoolbox", "libx264"] : [
		"h264_nvenc",
		"h264_vaapi",
		"h264_qsv",
		"libx264"
	] : [requestedEncoder === "software" ? "libx264" : requestedEncoder];
	for (const encoder$1 of encoders) if ((await runFfmpegProbe(path, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=size=64x64:rate=1",
		"-frames:v",
		"1",
		"-c:v",
		encoder$1,
		"-f",
		"null",
		"-"
	], {
		spawn: spawn$1,
		timeoutMs: 5e3
	})).ok) return {
		version,
		encoder: encoder$1
	};
	throw codedError$1("ffmpeg-encoder-unavailable", "FFmpeg has no usable H.264 encoder");
}
function codedError$1(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

//#endregion
//#region src/ffmpeg-installation.ts
function defaultFfmpegCacheRoot(home = homedir()) {
	return join(home, ".dsh", "cache", "dsh-browser-cdp", "ffmpeg");
}
const SHARED_MANAGERS_KEY = Symbol.for("dsh-browser-cdp.ffmpeg-installation-managers");
function getSharedManagers() {
	const existing = globalThis[SHARED_MANAGERS_KEY];
	if (existing) return existing;
	const fresh = /* @__PURE__ */ new Map();
	globalThis[SHARED_MANAGERS_KEY] = fresh;
	return fresh;
}
function getSharedFfmpegInstallationManager(options = {}) {
	const platform = options.platform || process.platform;
	const arch = options.arch || process.arch;
	const cacheRoot = options.cacheRoot || defaultFfmpegCacheRoot();
	const key = `${platform}:${arch}:${cacheRoot}`;
	const managers = getSharedManagers();
	if (!managers.has(key)) managers.set(key, new FfmpegInstallationManager({
		...options,
		platform,
		arch,
		cacheRoot
	}));
	return managers.get(key);
}
var FfmpegInstallationManager = class {
	getConfig;
	platform;
	arch;
	env;
	cacheRoot;
	fetch;
	spawn;
	manifest;
	installPromise;
	checkPromise;
	checkKey;
	statusValue;
	constructor({ getConfig = () => ({}), platform = process.platform, arch = process.arch, env = process.env, cacheRoot = defaultFfmpegCacheRoot(), fetchImpl = globalThis.fetch, spawn: spawn$1 = spawn } = {}) {
		this.getConfig = getConfig;
		this.platform = platform;
		this.arch = arch;
		this.env = env;
		this.cacheRoot = cacheRoot;
		this.fetch = fetchImpl;
		this.spawn = spawn$1;
		this.manifest = platformManifest(platform, arch);
		this.installPromise = null;
		this.checkPromise = null;
		this.checkKey = null;
		this.statusValue = this.#baseStatus();
	}
	#baseStatus() {
		const unsupported = this.platform === "linux" && (this.env.XDG_SESSION_TYPE === "wayland" || this.env.WAYLAND_DISPLAY);
		return {
			state: unsupported ? "unsupported" : "missing",
			source: null,
			path: null,
			version: null,
			encoder: null,
			progress: null,
			canDownload: !unsupported && !!this.manifest,
			canSelectFfmpeg: false,
			updateAvailable: false,
			reason: unsupported ? "Wayland capture is not supported" : null,
			candidates: [],
			platform: this.platform,
			arch: this.arch,
			buildId: this.manifest?.buildId || null
		};
	}
	status() {
		return structuredClone(this.statusValue);
	}
	managedPath() {
		if (!this.manifest) return null;
		return join(this.cacheRoot, `${this.platform}-${this.arch}`, this.manifest.buildId, this.manifest.executableName);
	}
	async check({ configuredPath, requestedEncoder = "auto" } = {}) {
		if (this.installPromise) return this.status();
		const key = JSON.stringify([configuredPath ?? "", requestedEncoder]);
		if (this.checkPromise) {
			if (this.checkKey === key) return this.checkPromise;
			await this.checkPromise.catch(() => {});
		}
		if (this.statusValue.state === "unsupported") return this.status();
		this.checkKey = key;
		const promise = this.#check(configuredPath, requestedEncoder).finally(() => {
			if (this.checkPromise === promise) {
				this.checkPromise = null;
				this.checkKey = null;
			}
		});
		this.checkPromise = promise;
		return this.checkPromise;
	}
	async #check(configuredPath, requestedEncoder = "auto") {
		this.#set({
			state: "checking",
			reason: null,
			progress: null,
			canSelectFfmpeg: false
		});
		const custom = configuredPath ?? this.getConfig().ffmpegPath ?? "";
		const candidates = [];
		if (custom) candidates.push({
			source: "custom",
			path: custom
		});
		candidates.push({
			source: "system",
			path: "ffmpeg"
		});
		const managed = this.managedPath();
		if (managed) candidates.push({
			source: "managed",
			path: managed
		});
		const results = [];
		for (const candidate of candidates) try {
			const probe = await probeFfmpeg(candidate.path, {
				platform: this.platform,
				env: this.env,
				spawn: this.spawn,
				requestedEncoder
			});
			results.push({
				...candidate,
				usable: true,
				version: probe.version,
				encoder: probe.encoder
			});
			this.#set({
				state: "ready",
				source: candidate.source,
				path: candidate.path,
				version: probe.version,
				encoder: probe.encoder,
				canSelectFfmpeg: true,
				canDownload: !!this.manifest,
				reason: null,
				candidates: results,
				updateAvailable: candidate.source === "managed" && !normalize(candidate.path).includes(normalize(this.manifest?.buildId || ""))
			});
			return this.status();
		} catch (error) {
			const e = error;
			results.push({
				...candidate,
				usable: false,
				code: e.code || "ffmpeg-unavailable",
				reason: e.message
			});
		}
		this.#set({
			...this.#baseStatus(),
			state: "missing",
			candidates: results,
			reason: results[0]?.reason || "No compatible FFmpeg installation was found"
		});
		return this.status();
	}
	async resolvedPath() {
		const status = this.statusValue.state === "ready" ? this.status() : await this.check();
		return status.canSelectFfmpeg ? status.path : null;
	}
	install({ githubMirror, configuredPath, requestedEncoder = "auto" } = {}) {
		if (this.installPromise) return this.installPromise;
		if (!this.manifest) return Promise.reject(codedError("ffmpeg-platform-unsupported", `No managed FFmpeg build for ${this.platform}-${this.arch}`));
		this.installPromise = this.#install(githubMirror ?? this.getConfig().githubMirror ?? "", configuredPath ?? this.getConfig().ffmpegPath ?? "", requestedEncoder).finally(() => {
			this.installPromise = null;
		});
		return this.installPromise;
	}
	startInstall(options = {}) {
		this.install(options).catch(() => {});
		return this.status();
	}
	async #install(githubMirror, configuredPath, requestedEncoder) {
		const manifest = this.manifest;
		const platformRoot = join(this.cacheRoot, `${this.platform}-${this.arch}`);
		const tempRoot = join(platformRoot, `.install-${randomUUID()}`);
		const archivePath = join(tempRoot, `archive.${manifest.archiveType === "gzip" ? "gz" : "pkg"}`);
		const extractedPath = join(tempRoot, manifest.executableName);
		const finalRoot = join(platformRoot, manifest.buildId);
		const finalPath = join(finalRoot, manifest.executableName);
		let releaseLock = null;
		let backup = null;
		let published = false;
		try {
			await mkdir(platformRoot, { recursive: true });
			releaseLock = await acquireInstallLock(platformRoot);
			await cleanupInterruptedInstalls(platformRoot);
			if (manifest.archiveType === "tar") await ensureTarAvailable(this.spawn);
			await mkdir(tempRoot, { recursive: true });
			const url = rewriteGithubUrl(manifest.url, githubMirror);
			this.#set({
				state: "downloading",
				reason: null,
				progress: {
					receivedBytes: 0,
					totalBytes: manifest.size,
					percent: 0
				},
				canSelectFfmpeg: false
			});
			const digest = await downloadFile(url, archivePath, {
				fetchImpl: this.fetch,
				expectedSize: manifest.size,
				onProgress: (progress) => this.#set({
					state: "downloading",
					progress
				})
			});
			this.#set({
				state: "verifying",
				progress: null
			});
			if (digest !== manifest.sha256) throw codedError("ffmpeg-checksum-mismatch", "Downloaded FFmpeg archive failed SHA-256 verification");
			this.#set({ state: "extracting" });
			if (manifest.archiveType === "gzip") await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(extractedPath, { mode: 493 }));
			else await extractWithTar(archivePath, tempRoot, extractedPath, manifest.archiveExecutable, this.spawn);
			if (this.platform !== "win32") await chmod(extractedPath, 493);
			if (this.platform === "darwin") await prepareMacExecutable(extractedPath, this.arch, this.spawn);
			this.#set({ state: "probing" });
			const probe = await probeFfmpeg(extractedPath, {
				platform: this.platform,
				env: this.env,
				spawn: this.spawn,
				requestedEncoder
			});
			const executableSha256 = await hashFile(extractedPath);
			await writeFile(join(tempRoot, "install.json"), JSON.stringify({
				provider: manifest.provider,
				buildId: manifest.buildId,
				archiveSha256: manifest.sha256,
				executableSha256,
				installedAt: (/* @__PURE__ */ new Date()).toISOString(),
				version: probe.version,
				encoder: probe.encoder
			}, null, 2));
			await rm(archivePath, { force: true });
			backup = `${finalRoot}.old-${randomUUID()}`;
			let hadExisting = false;
			try {
				await rename(finalRoot, backup);
				hadExisting = true;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await mkdir(dirname(finalRoot), { recursive: true });
			await rename(tempRoot, finalRoot);
			published = true;
			await access(finalPath, this.platform === "win32" ? constants.F_OK : constants.X_OK);
			if (hadExisting) await rm(backup, {
				recursive: true,
				force: true
			});
			backup = null;
			return await this.#check(configuredPath, requestedEncoder);
		} catch (error) {
			if (published) await rm(finalRoot, {
				recursive: true,
				force: true
			}).catch(() => {});
			if (backup) await rename(backup, finalRoot).catch(() => {});
			await rm(tempRoot, {
				recursive: true,
				force: true
			}).catch(() => {});
			const e = error;
			this.#set({
				state: "failed",
				reason: e.message,
				progress: null,
				canSelectFfmpeg: false,
				canDownload: true
			});
			throw error;
		} finally {
			await releaseLock?.();
		}
	}
	#set(patch) {
		this.statusValue = {
			...this.statusValue,
			...patch
		};
	}
};
async function acquireInstallLock(platformRoot) {
	const lockPath = join(platformRoot, ".install.lock");
	const token = randomUUID();
	for (let attempt = 0; attempt < 2; attempt += 1) try {
		const handle = await open(lockPath, "wx");
		await handle.writeFile(JSON.stringify({
			token,
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		}));
		return async () => {
			await handle.close().catch(() => {});
			if ((await readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null))?.token === token) await rm(lockPath, { force: true }).catch(() => {});
		};
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const owner = await readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
		if (!owner?.pid || !isProcessAlive(owner.pid)) {
			await rm(lockPath, { force: true });
			continue;
		}
		throw codedError("ffmpeg-install-busy", "Another FFmpeg installation is already running");
	}
	throw codedError("ffmpeg-install-busy", "Another FFmpeg installation is already running");
}
function isProcessAlive(pid) {
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
async function cleanupInterruptedInstalls(platformRoot) {
	const entries = await readdir(platformRoot, { withFileTypes: true }).catch((error) => {
		return error.code === "ENOENT" ? [] : Promise.reject(error);
	});
	await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(".install-")).map((entry) => rm(join(platformRoot, entry.name), {
		recursive: true,
		force: true
	})));
}
async function downloadFile(url, target, { fetchImpl = globalThis.fetch, expectedSize = null, onProgress = () => {}, maxBytes = 250 * 1024 * 1024 } = {}) {
	let current = url;
	let response;
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		assertSafeDownloadUrl(current);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15e3);
		try {
			response = await fetchImpl(current, {
				redirect: "manual",
				signal: controller.signal
			});
		} finally {
			clearTimeout(timer);
		}
		if (![
			301,
			302,
			303,
			307,
			308
		].includes(response.status)) break;
		const location = response.headers.get("location");
		if (!location) throw codedError("ffmpeg-download-failed", "FFmpeg download redirect omitted Location");
		current = new URL(location, current).toString();
		await response.body?.cancel().catch(() => {});
		if (!current.startsWith("https://")) throw codedError("ffmpeg-download-failed", "FFmpeg download refused a non-HTTPS redirect");
		if (redirects === 5) throw codedError("ffmpeg-download-failed", "Too many FFmpeg download redirects");
	}
	if (!response?.ok || !response.body) throw codedError("ffmpeg-download-failed", `FFmpeg download failed with HTTP ${response?.status || 0}`);
	const declared = Number(response.headers.get("content-length")) || expectedSize || null;
	const hash = createHash("sha256");
	const file = await open(target, "w");
	let received = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await readChunk(reader, 3e4);
			if (done) break;
			const buffer = Buffer.from(value);
			received += buffer.length;
			if (received > maxBytes) throw codedError("ffmpeg-download-failed", "FFmpeg archive exceeds the allowed size");
			hash.update(buffer);
			await file.write(buffer);
			onProgress({
				receivedBytes: received,
				totalBytes: declared,
				percent: declared ? Math.min(100, Math.round(received * 100 / declared)) : null
			});
		}
	} finally {
		await reader.cancel().catch(() => {});
		await file.close();
	}
	return hash.digest("hex");
}
async function ensureTarAvailable(spawn$1) {
	try {
		await runCommand("tar", ["--version"], spawn$1, 5e3);
	} catch {
		throw codedError("ffmpeg-extractor-unavailable", "The managed FFmpeg archive requires the system tar extractor");
	}
}
function assertSafeDownloadUrl(value) {
	const url = new URL(value);
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (url.protocol !== "https:" || host === "localhost" || host.endsWith(".localhost") || isPrivateIp(host)) throw codedError("ffmpeg-download-failed", "FFmpeg downloads require a public HTTPS destination");
}
function isPrivateIp(host) {
	const family = isIP(host);
	if (family === 4) {
		const [a, b] = host.split(".").map(Number);
		return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
	}
	if (family === 6) return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
	return false;
}
async function extractWithTar(archivePath, tempRoot, destination, matcher, spawn$1) {
	const matches = (await runCommand("tar", ["-tf", archivePath], spawn$1, 15e3)).stdout.split(/\r?\n/).filter(Boolean).filter((entry$1) => safeArchiveEntry(entry$1) && matcher.test(entry$1));
	if (matches.length !== 1) throw codedError("ffmpeg-executable-missing", `Expected one FFmpeg executable in archive, found ${matches.length}`);
	const entry = matches[0];
	await runCommand("tar", [
		"-xf",
		archivePath,
		"-C",
		tempRoot,
		entry
	], spawn$1, 6e4);
	const extracted = resolve(tempRoot, normalize(entry));
	if (!extracted.startsWith(resolve(tempRoot) + sep)) throw codedError("ffmpeg-archive-unsafe", "FFmpeg archive path escaped the install directory");
	await copyFile(extracted, destination);
}
function safeArchiveEntry(entry) {
	const value = entry.replaceAll("\\", "/");
	return value !== "" && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").includes("..");
}
async function prepareMacExecutable(path, arch, spawn$1) {
	await runCommand("xattr", [
		"-d",
		"com.apple.quarantine",
		path
	], spawn$1, 5e3).catch(() => {});
	if (arch === "arm64") await runCommand("codesign", [
		"--force",
		"--sign",
		"-",
		path
	], spawn$1, 15e3).catch(() => {});
}
async function hashFile(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
function readChunk(reader, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(codedError("ffmpeg-download-timeout", "FFmpeg download stalled")), timeoutMs);
		reader.read().then((value) => {
			clearTimeout(timer);
			resolvePromise(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
function runCommand(command, argv, spawn$1, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn$1(command, argv, {
			shell: false,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish$1 = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => finish$1(reject, error));
		child.once("exit", (code) => code === 0 ? finish$1(resolvePromise, {
			stdout,
			stderr
		}) : finish$1(reject, codedError("ffmpeg-archive-invalid", stderr || `${command} exited with ${code}`)));
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish$1(reject, codedError("ffmpeg-archive-invalid", `${command} timed out`));
		}, timeoutMs);
	});
}
function codedError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

//#endregion
//#region src/util.ts
/**
* src/util.ts — shared small helpers (sentinel / type coercion / JSON helpers).
*
* Factored out of index.ts for reuse by other modules. No ctx/cfg dependency,
* no side effects.
*/
const SENTINEL = "@@DSH_RESULT@@";
const j = (v) => JSON.stringify(v);
const str = (v, fallback) => typeof v === "string" && v !== "" ? v : fallback;
const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v, fallback) => typeof v === "boolean" ? v : fallback;
/** Inline helper making arbitrary helper results JSON-safe for the payload. */
const SAFE_FN = "function safe(v){try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}}\n";
/**
* Build an IN-PAGE wrapper that resolves a JS expression to a value that is
* already safe to cross the CDP boundary.
*
* WHY in-page, not outer: `page.evaluate` / `page.waitForFunction` serialize
* their result INSIDE the runtime's `handleMessage` (ego SDK index.js:539 — a
* hard reject, not a catchable throw), so a deeply-cyclic global like
* `window.top` kills the whole subprocess with "Object reference chain is too
* long" before any outer `safe()` could see the value. Doing the stringify/
* toString degradation inside the page (where the object graph actually lives)
* is the only place the reference chain can be bounded.
*
* Semantics preserved per-call:
*  - primitives and plain (non-cyclic) objects round-trip UNCHANGED;
*  - cyclic/DOM/global handles degrade to `Object.prototype.toString` or a
*    `<tagName>` hint;
*  - with `preserveFalsy`, a falsy result is returned as-is (the waitForFunction
*    truthiness contract depends on falsy meaning "not satisfied yet"), and a
*    truthy handle is always degraded to a TRUTHY string so the wait still
*    resolves.
*
* @internal exported for tests
*/
function safeEvalWrap(expr, preserveFalsy = false) {
	return `(() => {\nconst __v = (${expr});\n${preserveFalsy ? "if (!__v) return __v;\n" : ""}if (__v === null || typeof __v !== 'object') return __v;\ntry { const __s = JSON.stringify(__v); return __s === undefined ? Object.prototype.toString.call(__v) : JSON.parse(__s); }\ncatch { try { if (__v.tagName) return '<' + String(__v.tagName).toLowerCase() + '>' + (typeof __v.getAttribute === 'function' && __v.getAttribute('id') ? '#' + __v.getAttribute('id') : ''); return Object.prototype.toString.call(__v); } catch { return String(__v); } }\n})()`;
}
/** Read an entire subprocess reader's buffered output. */
function readAll(reader) {
	if (!reader) return "";
	return reader.readFrom(0).text;
}

//#endregion
//#region src/jev/wire.ts
const noul = (instructions, criteria) => criteria === void 0 ? {
	type: "noul",
	instructions
} : {
	type: "noul",
	instructions,
	criteria
};
const choice = (instructions, criteria) => ({
	type: "choice",
	instructions,
	criteria
});
/** `choice` options: an option table is a fixed head budget, so more is worse. */
const MAX_CHOICE_OPTIONS = 255;
/** `score` levels: ≥2 to be a scale at all, ≤10 per the protocol. */
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;
const MAX_QUESTIONS = 256;
/**
* Validate a question set against the SERVER's rules.
*
* Returns every issue rather than the first, because a caller fixing one 422 at
* a time over a network round trip is the slowest possible way to converge.
* `over`-limits are separated from `invalid`-shapes: an over-limit table is a
* design decision to revisit, a wrong shape is a bug.
*/
function validateQuestions(questions) {
	const issues = [];
	const ids = Object.keys(questions);
	if (ids.length === 0) issues.push({
		code: "questions-empty",
		message: "a request needs at least one question",
		questionId: ""
	});
	if (ids.length > MAX_QUESTIONS) issues.push({
		code: "questions-over-limit",
		message: `${ids.length} questions exceeds the protocol limit of ${MAX_QUESTIONS}`,
		questionId: ""
	});
	for (const id of ids) {
		const question = questions[id];
		if (question === void 0) continue;
		if (question.type === "noul") {
			if (question.instructions.trim() === "") issues.push({
				code: "noul-instructions-empty",
				message: "noul needs instructions",
				questionId: id
			});
			continue;
		}
		if (question.type === "choice") {
			const keys = Object.keys(question.criteria);
			if (keys.length === 0) issues.push({
				code: "choice-criteria-empty",
				message: "a choice question needs a non-empty option table — an empty candidate list is not a valid question",
				questionId: id
			});
			else if (keys.length > MAX_CHOICE_OPTIONS) issues.push({
				code: "choice-criteria-over-limit",
				message: `${keys.length} options exceeds the protocol limit of ${MAX_CHOICE_OPTIONS}`,
				questionId: id
			});
			continue;
		}
		const levels = question.criteria;
		if (levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) issues.push({
			code: "score-criteria-out-of-range",
			message: `a score question needs ${MIN_SCORE_LEVELS}..${MAX_SCORE_LEVELS} levels (got ${levels.length})`,
			questionId: id
		});
	}
	return issues;
}
/** Build the request body. Only the three allowed keys are ever emitted. */
function buildSystemOneRequest(state, questions, model) {
	return {
		model,
		state,
		questions
	};
}
/**
* Coerce a server answer set into ours, and REPORT what it could not use.
*
* The rule this follows was learned in JevLoop's own parser and is worth
* repeating: a malformed answer is MORE dangerous than a failed request. A
* failure is caught by the fallback chain; a fabricated `0` is a definite
* "no" that silently steers the loop. So a value-free answer is DROPPED and
* named, never defaulted.
*/
function normalizeAnswers(raw, expected) {
	const answers = {};
	const dropped = [];
	if (raw === null || typeof raw !== "object") return {
		answers,
		dropped,
		missing: [...expected]
	};
	for (const [id, value] of Object.entries(raw)) {
		if (value === null || typeof value !== "object") {
			dropped.push(id);
			continue;
		}
		const record = value;
		if (isFiniteNumber(record.noul)) {
			answers[id] = {
				type: "noul",
				noul: clamp(record.noul, 0, 1)
			};
			continue;
		}
		if (typeof record.choice === "string" && record.choice !== "") {
			const probabilities = numberMap(record.probabilities);
			answers[id] = {
				type: "choice",
				choice: record.choice,
				probabilities,
				confidence: isFiniteNumber(record.confidence) ? record.confidence : maxOf(probabilities)
			};
			continue;
		}
		if (isFiniteNumber(record.score)) {
			const probabilities = numberMap(record.probabilities);
			answers[id] = {
				type: "score",
				score: record.score,
				legend: stringMap(record.legend),
				probabilities,
				confidence: isFiniteNumber(record.confidence) ? record.confidence : maxOf(probabilities)
			};
			continue;
		}
		dropped.push(id);
	}
	return {
		answers,
		dropped,
		missing: expected.filter((id) => !(id in answers))
	};
}
/**
* The probability of the option that was picked.
*
* This — not `confidence` — is the number a threshold may use. `confidence` is
* a normalised entropy (`1 - H/log(k)`), so the same threshold means something
* different at 2 options and at 20; a bare `top` threshold does not move when
* the option table grows.
*/
function topProbability(answer) {
	if (answer === void 0) return 0;
	if (answer.type === "choice") return answer.probabilities[answer.choice] ?? 0;
	if (answer.type === "noul") return Math.max(answer.noul, 1 - answer.noul);
	return answer.confidence ?? 0;
}
/** The runner-up's probability — what a margin threshold compares against. */
function runnerUpProbability(answer) {
	if (answer === void 0 || answer.type !== "choice") return 0;
	return Object.values(answer.probabilities).sort((a, b) => b - a)[1] ?? 0;
}
/**
* The choice gate: `top ≥ minTop` AND (`top - runnerUp ≥ minMargin`).
*
* Both halves are required. A top of 0.8 with a runner-up of 0.79 is a coin
* flip wearing a confident number, and acting on it is how an agent clicks the
* wrong button while every metric says it was sure.
*/
function checkChoiceMargin(answer, minTop, minMargin) {
	if (answer === void 0) return {
		ok: false,
		top: 0,
		runnerUp: 0,
		margin: 0,
		code: "no-answer"
	};
	const top = topProbability(answer);
	const second = runnerUpProbability(answer);
	const margin = Math.max(0, top - second);
	if (top < minTop) return {
		ok: false,
		top,
		runnerUp: second,
		margin,
		code: "below-top"
	};
	if (margin < minMargin) return {
		ok: false,
		top,
		runnerUp: second,
		margin,
		code: "below-margin"
	};
	return {
		ok: true,
		top,
		runnerUp: second,
		margin,
		code: ""
	};
}
const THRESHOLD_BUCKETS = [
	{
		maxCandidates: 5,
		minTop: .6,
		minMargin: 0
	},
	{
		maxCandidates: 8,
		minTop: .6,
		minMargin: .1
	},
	{
		maxCandidates: 20,
		minTop: .5,
		minMargin: .15
	}
];
/** The bucket for a candidate count. Above the last bucket, the strictest applies. */
function bucketFor(candidateCount) {
	for (const bucket of THRESHOLD_BUCKETS) if (candidateCount <= bucket.maxCandidates) return bucket;
	return THRESHOLD_BUCKETS[THRESHOLD_BUCKETS.length - 1] ?? {
		maxCandidates: 20,
		minTop: .5,
		minMargin: .15
	};
}
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
function numberMap(value) {
	const out = {};
	if (value === null || typeof value !== "object") return out;
	for (const [key, raw] of Object.entries(value)) {
		const num$1 = Number(raw);
		if (Number.isFinite(num$1)) out[key] = num$1;
	}
	return out;
}
function stringMap(value) {
	const out = {};
	if (value === null || typeof value !== "object") return out;
	for (const [key, raw] of Object.entries(value)) if (typeof raw === "string") out[key] = raw;
	return out;
}
function maxOf(map) {
	const values = Object.values(map);
	return values.length === 0 ? 0 : Math.max(...values);
}

//#endregion
//#region src/jev/judge.ts
/** The canonical provider order. Index order is priority order. */
const PROVIDER_ORDER = [
	"jev",
	"laya",
	"rule",
	"refuse"
];
const defaultJudgeDeps = () => ({
	fetch: (...args) => globalThis.fetch(...args),
	now: () => Date.now()
});
/**
* One HTTP judge. `jev` and `laya` are the same class with different config,
* because they ARE the same protocol — the only differences that matter are the
* endpoint, the key, and the model name.
*/
var HttpJudgeProvider = class {
	name;
	config;
	constructor(name$1, config) {
		this.name = name$1;
		this.config = config;
	}
	available() {
		if (this.config.baseUrl.trim() === "") return {
			ok: false,
			reason: `${this.name}-no-base-url`
		};
		if (this.config.apiKey.trim() === "") return {
			ok: false,
			reason: `${this.name}-no-api-key`
		};
		if (this.config.model.trim() === "") return {
			ok: false,
			reason: `${this.name}-no-model`
		};
		return {
			ok: true,
			reason: ""
		};
	}
	async decide(req, deps) {
		const started = deps.now();
		const fatal = validateQuestions(req.questions).filter((issue) => issue.code !== "choice-criteria-over-limit");
		if (fatal.length > 0) return refuse(this.name, started, deps.now(), fatal.map((issue) => `${issue.code}:${issue.questionId}`));
		const body = buildSystemOneRequest(req.state, req.questions, this.config.model);
		const url = `${this.config.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
		try {
			const response = await deps.fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.config.apiKey}`
				},
				body: JSON.stringify(body),
				signal: controller.signal
			});
			if (!response.ok) return refuse(this.name, started, deps.now(), [`http-${response.status}`]);
			const payload = await response.json();
			const normalized = normalizeAnswers(payload.answers, Object.keys(req.questions));
			const latencyMs = deps.now() - started;
			const warnings = [];
			if (normalized.dropped.length > 0) warnings.push({
				code: "answers-dropped",
				message: `${this.name} returned unusable values for: ${normalized.dropped.join(", ")}`,
				provider: this.name
			});
			return {
				answers: normalized.answers,
				provider: this.name,
				model: typeof payload.model === "string" ? payload.model : this.config.model,
				latencyMs,
				usage: payload.usage === void 0 ? void 0 : { raw: payload.usage },
				degraded: false,
				trace: [],
				warnings,
				dropped: normalized.dropped,
				missing: normalized.missing
			};
		} catch (error) {
			const code = controller.signal.aborted ? "timeout" : "network";
			return refuse(this.name, started, deps.now(), [`${code}:${messageOf$2(error)}`]);
		} finally {
			clearTimeout(timer);
		}
	}
};
var RuleJudgeProvider = class {
	name = "rule";
	rule;
	constructor(rule) {
		this.rule = rule;
	}
	available() {
		return {
			ok: true,
			reason: ""
		};
	}
	async decide(req, deps) {
		const started = deps.now();
		let answers = {};
		const warnings = [];
		try {
			answers = this.rule(req);
		} catch (error) {
			warnings.push({
				code: "rule-threw",
				message: messageOf$2(error),
				provider: "rule"
			});
		}
		const normalized = normalizeAnswers(answers, Object.keys(req.questions));
		return {
			answers: normalized.answers,
			provider: "rule",
			model: "rule",
			latencyMs: deps.now() - started,
			degraded: true,
			trace: [],
			warnings,
			dropped: normalized.dropped,
			missing: normalized.missing
		};
	}
};
/**
* The terminal hop. It never answers — it reports that no provider could.
*
* Kept as a provider rather than an exception so the chain has ONE return shape
* and a caller cannot accidentally treat "unavailable" as "no action needed".
* `answers` is empty and `missing` names every question that went unanswered.
*/
var RefuseJudgeProvider = class {
	name = "refuse";
	reasons;
	constructor(reasons) {
		this.reasons = [...reasons];
	}
	available() {
		return {
			ok: true,
			reason: ""
		};
	}
	async decide(req, _deps) {
		return {
			answers: {},
			provider: "refuse",
			model: "",
			latencyMs: 0,
			degraded: true,
			trace: [...this.reasons],
			warnings: [{
				code: "judge-unavailable",
				message: "no configured provider could answer",
				provider: "refuse"
			}],
			dropped: [],
			missing: Object.keys(req.questions)
		};
	}
};
/**
* Resolve the chain, then run it IN ORDER until one hop answers.
*
* The two behaviours worth stating explicitly:
*
*  - A provider that is unavailable for a NAMED reason is skipped, not called,
*    which is how a missing key costs zero round trips instead of one 401.
*  - A provider that is called and fails DOES fall through to the next hop, but
*    the failure is recorded. Silent fall-through is the defect this file exists
*    to avoid; loud fall-through is the feature.
*/
var JudgeChain = class {
	config;
	deps;
	constructor(config, deps = defaultJudgeDeps()) {
		this.config = config;
		this.deps = deps;
	}
	/** The providers in priority order, each with its availability verdict. */
	resolve() {
		const prefer = this.config.prefer ?? PROVIDER_ORDER;
		const byName = /* @__PURE__ */ new Map();
		if (this.config.jev !== null) byName.set("jev", new HttpJudgeProvider("jev", this.config.jev));
		if (this.config.laya !== null) byName.set("laya", new HttpJudgeProvider("laya", this.config.laya));
		if (this.config.rule !== null) byName.set("rule", new RuleJudgeProvider(this.config.rule));
		const out = [];
		for (const name$1 of prefer) {
			if (name$1 === "refuse") continue;
			const provider = byName.get(name$1);
			if (provider === void 0) continue;
			const verdict = provider.available();
			out.push({
				provider,
				available: verdict.ok,
				reason: verdict.reason
			});
		}
		return out;
	}
	async decide(req) {
		const chain = [];
		const trace = [];
		const warnings = [];
		const started = this.deps.now();
		const hops = this.resolve();
		const firstConfigured = hops[0]?.provider.name ?? null;
		for (const hop of hops) {
			if (!hop.available) {
				chain.push(`${hop.provider.name}:skipped`);
				trace.push(`${hop.provider.name}-skipped:${hop.reason}`);
				warnings.push({
					code: "provider-skipped",
					message: hop.reason,
					provider: hop.provider.name
				});
				continue;
			}
			const response = await hop.provider.decide(req, this.deps);
			warnings.push(...response.warnings);
			if (response.provider === "refuse") {
				chain.push(`${hop.provider.name}:failed`);
				trace.push(...response.trace.map((entry) => `${hop.provider.name}-${entry}`));
				continue;
			}
			chain.push(`${hop.provider.name}:answered`);
			return {
				...response,
				degraded: hop.provider.name !== firstConfigured || response.degraded,
				trace,
				warnings,
				chain,
				latencyMs: this.deps.now() - started
			};
		}
		const refused = await new RefuseJudgeProvider(trace).decide(req, this.deps);
		chain.push("refuse:terminal");
		return {
			...refused,
			warnings: [...warnings, ...refused.warnings],
			chain,
			latencyMs: this.deps.now() - started
		};
	}
};
function refuse(provider, started, ended, reasons) {
	return {
		answers: {},
		provider: "refuse",
		model: "",
		latencyMs: Math.max(0, ended - started),
		degraded: true,
		trace: reasons,
		warnings: [],
		dropped: [],
		missing: []
	};
}
function messageOf$2(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

//#endregion
//#region src/jev/client.ts
/**
* Parse the saved `judgePrefer` string into a legal hop order.
*
* See the header for the three rules. Note that an EMPTY result is not an error:
* with nothing legal left, the order is just `[refuse]`, which is a truthful
* description of "the user disabled every hop".
*/
function resolvePreferOrder(raw) {
	const legal = PROVIDER_ORDER.filter((name$1) => name$1 !== "refuse");
	const seen = [];
	for (const token of raw.split(",")) {
		const name$1 = token.trim();
		if (name$1 === "refuse") continue;
		if (!legal.includes(name$1)) continue;
		if (seen.includes(name$1)) continue;
		seen.push(name$1);
	}
	return [...seen, "refuse"];
}
/** A rule judge that is deliberately, visibly trivial. */
function defaultRuleJudge() {
	return (req) => {
		const answers = {};
		for (const [id, question] of Object.entries(req.questions)) {
			if (question.type !== "choice") continue;
			const first = Object.keys(question.criteria)[0];
			if (first === void 0) continue;
			const choice$1 = "wait" in question.criteria ? "wait" : first;
			answers[id] = {
				type: "choice",
				choice: choice$1,
				probabilities: { [choice$1]: 1 },
				confidence: 1
			};
		}
		return answers;
	};
}
/**
* Build the judge runtime from settings.
*
* A hop is configured only when it has a URL: an empty `jevUrl` means the user
* has no JEV judge, which is a different fact from "the JEV judge is
* misconfigured". The first should be silent and the second should be reported,
* and this is the branch that keeps them apart.
*/
function buildJudgeRuntime(settings, options = {}) {
	const order = resolvePreferOrder(settings.prefer);
	const jev = settings.jevUrl.trim() === "" ? null : httpConfig(settings.jevUrl, settings.jevKey, settings.jevModel);
	const laya = settings.layaUrl.trim() === "" ? null : httpConfig(settings.layaUrl, settings.layaKey, settings.layaModel);
	const deps = {
		fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
		now: options.now ?? (() => Date.now())
	};
	return {
		chain: new JudgeChain({
			jev,
			laya,
			rule: options.withoutRule === true ? null : options.rule ?? defaultRuleJudge(),
			prefer: order
		}, deps),
		settings,
		order,
		hops: []
	};
}
const httpConfig = (baseUrl, apiKey, model) => ({
	baseUrl: baseUrl.trim(),
	apiKey: apiKey.trim(),
	model: model.trim() === "" ? "laya" : model.trim(),
	timeoutMs: 15e3
});
/**
* Assemble the request body for one hop.
*
* Returns the issues ALONGSIDE the body rather than throwing: a caller that is
* previewing a body (`dryRun`) wants to see what is wrong with it, and a caller
* about to send needs to refuse. Splitting those two decisions between the
* assembler and the sender is what keeps "preview" and "send" from drifting into
* two different encoders.
*/
function assembleSystemOneBody(input, hop) {
	return {
		body: buildSystemOneRequest(input.state, input.questions, input.model),
		issues: validateQuestions(input.questions),
		url: `${hop.baseUrl.replace(/\/+$/, "")}/v1/systemone`
	};
}
/** Send one already-assembled body through the chain, refusing an invalid one. */
async function sendJudge(runtime, request$1) {
	const fatal = validateQuestions(request$1.questions).filter((issue) => issue.code !== "choice-criteria-over-limit");
	if (fatal.length > 0) return {
		answers: {},
		provider: "refuse",
		model: "",
		latencyMs: 0,
		degraded: true,
		trace: fatal.map((issue) => `invalid-questions:${issue.code}:${issue.questionId}`),
		warnings: [],
		dropped: [],
		missing: Object.keys(request$1.questions),
		chain: ["local:refused"]
	};
	return runtime.chain.decide(request$1);
}
/**
* A one-line-per-hop description of the chain, for `bcdp_jev_status`.
*
* Computed WITHOUT calling anything, because a status tool that performs a
* request every time it is asked for status is a status tool nobody runs.
*/
function describeJudge(runtime) {
	const lines = [];
	const resolved = runtime.chain.resolve();
	for (const name$1 of runtime.order) {
		if (name$1 === "refuse") {
			lines.push("refuse    terminal (always available; a refusal is a result, not an error)");
			continue;
		}
		const hop = resolved.find((entry) => entry.provider.name === name$1);
		if (hop === void 0) {
			lines.push(`${pad(name$1)} not configured`);
			continue;
		}
		lines.push(hop.available ? `${pad(name$1)} ready` : `${pad(name$1)} SKIPPED (${hop.reason})`);
	}
	return lines;
}
const pad = (name$1) => (name$1 + "        ").slice(0, 9);

//#endregion
//#region src/jev/frame.ts
/** Roles worth numbering. Mirrors src/cdp/marks.ts so both paths agree. */
const INTERACTIVE_ROLES = [
	"button",
	"link",
	"textbox",
	"searchbox",
	"combobox",
	"checkbox",
	"radio",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"tab",
	"option",
	"switch",
	"slider"
];
function isInteractiveRole(role) {
	return INTERACTIVE_ROLES.includes(role);
}
/**
* A stable frame id.
*
* Built from facts that identify WHICH page state this is — target, document
* revision, capture sequence — rather than from a timestamp, so the same state
* captured twice hashes the same and a log can be re-derived. `seq` is what
* keeps two captures of an unchanged document distinct.
*/
function frameIdFor(target, documentRevision, seq) {
	return createHash("sha256").update(`${target.targetId}\u0000${documentRevision}\u0000${seq}`).digest("hex").slice(0, 16);
}
/** Default candidate cap. Matches the chunk ceiling — see THRESHOLD_BUCKETS. */
const DEFAULT_NODE_LIMIT = 20;
/**
* Number the interactive candidates and freeze them into a frame.
*
* Order is DOCUMENT order (the AX tree arrives in it), duplicates by backend
* node id are dropped, and `limit` caps the set BEFORE numbering — so `n = 1..N`
* is contiguous and a judge that answers `n = 7` is answering about a candidate
* the caller can find by index, always.
*/
function buildFrame(input) {
	const limit = input.limit ?? DEFAULT_NODE_LIMIT;
	const now = input.now ?? (() => Date.now());
	const seen = /* @__PURE__ */ new Set();
	const nodes = [];
	let skipped = 0;
	for (const candidate of input.nodes) {
		if (nodes.length >= limit) break;
		if (!isInteractiveRole(candidate.role)) {
			skipped += 1;
			continue;
		}
		if (seen.has(candidate.backendNodeId)) continue;
		seen.add(candidate.backendNodeId);
		nodes.push({
			n: nodes.length + 1,
			backendNodeId: candidate.backendNodeId,
			role: candidate.role,
			name: candidate.name,
			rect: candidate.rect ?? null,
			state: {
				disabled: candidate.disabled === true,
				checked: candidate.checked === true,
				expanded: candidate.expanded === true,
				focusable: candidate.focusable === true
			},
			container: candidate.container ?? "page",
			containerLabel: candidate.containerLabel ?? "the page itself"
		});
	}
	const interactive = input.nodes.filter((candidate) => isInteractiveRole(candidate.role)).length;
	return {
		frame: {
			frameId: frameIdFor(input.target, input.documentRevision, input.seq),
			capturedAt: now(),
			target: input.target,
			viewport: input.viewport,
			image: input.image,
			dom: {
				nodes,
				total: interactive,
				truncated: false,
				source: "ax-tree"
			}
		},
		skippedNonInteractive: skipped
	};
}
/**
* Decide whether this frame must be sliced.
*
* The order of the questions is deliberate: an image that fits and a candidate
* list that fits means NO slicing, and most real pages land there (measured
* 136.9 KiB / 26 candidates against a 1 MiB / 20-candidate set — the image is
* fine, the candidates are not, which is why both are asked separately).
*/
function planChunks(input) {
	const chunkSize = Math.max(1, input.chunkSize ?? DEFAULT_NODE_LIMIT);
	const overImage = input.imageBytes !== null && input.maxBytes > 0 && input.imageBytes > input.maxBytes;
	const overCandidates = input.candidateCount > chunkSize;
	if (!overImage && !overCandidates) return {
		chunkTotal: 1,
		chunkSize,
		reason: "fits",
		sizes: [input.candidateCount]
	};
	if (overImage && !overCandidates) return {
		chunkTotal: 1,
		chunkSize,
		reason: "image-over-budget",
		sizes: [input.candidateCount]
	};
	const chunkTotal = Math.ceil(input.candidateCount / chunkSize);
	const sizes = [];
	let remaining = input.candidateCount;
	while (remaining > 0) {
		const take = Math.min(chunkSize, remaining);
		sizes.push(take);
		remaining -= take;
	}
	return {
		chunkTotal,
		chunkSize,
		reason: overImage ? "both" : "too-many-candidates",
		sizes
	};
}
/**
* Slice a frame's candidates into chunks, preserving document order.
*
* Out-of-range chunk numbers return `null` rather than wrapping: a `next` at the
* boundary must surface as `no_more_chunks`, because a silent wrap turns a
* budget problem into an infinite loop.
*/
function sliceFrame(frame, plan, chunkIndex) {
	if (chunkIndex < 1 || chunkIndex > plan.chunkTotal) return null;
	const start = plan.sizes.slice(0, chunkIndex - 1).reduce((sum, size) => sum + size, 0);
	const count = plan.sizes[chunkIndex - 1] ?? 0;
	const nodes = frame.dom.nodes.slice(start, start + count);
	return {
		frameId: frame.frameId,
		chunkIndex,
		chunkTotal: plan.chunkTotal,
		itemCount: nodes.length,
		nodes,
		containerHint: dominantContainer(nodes)
	};
}
/** The container most of these nodes live in — the "is this chunk homogeneous" answer. */
function dominantContainer(nodes) {
	if (nodes.length === 0) return "other";
	const counts = /* @__PURE__ */ new Map();
	for (const node of nodes) counts.set(node.container, (counts.get(node.container) ?? 0) + 1);
	let best = "other";
	let bestCount = -1;
	for (const [container, count] of counts) if (count > bestCount) {
		best = container;
		bestCount = count;
	}
	return best;
}
/**
* Group candidates into chapters, in first-appearance order.
*
* Order is FIRST APPEARANCE, not alphabetical: a judge should be offered the
* chapters in the order the page presents them, which is how a human reads it.
*/
function chaptersOf(nodes) {
	const byKey = /* @__PURE__ */ new Map();
	for (const node of nodes) {
		const existing = byKey.get(node.container);
		if (existing === void 0) {
			byKey.set(node.container, {
				key: node.container,
				label: node.containerLabel,
				nodes: [node]
			});
			continue;
		}
		existing.nodes.push(node);
	}
	return [...byKey.values()];
}
/**
* Whether narrowing through a chapter question is worth a round trip.
*
* `false` when there is only ONE chapter: a question with a single option is not
* a question, it is a round trip that can only be answered one way. Skipping it
* keeps the loop at two rounds on simple pages and three on busy ones.
*/
function shouldAskChapter(nodes, chapterCount = chaptersOf(nodes).length) {
	return chapterCount > 1;
}

//#endregion
//#region src/jev/prompt.ts
const DEFAULT_HISTORY_LIMIT = 5;
/**
* Assemble the `state` string handed to a judge.
*
* Deterministic: same inputs, same string, byte for byte. That matters more
* than it looks — a prompt that varies run to run makes a judge's change of
* mind unattributable, and this pipeline is judged on being debuggable.
*/
function buildIntentState(input) {
	const limit = input.historyLimit ?? DEFAULT_HISTORY_LIMIT;
	const excluded = new Set(input.excluded ?? []);
	const sections = [];
	sections.push(buildIntentSection(input.intent));
	if (input.progress !== void 0) sections.push(buildProgressSection(input.progress));
	sections.push(buildFrameSection(input));
	const history = buildHistorySection(input.history ?? [], limit, excluded);
	if (history !== "") sections.push(history);
	const state = sections.join("\n\n");
	assertJudgeIsolation(state);
	return state;
}
/** The only headings a judge context may contain. */
const JUDGE_SECTIONS = [
	"INTENT",
	"PROGRESS",
	"FRAME",
	"HISTORY"
];
/**
* Throw if the composed judge context carries a section outside the allow-list.
*
* This is the enforcement half of "the UI-controlling judge must not carry the
* agent's session". Without it, isolation is a convention that holds until
* somebody adds a helpful extra section; with it, that addition fails loudly on
* the first run instead of silently inflating every judgement.
*/
function assertJudgeIsolation(state) {
	for (const line of state.split("\n")) {
		if (!line.startsWith("# ")) continue;
		const heading = line.slice(2).trim();
		if (!/^[A-Z][A-Z_-]*$/.test(heading)) continue;
		if (!JUDGE_SECTIONS.includes(heading)) throw new Error(`judge context leaked a non-judge section: "# ${heading}". Allowed: ${JUDGE_SECTIONS.join(", ")}. The judge must see the intent, the page, the progress and the local history — never the agent session.`);
	}
}
function buildProgressSection(progress) {
	const lines = [
		"# PROGRESS",
		`step: ${progress.step} of ${progress.stepBudget}`,
		`budget left: judge=${progress.judgeLeft} captures=${progress.capturesLeft}`
	];
	if (progress.chapters.length === 0) lines.push("chapters entered: none yet");
	else {
		lines.push("chapters entered:");
		for (const chapter of progress.chapters) lines.push(`  - ${chapter.key}: ${chapter.attempts} attempt(s), ${chapter.outcome}`);
	}
	if (progress.completed.length === 0) lines.push("actions that succeeded: none yet");
	else {
		lines.push("actions that succeeded:");
		for (const done of progress.completed) lines.push(`  - ${done}`);
	}
	if (progress.note !== "") lines.push(`note: ${progress.note}`);
	return lines.join("\n");
}
function buildIntentSection(intent) {
	const lines = [
		"# INTENT",
		`goal: ${intent.goal}`,
		`kind: ${intent.kind}`,
		`source: ${intent.source}`
	];
	if (intent.targetHints.length > 0) {
		lines.push("targets:");
		for (const hint of intent.targetHints) lines.push(`  - ${hint}`);
	}
	if (intent.successCriteria.length > 0) {
		lines.push("done when:");
		for (const criterion of intent.successCriteria) lines.push(`  - ${criterion}`);
	}
	if (intent.stopConditions.length > 0) {
		lines.push("stop when:");
		for (const condition of intent.stopConditions) lines.push(`  - ${condition}`);
	}
	return lines.join("\n");
}
function buildFrameSection(input) {
	const { frame } = input;
	const chunk = input.chunk ?? null;
	const lines = [
		"# FRAME",
		`frameId: ${frame.frameId}`,
		`url: ${frame.target.url}`,
		frame.target.title === "" ? "" : `title: ${frame.target.title}`,
		`viewport: ${frame.viewport.width}x${frame.viewport.height} @${frame.viewport.devicePixelRatio}x scroll(${frame.viewport.scrollX},${frame.viewport.scrollY})`,
		frame.image === null ? "screenshot: none (judge from the list below)" : `screenshot: attached (${frame.image.format})`,
		`candidates: ${frame.dom.total}${frame.dom.truncated ? " (TRUNCATED — more exist than are listed)" : ""}`
	];
	if (chunk !== null) lines.push(`chunk: ${chunk.chunkIndex}/${chunk.chunkTotal} (${chunk.itemCount} items, mostly in ${chunk.containerHint})`);
	const chapter = input.chapter ?? null;
	if (chapter !== null) {
		lines.push(`chapter: ${chapter.key} — ${chapter.label}`);
		lines.push(`  (this is ONE section of the page; ${chapter.total} other candidate(s) live elsewhere and were NOT re-listed)`);
	}
	const nodes = input.nodes ?? (chunk === null ? frame.dom.nodes : chunk.nodes);
	lines.push("", ...nodes.map(formatNode));
	return lines.filter((line) => line !== "").join("\n");
}
/**
* One candidate line: `7. button "Sign in" [nav] (disabled)`.
*
* Field order is fixed and role precedes name because that is how a screen
* reader announces it — the same order a model has seen millions of times.
*/
function formatNode(node) {
	const flags = [];
	if (node.state.disabled) flags.push("disabled");
	if (node.state.checked) flags.push("checked");
	if (node.state.expanded) flags.push("expanded");
	const suffix = flags.length === 0 ? "" : ` (${flags.join(", ")})`;
	return `${node.n}. ${node.role} "${node.name}" [${node.container}]${suffix}`;
}
/**
* Render the HISTORY section, or `''` when there is nothing to say.
*
* Returning `''` for the empty case is deliberate rather than tidiness: a judge
* shown an empty `# HISTORY` header on the very first frame is being told the
* loop has a past when it does not, and "excluded:" with nothing after it reads
* as "everything is excluded" to a careless reader. Nothing is omitted that
* would change a decision.
*/
function buildHistorySection(history, limit, excluded) {
	const recent = history.slice(-limit);
	if (recent.length === 0 && excluded.size === 0) return "";
	const lines = ["# HISTORY"];
	if (recent.length === 0) lines.push("(no actions taken yet — this is the first judgement on this frame)");
	else for (const step$1 of recent) {
		const target = step$1.n === 0 ? "" : ` n=${step$1.n}`;
		const acted = step$1.acted === void 0 ? "" : ` — <${step$1.acted.tagName}${step$1.acted.className ? ` class="${step$1.acted.className}"` : ""}>${step$1.acted.text}</${step$1.acted.tagName}>`;
		lines.push(`- ${step$1.action}${target} ${step$1.ok ? "ok" : "FAILED"}: ${step$1.note}${acted}`);
	}
	if (excluded.size > 0) {
		const ids = [...excluded].sort((a, b) => a - b);
		lines.push(`excluded (do not propose these): ${ids.join(", ")}`);
	}
	return lines.join("\n");
}
/** The fixed control question. Exactly 5 options — it anchors a threshold bucket. */
const CONTROL_CHOICE_ID = "control";
/**
* The control question: what should happen next, at the coarsest granularity.
*
* Five options is not arbitrary. It is the smallest set that covers the five
* real outcomes (we are finished / act on something visible / look elsewhere /
* wait for a change / cannot proceed), and staying at five keeps it in the
* loosest threshold bucket — a 20-way question needs a much higher bar.
*
* `blocked` is separate from `done` on purpose. "Finished" and "stuck" both mean
* stop, but conflating them turns an unrecoverable stuck state into a success.
*/
function controlQuestion(canScroll$1) {
	const criteria = {
		done: "the intent is already satisfied by what is on screen; no further action is needed",
		act: "an element in the candidate list should be clicked or filled to make progress",
		wait: "the page is mid-transition or loading; the same frame should be looked at again shortly",
		blocked: "the intent cannot be progressed from this state — a login wall, a hard error, or a missing precondition"
	};
	if (canScroll$1) criteria.scroll = "the needed element is not in this list but the page can be scrolled to reveal more";
	return choice("Decide the next step towards the intent. Pick exactly one option.", criteria);
}
/**
* The chapter question: WHICH PART of the page should we look in.
*
* This is the "narrow the search" level, and it exists because of how the
* thresholds work rather than out of tidiness: every gate in `wire.ts` is
* bucketed by candidate count, so a 20-way question is judged with a looser bar
* than a 5-way one. Asking "which section" (a handful of options) and then
* "which element in it" (a handful more) puts BOTH rounds in stricter buckets
* than one 20-way round — the accuracy gain follows from the counts.
*
* The value of each option is written as a CONDITION, like every other choice
* here. Writing it as a noun label ("the nav bar") is the standard way to make a
* routing question useless: the judge then matches the label against the goal
* text instead of reasoning about where the intent can be satisfied.
*/
function chapterQuestion(chapters) {
	if (chapters.length === 0) throw new Error("chapterQuestion needs at least one chapter — an empty table is not a valid question");
	const criteria = {};
	for (const chapter of chapters) {
		const sample = chapter.nodes.slice(0, 4).map((node) => `${node.role} "${node.name}"`).join(", ");
		const more = chapter.nodes.length > 4 ? `, +${chapter.nodes.length - 4} more` : "";
		criteria[chapter.key] = `${chapter.label} holds the control this intent needs — it contains ${chapter.nodes.length} candidate(s): ${sample}${more}`;
	}
	return choice("Which part of the page should be searched for the next action? Answer with the section key.", criteria);
}
/** The in-chunk question: which numbered candidate to act on. */
function pickQuestion(nodes) {
	if (nodes.length === 0) throw new Error("pickQuestion needs at least one candidate — an empty table is not a valid question");
	const criteria = {};
	for (const node of nodes) criteria[String(node.n)] = `act on ${node.role} "${node.name}"${node.state.disabled ? " (currently disabled)" : ""}`;
	return choice("Pick the single candidate to act on next. Answer with its number.", criteria);
}
/** The completion gate. A `noul` because it is a yes/no, not a choice. */
function doneQuestion(successCriteria) {
	return noul("Is the intent satisfied by the current frame alone, with no further action?", {
		true: successCriteria.length === 0 ? "the intent is satisfied" : `all of: ${successCriteria.join("; ")}`,
		false: "at least one condition is not yet observable on screen"
	});
}
/** The danger `score` question. 5 levels — the protocol allows 10, accuracy does not. */
const DANGER_LEVELS = [
	"harmless — reading or navigating only",
	"minor — reversible, no data changed",
	"moderate — changes page state but is undoable",
	"serious — submits data or changes an account setting",
	"irreversible — deletes, pays, or publishes"
];
function dangerQuestion() {
	return {
		type: "score",
		instructions: "How risky is acting on the chosen candidate? Choose the level.",
		criteria: [...DANGER_LEVELS]
	};
}
/**
* Ask the control question alone.
*
* The first round is always control-only. Asking "which of these 20 elements"
* before knowing whether we should act at all is how a loop clicks things on a
* page it was supposed to leave alone.
*/
function controlQuestions(canScroll$1) {
	return { [CONTROL_CHOICE_ID]: controlQuestion(canScroll$1) };
}
/** The evaluation round's question id. */
const EVALUATION_CHOICE_ID = "progress";
/** The three progress verdicts. Deliberately three, and deliberately not a score. */
const PROGRESS_VERDICTS = [
	"inprogress",
	"done",
	"fail"
];
/**
* The progress evaluation, asked AFTER an action.
*
* Three options rather than a `score`, because the three outcomes lead to three
* different PLACES and an ordinal scale cannot express that:
*
*   inprogress → the loop continues by itself, nobody is told
*   done       → checked against successCriteria, then the run ends
*   fail       → handed back to the model with recovery options
*
* A `score` of 0..4 would need a threshold on top, and the threshold would then
* be the thing deciding whether to hand back — one more number to calibrate for
* no gain over simply naming the three states.
*
* The question is about the STEP, not the goal: `done` here means "the action I
* just took finished the job", which is why it is worth re-checking rather than
* believing. The failure it catches is the commonest one of all — an action that
* reports success and changes nothing.
*/
function evaluationQuestion() {
	return choice("The action above has just been carried out. Did it move the intent forward? Pick exactly one.", {
		inprogress: "the action had an effect and the intent is closer, but more steps are still needed — continue",
		done: "the intent is now fully satisfied by what is on screen, so no further action is required",
		fail: "the action did not achieve what it was for, or the page did not change as expected — this needs a different approach"
	});
}
/** The evaluation round's question set. */
function evaluationQuestions() {
	return { [EVALUATION_CHOICE_ID]: evaluationQuestion() };
}
/** The chapter round's question set: one question, keyed `chapter`. */
const CHAPTER_CHOICE_ID = "chapter";
function chapterQuestions(chapters) {
	return { [CHAPTER_CHOICE_ID]: chapterQuestion(chapters) };
}
/** The full second-round question set: an element to act on, and how risky it is. */
function pickQuestions(nodes) {
	return {
		candidate: pickQuestion(nodes),
		danger: dangerQuestion()
	};
}
/** Can this frame scroll — i.e. is "scroll" a meaningful control option? */
function canScroll(frame) {
	return frame.viewport.scrollY > 0 || frame.viewport.scrollX > 0 || frame.dom.total === 0;
}

//#endregion
//#region src/jev/render.ts
const DEFAULT_RENDER_TUNING = {
	timeoutMs: 15e3,
	graceMs: 3e4,
	stdoutMaxBytes: 4 * 1024 * 1024,
	stderrMaxBytes: 64 * 1024
};
/** `node` is assumed present: the worker is our own JS and the host runs Node. */
const defaultNodePath = () => process.execPath;
/**
* Build the stdin script: connect first, then each step, all as separate lines.
*
* `id` values are 1..N in emission order so the replies can be matched by id
* rather than by position — a worker that logs an unsolicited line cannot shift
* the mapping.
*/
function buildWorkerScript(options) {
	const lines = [];
	lines.push(JSON.stringify({
		id: 1,
		method: "connect",
		params: {
			wsUrl: options.wsUrl,
			...options.targetId === void 0 || options.targetId === "" ? {} : { targetId: options.targetId }
		}
	}));
	options.steps.forEach((step$1, index) => {
		lines.push(JSON.stringify({
			id: index + 2,
			method: step$1.method,
			params: step$1.params ?? {}
		}));
	});
	return `${lines.join("\n")}\n`;
}
/**
* Parse the worker's stdout into replies, keyed by id.
*
* Tolerant on purpose: a shebang banner, a stray log line, or a truncated final
* line must not lose the replies that DID arrive. Unparsable lines are skipped;
* a missing reply for a requested id surfaces as an explicit failure at the
* call site instead of an `undefined` that reads like an empty result.
*/
function parseWorkerReplies(stdout) {
	const replies = /* @__PURE__ */ new Map();
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line === "" || line[0] !== "{") continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed.id === "number") replies.set(parsed.id, parsed);
	}
	return replies;
}
/**
* Run one render call: spawn the worker, run connect + the steps, collect.
*
* Never throws for a worker-level failure. A failure is DATA here — the caller
* decides whether a dead connection is fatal, and mixing "could not spawn" with
* "the page had no candidates" into one exception path is how a retry loop ends
* up retrying the wrong thing.
*/
async function runRenderCall(subprocess, options) {
	const tuning = {
		...DEFAULT_RENDER_TUNING,
		...options.tuning
	};
	const spec = {
		argv: [options.nodePath ?? defaultNodePath(), options.workerPath],
		...options.cwd === void 0 ? {} : { cwd: options.cwd },
		...options.env === void 0 ? {} : { env: options.env },
		stdio: {
			stdin: { data: buildWorkerScript(options) },
			stdout: { maxBytes: tuning.stdoutMaxBytes },
			stderr: { maxBytes: tuning.stderrMaxBytes }
		},
		graceMs: tuning.graceMs
	};
	const handle = subprocess.spawn(spec);
	const exit = await handle.done;
	const stdout = readAll$1(handle.collected.stdout);
	const log = readAll$1(handle.collected.stderr);
	const replies = parseWorkerReplies(stdout);
	const connectReply = replies.get(1);
	return {
		connected: connectReply !== void 0 && connectReply.ok ? connectReply.result : null,
		steps: options.steps.map((step$1, index) => {
			const reply = replies.get(index + 2);
			if (reply === void 0) return {
				method: step$1.method,
				ok: false,
				error: `the worker returned no reply for ${step$1.method}`
			};
			return reply.ok ? {
				method: step$1.method,
				ok: true,
				result: reply.result
			} : {
				method: step$1.method,
				ok: false,
				error: reply.error?.message ?? "unknown worker error"
			};
		}),
		log,
		exitCode: exit.exitCode
	};
}
/** Read a collect reader from the start. Missing reader = empty, not an error. */
function readAll$1(reader) {
	if (reader === void 0) return "";
	try {
		return reader.readFrom(0).text;
	} catch {
		return "";
	}
}

//#endregion
//#region src/jev/effects.ts
/**
* Build the effects the loop runs on.
*
* A `sequence` counter feeds `frameIdFor`, so two captures of an unchanged
* document get DIFFERENT frame ids. That is the point: `seq` is what makes a
* frame id identify a capture rather than merely a page state, and a log where
* two different screenshots share an id cannot be replayed.
*/
function makeJudgeEffects(deps) {
	const frames = [];
	let sequence = 0;
	const caps = capabilitiesFor(deps.engine ?? "unknown");
	let numbering = /* @__PURE__ */ new Map();
	let error = "";
	const captureWithWorker = async () => {
		const call = await runRenderCall(deps.subprocess, {
			workerPath: deps.workerPath,
			wsUrl: deps.wsUrl,
			...deps.targetId === void 0 || deps.targetId === "" ? {} : { targetId: deps.targetId },
			steps: [{
				method: "capture",
				params: {
					format: caps.imageFormat,
					...caps.imageFormat === "jpeg" ? { quality: 72 } : {},
					maxBytes: deps.maxImageBytes,
					limit: deps.candidateLimit,
					marks: true
				}
			}]
		});
		if (call.connected === null) {
			error = call.steps[0]?.error ?? "the render worker could not attach to the page";
			throw new Error(error);
		}
		const step$1 = call.steps[0];
		if (step$1 === void 0 || !step$1.ok) {
			error = step$1?.error ?? "the render worker returned no capture";
			throw new Error(error);
		}
		const reply = step$1.result;
		sequence += 1;
		const target = {
			endpoint: deps.wsUrl,
			targetId: reply.targetId,
			url: reply.targetUrl,
			title: ""
		};
		const revision = revisionOf(reply);
		const nodes = reply.marks.map((mark) => ({
			backendNodeId: mark.backendNodeId,
			role: mark.role,
			name: mark.name,
			container: mark.container ?? "page",
			containerLabel: mark.containerLabel ?? "the page itself",
			rect: null
		}));
		const { frame } = buildFrame({
			target,
			viewport: reply.viewport,
			image: {
				format: caps.imageFormat,
				bytes: reply.bytes,
				dataBase64: reply.data,
				quality: reply.quality,
				overBudget: reply.overBudget,
				maxBytes: deps.maxImageBytes
			},
			nodes,
			documentRevision: revision,
			seq: sequence,
			limit: deps.candidateLimit,
			now: deps.now
		});
		numbering = new Map(frame.dom.nodes.map((node) => [node.n, node.backendNodeId]));
		frames.push(frame);
		deps.onFrame?.(frame);
		return {
			frame,
			documentRevision: revision
		};
	};
	return {
		frames: () => frames,
		lastError: () => error,
		async navigate(url, timeoutMs = 25e3) {
			const call = await runRenderCall(deps.subprocess, {
				workerPath: deps.workerPath,
				wsUrl: deps.wsUrl,
				...deps.targetId === void 0 || deps.targetId === "" ? {} : { targetId: deps.targetId },
				steps: [{
					method: "navigate",
					params: {
						url,
						timeoutMs
					}
				}]
			});
			const step$1 = call.steps[0];
			if (call.connected === null || step$1 === void 0 || !step$1.ok) {
				const why = step$1?.error ?? "the render worker could not attach to the page";
				error = why;
				return {
					ok: false,
					url: "",
					loaded: false,
					error: why
				};
			}
			const reply = step$1.result;
			return {
				ok: true,
				url: reply.url,
				loaded: reply.loaded
			};
		},
		async capture() {
			return captureWithWorker();
		},
		async judge(request$1) {
			return sendJudge(deps.judge, request$1);
		},
		async act(request$1) {
			const backendNodeId = request$1.action === "scroll" ? 0 : numbering.get(request$1.n);
			if (request$1.action !== "scroll" && backendNodeId === void 0) return {
				ok: false,
				code: "candidate-not-found",
				message: `candidate ${request$1.n} is not in the current frame`,
				n: request$1.n
			};
			const step$1 = (await runRenderCall(deps.subprocess, {
				workerPath: deps.workerPath,
				wsUrl: deps.wsUrl,
				steps: [{
					method: "act",
					params: {
						action: request$1.action === "scroll" ? "scroll" : request$1.action === "fill" ? "fill" : "click",
						backendNodeId,
						deltaY: 600,
						...request$1.text === void 0 ? {} : { text: request$1.text }
					}
				}]
			})).steps[0];
			if (step$1 === void 0 || !step$1.ok) return {
				ok: false,
				code: "input-failed",
				message: step$1?.error ?? "the render worker returned no action result",
				n: request$1.n
			};
			const reply = step$1.result;
			if (!reply.ok) return {
				ok: false,
				code: codeOf(reply.code),
				message: reply.message ?? reply.code,
				n: request$1.n
			};
			return {
				ok: true,
				code: "ok",
				action: reply.action ?? "click",
				n: request$1.n,
				backendNodeId: reply.backendNodeId ?? backendNodeId ?? 0,
				point: reply.point ?? {
					x: 0,
					y: 0
				},
				measured: reply.measured ?? {
					x: 0,
					y: 0,
					width: 0,
					height: 0
				},
				drift: reply.drift ?? 0,
				...reply.recorded === void 0 ? {} : { recorded: reply.recorded }
			};
		},
		async verify(intent) {
			let frame;
			try {
				frame = (await captureWithWorker()).frame;
			} catch (captureError) {
				return {
					satisfied: false,
					note: `could not re-capture to verify: ${messageOf$1(captureError)}`
				};
			}
			const question = doneQuestion(intent.successCriteria);
			const result = await sendJudge(deps.judge, {
				questions: { satisfied: question },
				state: JSON.stringify({
					intent: intent.goal,
					criteria: intent.successCriteria,
					url: frame.target.url,
					candidates: frame.dom.nodes.map((node) => `${node.n}. ${node.role} "${node.name}"`)
				})
			});
			const answer = result.answers.satisfied;
			if (answer === void 0 || answer.type !== "noul") return {
				satisfied: false,
				note: `verification did not return a usable answer (${result.provider})`
			};
			return {
				satisfied: answer.noul >= .5,
				note: `verification ${answer.noul.toFixed(2)} from ${result.provider}`
			};
		},
		now: deps.now,
		sleep: deps.sleep
	};
}
/**
* A content-derived document revision.
*
* Hashes the target plus the DECODED BYTE COUNT and the candidate set, not the
* base64 string: base64 of identical bytes is identical, so hashing it would
* work, but it would also means hashing ~190 KB per capture to answer a question
* that a three-number tuple answers just as reliably for this purpose.
*/
function revisionOf(reply) {
	return createHash("sha1").update(`${reply.targetId}\u0000${reply.targetUrl}\u0000${reply.bytes}`).update(reply.marks.map((mark) => `${mark.backendNodeId}:${mark.role}:${mark.name}`).join("|")).digest().readUInt32BE(0);
}
/**
* Narrow a worker error code to one `act.ts` declares.
*
* `ActCode` is the single vocabulary for action outcomes, so an unrecognised
* code from the worker becomes `input-failed` rather than being passed through.
* Passing it through would let a new worker code silently become a code the
* caller's `switch` has no branch for — the outcome would then fall into
* whatever `default` happens to do.
*/
const FAILURE_CODES = [
	"no-answer",
	"candidate-not-found",
	"candidate-excluded",
	"candidate-disabled",
	"no-box-model",
	"click-missed",
	"input-timeout",
	"input-failed",
	"hit-test-failed"
];
function codeOf(code) {
	return FAILURE_CODES.includes(code) ? code : "input-failed";
}
const messageOf$1 = (value) => value instanceof Error ? value.message : String(value);

//#endregion
//#region src/jev/anchors.ts
/** Fixed prefix so an anchor is recognizable in a transcript at a glance. */
const ANCHOR_PREFIX = "sb-";
/** Hex length after the prefix — half a sha256, collision-safe for this use. */
const ANCHOR_HEX = 16;
/**
* Mint the anchor for one candidate inside one snapshot scope.
*
* `scope` is the frame identity (`frame.frameId`) in the current pipeline; any
* caller with a different snapshot notion passes its own scope string — the
* function only demands that different snapshots produce different scope
* strings, which is exactly what frameId guarantees.
*/
function anchorFor(scope, backendNodeId) {
	return `${ANCHOR_PREFIX}${createHash("sha256").update(`${scope}\0${backendNodeId}`).digest("hex").slice(0, ANCHOR_HEX)}`;
}

//#endregion
//#region src/jev/attempt.ts
/** Fixed question id; the judge's answer key for every round. */
const ATTEMPT_QUESTION_ID = "pick";
/** The option key that means "I choose to stop". */
const ATTEMPT_END_KEY = "end";
/** One candidate, as BOTH a FRAME list line and an option-table value. */
function candidateLine(node) {
	return `${node.role} "${node.name}" [${node.containerLabel}]`;
}
function endOptionText() {
	return "the goal is already achieved, or nothing on this page can advance it — stop and report back";
}
function buildAttemptState(frame, intent, actions, maxActions) {
	const nodes = frame.dom.nodes;
	const lines = [];
	lines.push("# INTENT");
	lines.push(`goal: ${intent.goal}`);
	for (const criterion of intent.successCriteria) lines.push(`success criterion: ${criterion}`);
	lines.push(`actions left: ${Math.max(0, maxActions - actions.length)}`);
	lines.push("");
	lines.push("# FRAME");
	lines.push(`url: ${frame.target.url}`);
	if (frame.dom.truncated) lines.push(`(candidate list truncated: showing ${nodes.length} of ${frame.dom.total})`);
	for (const node of nodes) lines.push(`${node.n}. ${candidateLine(node)}`);
	if (actions.length > 0) {
		lines.push("");
		lines.push("# HISTORY");
		for (const step$1 of actions) lines.push(`${step$1.ok ? "ok" : "FAILED"}: ${step$1.label}`);
	}
	const state = lines.join("\n");
	assertJudgeIsolation(state);
	return state;
}
function attemptQuestion(nodes) {
	const criteria = { [ATTEMPT_END_KEY]: endOptionText() };
	for (const node of nodes) criteria[String(node.n)] = candidateLine(node);
	return choice(`Pick the NUMBER of the element your next click should act on to advance the goal, or pick "${ATTEMPT_END_KEY}" when it applies.`, criteria);
}
async function runAttempt(input) {
	const maxActions = input.maxActions ?? 5;
	const actions = [];
	let lastFrameId = "";
	let lastUrl = "";
	let candidates = 0;
	for (;;) {
		let frame;
		try {
			frame = (await input.effects.capture()).frame;
		} catch (error) {
			return {
				status: "error",
				reason: `capture failed: ${error instanceof Error ? error.message : String(error)}`,
				actions,
				candidates,
				lastFrameId,
				lastUrl
			};
		}
		lastFrameId = frame.frameId;
		lastUrl = frame.target.url;
		candidates = frame.dom.nodes.length;
		if (candidates === 0) return {
			status: "blocked",
			reason: "the DOM tree offered no interactive candidates — nothing to choose from",
			actions,
			candidates,
			lastFrameId,
			lastUrl
		};
		const request$1 = {
			questions: { [ATTEMPT_QUESTION_ID]: attemptQuestion(frame.dom.nodes) },
			state: buildAttemptState(frame, input.intent, actions, maxActions)
		};
		let result;
		try {
			result = await input.effects.judge(request$1);
		} catch (error) {
			return {
				status: "unavailable",
				reason: `the judge chain threw: ${error instanceof Error ? error.message : String(error)}`,
				actions,
				candidates,
				lastFrameId,
				lastUrl
			};
		}
		const answer = result.answers[ATTEMPT_QUESTION_ID];
		if (answer === void 0 || answer.type !== "choice" || typeof answer.choice !== "string" || answer.choice === "") return {
			status: "unavailable",
			reason: `no usable pick answer from ${result.provider} (chain: ${result.chain.join(" → ")})`,
			actions,
			candidates,
			lastFrameId,
			lastUrl
		};
		if (answer.choice === ATTEMPT_END_KEY) return {
			status: "ended",
			reason: "the decision model chose to end by itself",
			actions,
			candidates,
			lastFrameId,
			lastUrl
		};
		const n = Number.parseInt(answer.choice, 10);
		const node = frame.dom.nodes.find((candidate) => candidate.n === n);
		if (node === void 0) return {
			status: "unclear",
			reason: `the judge named "${answer.choice}", which is not an offered option`,
			actions,
			candidates,
			lastFrameId,
			lastUrl
		};
		const bucket = bucketFor(candidates + 1);
		const margin = checkChoiceMargin(answer, bucket.minTop, bucket.minMargin);
		if (!margin.ok) return {
			status: "unclear",
			reason: `the pick for ${node.role} "${node.name}" did not clear its bucket (top=${margin.top.toFixed(2)}, runner-up=${margin.runnerUp.toFixed(2)}, margin=${margin.margin.toFixed(2)}, needs top≥${bucket.minTop}${bucket.minMargin > 0 ? ` margin≥${bucket.minMargin}` : ""})`,
			actions,
			candidates,
			lastFrameId,
			lastUrl
		};
		const outcome = await input.effects.act({
			frame,
			n,
			action: "click"
		});
		const label = `click ${node.role} "${node.name}" [${node.containerLabel}]`;
		actions.push({
			index: actions.length + 1,
			n,
			ok: outcome.ok,
			label: outcome.ok ? label : `${label} — failed: ${outcome.message}`,
			provider: result.provider,
			degraded: result.degraded,
			top: margin.top,
			...outcome.ok ? { anchor: anchorFor(frame.frameId, outcome.backendNodeId) } : {}
		});
		if (actions.length >= maxActions) return {
			status: "exhausted",
			reason: `the action budget (${maxActions}) was spent`,
			actions,
			candidates,
			lastFrameId,
			lastUrl
		};
	}
}

//#endregion
//#region src/jev/act.ts
/**
* Build a history line for the loop from an outcome.
*
* Lives here rather than in `prompt.ts` because it is a projection of THIS
* module's result shape; `prompt.ts` only needs the small `HistoryStep`.
*/
function toHistoryNote(outcome) {
	const acted = outcome.ok && outcome.recorded !== void 0 ? {
		tagName: outcome.recorded.tagName,
		className: outcome.recorded.className,
		text: outcome.recorded.text
	} : void 0;
	if (outcome.ok) {
		if (outcome.action === "scroll") return {
			action: "scroll",
			n: 0,
			ok: true,
			note: "page scrolled; the frame will be recaptured",
			...acted === void 0 ? {} : { acted }
		};
		const drift = outcome.drift > 1 ? ` (element had drifted ${outcome.drift}px since capture)` : "";
		return {
			action: outcome.action,
			n: outcome.n,
			ok: true,
			note: `${outcome.action} dispatched${drift}`,
			...acted === void 0 ? {} : { acted }
		};
	}
	return {
		action: "none",
		n: outcome.n,
		ok: false,
		note: `${outcome.code}: ${outcome.message}`,
		...acted === void 0 ? {} : { acted }
	};
}

//#endregion
//#region src/jev/pipe.ts
const DEFAULT_PIPE_CONFIG = {
	model: "laya",
	chunkSize: 20,
	maxImageBytes: 0,
	historyLimit: 5,
	archiveImageBudget: 0
};
/**
* Assemble one round from a frame and an intent.
*
* Pure: no network, no clock. The judge is a separate call, which is what makes
* the encoder testable against a fixture and the archived bundle reproducible.
*/
function buildRound(input) {
	const config = {
		...DEFAULT_PIPE_CONFIG,
		...input.config
	};
	const plan = planChunks({
		candidateCount: input.frame.dom.nodes.length,
		imageBytes: input.frame.image?.bytes ?? null,
		maxBytes: config.maxImageBytes,
		chunkSize: config.chunkSize
	});
	const chunkIndex = input.round === "control" ? 1 : Math.max(1, input.chunkIndex ?? 1);
	const chunk = plan.chunkTotal > 1 || input.round !== "control" ? sliceFrame(input.frame, plan, chunkIndex) : null;
	if (input.round !== "control" && chunk === null) throw new Error(`pick round asked for chunk ${chunkIndex} but the plan has ${plan.chunkTotal} chunk(s)`);
	const excluded = new Set(input.excluded ?? []);
	const inChunk = chunk?.nodes ?? input.frame.dom.nodes;
	const offered = input.round === "control" ? [] : input.round === "chapter" ? [] : inChunk.filter((node) => !excluded.has(node.n) && (input.chapterKey === void 0 || node.container === input.chapterKey));
	const chapters = chaptersOf(input.round === "chapter" ? inChunk.filter((node) => !excluded.has(node.n)) : offered);
	const chosenChapter = input.round === "pick" && input.chapterKey !== void 0 ? chapters.find((entry) => entry.key === input.chapterKey) ?? null : null;
	const elsewhere = chosenChapter === null ? 0 : inChunk.filter((node) => node.container !== chosenChapter.key).length;
	const state = buildIntentState({
		intent: input.intent,
		frame: input.frame,
		chunk,
		history: input.history ?? [],
		excluded: input.excluded ?? [],
		historyLimit: config.historyLimit,
		...input.progress === void 0 ? {} : { progress: input.progress },
		nodes: input.round === "control" ? input.frame.dom.nodes : offered,
		chapter: chosenChapter === null ? null : {
			key: chosenChapter.key,
			label: chosenChapter.label,
			total: elsewhere
		}
	});
	const questions = input.round === "control" ? controlQuestions(canScroll(input.frame)) : input.round === "evaluate" ? evaluationQuestions() : input.round === "chapter" ? chapterQuestions(chapters) : pickQuestions(offered);
	const issues = validateQuestions(questions);
	const body = buildSystemOneRequest(state, questions, config.model);
	return {
		round: input.round,
		frameId: input.frame.frameId,
		state,
		questions,
		issues,
		plan,
		chunkIndex,
		jev: {
			kind: "jev-wire",
			endpoint: input.endpoint ?? "",
			body
		},
		laya: {
			kind: "laya-frame",
			frameId: input.frame.frameId,
			intent: input.intent,
			round: input.round,
			frame: {
				target: input.frame.target,
				viewport: input.frame.viewport,
				image: input.frame.image === null ? null : {
					format: input.frame.image.format,
					bytes: input.frame.image.bytes,
					quality: input.frame.image.quality,
					overBudget: input.frame.image.overBudget
				},
				nodes: input.round === "control" ? chunk?.nodes ?? input.frame.dom.nodes : offered,
				truncated: input.frame.dom.truncated,
				total: input.frame.dom.total
			},
			chunk: chunk === null ? null : {
				index: chunk.chunkIndex,
				total: chunk.chunkTotal,
				itemCount: offered.length === 0 ? chunk.itemCount : offered.length,
				containerHint: chunk.containerHint
			},
			questions,
			...config.archiveImageBudget !== 0 && input.frame.image !== null && input.frame.image.dataBase64 !== "" ? { imageBase64: input.frame.image.dataBase64 } : {}
		}
	};
}
/**
* Read round 1's control answer into a decision.
*
* The distinction that matters most here is `no-answer` vs `unavailable`:
* "the model was asked and gave nothing" and "no model was reachable" look
* identical if both collapse to "no action", and they call for opposite
* responses — one is a prompt problem, the other is a configuration problem.
*
* `unclear` (a low-confidence answer) is likewise its own outcome: it means the
* judge DID answer, just not decisively, so a caller can retry with a tighter
* question rather than treating the element as ruled out.
*/
function readControl(result) {
	if (result.provider === "refuse") return {
		kind: "unavailable",
		trace: result.trace
	};
	const answer = result.answers[CONTROL_CHOICE_ID];
	if (answer === void 0) return {
		kind: "no-answer",
		missing: result.missing
	};
	const bucket = bucketFor(CONTROL_OPTION_COUNT);
	const margin = checkChoiceMargin(answer, bucket.minTop, bucket.minMargin);
	if (!margin.ok) return {
		kind: "unclear",
		code: margin.code,
		top: margin.top,
		margin: margin.margin
	};
	if (answer.type !== "choice") return {
		kind: "no-answer",
		missing: [CONTROL_CHOICE_ID]
	};
	switch (answer.choice) {
		case "done": return {
			kind: "done",
			top: margin.top
		};
		case "act": return {
			kind: "act",
			top: margin.top
		};
		case "scroll": return {
			kind: "scroll",
			top: margin.top
		};
		case "wait": return {
			kind: "wait",
			top: margin.top
		};
		case "blocked": return {
			kind: "blocked",
			top: margin.top
		};
		default: return {
			kind: "unclear",
			code: `unknown-option:${answer.choice}`,
			top: margin.top,
			margin: margin.margin
		};
	}
}
/** The control table's size, used to pick the threshold bucket. */
const CONTROL_OPTION_COUNT = 5;
/**
* Read the chapter answer.
*
* An unknown section key is its own outcome rather than a fallback to "look
* everywhere": falling back would silently undo the narrowing while the trace
* claimed it happened, which is worse than admitting the answer was unusable.
*/
function readChapter(result, chapters) {
	if (result.provider === "refuse") return {
		kind: "unavailable",
		trace: result.trace
	};
	const answer = result.answers[CHAPTER_CHOICE_ID];
	if (answer === void 0 || answer.type !== "choice") return {
		kind: "no-answer",
		missing: result.missing
	};
	const bucket = bucketFor(chapters.length);
	const margin = checkChoiceMargin(answer, bucket.minTop, bucket.minMargin);
	if (!margin.ok) return {
		kind: "unclear",
		code: margin.code,
		top: margin.top,
		margin: margin.margin
	};
	const chosen = chapters.find((chapter) => chapter.key === answer.choice);
	if (chosen === void 0) return {
		kind: "unknown-chapter",
		key: answer.choice,
		top: margin.top,
		margin: margin.margin
	};
	return {
		kind: "chapter",
		key: chosen.key,
		label: chosen.label,
		nodes: chosen.nodes,
		top: margin.top,
		margin: margin.margin
	};
}
/**
* Read the progress verdict.
*
* The option count is FIXED at three, so its bucket is the strictest one: a
* three-way question must be answered decisively, because a hesitant verdict is
* exactly the case where continuing automatically is worst. Anything unclear
* therefore escalates rather than continuing on a coin flip.
*/
function readEvaluation(result) {
	if (result.provider === "refuse") return {
		kind: "unavailable",
		trace: result.trace
	};
	const answer = result.answers[EVALUATION_CHOICE_ID];
	if (answer === void 0 || answer.type !== "choice") return {
		kind: "no-answer",
		missing: result.missing
	};
	const bucket = bucketFor(PROGRESS_VERDICTS.length);
	const margin = checkChoiceMargin(answer, bucket.minTop, bucket.minMargin);
	if (!margin.ok) return {
		kind: "unclear",
		code: margin.code,
		top: margin.top,
		margin: margin.margin
	};
	if (!PROGRESS_VERDICTS.includes(answer.choice)) return {
		kind: "unclear",
		code: `unknown-verdict:${answer.choice}`,
		top: margin.top,
		margin: margin.margin
	};
	return {
		kind: "verdict",
		verdict: answer.choice,
		top: margin.top,
		margin: margin.margin
	};
}
/**
* Read round 2's answer into an actionable reference.
*
* The `out-of-frame` case is worth its own outcome: a judge that returns `n`
* beyond the candidate list is exactly the failure the numbering scheme exists
* to make visible, and reporting it as `out-of-frame` is what keeps it from
* being clamped into a click on the last element.
*/
function readPick(result, candidates) {
	if (result.provider === "refuse") return {
		kind: "unavailable",
		trace: result.trace
	};
	const answer = result.answers.candidate;
	if (answer === void 0 || answer.type !== "choice") return {
		kind: "no-answer",
		missing: result.missing
	};
	const bucket = bucketFor(candidates.length);
	const margin = checkChoiceMargin(answer, bucket.minTop, bucket.minMargin);
	if (!margin.ok) return {
		kind: "unclear",
		code: margin.code,
		top: margin.top,
		margin: margin.margin
	};
	const n = Number.parseInt(answer.choice, 10);
	if (!Number.isFinite(n)) return {
		kind: "unclear",
		code: `non-numeric:${answer.choice}`,
		top: margin.top,
		margin: margin.margin
	};
	const node = candidates.find((candidate) => candidate.n === n);
	if (node === void 0) return {
		kind: "out-of-frame",
		n
	};
	const dangerAnswer = result.answers.danger;
	const danger = dangerAnswer !== void 0 && dangerAnswer.type === "score" ? dangerAnswer.score : null;
	return {
		kind: "pick",
		n,
		top: margin.top,
		margin: margin.margin,
		danger,
		node
	};
}
/** The Laya exit as JSON. Stable key order comes from the object literal. */
function serializeLaya(round) {
	return JSON.stringify(round.laya, null, 2);
}

//#endregion
//#region src/jev/loop.ts
const DEFAULT_BUDGETS = {
	steps: 20,
	judge: 60,
	captures: 5,
	chunksPerCapture: 8,
	wallMs: 12e4
};
/**
* The ledger.
*
* `spend()` REFUSES rather than decrementing past zero, and `check()` lets a
* caller verify before doing expensive work. That ordering matters: a budget
* checked after the call it was meant to prevent is a report, not a budget.
*/
var BudgetLedger = class {
	limits;
	used = {
		steps: 0,
		judge: 0,
		captures: 0,
		chunksPerCapture: 0,
		wallMs: 0
	};
	now;
	startedAt;
	constructor(limits, now) {
		this.limits = limits;
		this.now = now;
		this.startedAt = now();
	}
	/** Would this spend fit? Checked BEFORE the work, never after. */
	check(kind, amount = 1) {
		const spent = kind === "wallMs" ? this.elapsed() : this.used[kind];
		const limit = this.limits[kind];
		if (spent + amount > limit) return {
			ok: false,
			kind,
			remaining: Math.max(0, limit - spent)
		};
		return { ok: true };
	}
	/** Charge a spend. Throws only on programmer error — use `check` first. */
	spend(kind, amount = 1) {
		if (kind !== "wallMs") this.used[kind] += amount;
	}
	elapsed() {
		return Math.max(0, this.now() - this.startedAt);
	}
	snapshot() {
		return {
			steps: this.limits.steps - this.used.steps,
			judge: this.limits.judge - this.used.judge,
			captures: this.limits.captures - this.used.captures,
			chunksPerCapture: this.limits.chunksPerCapture,
			wallMs: Math.max(0, this.limits.wallMs - this.elapsed())
		};
	}
	/** The first exhausted budget, or `null`. Reported verbatim on `exhausted`. */
	exhausted() {
		for (const kind of [
			"steps",
			"judge",
			"captures",
			"wallMs"
		]) if (!this.check(kind).ok) return kind;
		return null;
	}
};
const DEFAULT_UNCLEAR_LIMIT = 3;
const DEFAULT_STALLED_LIMIT = 3;
/**
* Run the loop.
*
* See the module header for what it refuses to do; the short version is that
* every exit is enumerated, every claim of success is verified, and every budget
* is checked before the work rather than after it.
*/
async function runLoop(input) {
	const budgets = {
		...DEFAULT_BUDGETS,
		...input.budgets
	};
	const ledger = new BudgetLedger(budgets, input.effects.now);
	const unclearLimit = input.unclearLimit ?? DEFAULT_UNCLEAR_LIMIT;
	const stalledLimit = input.stalledLimit ?? DEFAULT_STALLED_LIMIT;
	const evaluate = input.evaluate === true;
	const history = [];
	const excluded = [];
	const steps = [];
	const chapterLog = /* @__PURE__ */ new Map();
	const completed = [];
	let progressNote = "";
	const progressOf = () => ({
		step: steps.length + 1,
		stepBudget: budgets.steps,
		judgeLeft: Math.max(0, ledger.snapshot().judge),
		capturesLeft: Math.max(0, ledger.snapshot().captures),
		chapters: [...chapterLog.values()],
		completed: [...completed],
		note: progressNote
	});
	let degraded = false;
	let consecutiveUnclear = 0;
	let consecutiveStalls = 0;
	let lastRevision = -1;
	let frame = null;
	let revision = -1;
	while (true) {
		const exhausted = ledger.exhausted();
		if (exhausted !== null) return finish("exhausted", `budget exhausted: ${exhausted}`, excluded, steps, degraded, ledger, exhausted);
		const stepGate = ledger.check("steps");
		if (!stepGate.ok) return finish("exhausted", `budget exhausted: steps (${stepGate.remaining} left)`, excluded, steps, degraded, ledger, "steps");
		ledger.spend("steps");
		if (frame === null || revision !== lastRevision) {
			if (!ledger.check("captures").ok) return finish("exhausted", "budget exhausted: captures", excluded, steps, degraded, ledger, "captures");
			ledger.spend("captures");
			let captured;
			try {
				captured = await input.effects.capture();
			} catch (error) {
				return finish("error", `capture failed: ${messageOf(error)}`, excluded, steps, degraded, ledger);
			}
			frame = captured.frame;
			revision = captured.documentRevision;
			lastRevision = captured.documentRevision;
		}
		const controlRound = buildRound({
			frame,
			intent: input.intent,
			round: "control",
			history,
			excluded,
			progress: progressOf(),
			config: input.pipe
		});
		const controlAsked = await ask(ledger, input.effects, controlRound);
		if (!controlAsked.ok) return finish("exhausted", `budget exhausted: ${controlAsked.blockedBy}`, excluded, steps, degraded, ledger, controlAsked.blockedBy);
		const controlAnswer = controlAsked.result;
		degraded = degraded || controlAnswer.degraded;
		const control = readControl(controlAnswer);
		if (control.kind === "unavailable") return finish("unavailable", `no judge could answer (${controlAnswer.trace.join(", ") || "no trace"})`, excluded, steps, degraded, ledger);
		if (control.kind === "no-answer") {
			consecutiveUnclear += 1;
			if (consecutiveUnclear >= unclearLimit) return finish("stuck", `control question went unanswered ${consecutiveUnclear}×`, excluded, steps, degraded, ledger);
			steps.push(step(ledger, steps.length, "no-answer", 0, "none", false, "judge returned no usable control answer", controlAnswer));
			continue;
		}
		if (control.kind === "unclear") {
			consecutiveUnclear += 1;
			if (consecutiveUnclear >= unclearLimit) return finish("stuck", `control answer unclear ${consecutiveUnclear}× (${control.code})`, excluded, steps, degraded, ledger);
			steps.push(step(ledger, steps.length, `unclear:${control.code}`, 0, "none", false, `top=${control.top.toFixed(2)} margin=${control.margin.toFixed(2)}`, controlAnswer));
			continue;
		}
		consecutiveUnclear = 0;
		if (control.kind === "blocked") return finish("blocked", "the judge reports the intent cannot be progressed from this state", excluded, steps, degraded, ledger);
		if (control.kind === "done") {
			let verdict;
			try {
				verdict = await input.effects.verify(input.intent);
			} catch (error) {
				return finish("error", `verification threw: ${messageOf(error)}`, excluded, steps, degraded, ledger);
			}
			if (verdict.satisfied) {
				steps.push(step(ledger, steps.length, "done", 0, "verify", true, verdict.note, controlAnswer));
				return finish("done", verdict.note, excluded, steps, degraded, ledger);
			}
			consecutiveStalls += 1;
			history.push({
				action: "verify",
				n: 0,
				ok: false,
				note: `judge claimed done but: ${verdict.note}`
			});
			steps.push(step(ledger, steps.length, "done-unverified", 0, "verify", false, verdict.note, controlAnswer));
			if (consecutiveStalls >= stalledLimit) return finish("stuck", `judge claimed done ${consecutiveStalls}× without the criteria holding`, excluded, steps, degraded, ledger);
			continue;
		}
		if (control.kind === "wait") {
			await input.effects.sleep(300);
			steps.push(step(ledger, steps.length, "wait", 0, "wait", true, "waited for the page to settle", controlAnswer));
			lastRevision = -1;
			history.push({
				action: "wait",
				n: 0,
				ok: true,
				note: "waited for the page to settle"
			});
			continue;
		}
		if (control.kind === "scroll") {
			const scrolled = await input.effects.act({
				frame,
				n: 0,
				action: "scroll"
			});
			history.push(toHistoryNote(scrolled));
			steps.push(step(ledger, steps.length, "scroll", 0, "scroll", scrolled.ok, scrolled.ok ? "scrolled; frame will be recaptured" : scrolled.message, controlAnswer));
			lastRevision = -1;
			excluded.length = 0;
			continue;
		}
		const outcome = await walkNarrowing(ledger, input.effects, frame, input.intent, history, excluded, input.pipe, progressOf, chapterLog);
		if (!outcome.ok) return finish("exhausted", `budget exhausted: ${outcome.blockedBy}`, excluded, steps, degraded, ledger, outcome.blockedBy);
		degraded = degraded || outcome.degraded;
		if (outcome.kind === "candidates-exhausted") {
			consecutiveStalls += 1;
			steps.push(step(ledger, steps.length, "no-candidates", 0, "none", false, "every candidate in this frame was ruled out", outcome.result));
			if (consecutiveStalls >= stalledLimit) return finish("stuck", "all candidates ruled out on this frame", excluded, steps, degraded, ledger);
			lastRevision = -1;
			continue;
		}
		if (outcome.kind !== "pick") {
			if (outcome.kind === "unavailable") return finish("unavailable", "no judge could answer the candidate question", excluded, steps, degraded, ledger);
			if (outcome.kind === "out-of-frame") {
				consecutiveStalls += 1;
				history.push({
					action: "none",
					n: outcome.n,
					ok: false,
					note: `judge named candidate ${outcome.n}, which is not in this frame`
				});
				steps.push(step(ledger, steps.length, "out-of-frame", outcome.n, "none", false, `candidate ${outcome.n} is out of frame`, outcome.result));
				if (consecutiveStalls >= stalledLimit) return finish("stuck", "judge repeatedly named candidates outside the frame", excluded, steps, degraded, ledger);
				continue;
			}
			if (outcome.kind === "unknown-chapter") {
				consecutiveStalls += 1;
				history.push({
					action: "none",
					n: 0,
					ok: false,
					note: `judge named section ${outcome.key}, which is not in this frame`
				});
				steps.push(step(ledger, steps.length, "unknown-chapter", 0, "none", false, `section ${outcome.key} is not in the table the judge was given`, outcome.result));
				if (consecutiveStalls >= stalledLimit) return finish("stuck", "judge repeatedly named sections outside the frame", excluded, steps, degraded, ledger);
				continue;
			}
			consecutiveUnclear += 1;
			steps.push(step(ledger, steps.length, `narrowing-${outcome.kind}`, 0, "none", false, "no usable answer while narrowing", outcome.result));
			if (consecutiveUnclear >= unclearLimit) return finish("stuck", `no usable answer while narrowing ${consecutiveUnclear}×`, excluded, steps, degraded, ledger);
			continue;
		}
		const action = await input.effects.act({
			frame,
			n: outcome.n,
			action: "click"
		});
		history.push(toHistoryNote(action));
		if (!action.ok) {
			excluded.push(outcome.n);
			consecutiveStalls += 1;
			steps.push(step(ledger, steps.length, `act-failed:${action.code}`, outcome.n, "click", false, action.message, outcome.result, outcome.danger));
			if (consecutiveStalls >= stalledLimit) return finish("stuck", `action failed ${consecutiveStalls}× (${action.code})`, excluded, steps, degraded, ledger);
			continue;
		}
		consecutiveStalls = 0;
		const actionLabel = `${action.action} ${describeNodeName(outcome.node)}`;
		completed.push(`${actionLabel} in ${outcome.chapterKey ?? "the page"}`);
		progressNote = "";
		steps.push(step(ledger, steps.length, "act", outcome.n, action.action, true, describeNodeName(outcome.node), outcome.result, outcome.danger, anchorFor(frame.frameId, action.backendNodeId)));
		if (evaluate) {
			const evalRound = buildRound({
				frame,
				intent: input.intent,
				round: "evaluate",
				history,
				excluded,
				progress: progressOf(),
				config: input.pipe
			});
			const askedEval = await ask(ledger, input.effects, evalRound);
			if (!askedEval.ok) return finish("exhausted", `budget exhausted: ${askedEval.blockedBy}`, excluded, steps, degraded, ledger, askedEval.blockedBy);
			degraded = degraded || askedEval.result.degraded;
			const verdict = readEvaluation(askedEval.result);
			if (verdict.kind === "verdict" && verdict.verdict === "inprogress") {
				steps.push(step(ledger, steps.length, "evaluate:inprogress", outcome.n, "evaluate", true, `step advanced (top ${verdict.top.toFixed(2)})`, askedEval.result, outcome.danger));
				lastRevision = -1;
				continue;
			}
			if (verdict.kind === "verdict" && verdict.verdict === "done") {
				let checked;
				try {
					checked = await input.effects.verify(input.intent);
				} catch (error) {
					return finish("error", `verification threw: ${messageOf(error)}`, excluded, steps, degraded, ledger);
				}
				if (checked.satisfied) {
					steps.push(step(ledger, steps.length, "evaluate:done", outcome.n, "verify", true, checked.note, askedEval.result, outcome.danger));
					return finish("done", checked.note, excluded, steps, degraded, ledger);
				}
				steps.push(step(ledger, steps.length, "evaluate:done-unverified", outcome.n, "verify", false, checked.note, askedEval.result, outcome.danger));
				return finishEscalated({
					reason: "done-unverified",
					lastAction: actionLabel,
					verdict: `judge reported done, but the criteria do not hold on the page (${checked.note})`,
					recovery: recoveryFor("done-unverified", action.action),
					suggest: "The judge believes the goal is met while the page disagrees. Re-capture and re-check, or correct the successCriteria if they are wrong.",
					...action.recorded === void 0 ? {} : { acted: action.recorded }
				}, excluded, steps, degraded, ledger);
			}
			if (verdict.kind === "verdict" && verdict.verdict === "fail") {
				steps.push(step(ledger, steps.length, "evaluate:fail", outcome.n, "evaluate", false, `step did not advance (top ${verdict.top.toFixed(2)})`, askedEval.result, outcome.danger));
				return finishEscalated({
					reason: "step-failed",
					lastAction: actionLabel,
					verdict: "the judge reports the step did not advance",
					recovery: recoveryFor("step-failed", action.action),
					suggest: `The step "${actionLabel}" did not work. Pick a recovery and resume, or stop and report.`,
					...action.recorded === void 0 ? {} : { acted: action.recorded }
				}, excluded, steps, degraded, ledger);
			}
			if (verdict.kind === "unavailable") return finish("unavailable", "no judge could answer the progress evaluation", excluded, steps, degraded, ledger);
			const detail = verdict.kind === "unclear" ? verdict.code : verdict.kind;
			steps.push(step(ledger, steps.length, `evaluate:${verdict.kind}`, outcome.n, "evaluate", false, `verdict unusable (${detail})`, askedEval.result, outcome.danger));
			return finishEscalated({
				reason: verdict.kind === "no-answer" ? "no-verdict" : "evaluation-unclear",
				lastAction: actionLabel,
				verdict: `the progress verdict was unusable: ${detail}`,
				recovery: recoveryFor("evaluation-unclear", action.action),
				suggest: "The judge could not say whether the step advanced. Re-capture and re-evaluate, or take over.",
				...action.recorded === void 0 ? {} : { acted: action.recorded }
			}, excluded, steps, degraded, ledger);
		}
		lastRevision = -1;
	}
}
/**
* The recovery options for a failure, DERIVED from what failed.
*
* Mechanical on purpose, and always non-empty: a hand-back with no suggested
* action pushes the whole problem onto the caller, and the caller in practice is
* a model that will then guess. Naming `reload` first for a step that failed is
* the cheap, high-yield move — a page that half-rendered or lost its session
* state is repaired by a reload far more often than by a cleverer selector.
*/
function recoveryFor(reason, lastAction) {
	if (reason === "done-unverified") return [
		{
			action: "recapture",
			why: "the page may have changed after the last capture, so the criteria could now hold"
		},
		{
			action: "scroll",
			why: "the thing that would prove completion may be below the fold"
		},
		{
			action: "reload",
			why: "a stale render can hide the confirmation that was actually written"
		},
		{
			action: "abandon",
			why: "if the criteria are simply wrong, fix the intent rather than the page"
		}
	];
	if (reason === "judge-unavailable") return [{
		action: "abandon",
		why: "no judge answered, which is a configuration problem and not a page problem"
	}];
	const reloadable = lastAction === "click" || lastAction === "fill";
	const options = [];
	if (reloadable) options.push({
		action: "reload",
		why: "a failed interaction often means the page is in a stale or half-loaded state"
	});
	options.push({
		action: "recapture",
		why: "the frame the judge decided on may no longer match the page"
	}, {
		action: "scroll",
		why: "the target may have moved out of the captured region"
	}, {
		action: "back",
		why: "the last action may have navigated somewhere unhelpful"
	}, {
		action: "abandon",
		why: "the intent may not be achievable on this page at all"
	});
	return options;
}
/** Wrap up as a hand-back, with the escalation attached. */
function finishEscalated(escalation, excluded, steps, degraded, ledger) {
	return {
		status: "escalate",
		reason: escalation.suggest,
		steps,
		excluded: [...excluded],
		remaining: ledger.snapshot(),
		degraded,
		escalation,
		...escalation.acted === void 0 ? {} : { actedOn: escalation.acted }
	};
}
/**
* Narrow the page down: chunk → chapter → candidate.
*
* Why chapters at all, given the extra round trip: every gate in `wire.ts` is
* bucketed by CANDIDATE COUNT, so a 20-way question is judged against a looser
* bar than a 5-way one. Splitting 20 options into (5 sections) × (4 candidates)
* puts BOTH rounds in stricter buckets. The accuracy gain follows from the
* counts, not from a hope about the model.
*
* The chapter round is SKIPPED when the frame has one chapter: a question with a
* single option is a round trip that can only go one way.
*/
async function walkNarrowing(ledger, effects, frame, intent, history, excluded, pipe, progressOf, chapterLog) {
	const chunkSize = buildRound({
		frame,
		intent,
		round: "control",
		history,
		excluded,
		config: pipe
	}).plan.chunkSize;
	const total = frame.dom.nodes.length;
	const chunkTotal = Math.max(1, Math.ceil(total / chunkSize));
	const excludedSet = new Set(excluded);
	let last = null;
	for (let index = 1; index <= chunkTotal; index += 1) {
		if (!ledger.check("chunksPerCapture").ok) return {
			ok: false,
			blockedBy: "chunksPerCapture"
		};
		const start = (index - 1) * chunkSize;
		const live = frame.dom.nodes.slice(start, start + chunkSize).filter((node) => !excludedSet.has(node.n));
		if (live.length === 0) continue;
		ledger.spend("chunksPerCapture");
		const chapters = chaptersOf(live);
		const askChapter = shouldAskChapter(live, chapters.length);
		let targets = chapters;
		if (askChapter) {
			const asked = await ask(ledger, effects, buildRound({
				frame,
				intent,
				round: "chapter",
				chunkIndex: index,
				history,
				excluded,
				progress: progressOf(),
				config: pipe
			}));
			if (!asked.ok) return {
				ok: false,
				blockedBy: asked.blockedBy
			};
			const answer = asked.result;
			const read = readChapter(answer, chapters);
			if (read.kind === "unavailable") return {
				ok: true,
				kind: "unavailable",
				result: answer,
				degraded: answer.degraded
			};
			if (read.kind === "no-answer" || read.kind === "unclear" || read.kind === "unknown-chapter") {
				recordChapter(chapterLog, `chunk${index}`, "could not choose a section");
				if (read.kind === "unknown-chapter") return {
					ok: true,
					kind: "unknown-chapter",
					key: read.key,
					result: answer,
					degraded: answer.degraded
				};
				return {
					ok: true,
					kind: read.kind,
					code: read.kind === "unclear" ? read.code : "no-answer",
					result: answer,
					degraded: answer.degraded
				};
			}
			recordChapter(chapterLog, read.key, `chosen (top ${read.top.toFixed(2)})`);
			last = answer;
			targets = chapters.filter((chapter) => chapter.key === read.key);
		}
		for (const chapter of targets) {
			if (chapter.nodes.filter((node) => !excludedSet.has(node.n)).length === 0) {
				recordChapter(chapterLog, chapter.key, "every candidate ruled out");
				continue;
			}
			const round = buildRound({
				frame,
				intent,
				round: "pick",
				chunkIndex: index,
				chapterKey: askChapter ? chapter.key : void 0,
				history,
				excluded,
				progress: progressOf(),
				config: pipe
			});
			const asked = await ask(ledger, effects, round);
			if (!asked.ok) return {
				ok: false,
				blockedBy: asked.blockedBy
			};
			const answer = asked.result;
			const read = readPick(answer, round.laya.frame.nodes);
			if (read.kind === "pick") {
				if (askChapter) recordChapter(chapterLog, chapter.key, `acting on ${describeNodeName(read.node)}`);
				return {
					ok: true,
					kind: "pick",
					n: read.n,
					danger: read.danger,
					node: read.node,
					chapterKey: askChapter ? chapter.key : null,
					result: answer,
					degraded: answer.degraded
				};
			}
			if (read.kind === "unavailable") return {
				ok: true,
				kind: "unavailable",
				result: answer,
				degraded: answer.degraded
			};
			if (read.kind === "out-of-frame") return {
				ok: true,
				kind: "out-of-frame",
				n: read.n,
				result: answer,
				degraded: answer.degraded
			};
			if (read.kind === "unclear") {
				if (askChapter) recordChapter(chapterLog, chapter.key, `no clear candidate (${read.code})`);
				return {
					ok: true,
					kind: "unclear",
					code: read.code,
					result: answer,
					degraded: answer.degraded
				};
			}
			last = answer;
		}
	}
	if (last === null) return {
		ok: true,
		kind: "candidates-exhausted",
		result: NO_JUDGE_CALL,
		degraded: false
	};
	return {
		ok: true,
		kind: "candidates-exhausted",
		result: last,
		degraded: last.degraded
	};
}
/** Count an attempt against a chapter, keeping the most recent outcome. */
function recordChapter(log, key, outcome) {
	const existing = log.get(key);
	if (existing === void 0) log.set(key, {
		key,
		attempts: 1,
		outcome
	});
	else {
		existing.attempts += 1;
		existing.outcome = outcome;
	}
}
/**
* A stand-in response for "we never asked".
*
* `provider: 'refuse'` is the honest value: nothing answered, and every reader
* of a `JudgeChainResult` already handles that case. Using a fabricated
* `provider: 'rule'` would make an unasked question look like a heuristic answer.
*/
const NO_JUDGE_CALL = {
	answers: {},
	provider: "refuse",
	model: "",
	latencyMs: 0,
	degraded: false,
	trace: ["no-judge-call: every candidate in this frame was excluded"],
	warnings: [],
	dropped: [],
	missing: [],
	chain: []
};
async function ask(ledger, effects, round) {
	if (!ledger.check("judge").ok) return {
		ok: false,
		blockedBy: "judge"
	};
	if (!ledger.check("wallMs").ok) return {
		ok: false,
		blockedBy: "wallMs"
	};
	ledger.spend("judge");
	return {
		ok: true,
		result: await effects.judge({
			questions: round.questions,
			state: round.state
		})
	};
}
function step(ledger, index, control, n, action, ok, note, result, danger, anchor) {
	return {
		index,
		control,
		n,
		action,
		ok,
		note: danger === void 0 || danger === null ? note : `${note} (danger ${danger}/4)`,
		provider: result.provider,
		degraded: result.degraded,
		latencyMs: result.latencyMs,
		budget: ledger.snapshot(),
		...anchor === void 0 ? {} : { anchor }
	};
}
function finish(status, reason, excluded, steps, degraded, ledger, budget) {
	return {
		status,
		reason,
		...budget === void 0 ? {} : { exhaustedKind: budget },
		steps,
		excluded: [...excluded],
		remaining: ledger.snapshot(),
		degraded
	};
}
/** A candidate's label, for a trace line a human will read. */
function describeNodeName(node) {
	const name$1 = node.name === "" ? "(unnamed)" : `"${node.name}"`;
	return `${node.role} ${name$1}`;
}
const messageOf = (error) => error instanceof Error ? error.message : String(error);

//#endregion
//#region src/index.ts
const name = "dsh-browser-cdp";
const inject = [
	"tools",
	"subprocess",
	"settings"
];
const Config = Config$1;
/** Vendored ego-linux CLI shipped inside this plugin (runtime/ego-linux/bin/). */
const VENDORED_EGO_BIN = fileURLToPath(new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url));
const DEFAULT_EGO_BIN = VENDORED_EGO_BIN;
const AUTO_SPACE_PREFIX = "dsh-agent-";
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_GRACE_MS = 15e3;
const TOOL_TIMEOUT_MS = 12e4;
/** Build the script that runs the probe and emits a sentinel payload. */
function humanCheckScript(space) {
	return `${useSpace(space)}${ensureRealTab()}let __hc = null\ntry { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}) } catch { __hc = null }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, humanCheck: __hc }))\n`;
}
function createActiveSpaceTracker(defaultSpace = DEFAULT_SPACE) {
	let activeSpace = defaultSpace;
	let activeName = typeof defaultSpace === "string" ? defaultSpace : null;
	return {
		current: () => activeSpace,
		opened: (args, result) => {
			activeName = result?.name ?? str(args?.name, defaultSpace) ?? null;
			activeSpace = result?.id ?? activeName ?? defaultSpace;
		},
		selected: (space) => {
			if (space !== void 0 && space !== "") {
				activeSpace = space;
				activeName = typeof space === "string" ? space : null;
			}
		},
		closed: (space, done) => {
			if (done && (String(space) === String(activeSpace) || activeName !== null && String(space) === String(activeName))) {
				activeSpace = defaultSpace;
				activeName = typeof defaultSpace === "string" ? defaultSpace : null;
			}
		},
		resetToName: () => {
			activeSpace = activeName ?? defaultSpace;
		}
	};
}
const GLOBAL_SESSION_KEY = "__global__";
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
function deriveSlotDefaultName(rc, sessionKey) {
	const name$1 = rc.defaultSpace;
	if (name$1 === AUTO_SPACE_SENTINEL) {
		if (sessionKey === GLOBAL_SESSION_KEY) return DEFAULT_SPACE;
		return AUTO_SPACE_PREFIX + sessionSpaceToken(sessionKey);
	}
	return name$1;
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
function sessionSpaceToken(sessionId) {
	const bare = sessionId.replace(/^session-/, "").replace(/[^A-Za-z0-9-]/g, "");
	if (bare.length > 0) return bare.slice(0, 8);
	let h = 2166136261;
	for (let i = 0; i < sessionId.length; i += 1) {
		h ^= sessionId.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h.toString(16).padStart(8, "0").slice(0, 8);
}
function createSessionSpaceTracker(defaultNameFor = () => DEFAULT_SPACE) {
	const slots = /* @__PURE__ */ new Map();
	let sessionKey = GLOBAL_SESSION_KEY;
	let session;
	const slotOf = (key) => {
		let s = slots.get(key);
		if (!s) {
			const def = defaultNameFor(key);
			s = {
				activeSpace: def,
				activeName: typeof def === "string" ? def : null
			};
			slots.set(key, s);
		}
		return s;
	};
	const withSlot = (fn) => {
		fn(slotOf(sessionKey), defaultNameFor(sessionKey));
	};
	return {
		setCurrentSession: (id) => {
			session = id;
			sessionKey = id ?? GLOBAL_SESSION_KEY;
		},
		currentSession: () => session,
		current: () => slotOf(sessionKey).activeSpace,
		opened: (args, result) => {
			withSlot((s, def) => {
				s.activeName = result?.name ?? str(args?.name, def) ?? null;
				s.activeSpace = result?.id ?? s.activeName ?? def;
			});
		},
		selected: (space) => {
			if (space !== void 0 && space !== "") withSlot((s) => {
				s.activeSpace = space;
				s.activeName = typeof space === "string" ? space : null;
			});
		},
		closed: (space, done) => {
			withSlot((s, def) => {
				if (done && (String(space) === String(s.activeSpace) || s.activeName !== null && String(space) === String(s.activeName))) {
					s.activeSpace = def;
					s.activeName = typeof def === "string" ? def : null;
				}
			});
		},
		resetToName: () => {
			withSlot((s, def) => {
				s.activeSpace = s.activeName ?? def;
			});
		}
	};
}
/**
* The bundled runtime host is a single persistent browser shared by every tool call;
* concurrent tool executions would race on the same task space / tabs. All
* bcdp_* executions are therefore serialized through one in-process lock. This
* guards against concurrent tool calls within this plugin instance; separate
* harness sessions sharing the same browser remain unsupported (host-level).
*/
let egoLockChain = Promise.resolve();
function withEgoLock(fn) {
	const run = egoLockChain.then(() => fn(), () => fn());
	egoLockChain = run.then(() => void 0, () => void 0);
	return run;
}
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
const RENDER_WORKER_BIN = fileURLToPath(new URL("../bin/cdp-render-worker.mjs", import.meta.url));
const BUNDLED_WRAPPER = fileURLToPath(new URL("../bin/cdp-chrome-wrapper.sh", import.meta.url));
const IS_WIN = process.platform === "win32";
const AUTO_ADAPT_OFF = /^(0|false|no)$/i.test(process.env.EGO_BROWSER_AUTO_ADAPT ?? "");
const COMMON_CHROME_BINS = [
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/opt/google/chrome/google-chrome"
];
/** Windows registry-free probe of the usual install dirs (no subprocess). */
function windowsChromeCandidates() {
	const pf = process.env.ProgramFiles;
	const pfx86 = process.env["ProgramFiles(x86)"];
	const local = process.env.LOCALAPPDATA;
	local || `${process.env.USERPROFILE || process.env.HOME || ""}`;
	const b = (p) => p ? p.replace(/\\+$/, "") : p;
	return [
		b(pf) + "\\Google\\Chrome\\Application\\chrome.exe",
		b(pfx86) + "\\Google\\Chrome\\Application\\chrome.exe",
		b(local) + "\\Google\\Chrome\\Application\\chrome.exe",
		b(pf) + "\\Microsoft\\Edge\\Application\\msedge.exe",
		b(pfx86) + "\\Microsoft\\Edge\\Application\\msedge.exe",
		b(local) + "\\Microsoft\\Edge\\Application\\msedge.exe",
		b(pfx86) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		b(local) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
	].filter(Boolean);
}
/** Find a usable Chrome binary by scanning PATH + common fixed locations. */
function findChromeBinary() {
	if (process.env.EGO_LINUX_CHROME) return process.env.EGO_LINUX_CHROME;
	if (IS_WIN) {
		for (const p of windowsChromeCandidates()) try {
			if (existsSync(p)) return p;
		} catch {}
		const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((e) => e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`);
		const dirs = (process.env.PATH ?? "").split(";").map((d) => d.replace(/^"|"$/g, "")).filter(Boolean);
		for (const dir of dirs) for (const name$1 of [
			"chrome",
			"msedge",
			"brave"
		]) for (const ext of exts) try {
			const p = `${dir}\\${name$1}${ext}`;
			if (existsSync(p)) return p;
		} catch {}
		return;
	}
	for (const name$1 of COMMON_CHROME_BINS) if (name$1.includes("/")) try {
		if (existsSync(name$1)) return name$1;
	} catch {}
	else for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const p = `${dir}/${name$1}`;
		try {
			if (existsSync(p)) return p;
		} catch {}
	}
}
/** Root detection only makes sense on POSIX; Windows doesn't gate on sandbox. */
function isPosixRoot(platform = process.platform) {
	const uid = process.getuid?.();
	return typeof uid === "number" && uid === 0 && platform !== "win32";
}
/** No display server �?headless is required (Linux/macOS headless servers). */
function isHeadlessDetected(platform = process.platform, env = process.env) {
	if (platform === "win32" || platform === "darwin") return false;
	return env.DISPLAY === void 0 || env.DISPLAY === "";
}
/**
* Build the env handed to `ego-browser nodejs` spawns. See the block comment
* above ("environment self-adaptation") for the design contract.
*
* Platform/env are injectable for testing; production calls use process defaults.
*/
function resolveEgoEnv(cfg, { platform = process.platform, baseEnv = process.env } = {}) {
	if (AUTO_ADAPT_OFF) return baseEnv;
	const env = { ...baseEnv };
	if (process.versions.electron && env.ELECTRON_RUN_AS_NODE === void 0) env.ELECTRON_RUN_AS_NODE = "1";
	const chrome = findChromeBinary();
	const configChrome = cfg?.chromePath;
	if (env.EGO_LINUX_CHROME === void 0 && configChrome) env.EGO_LINUX_CHROME = configChrome;
	if (env.EGO_LINUX_CHROME === void 0 && isPosixRoot(platform) && chrome) env.EGO_LINUX_CHROME = BUNDLED_WRAPPER;
	if (env.EGO_LINUX_CHROME === void 0 && platform === "win32" && chrome) env.EGO_LINUX_CHROME = chrome;
	if (env.EGO_LINUX_HEADLESS === void 0 && isHeadlessDetected(platform, env)) env.EGO_LINUX_HEADLESS = "1";
	const configChromeArgs = cfg?.chromeArgs;
	if (env.EGO_LINUX_EXTRA_ARGS === void 0 && typeof configChromeArgs === "string" && configChromeArgs.trim() !== "") env.EGO_LINUX_EXTRA_ARGS = configChromeArgs;
	if (env.EGO_ISOLATE_SPACES === void 0 && cfg?.isolateSpaces !== void 0) env.EGO_ISOLATE_SPACES = cfg.isolateSpaces ? "1" : "0";
	const decision = decideCdpAttach(cfg);
	if (decision.kind === "inject") env[EGO_LINUX_CDP_URL] = decision.wsUrl;
	else if (decision.kind === "local" && cfg.cdpMode === "local" && env[EGO_LINUX_CDP_URL] === void 0) {
		const local = defaultAttachCache.get();
		if (local.status === "ready" && local.endpointSource === "local" && local.wsUrl !== "") env[EGO_LINUX_CDP_URL] = local.wsUrl;
	}
	if (env.EGO_LINUX_CURSOR === void 0 && cfg?.cursorHud !== void 0) env.EGO_LINUX_CURSOR = cfg.cursorHud ? "1" : "0";
	if (env.EGO_LINUX_CURSOR_NAME === void 0 && typeof cfg?.cursorName === "string" && cfg.cursorName !== "") env.EGO_LINUX_CURSOR_NAME = cfg.cursorName;
	return env;
}
/**
* The channel that owns routing right now: `resolveEffectiveLink` over the
* CURRENT config (activation first, sequence order as the visible fallback),
* plus the attach cache SCOPED to that link. After any links event
* (enable/activation toggle, reorder, add, remove) the async refresh may still
* be probing; a cache row describing the PREVIOUS owner must not leak its
* linkKind/cliPath/wsUrl into the new channel's spawn decisions.
*/
function effectiveChannel(cfg) {
	const effective = resolveEffectiveLink(cfg.links ?? [], cfg.activeTargetId ?? "");
	const live = defaultAttachCache.get();
	return {
		effective,
		attach: effective && attachMatchesLink(live, effective.link) ? live : emptyAttachState()
	};
}
/**
* Read the attach decision for the CURRENTLY configured mode/activation.
* Pure over (cfg, cache) — the decision table itself lives in cdp-targets.ts.
*/
function decideCdpAttach(cfg) {
	const { effective, attach } = effectiveChannel(cfg);
	return decideAttach({
		mode: cfg?.cdpMode ?? "auto",
		hasActive: effective !== null,
		status: attach.status,
		wsUrl: attach.wsUrl,
		code: attach.code,
		message: attach.message,
		allowLocalFallback: Boolean(cfg?.allowLocalFallback),
		remoteDisabled: cfg?.remoteEnabled === false,
		...effective ? { linkKind: effective.link.kind } : {},
		localLauncherReady: true
	});
}
/**
* Gating helper for every browser-driving spawn. Returns a human-readable
* reason when the call must NOT reach the runtime, or null when it may
* proceed. `local` decisions always pass: that is the explicit escape hatch
* the user asked for.
*/
function cdpAttachError(cfg) {
	const decision = decideCdpAttach(cfg);
	if (decision.kind === "error") return `${decision.code}: ${decision.message}`;
	return null;
}
function describeStderr(stderr) {
	const tail = stderr.trim();
	return tail === "" ? "" : `\n--- ego-browser stderr (tail) ---\n${tail.slice(-2e3)}`;
}
function describeSpawnFailure(err) {
	const msg = err instanceof Error ? err.message : String(err);
	if (/ENOENT|spawn .* ENOENT|not found|could not load|cannot find module/i.test(msg)) return "ego-browser CLI could not be started. For the vendored runtime, make sure a Chrome/Chromium is reachable (PATH, or set EGO_LINUX_CHROME; root users need a --no-sandbox wrapper, see AGENTS.md). To use an official host instead, set egoBin to your `ego-browser` command. " + msg;
	return `failed to start ego-browser: ${msg}`;
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
	/ECONNREFUSED/i
];
function isColdStartError(message) {
	return COLD_START_SIGNS.some((re) => re.test(message));
}
/**
* Run `fn` (a per-call `ego-browser` spawn) up to `tries` times with a short
* backoff, retrying ONLY when the failure matches a transient cold-start
* signature. Real errors return on their first occurrence so they are never
* masked. Each retry re-spawns a fresh process, which is exactly what lets a
* warmed-up browser connect on a later attempt.
*/
async function withWarmupRetry(fn, { tries = 3, baseDelayMs = 600 } = {}) {
	let last;
	for (let i = 0; i < tries; i++) {
		const result = await fn();
		if (result.ok || !isColdStartError(result.error ?? "")) return result;
		last = result;
		if (i < tries - 1) await new Promise((resolve$1) => setTimeout(resolve$1, baseDelayMs * (i + 1)));
	}
	return last;
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
function shouldReapBrowser(nowMs, lastActivityMs, idleTimeoutMin) {
	if (!(idleTimeoutMin > 0) || !(lastActivityMs > 0)) return false;
	return nowMs - lastActivityMs > idleTimeoutMin * 6e4;
}
/**
* Pop the agent browser out as a REAL visible window (issue #51). The
* runtime's `--open` subcommand replaces a headless instance with a headed
* one on the same profile (tabs restore) or just raises the existing window.
* `--open` is on the runtimeArgs blocklist only because USER-supplied args
* must not steal the window �?here it is an explicit user action from the
* watch panel. --open stops+relaunches when headless, so give it real time.
*/
async function openAgentWindow(ctx, cfg) {
	try {
		const gate = cdpAttachError(cfg);
		if (gate) return {
			ok: false,
			error: gate
		};
		if (effectiveChannel(cfg).effective?.link.kind === EGO_CLI_KIND) {
			ctx.logger?.info?.("dsh-browser-cdp: ego-cli: browser already visible, skipping --open");
			return { ok: true };
		}
		const handle = ctx.subprocess.spawn({
			argv: [...cfg.egoArgvPrefix, "--open"],
			cwd: process.cwd(),
			env: resolveEgoEnv(cfg),
			stdio: {
				stdin: { data: "" },
				stdout: { maxBytes: 4096 },
				stderr: { maxBytes: 4096 }
			},
			graceMs: 25e3
		});
		const outcome = await handle.done;
		if (outcome.exitCode !== 0) return {
			ok: false,
			error: readAll(handle.collected.stderr).trim() || `ego-browser --open exited with code ${outcome.exitCode}`
		};
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: describeSpawnFailure(err)
		};
	}
}
/** @internal exported for tests */
async function runWithStaleSpaceRetry(ctx, cfg, exec, buildScript, graceOverrideMs) {
	let result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs));
	if (!result.ok && /task space not found: \d+/.test(result.error ?? "")) {
		cfg.spaceTracker.resetToName();
		result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs));
	}
	if (!result.ok && CDP_CONNECT_FAIL_RE.test(result.error ?? "")) {
		if (await cfg.refreshAttach?.() === true) result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs));
	}
	return result;
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
const TAB_STUCK_RE = /no active tab|navigation (?:timed out|timeout)|page\.goto[\s\S]*timeout|timed out after \d+ms|net::ERR_|waiting for (?:document|load) timed out|TimeoutError|target closed/i;
/**
* A dead cached ws (the browser was relaunched behind the SAME endpoint) surfaces
* as this one runtime message — see `runtime/ego-linux/src/transport.mjs`. It is
* deliberately NOT folded into `TAB_STUCK_RE`: the fix is a re-probe of the link,
* not a tab swap, so the two recoveries must stay distinguishable.
*/
const CDP_CONNECT_FAIL_RE = /failed to connect to CDP endpoint|CDP channel is not open/i;
/** True when a failed run looks like a wedged/absent tab rather than a cold start. */
function isTabStuckFailure(result) {
	const hay = `${result.error ?? ""}\n${result.stderr ?? ""}`;
	return TAB_STUCK_RE.test(hay);
}
/** Heredoc that swaps the stuck target for a fresh blank one (see runWithTabRevive). */
function tabReviveScript() {
	return `const __before = await browser.listTabs()
const __stuck = __before.find(t => t.active) ?? __before[0]
await browser.openOrReuseTab('about:blank', { wait: true, timeout: 8000 })
if (__stuck) { await browser.closeTab(__stuck.targetId) }
console.log('${SENTINEL}' + JSON.stringify({ ok: true, revived: true, closed: __stuck?.targetId ?? null }))\n`;
}
/**
* @internal exported for tests. Returns the final WarmupResult plus what it
* recovered from (null on the normal path, so the tool result always carries
* a `recoveredFrom` field the model can see).
*/
async function runWithTabRevive(ctx, cfg, exec, buildScript, graceOverrideMs) {
	const first = await runWithStaleSpaceRetry(ctx, cfg, exec, buildScript, graceOverrideMs);
	if (first.ok || !isTabStuckFailure(first)) return {
		result: first,
		recoveredFrom: null
	};
	const recoveredFrom = (first.error ?? first.stderr ?? "tab stuck").trim().slice(0, 500);
	await runEgoScript(ctx.subprocess, tabReviveScript(), exec, cfg, graceOverrideMs);
	return {
		result: await runWithStaleSpaceRetry(ctx, cfg, exec, buildScript, graceOverrideMs),
		recoveredFrom
	};
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
function parseSentinel(stdout) {
	const lines = stdout.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const idx = lines[i].indexOf(SENTINEL);
		if (idx === -1) continue;
		const payload = lines[i].slice(idx + SENTINEL.length).trim();
		try {
			return JSON.parse(payload);
		} catch {
			return;
		}
	}
	return lastJsonObject(stdout);
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
function lastJsonObject(text) {
	let best;
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === "\"") inString = false;
			continue;
		}
		if (c === "\"") {
			inString = true;
			continue;
		}
		if (c === "{") {
			if (depth === 0) start = i;
			depth += 1;
			continue;
		}
		if (c !== "}") continue;
		if (depth === 0) continue;
		depth -= 1;
		if (depth !== 0 || start < 0) continue;
		let p = start - 1;
		while (p >= 0 && (text[p] === " " || text[p] === "	" || text[p] === "\r")) p -= 1;
		const atLineStart = p < 0 || text[p] === "\n";
		try {
			const parsed = atLineStart ? JSON.parse(text.slice(start, i + 1)) : null;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) best = parsed;
		} catch {}
		start = -1;
	}
	return best;
}
/** R2/R3 �?sentinel + payload for the `bcdp_status` facade probe. @internal exported for tests */
const STATUS_FACADE_SENTINEL = "__BCDP_STATUS__";
/** @internal exported for tests �?the exact heredoc the status probe runs. */
const STATUS_FACADE_SCRIPT = `console.log(${JSON.stringify(STATUS_FACADE_SENTINEL)} + JSON.stringify({ taskSpaces: typeof taskSpaces, browser: typeof browser, page: typeof page }))
`;
/**
* Parse the facade payload the status probe prints; `undefined` if absent.
* @internal exported for tests
*/
function parseStatusFacades(stdout) {
	const lines = stdout.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const idx = lines[i].indexOf(STATUS_FACADE_SENTINEL);
		if (idx === -1) continue;
		const payload = lines[i].slice(idx + 15).trim();
		try {
			const parsed = JSON.parse(payload);
			return {
				taskSpaces: typeof parsed.taskSpaces === "string" ? parsed.taskSpaces : "undefined",
				browser: typeof parsed.browser === "string" ? parsed.browser : "undefined",
				page: typeof parsed.page === "string" ? parsed.page : "undefined"
			};
		} catch {
			return;
		}
	}
}
/**
* R7 �?is the old dsh-ego-browser plugin installed anywhere under this DSH home?
*
* Reported (never enforced): the two plugins can coexist now that tool names
* and routes no longer overlap, but both driving ONE local ego browser would
* fight over the same task spaces, and that plugin's handoff API has no
* ownership check. A warning is the honest limit of what we can do here.
*/
function findUpstreamPluginInstall(home = process.env.HOME || process.env.USERPROFILE || homedir()) {
	const profiles = `${home}/.dsh/profiles`;
	try {
		for (const profile$1 of readdirSync(profiles)) {
			const dir = `${profiles}/${profile$1}/node_modules/dsh-ego-browser`;
			if (existsSync(dir)) return dir;
		}
	} catch {}
	return "";
}
/**
* R1 �?argv for one tool run. Single source of truth for the `--sdk-path`
* injection: `bcdp_status` and `runEgoScript` must probe/run under the exact
* same conditions, otherwise "available" and "actually works" diverge again.
* @internal exported for tests
*/
function buildEgoToolArgv(prefix, attach, runtimeArgs) {
	const extraCliArgs = filterArgs(runtimeArgs, EGO_CLI_BLOCKED);
	const sdkArgs = attach.linkKind === EGO_CLI_KIND && (attach.sdkPath ?? "") !== "" ? ["--sdk-path", attach.sdkPath] : [];
	return [
		...prefix,
		"nodejs",
		...sdkArgs,
		...extraCliArgs
	];
}
async function runEgoScript(subprocess, script, exec, cfg, graceOverrideMs) {
	let handle;
	try {
		const { attach } = effectiveChannel(cfg);
		handle = subprocess.spawn({
			argv: buildEgoToolArgv(cfg.egoArgvPrefix, attach, cfg.runtimeArgs ?? ""),
			cwd: process.cwd(),
			env: resolveEgoEnv(cfg),
			stdio: {
				stdin: { data: script },
				stdout: {
					maxBytes: cfg.maxOutputBytes,
					spill: { maxBytes: cfg.maxOutputBytes }
				},
				stderr: {
					maxBytes: cfg.maxOutputBytes,
					spill: { maxBytes: cfg.maxOutputBytes }
				}
			},
			graceMs: Number.isFinite(graceOverrideMs) && graceOverrideMs > 0 ? graceOverrideMs : cfg.graceMs,
			...exec.signal !== void 0 ? { signal: exec.signal } : {}
		});
	} catch (err) {
		return {
			ok: false,
			error: describeSpawnFailure(err),
			stdout: "",
			stderr: ""
		};
	}
	let outcome;
	try {
		outcome = await handle.done;
	} catch (err) {
		return {
			ok: false,
			error: describeSpawnFailure(err),
			stdout: "",
			stderr: ""
		};
	}
	const stdout = readAll(handle.collected.stdout);
	const stderr = readAll(handle.collected.stderr);
	if (exec.signal !== void 0 && exec.signal.aborted) return {
		ok: false,
		error: "ego-browser tool aborted (harness timeout or cancellation)",
		stdout,
		stderr
	};
	if (outcome.exitCode !== 0) return {
		ok: false,
		error: /Cannot find module|MODULE_NOT_FOUND/i.test(stderr) ? describeSpawnFailure(/* @__PURE__ */ new Error(`node could not load ${cfg.egoBin}`)) : `ego-browser exited with ${outcome.exitCode !== null ? `code ${outcome.exitCode}` : `signal ${String(outcome.signal)}`}${describeStderr(stderr)}`,
		stdout,
		stderr
	};
	return {
		ok: true,
		value: parseSentinel(mergeCliOutput({
			stdout,
			stderr
		})),
		stdout,
		stderr
	};
}
/** How much raw stdout a tool may hand back when a script emitted no JSON. */
const TOOL_RAW_STDOUT_MAX = 4e3;
/**
* The payload a bcdp_* tool returns for a successful run.
*
* Dropping `undefined` straight into the tool result would show the model an
* empty outcome for a script that actually ran, so fall back to the (bounded)
* raw stdout plus a note naming the reason. Structured tools always emit a
* sentinel payload and never take this branch.
*/
function toolPayload(result) {
	if (result.value !== void 0) return result.value;
	return {
		ok: true,
		stdout: (result.stdout ?? "").trim().slice(0, TOOL_RAW_STDOUT_MAX),
		note: "no JSON payload on stdout; raw output returned"
	};
}
/** JS snippet that pins an action tool to one task space. */
const useSpace = (name$1) => `const task = await taskSpaces.useOrCreate(${j(name$1)})\n`;
/**
* JS snippet that makes the harness act on a real page tab.
*
* The Linux host (PR #234 ego-linux) does not reliably persist "current tab"
* across CLI invocations: a fresh process sometimes resolves page actions
* against a blank/stale tab. Selecting the first non-blank tab in the space
* before acting makes cross-process tool calls deterministic.
*/
const ensureRealTab = () => "const __tabs = await browser.listTabs()\nconst __real = __tabs.find(t => !t.url.startsWith('about:') && !t.url.startsWith('chrome://')) ?? __tabs[0]\nif (__real) await browser.switchTab(__real.targetId)\n";
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
const ATTACH_SESSION_HINT = "hint: call `await taskSpaces.useOrCreate(name)` (and `browser.switchTab(...)` if the space has no real tab) before using page.* in a raw heredoc — structured bcdp_* tools do this for you.";
function attachSessionHint(errorText) {
	const t = errorText ?? "";
	if (!/no active tab to attach session/.test(t)) return t;
	return t.includes(ATTACH_SESSION_HINT) ? t : `${t}\n${ATTACH_SESSION_HINT}`;
}
function renderText(_args, value) {
	const v = value;
	if (v !== null && typeof v === "object" && v.ok === true && typeof v.text === "string") return [{
		type: "text",
		text: v.text
	}];
	return [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
}
const commonOutputSchema = {
	type: "object",
	additionalProperties: true,
	properties: { ok: {
		type: "boolean",
		required: true
	} }
};
/**
* The calling session id �?the scope the client's sidebar auto-open binds to.
* Read structurally (`exec.agent` is typed `unknown` in this plugin's own
* seam); a call with no initiating agent simply leaves the open unscoped.
*/
function callingSessionId(exec) {
	const id = (exec?.agent)?.session?.id;
	return typeof id === "string" && id !== "" ? id : void 0;
}
function defineEgoTool(ctx, cfg, opts) {
	return defineTool({
		name: opts.name,
		description: opts.description,
		parameters: opts.parameters,
		output: {
			schema: commonOutputSchema,
			render: renderText
		},
		timeoutMs: TOOL_TIMEOUT_MS,
		execute: async (args, exec) => withEgoLock(async () => {
			cfg.spaceTracker.setCurrentSession(callingSessionId(exec));
			markEgoToolCall(callingSessionId(exec));
			if (typeof opts.gate === "function") {
				const blocked = opts.gate(args);
				if (blocked !== null && blocked !== "") return {
					ok: false,
					text: blocked
				};
			}
			if (opts.tabRevive) {
				const { result: result$1, recoveredFrom } = await runWithTabRevive(ctx, cfg, exec, () => opts.buildScript(args));
				if (!result$1.ok) throw new Error(recoveredFrom ? `${result$1.error}\n${recoveredFrom}` : result$1.error);
				if (result$1.value && typeof result$1.value === "object") result$1.value.recoveredFrom = recoveredFrom;
				if (typeof opts.afterExecute === "function") opts.afterExecute(args, result$1.value);
				return toolPayload(result$1);
			}
			const result = await runWithStaleSpaceRetry(ctx, cfg, exec, () => opts.buildScript(args));
			if (!result.ok) throw new Error(result.error);
			if (typeof opts.afterExecute === "function") opts.afterExecute(args, result.value);
			return toolPayload(result);
		}),
		presentCall: () => ({
			card: "generic",
			title: opts.name,
			kind: "other",
			rawInput: null
		})
	});
}
const scopeProbe = {
	restrictType: "n/a",
	onType: "n/a",
	agentsSvc: "n/a",
	agentCount: -1,
	createdEvents: 0,
	agentHasCtx: "n/a",
	agentCtxRestrict: "n/a",
	agentCtxTools: "n/a",
	error: ""
};
/** Inspect one agent handle (host-side shape varies) and remember what we reached. */
function probeAgent(agent) {
	if (agent == null) return;
	scopeProbe.agentHasCtx = String(agent.ctx != null);
	scopeProbe.agentCtxTools = typeof agent?.ctx?.tools;
	scopeProbe.agentCtxRestrict = typeof agent?.ctx?.tools?.restrict;
}
/** Install the probe once per mount: capability types + live agent enumeration + lifecycle event. */
function installScopeProbe(ctx) {
	try {
		const anyCtx = ctx;
		scopeProbe.restrictType = typeof anyCtx?.tools?.restrict;
		scopeProbe.onType = typeof anyCtx?.on;
		const agents = typeof anyCtx.get === "function" ? anyCtx.get("agents") : void 0;
		scopeProbe.agentsSvc = agents == null ? "absent" : "present";
		if (agents != null) {
			const list = typeof agents.roots === "function" ? agents.roots() : typeof agents.list === "function" ? agents.list() : [];
			scopeProbe.agentCount = Array.isArray(list) ? list.length : -2;
			probeAgent(Array.isArray(list) ? list[0] : void 0);
		}
		if (scopeProbe.onType === "function") {
			const off = anyCtx.on("agent/created", (payload) => {
				scopeProbe.createdEvents += 1;
				probeAgent(payload?.agent ?? payload);
			});
			ctx.effect?.(() => typeof off === "function" ? off : () => void 0);
		}
	} catch (err) {
		scopeProbe.error = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
	}
}
/** One-line render for the doctor report. */
function scopeProbeLine() {
	return `scope probe: tools.restrict=${scopeProbe.restrictType} ctx.on=${scopeProbe.onType} agentsSvc=${scopeProbe.agentsSvc} agentCount=${scopeProbe.agentCount} agentCreatedEvents=${scopeProbe.createdEvents} agentHasCtx=${scopeProbe.agentHasCtx} agent.ctx.tools=${scopeProbe.agentCtxTools} agent.ctx.tools.restrict=${scopeProbe.agentCtxRestrict}` + (scopeProbe.error !== "" ? ` error=${scopeProbe.error}` : "");
}
function apply(ctx, config = {}) {
	installScopeProbe(ctx);
	const bridge = installSettingsAuto(ctx, config);
	const ffmpegManager = getSharedFfmpegInstallationManager();
	const initialFfmpegConfig = resolveConfig(bridge.source());
	ffmpegManager.check({
		configuredPath: initialFfmpegConfig.ffmpegPath,
		requestedEncoder: initialFfmpegConfig.ffmpegEncoder
	}).catch(() => {});
	const spaceTracker = createSessionSpaceTracker((sessionKey) => deriveSlotDefaultName(resolveConfig(bridge.source()), sessionKey));
	let triggerCdpRef;
	const cfg = {
		refreshAttach: () => triggerCdpRef?.() ?? Promise.resolve(false),
		egoBin: typeof config.egoBin === "string" && config.egoBin !== "" ? config.egoBin : DEFAULT_EGO_BIN,
		get configuredDefaultSpace() {
			return resolveConfig(bridge.source()).defaultSpace;
		},
		spaceTracker,
		get defaultSpace() {
			return resolveConfig(bridge.source()).defaultSpace;
		},
		get activeSpace() {
			return this.spaceTracker.current();
		},
		maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
		get chromePath() {
			return resolveConfig(bridge.source()).chromePath;
		},
		get captureBackend() {
			return resolveConfig(bridge.source()).captureBackend;
		},
		get streamProfile() {
			return resolveConfig(bridge.source()).streamProfile;
		},
		get cdpFps() {
			return resolveConfig(bridge.source()).cdpFps;
		},
		get cdpQuality() {
			return resolveConfig(bridge.source()).cdpQuality;
		},
		get cdpMaxWidth() {
			return resolveConfig(bridge.source()).cdpMaxWidth;
		},
		get cdpBackstopIntervalMs() {
			return resolveConfig(bridge.source()).cdpBackstopIntervalMs;
		},
		get ffmpegFps() {
			return resolveConfig(bridge.source()).ffmpegFps;
		},
		get ffmpegMaxWidth() {
			return resolveConfig(bridge.source()).ffmpegMaxWidth;
		},
		get ffmpegBitrateKbps() {
			return resolveConfig(bridge.source()).ffmpegBitrateKbps;
		},
		get ffmpegEncoder() {
			return resolveConfig(bridge.source()).ffmpegEncoder;
		},
		get ffmpegPath() {
			return resolveConfig(bridge.source()).ffmpegPath;
		},
		get githubMirror() {
			return resolveConfig(bridge.source()).githubMirror;
		},
		get runtimeArgs() {
			return resolveConfig(bridge.source()).runtimeArgs;
		},
		get chromeArgs() {
			return resolveConfig(bridge.source()).chromeArgs;
		},
		get isolateSpaces() {
			return resolveConfig(bridge.source()).isolateSpaces;
		},
		get idleTimeoutMin() {
			return resolveConfig(bridge.source()).idleTimeoutMin;
		},
		get toolInjection() {
			return resolveConfig(bridge.source()).toolInjection;
		},
		get toolBrowse() {
			return resolveConfig(bridge.source()).toolBrowse;
		},
		get toolExtended() {
			return resolveConfig(bridge.source()).toolExtended;
		},
		get toolEscape() {
			return resolveConfig(bridge.source()).toolEscape;
		},
		get toolJudge() {
			return resolveConfig(bridge.source()).toolJudge;
		},
		get sessionScopedPulse() {
			return resolveConfig(bridge.source()).sessionScopedPulse;
		},
		get links() {
			return resolveConfig(bridge.source()).links;
		},
		get droppedEgoCli() {
			const raw = bridge.source();
			return sanitizeLinks(raw.links ?? raw.cdpTargets).droppedEgoCli;
		},
		get egoArgvPrefix() {
			const { effective, attach } = effectiveChannel(this);
			if (effective?.link.kind === EGO_CLI_KIND && attach.cliPath) return spawnArgvFor(attach.cliShape === "node" ? "node" : "direct", attach.cliPath, []);
			return [process.execPath, this.egoBin];
		},
		get activeTargetId() {
			return resolveConfig(bridge.source()).activeTargetId;
		},
		get cdpMode() {
			return resolveConfig(bridge.source()).cdpMode;
		},
		get cdpProbeTimeoutMs() {
			return resolveConfig(bridge.source()).cdpProbeTimeoutMs;
		},
		get cursorHud() {
			return resolveConfig(bridge.source()).cursorHud;
		},
		get cursorName() {
			return resolveConfig(bridge.source()).cursorName;
		},
		get allowLocalFallback() {
			return resolveConfig(bridge.source()).allowLocalFallback;
		},
		get legacyEgoToolNames() {
			return resolveConfig(bridge.source()).legacyEgoToolNames;
		},
		get localHeadless() {
			return resolveConfig(bridge.source()).localHeadless;
		},
		get remoteEnabled() {
			return resolveConfig(bridge.source()).remoteEnabled;
		},
		get localUserDataDir() {
			return resolveConfig(bridge.source()).localUserDataDir;
		},
		get lightpandaArgs() {
			return resolveConfig(bridge.source()).lightpandaArgs;
		},
		get allowProbeColdStart() {
			return resolveConfig(bridge.source()).allowProbeColdStart;
		},
		get jevUrl() {
			return judgeSettingsOf(resolveConfig(bridge.source())).jevUrl;
		},
		get jevKey() {
			return judgeSettingsOf(resolveConfig(bridge.source())).jevKey;
		},
		get jevModel() {
			return judgeSettingsOf(resolveConfig(bridge.source())).jevModel;
		},
		get layaUrl() {
			return judgeSettingsOf(resolveConfig(bridge.source())).layaUrl;
		},
		get layaKey() {
			return judgeSettingsOf(resolveConfig(bridge.source())).layaKey;
		},
		get layaModel() {
			return judgeSettingsOf(resolveConfig(bridge.source())).layaModel;
		},
		get judgePrefer() {
			return judgeSettingsOf(resolveConfig(bridge.source())).prefer;
		},
		get jevChunkSize() {
			return judgeSettingsOf(resolveConfig(bridge.source())).chunkSize;
		},
		get jevMaxImageBytes() {
			return judgeSettingsOf(resolveConfig(bridge.source())).maxImageBytes;
		},
		get jevHistoryLimit() {
			return judgeSettingsOf(resolveConfig(bridge.source())).historyLimit;
		},
		get jevArchiveImage() {
			return judgeSettingsOf(resolveConfig(bridge.source())).archiveImage;
		},
		get jevEvaluate() {
			return judgeSettingsOf(resolveConfig(bridge.source())).evaluate;
		},
		get jevStepBudget() {
			return judgeSettingsOf(resolveConfig(bridge.source())).stepBudget;
		},
		get jevWallMs() {
			return judgeSettingsOf(resolveConfig(bridge.source())).wallMs;
		}
	};
	let browserActive = false;
	const sessionDepth = /* @__PURE__ */ new Map();
	let browseBatchDepth = 0;
	/** Compute max depth from all tracked sessions, or 0 if none. */
	const maxSessionDepth = () => {
		let m = 0;
		for (const d of sessionDepth.values()) if (d > m) m = d;
		return m;
	};
	const tiers = createTierInjector({
		register: (tool) => {
			const dispose = ctx.tools.register(tool);
			ctx.effect?.(() => dispose);
			return dispose;
		},
		policy: () => ({
			injection: cfg.toolInjection,
			toolBrowse: cfg.toolBrowse,
			toolExtended: cfg.toolExtended,
			toolEscape: cfg.toolEscape,
			toolJudge: cfg.toolJudge,
			judgeConfigured: judgeConfigured({
				jevKey: cfg.jevKey,
				layaKey: cfg.layaKey
			}),
			active: browserActive,
			batchDepth: browseBatchDepth
		}),
		logger: ctx.logger
	});
	/**
	* Apply per-session restrict to hide globally-registered tools that exceed
	* the calling agent's own depth. Best-effort: silently no-ops when the host
	* does not expose agent-scoped restriction (plugin fiber is not an agent scope).
	*/
	const tryRestrictSession = (sessionId) => {
		if (!cfg.sessionScopedPulse || !sessionId) return;
		try {
			const depth = sessionDepth.get(sessionId) ?? 0;
			const allowed = /* @__PURE__ */ new Set();
			for (const n of TIER_MEMBERS.core) allowed.add(n);
			const pol = {
				injection: cfg.toolInjection,
				toolBrowse: cfg.toolBrowse,
				toolExtended: cfg.toolExtended,
				toolEscape: cfg.toolEscape,
				toolJudge: cfg.toolJudge,
				judgeConfigured: judgeConfigured({
					jevKey: cfg.jevKey,
					layaKey: cfg.layaKey
				}),
				active: depth > 0,
				batchDepth: depth
			};
			for (const name$1 of tiers.surface().live) if (toolAllowed(name$1, pol)) allowed.add(name$1);
			const restrictFn = ctx.tools.restrict;
			if (typeof restrictFn === "function") restrictFn({ allow: [...allowed] });
		} catch {}
	};
	/**
	* Activity pulse: advance browse batch depth. When sessionScopedPulse is ON
	* and a sessionId is given, only that session's depth advances; the global
	* depth = max across sessions drives tier registration. Without restrict
	* support the effect is still beneficial for per-session sealAfterReap.
	*/
	const pulseActivity = (sessionId) => {
		const before = browseBatchDepth;
		browserActive = true;
		if (cfg.sessionScopedPulse && sessionId) {
			const cur = Math.min(BATCH_ORDER.length, (sessionDepth.get(sessionId) ?? 0) + 1);
			sessionDepth.set(sessionId, cur);
			browseBatchDepth = Math.max(browseBatchDepth, maxSessionDepth());
		} else browseBatchDepth = Math.min(BATCH_ORDER.length, browseBatchDepth + 1);
		if (before !== browseBatchDepth) tiers.reapply();
		if (cfg.sessionScopedPulse && sessionId) tryRestrictSession(sessionId);
	};
	{
		const offActivity = onEgoActivity(pulseActivity);
		ctx.effect?.(() => offActivity);
	}
	/**
	* Seal: idle reaper resets depths. With sessionScopedPulse, only sessions
	* whose last activity exceeded the timeout are sealed; when ALL are idle the
	* global depth drops to 0 (same observable behaviour as before).
	*/
	const sealAfterReap = () => {
		if (cfg.toolInjection !== "lazy" || !browserActive) return;
		if (cfg.sessionScopedPulse && sessionDepth.size > 0) {
			sessionDepth.clear();
			browseBatchDepth = 0;
		} else browseBatchDepth = 0;
		browserActive = false;
		tiers.reapply();
	};
	const tierView = {
		pulse: pulseActivity,
		active: () => browserActive,
		surface: () => tiers.surface()
	};
	const reg = (tool) => {
		tiers.offer(tool);
		if (cfg.legacyEgoToolNames && typeof tool.name === "string" && tool.name.startsWith("bcdp_")) {
			const alias = {
				...tool,
				name: "ego_" + tool.name.slice(5)
			};
			try {
				tiers.offer(alias);
			} catch (error) {
				ctx.logger?.warn?.(`dsh-browser-cdp: legacy alias ${alias.name} not registered: ${error.message}`);
			}
		}
	};
	registerEgoStatus(ctx, cfg, reg, tierView);
	registerAuthFlush(ctx, cfg, reg);
	registerLoginImport(ctx, cfg, reg);
	registerActionTools(ctx, cfg, reg);
	registerHelpAndDoctor(ctx, cfg, reg, tierView);
	{
		const s = tiers.surface();
		const unlisted = unknownTieredTools([...s.live, ...s.sealed]);
		if (unlisted.length > 0) ctx.logger?.warn?.(`dsh-browser-cdp: tools missing from the tier table (defaulted to power): ${unlisted.join(" ")}`);
		ctx.logger?.info?.(`dsh-browser-cdp: tool surface ${s.live.length}/${s.live.length + s.sealed.length} (injection=${cfg.toolInjection}, switches browse=${cfg.toolBrowse ? "open" : "sealed"} extended=${cfg.toolExtended ? "open" : "sealed"} escape=${cfg.toolEscape ? "open" : "sealed"} judge=${cfg.toolJudge ? "open" : "sealed"}, judgeConfigured=${judgeConfigured({
			jevKey: cfg.jevKey,
			layaKey: cfg.layaKey
		})})`);
	}
	bridge.onChange(() => tiers.reapply());
	const triggerCdpRefresh = (() => {
		let inFlight = false;
		let pending = false;
		/** Last ws handed to the worker; a differ means the browser was relaunched. */
		let lastAttachWs = null;
		/** Last channel owner (id|reason); a differ is logged so takeovers are visible. */
		let lastOwnerKey = null;
		/** True when this pass actually moved the resolved endpoint. */
		let changed = false;
		const run = async () => {
			if (inFlight) {
				pending = true;
				return changed;
			}
			inFlight = true;
			changed = false;
			try {
				const resolved = resolveConfig(bridge.source());
				const owner = resolveEffectiveLink(resolved.links, resolved.activeTargetId);
				const ownerKey = owner ? `${owner.link.id}|${owner.reason}` : "none";
				if (ownerKey !== lastOwnerKey) {
					lastOwnerKey = ownerKey;
					ctx.logger?.info?.(owner ? `dsh-browser-cdp: channel owner: ${owner.link.label} [${owner.link.id}] (${owner.reason}${owner.demotedId ? `, over ${owner.demotedId}` : ""})` : "dsh-browser-cdp: channel owner: none (no enabled link owns routing)");
				}
				const attach = await refreshAttach({
					targets: resolved.links,
					activeTargetId: resolved.activeTargetId,
					mode: resolved.cdpMode,
					timeoutMs: resolved.cdpProbeTimeoutMs,
					cache: defaultAttachCache,
					fallback: {
						enabled: resolved.allowLocalFallback === true,
						chromePath: resolved.chromePath,
						chromeArgs: resolved.chromeArgs,
						localHeadless: resolved.localHeadless,
						userDataDir: resolved.localUserDataDir
					},
					remoteEnabled: resolved.remoteEnabled,
					useLauncher: true,
					cliProbeColdStart: resolved.allowProbeColdStart === true,
					lightpandaArgs: resolved.lightpandaArgs,
					cliIo: createSubprocessCliIo(ctx.subprocess),
					sdkPath: fileURLToPath(new URL("../runtime/ego-browser/dist/out/index.js", import.meta.url)),
					bundledCli: VENDORED_EGO_BIN
				});
				const ws = attach.status === "ready" && attach.wsUrl !== "" ? attach.wsUrl : null;
				if (ws !== null && ws !== lastAttachWs) lastAttachWs = ws;
				if (setAttachEndpoint(ws, attach.status === "ready" ? attach.engine ?? "unknown" : null)) {
					changed = true;
					recycleWorker("cdp activation change").catch(() => null);
				}
			} catch {} finally {
				inFlight = false;
				if (pending) {
					pending = false;
					run();
				}
			}
			return changed;
		};
		return () => run();
	})();
	triggerCdpRef = triggerCdpRefresh;
	bridge.onChange(() => void triggerCdpRefresh());
	triggerCdpRefresh();
	ctx.effect?.(() => () => {
		defaultAttachCache.reset();
	});
	initCastWorker(ctx, resolveConfig(bridge.source()), ffmpegManager);
	ctx.inject?.(["webServer"], (wctx) => {
		try {
			initCastServer(wctx, cfg, bridge, ffmpegManager, () => openAgentWindow(ctx, cfg), (opts) => importLoginCookies(opts, { subprocess: ctx.subprocess }));
		} catch (err) {
			ctx.logger?.warn?.(`dsh-browser-cdp: cast server init failed: ${err?.message ?? err}`);
		}
		try {
			registerEgoBrowserGateway(wctx, bridge, ffmpegManager, { resolveDir: (sessionId) => {
				try {
					const registry = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : void 0;
					const workspaces = (registry ? registry.list() : []) ?? [];
					if (workspaces.length === 0) return void 0;
					if (sessionId) {
						const owned = workspaces.find((w) => w.sessionIds.includes(sessionId));
						if (owned) return owned.path + "/picks";
					}
					if (workspaces.length === 1) return workspaces[0].path + "/picks";
					return;
				} catch {
					return;
				}
			} });
		} catch (err) {
			ctx.logger?.warn?.(`dsh-browser-cdp: capability gateway init failed: ${err?.message ?? err}`);
		}
		try {
			registerSettingsBridge(wctx, ctx);
		} catch (err) {
			ctx.logger?.warn?.(`dsh-browser-cdp: settings bridge init failed: ${err?.message ?? err}`);
		}
	});
	ctx.effect?.(() => {
		if (cfg.idleTimeoutMin <= 0) return;
		let reapedFor = 0;
		const timer = setInterval(() => {
			(async () => {
				try {
					const last = getLastEgoActivity();
					if (!shouldReapBrowser(Date.now(), last, cfg.idleTimeoutMin)) return;
					if (last <= reapedFor) return;
					if (effectiveChannel(cfg).effective?.link.kind === EGO_CLI_KIND) {
						reapedFor = last;
						ctx.logger?.info?.("dsh-browser-cdp: idle reaper skipped: ego-cli owns the user's browser (never --stop it)");
						return;
					}
					try {
						const { localBrowserInfo, stopLocalBrowser: stopLocalBrowser$1 } = await import("./launcher-hmPXaWQa.js");
						if (localBrowserInfo()) {
							await stopLocalBrowser$1();
							ctx.logger?.info?.("dsh-browser-cdp: idle reaper stopped the locally launched browser");
						}
					} catch {}
					const e = process.env;
					const isWin = process.platform === "win32";
					const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
					const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
					const { readFile: readFile$1 } = await import("node:fs/promises");
					try {
						await readFile$1(`${stateDir}/browser.json`, "utf8");
					} catch {
						return;
					}
					reapedFor = last;
					ctx.logger?.info?.(`dsh-browser-cdp: idle reaper stopping the backing browser after ${cfg.idleTimeoutMin}min without bcdp_* activity`);
					ctx.subprocess.spawn({
						argv: [
							process.execPath,
							cfg.egoBin,
							"--stop"
						],
						cwd: process.cwd(),
						env: resolveEgoEnv(cfg),
						stdio: {
							stdin: { data: "" },
							stdout: { maxBytes: 1024 },
							stderr: { maxBytes: 1024 }
						},
						graceMs: 8e3
					}).done.catch(() => null);
					sealAfterReap();
				} catch {}
			})();
		}, 6e4);
		return () => clearInterval(timer);
	}, "dsh-browser-cdp: idle reaper");
	ctx.effect?.(() => {
		try {
			if (effectiveChannel(cfg).effective?.link.kind === EGO_CLI_KIND) {
				ctx.logger?.info?.("dsh-browser-cdp: teardown skipped --stop: ego-cli owns the user's browser");
				return;
			}
			ctx.subprocess.spawn({
				argv: [
					process.execPath,
					cfg.egoBin,
					"--stop"
				],
				cwd: process.cwd(),
				env: resolveEgoEnv(cfg),
				stdio: {
					stdin: { data: "" },
					stdout: { maxBytes: 1024 },
					stderr: { maxBytes: 1024 }
				},
				graceMs: 8e3
			}).done.catch(() => {});
		} catch {}
	});
	ctx.logger?.info?.(`dsh-browser-cdp: mounted (egoBin=${cfg.egoBin}, defaultSpace=${cfg.activeSpace})`);
}
/** `bcdp_status` probes the SAME channel work uses: a `nodejs` heredoc. */
function registerEgoStatus(ctx, cfg, reg, tiers) {
	reg(defineTool({
		name: "bcdp_status",
		description: "Drive the shared CDP browser (ego runtime): probe the CLI, and unlock the rest of the bcdp_* tools — under lazy injection only this tool is resident, so call it first for any browsing task (open a page, fill a form, screenshot, read, or attach your own Chrome/Edge over CDP). A bcdp_* tool missing from your list is sealed by tiering, not broken.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					available: {
						type: "boolean",
						required: true
					},
					path: { type: "string" },
					exitCode: { type: "integer" },
					facades: {
						type: "object",
						additionalProperties: false,
						properties: {
							taskSpaces: { type: "string" },
							browser: { type: "string" },
							page: { type: "string" }
						}
					}
				}
			},
			render: renderText
		},
		timeoutMs: 15e3,
		execute: async (_args, exec) => {
			tiers.pulse(callingSessionId(exec));
			return withEgoLock(async () => {
				try {
					const { attach } = effectiveChannel(cfg);
					const handle = ctx.subprocess.spawn({
						argv: buildEgoToolArgv(cfg.egoArgvPrefix, attach, cfg.runtimeArgs ?? ""),
						cwd: process.cwd(),
						env: resolveEgoEnv(cfg),
						stdio: {
							stdin: { data: STATUS_FACADE_SCRIPT },
							stdout: { maxBytes: 4096 },
							stderr: { maxBytes: 4096 }
						},
						graceMs: 15e3
					});
					const outcome = await handle.done;
					const facades = parseStatusFacades(mergeCliOutput({
						stdout: readAll(handle.collected.stdout),
						stderr: readAll(handle.collected.stderr)
					}));
					return {
						ok: true,
						available: outcome.exitCode === 0 && facades?.taskSpaces === "object" && facades?.browser === "object",
						path: attach.cliPath ?? cfg.egoBin,
						exitCode: outcome.exitCode,
						...facades ? { facades } : {}
					};
				} catch (err) {
					return {
						ok: true,
						available: false,
						path: "",
						exitCode: null,
						error: describeSpawnFailure(err)
					};
				}
			});
		},
		presentCall: () => ({
			card: "generic",
			title: "bcdp_status",
			kind: "other",
			rawInput: null
		})
	}));
}
/** `bcdp_auth_flush` �?force persistent login cookies down to the disk profile. */
function registerAuthFlush(ctx, cfg, reg) {
	reg(defineTool({
		name: "bcdp_auth_flush",
		description: "Force all persistent login cookies in the agent browser to be written to the on-disk profile. Call this after login (or before ending a browsing task) so the login survives a later DSH/browser restart �?Chrome only flushes cookies to disk on graceful close, this nudges it to persist them now.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					total: { type: "integer" },
					flushed: { type: "integer" },
					degraded: { type: "boolean" },
					error: { type: "string" }
				}
			},
			render: renderText
		},
		timeoutMs: 1e4,
		execute: async () => withEgoLock(async () => {
			try {
				const { readFile: readFile$1 } = await import("node:fs/promises");
				const e = process.env;
				const isWin = process.platform === "win32";
				const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
				const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
				let port = null;
				try {
					const state = JSON.parse(await readFile$1(`${stateDir}/dsh-browser-cdp.cast.json`, "utf8"));
					port = typeof state.port === "number" ? state.port : null;
				} catch {
					port = null;
				}
				if (port === null) return {
					ok: false,
					error: "no live ego-cast worker (browser not running)"
				};
				const jbody = await (await fetch(`http://127.0.0.1:${port}/api/flush`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
					signal: AbortSignal.timeout(8e3)
				})).json();
				const degraded = defaultAttachCache.get().engine === "lightpanda";
				return {
					ok: !!jbody.ok && !degraded,
					total: jbody.total ?? 0,
					flushed: jbody.flushed ?? 0,
					...degraded ? {
						degraded: true,
						error: "engine-unsupported: Lightpanda has no Storage.flushCookies �?cookies persist only while the engine process is alive"
					} : {},
					...!degraded && jbody.error !== void 0 ? { error: jbody.error } : {}
				};
			} catch (err) {
				return {
					ok: false,
					error: String(err?.message || err)
				};
			}
		}),
		presentCall: () => ({
			card: "generic",
			title: "bcdp_auth_flush",
			kind: "other",
			rawInput: null
		})
	}));
}
/** `bcdp_login_import` �?copy login cookies from the system browser (issue #46). */
function registerLoginImport(ctx, cfg, reg) {
	reg(defineTool({
		name: "bcdp_login_import",
		description: "Import login cookies from the system browser (Chrome/Edge/Brave) into the agent browser via CDP passthrough, so sites open logged in. Run dryRun first, then import explicit domains; logins persist in the profile. Cookie values are never shown.",
		parameters: {
			source: {
				type: "string",
				description: "chrome | edge | brave | auto (default auto)."
			},
			domains: {
				type: "json",
				description: "Domains to import, e.g. [\"bilibili.com\"] (subdomains included). Omit = all cookies; prefer an explicit list."
			},
			profile: {
				type: "string",
				description: "Source profile dir, e.g. \"Default\" (default: first profile)."
			},
			closeSource: {
				type: "boolean",
				description: "true = gracefully close a running source browser first (tabs restore); false = return an actionable error (default)."
			},
			dryRun: {
				type: "boolean",
				description: "true = report what would be imported; write nothing."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					source: { type: "string" },
					profile: { type: "string" },
					dryRun: { type: "boolean" },
					totalRead: { type: "integer" },
					matched: { type: "integer" },
					written: { type: "integer" },
					domains: { type: "json" },
					closedSource: { type: "boolean" },
					restoredFromBackup: { type: "boolean" },
					error: { type: "string" }
				}
			},
			render: renderText
		},
		timeoutMs: 6e4,
		execute: async (args) => withEgoLock(async () => {
			try {
				const domains = Array.isArray(args.domains) ? args.domains.map(String) : void 0;
				const source = typeof args.source === "string" && args.source !== "" ? args.source : "auto";
				if (![
					"chrome",
					"edge",
					"brave",
					"auto"
				].includes(source)) return {
					ok: false,
					error: `invalid source "${source}" �?expected chrome|edge|brave|auto`
				};
				return await importLoginCookies({
					source,
					domains,
					profile: typeof args.profile === "string" && args.profile !== "" ? args.profile : void 0,
					closeSource: args.closeSource === true,
					dryRun: args.dryRun === true
				}, { subprocess: ctx.subprocess });
			} catch (err) {
				return {
					ok: false,
					error: String(err?.message || err)
				};
			}
		}),
		presentCall: () => ({
			card: "generic",
			title: "bcdp_login_import",
			kind: "other",
			rawInput: null
		})
	}));
}
function registerDiagnosticsTool(ctx, cfg, reg) {
	reg(defineTool({
		name: "bcdp_diagnostics",
		description: "Read recent network requests or console/page errors from the current CDP browser, or render the current page to PDF. This is an optional diagnostic tool (toolExtended): use kind=network|console before guessing why a page failed; use kind=pdf to save a PDF and return its local path.",
		parameters: {
			kind: {
				type: "string",
				required: true,
				description: "network | console | pdf"
			},
			limit: {
				type: "number",
				description: "For network/console: newest entries to return (1-300, default 50)."
			},
			targetId: {
				type: "string",
				description: "Optional CDP target id; defaults to the worker active target."
			},
			path: {
				type: "string",
				description: "For pdf: output path. Defaults to ~/.dsh/browser-cdp-pdfs/page-<timestamp>.pdf."
			},
			printBackground: {
				type: "boolean",
				description: "For pdf: print CSS backgrounds (default true)."
			},
			scale: {
				type: "number",
				description: "For pdf: scale 0.1-2 (default browser value)."
			},
			landscape: {
				type: "boolean",
				description: "For pdf: landscape orientation."
			}
		},
		output: {
			schema: commonOutputSchema,
			render: renderText
		},
		timeoutMs: 6e4,
		execute: async (args, exec) => withEgoLock(async () => {
			cfg.spaceTracker.setCurrentSession(callingSessionId(exec));
			markEgoToolCall(callingSessionId(exec));
			const kind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : "";
			const targetId = typeof args.targetId === "string" && args.targetId.trim() !== "" ? args.targetId.trim() : void 0;
			if (kind === "network" || kind === "console") {
				const rawLimit = Number(args.limit);
				const result = await readWorkerDiagnostics(kind, Number.isFinite(rawLimit) ? Math.min(300, Math.max(1, Math.floor(rawLimit))) : 50, targetId);
				if (result === null) return {
					ok: false,
					kind,
					error: "browser worker is not running — call bcdp_status or a browser tool first"
				};
				return result;
			}
			if (kind === "pdf") {
				const result = await printWorkerPdf({
					...targetId ? { targetId } : {},
					printBackground: args.printBackground !== false,
					...typeof args.scale === "number" ? { scale: args.scale } : {},
					...typeof args.landscape === "boolean" ? { landscape: args.landscape } : {}
				});
				if (result === null) return {
					ok: false,
					kind,
					error: "browser worker is not running — call bcdp_status or a browser tool first"
				};
				const body = result.body;
				if (result.status !== 200 || body.ok !== true || typeof body.data !== "string") return {
					ok: false,
					kind,
					error: typeof body.error === "string" ? body.error : `PDF worker returned ${result.status}`
				};
				const out = typeof args.path === "string" && args.path.trim() !== "" ? resolve(args.path.trim()) : join(homedir(), ".dsh", "browser-cdp-pdfs", `page-${Date.now()}.pdf`);
				const bytes = Buffer.from(body.data, "base64");
				await mkdir(dirname(out), { recursive: true });
				await writeFile(out, bytes);
				return {
					ok: true,
					kind,
					path: out,
					bytes: bytes.length,
					...typeof body.targetId === "string" ? { targetId: body.targetId } : targetId ? { targetId } : {}
				};
			}
			return {
				ok: false,
				error: "kind must be network, console, or pdf"
			};
		}),
		presentCall: () => ({
			card: "generic",
			title: "bcdp_diagnostics",
			kind: "other",
			rawInput: null
		})
	}));
}
/** The structured action tools that drive `ego-browser nodejs`. */
function registerActionTools(ctx, cfg, reg) {
	reg(defineTool({
		name: "bcdp_watch",
		description: "Open the live CDP watch tab in the sidebar on demand. Ordinary bcdp_* calls keep it collapsed; use this when the user should watch the page in real time.",
		parameters: {},
		output: {
			schema: commonOutputSchema,
			render: renderText
		},
		timeoutMs: 15e3,
		execute: async (_args, exec) => {
			const sessionId = callingSessionId(exec);
			markEgoToolCall(sessionId);
			requestWatchOpen(sessionId);
			await ensureCastWorker();
			return {
				ok: true,
				opened: true
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "bcdp_watch",
			kind: "other",
			rawInput: null
		})
	}));
	registerDiagnosticsTool(ctx, cfg, reg);
	const t = (opts) => defineEgoTool(ctx, cfg, {
		...opts,
		afterExecute: (args, result) => {
			if (!result || result.ok === false) return;
			const a = args;
			const op = typeof a?.op === "string" ? a.op.trim() : "";
			if (opts.name === "bcdp_space" && op === "open") cfg.spaceTracker.opened(args, result);
			else if (opts.name === "bcdp_space" && op === "close") cfg.spaceTracker.closed(a.name, result.done);
			else if (a && a.space !== void 0 && a.space !== "") cfg.spaceTracker.selected(a.space);
			opts.afterExecute?.(args, result);
		}
	});
	const spaceParam = {
		type: "string",
		description: "Task-space name or numeric id; defaults to the most recently opened or explicitly selected space."
	};
	reg(t({
		name: "bcdp_space",
		description: "Task space: op=open (or reuse) | close | list | handoff | takeover. Omitting `space` targets THIS session's own space (dsh-agent-<sessionId8>), so concurrent sessions never share or hijack each other's browsing context — this is the default and needs no setup. To reuse ONE shared slot across sessions, pass `space: 'default'` (or op=open with name='default') deliberately; do NOT create numbered spaces like #4/#5. The browser profile (logins) persists on disk across restarts unless isolateSpaces is on; if a page needs login, prompt the user to log in manually. handoff yields control to the human (stop driving until they hand back); takeover resumes agent control.",
		parameters: {
			op: {
				type: "string",
				required: true,
				description: "\"open\" | \"close\" | \"list\" | \"handoff\" | \"takeover\"."
			},
			name: {
				type: "string",
				description: "op=open/close: task-space name. Omit to use this session's own space (dsh-agent-<sessionId8>); pass 'default' only when you deliberately want the ONE shared slot. op=handoff/takeover: default = this session's space."
			},
			keep: {
				type: "boolean",
				description: "op=close: keep the live page open (default false: close it)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const send = (expr) => `console.log('${SENTINEL}' + JSON.stringify(${expr}))\n`;
			const op = str(args.op, "").trim();
			const name$1 = str(args.name, str(args.space, cfg.activeSpace));
			if (op === "open") return `${useSpace(str(args.name, cfg.activeSpace))}` + send(`{ ok: true, op: 'open', id: task.id ?? null, name: task.name ?? ${j(str(args.name, cfg.activeSpace))} }`);
			if (op === "close") return `const res = await taskSpaces.complete(${j(name$1)}, { keep: ${bool(args.keep, false)} })\n` + send(`{ ok: true, op: 'close', done: !!res.done, skipped: !!res.skipped, reason: res.skipped ? ${j("target space was not agent-owned")} : null }`);
			if (op === "list") return `const __sp = await taskSpaces.list()\n` + send(`{ ok: true, op: 'list', spaces: __sp.map(s => ({ id: s.id ?? null, name: s.name ?? null, ownership: s.ownership ?? null })) }`);
			if (op === "handoff") return `${useSpace(name$1)}const __h = await taskSpaces.handOff(${j(name$1)})\n` + send(`{ ok: true, op: 'handoff', name: ${j(name$1)}, done: !!__h.done, skipped: __h.skipped ?? null, hint: 'user now has control; ask them to confirm before calling op=takeover' }`);
			if (op === "takeover") return `await taskSpaces.takeOver(${j(name$1)})\nconst __info = await page.info()\n` + send(`{ ok: true, op: 'takeover', name: ${j(name$1)}, page: __info }`);
			return send(`{ ok: false, reason: ${j("bcdp_space: op must be one of open|close|list|handoff|takeover")} }`);
		}
	}));
	reg(t({
		name: "bcdp_snapshot",
		description: "Read the current page as text: the full-page semantic tree annotated with [ref=N, loc=...] selectors that bcdp_click / bcdp_fill can target. To target across calls prefer a `loc=` over `@N`: a loc is stable, a ref is renumbered every snapshot.",
		parameters: {
			space: spaceParam,
			scope: {
				type: "string",
				description: "scope: 'full_page' (default) | 'only_within_viewport'; 'subtree' captures only `root`'s subtree."
			},
			root: {
				type: "string",
				description: "scope='subtree': the node to capture - a `loc=` token (stable across calls) or a ref like '@12' from a fresh snapshot."
			}
		},
		buildScript: (args) => {
			const scope = str(args.scope, "");
			const send = (expr) => `console.log('${SENTINEL}' + JSON.stringify(${expr}))\n`;
			const SNAP_OPTS = "includeStableLocator: true";
			if (scope === "subtree") {
				const rootArg = str(args.root, "").trim();
				if (rootArg === "") return send(`{ ok: false, reason: 'bcdp_snapshot: root (a ref such as @N, or a loc=css:�? is required for scope=subtree' }`);
				const resolver = `((raw, refs) => {
  const want = raw.replace(/^loc=/, '').trim()
  if (want !== '' && want !== 'unstable') {
    const byLoc = refs.find(r => r.loc != null && String(r.loc).replace(/^loc=/, '') === want)
    if (byLoc && byLoc.backendNodeId != null) return byLoc.backendNodeId
  }
  const id = raw.replace(/^@/, '').trim()
  const byRef = refs.find(r => String(r.refId) === id)
  return byRef ? byRef.backendNodeId ?? null : null
})(${j(rootArg)}, s.refs ?? [])`;
				return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}let s = await page.snapshotRaw({ ${SNAP_OPTS} })\nlet tries = 0\nwhile (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = await page.snapshotRaw({ ${SNAP_OPTS} }); tries++ }\nconst __bn = ${resolver}\nif (__bn === null) { ${send(`{ ok: false, root: ${j(rootArg)}, reason: 'subtree root not present in the current snapshot; take a fresh full snapshot and use a loc= (survives across calls) or a ref @N from it' }`)} }\nelse { const sub = await page.snapshotRaw({ scope: 'subtree', root: __bn, ${SNAP_OPTS} }); const stext = sub.content ?? '';\nconsole.log('${SENTINEL}' + JSON.stringify(stext === ''\n  ? { ok: false, root: ${j(rootArg)}, backendNodeId: __bn, text: stext, reason: 'subtree capture came back empty' }\n  : { ok: true, root: ${j(rootArg)}, backendNodeId: __bn, text: stext, tries })) }\n`;
			}
			const call = scope === "" ? `await page.snapshotRaw({ ${SNAP_OPTS} })` : `await page.snapshotRaw({ scope: ${j(scope)}, ${SNAP_OPTS} })`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}let s = ${call}\nlet tries = 0\nwhile (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = ${call}; tries++ }\nconst text = s.content ?? ''\nconsole.log('${SENTINEL}' + JSON.stringify(text === ''\n  ? { ok: false, text, tries, reason: 'snapshot returned no content after retries (page may be blank, still loading, or the browser dropped)' }\n  : { ok: true, text, tries }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_navigate",
		description: "Open a URL in the task space, or switch to the existing tab for it (prefer reuse over duplicates). Waits for document load, returns page info.",
		tabRevive: true,
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to open (omit if reload)."
			},
			reload: {
				type: "boolean",
				description: "Reload the current tab (no url needed)."
			},
			ignoreCache: {
				type: "boolean",
				description: "With reload: bypass cache."
			},
			wait: {
				type: "boolean",
				description: "Wait for document load (default true)."
			},
			timeout: {
				type: "number",
				description: "Load wait timeout in ms (default 20000)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const u = str(args.url, "");
			if (bool(args.reload, false)) return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}const __ok = await page.reload({ ignoreCache: ${bool(args.ignoreCache, false)}, waitUntil: ${j(bool(args.wait, true) ? "load" : "commit")}, timeout: ${num(args.timeout, 2e4)} })\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, reloaded: true, loaded: __ok !== false, page: pginfo }))\n`;
			if (u === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reused: false, page: null, reason: 'bcdp_navigate: url is required' }))\n`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}const __existing = __tabs.find(t => t.url.split('#')[0] === ${j(u.split("#")[0])})\nconst tab = __existing ? await browser.switchTab(__existing.targetId) : await page.goto(${j(u)}, { wait: ${bool(args.wait, true)}, timeout: ${num(args.timeout, 2e4)} })\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, reused: !!__existing, page: pginfo }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_click",
		description: "Click an element: CSS/xpath/loc/ref selector, or viewport x+y coordinates.",
		parameters: {
			selector: {
				type: "string",
				description: "CSS/xpath/loc/ref=N from bcdp_snapshot; required unless x,y."
			},
			x: {
				type: "number",
				description: "Viewport x for a coordinate click."
			},
			y: {
				type: "number",
				description: "Viewport y for a coordinate click."
			},
			label: {
				type: "string",
				description: "Short action label, e.g. \"click submit\"."
			},
			double: {
				type: "boolean",
				description: "Double-click instead of single."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "");
			const x = args.x;
			const y = args.y;
			if (sel === "" && !(typeof x === "number" && typeof y === "number")) throw new Error("bcdp_click: provide either `selector` (CSS/xpath/loc/ref from bcdp_snapshot) or both `x` and `y` viewport coordinates");
			const dbl = bool(args.double, false);
			let action;
			if (sel !== "") {
				const labelOpt = str(args.label, "") !== "" ? `{ label: ${j(str(args.label, ""))} }` : "";
				action = dbl ? `await page.locator(${j(sel)}).dblclick(${labelOpt})` : `await page.locator(${j(sel)}).click(${labelOpt})`;
			} else action = dbl ? `await page.mouse.dblclick(${x}, ${y})` : `await page.mouse.click(${x}, ${y})`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}${action}\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, double: ${dbl}, page: pginfo }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_fill",
		description: "Type text into an input field. Target with a CSS selector, xpath=..., loc=..., or ref=N from bcdp_snapshot.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector, xpath=..., loc=..., or ref=N for the input."
			},
			text: {
				type: "string",
				required: true,
				description: "Text to type into the field."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).fill(${j(str(args.text, ""))})\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`
	}));
	reg(t({
		name: "bcdp_js",
		description: "Evaluate a JavaScript expression in the current page and return its JSON-serializable value (e.g. \"document.title\", \"document.querySelectorAll('a').length\"). One expression only; multi-step: use bcdp_script; raw protocol: use bcdp_cdp.",
		parameters: {
			expression: {
				type: "string",
				required: true,
				description: "JavaScript expression string to evaluate in the page."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}${SAFE_FN}const result = await page.evaluate(${j(safeEvalWrap(str(args.expression, "")))})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`
	}));
	reg(t({
		name: "bcdp_cdp",
		description: "Issue a raw CDP command on the page target, e.g. cdp(\"Page.handleJavaScriptDialog\", { accept: true }). Prefer a structured tool when one exists; page JS belongs to bcdp_js.",
		parameters: {
			method: {
				type: "string",
				required: true,
				description: "CDP method name, e.g. Page.handleJavaScriptDialog."
			},
			params: {
				type: "object",
				additionalProperties: true,
				description: "CDP method parameters object."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const params = args.params;
			const call = params !== void 0 && params !== null ? `await cdp(${j(str(args.method, ""))}, ${j(params)})` : `await cdp(${j(str(args.method, ""))})`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}${SAFE_FN}const result = ${call}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_screenshot",
		description: "Capture a screenshot of the current page (or of a single element if selector is given). Returns the file path of the saved PNG, which you can then read with a vision/image tool.",
		parameters: {
			selector: {
				type: "string",
				description: "Optional CSS selector of an element to screenshot instead of the whole page."
			},
			path: {
				type: "string",
				description: "Optional absolute output path for the PNG."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "");
			const pth = str(args.path, "");
			const shot = sel !== "" ? `await page.locator(${j(sel)}).screenshot(${pth ? `{ path: ${j(pth)} }` : ""})` : `await page.screenshot(${pth ? `{ path: ${j(pth)} }` : ""})`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}const path = ${shot}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, path }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_page_info",
		description: "Return the current page info: url, title, viewport size (w, h), scroll offsets (sx, sy), device metrics (pw, ph), and whether a native dialog is open. Also reports `humanCheck` �?whether a CAPTCHA / human-verification challenge is detected on the page (so the agent can alert the user to complete it).",
		parameters: { space: spaceParam },
		buildScript: (args) => `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}const pginfo = await page.info()\nlet __hc = null\ntry { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}).catch(() => null); } catch { __hc = null }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo, humanCheck: __hc }))\n`
	}));
	reg(t({
		name: "bcdp_tab",
		description: "Manage tabs: op=list|current|new|switch|close. new opens/reuses a tab at url; switch/close take a `target` (targetId or URL substring). Will not close the last tab.",
		parameters: {
			op: {
				type: "string",
				required: true,
				description: "\"list\" | \"current\" | \"new\" | \"switch\" | \"close\"."
			},
			url: {
				type: "string",
				description: "Absolute URL for op=new (reuses a matching tab)."
			},
			target: {
				type: "string",
				description: "targetId or URL substring for switch / close."
			},
			wait: {
				type: "boolean",
				description: "op=new: wait for load (default true)."
			},
			timeout: {
				type: "number",
				description: "op=new: load timeout ms (default 20000)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const send = (expr) => `console.log('${SENTINEL}' + JSON.stringify(${expr}))\n`;
			const op = str(args.op, "").trim();
			const head = useSpace(str(args.space, cfg.activeSpace));
			if (op === "list") return head + `const __tabs = await browser.listTabs()\n` + send(`{ ok: true, tabs: __tabs.map(t => ({ targetId: t.targetId, title: t.title, url: t.url, active: !!t.active, index: t.index })) }`);
			if (op === "current") return head + `const __cur = await browser.currentTab()\n` + send(`{ ok: true, tab: __cur }`);
			if (op === "new") {
				const u = str(args.url, "");
				if (u === "") return send(`{ ok: false, reason: 'bcdp_tab: url is required for op=new' }`);
				return head + `const __t = await browser.openOrReuseTab(${j(u)}, { wait: ${bool(args.wait, true)}, timeout: ${num(args.timeout, 2e4)} })\n` + send(`{ ok: true, tab: __t }`);
			}
			if (op === "switch" || op === "close") {
				const t$1 = str(args.target, "");
				if (t$1 === "") return send(`{ ok: false, reason: ${j("bcdp_tab: target (targetId or URL substring) is required for op=" + op)} }`);
				const find = `const __tabs = await browser.listTabs()\nconst __t = __tabs.find(x => x.targetId === ${j(t$1)}) ?? __tabs.find(x => (x.url || '').includes(${j(t$1)}))\n`;
				if (op === "switch") return head + find + `if (!__t) { ${send(`{ ok: false, reason: 'bcdp_tab: no tab matches switch target ' + ${j(t$1)} }`)} }\nelse { await browser.switchTab(__t.targetId); const pginfo = await page.info(); ${send(`{ ok: true, tab: { ...__t, active: true }, page: pginfo }`)} }\n`;
				return head + find + `if (!__t) { ${send(`{ ok: false, reason: 'bcdp_tab: no tab matches close target ' + ${j(t$1)} }`)} }\nelse if (__tabs.length <= 1) { ${send(`{ ok: false, reason: 'refusing to close the last tab: open another tab first' }`)} }\nelse { const __closed = await browser.closeTab(__t.targetId); const __after = await browser.listTabs(); ${send(`{ ok: true, closed: __closed, count: __after.length, tabs: __after.map(t => ({ targetId: t.targetId, url: t.url, active: !!t.active })) }`)} }\n`;
			}
			return send(`{ ok: false, reason: ${j("bcdp_tab: op must be one of list|current|new|switch|close")} }`);
		}
	}));
	reg(t({
		name: "bcdp_wait",
		description: "Wait. op=duration (fixed ms) | selector (element appears/disappears) | url (navigation) | response (network reply) | load (page load state) | function (in-page expression becomes truthy) | request (network request) | event (a download). selector takes `selector` + optional `state` (visible|attached|hidden|detached); url takes `pattern`; response takes `url` + optional `body` (none|text|json); load takes `state` (load|domcontentloaded|networkidle); function takes `expression`; request takes `url`. `timeout` in ms (default 10000; page-level ops load/function/request/event default 30000). Every op except duration accepts `space`.",
		parameters: {
			op: {
				type: "string",
				required: true,
				description: "\"duration\" | \"selector\" | \"url\" | \"response\" | \"load\" | \"function\" | \"request\" | \"event\"."
			},
			ms: {
				type: "number",
				description: "op=duration: milliseconds to wait (default 1000)."
			},
			selector: {
				type: "string",
				description: "op=selector: CSS selector to wait for, e.g. '.results' or '[data-id=done]'."
			},
			state: {
				type: "string",
				description: "op=selector: \"visible\" (default) | \"attached\" | \"hidden\" | \"detached\". op=load: \"load\" (default) | \"domcontentloaded\" | \"networkidle\"."
			},
			pattern: {
				type: "string",
				description: "op=url: URL/glob to match (e.g. '/login?done', 'https://*/post/*', or a /regex/)."
			},
			url: {
				type: "string",
				description: "op=response: URL/glob/regex, e.g. '/api/search'. op=request: URL substring / glob / regex."
			},
			body: {
				type: "string",
				description: "op=response: 'none' (default) | 'text' | 'json'."
			},
			expression: {
				type: "string",
				description: "op=function: in-page JS expression evaluated until truthy."
			},
			timeout: {
				type: "number",
				description: "Wait in ms (default 10000; page-level ops default 30000)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const send = (expr) => `console.log('${SENTINEL}' + JSON.stringify(${expr}))\n`;
			const op = str(args.op, "").trim();
			const asked = num(args.timeout, 0);
			const to = asked > 0 ? asked : 1e4;
			const pageTo = asked > 0 ? asked : 3e4;
			const head = `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}`;
			if (op === "duration") {
				const ms = Math.max(0, num(args.ms, 1e3));
				return `await page.waitForTimeout(${ms})\n` + send(`{ ok: true, op: 'duration', waitedMs: ${ms} }`);
			}
			if (op === "selector") {
				const sel = str(args.selector, "").trim();
				if (sel === "") return send(`{ ok: false, op: 'selector', waited: false, reason: 'bcdp_wait: selector is required for op=selector' }`);
				return head + `await page.waitForSelector(${j(sel)}, { state: ${j(str(args.state, "visible"))}, timeout: ${to} })\n` + send(`{ ok: true, op: 'selector', waited: true, selector: ${j(sel)}, state: ${j(str(args.state, "visible"))} }`);
			}
			if (op === "url") {
				const p = str(args.pattern, "").trim();
				if (p === "") return send(`{ ok: false, op: 'url', reached: false, reason: 'bcdp_wait: pattern is required for op=url' }`);
				return head + `const __ok = await page.waitForURL(${j(p)}, { timeout: ${to} }).catch(() => false)\nconst __u = await page.url()\n` + send(`{ ok: !!__ok, op: 'url', reached: !!__ok, url: __u }`);
			}
			if (op === "response") {
				const u = str(args.url, "").trim();
				if (u === "") return send(`{ ok: false, op: 'response', reason: 'bcdp_wait: url is required for op=response' }`);
				const mode = str(args.body, "none");
				const wantBody = mode === "text" || mode === "json";
				return head + `const __res = await page.waitForResponse(${j(u)}, { timeout: ${to} })\n${wantBody ? `const __body = ${mode === "json" ? "await __res.json().catch(()=>null)" : "await __res.text().catch(()=>null)"}\n` : ""}` + send(`{ ok: true, op: 'response', url: __res.url(), status: __res.status()${wantBody ? ", body: __body" : ""} }`);
			}
			if (op === "load") return head + `const __ok = await page.waitForLoadState(${j(str(args.state, "load"))}, { timeout: ${pageTo} })\n` + send(`{ ok: !!__ok, op: 'load', state: ${j(str(args.state, "load"))}, reason: __ok ? null : 'timed out: load state not reached within ${pageTo}ms' }`);
			if (op === "function") {
				const expr = str(args.expression, "").trim();
				if (expr === "") return send(`{ ok: false, op: 'function', reason: 'bcdp_wait: expression is required for op=function' }`);
				return head + `const __v = await page.waitForFunction(${j(safeEvalWrap(expr, true))}, undefined, { timeout: ${pageTo} })\n` + send(`{ ok: !!__v, op: 'function', value: __v === false ? null : __v, reason: __v === false ? 'timed out: expression never became truthy within ${pageTo}ms' : null }`);
			}
			if (op === "request") {
				const u = str(args.url, "").trim();
				if (u === "") return send(`{ ok: false, op: 'request', reason: 'bcdp_wait: url is required for op=request' }`);
				return head + `try { const __req = await page.waitForRequest(${j(u)}, { timeout: ${pageTo} })\n` + send(`{ ok: true, op: 'request', url: __req.url(), method: __req.method() }`) + `} catch (e) { ${send(`{ ok: false, op: 'request', reason: String(e && e.message || e) }`)} }\n`;
			}
			if (op === "event") return head + `try { const __ev = await page.waitForEvent('download', { timeout: ${pageTo} })\nconst __p = await __ev.path().catch(() => null)\n` + send(`{ ok: true, op: 'event', event: 'download', suggestedFilename: __ev.suggestedFilename(), url: __ev.url(), path: __p }`) + `} catch (e) { ${send(`{ ok: false, op: 'event', reason: String(e && e.message || e) }`)} }\n`;
			return send(`{ ok: false, reason: ${j("bcdp_wait: op must be one of duration|selector|url|response|load|function|request|event")} }`);
		}
	}));
	reg(t({
		name: "bcdp_key",
		description: "Press a key/combo ('Enter', 'Tab', 'Control+a', 'Escape') or type text character-by-character.",
		parameters: {
			key: {
				type: "string",
				description: "Key/combo: 'Enter', 'Control+c', 'ArrowDown', 'F5' (ignored when text is given)."
			},
			text: {
				type: "string",
				description: "Type this text instead (keyboard.type)."
			},
			via: {
				type: "string",
				description: "text mode: 'type' (default, per-character) | 'insert' (keyboard.insertText, faster for long strings)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const txt = str(args.text, "");
			const k = str(args.key, "").trim();
			if (txt !== "") {
				const method = str(args.via, "type") === "insert" ? "insertText" : "type";
				return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}await page.keyboard.${method}(${j(txt)})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, typed: ${j(txt)} }))\n`;
			}
			if (k === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_key: provide key or text to type' }))\n`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}await page.keyboard.press(${j(k)})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, key: ${j(k)} }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_hover",
		description: "Move the pointer over an element (CSS selector / ref) or to viewport coordinates. Triggers CSS :hover, dropdowns and mouseenter handlers.",
		parameters: {
			selector: {
				type: "string",
				description: "CSS selector, xpath=..., loc=..., or ref=N for the element."
			},
			x: {
				type: "number",
				description: "Viewport x (only with y)."
			},
			y: {
				type: "number",
				description: "Viewport y (only with x)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "");
			const hasXY = typeof args.x === "number" && typeof args.y === "number";
			if (sel === "" && !hasXY) return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_hover: provide selector or both x and y' }))\n`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` + (sel !== "" ? `await page.locator(${j(sel)}).hover()\n` : `await page.mouse.move(${args.x}, ${args.y})\n`) + `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_read_element",
		description: "Read one element: text, HTML, value, an attribute, or visible/enabled/count.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the target."
			},
			what: {
				type: "string",
				description: "'text' (default) | 'html' | 'value' | 'attribute' | 'visible' | 'enabled' | 'count'."
			},
			attribute: {
				type: "string",
				description: "Attribute name when what=attribute."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "").trim();
			const what = str(args.what, "text");
			if (sel === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_read_element: selector is required' }))\n`;
			const selExpr = `page.locator(${j(sel)})`;
			let expr;
			switch (what) {
				case "html":
					expr = `await ${selExpr}.innerHTML()`;
					break;
				case "value":
					expr = `await ${selExpr}.inputValue()`;
					break;
				case "attribute":
					expr = `await ${selExpr}.getAttribute(${j(str(args.attribute, ""))})`;
					break;
				case "visible":
					expr = `await ${selExpr}.isVisible()`;
					break;
				case "enabled":
					expr = `await ${selExpr}.isEnabled()`;
					break;
				case "count":
					expr = `await ${selExpr}.count()`;
					break;
				default: expr = `await ${selExpr}.textContent()`;
			}
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}${SAFE_FN}const __v = ${expr}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, what: ${j(what)}, selector: ${j(sel)}, value: safe(__v) }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_select",
		description: "Choose an option in a <select> dropdown by value, label, or index (a single value or an array for multi-select).",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the <select> element."
			},
			value: {
				type: "json",
				description: "The option: a string value/label, or {value:'..'}, {label:'..'}, {index:n}, or an array of these for multi-select."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).selectOption(${j(args.value ?? "")})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, select: ${j(str(args.selector, ""))} }))\n`
	}));
	reg(t({
		name: "bcdp_drag",
		description: "Drag an element to a target (Playwright dragTo) or drag the pointer through coordinates. Use for sliders, sortable rows, and drag-drop zones.",
		parameters: {
			from: {
				type: "string",
				description: "CSS selector of the element to drag from."
			},
			to: {
				type: "string",
				description: "CSS selector of the drop target (used with from)."
			},
			points: {
				type: "array",
				items: { type: "number" },
				description: "Alternative: a flat list of [x1,y1,x2,y2,...] viewport coordinates to drag the mouse through."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const pts = Array.isArray(args.points) ? args.points.map(Number).filter((n) => Number.isFinite(n)) : [];
			const hasEl = str(args.from, "") !== "" && str(args.to, "") !== "";
			if (!hasEl && pts.length < 4) return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_drag: provide from+to selectors, or at least 4 points (x1,y1,x2,y2)' }))\n`;
			const action = hasEl ? `await page.locator(${j(str(args.from, ""))}).dragTo(page.locator(${j(str(args.to, ""))}))\n` : `const __pts = ${j(pts)}\nconst __coords=[];for(let __i=0;__i<__pts.length;__i+=2){__coords.push([__pts[__i],__pts[__i+1]])}\nawait page.mouse.drag(__coords)\n`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` + action + `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_scroll",
		description: "Scroll the page: by pixel deltas (wheel), or bring an element into view (scrollIntoView).",
		parameters: {
			deltaX: {
				type: "number",
				description: "Horizontal scroll delta (wheel) in px."
			},
			deltaY: {
				type: "number",
				description: "Vertical scroll delta (wheel) in px."
			},
			selector: {
				type: "string",
				description: "CSS selector to scroll into view (primary if given)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const hasSelector = str(args.selector, "") !== "";
			const hasDelta = Number.isFinite(args.deltaX) || Number.isFinite(args.deltaY);
			if (!hasSelector && !hasDelta) return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'bcdp_scroll: provide deltaX/deltaY or a selector' }))\n`;
			const action = hasSelector ? `await page.locator(${j(str(args.selector, ""))}).scrollIntoViewIfNeeded()\n` : `await page.mouse.wheel(${num(args.deltaX, 0)}, ${num(args.deltaY, 300)})\n`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}` + action + `const __p = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, scrollX: __p.sx ?? null, scrollY: __p.sy ?? null }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_upload",
		description: "Set files on a file <input> element (path-driven). Use to upload a dataset/attachment from a local path.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the <input type=file> element."
			},
			path: {
				type: "string",
				required: true,
				description: "Absolute path of the file(s) to upload on this machine."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).setInputFiles(${j(str(args.path, ""))})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, upload: ${j(str(args.selector, ""))} }))\n`
	}));
	reg(t({
		name: "bcdp_download",
		description: "Wait for a download triggered by the current action, then return its saved path. Trigger with triggerSelector or triggerScript; optionally copy to savePath.",
		parameters: {
			triggerSelector: {
				type: "string",
				description: "CSS selector of the button/link whose click starts the download."
			},
			triggerScript: {
				type: "string",
				description: "JS snippet that triggers the download (runs before waiting)."
			},
			savePath: {
				type: "string",
				description: "Absolute path to also copy the file to."
			},
			timeout: {
				type: "number",
				description: "Wait timeout in ms (default 30000)."
			},
			space: spaceParam
		},
		gate: () => defaultAttachCache.get().engine === "lightpanda" ? "engine-unsupported: the attached browser is Lightpanda, which has no Page download events �?bcdp_download cannot capture files on this engine. Trigger the download another way (e.g. fetch() the URL in-page and return the bytes)." : null,
		buildScript: (args) => {
			const sel = str(args.triggerSelector, "");
			const script = str(args.triggerScript, "");
			const savePath = str(args.savePath, "");
			const timeout = num(args.timeout, 3e4);
			const trigger = sel !== "" ? `await page.locator(${j(sel)}).click()\n` : script !== "" ? `await page.evaluate(() => { ${script} })\n` : "/* no trigger given �?the download may be started by an earlier navigation */\n";
			const save = savePath !== "" ? `const __final = await __dl.saveAs(${j(savePath)}).catch(()=>null)\n` : `const __final = await __dl.path().catch(()=>null)\n`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}const __dlPromise = page.waitForEvent('download', { timeout: ${timeout} })\n` + trigger + "const __dl = await __dlPromise\nconst __name = typeof __dl.suggestedFilename === 'function' ? __dl.suggestedFilename() : null\nconst __url = typeof __dl.url === 'function' ? __dl.url() : null\n" + save + `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path: __final, suggestedFilename: __name, url: __url }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_check",
		description: "Check (tick) or uncheck a checkbox/radio element. Does nothing if already in the desired state.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the checkbox/radio."
			},
			checked: {
				type: "boolean",
				description: "true=check (default), false=uncheck."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const chk = bool(args.checked, true);
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).${chk ? "check" : "uncheck"}()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, checked: ${chk} }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_dialog",
		description: "Accept or dismiss a native browser dialog (alert/confirm/prompt), optionally supplying text for a prompt. Use right after the action that triggers the dialog.",
		parameters: {
			accept: {
				type: "boolean",
				description: "true=Accept/OK (default), false=Dismiss/Cancel."
			},
			text: {
				type: "string",
				description: "Text to type into a prompt dialog."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const accept = bool(args.accept, true);
			const text = str(args.text, "");
			const params = `{ accept: ${accept}${text !== "" ? `, promptText: ${j(text)}` : ""} }`;
			return `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}const __r = await cdp("Page.handleJavaScriptDialog", ${params}).catch((e) => ({ error: String(e) }))\nconst __ok = !!(__r && !__r.error)\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, handled: __ok, accept: ${accept}, error: __r?.error ?? null }))\n`;
		}
	}));
	reg(t({
		name: "bcdp_http",
		description: "Make an HTTP request and return status + body. Default runs in the page's browser context; mode=server uses Node-side fetch.server (may crash on the vendored ego-linux Windows runtime, so prefer browser mode). To render a page use bcdp_navigate; server mode is not bound by page CORS.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to request."
			},
			method: {
				type: "string",
				description: "HTTP method (default GET)."
			},
			headers: {
				type: "object",
				additionalProperties: true,
				description: "Request headers, e.g. { 'Content-Type': 'application/json' }."
			},
			body: {
				type: "string",
				description: "Request body (POST/PUT)."
			},
			timeout: {
				type: "number",
				description: "Timeout in ms (default 20000)."
			},
			mode: {
				type: "string",
				description: "'browser' (default) or 'server' (Node-side fetch)."
			},
			credentials: {
				type: "string",
				description: "Browser mode: 'include' sends the profile's cookies cross-origin; 'omit'/'same-origin' also accepted. Default: engine default."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const opts = {
				method: str(args.method, "GET"),
				headers: args.headers && typeof args.headers === "object" ? args.headers : {},
				timeout: num(args.timeout, 2e4)
			};
			if (str(args.body, "") !== "") opts.body = str(args.body, "");
			const mode = str(args.mode, "browser");
			const cred = str(args.credentials, "");
			if (mode !== "server" && (cred === "include" || cred === "omit" || cred === "same-origin")) opts.credentials = cred;
			return `${mode === "server" ? "" : `${useSpace(str(args.space, cfg.activeSpace))}${ensureRealTab()}`}${SAFE_FN}const __r = await fetch.${mode === "server" ? "server" : "browser"}(${j(str(args.url, ""))}, ${j(opts)})\nconst __status = typeof __r.status !== "undefined" ? __r.status : 200\nlet __body = null\ntry { __body = typeof __r.text === "function" ? await __r.text() : (typeof __r === "string" ? __r : JSON.stringify(safe(__r))) } catch { __body = null }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, mode: ${j(mode)}, status: __status, body: __body, url: ${j(str(args.url, ""))} }))\n`;
		}
	}));
}
/** Register bcdp_help / bcdp_doctor / bcdp_script. */
function registerHelpAndDoctor(ctx, cfg, reg, tiers) {
	reg(defineTool({
		name: "bcdp_captcha",
		description: "Check the current page for a human-verification (CAPTCHA) challenge �?reCAPTCHA / hCaptcha / Cloudflare / Turnstile �?and return { detected, kind }. If detected=true, ALERT THE USER that they must complete the verification in the 'ego lite - agent' browser window (it is the same live session shown in the watch panel), then continue after they have.",
		parameters: { space: {
			type: "string",
			description: "Task-space name or numeric id; defaults to the configured defaultSpace."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					detected: {
						type: "boolean",
						required: true
					},
					kind: { oneOf: [{ type: "string" }, { type: "null" }] },
					engine: { type: "string" },
					rendering: { type: "string" }
				}
			},
			render: renderText
		},
		timeoutMs: 15e3,
		execute: async (args, exec) => withEgoLock(async () => {
			cfg.spaceTracker.setCurrentSession(callingSessionId(exec));
			markEgoToolCall(callingSessionId(exec));
			const result = await runWithStaleSpaceRetry(ctx, cfg, { signal: exec?.signal }, () => humanCheckScript(str(args.space, cfg.activeSpace)));
			if (!result.ok) return {
				ok: false,
				detected: false,
				kind: null,
				error: result.error
			};
			const hc = (parseSentinel(mergeCliOutput(result)) || {}).humanCheck;
			return {
				ok: true,
				detected: !!hc?.detected,
				kind: hc?.kind ?? null,
				...defaultAttachCache.get().engine === "lightpanda" ? {
					engine: "lightpanda",
					rendering: "text"
				} : {}
			};
		}),
		presentCall: () => ({
			card: "generic",
			title: "bcdp_captcha",
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "bcdp_help",
		description: "Query the built-in ego-browser tool guide. `topic` may be a category (overview/tools/navigate/observe/input/keyboard-mouse/form/wait/network/login/script/doctor) or a specific tool name (e.g. bcdp_click). Returns the matching usage notes. Call this when unsure which eyebrow tool to use. If a bcdp_* tool is missing from your list, ask topic=injection.",
		parameters: { topic: {
			type: "string",
			description: "Category or tool name to look up; omitted/all returns the overview index."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					topic: {
						type: "string",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 1e4,
		execute: async (args, exec) => {
			tiers.pulse(callingSessionId(exec));
			const q = str(args.topic, "").trim().toLowerCase();
			const key = Object.prototype.hasOwnProperty.call(EGO_HELP_INDEX, q) ? q : "";
			const text = key ? EGO_HELP_INDEX[key] : q ? `未找�?topic "${q}"。可�? ` + Object.keys(EGO_HELP_INDEX).filter((k) => k !== "overview").join(", ") + "\n\noverview: " + EGO_HELP_INDEX.overview : EGO_HELP_INDEX.overview;
			return {
				ok: true,
				topic: q || "overview",
				text
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "bcdp_help",
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "bcdp_doctor",
		description: "Preflight the ego-browser environment: vendored runtime present, Chrome/Edge/Brave candidates, state dir, CDP/browser.json, ego-cast worker, task spaces. Run first when the browser fails to start (update, reboot, port conflict) or before a long session.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					report: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 25e3,
		execute: async (_args, exec) => {
			tiers.pulse(callingSessionId(exec));
			const lines = [];
			{
				const s = tiers.surface();
				const key = judgeConfigured({
					jevKey: cfg.jevKey,
					layaKey: cfg.layaKey
				});
				lines.push(`tool injection: mode=${cfg.toolInjection} browse=${cfg.toolBrowse ? "open" : "sealed"} extended=${cfg.toolExtended ? "open" : "sealed"} escape=${cfg.toolEscape ? "open" : "sealed"} judge=${cfg.toolJudge ? "open" : "sealed"} judgeKey=${key ? "set" : "none"} active=${tiers.active() ? "yes" : "no"} �?live ${s.live.length} / sealed ${s.sealed.length}`);
			}
			lines.push(scopeProbeLine());
			lines.push(`egoBin: ${cfg.egoBin}`);
			try {
				lines.push(`egoBin exists: ${existsSync(cfg.egoBin)}`);
			} catch {
				lines.push("egoBin exists: n/a");
			}
			const chrome = findChromeBinary();
			const configured = cfg.chromePath;
			if (configured) lines.push(`browser binary: ${configured} (from settings)`);
			else lines.push(`browser binary: ${chrome || "(none found �?set chromePath in settings, or set EGO_LINUX_CHROME, or install Chrome/Edge/Brave)"}`);
			const cliArgs = filterArgs(cfg.runtimeArgs ?? "", EGO_CLI_BLOCKED);
			const chrArgs = filterArgs(cfg.chromeArgs ?? "", CHROME_BLOCKED);
			lines.push(`runtimeArgs (effective): ${cliArgs.length ? cliArgs.join(" ") : "(none)"}`);
			const attachNow = defaultAttachCache.get();
			const channel = effectiveChannel(cfg);
			lines.push(`channel: ${channel.effective ? `${channel.effective.link.label} [${channel.effective.link.id}] (${channel.effective.reason}${channel.effective.demotedId ? `, over ${channel.effective.demotedId}` : ""})` : "(none — activate a link or enable one)"}`);
			lines.push(`remote CDP: ${cfg.remoteEnabled === false ? "DISABLED by switch (sequence preserved)" : "enabled"}`);
			lines.push(`attach: ${attachNow.status}${attachNow.endpointSource ? ` (source: ${attachNow.endpointSource})` : ""}${attachNow.endpoint ? ` @ ${attachNow.endpoint}` : ""}`);
			if (attachNow.engine !== void 0) lines.push(`engine: ${attachNow.engine}`);
			if (attachNow.engine === "lightpanda") lines.push("degraded on this engine: live view (no screencast) · panel pick (no Overlay/bindingCalled) · bcdp_download (no Page download events) · screenshots are PNG text-renders · auth_flush is a no-op");
			if (attachNow.engine === "lightpanda" || process.platform === "win32") lines.push(process.platform === "win32" ? "lightpanda on win32: no native build �?use WSL2: `wsl --install` (admin), then inside WSL: `curl -fsSL https://pkg.lightpanda.io/install.sh | bash` + `lightpanda serve --host 127.0.0.1 --port 9222`; WSL2 maps the port to Windows localhost, then add http://127.0.0.1:9222 as a CDP endpoint. Docker alternative: `docker run -d -p 127.0.0.1:9222:9222 lightpanda/browser:nightly`." : "lightpanda (linux/macOS): `curl -fsSL https://pkg.lightpanda.io/install.sh | bash` (installs to ~/.local/bin) then `lightpanda serve --host 127.0.0.1 --port 9222`.");
			const kindCount = (kind) => cfg.links.filter((link) => link.kind === kind).length;
			const dropped = cfg.droppedEgoCli;
			lines.push(`links: ${cfg.links.length} (cdp ${kindCount("cdp")}, ego-cli ${kindCount(EGO_CLI_KIND)}, lightpanda ${kindCount(LP_KIND)})${dropped > 0 ? ` �?${dropped} extra ego-cli row(s) dropped (local-only singleton)` : ""}`);
			if (kindCount(LP_KIND) > 0) {
				const lpRow = cfg.links.find((link) => link.kind === LP_KIND);
				lines.push(`lightpanda row: servePath=${lpRow?.servePath === void 0 || lpRow.servePath === "" ? "(auto: PATH �?~/.local/bin; win32 via WSL2)" : lpRow.servePath} �?headless quick-trial engine; headed kinds (CDP / local Chrome / ego CLI) are the manual-fallback backstop`);
			}
			const cliLink = cfg.links.find((link) => link.kind === EGO_CLI_KIND);
			if (cliLink && cliLink.kind === EGO_CLI_KIND) {
				const resolved = resolveCliBinary({
					cliPath: cliLink.cliPath,
					bundled: VENDORED_EGO_BIN
				}, createSubprocessCliIo(ctx.subprocess));
				lines.push(resolved.ok ? `cli: ${resolved.path} (${resolved.origin}${attachNow.cliShape ? `, shape ${attachNow.cliShape}` : ""})` : `cli: (missing) �?${resolved.message}`);
			}
			const toolCount = ((EGO_HELP_INDEX["tools"] ?? "").match(/bcdp_/g) ?? []).length;
			const legacy = cfg.legacyEgoToolNames === true;
			lines.push(`naming: ${toolCount} bcdp_* tools; legacy ego_* aliases ${legacy ? "ON (mutually exclusive with the old dsh-ego-browser plugin)" : "OFF (coexists with the old dsh-ego-browser plugin)"}`);
			const upstream = findUpstreamPluginInstall();
			if (upstream !== "") lines.push(`conflict: old dsh-ego-browser installed at ${upstream} �?only one plugin should drive the local ego browser (they would share its task spaces)`);
			lines.push(`chromeArgs (effective, next cold start): ${chrArgs.length ? chrArgs.join(" ") : "(none)"}`);
			const isWin = process.platform === "win32";
			const e = process.env;
			const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
			const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
			lines.push(`state dir: ${stateDir} (exists: ${existsSync(stateDir)})`);
			const bjson = `${stateDir}/browser.json`;
			let browserReport = "browser.json: (none �?agent browser not running)";
			if (existsSync(bjson)) try {
				const { readFile: readFile$1 } = await import("node:fs/promises");
				const b = JSON.parse(await readFile$1(bjson, "utf8"));
				const alive = b.pid ? await (async () => {
					try {
						process.kill(b.pid, 0);
						return true;
					} catch (x) {
						return x?.code === "EPERM";
					}
				})() : false;
				browserReport = `browser.json: port=${b.port} pid=${b.pid} alive=${alive} headless=${b.headless}`;
			} catch (err) {
				browserReport = `browser.json: unreadable (${err?.message})`;
			}
			lines.push(browserReport);
			const tjson = `${stateDir}/task-spaces.json`;
			if (existsSync(tjson)) try {
				const { readFile: readFile$1 } = await import("node:fs/promises");
				const t = JSON.parse(await readFile$1(tjson, "utf8"));
				lines.push(`task spaces: ${(t.spaces || []).length}`);
			} catch {}
			lines.push("headless override: " + (e.EGO_LINUX_HEADLESS ? "yes (" + e.EGO_LINUX_HEADLESS + ")" : "no"));
			lines.push("npm/node: " + process.version);
			{
				const judge = judgeCfg();
				const runtime = buildJudgeRuntime(judge, { now: () => Date.now() });
				const ready = describeJudge(runtime).filter((line) => line.includes("ready")).length;
				lines.push(`judge: ${runtime.order.join(" -> ")} (${ready} http hop(s) ready)`);
				lines.push(`judge jev: ${judge.jevUrl === "" ? "not configured" : `${judge.jevUrl} key=${judge.jevKey === "" ? "MISSING" : "set"}`}`);
				lines.push(`judge laya: ${judge.layaUrl} key=${judge.layaKey === "" ? "MISSING (hop will be SKIPPED)" : "set"}`);
				lines.push(`judge budgets: chunk=${judge.chunkSize} steps=${judge.stepBudget} wall=${judge.wallMs}ms imageBytes=${judge.maxImageBytes === 0 ? "unbounded" : judge.maxImageBytes}`);
				lines.push(`judge worker: ${existsSync(RENDER_WORKER_BIN) ? RENDER_WORKER_BIN : `MISSING at ${RENDER_WORKER_BIN}`}`);
			}
			return {
				ok: true,
				report: lines.join("\n")
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "bcdp_doctor",
			kind: "other",
			rawInput: null
		})
	}));
	reg((() => {
		return defineTool({
			name: "bcdp_script",
			description: "Run an arbitrary `ego-browser nodejs` heredoc script in ONE invocation (page/…locator/browser/taskSpaces/site/fetch/cdp preloaded), and return structured {ok, stdout, stderr, result, durationMs, timedOut}. Use for a full multi-step browser task as a single script. The task space is selected and a real (non-blank) tab activated for you before your script runs, so page.* works directly. Set verbatim:true to run the body verbatim with no preamble (the retired bcdp_cli behaviour). For a single page expression use bcdp_js. These scripts expose the vendored SDK (`taskSpaces`, `page.locator()`, global `cdp()`, `fetch.browser|server`) �?NOT the official docs' `taskSpace()` / `page.click()`.",
			parameters: {
				script: {
					type: "string",
					required: true,
					description: "Full JS script body. You may end with console.log(JSON.stringify(payload)) �?bare or prefixed with the sentinel �?and it is returned as `result`. Without one, `output` still carries everything the script printed."
				},
				timeoutMs: {
					type: "integer",
					description: "Per-run timeout in ms (default plugin grace)."
				},
				verbatim: {
					type: "boolean",
					description: "Run the body verbatim with NO preamble (no task-space selection, no real-tab activation) — the retired bcdp_cli behaviour. Default false prepends the preamble so page.* works directly. In verbatim mode select the space yourself (`await taskSpaces.useOrCreate(name)`) before touching page.*."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: {
							type: "boolean",
							required: true
						},
						stdout: {
							type: "string",
							required: true
						},
						stderr: { type: "string" },
						output: {
							type: "string",
							description: "Merged stdout+stderr text of the CLI run. The ego CLI writes script output to stderr on Windows, so read this when `stdout` looks empty."
						},
						result: { type: "json" },
						durationMs: { type: "integer" },
						timedOut: { type: "boolean" },
						error: { type: "string" }
					}
				},
				render: renderText
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			execute: async (args, exec) => {
				cfg.spaceTracker.setCurrentSession(callingSessionId(exec));
				markEgoToolCall(callingSessionId(exec));
				const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : void 0;
				const start = Date.now();
				const verbatimMode = bool(args.verbatim, false);
				const preamble = (body) => {
					if (verbatimMode) return body;
					if (/taskSpaces\s*\.\s*useOrCreate\s*\(/.test(body)) return body;
					return `${useSpace(cfg.activeSpace)}${ensureRealTab()}${body}`;
				};
				const result = await runWithStaleSpaceRetry(ctx, cfg, exec, () => preamble(str(args.script, "")), timeoutMs);
				const durationMs = Date.now() - start;
				if (!result.ok) return {
					ok: false,
					stdout: result.stdout,
					stderr: result.stderr,
					output: attachSessionHint(mergeCliOutput(result)),
					durationMs,
					timedOut: false,
					error: attachSessionHint(result.error)
				};
				const parsed = parseSentinel(mergeCliOutput(result));
				return {
					ok: true,
					stdout: result.stdout,
					stderr: result.stderr,
					output: mergeCliOutput(result),
					result: parsed ?? null,
					durationMs,
					timedOut: false
				};
			},
			presentCall: () => ({
				card: "generic",
				title: "bcdp_script",
				kind: "other",
				rawInput: null
			})
		});
	})());
	/**
	* The judge settings, read live off the runtime config.
	*
	* Assembled field-by-field here rather than carried as one object on `cfg`,
	* because `EgoRuntimeConfig` must stay structurally assignable to
	* `ResolvedConfig` (see the interface note) and a nested object would break
	* that. Each field is a live getter, so a settings edit lands on the next call.
	*/
	const judgeCfg = () => ({
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
		wallMs: cfg.jevWallMs
	});
	/** Build the intent from tool args. Hints stay hints �?never selectors. */
	const intentFrom = (args) => {
		const hints = str(args.hints, "");
		const criteria = str(args.successCriteria, "");
		const stops = str(args.stopConditions, "");
		return {
			goal: str(args.goal, ""),
			kind: str(args.kind, "other") || "other",
			targetHints: hints === "" ? [] : hints.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
			successCriteria: criteria === "" ? [] : criteria.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
			stopConditions: stops === "" ? [] : stops.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
			source: "user"
		};
	};
	/** The judge runtime, rebuilt per call so a settings edit takes effect now. */
	const judgeRuntimeOf = () => buildJudgeRuntime(judgeCfg(), { now: () => Date.now() });
	/**
	* The effects, bound to this plugin's worker + the live attach cache.
	*
	* `wsUrl` comes from the attach cache, which is the same source the panel's
	* badge reads. When it is empty there is no live browser and EVERY jev tool
	* must say so rather than failing later with a confusing worker error.
	*/
	const effectsOf = (judge, onFrame) => {
		const { attach } = effectiveChannel(cfg);
		return makeJudgeEffects({
			subprocess: ctx.subprocess,
			workerPath: RENDER_WORKER_BIN,
			wsUrl: attach.wsUrl,
			targetId: attach.targetId,
			...attach.engine === void 0 ? {} : { engine: attach.engine },
			judge,
			maxImageBytes: cfg.jevMaxImageBytes,
			candidateLimit: cfg.jevChunkSize,
			now: () => Date.now(),
			sleep: (ms) => new Promise((resolve$1) => {
				setTimeout(resolve$1, ms);
			}),
			...onFrame === void 0 ? {} : { onFrame }
		});
	};
	/** The browser must be attached before any frame exists. Shared by 3 tools. */
	const attachGate = () => {
		const { attach } = effectiveChannel(cfg);
		if (attach.wsUrl === "") return `no live browser: the activated link has no CDP endpoint yet. Run bcdp_status (or bcdp_doctor) to attach, then retry. (attach status=${attach.status}${attach.code === "" ? "" : `, code=${attach.code}`})`;
		return "";
	};
	reg(defineTool({
		name: "bcdp_jev_status",
		description: "Report the JEV/Laya judgement chain WITHOUT calling anything: which hops are configured, which will be skipped and why, thresholds, budgets, and the browser attach state. Run this first when judging fails.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 1e4,
		execute: async (_args, exec) => {
			cfg.spaceTracker.setCurrentSession(callingSessionId(exec));
			markEgoToolCall(callingSessionId(exec));
			const judge = judgeCfg();
			const runtime = judgeRuntimeOf();
			const { attach } = effectiveChannel(cfg);
			const lines = [
				"judgement chain (priority order):",
				...describeJudge(runtime),
				"",
				`prefer (raw)      : ${judge.prefer}`,
				`prefer (parsed)   : ${runtime.order.join(" -> ")}`,
				`jev               : ${judge.jevUrl === "" ? "(not configured)" : judge.jevUrl} model=${judge.jevModel} key=${judge.jevKey === "" ? "MISSING" : "set"}`,
				`laya              : ${judge.layaUrl} model=${judge.layaModel} key=${judge.layaKey === "" ? "MISSING" : "set"}`,
				"",
				`chunk ceiling     : ${judge.chunkSize} candidates`,
				`image budget      : ${judge.maxImageBytes === 0 ? "unbounded (measured default)" : `${judge.maxImageBytes} B`}`,
				`history depth     : ${judge.historyLimit}`,
				`archive image     : ${judge.archiveImage ? "embedded" : "metadata only"}`,
				`loop budgets      : steps=${judge.stepBudget} wall=${judge.wallMs}ms captures=${DEFAULT_BUDGETS.captures}`,
				"",
				`browser attach    : ${attach.wsUrl === "" ? `NOT ATTACHED (status=${attach.status}${attach.code === "" ? "" : `, code=${attach.code}`})` : `${attach.endpoint} (${attach.endpointSource ?? "unknown"})`}`
			];
			if (judge.layaKey === "") lines.push("", "laya has no key, so that hop is SKIPPED �?the chain is running on the offline rule hop alone.", "laya-api has no anonymous branch, so a keyless call is a guaranteed 401; skipping it is deliberate.", "", "To bring laya up locally:", "  1. start the sidecar (it serves 8000, and JevLoop's 7789 is a different tool):", "       ENGINE=laya LAYA_PRELOAD=true LAYA_DEVICE=cpu uvicorn laya_api.main:app", "     with ALLOW_DEV_LOGIN=true you can sign in without Google.", "  2. open http://localhost:8000, create an API key (it is shown once, format laya_...).", "  3. paste it into this panel's Laya key field and save.");
			return {
				ok: true,
				text: lines.join("\n")
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "bcdp_jev_status",
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "bcdp_jev_ask",
		description: "Assemble the JEV/Laya judgement request for the current page + intent; return it (dryRun) or send it.",
		parameters: {
			goal: {
				type: "string",
				required: true,
				description: "What we are trying to accomplish."
			},
			kind: {
				type: "string",
				description: "navigate | extract | fill | click | verify | other."
			},
			hints: {
				type: "string",
				description: "Target hint per line; never a selector."
			},
			successCriteria: {
				type: "string",
				description: "Success condition per line."
			},
			stopConditions: {
				type: "string",
				description: "Stop condition per line."
			},
			dryRun: {
				type: "boolean",
				description: "Assemble only, do not send (default true)."
			},
			includeImage: {
				type: "boolean",
				description: "Also return the base64 frame (default false)."
			},
			maxCandidates: {
				type: "integer",
				description: "Candidate ceiling for this call."
			},
			round: {
				type: "string",
				description: "'control' | 'chapter' | 'pick' (default control)."
			},
			chapter: {
				type: "string",
				description: "Chapter key for a 'pick' round, e.g. form#1."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 6e4,
		execute: async (args, exec) => {
			cfg.spaceTracker.setCurrentSession(callingSessionId(exec));
			markEgoToolCall(callingSessionId(exec));
			const blocked = attachGate();
			if (blocked !== "") return {
				ok: false,
				text: blocked
			};
			if (str(args.goal, "") === "") return {
				ok: false,
				text: "bcdp_jev_ask: goal is required"
			};
			const judge = judgeCfg();
			const runtime = judgeRuntimeOf();
			const effects = effectsOf(runtime);
			let frame;
			try {
				frame = (await effects.capture()).frame;
			} catch (error) {
				return {
					ok: false,
					text: `capture failed: ${error instanceof Error ? error.message : String(error)}`
				};
			}
			const maxCandidates = num(args.maxCandidates, judge.chunkSize);
			const asked = str(args.round, "control");
			const roundKind = asked === "chapter" || asked === "pick" ? asked : "control";
			const chapterKey = str(args.chapter, "");
			let round;
			try {
				round = buildRound({
					frame,
					intent: intentFrom(args),
					round: roundKind,
					...chapterKey === "" ? {} : { chapterKey },
					config: {
						chunkSize: maxCandidates,
						maxImageBytes: judge.maxImageBytes,
						historyLimit: judge.historyLimit,
						archiveImageBudget: judge.archiveImage ? 1 : 0,
						model: judge.layaModel
					}
				});
			} catch (error) {
				return {
					ok: false,
					text: `could not assemble the ${roundKind} round: ${error instanceof Error ? error.message : String(error)}`
				};
			}
			const firstHttp = runtime.order.find((name$1) => name$1 === "jev" || name$1 === "laya");
			const assembland = firstHttp === void 0 ? null : assembleSystemOneBody({
				state: round.state,
				questions: round.questions,
				model: firstHttp === "jev" ? judge.jevModel : judge.layaModel
			}, {
				name: firstHttp,
				baseUrl: firstHttp === "jev" ? judge.jevUrl : judge.layaUrl
			});
			const chaptersInFrame = chaptersOf(frame.dom.nodes);
			const lines = [
				`round      : ${round.round}`,
				`frame      : ${frame.frameId}  ${frame.viewport.width}x${frame.viewport.height} @${frame.viewport.devicePixelRatio}x`,
				`page       : ${frame.target.url}`,
				`candidates : ${frame.dom.nodes.length}${frame.dom.truncated ? " (TRUNCATED)" : ""}`,
				`chapters   : ${chaptersInFrame.length}  ${chaptersInFrame.map((c) => `${c.key}(${c.nodes.length})`).join(" ")}`,
				`image      : ${frame.image === null ? "none" : `${frame.image.format} ${frame.image.bytes} B q=${frame.image.quality ?? "-"}${frame.image.overBudget ? " OVER BUDGET" : ""}`}`,
				`chunk plan : total=${round.plan.chunkTotal} size=${round.plan.chunkSize} reason=${round.plan.reason}`,
				`questions  : ${Object.keys(round.questions).join(", ")}`
			];
			if (round.round === "pick" && chapterKey === "") lines.push("", "note: this pick round was assembled WITHOUT a chapter filter, so it offers every candidate in the chunk.", "During a real run the loop asks the chapter question first and then restricts the pick to that section —", "which is what keeps both questions inside a stricter threshold bucket.");
			if (round.issues.length > 0) lines.push(`ISSUES     : ${round.issues.map((issue) => `${issue.code}(${issue.questionId})`).join(", ")}  <- must be fixed before sending`);
			if (assembland !== null) {
				lines.push(`POST       : ${assembland.url}`);
				lines.push("", "── assembled request body (exactly the three allowed keys) ──", JSON.stringify(assembland.body, null, 2));
			} else lines.push("", "(no HTTP hop configured �?only the rule hop is available)");
			if (bool(args.dryRun, true)) {
				lines.push("", "dryRun: nothing was sent.");
				return {
					ok: true,
					text: lines.join("\n")
				};
			}
			const answer = await sendJudge(runtime, {
				questions: round.questions,
				state: round.state
			});
			lines.push("", "── answer ──", `provider   : ${answer.provider}${answer.degraded ? " (DEGRADED)" : ""} model=${answer.model} ${answer.latencyMs}ms`, `chain      : ${answer.chain.join(" -> ") || "(none)"}`, `trace      : ${answer.trace.join(" | ") || "(none)"}`, `answers    : ${JSON.stringify(answer.answers)}`);
			if (answer.missing.length > 0) lines.push(`MISSING    : ${answer.missing.join(", ")}`);
			if (answer.dropped.length > 0) lines.push(`DROPPED    : ${answer.dropped.join(", ")}`);
			if (judge.archiveImage) lines.push("", `(archive image omitted from this report: ${frame.image?.dataBase64.length ?? 0} base64 chars)`);
			if (bool(args.includeImage, false) && frame.image !== null) lines.push("", "── frame image (base64) ──", frame.image.dataBase64);
			lines.push("", `── Laya archive bundle (${serializeLaya(round).length} chars) ──`, "write it with bcdp_script if you need it on disk");
			return {
				ok: true,
				text: lines.join("\n")
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "bcdp_jev_ask",
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "bcdp_jev_frame",
		description: "Capture one judgement FRAME from the current page: numbered interactive candidates plus a budgeted screenshot. Inspect this to see exactly what a judge would be shown.",
		parameters: {
			limit: {
				type: "integer",
				description: "Candidate ceiling (default: the configured chunk size)."
			},
			maxBytes: {
				type: "integer",
				description: "Screenshot byte budget; 0 = unbounded (default)."
			},
			showCandidates: {
				type: "boolean",
				description: "List every numbered candidate (default true)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 6e4,
		execute: async (args, exec) => {
			cfg.spaceTracker.setCurrentSession(callingSessionId(exec));
			markEgoToolCall(callingSessionId(exec));
			const blocked = attachGate();
			if (blocked !== "") return {
				ok: false,
				text: blocked
			};
			const judge = judgeCfg();
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
				sleep: async () => {}
			});
			let frame;
			try {
				frame = (await effects.capture()).frame;
			} catch (error) {
				return {
					ok: false,
					text: `capture failed: ${error instanceof Error ? error.message : String(error)}`
				};
			}
			const lines = [
				`frameId    : ${frame.frameId}`,
				`page       : ${frame.target.url}`,
				`target     : ${frame.target.targetId}`,
				`viewport   : ${frame.viewport.width}x${frame.viewport.height} @${frame.viewport.devicePixelRatio}x scroll(${frame.viewport.scrollX},${frame.viewport.scrollY})`,
				`image      : ${frame.image === null ? "none" : `${frame.image.format} ${frame.image.bytes} B (${(frame.image.bytes / 1024).toFixed(1)} KiB) q=${frame.image.quality ?? "-"}`}`,
				`budget     : ${frame.image === null || frame.image.maxBytes === 0 ? "unbounded" : frame.image.maxBytes + " B"}${frame.image?.overBudget === true ? "  *** OVER BUDGET ***" : ""}`,
				`candidates : ${frame.dom.nodes.length} of ${frame.dom.total}${frame.dom.truncated ? " (TRUNCATED)" : ""}`
			];
			if (defaultAttachCache.get().engine === "lightpanda") lines.push(`engine     : lightpanda (rendering: text �?screenshot fidelity differs from Chrome)`);
			if (frame.image?.overBudget === true) lines.push("", "The image exceeded the byte budget even at floor quality. Raise jevMaxImageBytes, or accept it and let the count drive chunking.");
			if (bool(args.showCandidates, true)) {
				lines.push("", "── candidates (the judge answers with these numbers) ──");
				for (const node of frame.dom.nodes) lines.push(`${node.n}. ${node.role} "${node.name}" [${node.container}]`);
			}
			lines.push("", "note: rects are NOT carried on this path (the AX tree has none) �?the executor re-measures before any action.");
			return {
				ok: true,
				text: lines.join("\n")
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "bcdp_jev_frame",
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "bcdp_jev_run",
		description: "Run the JEV loop for one goal; returns a step trace.",
		parameters: {
			goal: {
				type: "string",
				required: true,
				description: "The goal, in your own words."
			},
			kind: {
				type: "string",
				description: "navigate | extract | fill | click | verify | other."
			},
			hints: {
				type: "string",
				description: "Target hint per line (never a selector)."
			},
			successCriteria: {
				type: "string",
				description: "Success condition per line; required for done."
			},
			stopConditions: {
				type: "string",
				description: "Stop condition per line."
			},
			stepBudget: {
				type: "integer",
				description: "Max judgement rounds (default settings)."
			},
			wallMs: {
				type: "integer",
				description: "Wall-clock ceiling in ms (default settings)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: TOOL_TIMEOUT_MS,
		execute: async (args, exec) => {
			cfg.spaceTracker.setCurrentSession(callingSessionId(exec));
			markEgoToolCall(callingSessionId(exec));
			const blocked = attachGate();
			if (blocked !== "") return {
				ok: false,
				text: blocked
			};
			if (str(args.goal, "") === "") return {
				ok: false,
				text: "bcdp_jev_run: goal is required"
			};
			const judge = judgeCfg();
			const runtime = judgeRuntimeOf();
			const intent = intentFrom(args);
			const effects = effectsOf(runtime);
			const started = Date.now();
			const result = await runLoop({
				intent,
				effects,
				budgets: {
					...DEFAULT_BUDGETS,
					steps: num(args.stepBudget, judge.stepBudget),
					wallMs: num(args.wallMs, judge.wallMs)
				},
				pipe: {
					chunkSize: judge.chunkSize,
					maxImageBytes: judge.maxImageBytes,
					historyLimit: judge.historyLimit,
					archiveImageBudget: judge.archiveImage ? 1 : 0,
					model: judge.jevModel
				}
			});
			const lines = [
				`status     : ${result.status.toUpperCase()}${result.exhaustedKind === void 0 ? "" : ` (${result.exhaustedKind})`}`,
				`reason     : ${result.reason}`,
				`steps      : ${result.steps.length}  elapsed=${Date.now() - started}ms  degraded=${result.degraded}`,
				`remaining  : steps=${result.remaining.steps} judge=${result.remaining.judge} captures=${result.remaining.captures} wall=${result.remaining.wallMs}ms`
			];
			if (effects.lastError() !== "") lines.push(`lastError  : ${effects.lastError()}`);
			if (intent.successCriteria.length === 0 && result.status === "done") lines.push("", "WARNING: this run reported `done` with NO successCriteria, so the claim could only be checked against the goal text. Add criteria for a trustworthy verdict.");
			lines.push("", "── steps ──");
			if (result.steps.length === 0) lines.push("(none)");
			for (const step$1 of result.steps) lines.push(`${String(step$1.index).padStart(3)}. ${step$1.control.padEnd(20)} n=${String(step$1.n).padStart(3)} ${step$1.action.padEnd(7)} ${step$1.ok ? "ok  " : "FAIL"} ${step$1.provider}${step$1.degraded ? "*" : " "} ${step$1.note}`);
			if (result.excluded.length > 0) lines.push("", `ruled out: ${result.excluded.join(", ")}  (these are no longer OFFERED to the judge)`);
			return {
				ok: true,
				text: lines.join("\n")
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "bcdp_jev_run",
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "bcdp_jev_attempt",
		description: "Open a URL and let the decision model attempt one goal: each round it picks from the page's DOM candidates plus `end`, up to N actions. Returns a receipt; verify yourself via bcdp_cdp/bcdp_screenshot (a receipt is a report, not proof).",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to open."
			},
			goal: {
				type: "string",
				required: true,
				description: "The goal, in your own words."
			},
			successCriteria: {
				type: "string",
				description: "Success condition per line; helps the model decide when to stop."
			},
			maxActions: {
				type: "integer",
				description: "Action budget (default 5, max 20)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: TOOL_TIMEOUT_MS,
		execute: async (args, exec) => {
			cfg.spaceTracker.setCurrentSession(callingSessionId(exec));
			markEgoToolCall(callingSessionId(exec));
			const blocked = attachGate();
			if (blocked !== "") return {
				ok: false,
				text: blocked
			};
			const url = str(args.url, "");
			const goal = str(args.goal, "");
			if (url === "") return {
				ok: false,
				text: "bcdp_jev_attempt: url is required"
			};
			if (goal === "") return {
				ok: false,
				text: "bcdp_jev_attempt: goal is required"
			};
			const maxActions = Math.min(20, Math.max(1, num(args.maxActions, 5)));
			judgeCfg();
			const effects = effectsOf(judgeRuntimeOf());
			const criteria = str(args.successCriteria, "");
			const intent = {
				goal,
				kind: "click",
				targetHints: [],
				successCriteria: criteria === "" ? [] : criteria.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
				stopConditions: [],
				source: "user"
			};
			const started = Date.now();
			const nav = await effects.navigate(url);
			if (!nav.ok) return {
				ok: false,
				text: `bcdp_jev_attempt: navigation failed �?${nav.error ?? "unknown error"}`
			};
			const result = await runAttempt({
				intent,
				effects,
				maxActions
			});
			const lines = [
				`status     : ${result.status.toUpperCase()}  actions=${result.actions.length}/${maxActions}`,
				`reason     : ${result.reason}`,
				`page       : ${result.lastUrl || nav.url}`,
				`elapsed    : ${Date.now() - started}ms  candidates(last round)=${result.candidates}`,
				`verify via : bcdp_cdp / bcdp_screenshot on targetId=${effects.frames().at(-1)?.target.targetId ?? "unknown"} �?the receipt is a report, not a proof`
			];
			if (effects.lastError() !== "") lines.push(`lastError  : ${effects.lastError()}`);
			lines.push("", result.actions.length === 0 ? "── actions ──  (none)" : "── actions ──");
			for (const step$1 of result.actions) lines.push(`${String(step$1.index).padStart(3)}. n=${String(step$1.n).padStart(3)} ${step$1.ok ? "ok  " : "FAIL"} top=${step$1.top.toFixed(2)} ${step$1.provider}${step$1.degraded ? "*" : " "} ${step$1.label}${step$1.anchor === void 0 ? "" : `  [${step$1.anchor}]`}`);
			if (result.status === "ended") lines.push("", "The model ENDED BY ITSELF. Check the page state through CDP before treating the goal as achieved.");
			if (result.status === "exhausted") lines.push("", "The action budget ran out WITHOUT the model ending. Raise maxActions, or take over via CDP tools.");
			return {
				ok: true,
				text: lines.join("\n")
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "bcdp_jev_attempt",
			kind: "other",
			rawInput: null
		})
	}));
}

//#endregion
export { ATTACH_SESSION_HINT, CDP_CONNECT_FAIL_RE, Config, GLOBAL_SESSION_KEY, STATUS_FACADE_SCRIPT, STATUS_FACADE_SENTINEL, TAB_STUCK_RE, apply, attachSessionHint, buildEgoToolArgv, cdpAttachError, createActiveSpaceTracker, createSessionSpaceTracker, decideCdpAttach, deriveSlotDefaultName, effectiveChannel, findChromeBinary, findUpstreamPluginInstall, inject, isTabStuckFailure, name, parseSentinel, parseStatusFacades, resolveEgoEnv, runWithStaleSpaceRetry, runWithTabRevive, sessionSpaceToken, shouldReapBrowser };