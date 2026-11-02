import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

//#region src/cdp/launcher.ts
const defaultIo = () => ({
	exists: (path) => existsSync(path),
	readFile: (path) => readFileSync(path, "utf8"),
	writeFile: (path, data) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, data, "utf8");
	},
	removeFile: (path) => {
		try {
			rmSync(path);
		} catch {}
	},
	isAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	},
	killTree: (pid) => {
		if (process.platform === "win32") {
			try {
				spawn("taskkill", [
					"/PID",
					String(pid),
					"/T",
					"/F"
				], { stdio: "ignore" });
			} catch {}
			return;
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	},
	spawn: (bin, args, env) => {
		const child = spawn(bin, args, {
			detached: true,
			stdio: "ignore",
			...env === void 0 ? {} : { env: {
				...process.env,
				...env
			} }
		});
		child.unref();
		return { pid: child.pid ?? 0 };
	},
	fetchVersion: async (url) => {
		return { ok: (await fetch(url)).ok };
	},
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve$1) => setTimeout(resolve$1, ms)),
	makePort: async () => {
		const server = createServer();
		const port = await new Promise((resolve$1, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (address && typeof address === "object") resolve$1(address.port);
				else reject(/* @__PURE__ */ new Error("no port"));
			});
		});
		server.close();
		return port;
	}
});
const PLATFORM_CANDIDATES = {
	win32: [
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe"
	],
	darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
	linux: [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser"
	]
};
function discoverChromeBinary(explicit, platform, exists) {
	if (explicit !== "") return exists(explicit) ? explicit : "";
	for (const candidate of PLATFORM_CANDIDATES[platform] ?? []) if (exists(candidate)) return candidate;
	return "";
}
/** Flags the user must never smuggle into the managed launch. */
const BLOCKED_ARGS = [
	"--user-data-dir",
	"--remote-debugging-port",
	"--remote-allow-origins",
	"--no-startup-window",
	"--proxy-server",
	"--headless"
];
function buildLaunchArgs(options) {
	const userArgs = (options.chromeArgs ?? "").split(/\s+/).map((arg) => arg.trim()).filter((arg) => arg !== "").filter((arg) => !BLOCKED_ARGS.some((blocked) => arg === blocked || arg.startsWith(`${blocked}=`) || arg.startsWith(`${blocked} `)));
	return [
		`--remote-debugging-port=${options.port}`,
		`--user-data-dir=${options.userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-allow-origins=*",
		...options.headless ? ["--headless=new"] : [],
		...userArgs
	];
}
/** Flags the user must never smuggle into a managed `lightpanda serve`. */
const LP_BLOCKED_ARGS = [
	"--host",
	"--port",
	"--address"
];
/**
* Assemble `lightpanda serve --host 127.0.0.1 --port <port>` + user args.
* No profile/headless flags exist on the serve CLI — nothing to block there.
*/
function buildServeArgs(options) {
	const tokens = (options.lightpandaArgs ?? "").split(/\s+/).map((arg) => arg.trim()).filter((arg) => arg !== "");
	const userArgs = [];
	let skipNext = false;
	for (const arg of tokens) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		const blocked = LP_BLOCKED_ARGS.find((b) => arg === b || arg.startsWith(`${b}=`));
		if (blocked !== void 0) {
			if (arg === blocked) skipNext = true;
			continue;
		}
		userArgs.push(arg);
	}
	return [
		"serve",
		"--host",
		"127.0.0.1",
		"--port",
		String(options.port),
		...userArgs
	];
}
/**
* win32 sentinel returned by `discoverLightpandaBinary`: Lightpanda has no
* native Windows build, so the launch argv goes through `wsl.exe --` and the
* binary lives inside the WSL2 filesystem (host `exists()` cannot see it —
* the readiness gate is the real check).
*/
const WSL_LAUNCH = "wsl";
/**
* Lightpanda discovery. unix: explicit → common install roots (the official
* installer targets `~/.local/bin`) → bare PATH name. win32: the WSL sentinel
* when `wsl.exe` exists (the serve runs inside the default distro).
*/
function discoverLightpandaBinary(explicit, platform, exists) {
	if (platform === "win32") return exists("C:/Windows/System32/wsl.exe") ? WSL_LAUNCH : "";
	if (explicit !== "") return explicit;
	const home = homedir();
	for (const candidate of [
		`/usr/local/bin/lightpanda`,
		`/usr/bin/lightpanda`,
		join(home, ".local", "bin", "lightpanda"),
		join(home, ".dsh", "cache", "dsh-browser-cdp", "bin", "lightpanda")
	]) if (exists(candidate)) return candidate;
	return "lightpanda";
}
/** Spawn argv for one engine on one platform. */
function buildEngineArgv(options) {
	if (options.engine === "lightpanda" && options.platform === "win32" && options.bin === WSL_LAUNCH) return [
		"wsl.exe",
		"--",
		"lightpanda",
		...options.serveArgs
	];
	return [options.bin, ...options.serveArgs];
}
/** Env handed to a managed Lightpanda serve (telemetry opt-out; WSLENV carries it into WSL). */
function lightpandaSpawnEnv(platform) {
	const env = { LIGHTPANDA_DISABLE_TELEMETRY: "true" };
	if (platform === "win32") env.WSLENV = "LIGHTPANDA_DISABLE_TELEMETRY/u";
	return env;
}
function defaultLauncherStatePath() {
	return join(homedir(), ".dsh", "cache", "dsh-browser-cdp", "launcher.json");
}
function defaultManagedProfileDir() {
	return join(homedir(), ".dsh", "cache", "dsh-browser-cdp", "chrome-profile");
}
function readRecord(path, io) {
	if (!io.exists(path)) return null;
	try {
		const parsed = JSON.parse(io.readFile(path));
		if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return null;
		return {
			pid: parsed.pid,
			port: parsed.port,
			userDataDir: typeof parsed.userDataDir === "string" ? parsed.userDataDir : "",
			endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : "",
			startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
			engine: parsed.engine === "lightpanda" ? "lightpanda" : "chrome"
		};
	} catch {
		return null;
	}
}
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
async function launchLocalBrowser(options, io) {
	const ioImpl = {
		...defaultIo(),
		...io ?? {}
	};
	const now = ioImpl.now;
	const sleep = ioImpl.sleep;
	const statePath = options.statePath ?? defaultLauncherStatePath();
	const engine = options.engine === "lightpanda" ? "lightpanda" : "chrome";
	const platform = options.platform ?? process.platform;
	const record = readRecord(statePath, ioImpl);
	if (record && record.engine !== engine && ioImpl.isAlive(record.pid)) {
		ioImpl.killTree(record.pid);
		ioImpl.removeFile(statePath);
	}
	const live = readRecord(statePath, ioImpl);
	if (live && live.engine === engine && ioImpl.isAlive(live.pid) && (await ioImpl.fetchVersion(`http://127.0.0.1:${live.port}/json/version`)).ok) return {
		ok: true,
		reused: true,
		endpoint: live.endpoint,
		pid: live.pid,
		port: live.port
	};
	let bin;
	let spawnEnv;
	if (engine === "lightpanda") {
		bin = discoverLightpandaBinary(options.lightpandaPath ?? "", platform, ioImpl.exists);
		if (bin === "") return {
			ok: false,
			code: "binary-not-found",
			message: "wsl.exe not found — Lightpanda has no native Windows build. Install WSL2 (`wsl --install` as admin), then inside WSL: `curl -fsSL https://pkg.lightpanda.io/install.sh | bash`."
		};
		spawnEnv = lightpandaSpawnEnv(platform);
	} else {
		bin = discoverChromeBinary(options.chromePath ?? "", platform, ioImpl.exists);
		if (bin === "") return {
			ok: false,
			code: "chrome-not-found",
			message: "No Chrome/Chromium/Edge binary found. Set chromePath in the settings panel."
		};
	}
	const userDataDir = options.userDataDir && options.userDataDir !== "" ? options.userDataDir : defaultManagedProfileDir();
	const port = await ioImpl.makePort();
	let spawnBin;
	let args;
	if (engine === "lightpanda") {
		const full = buildEngineArgv({
			engine,
			platform,
			bin,
			serveArgs: buildServeArgs({
				port,
				lightpandaArgs: options.lightpandaArgs
			})
		});
		spawnBin = full[0];
		args = full.slice(1);
	} else {
		spawnBin = bin;
		args = buildLaunchArgs({
			userDataDir,
			port,
			headless: options.localHeadless === true,
			chromeArgs: options.chromeArgs
		});
	}
	let pid = 0;
	try {
		pid = ioImpl.spawn(spawnBin, args, spawnEnv).pid;
	} catch (error) {
		return {
			ok: false,
			code: "spawn-failed",
			message: String(error.message ?? error)
		};
	}
	if (!pid) return {
		ok: false,
		code: "spawn-failed",
		message: "spawn returned no pid"
	};
	const endpoint = `http://127.0.0.1:${port}`;
	const engineName = engine === "lightpanda" ? "lightpanda" : "chrome";
	const deadline = now() + (options.timeoutMs ?? 2e4);
	for (;;) {
		if (!ioImpl.isAlive(pid)) return {
			ok: false,
			code: "launch-exited",
			message: `${engineName} exited before opening the debugging port (pid ${pid})${engine === "lightpanda" && platform === "win32" ? " — is lightpanda installed inside WSL? (`wsl` then `curl -fsSL https://pkg.lightpanda.io/install.sh | bash`)" : ""}`
		};
		let versionOk = false;
		try {
			versionOk = (await ioImpl.fetchVersion(`${endpoint}/json/version`)).ok;
		} catch {}
		if (versionOk) break;
		if (now() >= deadline) {
			ioImpl.killTree(pid);
			ioImpl.removeFile(statePath);
			return {
				ok: false,
				code: "not-ready",
				message: `${engineName} did not answer ${endpoint}/json/version within the readiness window`
			};
		}
		await sleep(250);
	}
	ioImpl.writeFile(statePath, JSON.stringify({
		pid,
		port,
		userDataDir,
		endpoint,
		startedAt: now(),
		headless: options.localHeadless === true,
		engine
	}, null, 2));
	return {
		ok: true,
		reused: false,
		endpoint,
		pid,
		port
	};
}
/**
* Stop the managed instance: kill-tree, wait for the pid to disappear, drop
* the registry entry. T2.14 — the reaper and plugin unmount both call this.
* Lightpanda on win32 rides `wsl.exe`, and taskkill /T does not reach the
* Linux-side process — add a targeted pkill of OUR serve argv as backstop.
*/
async function stopLocalBrowser(options = {}, io) {
	const ioImpl = {
		...defaultIo(),
		...io ?? {}
	};
	const statePath = options.statePath ?? defaultLauncherStatePath();
	const record = readRecord(statePath, ioImpl);
	if (!record) return {
		ok: true,
		code: "not-running"
	};
	if (ioImpl.isAlive(record.pid)) {
		ioImpl.killTree(record.pid);
		if (record.engine === "lightpanda" && process.platform === "win32") try {
			spawn("wsl.exe", [
				"--",
				"sh",
				"-c",
				`pkill -f 'lightpanda serve --host 127.0.0.1 --port ${record.port}' || true`
			], { stdio: "ignore" }).unref();
		} catch {}
		const deadline = ioImpl.now() + (options.graceMs ?? 5e3);
		while (ioImpl.isAlive(record.pid) && ioImpl.now() < deadline) await ioImpl.sleep(100);
		if (ioImpl.isAlive(record.pid)) return {
			ok: false,
			code: "stop-timeout"
		};
	}
	ioImpl.removeFile(statePath);
	return {
		ok: true,
		code: "stopped"
	};
}
/** Is a managed local browser alive right now? (reaper + doctor helper) */
function localBrowserInfo(statePath, io) {
	const ioImpl = {
		...defaultIo(),
		...io ?? {}
	};
	const record = readRecord(statePath ?? defaultLauncherStatePath(), ioImpl);
	if (!record || !ioImpl.isAlive(record.pid)) return null;
	return {
		endpoint: record.endpoint,
		pid: record.pid
	};
}

//#endregion
export { defaultLauncherStatePath as a, discoverLightpandaBinary as c, localBrowserInfo as d, stopLocalBrowser as f, buildServeArgs as i, launchLocalBrowser as l, buildEngineArgv as n, defaultManagedProfileDir as o, buildLaunchArgs as r, discoverChromeBinary as s, WSL_LAUNCH as t, lightpandaSpawnEnv as u };