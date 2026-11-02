/** Injected by the DSH ModuleLoader factory wrapper (tsdown banner). */
declare function require(id: string): any

import { addRow, applyProbe, buildCdpRow, buildCliRow, buildLpRow, hasCliLink, hasLpLink, isFull, isValidEndpoint, MAX_LINKS, moveRow, removeRow, updateRow } from './fam-links'
import { claimFamilyHostIfOrphaned } from './family-host'
import { fromRatio, normalizeStored, toRatio, type RatioPos, type Viewport } from './fab-pos'
import { commitField } from './fam-write'

		// #region CDP browser bridge client: realtime watch-bubble
		//
		// A floating "watch" bubble (bottom-right) plus an expandable overlay
		// panel that shows what the agent's browser is doing in real time:
		// one thumbnail per live page target (URL + title), polled from the
		// host route /api/bcdp/spaces (which the host proxies to the ego-cast
		// worker attached to the agent's own Chrome via CDP screencast).
		//
		// Design constraints (kept deliberately minimal / read-only):
		//  - NO layout takeover: it is an overlay, not a grid-sidebar, so it
		//    never reshapes the conversation area or fights other panels.
		//  - READ-ONLY: only displays what the agent browser is already doing;
		//    there is no pause/resume/navigate control here (that stays out of
		//    scope to avoid racing the running agent).
		//  - Self-cleaning: everything is registered through ctx.effect so
		//    unmount / hot-reload restores the DOM and stops the poller.
		//
		// == 内部结构（维护前先看 docs/ARCH.md）==
		//   PANEL_CSS + ICON_*        : 样式与图标（顶部常量区）
		//   apply()                   : 入口，挂载面板/浮球/事件
		//   makeZoomImage / browserXY : 主视图缩放 + 坐标逆映射
		//   makeDraggable / snapPanelToFab : 球/窗口各自拖动 + 打点吸附
		//   renderSpaces / applyFrame / openStream : 轮询 + SSE 实时帧
		//   maybeShowLoginGuide / maybeShowCaptchaGuide : 登录/人机验证提醒条
		// 注意：本前端是单文件（受 DSH 注入机制限制），不要在页面上拆文件；
		//   数据源 = 轮询 /api/bcdp/spaces + SSE /api/bcdp/stream(实时帧)。
		// #endregion

		// ── Watch panel / sidebar tab dependencies ────────────────────────
		// Required up-front so the sidebar tab (React) can share the client
		// store snapshot. The ModuleLoader factory's `require` resolves these
		// from the profile's node_modules (declared as peerDependencies).
		//
		// [0.1.2-alpha.1 migration] `@deepseek-ai/dsh-client-runtime` was renamed
		// to `@deepseek-ai/dsh-client-store` (packages/client/store); the browser
		// module graph now resolves the store as a static module under the plain
		// package id (no `/client` subpath). createSnapshotStore kept its shape.
		var React = require('react')
		// 0.1.0/0.1.1 宿主模块表没有 @deepseek-ai/dsh-client-store——静态 require
		// 会让整个 client 模块加载即砖。改为懒加载:有包用宿主的,没包用本地
		// 极简快照仓(subscribe/getSnapshot/update 三件套,watch 面板够用)。
		var runtimeClient: any = null
		var createSnapshotStore: any = null
		function ensureSnapshotStoreCreator(): any {
			if (createSnapshotStore !== null) return createSnapshotStore
			try {
				runtimeClient = require('@deepseek-ai/dsh-client-store')
				createSnapshotStore = runtimeClient.createSnapshotStore
			} catch (e) {
				createSnapshotStore = function (initial: any) {
					var value = initial
					var listeners: any[] = []
					return {
						subscribe: function (fn: any) { listeners.push(fn); return function () { listeners = listeners.filter(function (l: any) { return l !== fn }) } },
						getSnapshot: function () { return value },
						update: function (fn: any) { value = fn(value); for (var i = 0; i < listeners.length; i++) listeners[i]() },
					}
				}
			}
			return createSnapshotStore
		}
		// bindSnapshotSelector inlined from dsh-client-ui-renderer (shell-only
		// glue; business plugins depend on runtime + ui-slots only). Uses
		// React 18's built-in useSyncExternalStore with per-snapshot selector
		// memoization via useRef.
		var useSyncExternalStore = React.useSyncExternalStore
		var useRef = React.useRef
		function bindSnapshotSelector(source: any) {
			var subscribe = function (fn: any) { return source.subscribe(fn) }
			var getSnapshot = function () { return source.getSnapshot() }
			return function useSelector(sel: any, eq: any) {
				var snapshot = useSyncExternalStore(subscribe, getSnapshot)
				var prevSnapshotRef = useRef()
				var prevSelectedRef = useRef()
				if (prevSnapshotRef.current !== snapshot) {
					prevSnapshotRef.current = snapshot
					prevSelectedRef.current = sel(snapshot)
				}
				return prevSelectedRef.current
			}
		}

		// 'betterSidebar' must NOT be declared here: hosts without
		// dsh-better-sidebar have no such service, and the module loader keeps
		// any row that statically injects it pending forever — which blocks the
		// whole web boot (issue #29, reproduced on DSH 0.1.2-rc.1 without the
		// sidebar installed). Probe it defensively in apply() instead.
		// sessions + conversation：点选投递（deliverPickToConversation）与 composer
// 包装卡（mountComposerDecoration）裸访问 ctx.sessions / ctx.get('conversation')。
// 两者都是宿主 web UI 的核心服务（必然已加载），声明后 strict resolver 才放行
// ——否则抛 cannot get property "sessions" without inject（issue #29 同类）。
const inject = ['slots', 'locale', 'connection', 'sessions', 'conversation']

		// ── Watch panel locale ────────────────────────────────────────────
		var _egoLocale = (function () {
			try { var lang = navigator.language || ''; return lang.startsWith('zh') ? 'zh' : 'en' } catch { return 'en' }
		})()
		var watchEn = {
			title: 'Agent Browser',
			titleLive: 'Agent Browser · Live',
			liveView: 'Live view',
			pinned: 'Pinned',
			realtime: 'Live',
			noScreenshot: '(no screenshot — about:blank or browser not rendering)',
			engineUnsupportedBanner: '(live view unsupported on this engine — Lightpanda renders text; use bcdp_snapshot / bcdp_screenshot instead)',
			engineUnsupportedPick: 'picking is unsupported on this engine (no Overlay / no live view) — use bcdp_snapshot to locate elements',
			noActivePages: 'No active browser pages',
			noActiveHint: 'Pages will appear here as the agent browses with bcdp_*',
			openExternal: 'Open real page',
		raiseWindow: 'Pop out window',
		raiseWindowHint: 'Raise the agent browser as a real window (a headless instance is replaced by a visible one on the same profile)',
			pickMode: 'Pick element',
			pickModeHint: 'Click an element in the live page to quote it into the conversation',
			picking: 'Picking… click an element in the page',
			picked: 'Element captured',
			pickFailed: 'Pick failed',
			pickQuoted: '✓ Quoted to composer',
			pickDeliverFailed: 'Delivery failed',
			noUrl: 'No URL to open',
			closeTab: 'Close tab',
			newTab: '(new tab)',
			history: 'Browsing history',
			historyHide: 'Hide history',
			historyShow: 'Show history',
			noHistory: 'No browsing history',
			current: 'current',
			refresh: 'Refresh',
			backToLive: '← Back to live',
			dragHint: 'Drag to move panel',
			loginTitle: 'Log in via the CDP browser bridge window on your desktop',
			loginBtn: 'Logged in, save',
			loginSaving: 'Saving…',
			loginSaved: 'Saved {n} sessions',
			loginNotConnected: 'Browser not connected',
			loginFailed: 'Save failed',
			loginDismiss: 'Dismiss',
			captchaTitle: '⚠️ CAPTCHA detected',
			captchaHint: 'Complete verification in the CDP browser bridge window; the agent will continue.',
			captchaDismiss: 'Dismiss',
			hintReset: 'Reset · scroll to pan · Ctrl+scroll to zoom · double-click to reset',
			hintPan: 'Ctrl+scroll to zoom · Ctrl+drag to pan · double-click to reset',
			hintScroll: 'Ctrl+drag to pan · scroll to pan',
			hintNotCaptured: 'Not captured · operation not delivered · click again to recover',
			failed: 'failed',
			stale: '⚠ Not captured',
			captured: 'Captured',
			fabTitle: 'Agent Browser live view',
			settingsTitle: 'Show settings',
			settingsHide: 'Hide settings',
			famTitle: 'CDP Browser',
			famIsolate: 'Space isolation',
			famIsolateDesc: 'Off = persistent profile (logins survive restarts); on = isolated sandbox',
			famIdle: 'Auto-stop idle browser (minutes, 0 = off)',
			famIdleDesc: 'Stops the backing browser after N minutes without a bcdp_* call; relaunches on demand',
			linksTitle: 'Connection targets (order = priority)',
			linksEmpty: 'No targets yet — add the first one with the form below',
			linksEnabled: 'Enabled',
			linksActive: 'active',
			linksAddCdp: 'Add CDP endpoint',
			linksAddCli: 'Add local ego CLI',
			linksAddLp: 'Add Lightpanda (managed)',
			linksAddLpExists: 'The Lightpanda link already exists — local-only, one per machine',
			linksLpPathHint: 'Empty = auto (PATH → ~/.local/bin; Windows runs it inside WSL2)',
			linksLpHeadlessHint: 'Headless quick-trial engine — no manual fallback (login/captcha). Early in the order = quick trials use it; after the headed kinds (CDP / local Chrome / ego CLI) = backstop first.',
			linksLpRemoteWarn: 'Activating a Lightpanda link under cdpMode=remote fails with mode-kind-mismatch',
			linksAddCliExists: 'The local ego CLI link already exists — local-only, one per machine',
			linksEndpoint: 'Endpoint',
			linksEndpointHint: 'http(s)://host:port or ws(s)://…',
			linksEndpointInvalid: 'Invalid endpoint — not saved',
			linksCliPath: 'ego CLI path',
			linksCliPathHint: 'Empty = auto-detect (PATH → app bundle → bundled runtime)',
			linksLabel: 'Label',
			linksRemove: 'Remove',
			linksMoveUp: 'Move up',
			linksMoveDown: 'Move down',
			linksProbe: 'Probe',
			linksProbing: 'Probing…',
			linksProbeOk: 'reachable',
			linksProbeFail: 'unreachable',
			linksLimitReached: 'The sequence is capped at {n} entries',
			linksWriteFailed: 'Save failed — the settings layer rejected this write',
			linksCliRemoteWarn: 'Activating an ego CLI link under cdpMode=remote fails with mode-kind-mismatch',
			linksCliSdk: 'Use bundled harness',
			linksDisabledHint: 'Disabled — enable it before activating',
			linksActivate: 'activate',
			linksLocalRow: 'Local Chrome (managed)',
			linksLocalEnableHint: 'Checked = auto mode may fall back to the managed local browser when the activated target is unreachable',
			pickCardTitle: 'Browser picks',
			pickCardElements: '{n} element(s) picked',
			pickCardRemove: 'Remove these picks',
		}
		var watchZh = {
			title: 'CDP 浏览器',
			titleLive: 'CDP 浏览器 · 实时',
			liveView: '只读观察窗',
			pinned: '已固定查看',
			realtime: '正在实时浏览',
			noScreenshot: '（暂无截图 — about:blank 或浏览器未渲染）',
			engineUnsupportedBanner: '（当前引擎不支持实时画面 — Lightpanda 为文本渲染，可用 bcdp_snapshot / bcdp_screenshot 查看）',
			engineUnsupportedPick: '当前引擎不支持面板点选（无 Overlay/无实时画面）— 请用 bcdp_snapshot 定位元素',
			noActivePages: '暂无活跃浏览器页',
			noActiveHint: '当 agent 开始用 bcdp_* 操作网页时，这里会实时显示',
			openExternal: '⧉ 打开真实页',
		raiseWindow: '弹出窗口',
		raiseWindowHint: '把 agent 浏览器弹出为真实窗口（无头实例会被同 Profile 的有头实例替换，标签页保留）',
			pickMode: '选择元素',
			pickModeHint: '在实时页面里点选一个元素，引用到对话',
			picking: '点选中…请点击页面里的元素',
			picked: '已捕获元素',
			pickFailed: '点选失败',
			pickQuoted: '✓ 已引用到输入框',
			pickDeliverFailed: '投递失败',
			noUrl: '无可打开的地址',
			closeTab: '关闭标签',
			newTab: '(新标签页)',
			history: '历史浏览轨迹',
			historyHide: '收起历史轨迹',
			historyShow: '历史浏览轨迹',
			noHistory: '暂无浏览记录',
			current: '当前',
			refresh: '刷新',
			backToLive: '← 返回实时',
			dragHint: '拖动移动面板',
			loginTitle: '需要账号登录时，请到桌面上那个 「CDP 浏览器代理」 Chrome 窗口完成登录。',
			loginBtn: '已登录，保存',
			loginSaving: '保存中…',
			loginSaved: '已保存 {n} 条会话',
			loginNotConnected: '未连接浏览器',
			loginFailed: '保存失败',
			loginDismiss: '关闭提示',
			captchaTitle: '⚠️ 检测到人机验证',
			captchaHint: '请在桌面那个 「CDP 浏览器代理」 浏览器窗口手动完成验证，agent 会继续。',
			captchaDismiss: '关闭提示',
			hintReset: '已复位 · 滚轮滚动页面 · Ctrl+滚轮缩放 · 双击复位',
			hintPan: 'Ctrl+滚轮缩放 · Ctrl+拖动平移 · 双击复位',
			hintScroll: 'Ctrl+拖动平移 · 滚轮滚动页面',
			hintNotCaptured: '画面未接管 · 本次操作未送达 · 再点一次即可恢复',
			failed: '失败',
			stale: '⚠ 未接管',
			captured: '已接管',
			fabTitle: 'CDP 浏览器实时视图',
			settingsTitle: '展开设置',
			settingsHide: '收起设置',
			famTitle: 'CDP 浏览器',
			famIsolate: '空间隔离',
			famIsolateDesc: '关 = 持久化配置（重启保留登录态）；开 = 每次隔离沙箱',
			famIdle: '空闲自动停止（分钟，0 = 不停）',
			famIdleDesc: '超过 N 分钟没有 bcdp_* 调用即停止后台浏览器，下次调用按需重启',
			linksTitle: '连接目标（顺序即优先级）',
			linksEmpty: '暂无目标——用下方表单添加第一个连接目标',
			linksEnabled: '启用',
			linksActive: '已激活',
			linksAddCdp: '添加 CDP 端点',
			linksAddCli: '添加本机 ego CLI',
			linksAddLp: '添加 Lightpanda（受管）',
			linksAddLpExists: 'Lightpanda 连接已存在——仅限本机，一台机器只允许一条',
			linksLpPathHint: '留空 = 自动检测（PATH → ~/.local/bin；Windows 经 WSL2）',
			linksLpHeadlessHint: '无头快速试验引擎：无法人工兜底（登录/验证码）。排前面 = 快速场景优先用它；排在有头类型（CDP/本机 Chrome/ego CLI）后 = 兜底优先。',
			linksLpRemoteWarn: 'cdpMode=remote 时激活 Lightpanda 行会报 mode-kind-mismatch',
			linksAddCliExists: '本机 ego CLI 连接已存在——仅限本机，一台机器只允许一条',
			linksEndpoint: '端点',
			linksEndpointHint: 'http(s)://主机:端口 或 ws(s)://…',
			linksEndpointInvalid: '端点无效，未保存',
			linksCliPath: 'ego CLI 路径',
			linksCliPathHint: '留空 = 自动检测（PATH → 应用包 → 内置运行时）',
			linksLabel: '标签',
			linksRemove: '删除',
			linksMoveUp: '上移',
			linksMoveDown: '下移',
			linksProbe: '探测',
			linksProbing: '探测中…',
			linksProbeOk: '可达',
			linksProbeFail: '不可达',
			linksLimitReached: '连接序列最多 {n} 条',
			linksWriteFailed: '保存失败——设置层拒绝了这次写入',
			linksCliRemoteWarn: 'cdpMode=remote 时激活 ego CLI 会报 mode-kind-mismatch',
			linksCliSdk: '使用内置 harness',
			linksDisabledHint: '已停用——先勾选启用才能激活',
			linksActivate: '激活',
			linksLocalRow: '本机 Chrome（受管启动）',
			linksLocalEnableHint: '勾选 = 允许 auto 模式在激活目标不可达时回落本机启动',
			pickCardTitle: '浏览器点选内容',
			pickCardElements: '已选 {n} 个元素',
			pickCardRemove: '移除这段点选',
		}
		var watchDict: Record<string, any> = { en: watchEn, zh: watchZh }
		function wt(key: any, params: any = undefined) {
			var dict: any = watchDict[_egoLocale] || watchEn
			var text = dict[key] || (watchEn as any)[key] || key
			if (params) { for (var k in params) { text = text.replace(new RegExp('{' + k + '}', 'g'), String(params[k])) } }
			return text
		}

		const SPACES_ROUTE = '/api/bcdp/spaces'
		const EGO_CLOSE_ROUTE = '/api/bcdp/close'
		const WATCH_START_ROUTE = '/api/bcdp/watch/start'
		const WATCH_SWITCH_ROUTE = '/api/bcdp/watch/switch'
		const WATCH_STOP_ROUTE = '/api/bcdp/watch/stop'
		const WATCH_STATUS_ROUTE = '/api/bcdp/watch/status'
		const VIDEO_ROUTE = '/api/bcdp/video'

		function postJson(path: any, body: any) {
			return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (res) { return res.json().catch(function () { return {} }) })
		}

		function createKeyboardProxy(send: any) {
			var input = document.createElement('textarea')
			input.className = 'dsh-ego-keyboard-proxy'
			input.tabIndex = -1
			input.setAttribute('autocomplete', 'off')
			input.setAttribute('autocapitalize', 'off')
			input.setAttribute('spellcheck', 'false')
			input.style.cssText = 'position:fixed;z-index:2147483647;width:1px;height:1px;opacity:.01;pointer-events:none;resize:none;padding:0;border:0;left:0;top:0;'
			document.body.appendChild(input)
			var composing = false
			var armed = false
			var activeTargetId: any = null
			var pressed = new Map()
			var lastCompositionText = '', lastCompositionAt = 0, lastPasteText = '', lastPasteAt = 0
			var blurCount = 0, lastBlurAt = 0
			var modifiers = function (e: any) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0) }
			var keyId = function (e: any) { return e.code || e.key }
			var keyPayload = function (e: any) { return { key: e.key, code: e.code || '', modifiers: modifiers(e), autoRepeat: !!e.repeat, windowsVirtualKeyCode: Number(e.keyCode || e.which || 0) } }
			var isDshInput = function (target: any) {
				if (!target || target === input) return false
				var tag = target.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA') return true
				if (target.isContentEditable) return true
				return false
			}
			var releaseAllKeys = function () {
				for (const record of pressed.values()) send(record.targetId, 'keyUp', Object.assign({}, record.payload, { autoRepeat: false }))
				pressed.clear()
			}
			input.addEventListener('compositionstart', function (e) { composing = true; e.stopPropagation() })
			input.addEventListener('compositionend', function (e) {
				composing = false; e.stopPropagation()
				if (e.data && activeTargetId) { lastCompositionText = e.data; lastCompositionAt = Date.now(); send(activeTargetId, 'insertText', { text: e.data }) }
				window.setTimeout(function () { input.value = '' }, 0)
			})
			input.addEventListener('beforeinput', function (e) {
				e.stopPropagation()
				if (composing || /Composition/i.test(e.inputType || '')) return
				if (e.data && e.data === lastCompositionText && Date.now() - lastCompositionAt < 100) { e.preventDefault(); return }
				if (e.data && e.data === lastPasteText && Date.now() - lastPasteAt < 100) { e.preventDefault(); return }
				if (e.data && activeTargetId) { e.preventDefault(); send(activeTargetId, 'insertText', { text: e.data }); input.value = '' }
			})
			input.addEventListener('paste', function (e) {
				var text = e.clipboardData && e.clipboardData.getData('text/plain')
				if (!text) return
				e.preventDefault(); e.stopPropagation(); lastPasteText = text; lastPasteAt = Date.now(); if (activeTargetId) send(activeTargetId, 'insertText', { text: text }); input.value = ''
			})
			input.addEventListener('keydown', function (e) {
				e.stopPropagation()
				if (composing || e.key === 'Process' || e.key === 'Dead') return
				if (e.getModifierState && e.getModifierState('AltGraph') && e.key.length === 1) return
				var isShortcut = e.ctrlKey || e.metaKey || e.altKey
				var isControl = e.key.length > 1
				if (!isShortcut && !isControl) return
				if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'v') return
				if (!activeTargetId) return
				e.preventDefault(); var payload = keyPayload(e); pressed.set(keyId(e), { targetId: activeTargetId, payload: payload }); send(activeTargetId, 'keyDown', payload)
			})
			input.addEventListener('keyup', function (e) {
				e.stopPropagation()
				var id = keyId(e)
				var record = pressed.get(id)
				if (!record) return
				e.preventDefault(); pressed.delete(id); send(record.targetId, 'keyUp', keyPayload(e))
			})
			input.addEventListener('blur', function () {
				if (!armed || !activeTargetId) return
				var now = Date.now()
				if (now - lastBlurAt < 1000) { blurCount++; if (blurCount > 3) return }
				else blurCount = 0
				lastBlurAt = now
				window.setTimeout(function () { if (armed && activeTargetId) { try { input.focus({ preventScroll: true }) } catch (err) { input.focus() } } }, 0)
			})
			var onDocKeyDown = function (e: any) {
				if (!armed || !activeTargetId) return
				if (e.target === input) return
				if (composing || e.key === 'Process' || e.key === 'Dead') return
				if (e.getModifierState && e.getModifierState('AltGraph') && e.key.length === 1) return
				if (isDshInput(e.target) && document.activeElement === e.target) return
				var isShortcut = e.ctrlKey || e.metaKey || e.altKey
				var isControl = e.key.length > 1
				if (!isShortcut && !isControl) {
					e.preventDefault(); e.stopPropagation()
					send(activeTargetId, 'insertText', { text: e.key })
					return
				}
				if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'v') return
				e.preventDefault(); e.stopPropagation()
				var payload = keyPayload(e); pressed.set(keyId(e), { targetId: activeTargetId, payload: payload }); send(activeTargetId, 'keyDown', payload)
			}
			var onDocKeyUp = function (e: any) {
				if (!armed || !activeTargetId) return
				if (e.target === input) return
				var id = keyId(e)
				var record = pressed.get(id)
				if (!record) return
				e.preventDefault(); e.stopPropagation(); pressed.delete(id); send(record.targetId, 'keyUp', keyPayload(e))
			}
			var onDocPointerDown = function (e: any) {
				if (armed && isDshInput(e.target) && e.target !== input) {
					armed = false; releaseAllKeys()
				}
			}
			document.addEventListener('keydown', onDocKeyDown, true)
			document.addEventListener('keyup', onDocKeyUp, true)
			document.addEventListener('pointerdown', onDocPointerDown, true)
			return {
				focusAt: function (e: any, targetId: any) {
					if (activeTargetId && targetId !== activeTargetId) releaseAllKeys()
					activeTargetId = targetId
					armed = true
					blurCount = 0
					input.style.left = Math.max(0, e.clientX) + 'px'; input.style.top = Math.max(0, e.clientY) + 'px'
					try { input.focus({ preventScroll: true }) } catch (err) { input.focus() }
				},
				dispose: function () {
					armed = false
					document.removeEventListener('keydown', onDocKeyDown, true)
					document.removeEventListener('keyup', onDocKeyUp, true)
					document.removeEventListener('pointerdown', onDocPointerDown, true)
					releaseAllKeys(); input.remove()
				},
			}
		}

		function createMsePlayer(video: any, generation: any, mime: any, onFailure: any) {
			if (!window.MediaSource || !window.MediaSource.isTypeSupported(mime)) { onFailure('当前浏览器不支持此 H.264 流'); return function () {} }
			var mediaSource = new MediaSource()
			var objectUrl = URL.createObjectURL(mediaSource)
			var abort = new AbortController()
			var sourceBuffer: any = null, queue: any[] = [], queuedBytes = 0, disposed = false, reader: any = null, reading = false
			var MAX_QUEUED_VIDEO_BYTES = 4 * 1024 * 1024
			video.src = objectUrl; video.muted = true; video.autoplay = true; video.playsInline = true
			function appendNext() {
				if (disposed || !sourceBuffer || sourceBuffer.updating || queue.length === 0) return
				var chunk = queue.shift(); queuedBytes -= chunk.byteLength
				try { sourceBuffer.appendBuffer(chunk) } catch (error) { onFailure(error.message) }
			}
			function pump() {
				if (disposed || reading || !reader || queuedBytes >= MAX_QUEUED_VIDEO_BYTES) return
				reading = true
				reader.read().then(function (part: any) {
					reading = false
					if (disposed) return
					if (part.done) { onFailure('视频流已断开'); return }
					queue.push(part.value); queuedBytes += part.value.byteLength; appendNext(); pump()
				}).catch(function (error: any) { reading = false; if (!disposed && error.name !== 'AbortError') onFailure(error.message) })
			}
			mediaSource.addEventListener('sourceopen', function () {
				if (disposed) return
				try { sourceBuffer = mediaSource.addSourceBuffer(mime) } catch (error) { onFailure(error.message); return }
				sourceBuffer.mode = 'segments'
				sourceBuffer.addEventListener('updateend', function () {
					if (video.buffered.length) {
						var end = video.buffered.end(video.buffered.length - 1)
						if (end - video.currentTime > .8) video.currentTime = Math.max(0, end - .15)
						if (!sourceBuffer.updating && video.buffered.start(0) < end - 3) try { sourceBuffer.remove(video.buffered.start(0), end - 2) } catch (e) {}
					}
					appendNext(); pump()
				})
				fetch(VIDEO_ROUTE + '?generation=' + encodeURIComponent(generation), { signal: abort.signal }).then(function (res) {
					if (!res.ok || !res.body) throw new Error('视频流连接失败 (' + res.status + ')')
					reader = res.body.getReader(); pump()
				}).catch(function (error) { if (!disposed && error.name !== 'AbortError') onFailure(error.message) })
			})
			return function () {
				disposed = true; abort.abort(); queue = []; queuedBytes = 0
				try { video.pause(); video.removeAttribute('src'); video.load() } catch (e) {}
				try { URL.revokeObjectURL(objectUrl) } catch (e) {}
			}
		}
		const OPEN_KEY = 'dsh.ego.watch.open'
		// Treat the agent as "active" when any page was touched within this window.
		const ACTIVE_WINDOW_MS = 3000

		const PANEL_CSS = `
/* ---- deep Apple / macOS dark-glass chrome ---- */
:root { --ego-ios-gap: 6px; }

#dsh-ego-fab {
  position: fixed; left: 0; top: 0; z-index: 9999;
  width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.14);
  background: rgba(30,30,32,.72);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  backdrop-filter: blur(22px) saturate(180%);
  color: #f5f5f7; cursor: grab;
  touch-action: none; user-select: none; -webkit-user-select: none;
  box-shadow: 0 10px 30px rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center;
}
#dsh-ego-fab.dsh-ego-dragging { cursor: grabbing; opacity:.85; }
#dsh-ego-fab:hover { transform: scale(1.09); }
#dsh-ego-fab[hidden] { display: none; }
#dsh-ego-fab .dsh-ego-dot {
  position: absolute; top: 1px; right: 1px; width: 11px; height: 11px;
  border-radius: 50%; background: #86868b;
  border: 2px solid rgba(30,30,32,.9);
}
#dsh-ego-fab svg { width: 22px; height: 22px; }
/* FAB status dot: steady green while the agent is driving the browser
   (busy), breathing green when idle (browser open, no recent action). */
#dsh-ego-fab.dsh-ego-live:not(.dsh-ego-busy) .dsh-ego-dot {
  background: #30d158; box-shadow: 0 0 8px #30d158aa;
  animation: dsh-ego-breathe 2.4s ease-in-out infinite;
}
#dsh-ego-fab.dsh-ego-busy .dsh-ego-dot {
  background: #30d158; box-shadow: 0 0 9px #30d158cc; animation: none;
}
@keyframes dsh-ego-breathe {
  0%, 100% { box-shadow: 0 0 2px #30d15822; opacity: .5; }
  50%      { box-shadow: 0 0 11px #30d158ee; opacity: 1; }
}

#dsh-ego-panel {
  position: fixed; left: 0; top: 0; z-index: 9998;
  width: 408px; max-height: 78vh;
  display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 16px;
  background: rgba(28,28,30,.74);
  -webkit-backdrop-filter: blur(26px) saturate(180%);
  backdrop-filter: blur(26px) saturate(180%);
  color: #f5f5f7;
  box-shadow: 0 14px 44px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.08);
  /* Pop-out animation: the panel springs up-left out of the ball's spot.
     transform-origin sits near its bottom-right (closest to the FAB). */
  opacity: 0; pointer-events: none;
  transform-origin: 82% 100%;
  transform: translateY(12px) scale(.88);
  transition: opacity .26s cubic-bezier(.16,.8,.3,1.05),
              transform .26s cubic-bezier(.16,.8,.3,1.15),
              visibility .26s;
  will-change: transform, opacity;
}
#dsh-ego-panel.dsh-ego-panel-open { opacity: 1; pointer-events: auto; transform: none; }
#dsh-ego-panel[hidden] { display: none; }
#dsh-ego-panel.open-drawer { width: 640px; }

/* FAB press / open feedback */
#dsh-ego-fab:active { transform: scale(.95); }
#dsh-ego-fab.dsh-ego-on { transform: scale(1.12); box-shadow: 0 0 0 6px rgba(10,132,255,.22), 0 10px 30px rgba(0,0,0,.5); }
#dsh-ego-fab.dsh-ego-on:hover { transform: scale(1.18); }

/* Drag handles for the panel: its header doubles as a title-bar grip. */
#dsh-ego-head { cursor: grab; }
#dsh-ego-head.dsh-ego-grabbing { cursor: grabbing; }
#dsh-ego-head .dsh-ego-grip {
  flex: none; width: 22px; height: 22px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  color:#86868b; opacity:.8;
}
#dsh-ego-head .dsh-ego-grip svg { width: 13px; height: 13px; }

#dsh-ego-head { display:flex; align-items:center; gap:4px; padding:10px 14px;
  border-bottom:1px solid rgba(255,255,255,.08); }
#dsh-ego-title { flex:1; font-size:13px; font-weight:600; letter-spacing:.2px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:6px; }
#dsh-ego-title svg { width:16px; height:16px; color:#0a84ff; flex-shrink:0; }
#dsh-ego-iconbtn {
  background: transparent; border:none; color: #aeaeb2; cursor: pointer;
  width: 28px; height: 28px; border-radius: 8px; padding: 0;
  display:flex; align-items:center; justify-content:center;
  transition: background .15s ease, color .15s ease;
}
#dsh-ego-iconbtn svg { width: 15px; height: 15px; }
#dsh-ego-iconbtn:hover { background: rgba(255,255,255,.12); color: #f5f5f7; }
#dsh-ego-iconbtn.off { opacity:.5; }
#dsh-ego-iconbtn.spinning svg { animation: dsh-ego-spin .7s linear infinite; }
@keyframes dsh-ego-spin { to { transform: rotate(360deg); } }

#dsh-ego-body { flex:1; overflow-y:auto; padding:12px 14px; min-height:60px; }
.dsh-ego-empty { padding:20px 12px; text-align:center; color:#86868b; font-size:12.5px; line-height:1.7; }
.dsh-ego-off { padding:6px 14px 10px; text-align:center; font-size:11px; color:#6e6e73; }
.dsh-ego-off svg { width:11px; height:11px; vertical-align:-1px; color:#6e6e73; }

/* ---- login guide strip (top of the panel body) ---- */
#dsh-ego-login { display:none; align-items:center; gap:8px; margin:0 14px 9px; padding:7px 10px;
  border-radius:9px; border:1px solid rgba(255,214,10,.28); background: rgba(255,214,10,.09); }
#dsh-ego-login.show { display:flex; }
#dsh-ego-login .dsh-ego-login-txt { flex:1; min-width:0; font-size:11px; line-height:1.45; color:#f5f5f7; }
#dsh-ego-login .dsh-ego-login-txt b { color:#ffd60a; }
#dsh-ego-login .dsh-ego-login-btn { flex:none; background:#0a84ff; color:#fff; border:none; border-radius:8px;
  font-size:11px; padding:4px 10px; cursor:pointer; white-space:nowrap; transition: background .15s ease; }
#dsh-ego-login .dsh-ego-login-btn:hover { background:#338cff; }
#dsh-ego-login .dsh-ego-login-btn.saving { opacity:.55; pointer-events:none; }
#dsh-ego-login .dsh-ego-login-note { flex:none; font-size:10.5px; color:#6e6e73; white-space:nowrap; }
/* dismiss (×) on guide strips so the user can close them and reclaim the space */
.dsh-ego-dismiss { flex:none; width:18px; height:18px; line-height:1; border-radius:50%; border:none;
  background: rgba(255,255,255,.12); color:inherit; font-size:13px; cursor:pointer; opacity:.75;
  display:inline-flex; align-items:center; justify-content:center; padding:0; transition: background .15s,opacity .15s; }
.dsh-ego-dismiss:hover { background: rgba(255,69,58,.35); opacity:1; }
#dsh-ego-login .dsh-ego-dismiss { color:#ffd60a; }
#dsh-ego-captcha .dsh-ego-dismiss { color:#ffd8d5; }

/* ---- human-verification (CAPTCHA) reminder strip ---- */
#dsh-ego-captcha { display:none; align-items:center; gap:8px; margin:0 14px 9px; padding:8px 11px;
  border-radius:9px; border:1px solid rgba(255,69,58,.4); background: rgba(255,69,58,.13); color:#ffe1de; }
#dsh-ego-captcha.show { display:flex; }
#dsh-ego-captcha .dsh-ego-captcha-txt { flex:1; min-width:0; font-size:11.5px; line-height:1.5; }
#dsh-ego-captcha .dsh-ego-captcha-txt b { color:#ff6961; }
#dsh-ego-captcha .dsh-ego-captcha-kind { flex:none; font-size:10px; padding:2px 8px; border-radius:999px;
  background: rgba(255,255,255,.12); color:#ffd8d5; text-transform:uppercase; letter-spacing:.4px; }

/* ---- tab bar: frosted pills ---- */
#dsh-ego-tabs { display:flex; gap:6px; padding:9px 12px;
  border-bottom:1px solid rgba(255,255,255,.08); overflow-x:auto; flex-shrink:0; scrollbar-width:thin; }
#dsh-ego-tabs:empty { display:none; }
.dsh-ego-tab {
  display:inline-flex; align-items:center; gap:6px; max-width:176px; white-space:nowrap;
  padding:5px 12px; border-radius: 999px; cursor:pointer; font-size:11.5px; flex-shrink:0;
  border:1px solid rgba(255,255,255,.1);
  background: rgba(72,72,74,.45); color:#aeaeb2;
  transition: background .15s ease, color .15s ease, border-color .15s ease;
}
.dsh-ego-tab > .dsh-ego-tabtxt { overflow:hidden; text-overflow:ellipsis; }
.dsh-ego-tab:hover { color:#f5f5f7; background: rgba(72,72,74,.65); }
.dsh-ego-tab.active {
  background: #0a84ff; color:#fff; border-color: transparent;
  box-shadow: 0 2px 10px rgba(10,132,255,.35);
}
.dsh-ego-tab .dsh-ego-tabdot { width:7px; height:7px; border-radius:50%; background:#86868b; flex-shrink:0; }
.dsh-ego-tab.active .dsh-ego-tabdot { background:#fff; }
.dsh-ego-tab .dsh-ego-tabclose { flex-shrink:0; width:14px; height:14px; line-height:13px; text-align:center;
  border-radius:50%; font-size:12px; color:#86868b; margin-left:2px; }
.dsh-ego-tab .dsh-ego-tabclose:hover { background:rgba(255,255,255,.2); color:#ff453a; }
.dsh-ego-tab.active .dsh-ego-tabclose { color:rgba(255,255,255,.85); }
.dsh-ego-tab.active .dsh-ego-tabclose:hover { color:#ff453a; background:rgba(255,255,255,.25); }

/* ---- main live view ---- */
.dsh-ego-liveview { display:flex; flex-direction:column; gap:9px; min-height:60px;
  overflow:hidden; /* clips the zoomed image so it doesn't bleed outside */ }
.dsh-ego-livebadge { font-size:11px; color:#86868b; letter-spacing:.3px;
  display:flex; align-items:center; gap:6px; }
.dsh-ego-state-dot { display:inline-block; width:8px; height:8px; border-radius:50%;
  background:#30d158; box-shadow:0 0 6px #30d15888; flex-shrink:0;
  animation: dsh-ego-breathe 2.4s ease-in-out infinite; }
.dsh-ego-state-dot.busy { background:#30d158; box-shadow:0 0 7px #30d158bb; animation:none; }
.dsh-ego-state-dot.pin { background:#0a84ff; box-shadow:0 0 6px #0a84ff88; animation:none; }
.dsh-ego-back {
  background: rgba(255,255,255,.12); color:#f5f5f7;
  border:1px solid rgba(255,255,255,.12); border-radius:7px;
  cursor:pointer; font-size:11px; padding:3px 9px;
  display:inline-flex; align-items:center; gap:4px;
  transition: background .15s ease;
}
.dsh-ego-back:hover { background: rgba(255,255,255,.2); }
.dsh-ego-back.dsh-ego-pick-on { background: rgba(56,189,248,.3); color: #7dd3fc; }
.dsh-ego-liveimg {
  width:100%; border-radius:11px; display:block;
  max-height:50vh; object-fit:contain;
  border:1px solid rgba(255,255,255,.14);
  background:#000; /* letterbox behind landscape jpeg */
  box-shadow: 0 4px 16px rgba(0,0,0,.35);
  user-select:none; -webkit-user-select:none; touch-action:none;
  will-change:transform; cursor:grab;
}
.dsh-ego-zoomhint { font-size:10.5px; color:#6e6e73; letter-spacing:.2px; margin-top:-3px; }
.dsh-ego-livetitle { font-size:13px; font-weight:600; }
.dsh-ego-liveurl { font-size:11.5px; color:#86868b; word-break:break-all; }
.dsh-ego-liveurl.dsh-ego-hint { color:#75c2ff; font-style:italic; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-shadow:0 0 6px rgba(117,194,255,.4); }
.dsh-ego-hint { animation: dsh-ego-hint-in .2s ease; }
@keyframes dsh-ego-hint-in { from { opacity:.3 } to { opacity:1 } }

/* ---- history drawer ---- */
#dsh-ego-history { display:none; flex-direction:column; width:224px; flex-shrink:0;
  border-left:1px solid rgba(255,255,255,.08); background: rgba(0,0,0,.18); }
#dsh-ego-history.open { display:flex; }
#dsh-ego-historyhead { padding:9px 12px; font-size:12px; font-weight:600; color:#86868b;
  display:flex; align-items:center; gap:6px;
  border-bottom:1px solid rgba(255,255,255,.06); }
#dsh-ego-historyhead svg { width:12px; height:12px; }
#dsh-ego-historylist { overflow-y:auto; padding:7px; }
.dsh-ego-hitem { display:flex; gap:8px; align-items:center; padding:6px; border-radius:9px; cursor:pointer;
  transition: background .15s ease; }
.dsh-ego-hitem:hover { background: rgba(255,255,255,.1); }
.dsh-ego-hthumb { width:58px; height:42px; border-radius:6px; object-fit:cover; background:#000;
  flex-shrink:0; border:1px solid rgba(255,255,255,.14); }
.dsh-ego-hinfo { min-width:0; }
.dsh-ego-hurl { font-size:10.5px; color:#86868b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ego-htitle { font-size:10.5px; font-weight:500; color:#f5f5f7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ego-hactive { color:#30d158; font-size:10.5px; }
.dsh-ego-hnone { padding:16px 8px; text-align:center; font-size:11px; color:#6e6e73; }

#dsh-ego-cols { display:flex; flex:1; min-height:0; }
.dsh-ego-maincol { flex:1; min-width:0; display:flex; flex-direction:column; }
`;

		// ── SF-Symbols-style linear icons (inline SVG, zero deps) ──
		// Each icon carries explicit width/height (scaled from a 24 viewBox)
		// so it renders at a sane size even if no CSS rule targets it.
		const ICON_GLOBE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21"/><path d="M12 3C9.5 5.4 8.2 8.4 8.2 12s1.3 6.6 3.8 9"/><path d="M3 12h18"/></svg>`;
		const ICON_REFRESH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4.5V9h-4.5"/></svg>`;
		const ICON_CLOCK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>`;
		const ICON_CLOSE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
		// 6-dot drag grip for the panel's title bar.
		const ICON_GRIP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.8"/><circle cx="16" cy="6" r="1.8"/><circle cx="8" cy="12" r="1.8"/><circle cx="16" cy="12" r="1.8"/><circle cx="8" cy="18" r="1.8"/><circle cx="16" cy="18" r="1.8"/></svg>`;

		// ── 设置卡双轨数据源的桥轨（session-guard BridgeDocHandle 同式收缩版）──
		// ≤0.1.5 宿主无 configForms 服务（代际切分：configForms 属 rc.1+ 代），
		// 卡的原生数据臂坐死 → 改走自家 webServer 桥 describe/mutate 读写宿主
		// settings 服务。快照形状对齐原生 scope（value/writable 两字段卡面消费）；
		// 路由与 server 侧 registerSettingsBridge（src/settings.ts）逐字符一致。
		var BRIDGE_ROUTES = { describe: '/api/dsh-browser-cdp/settings/describe', mutate: '/api/dsh-browser-cdp/settings/mutate' }

		// ≤0.1.5 describe 的 descriptor.value 是「每字段 → {}」骨架（真值拆在
		// base+user 两层）——命中即以 {...base, ...user} 重组（本卡字段全是
		// 顶层标量/数组，浅合并即语义；session-guard isFieldSkeleton 同款）。
		function bridgeDescriptorPlainValue(d: any) {
			var v = d && d.value
			if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
				var values = Object.keys(v)
				var skeleton = values.length > 0 && values.every(function (k) {
					var x = v[k]
					return x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0
				})
				if (skeleton) {
					var merged: any = {}
					var pull = function (layer: any) {
						if (layer !== null && typeof layer === 'object' && !Array.isArray(layer)) {
							for (var k in layer) merged[k] = layer[k]
						}
					}
					pull(d.base)
					pull(d.user)
					return merged
				}
			}
			return v
		}

		function makeBridgeScope() {
			var listeners: any[] = []
			var snapshot: any = { status: 'loading', value: undefined, writable: true, mode: 'bridge' }
			var revision: any = undefined
			var retriesLeft = 4
			var inflight: any = undefined
			function notify() { for (var i = 0; i < listeners.length; i++) listeners[i]() }
			function applyDescriptor(d: any, writable: boolean) {
				revision = typeof d.revision === 'number' ? d.revision : undefined
				snapshot = { status: 'ready', value: bridgeDescriptorPlainValue(d), writable: writable, mode: 'bridge' }
			}
			function request(path: string, body: any) {
				return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
					.then(function (r) {
						if (!r.ok) throw new Error('bridge ' + path + ' HTTP ' + r.status)
						return r.json()
					})
			}
			function retryOrFail() {
				if (retriesLeft > 0) {
					retriesLeft -= 1
					inflight = undefined
					setTimeout(function () { void refresh() }, 1500)
					return true
				}
				snapshot = { status: 'unavailable', value: undefined, writable: false, mode: 'bridge' }
				return false
			}
			function refresh(): any {
				if (inflight !== undefined) return inflight
				inflight = request(BRIDGE_ROUTES.describe, {}).then(function (body: any) {
					if (body && body.ok && body.value && body.value.descriptor !== undefined) {
						retriesLeft = 4
						applyDescriptor(body.value.descriptor, body.value.writable !== false)
					} else if (!(body && body.code && (body.code === 'settings-unavailable' || body.code === 'ns-not-registered') && retryOrFail())) {
						snapshot = { status: 'unavailable', value: undefined, writable: false, mode: 'bridge' }
					}
					inflight = undefined
					notify()
				}, function () {
					retryOrFail() // 网络异常按瞬态处理；预算耗尽落终态
					inflight = undefined
					notify()
				})
				return inflight
			}
			void refresh()
			return {
				subscribe: function (listener: any) {
					listeners.push(listener)
					return function () {
						var i = listeners.indexOf(listener)
						if (i >= 0) listeners.splice(i, 1)
					}
				},
				getSnapshot: function () { return snapshot },
				set: function (field: string, value: any): Promise<boolean> {
					return request(BRIDGE_ROUTES.mutate, { ops: [{ op: 'set', path: [field], value: value }], expectedRevision: revision })
						.then(function (body: any) {
							if (body && body.ok && body.value && body.value.descriptor !== undefined) {
								applyDescriptor(body.value.descriptor, snapshot.writable)
								notify()
								return true
							}
							// 拒写（revision 冲突 / 宿主瞬态错 / 非法值）时不能直接返回 false：
							// 上层重试带的是 `revision`，它还是陈的。先把 describe 等到底
							// （拿到新 revision 与宿主真值）再交回失败，重试才有意义。
							return Promise.resolve(refresh()).then(function () { return false }, function () { return false })
						}, function () {
							// 网络异常同路：重读后报失败，交给上层重试预算
							return Promise.resolve(refresh()).then(function () { return false }, function () { return false })
						})
				},
			}
		}

		// 所有字段写入走 ./fam-write 的 commitField：带 revision、被拒（并发编辑
		// 冲突或瞬态故障）则有限次重试，预算用尽报 false 给调用方回滚乐观态。
		// 桥轨的 set 在返回 false 前已经把 describe 等到底，所以重试带的是新 revision。

		// ── 插件族共用设置 tab（「起子插件设置」）──────────────────────────
		// dsh-thinking-levels 的顶级 settings.section 声明 `dsh-family.tab` 子席位；
		// 本卡全量渲染 Config 的用户可调 volatile 字段（分组 + links 连接目标）。
		// 数据臂双轨：rc.1+ 用 configForms 原生句柄（快照身份稳定）；≤0.1.5 无
		// configForms 服务 → 落 webServer 桥轨。thinking-levels 缺席时 inject
		// 静默等待，不阻塞客户端半。
		function mountFamilySettingsCard(ctx: any) {
			var forms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
			var scope = forms && typeof forms.get === 'function' ? forms.get('dsh-browser-cdp') : undefined
			if (!scope) scope = makeBridgeScope()
			// 贡献卡注册（apply 顶层）：scope 已有 configForms/桥 两轨兜底，恒非空。
			ctx.slots.inject('dsh-family.tab', function () {
				return ctx.slots.register({
					name: 'dsh-family.tab',
					id: 'dsh-browser-cdp',
					order: 35,
					label: function () { return wt('famTitle') },
					inject: function () { return { scope: scope } },
				}, FamilySettingsCard)
			}, 'dsh-browser-cdp: family settings tab')
			// 家族容器兜底：thinking-levels/guard/steward/mcp 全部让位或声明失败时，
			// 上面的 inject 会静默等待——本卡整轮启动不可见且不报错。到分级时刻自己上位。
			// declare-or-withdraw：声明失败就放弃，绝不裸注册不带 children 的残废节。
			var claim = claimFamilyHostIfOrphaned(
				ctx.slots,
				function () {
					try {
						return ctx.slots.entries('settings.section')
							.some(function (e: any) { return String((e && e.options && e.options.id) || '') === 'dsh-family' })
					} catch { return false }
				},
				function () { return '起子插件设置' },
				'[dsh-browser-cdp]',
				// 接管态内联直挂本卡：own 卡组件 + 现取 scope（configForms/桥 两轨兜底，非空白）。
				{ id: 'dsh-browser-cdp', component: FamilySettingsCard, inject: function () { return { scope: scope } } },
			)
			if (typeof ctx.effect === 'function') ctx.effect(function () { return claim }, 'dsh-browser-cdp: family host backstop')
		}

		// ── 插件详情页设置卡（plugins.bundle.config keyed 席位）─────────────
		// thinking-levels b660785 同款双挂载：同一张 FamilySettingsCard、同一个
		// scope——family tab 之外，插件详情页的 keyed 席位（按包名分发）是独立
		// 设置入口；不装 thinking-levels 时 family tab 的 inject 静默等待、本卡
		// 无处出现，这个面就是唯一设置入口。0.1.7 / 0.2.0 宿主均声明该席位；
		// 未声明它的宿主上 inject 空转不阻塞客户端半。卡是叶子组件（不消费
		// renderSlot），无需 b660785 的缺席守卫。
		function mountPluginsPageCard(ctx: any) {
			var forms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
			var scope = forms && typeof forms.get === 'function' ? forms.get('dsh-browser-cdp') : undefined
			if (!scope) scope = makeBridgeScope()
			ctx.slots.inject('plugins.bundle.config', function () {
				return ctx.slots.register({
					name: 'plugins.bundle.config',
					key: 'dsh-browser-cdp',
					inject: function () { return { scope: scope } },
				}, FamilySettingsCard)
			}, 'dsh-browser-cdp: plugins-page config card')
		}

		// 全量设置面：Config 里所有用户可调 volatile 字段按组分块渲染。
		// kind: bool=checkbox / num=数字 / str=文本 / secret=密码 / sel=下拉。
		// 文案直接内联 en/zh（跟随 wt 的 _egoLocale），不再膨胀字典键。
		var FAM_FIELD_GROUPS = [
			// 工具封印：放在最前（与 prime-memory 的「工具封印」节同一位置）——
			// 它是“今天这个会话能看到多少个工具”的唯一开关面。
			{ gk: 'gTools', en: 'Tool sealing', zh: '工具封印', fields: [
				{ k: 'toolInjection', kind: 'sel', options: ['lazy', 'always'], en: ['Injection mode', 'lazy (default) = only bcdp_status stays resident — it is the unlock entry, and the rest are injected after the first bcdp_* call and sealed back on idle reaping. always = every tool registered at mount (historical)'], zh: ['工具注入模式', 'lazy（默认）= 只常驻 bcdp_status（它是解锁入口），其余在首次 bcdp_* 调用后铺开、闲置回收时收回；always = 挂载即注册全部（历史行为）'] },
				{ k: 'toolBrowse', kind: 'bool', en: ['Basic browsing tools (19)', 'On (default) = released in three waves after browser activity (act → observe → wait); off = 19 tools removed from the model tool list (space / navigate / click / fill / key / drag / screenshot / read / help / doctor / wait ...)'], zh: ['基础操作工具（19 个）', '开（默认）= 浏览器活动后按 act → observe → wait 三波放行；关 = 19 个工具从模型工具列表移除（空间/导航/点击/填写/键鼠/拖拽/截图/读取/指南/预检/等待…）'] },
				{ k: 'toolExtended', kind: 'bool', en: ['Extended tools (8)', 'On (default) = registered after browser activity; off = 8 tools removed (raw CDP / http / upload / download / dialog / captcha / auth flush / login import)'], zh: ['扩展能力工具（8 个）', '开（默认）= 浏览器活动后注册；关 = 8 个工具移除（裸 CDP/HTTP/上传/下载/对话框/验证码/登录落盘/登录导入）'] },
				{ k: 'toolEscape', kind: 'bool', en: ['Escape hatch (1: script)', 'Sealed until browser activity, like every other non-core tier — call bcdp_status first and it appears. Off = sealed'], zh: ['逃生舱（1 个：script）', '与其它非 core 档一样等浏览器活动（1.7.0 起不再有「始终可达」豁免）：先调 bcdp_status 即可拿到。关 = 封印'] },
				{ k: 'toolJudge', kind: 'bool', en: ['Judgement tools bcdp_jev_* (5)', 'On still requires a JEV or Laya key — without one they can only answer "not configured", so they stay sealed anyway'], zh: ['评审工具 bcdp_jev_*（5 个）', '开仍需配了 JEV/Laya Key；没 Key 它们本来也只能回答「未配置」，依旧不注入'] },
				{ k: 'sessionScopedPulse', kind: 'bool', en: ['Per-session unlock', 'On (default) = each session must call bcdp_status independently; one session\'s unlock does not affect others. Off = process-wide (any unlock affects all sessions, historical)'], zh: ['按会话隔离解锁', '开（默认）= 每个会话各自调 bcdp_status 解锁，不互相影响；关 = 进程级共享（任一会话解锁对所有会话生效，历史行为）'] },
			] },
			{ gk: 'gBasic', en: 'Basics', zh: '基础', fields: [
				{ k: 'isolateSpaces', kind: 'bool', en: ['Space isolation', 'Off = persistent profile (logins survive restarts); on = isolated sandbox'], zh: ['空间隔离', '关 = 持久化配置（重启保留登录态）；开 = 每次隔离沙箱'] },
				{ k: 'idleTimeoutMin', kind: 'num', min: 0, max: 1440, step: 1, en: ['Auto-stop idle browser (minutes, 0 = off)', 'Stops the backing browser after N minutes without a bcdp_* call; relaunches on demand'], zh: ['空闲自动停止（分钟，0 = 不停）', '超过 N 分钟没有 bcdp_* 调用即停止后台浏览器，下次调用按需重启'] },
				{ k: 'cdpMode', kind: 'sel', options: ['auto', 'local', 'remote'], en: ['Connection mode', 'auto = activated target only; remote = never start a local browser; local = always local control'], zh: ['连接模式', 'auto = 只用已激活目标；remote = 绝不静默启动本地浏览器；local = 始终本地控制'] },
				{ k: 'remoteEnabled', kind: 'bool', en: ['Remote attach master switch', 'Off = the target sequence is preserved but inert; does not affect local mode'], zh: ['远程接管总开关', '关 = 目标序列保留但不生效；不影响 local 模式'] },
				{ k: 'allowLocalFallback', kind: 'bool', en: ['Allow local fallback in auto mode', 'auto may launch a local browser when the activated target is unreachable'], zh: ['auto 模式允许本地回退', '已激活目标不可达时允许自动拉起本地浏览器'] },
				{ k: 'allowProbeColdStart', kind: 'bool', en: ['Allow the probe to launch the browser', 'Off (default) = the ego-cli readiness probe never launches the browser: when --status cannot prove it is already up, the heredoc check is skipped and the browser starts on the first real bcdp_* call (no browser window at plugin startup). On = the probe verifies the SDK harness at startup, which may open the browser window'], zh: ['探测允许拉起浏览器', '关（默认）= ego-cli 就绪探测绝不拉起 ego 浏览器：--status 证明浏览器已在跑才做 heredoc 验证，否则跳过，浏览器推迟到首个真实 bcdp_* 调用才启动（插件启动不再弹浏览器窗口）；开 = 挂载时预先验证 SDK harness，可能当场弹出浏览器窗口'] },
				{ k: 'chromePath', kind: 'str', en: ['Chrome/Chromium path', 'Empty = auto-detect'], zh: ['Chrome/Chromium 路径', '留空 = 自动探测'] },
				{ k: 'localHeadless', kind: 'bool', en: ['Launch local browser headless', 'Applies to the locally launched browser'], zh: ['本地浏览器无头启动', '仅作用于本地拉起的浏览器'] },
				{ k: 'localUserDataDir', kind: 'str', en: ['Local profile dir', 'Empty = managed dir; never point at your daily Chrome profile'], zh: ['本地浏览器 Profile 目录', '留空 = 托管目录；不要指向日常使用的 Chrome 配置'] },
				{ k: 'legacyEgoToolNames', kind: 'bool', en: ['Also register legacy ego_* tool names', 'For scripts written before the bcdp_* rename; conflicts with the upstream ego-browser plugin'], zh: ['同时注册旧版 ego_* 工具名', '给 bcdp_* 更名前的脚本用；与上游 ego-browser 插件互斥'] },
			] },
			{ gk: 'gCapture', en: 'Capture & streaming', zh: '截图与推流', fields: [
				{ k: 'captureBackend', kind: 'sel', options: ['auto', 'cdp', 'ffmpeg'], en: ['Capture backend', 'auto, cdp, or ffmpeg'], zh: ['截取后端', 'auto / cdp / ffmpeg'] },
				{ k: 'streamProfile', kind: 'sel', options: ['low', 'balanced', 'high'], en: ['Capture quality profile', 'Overall quality preset'], zh: ['画质档位', '整体画质预设'] },
				{ k: 'cdpFps', kind: 'num', min: 5, max: 30, step: 1, en: ['CDP preview FPS', ''], zh: ['CDP 预览帧率', ''] },
				{ k: 'cdpQuality', kind: 'num', min: 1, max: 100, step: 1, en: ['CDP JPEG quality', ''], zh: ['CDP JPEG 质量', ''] },
				{ k: 'cdpMaxWidth', kind: 'num', min: 320, max: 1920, step: 40, en: ['CDP frame max width', ''], zh: ['CDP 帧最大宽度', ''] },
				{ k: 'cdpBackstopIntervalMs', kind: 'num', min: 1000, max: 10000, step: 100, en: ['CDP recovery interval (ms)', ''], zh: ['CDP 恢复截图间隔（ms）', ''] },
				{ k: 'ffmpegFps', kind: 'num', min: 5, max: 30, step: 1, en: ['FFmpeg video FPS', ''], zh: ['FFmpeg 视频帧率', ''] },
				{ k: 'ffmpegMaxWidth', kind: 'num', min: 320, max: 1920, step: 40, en: ['FFmpeg max width', ''], zh: ['FFmpeg 最大宽度', ''] },
				{ k: 'ffmpegBitrateKbps', kind: 'num', min: 500, max: 20000, step: 250, en: ['FFmpeg bitrate (kbps)', ''], zh: ['FFmpeg 码率（kbps）', ''] },
				{ k: 'ffmpegEncoder', kind: 'sel', options: ['auto', 'software', 'h264_mf', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'h264_vaapi'], en: ['FFmpeg H.264 encoder', ''], zh: ['FFmpeg H.264 编码器', ''] },
				{ k: 'ffmpegPath', kind: 'str', en: ['FFmpeg path', 'Empty = detect PATH or managed install'], zh: ['FFmpeg 路径', '留空 = 探测 PATH 或托管安装'] },
				{ k: 'cursorHud', kind: 'bool', en: ['Draw cursor HUD into screenshots', ''], zh: ['截图绘制光标 HUD', ''] },
				{ k: 'cursorName', kind: 'str', en: ['Cursor HUD label', ''], zh: ['光标 HUD 名称', ''] },
				{ k: 'githubMirror', kind: 'str', en: ['GitHub download mirror', 'HTTPS base replacing https://github.com for managed downloads'], zh: ['GitHub 下载镜像', '托管下载时替换 https://github.com 的 HTTPS 前缀'] },
				{ k: 'runtimeArgs', kind: 'str', en: ['Extra runtime args', 'Appended to the vendored runtime argv; next bcdp_* call'], zh: ['运行时附加参数', '追加到托管运行时 argv；下次 bcdp_* 调用生效'] },
				{ k: 'chromeArgs', kind: 'str', en: ['Extra Chrome args', 'Appended to the Chrome launch argv; next cold start'], zh: ['Chrome 附加启动参数', '追加到 Chrome 启动 argv；下次冷启动生效'] },
			] },
			{ gk: 'gJudge', en: 'Judgement (JEV / Laya)', zh: '评审（JEV / Laya）', fields: [
				{ k: 'judgePrefer', kind: 'str', en: ['Judge hop order', 'Comma separated; defaults to "laya,rule"'], zh: ['评审跳序', '逗号分隔；默认 "laya,rule"'] },
				{ k: 'jevUrl', kind: 'str', en: ['JEV base URL', 'Leave empty to skip the jev hop'], zh: ['JEV 基础 URL', '留空 = 跳过 jev 跳'] },
				{ k: 'jevKey', kind: 'secret', en: ['JEV bearer key', 'Empty = the jev hop is skipped'], zh: ['JEV Bearer Key', '留空 = 跳过 jev 跳'] },
				{ k: 'jevModel', kind: 'str', en: ['JEV model', ''], zh: ['JEV 模型名', ''] },
				{ k: 'jevChunkSize', kind: 'num', min: 1, max: 255, step: 1, en: ['JEV candidates per round', ''], zh: ['JEV 每轮候选上限', ''] },
				{ k: 'jevMaxImageBytes', kind: 'num', min: 0, step: 1024, en: ['JEV frame byte budget (0 = unbounded)', ''], zh: ['JEV 单帧字节预算（0 = 不限）', ''] },
				{ k: 'jevHistoryLimit', kind: 'num', min: 0, max: 20, step: 1, en: ['JEV recent-step window', ''], zh: ['JEV 近期步数窗口', ''] },
				{ k: 'jevArchiveImage', kind: 'bool', en: ['Embed screenshot in archived bundle', ''], zh: ['归档包内嵌截图', ''] },
				{ k: 'jevEvaluate', kind: 'bool', en: ['Evaluate every action with the judge', 'Costs one judgement call per action'], zh: ['每步动作都过评审', '每步多花一次评审调用'] },
				{ k: 'jevStepBudget', kind: 'num', min: 1, max: 200, step: 1, en: ['Rounds per bcdp_jev_run', ''], zh: ['单次 bcdp_jev_run 轮数上限', ''] },
				{ k: 'jevWallMs', kind: 'num', min: 1000, max: 3600000, step: 1000, en: ['Wall-clock ceiling per run (ms)', ''], zh: ['单次运行墙钟上限（ms）', ''] },
				{ k: 'layaUrl', kind: 'str', en: ['Laya base URL', 'The sidecar serves 8000'], zh: ['Laya 基础 URL', 'sidecar 服务 8000 端口'] },
				{ k: 'layaKey', kind: 'secret', en: ['Laya key (required)', 'Keyless calls are a guaranteed 401'], zh: ['Laya Key（必填）', '无 Key 必然 401'] },
				{ k: 'layaModel', kind: 'str', en: ['Laya model', ''], zh: ['Laya 模型名', ''] },
			] },
		]

		// 文案助手：组标题/字段标题与描述（en 兜底，与 wt 同一 locale 源）。
		function famText(item: any, kind: any) {
			var pair = _egoLocale === 'zh' ? item.zh : item.en
			if (kind === 'title') return pair[0]
			return pair[1] || ''
		}

		function FamilySettingsCard(props: any) {
			var scope = props.scope
			var snapshot = React.useSyncExternalStore(
				function (listener: any) { return scope.subscribe(listener) },
				function () { return scope.getSnapshot() }
			)
			var value = snapshot.value || {}
			var writable = snapshot.writable === true
			var h = React.createElement
			return h('div', { style: { display: 'grid', gap: '8px' } },
				FAM_FIELD_GROUPS.map(function (group) {
					return h(FamGroup, { key: group.gk, group: group, value: value, writable: writable, scope: scope })
				}),
				h(FamLinks, { key: 'links', value: value, writable: writable, scope: scope }),
			)
		}

		function FamGroup(props: any) {
			var group = props.group
			var h = React.createElement
			return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))', paddingTop: '6px' } },
				h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))', padding: '2px 0 4px' } },
					_egoLocale === 'zh' ? group.zh : group.en),
				group.fields.map(function (f: any) { return h(FamField, { key: f.k, f: f, group: group, ...props }) })
			)
		}

		function FamField(props: any) {
			var f = props.f
			var value = props.value
			var writable = props.writable
			var scope = props.scope
			var h = React.createElement
			var rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '6px 0' }
			var textCol = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }
			var titleStyle = { fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' }
			var descStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))', lineHeight: 1.5 }
			var label = h('div', { style: textCol },
				h('span', { style: titleStyle }, famText(f, 'title')),
				f.desc === false || !famText(f, 'desc') ? null : h('span', { style: descStyle }, famText(f, 'desc')))
			if (f.kind === 'bool') {
				return h(FamBoolRow, { f: f, value: value, writable: writable, scope: scope })
			}
			if (f.kind === 'num') {
				return h('div', { style: rowStyle }, label,
					h(FamNumInput, { f: f, v: value[f.k], writable: writable, scope: scope }))
			}
			if (f.kind === 'sel') {
				return h('div', { style: rowStyle }, label,
					h('select', { value: String(value[f.k] ?? f.options[0]), disabled: !writable,
						style: { font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', borderRadius: '8px', padding: '4px 8px' },
						onChange: function (e: any) { void commitField(scope, f.k, e.target.value) } },
						f.options.map(function (o: any) { return h('option', { key: o, value: o }, o) })))
			}
			// str / secret：文本行（宽度占满，失焦提交）
			return h('div', { style: { display: 'grid', gap: '2px', padding: '6px 0' } }, label,
				h(FamStrInput, { f: f, v: value[f.k], writable: writable, scope: scope }))
		}

		// 胶囊开关。宿主没有可借的共享 switch 组件（自动表单页是另一套 DOM），所以按
		// --dsw-alias 令牌自绘：用原生 <button role="switch"> 自带聚焦与回车/空格，
		// 不重造键盘轮子；尺寸固定 38×22、旋钮 18px，border-box 下位移 16px 刚好贴右。
		function FamSwitch(props: any) {
			var h = React.createElement
			var on = props.checked === true
			var busy = props.busy === true
			var disabled = props.writable !== true || busy
			return h('button', {
				type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': props.ariaLabel || '',
				disabled: disabled, title: props.title || '',
				style: {
					flex: '0 0 auto', width: '38px', height: '22px', padding: 0, boxSizing: 'border-box',
					position: 'relative', cursor: disabled ? 'default' : 'pointer',
					borderRadius: '999px', border: '1px solid transparent',
					background: on ? 'var(--dsw-alias-bg-brand, #3a76f0)' : 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.28))',
					opacity: busy ? 0.55 : 1, transition: 'background .16s ease, opacity .16s ease',
				},
				onClick: function () { props.onToggle(!on) },
			}, h('span', {
				style: {
					position: 'absolute', top: '1px', left: '1px', width: '18px', height: '18px',
					borderRadius: '999px', boxSizing: 'border-box',
					background: 'var(--dsw-alias-label-inverse, #fff)', boxShadow: '0 1px 2px rgba(0,0,0,.35)',
					transform: on ? 'translateX(16px)' : 'translateX(0)', transition: 'transform .16s ease',
				},
			}))
		}

		// 布尔行 = 乐观态 + 胶囊开关 + 失败回滚。
		// 点下去先本地翻转（pending），提交走 commitField（带重试）；宿主快照追上来
		// 就清掉 pending，重试预算用尽则回滚到宿主真值并亮一行提示——开关停在“看起
		// 来改了其实没改”是最坑的状态，宁可弹回去并说一一声。
		function FamBoolRow(props: any) {
			var f = props.f
			var scope = props.scope
			var writable = props.writable
			var h = React.createElement
			var host = props.value[f.k] === true
			var pendingState = React.useState(undefined)
			var pending = pendingState[0], setPending = pendingState[1]
			var errState = React.useState(false)
			var failed = errState[0], setFailed = errState[1]
			React.useEffect(function () {
				if (pending !== undefined && props.value[f.k] === pending) setPending(undefined)
			}, [props.value[f.k]])
			var shown = pending === undefined ? host : pending === true
			var rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '6px 0' }
			var textCol = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }
			var titleStyle = { fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' }
			var descStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))', lineHeight: 1.5 }
			function toggle(next: boolean) {
				if (writable !== true || pending !== undefined) return
				setFailed(false)
				setPending(next)
				void commitField(scope, f.k, next).then(function (ok: any) {
					if (ok === true) return
					setPending(undefined)
					setFailed(true)
				})
			}
			return h('div', { style: { display: 'grid', gap: '2px' } },
				h('div', { style: rowStyle },
					h('div', { style: textCol },
						h('span', { style: titleStyle }, famText(f, 'title')),
						f.desc === false || !famText(f, 'desc') ? null : h('span', { style: descStyle }, famText(f, 'desc'))),
					h(FamSwitch, {
						checked: shown, busy: pending !== undefined, writable: writable,
						ariaLabel: famText(f, 'title'), onToggle: toggle,
					})),
				failed ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-text-danger, #e5534b)' } },
					_egoLocale === 'zh' ? '保存未成功（已重试），开关已回到宿主当前值。' : 'Save failed after retries; the switch is back to the host value.') : null,
			)
		}

		function FamNumInput(props: any) {
			var f = props.f
			var h = React.createElement
			var draft = React.useState(props.v === undefined || props.v === null ? '' : String(props.v))
			var v = draft[0], setV = draft[1]
			React.useEffect(function () { setV(props.v === undefined || props.v === null ? '' : String(props.v)) }, [props.v])
			return h('input', { type: 'number', min: f.min, max: f.max, step: f.step, value: v, disabled: !props.writable,
				style: { width: '96px', font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', borderRadius: '8px', padding: '4px 8px' },
				onChange: function (e: any) { setV(e.target.value) },
				onBlur: function () {
					if (v === '') return
					var n = Number(v)
					if (!isFinite(n)) return
					n = Math.round(n / (f.step || 1)) * (f.step || 1)
					if (f.min !== undefined) n = Math.max(f.min, n)
					if (f.max !== undefined) n = Math.min(f.max, n)
					void commitField(props.scope, f.k, n)
				} })
		}

		function FamStrInput(props: any) {
			var f = props.f
			var h = React.createElement
			var draft = React.useState(props.v === undefined || props.v === null ? '' : String(props.v))
			var v = draft[0], setV = draft[1]
			React.useEffect(function () { setV(props.v === undefined || props.v === null ? '' : String(props.v)) }, [props.v])
			return h('input', { type: f.kind === 'secret' ? 'password' : 'text', value: v, disabled: !props.writable,
				style: { width: '100%', font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', borderRadius: '8px', padding: '5px 10px', boxSizing: 'border-box' },
				onChange: function (e: any) { setV(e.target.value) },
				onBlur: function () { void commitField(props.scope, f.k, v) },
				onKeyDown: function (e: any) { if (e.key === 'Enter') { void commitField(props.scope, f.k, v) } } })
		}

		// 连接目标（links）：按行渲染启用开关 + 激活按钮（写 activeTargetId）。
		// 行内单字段的就位编辑：FamStrInput 的行级变体——本地草稿 + onBlur/Enter
		// 提交（每次整组 set 都是宿主一次 patch 落盘，禁止每键提交），提交走
		// onCommit 回调而非顶层字段。
		function FamRowInput(props: any) {
			var h = React.createElement
			var empty = props.v === undefined || props.v === null ? '' : String(props.v)
			var draft = React.useState(empty)
			var v = draft[0], setV = draft[1]
			React.useEffect(function () { setV(props.v === undefined || props.v === null ? '' : String(props.v)) }, [props.v])
			function commit() { if (v !== empty) props.onCommit(v) }
			return h('input', { type: 'text', value: v, disabled: !props.writable, placeholder: props.placeholder || '',
				style: { flex: '1 1 140px', minWidth: 0, font: 'inherit', fontSize: '12px', color: 'inherit', background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', borderRadius: '8px', padding: '3px 8px' },
				onChange: function (e: any) { setV(e.target.value) },
				onBlur: commit,
				onKeyDown: function (e: any) { if (e.key === 'Enter') { commit() } } })
		}

		// 连接目标（links）v2：启用 / 激活 / 就位编辑 / 探测 / 增删 / 排序。
		// 写回只有一条通道：整组 commitField(scope, 'links', next)（行级 volatile 写不存在），
		// 每个离散动作恰好一次 set。守卫规则在 ./fam-links（与宿主 sanitize/upsert
		// 同构）：ego-cli 单例、MAX_LINKS 上限、endpoint 轻校验——空/非法端点行能过
		// 设置写入，却会在宿主下次 resolve 时被 coerceLink 静默丢弃，必须写前挡住。
		function FamLinks(props: any) {
			var value = props.value
			var writable = props.writable
			var scope = props.scope
			var h = React.createElement
			var links = Array.isArray(value.links) ? value.links : []
			var activeId = typeof value.activeTargetId === 'string' ? value.activeTargetId : ''
			var cdpMode = typeof value.cdpMode === 'string' ? value.cdpMode : 'auto'

			var errState = React.useState('')
			var errText = errState[0], setErrText = errState[1]
			var probeState = React.useState('')
			var probingId = probeState[0], setProbingId = probeState[1]
			var addLabelState = React.useState('')
			var addLabel = addLabelState[0], setAddLabel = addLabelState[1]
			var addEndpointState = React.useState('')
			var addEndpoint = addEndpointState[0], setAddEndpoint = addEndpointState[1]
			var addCliPathState = React.useState('')
			var addCliPath = addCliPathState[0], setAddCliPath = addCliPathState[1]
			var addLpPathState = React.useState('')
			var addLpPath = addLpPathState[0], setAddLpPath = addLpPathState[1]

			var btnStyle = { font: 'inherit', fontSize: '12px', cursor: writable ? 'pointer' : 'not-allowed', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', background: 'none', color: 'var(--dsw-alias-label-primary, inherit)', borderRadius: '8px', padding: '2px 8px', flex: '0 0 auto' }
			var badgeStyle = { fontSize: '10px', fontWeight: 600, letterSpacing: '.04em', flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.7))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))', borderRadius: '6px', padding: '0 5px', lineHeight: '16px' }
			var inputStyle = { font: 'inherit', fontSize: '12px', color: 'inherit', background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', borderRadius: '8px', padding: '3px 8px' }

			function writeLinks(next: any) {
				commitField(scope, 'links', next).then(function (ok: any) {
					if (ok === false) setErrText(wt('linksWriteFailed'))
				}, function () { setErrText(wt('linksWriteFailed')) })
			}
			function limitText() { return wt('linksLimitReached', { n: MAX_LINKS }) }
			function addCdp() {
				if (!isValidEndpoint(addEndpoint)) { setErrText(wt('linksEndpointInvalid')); return }
				var res = addRow(links, buildCdpRow({ label: addLabel, endpoint: addEndpoint }))
				if (res.code) { setErrText(res.code === 'link-limit-reached' ? limitText() : wt('linksEndpointInvalid')); return }
				writeLinks(res.links)
				if (activeId === '') {
					// 空序列的第一个目标入列即激活（无歧义）；后续行保持不自动激活。
					void commitField(scope, 'activeTargetId', res.links[res.links.length - 1].id)
				}
				setAddLabel(''); setAddEndpoint(''); setErrText('')
			}
			function addCli() {
				var res = addRow(links, buildCliRow({ label: '', cliPath: addCliPath }))
				if (res.code) { setErrText(res.code === 'link-limit-reached' ? limitText() : wt('linksAddCliExists')); return }
				writeLinks(res.links)
				if (activeId === '') {
					// 空序列的第一个目标入列即激活（无歧义）；后续行保持不自动激活。
					void commitField(scope, 'activeTargetId', res.links[res.links.length - 1].id)
				}
				setAddCliPath(''); setErrText('')
			}
			function addLp() {
				var res = addRow(links, buildLpRow({ label: '', servePath: addLpPath }))
				if (res.code) { setErrText(res.code === 'link-limit-reached' ? limitText() : wt('linksAddLpExists')); return }
				writeLinks(res.links)
				if (activeId === '') {
					// 空序列的第一个目标入列即激活（无歧义）；后续行保持不自动激活。
					void commitField(scope, 'activeTargetId', res.links[res.links.length - 1].id)
				}
				setAddLpPath(''); setErrText('')
			}
			function removeOne(row: any) {
				var res = removeRow(links, row.id)
				writeLinks(res.links)
				// 删激活行 = 清空激活，不顺延（先 links 后 activeId；两次触发被
				// 宿主 inFlight/pending 合并，瞬态悬挂无害）。
				if (res.removed && res.removed.id !== undefined && res.removed.id === activeId) {
					void commitField(scope, 'activeTargetId', '')
				}
			}
			function probeOne(row: any) {
				if (probingId !== '' || !isValidEndpoint(row.endpoint)) return
				setProbingId(row.id); setErrText('')
				postJson('/bcdp/api/cdp-probe', { endpoint: row.endpoint })
					.then(function (data: any) {
						var outcome = data && data.value && data.value.outcome
							? data.value.outcome
							: { ok: false, code: 'probe-failed', message: 'no outcome' }
						// Lightpanda backend — persist the recognized engine with the probe state.
						if (outcome && outcome.engine === undefined && outcome.ok === true) outcome.engine = 'chrome'
						writeLinks(applyProbe(links, row.id, outcome, Date.now()))
					})
					.catch(function (error: any) {
						writeLinks(applyProbe(links, row.id, { ok: false, code: 'probe-failed', message: String((error && error.message) || error) }, Date.now()))
					})
					.then(function () { setProbingId('') })
			}
			// 受管本机浏览器固定行（LOCAL）：显性化本地唤起——激活 = cdpMode=local，
			// 勾选 = allowLocalFallback（auto 回落许可）。固定列在序列末尾，不可
			// 删除/排序，也无探测（本地未启动就没有端点）。
			var localActive = cdpMode === 'local'
			var localRow = h('div', { key: 'fam-links-local', style: { borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.18))', padding: '6px 0', display: 'grid', gap: '4px' } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
					h(FamSwitch, { checked: value.allowLocalFallback === true, writable: writable,
						title: wt('linksLocalEnableHint'),
						onToggle: function (next: boolean) { void commitField(scope, 'allowLocalFallback', next) } }),
					h('span', { style: badgeStyle }, 'LOCAL'),
					h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)', flex: '1 1 120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, wt('linksLocalRow')),
					localActive
						? h('span', { style: { fontSize: '11px', color: '#30d158', flex: '0 0 auto' } }, wt('linksActive'))
						: h('button', { type: 'button', disabled: !writable, style: btnStyle,
							onClick: function () { void commitField(scope, 'cdpMode', 'local') } },
							wt('linksActivate'))))
			return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))', paddingTop: '6px', display: 'grid', gap: '4px' } },
				h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))', padding: '2px 0 4px' } },
					wt('linksTitle')),
				links.length === 0
					? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))', padding: '2px 0' } },
						wt('linksEmpty'))
					: links.map(function (row: any, idx: any) {
						var isCli = row.kind === 'ego-cli'
						var isLp = row.kind === 'lightpanda'
						var isActive = row.id !== undefined && row.id === activeId
						var probeBadge: any = null
						if (row.probeStatus === 'ok' || row.probeStatus === 'error') {
							probeBadge = h('span', { title: row.probeError || row.probeCode || '',
								style: { fontSize: '11px', flex: '0 0 auto', color: row.probeStatus === 'ok' ? '#30d158' : '#ff453a' } },
								wt(row.probeStatus === 'ok' ? 'linksProbeOk' : 'linksProbeFail')
								+ (row.probeStatus === 'ok' && row.probeLatencyMs ? ' · ' + row.probeLatencyMs + 'ms' : ''))
						}
						return h('div', { key: row.id || idx, style: { borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.18))', padding: '6px 0', display: 'grid', gap: '4px' } },
							h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
								h(FamSwitch, { checked: row.enabled === true, writable: writable,
									title: wt('linksEnabled'),
									onToggle: function (next: boolean) { writeLinks(updateRow(links, row.id, { enabled: next })) } }),
								h('span', { style: badgeStyle }, isCli ? 'CLI' : isLp ? 'LP·无头' : 'CDP'),
								h(FamRowInput, { v: row.label || '', writable: writable, placeholder: wt('linksLabel'),
									onCommit: function (v: any) { writeLinks(updateRow(links, row.id, { label: v })) } }),
								probeBadge,
								isActive
									? h('span', { style: { fontSize: '11px', color: '#30d158', flex: '0 0 auto' } }, wt('linksActive'))
									: h('button', { type: 'button', disabled: !writable || row.enabled === false,
										title: row.enabled === false ? wt('linksDisabledHint') : undefined, style: btnStyle,
										onClick: function () {
											void commitField(scope, 'activeTargetId', row.id)
											// 从受管本地切回目标序列：local 模式无视激活项，不同步模式就是点了没反应。
											if (cdpMode === 'local') { void commitField(scope, 'cdpMode', 'auto') }
										} },
										wt('linksActivate'))),
							h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
								h(FamRowInput, { v: (isCli ? row.cliPath : isLp ? row.servePath : row.endpoint) || '', writable: writable,
									placeholder: isCli ? wt('linksCliPathHint') : isLp ? wt('linksLpPathHint') : wt('linksEndpointHint'),
									onCommit: function (v: any) {
										if (isCli) { writeLinks(updateRow(links, row.id, { cliPath: v })); return }
										if (isLp) { writeLinks(updateRow(links, row.id, { servePath: v })); return }
										if (!isValidEndpoint(v)) { setErrText(wt('linksEndpointInvalid')); return }
										writeLinks(updateRow(links, row.id, { endpoint: v }))
									} }),
								// v1.7.1-rc.5: the 「使用内置 harness」 toggle is GONE — the
								// native ego CLI has no taskSpaces facade, so OFF could only ever
								// produce `taskSpaces is not defined` on every call. The host now
								// always injects the harness (and the probe auto-drops the flag
								// for CLIs that reject it), so there is nothing left to switch.
								!isCli && !isLp ? h('button', { type: 'button', disabled: !writable || probingId === row.id, style: btnStyle,
									onClick: function () { probeOne(row) } },
									probingId === row.id ? wt('linksProbing') : wt('linksProbe')) : null,
								h('button', { type: 'button', disabled: !writable || idx === 0, title: wt('linksMoveUp'), style: btnStyle,
									onClick: function () { writeLinks(moveRow(links, row.id, -1)) } }, '↑'),
								h('button', { type: 'button', disabled: !writable || idx === links.length - 1, title: wt('linksMoveDown'), style: btnStyle,
									onClick: function () { writeLinks(moveRow(links, row.id, 1)) } }, '↓'),
								h('button', { type: 'button', disabled: !writable, title: wt('linksRemove'), style: btnStyle,
									onClick: function () { removeOne(row) } }, '✕'),
								(isCli || isLp) && cdpMode === 'remote'
									? h('span', { style: { fontSize: '11px', color: '#ff9f0a', flex: '1 1 100%' } }, wt(isCli ? 'linksCliRemoteWarn' : 'linksLpRemoteWarn'))
									: null,
								isLp ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.7))', flex: '1 1 100%' } }, wt('linksLpHeadlessHint'))
									: null))
					}),
				localRow,
				h('div', { style: { display: 'grid', gap: '6px', paddingTop: '4px' } },
					h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
						h('input', { type: 'text', value: addLabel, disabled: !writable || isFull(links), placeholder: wt('linksLabel'),
							style: Object.assign({ width: '96px' }, inputStyle),
							onChange: function (e: any) { setAddLabel(e.target.value) } }),
						h('input', { type: 'text', value: addEndpoint, disabled: !writable || isFull(links), placeholder: wt('linksEndpointHint'),
							style: Object.assign({ flex: '1 1 160px', minWidth: 0 }, inputStyle),
							onChange: function (e: any) { setAddEndpoint(e.target.value) },
							onKeyDown: function (e: any) { if (e.key === 'Enter') { addCdp() } } }),
						h('button', { type: 'button', disabled: !writable || isFull(links),
							title: isFull(links) ? limitText() : undefined, style: btnStyle, onClick: addCdp }, wt('linksAddCdp'))),
					h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
						h('input', { type: 'text', value: addCliPath, disabled: !writable || isFull(links) || hasCliLink(links),
							placeholder: wt('linksCliPathHint'),
							style: Object.assign({ flex: '1 1 160px', minWidth: 0 }, inputStyle),
							onChange: function (e: any) { setAddCliPath(e.target.value) },
							onKeyDown: function (e: any) { if (e.key === 'Enter') { addCli() } } }),
h('button', { type: 'button', disabled: !writable || isFull(links) || hasCliLink(links),
							title: hasCliLink(links) ? wt('linksAddCliExists') : (isFull(links) ? limitText() : undefined),
							style: btnStyle, onClick: addCli }, wt('linksAddCli'))),
						h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
							h('input', { type: 'text', value: addLpPath, disabled: !writable || isFull(links) || hasLpLink(links),
								placeholder: wt('linksLpPathHint'),
								style: Object.assign({ flex: '1 1 160px', minWidth: 0 }, inputStyle),
								onChange: function (e: any) { setAddLpPath(e.target.value) },
								onKeyDown: function (e: any) { if (e.key === 'Enter') { addLp() } } }),
							h('button', { type: 'button', disabled: !writable || isFull(links) || hasLpLink(links),
								title: hasLpLink(links) ? wt('linksAddLpExists') : (isFull(links) ? limitText() : undefined),
								style: btnStyle, onClick: addLp }, wt('linksAddLp'))),
					errText ? h('div', { style: { fontSize: '11px', color: '#ff453a' } }, errText) : null))
		}

		function apply(ctx: any) {
		// ── Watch panel: sidebar tab & floating watch ─────────────────────
		// betterSidebar is an OPTIONAL service and is intentionally absent from
		// the static inject list (see its declaration above): on hosts without
		// dsh-better-sidebar the module loader would otherwise keep this row
		// pending forever and block the whole web boot (issue #29, reproduced
		// on DSH 0.1.2-rc.1). Probe with ctx.get; when absent, mount the
		// floating watch panel immediately and upgrade to the sidebar tab if
		// the service appears later (dynamic ctx.inject, same pattern as PR #45).
		// Per-surface isolation: any single mount may throw on a given host line
		// (absent service/slot variants) — on 0.1.x cordis surfaces that throw
		// inside apply take every later mount down with them, so each one is
		// isolated and failures degrade to a console.warn only.
		var mounts: Array<[string, (c: any) => void]> = [
			['family settings tab', mountFamilySettingsCard],
			['plugins-page config card', mountPluginsPageCard],

			['picks dock', mountPicksDockCard],
			['picks badge', mountPicksBadge],
		]
		for (var mi = 0; mi < mounts.length; mi++) {
			try {
				mounts[mi][1](ctx)
			} catch (e: any) {
				console.warn('[dsh-browser-cdp] mount failed:', mounts[mi][0], e && e.message ? e.message : String(e))
			}
		}
		var betterSidebarService: any
		try { betterSidebarService = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined } catch (e) { betterSidebarService = undefined }
		if (betterSidebarService !== undefined) {
			ctx.effect(() => mountSidebarTab(ctx, betterSidebarService), 'dsh-browser-cdp sidebar tab')
		} else {
			var disposeFloating: any = null
			ctx.effect(() => {
				disposeFloating = mountFloatingWatch(ctx)
				return function () { if (disposeFloating) { var d = disposeFloating; disposeFloating = null; d() } }
			}, 'dsh-browser-cdp watch panel')
			if (typeof ctx.inject === 'function') {
				ctx.inject(['betterSidebar'], function (sidebarCtx: any) {
					var svc: any
					try { svc = typeof sidebarCtx.get === 'function' ? sidebarCtx.get('betterSidebar') : sidebarCtx.betterSidebar } catch (e) { svc = undefined }
					if (!svc) return
					if (disposeFloating) { var d2 = disposeFloating; disposeFloating = null; d2() }
					sidebarCtx.effect(function () { return mountSidebarTab(sidebarCtx, svc) }, 'dsh-browser-cdp sidebar tab')
				})
			}
		}
	}

	// ── Floating watch panel (vanilla DOM, fallback when no sidebar) ────────
	// This is the original self-contained overlay: a draggable FAB + pop-out
	// panel. Kept verbatim for the no-sidebar path; the sidebar Tab path uses
	// the React EgoBrowserTab component + LivePreviewController instead.
	function mountFloatingWatch(ctx: any) {
		// Guard: skip if already mounted (apply() may fire multiple times).
		if (document.getElementById('dsh-ego-fab') !== null) return () => {}
				const style = document.createElement('style')
				style.textContent = PANEL_CSS
				document.head.appendChild(style)

				const panel = document.createElement('div')
				panel.id = 'dsh-ego-panel'
				panel.hidden = true
				panel.innerHTML = `
					<div id="dsh-ego-head">
						<span class="dsh-ego-grip" title="${wt('dragHint')}">${ICON_GRIP}</span>
						<span id="dsh-ego-title">${ICON_GLOBE}<span style="margin-left:6px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wt('title')}</span></span>
						<button id="dsh-ego-refresh" class="dsh-ego-iconbtn" title="${wt('refresh')}">${ICON_REFRESH}</button>
						<button id="dsh-ego-historybtn" class="dsh-ego-iconbtn off" title="${wt('historyShow')}">${ICON_CLOCK}</button>
						<button id="dsh-ego-close" class="dsh-ego-iconbtn" title="${wt('settingsHide')}">${ICON_CLOSE}</button>
					</div>
					<div id="dsh-ego-tabs"></div>
					<div id="dsh-ego-login">
						<span class="dsh-ego-login-txt">${wt('loginTitle')}</span>
						<button id="dsh-ego-login-btn" class="dsh-ego-login-btn" type="button">${wt('loginBtn')}</button>
						<span class="dsh-ego-login-note" id="dsh-ego-login-note"></span>
						<button class="dsh-ego-dismiss" type="button" title="${wt('loginDismiss')}" data-dismiss="login">×</button>
					</div>
					<div id="dsh-ego-captcha">
						<span class="dsh-ego-captcha-txt"><b>${wt('captchaTitle')}</b> — ${wt('captchaHint')}</span>
						<span class="dsh-ego-captcha-kind" id="dsh-ego-captcha-kind"></span>
						<button class="dsh-ego-dismiss" type="button" title="${wt('captchaDismiss')}" data-dismiss="captcha">×</button>
					</div>
					<div id="dsh-ego-cols">
						<div class="dsh-ego-maincol">
							<div id="dsh-ego-body"></div>
						</div>
						<aside id="dsh-ego-history">
							<div id="dsh-ego-historyhead">${ICON_CLOCK} ${wt('history')}</div>
							<div id="dsh-ego-historylist"></div>
						</aside>
					</div>
					<div class="dsh-ego-off">${wt('liveView')} · ${wt('realtime')} · ${ICON_CLOCK} ${wt('historyShow')}</div>
				`

				const fab = document.createElement('button')
				fab.id = 'dsh-ego-fab'
				fab.type = 'button'
				fab.title = wt('fabTitle')
				fab.textContent = ''
				fab.innerHTML = `${ICON_GLOBE}<span class="dsh-ego-dot"></span>`

				const body = panel.querySelector('#dsh-ego-body')
				const titleEl = panel.querySelector('#dsh-ego-title')
				const refreshBtn = panel.querySelector('#dsh-ego-refresh')
				const closeBtn = panel.querySelector('#dsh-ego-close')
				const historyBtn = panel.querySelector('#dsh-ego-historybtn')
				const historyEl = panel.querySelector('#dsh-ego-history')
				const historyList = panel.querySelector('#dsh-ego-historylist')
				const tabsEl = panel.querySelector('#dsh-ego-tabs')
				const loginEl = panel.querySelector('#dsh-ego-login')
				const loginBtn = panel.querySelector('#dsh-ego-login-btn')
				const loginNote = panel.querySelector('#dsh-ego-login-note')
				const captchaEl = panel.querySelector('#dsh-ego-captcha')
				const captchaKindEl = panel.querySelector('#dsh-ego-captcha-kind')
				const FLUSH_ROUTE = '/api/bcdp/flush'

				// Guide strips that the user can dismiss (×). Once closed in this
				// panel lifecycle they stay closed, so they never permanently eat
				// vertical space above the main view.
				const dismissedGuides: Record<string, boolean> = { login: false, captcha: false }
				const bindGuideDismiss = (which: any, el: any) => {
					const btn = el && el.querySelector('[data-dismiss="' + which + '"]')
					if (!btn) return
					btn.addEventListener('click', () => {
						dismissedGuides[which] = true
						el.classList.remove('show')
					})
				}
				bindGuideDismiss('login', loginEl)
				bindGuideDismiss('captcha', captchaEl)

				// Title keeps a leading globe icon; update only the trailing label
				// text so the icon is never wiped by a textContent reassignment.
				const setTitle = (text: any) => {
					const label = titleEl.querySelector('span:last-child')
					if (label) label.textContent = text
				}

				let disposed = false
				let liveCount = 0
				let historyOpen = false
				// Cache of the most recent spaces payload, so the preview "back"
				// control can restore the list synchronously and reliably instead
				// of depending on a fresh network round-trip (which may hang when
				// the worker/host is transiently unreachable).
				let lastList: any[] = []

				// Toggle the history drawer (side panel).
				const setHistory = (open: any) => {
					historyOpen = open
					historyEl.classList.toggle('open', open)
					panel.classList.toggle('open-drawer', open)
					historyBtn.classList.toggle('off', !open)
					;(historyBtn as HTMLElement).title = open ? wt('historyHide') : wt('historyShow')
					if (open) renderHistory(lastList)
				}

				// ---- History drawer: list every page, oldest -> newest ----
				const renderHistory = (spaces: any) => {
					historyList.innerHTML = ''
					const list = Array.isArray(spaces) ? [...spaces].sort((a, b) => (a.lastActive ?? 0) - (b.lastActive ?? 0)) : []
					if (list.length === 0) {
						historyList.innerHTML = `<div class="dsh-ego-hnone">${wt('noHistory')}</div>`
						return
					}
					for (const s of list) {
						const item = document.createElement('div')
						item.className = 'dsh-ego-hitem'
						const thumbSrc = frameCache.get(s.targetId)
						const thumb = thumbSrc
							? `<img class="dsh-ego-hthumb" src="${thumbSrc}" alt="">`
							: `<div class="dsh-ego-hthumb"></div>`
						const active = s.targetId === currentActiveId
						item.innerHTML = `${thumb}
							<div class="dsh-ego-hinfo">
								<div class="dsh-ego-htitle">${escapeHtml(s.title || (s.url || wt('newTab')))}</div>
								<div class="dsh-ego-hurl">${escapeHtml(s.url || '(about:blank)')}</div>
								${active ? '<div class="dsh-ego-hactive">● ' + wt('current') + '</div>' : ''}
							</div>`
						item.addEventListener('click', () => openPreview(s))
						historyList.appendChild(item)
					}
				}

				// "pinned" = the user clicked a history entry and the main view is
				// now locked to that page. null = live view (auto-follows the
				// agent's current active page). Polling must NOT overwrite a
				// pinned view, or it would snap back to live every poll tick.
				let pinned: any = null
				// Which page is "current" (the live one shown in the main view).
				let currentActiveId: any = null
				// The page the AGENT is actually on — the browser's MRU-active tab,
				// reported by the worker as `active: true` in the spaces payload.
				// Distinct from currentActiveId (what the user is viewing): gating
				// auto-follow on agentActiveId stops a background repainting tab
				// (video/animation) from hijacking the view.
				let agentActiveId: any = null
				// selectedTabId = the tab the user last clicked on the tab bar. When
				// set to a live tab, the main view shows that tab (and sticks with
				// it across polls) instead of auto-following the agent's newest page.
				let selectedTabId: any = null
				// Zoom/pan state for the main live image, persisted across renders
				// so a re-render (poll refresh) keeps the user's zoom & position.
				let zoomState = { scale: 1, tx: 0, ty: 0 }
				// ── realtime SSE frame pipeline ──
				// frameCache: targetId -> dataURL of the newest JPEG that arrived
				// over the stream. liveImg: the <img> currently in the main view,
				// so a frame event for the shown tab swaps its src in place without
				// tearing down the zoom/pan state.
				const frameCache = new Map()
				let liveImg: any = null
				let liveImgTargetId: any = null
				// T5.17 — the floating window's pick control. Lives at closure
				// scope so it survives renderLiveMain re-renders; its status is
				// echoed on the URL line, the same surface hints use.
				var pickCtl = createPickControl(function (pick: any, message: any) {
					if (pickUrlLine) pickUrlLine.textContent = message || ''
					if (pickBtnEl) {
						pickBtnEl.textContent = pick === 'failed' ? wt('pickFailed') : pick === 'on' ? wt('picking') : wt('pickMode')
						pickBtnEl.classList.toggle('dsh-ego-pick-on', pick === 'on')
						// 失败详情（worker 的 code/message）挂到 hover，别再只有一句泛化文案。
						pickBtnEl.title = pick === 'failed' ? (message || '') : ''
					}
				}, function (el: any, a: any) { return deliverPickToConversation(ctx, el, a) })
				var pickBtnEl: any = null
				var pickUrlLine: any = null
				// rAF-coalesced live-frame flush: newest frame is applied at display
				// cadence instead of decoding every source frame (bounds CPU under
				// an uncapped screencast).
				let pendingLiveFrame: any = null
				let liveFlushRaf: any = null
				// pageMeta: targetId -> { url, title }, kept authoritative for the
				// auto-follow path. Polled /api/bcdp/spaces data lags the SSE frame
				// stream, so a brand-new page (frame-first, list-later) would never
				// be findable in lastList in time to follow it. We merge updates
				// from both sources here and follow from this map instead.
				const pageMeta = new Map()
				const watchClientId = 'floating-' + Math.random().toString(36).slice(2)
				let watchStarted = false, watchTargetId: any = null, watchRenewTimer: any = null, watchStopTimer: any = null, watchRequest: any = null
				let captureBackend = 'cdp', streamGeneration = 0, streamState = 'idle', streamMessage = '', streamMime = 'video/mp4; codecs="avc1.42E01E"', videoCleanup: any = null
				let streamEngineUnsupported = false
				const effectiveVisible = () => !panel.hidden
				const stopVideo = () => { if (videoCleanup) try { videoCleanup() } catch {}; videoCleanup = null }
				const applyCaptureStatus = (status: any) => {
					if (!status || typeof status !== 'object') return
					if (Number.isFinite(status.generation) && status.generation < streamGeneration) return
					if (status.generation === streamGeneration && streamState === 'streaming' && status.state === 'starting') return
					const nextBackend = status.backend || captureBackend
					const nextGeneration = status.generation ?? streamGeneration
					const nextState = status.state || streamState
					const nextMime = status.mime || streamMime
					const nextUnsupported = status.engineUnsupported === true
					const changed = captureBackend !== nextBackend || streamGeneration !== nextGeneration || streamState !== nextState || streamMime !== nextMime || streamEngineUnsupported !== nextUnsupported
					captureBackend = nextBackend; streamGeneration = nextGeneration; streamState = nextState; streamMessage = status.message || status.code || ''; streamMime = nextMime; streamEngineUnsupported = nextUnsupported
					if (changed) { stopVideo(); const current = lastList.find((s) => s.targetId === (selectedTabId || currentActiveId)); if (current) renderLiveMain(current, selectedTabId !== null) }
				}
				const requestWatch = (route: any, body: any) => {
					if (watchRequest) return null
					watchRequest = postJson(route, body).finally(() => { watchRequest = null })
					return watchRequest
				}
				const syncWatch = (targetId: any) => {
					if (disposed || !effectiveVisible() || !targetId) return
					if (watchStopTimer) { window.clearTimeout(watchStopTimer); watchStopTimer = null }
					if (watchStarted && watchTargetId === targetId) return
					const request = requestWatch(watchStarted ? WATCH_SWITCH_ROUTE : WATCH_START_ROUTE, { clientId: watchClientId, targetId })
					if (!request) { watchRequest.finally(() => syncWatch(targetId)); return }
					request.then((status: any) => { watchStarted = status && status.ok !== false; watchTargetId = status?.targetId || targetId; if (watchTargetId !== targetId) { selectedTabId = null; currentActiveId = watchTargetId }; applyCaptureStatus(status); if (!effectiveVisible()) stopWatch(true) }).catch(() => {})
					if (!watchRenewTimer) watchRenewTimer = window.setInterval(() => { if (effectiveVisible() && watchTargetId) { const renewal = requestWatch(WATCH_START_ROUTE, { clientId: watchClientId, targetId: watchTargetId }); if (renewal) renewal.then(applyCaptureStatus).catch(() => {}) } }, 5000)
				}
				const stopWatch = (immediate: any) => {
					if (watchRenewTimer) { window.clearInterval(watchRenewTimer); watchRenewTimer = null }
					const stop = () => { watchStopTimer = null; watchStarted = false; watchTargetId = null; postJson(WATCH_STOP_ROUTE, { clientId: watchClientId }).catch(() => {}) }
					if (immediate) stop(); else { if (watchStopTimer) window.clearTimeout(watchStopTimer); watchStopTimer = window.setTimeout(stop, 1500) }
				}

				// ── browser interaction: map panel pointer → real browser pixels ──
				const INPUT_ROUTE = '/api/bcdp/input'
				let inputBusy = false
				/**
				 * Send a pointer/wheel intention to the agent browser. Coordinates
				 * are already in browser CSS pixels; the worker turns them into CDP
				 * Input.dispatchMouseEvent on the page the panel is showing.
				 * `type`: mouseMoved | mousePressed | mouseReleased | mouseWheel.
				 */
				const sendInput = (targetId: any, type: any, params: any) => {
					const targetValid = !!targetId
					if (!targetValid || ((type !== 'mouseReleased' && type !== 'keyUp') && !effectiveVisible())) return
					if (inputBusy && type === 'mouseMoved') return
					if (type === 'mouseMoved') { inputBusy = true; window.setTimeout(() => { inputBusy = false }, 24) }
					void fetch(INPUT_ROUTE, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ targetId, type, ...params }),
					}).then((res) => { if (res.status === 409) { liveImgTargetId = null; refresh() } }).catch(() => {})
				}
				const keyboardProxy = createKeyboardProxy((targetId: any, type: any, params: any) => sendInput(targetId, type, params))
				/**
				 * Map an event's client coords to the agent page's CSS pixels.
				 *
				 * The shown <img> is the screencast frame laid out with
				 * object-fit:contain, so the page fills a centered letterboxed box
				 * inside the element. We find that box from the image's natural
				 * (frame) size vs its rendered box, then scale into the page's CSS
				 * viewport (vw/vh), which the worker attaches to each frame.
				 */
				const browserXY = (e: any) => {
					if (liveImgTargetId == null) return null
					const m = pageMeta.get(liveImgTargetId)
					const vw = m?.vw, vh = m?.vh
					if (!Number.isFinite(vw) || !Number.isFinite(vh)) return null
					const img = liveImg
					if (!img) return null
					const rect = img.getBoundingClientRect()
					const natW = img.naturalWidth || img.videoWidth || rect.width
					const natH = img.naturalHeight || img.videoHeight || rect.height
					if (!natW || !natH) return null
					const scale = Math.min(rect.width / natW, rect.height / natH)
					const contentW = natW * scale
					const contentH = natH * scale
					const ox = (rect.width - contentW) / 2
					const oy = (rect.height - contentH) / 2
					const rx = e.clientX - rect.left - ox
					const ry = e.clientY - rect.top - oy
					const x = (rx / contentW) * vw
					const y = (ry / contentH) * vh
					return { x, y }
				}

				// Build the zoomable main-view <img>. Wheel zooms around the cursor,
				// drag pans, double-click resets. State is shared via zoomState.
				// `urlEl` is the URL line below the image: while the user is zooming
				// or panning it briefly shows the relevant hint instead of the URL.
				// Interaction modes:
				//   plain wheel  → scroll the agent page (sent to the browser)
				//   Ctrl+wheel   → zoom the view (magnifier, local only)
				//   plain drag   → drag inside the agent page (sent to the browser)
				//   Ctrl+drag    → pan the view (local only)
				//   click        → click the agent page
				//   dblclick     → reset the view zoom
				const makeZoomImage = (urlEl: any, tagName = 'img') => {
					const img = document.createElement(tagName) as any
					img.className = 'dsh-ego-liveimg'
					if (tagName === 'img') img.draggable = false
					else { img.muted = true; img.autoplay = true; img.playsInline = true }
					img.title = '滚轮缩放 · 按住拖动平移 · 缩小到最小或双击复位'
					// Hint swap: remember the real URL, show a tip while operating,
					// restore it after a short quiet period.
					const realText = urlEl ? urlEl.textContent : ''
					let hintTimer: any = null
					const clearHint = () => { if (hintTimer) { window.clearTimeout(hintTimer); hintTimer = null } }
					const showHint = (txt: any) => {
						if (!urlEl) return
						urlEl.textContent = txt
						urlEl.classList.add('dsh-ego-hint')
						clearHint()
						hintTimer = window.setTimeout(() => {
							urlEl.textContent = realText
							urlEl.classList.remove('dsh-ego-hint')
							hintTimer = null
						}, 2000)
					}
					const apply = () => {
						img.style.transformOrigin = '0 0'
						img.style.transform = `translate(${zoomState.tx}px, ${zoomState.ty}px) scale(${zoomState.scale})`
					}
					let viewPanning = false   // Ctrl+drag → local pan
					let browserDrag = false   // plain drag → send to agent
					let sx = 0, sy = 0, stx = 0, sty = 0
					let lastDragPos: any = null     // last browser coords sent during drag
					let dragTargetId: any = null
					let downButtons = 0

					const resetView = () => {
						zoomState = { scale: 1, tx: 0, ty: 0 }
						apply()
						showHint(wt('hintReset'))
					}
					img.title = wt('hintReset')

					// Wheel: plain = scroll the agent page; Ctrl+wheel = view zoom.
					img.addEventListener('wheel', (e: any) => {
						e.preventDefault()
						e.stopPropagation()
						if (e.ctrlKey || e.metaKey) {
							const rect = img.getBoundingClientRect()
							const mx = e.clientX - rect.left, my = e.clientY - rect.top
							const next = Math.min(8, Math.max(1, zoomState.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
							if (next <= 1) { resetView(); return }
							zoomState.tx = mx - (mx - zoomState.tx) * (next / zoomState.scale)
							zoomState.ty = my - (my - zoomState.ty) * (next / zoomState.scale)
							zoomState.scale = next
							apply()
							showHint(wt('hintPan'))
							return
						}
						// Plain wheel → scroll the real page.
						const p = browserXY(e)
						if (p && liveImgTargetId) {
							sendInput(liveImgTargetId, 'mouseWheel', { x: p.x, y: p.y, deltaX: e.deltaX || 0, deltaY: e.deltaY || (e.deltaMode === 1 ? 40 : (e.deltaY || 100)) })
						}
					}, { passive: false })

					img.addEventListener('pointerdown', (e: any) => {
						if (e.button !== 0) return // left button only
						// T5.1b: while picking, a click on the live image IS the pick.
						if (pickCtl.isEnabled()) {
							const pp = browserXY(e)
							if (pp && liveImgTargetId) pickCtl.clickAt(pp.x, pp.y, liveImgTargetId)
							return
						}
						img.setPointerCapture(e.pointerId)
						sx = e.clientX; sy = e.clientY
						stx = zoomState.tx; sty = zoomState.ty
						if (e.ctrlKey || e.metaKey) {
							// Ctrl+drag → pan the view (magnifier), no browser input.
							viewPanning = true
							img.style.cursor = 'grabbing'
							showHint(wt('hintScroll'))
							return
						}
						// Plain press → start a browser interaction (click or drag).
						browserDrag = true
						dragTargetId = liveImgTargetId
						keyboardProxy.focusAt(e, dragTargetId)
						lastDragPos = null
						downButtons = 1
						const p = browserXY(e)
						if (p) {
							lastDragPos = p
							sendInput(dragTargetId, 'mousePressed', { x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
						}
					})
					img.addEventListener('pointermove', (e: any) => {
						if (viewPanning) {
							zoomState.tx = stx + (e.clientX - sx)
							zoomState.ty = sty + (e.clientY - sy)
							apply()
							return
						}
						// Hover feedback even when not dragging: move the browser pointer.
						if (!browserDrag) {
							const p = browserXY(e)
							if (p) sendInput(liveImgTargetId, 'mouseMoved', { x: p.x, y: p.y, buttons: 0 })
							return
						}
						// Active drag → stream pointer moves to the browser.
						const p = browserXY(e)
						if (p) {
							// Skip a first tiny jitter if the press also set lastDragPos.
							sendInput(dragTargetId, 'mouseMoved', { x: p.x, y: p.y, buttons: downButtons })
							lastDragPos = p
						}
					})
					const stopDrag = (e: any) => {
						if (viewPanning) { viewPanning = false; img.style.cursor = e.ctrlKey ? 'grab' : 'grab' }
						if (browserDrag) {
							browserDrag = false
							if (lastDragPos && dragTargetId) {
								sendInput(dragTargetId, 'mouseReleased', { x: lastDragPos.x, y: lastDragPos.y, button: 'left', buttons: 0, clickCount: 1 })
							}
							dragTargetId = null
						}
						img.style.cursor = 'grab'
					}
					img.addEventListener('pointerup', stopDrag)
					img.addEventListener('pointercancel', stopDrag)
					img.addEventListener('pointerleave', (e: any) => { if (browserDrag || viewPanning) stopDrag(e) })
					img.addEventListener('dblclick', (e: any) => { e.preventDefault(); resetView() })
					img.style.cursor = 'grab'
					apply()
					return img
				}


				// ---- tab bar ----
				const renderTabs = (spaces: any) => {
					tabsEl.innerHTML = ''
					const list = Array.isArray(spaces) ? spaces : []
					if (list.length === 0) { if (selectedTabId) selectedTabId = null; return }
					for (const s of list) {
						const tab = document.createElement('div')
						tab.className = 'dsh-ego-tab'
						tab.title = s.url || ''
						;(tab as any).__tid = s.targetId
						const dot = document.createElement('span')
						dot.className = 'dsh-ego-tabdot'
						const txt = document.createElement('span')
						txt.className = 'dsh-ego-tabtxt'
						txt.textContent = s.title || (s.url || wt('newTab'))
						tab.appendChild(dot)
						tab.appendChild(txt)
						// Tab close "×": POST to the host close route, then refresh.
						const closeBtn = document.createElement('span')
						closeBtn.className = 'dsh-ego-tabclose'
						closeBtn.title = wt('closeTab')
						closeBtn.textContent = '×'
						closeBtn.addEventListener('click', (e) => {
							e.stopPropagation()
							void (async () => {
								try {
									await fetch(EGO_CLOSE_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: s.targetId }) })
								} catch { /* keep silent */ }
								if (selectedTabId === s.targetId) { selectedTabId = null; pinned = null }
							})().then(() => refresh())
						})
						tab.appendChild(closeBtn)
						if (s.targetId === selectedTabId || (selectedTabId === null && s.targetId === currentActiveId)) tab.classList.add('active')
						tab.addEventListener('click', () => {
							// Clicking the already-selected tab returns to live follow.
							if (selectedTabId === s.targetId) { selectedTabId = null; pinned = null; renderSpaces(lastList); return }
							selectedTabId = s.targetId
							pinned = null
							renderLiveMain(s, true)
							syncWatch(s.targetId)
							;[...tabsEl.querySelectorAll('.dsh-ego-tab')].forEach(t => t.classList.toggle('active', (t as any).__tid === s.targetId))
						})
						tabsEl.appendChild(tab)
					}
				}

				// Render one page's screenshot in the main view. `pinned` controls
				// whether this is the sticky (user-selected) view or the live one.
				// Reuses the SAME large landscape layout as the live view so aspect
				// ratio / sizing never changes between live and history preview.
				const renderSingleView = (s: any) => {
					body.innerHTML = ''
					const view = document.createElement('div')
					view.className = 'dsh-ego-liveview'
					const badge = document.createElement('div')
					badge.className = 'dsh-ego-livebadge'
					badge.innerHTML = pinned
						? `<span class="dsh-ego-state-dot pin"></span> ${wt('pinned')}`
						: `<span class="dsh-ego-state-dot${fab.classList.contains('dsh-ego-busy') ? ' busy' : ''}"></span> ${wt('realtime')}`
					view.appendChild(badge)
					if (pinned) {
						const back = document.createElement('button')
						back.className = 'dsh-ego-back'
						back.type = 'button'
						back.textContent = wt('backToLive')
						back.addEventListener('click', () => { pinned = null; renderSpaces(lastList) })
						badge.appendChild(back)
					}
					const t = document.createElement('div')
					t.className = 'dsh-ego-livetitle'
					t.textContent = s.title || (s.url || wt('newTab'))
					// URL line — also the surface the hint is shown on while operating.
					const u = document.createElement('div')
					u.className = 'dsh-ego-liveurl'
					u.textContent = s.url || ''
					// The thumbnail is no longer in the spaces payload — pull the
					// latest cached JPEG from the SSE frame pipeline. attachLiveImg
					// wires up the live <img> so future SSE frame events for this
					// target swap its src in place.
					const cached = frameCache.get(s.targetId)
					if (captureBackend === 'ffmpeg' || cached) {
						const img = makeZoomImage(u, captureBackend === 'ffmpeg' ? 'video' : 'img')
						if (captureBackend === 'ffmpeg' && streamState === 'streaming') { stopVideo(); videoCleanup = createMsePlayer(img, streamGeneration, streamMime, (message: any) => { streamMessage = message }) }
						else img.src = cached
						img.alt = 'live'
						attachLiveImg(s.targetId, img)
						view.appendChild(img)
					} else {
						const n = document.createElement('div')
						n.className = 'dsh-ego-liveurl'
						n.textContent = streamEngineUnsupported ? wt('engineUnsupportedBanner') : wt('noScreenshot')
						view.appendChild(n)
					}
					view.appendChild(t)
					view.appendChild(u)
					body.appendChild(view)
				}

				// Secondary view: open a specific history page in the main view,
				// pinned until the user returns to live.
				const openPreview = (s: any) => {
					if (disposed) return
					pinned = s
					renderSingleView(s)
				}

				const renderSpaces = (spaces: any) => {
					if (disposed) return
					lastList = Array.isArray(spaces) ? spaces : []
					// Keep pageMeta authoritative for the auto-follow AND for the
					// viewport-based coordinate mapping. Merge (do not overwrite) so
					// vw/vh learned from an SSE frame are not lost on the next poll;
					// also pick up viewportW/H now that /api/bcdp/spaces carries them.
					for (const s of lastList) {
						const prev = pageMeta.get(s.targetId) || { targetId: s.targetId }
						pageMeta.set(s.targetId, {
							url: s.url,
							title: s.title,
							targetId: s.targetId,
							...(Number.isFinite(s.viewportW) ? { vw: s.viewportW } : prev.vw !== undefined ? { vw: prev.vw } : {}),
							...(Number.isFinite(s.viewportH) ? { vh: s.viewportH } : prev.vh !== undefined ? { vh: prev.vh } : {}),
						})
					}
					// Prune caches for tabs that no longer exist, so long sessions
					// never grow frameCache/pageMeta unboundedly on closed pages.
					const liveIds = new Set(lastList.map(s => s.targetId))
					for (const id of [...pageMeta.keys()]) if (!liveIds.has(id)) pageMeta.delete(id)
					for (const id of [...frameCache.keys()]) if (!liveIds.has(id)) frameCache.delete(id)
					const sorted = [...lastList].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
					// Authoritative active page: the worker marks it `active: true`
					// (the browser's MRU tab, not "last repaint"). Prefer it over the
					// recency sort so a repainting background tab (video/animation)
					// with a high lastActive cannot steal the view.
					const activeMarked = lastList.find(s => s.active === true) || sorted[0] || null
					if (activeMarked) {
						agentActiveId = activeMarked.targetId
						currentActiveId = activeMarked.targetId
					}
					// Reflect whether a page is present (for the login guide).
					maybeShowLoginGuide()
					// Reflect whether the agent is being asked to verify (CAPTCHA).
					maybeShowCaptchaGuide()
					// Tab bar always reflects the current open tabs.
					renderTabs(lastList)
					if (historyOpen) renderHistory(lastList)
					// While the user pinned a history page, do NOT overwrite the main
					// view — otherwise the standing poll snaps it back to live.
					if (pinned) return
					if (lastList.length === 0) {
						setTitle('Agent 浏览器')
						body.innerHTML = `<div class="dsh-ego-empty">${wt('noActivePages')}<br><span style="font-size:11px;">${wt('noActiveHint')}</span></div>`
						liveCount = 0
						fab.classList.remove('dsh-ego-live', 'dsh-ego-busy')
						return
					}
				liveCount = lastList.length
				fab.classList.add('dsh-ego-live')
				// Busy signal: derived from whether any page was touched recently.
				// Previously lived in the now-removed polling scheduler; moved
				// here so the SSE `spaces` event keeps the status dot live.
				const busy = lastList.some(s => (Date.now() - (s.lastActive || 0)) <= ACTIVE_WINDOW_MS)
				if (busy !== lastSawActive) {
					fab.classList.toggle('dsh-ego-busy', busy)
					lastSawActive = busy
				} else {
					fab.classList.remove('dsh-ego-busy')
				}
					// If the user picked a tab on the bar, keep showing that tab
					// (even as the agent opens new pages); else follow the newest.
					const sel = selectedTabId !== null ? lastList.find(x => x.targetId === selectedTabId) : null
					const current = sel || activeMarked
					currentActiveId = current.targetId
					syncWatch(current.targetId)
					setTitle(sel ? wt('title') : wt('titleLive'))
					renderLiveMain(current, sel)
				}

				// Point the realtime pipeline at this <img> so incoming SSE frames
				// for `targetId` swap its src in place (no view teardown).
				const attachLiveImg = (targetId: any, img: any) => {
					liveImg = img
					liveImgTargetId = targetId
					const cached = frameCache.get(targetId)
					if (cached) img.src = cached
				}

				const renderLiveMain = (current: any, isPinned: any) => {
					body.innerHTML = ''
					const view = document.createElement('div')
					view.className = 'dsh-ego-liveview'
					const badge = document.createElement('div')
					badge.className = 'dsh-ego-livebadge'
					badge.innerHTML = isPinned
						? `<span class="dsh-ego-state-dot pin"></span> ${wt('pinned')}`
						: `<span class="dsh-ego-state-dot${fab.classList.contains('dsh-ego-busy') ? ' busy' : ''}"></span> ${wt('realtime')}`
					view.appendChild(badge)
					const t = document.createElement('div')
					t.className = 'dsh-ego-livetitle'
					t.textContent = current.title || (current.url || wt('newTab'))
					// URL line — also the surface the hint is shown on while operating.
					const u = document.createElement('div')
					u.className = 'dsh-ego-liveurl'
					u.textContent = current.url || ''
					pickUrlLine = u
					// T5.17 — pick toggle, LEFT of "open real page".
					const pickBtn = document.createElement('button')
					pickBtn.type = 'button'
					pickBtn.className = 'dsh-ego-back'
					pickBtn.title = wt('pickModeHint')
					pickBtn.textContent = wt('pickMode')
					pickBtnEl = pickBtn
					pickBtn.addEventListener('click', () => { pickCtl.toggle(current.targetId) })
					badge.appendChild(pickBtn)
					const openHere = document.createElement('button')
					openHere.type = 'button'
					openHere.className = 'dsh-ego-back'
					openHere.title = wt('openExternal')
					openHere.textContent = wt('openExternal')
					openHere.addEventListener('click', () => {
						const url = current.url
						if (url && !url.startsWith('about:') && !url.startsWith('chrome://')) window.open(url, '_blank', 'noopener')
						else openHere.textContent = wt('noUrl')
					})
					badge.appendChild(openHere)
					// Raise the real agent window (issue #51): headless instances
					// get replaced by a headed one on the same profile.
					const raiseBtn = document.createElement('button')
					raiseBtn.type = 'button'
					raiseBtn.className = 'dsh-ego-back'
					raiseBtn.title = wt('raiseWindowHint')
					raiseBtn.textContent = wt('raiseWindow')
					raiseBtn.addEventListener('click', () => {
						fetch('/api/bcdp/raise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
							.then((r) => r.json().catch((): any => null))
							.catch((): any => null)
					})
					badge.appendChild(raiseBtn)
					const cached = frameCache.get(current.targetId)
					if (captureBackend === 'ffmpeg' || cached) {
						const img = makeZoomImage(u, captureBackend === 'ffmpeg' ? 'video' : 'img')
						if (captureBackend === 'ffmpeg' && streamState === 'streaming') { stopVideo(); videoCleanup = createMsePlayer(img, streamGeneration, streamMime, (message: any) => { streamMessage = message }) }
						else img.src = cached
						img.alt = 'live'
						attachLiveImg(current.targetId, img)
						view.appendChild(img)
					} else {
						const n = document.createElement('div')
						n.className = 'dsh-ego-liveurl'
						n.textContent = streamEngineUnsupported ? wt('engineUnsupportedBanner') : wt('noScreenshot')
						view.appendChild(n)
					}
					view.appendChild(t)
					view.appendChild(u)
					body.appendChild(view)
				}

				// ── spaces loading ────────────────────────────────────────────
				// The watch panel is now pure SSE-driven (spaces + frame events
				// from /api/bcdp/stream). This `refresh` is NO LONGER called on a
				// timer — it is only used as a one-shot fallback when:
				//   • the SSE stream errors / reconnects (to re-sync the tab list),
				//   • the user manually clicks the refresh button,
				//   • the user closes a tab (to re-sync),
				//   • initial mount (the SSE `spaces` event on connect covers this
				//     too, but we do an explicit fetch to surface any error early).
				// The response carries NO thumbnail bytes (worker /api/spaces is
				// pure metadata now); thumbnails come from the SSE frame cache.
				let lastSawActive = false
				const refresh = () => {
					void (async () => {
						try {
							const res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
							if (disposed || !res.ok) { renderEmpty(); return }
							const data = await res.json()
							if (!data || data.ok !== true) { renderEmpty(); return }
							applyCaptureStatus(data.capture)
							renderSpaces(data.spaces)
						} catch {
							renderEmpty()
						}
					})()
				}
				const renderEmpty = () => {
					if (body.children.length === 0) renderSpaces([])
				}

				// ── realtime SSE: live frames + active-page auto-follow ──
				// The cast worker pushes two kinds of events on /api/bcdp/stream:
				//   • `frame`  — per-repaint JPEG for any page (real-time video)
				//   • `spaces` — pure metadata (url/title/active/viewport/humanCheck),
				//                broadcast on every keepalive tick (~500ms) and on
				//                tab churn, so the tab bar + main view stay in sync
				//                WITHOUT any client-side polling.
				// The panel no longer polls /api/bcdp/spaces on a timer. A one-shot
				// `refresh()` is only called on initial mount and on SSE reconnect
				// (via the `onerror` debouncer below) to re-sync after a stream gap.
				let sse: any = null
				let lastFrameAt = 0
				const FRAME_FOLLOW_MIN_MS = 350 // throttle live-follow view swaps
				let followTimer: any = null

				const applyFrame = (targetId: any, dataUrl: any, vw: any, vh: any) => {
					if (disposed) return
					frameCache.set(targetId, dataUrl)
					// Bounded cache: cap live frames to the most recent few pages so a
					// busy session can never accumulate unbounded JPEG dataURLs.
					const MAX_CACHED_FRAMES = 12
					if (frameCache.size > MAX_CACHED_FRAMES) {
						for (const [id] of frameCache) {
							if (id === targetId || id === liveImgTargetId) continue
							frameCache.delete(id)
							if (frameCache.size <= MAX_CACHED_FRAMES) break
						}
					}
					// Snapshot the page viewport for coordinate mapping.
					if (Number.isFinite(vw) && Number.isFinite(vh)) {
						const cur = pageMeta.get(targetId) || { targetId }
						pageMeta.set(targetId, { ...cur, vw, vh })
					}
					// Swap the currently shown image in place, no view rebuild.
					if (liveImg && liveImgTargetId === targetId) {
						// Coalesce to display cadence: with an uncapped screencast the
						// frames can arrive faster than the panel can present, and
						// setting img.src on every frame decodes each one. Instead keep
						// only the newest frame and apply it on the next animation
						// frame — the browser samples the latest, so bursts cost one
						// decode per presentation instead of per source frame.
						pendingLiveFrame = dataUrl
						if (!liveFlushRaf && !disposed) {
							liveFlushRaf = window.requestAnimationFrame(() => {
								liveFlushRaf = null
								if (disposed || !liveImg || pendingLiveFrame == null) return
								try { liveImg.src = pendingLiveFrame } catch {}
								pendingLiveFrame = null
							})
						}
						return
					}
					// Auto-follow: while not pinned to a history page and not pinned to
					// a manually chosen tab, jump to the page the agent is ACTIVELY on.
					// Only follow when this frame belongs to the agent's current page
					// (worker-reported MRU-active tab). Frames from a background
					// repainting tab (video/animation) must NOT hijack the view; we
					// merely swap its cached frame so the moment the user/agent brings
					// the tab forward the correct picture is already there.
					if (!pinned && selectedTabId === null && targetId === agentActiveId) {
						const now = Date.now()
						if (now - lastFrameAt >= FRAME_FOLLOW_MIN_MS) {
							lastFrameAt = now
							if (followTimer) window.clearTimeout(followTimer)
							followTimer = window.setTimeout(() => {
								if (disposed || pinned || selectedTabId !== null) return
								if (liveImg && liveImgTargetId === targetId) return
								const meta = pageMeta.get(targetId)
								if (!meta) return
								currentActiveId = targetId
								renderLiveMain({ ...meta, targetId }, false)
							}, 0)
						}
					}
				}

				let reconnectFallbackTimer: any = null
				const openStream = () => {
					if (disposed) return
					fetch(WATCH_STATUS_ROUTE, { cache: 'no-store' }).then((res) => res.ok ? res.json() : null).then(applyCaptureStatus).catch(() => {})
					try { if (sse) sse.close() } catch {}
					doConnected = false
					sse = new EventSource('/api/bcdp/stream')
					sse.onopen = () => { doConnected = true }
					// A frame event looks like: { targetId, data (base64 jpeg), ts, vw, vh }.
					sse.addEventListener('frame', (ev: any) => {
						try {
							const m = JSON.parse(ev.data)
							if (!m || !m.targetId || !m.data) return
							if (Number.isFinite(m.vw) && Number.isFinite(m.vh)) {
								const cur = pageMeta.get(m.targetId) || { targetId: m.targetId }
								pageMeta.set(m.targetId, { ...cur, vw: m.vw, vh: m.vh })
							}
							applyFrame(m.targetId, `data:image/${m.fmt === 'png' ? 'png' : 'jpeg'};base64,${m.data}`, m.vw, m.vh)
						} catch {}
					})
				// The worker also sends the live list on open (and on tab
				// churn); treat it as the authoritative tab-list + main-view
				// update. This replaces the old /api/bcdp/spaces polling loop.
					sse.addEventListener('spaces', (ev: any) => {
					if (disposed) return
					try {
						const list = JSON.parse(ev.data)
						if (Array.isArray(list)) {
							// Even for an empty list, we want to call renderSpaces
							// so the "no live browser" placeholder shows up.
							renderSpaces(list)
						}
					} catch {}
				})
				sse.addEventListener('capture-status', (ev: any) => {
					try {
						applyCaptureStatus(JSON.parse(ev.data))
					} catch {}
				})
				// Debounced reconnect fallback: when the SSE stream drops,
				// EventSource auto-reconnects, but we also kick off a one-shot
				// /api/bcdp/spaces fetch so the panel re-syncs immediately on the
				// next successful connect (without waiting for the worker's next
				// keepalive broadcast). The 1.5s delay gives EventSource room to
				// reconnect cleanly first, avoiding a redundant fetch on a
				// momentary blip.
				sse.onerror = () => {
					doConnected = false
					if (reconnectFallbackTimer) return
					reconnectFallbackTimer = window.setTimeout(() => {
						reconnectFallbackTimer = null
						if (disposed) return
						refresh()
					}, 1500)
				}
				}
				let doConnected = false

				// ── draggable FAB + panel, independently positioned ──
				// The ball and its pop-out window each keep their own spot: dragging
				// the ball moves only the ball, dragging the panel header moves only
				// the panel. When you open the panel by tapping the ball it snaps to
				// a corner next to the ball (flipping below when near the top edge),
				// so it never pops up in a surprising spot.
				const DRAG_KEY = 'dsh.ego.watch.pos'
				const DRAG_PANEL_KEY = 'dsh.ego.watch.panelPos'
				const FAB_W = 48, FAB_H = 48
				const PANEL_W = 408, PANEL_GAP = 8
				// Viewport-fraction persistence (issue #4): ratio is the stored truth, pos a
				// pixel cache; conversion happens only at the read/write boundary, the
				// existing pixel clamp still guards on-screen placement. Legacy {x,y}
				// archives are normalized against the current viewport on load.
				const vpFab = (): Viewport => ({ vw: window.innerWidth, vh: window.innerHeight, w: FAB_W, h: FAB_H })
				const vpPanel = (): Viewport => ({ vw: window.innerWidth, vh: window.innerHeight, w: PANEL_W, h: 520 })
				const loadRatio = (key: string, vp: Viewport): RatioPos | null => {
					try { return normalizeStored(JSON.parse(localStorage.getItem(key) || 'null'), vp) } catch { return null }
				}
				let ratio: RatioPos | null = loadRatio(DRAG_KEY, vpFab())
				let pos = ratio ? fromRatio(ratio, vpFab()) : { x: window.innerWidth - 18 - FAB_W, y: window.innerHeight - 104 - FAB_H }
				let panelRatio: RatioPos | null = loadRatio(DRAG_PANEL_KEY, vpPanel())
				let panelPos = panelRatio ? fromRatio(panelRatio, vpPanel()) : null
				const clampFab = () => {
					const vw = window.innerWidth, vh = window.innerHeight
					pos.x = Math.max(4, Math.min(vw - FAB_W - 4, pos.x))
					pos.y = Math.max(4, Math.min(vh - FAB_H - 4, pos.y))
				}
				/** Paint current pixel state: clamp, mirror into ratio, write style.
				 *  Used by drags (which set pos directly) — never re-derives from ratio. */
				const paintFab = () => { clampFab(); ratio = toRatio(pos, vpFab()); fab.style.left = pos.x + 'px'; fab.style.top = pos.y + 'px' }
				/** Full re-layout from the stored ratio (init + viewport resize): the ball
				 *  keeps its corner at any window size, then clamps back on-screen. */
				const placeFab = () => { if (ratio) pos = fromRatio(ratio, vpFab()); paintFab() }
				const placePanel = () => { panel.style.left = panelPos.x + 'px'; panel.style.top = panelPos.y + 'px' }
				/** Position the panel against the ball: just above it (below when near
				 *  the top edge), clamped inside the viewport. */
				const snapPanelToFab = () => {
					const vw = window.innerWidth, vh = window.innerHeight
					const pw = panel.classList.contains('open-drawer') ? 640 : PANEL_W
					const ph = panel.offsetHeight > 0 ? panel.offsetHeight : Math.min(Math.round(vh * 0.7), 520)
					// Panel's right edge hugs the ball's left edge.
					let px = pos.x + FAB_W - pw
					let py = pos.y - ph - PANEL_GAP
					if (py < 8) py = pos.y + FAB_H + PANEL_GAP // ball near top -> panel below
					px = Math.max(8, Math.min(vw - pw - 8, px))
					py = Math.max(8, Math.min(vh - ph - 8, py))
					panelPos = { x: Math.round(px), y: Math.round(py) }
					placePanel()
				}
				placeFab()
				if (panelPos) placePanel()
				// Re-anchor the ball on its stored fraction whenever the viewport
				// changes (maximize / resolution / zoom); an open panel re-snaps to the
				// moved ball, a closed one re-snaps when it next opens.
				window.addEventListener('resize', () => { placeFab(); if (!panel.hidden) snapPanelToFab() })
				let suppressFabClick = false
				/**
				 * Make `el` drag the FAB or the panel (`which` = 'fab' | 'panel').
				 * Movement under ~5px is treated as a click, so the FAB still toggles.
				 * Interactive children (buttons/icons) never start a drag.
				 */
				const makeDraggable = (el: any, which: any) => {
					const state = () => (which === 'fab' ? pos : panelPos)
					let sx = 0, sy = 0, bx = 0, by = 0, active = false, dragged = false
					const down = (e: any) => {
						if (e.button !== 0) return
						if (e.target && e.target.closest) {
							const hit = e.target.closest('button, a, input, [role="button"]')
							if (hit && hit !== el) return
						}
						active = true; dragged = false
						sx = e.clientX; sy = e.clientY
						const s = state(); bx = s.x; by = s.y
						try { el.setPointerCapture(e.pointerId) } catch {}
						el.classList.add('dsh-ego-dragging')
						e.preventDefault()
					}
					const move = (e: any) => {
						if (!active) return
						const dx = e.clientX - sx, dy = e.clientY - sy
						if (!dragged && Math.abs(dx) + Math.abs(dy) > 5) dragged = true
						if (dragged) {
							const s = state(); s.x = bx + dx; s.y = by + dy
							which === 'fab' ? paintFab() : placePanel()
						}
					}
					const up = (e: any) => {
						if (!active) return
						active = false
						el.classList.remove('dsh-ego-dragging')
						try { el.releasePointerCapture(e.pointerId) } catch {}
						if (dragged) {
							if (which === 'fab') suppressFabClick = true
							try {
								const r = toRatio(state(), which === 'fab' ? vpFab() : vpPanel())
								if (which === 'fab') ratio = r; else panelRatio = r
								localStorage.setItem(which === 'fab' ? DRAG_KEY : DRAG_PANEL_KEY, JSON.stringify(r))
							} catch {}
						}
					}
					el.addEventListener('pointerdown', down)
					el.addEventListener('pointermove', move)
					el.addEventListener('pointerup', up)
					el.addEventListener('pointercancel', up)
				}
				// Ball drags the ball; the panel header drags the panel. Independent.
				makeDraggable(fab, 'fab')
				makeDraggable(panel.querySelector('#dsh-ego-head'), 'panel')

				const setOpen = (open: any) => {
					if (open) {
						// Reveal then transition in, so the pop-out animation plays
						// (hidden -> display:flex would otherwise jump with no tween).
						panel.hidden = false
						panel.classList.remove('dsh-ego-panel-hide')
						// Snap the panel next to the ball each time it opens, so it
						// never appears at a surprise location.
						snapPanelToFab()
						// force a reflow so the browser sees the closed state first
						void panel.offsetHeight
						panel.classList.add('dsh-ego-panel-open')
						fab.classList.add('on')
						refresh()
						openStream()
						if (currentActiveId) syncWatch(selectedTabId || currentActiveId)
					} else {
						panel.classList.remove('dsh-ego-panel-open')
						// after the close transition ends, fully hide to free layout.
clearTimeout((panel as any)._dshHideT)
					;(panel as any)._dshHideT = setTimeout(() => {
							panel.classList.add('dsh-ego-panel-hide')
							panel.hidden = true
							fab.classList.remove('on')
						}, 280)
						try { if (sse) sse.close() } catch {}
						sse = null
						stopWatch(false)
						stopVideo()
					}
					try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch {}
				}
				// A real click (not a drag) toggles the panel; a drag suppresses it.
				fab.addEventListener('click', () => {
					if (suppressFabClick) { suppressFabClick = false; return }
					setOpen(panel.hidden)
				})
				closeBtn.addEventListener('click', () => setOpen(false))
				refreshBtn.addEventListener('click', () => {
					// Show a spinner so a manual refresh has clear feedback even when
					// the underlying picture is static (no visible change).
					refreshBtn.classList.add('spinning')
					window.setTimeout(() => refreshBtn.classList.remove('spinning'), 800)
					refresh()
				})
				historyBtn.addEventListener('click', () => setHistory(!historyOpen))

				// Show a login guide when an agent browser is actually showing
				// something, so the user knows where to log in (the separate
				// 'ego lite — agent' Chrome window) and can persist the login.
				const maybeShowLoginGuide = () => {
					if (disposed || dismissedGuides.login) return
					const hasPage = lastList.some(s => s.url && !s.url.startsWith('about:'))
					// Avoid stacking two guide strips above the main view (which would
					// squash it): the captcha strip takes priority when both apply.
					const show = hasPage && !captchaEl.classList.contains('show')
					loginEl.classList.toggle('show', show)
					loginNote.textContent = ''
				}
				// Human-verification (CAPTCHA) reminder: if any live page reports a
				// challenge, flash a strip asking the user to complete it in the
				// 'ego lite — agent' browser window (the same session the panel views).
				const maybeShowCaptchaGuide = () => {
					if (disposed || dismissedGuides.captcha) return
					const hit = lastList.find(s => s.humanCheck && s.humanCheck.detected)
					const show = !!hit
					captchaEl.classList.toggle('show', show)
					if (show && captchaKindEl) captchaKindEl.textContent = hit.humanCheck.kind || 'captcha'
				}
				// "已登录，保存" → POST /api/bcdp/flush, which forces the agent
				// browser's persistent cookies down to its on-disk profile so a
				// later DSH/browser restart does not drop the login.
				loginBtn.addEventListener('click', () => {
					void (async () => {
						loginBtn.classList.add('saving')
						loginBtn.textContent = wt('loginSaving')
						try {
							const r = await fetch(FLUSH_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
							const j = await r.json()
							if (j && j.ok) loginNote.textContent = wt('loginSaved', { n: j.total ?? '' })
							else loginNote.textContent = (j?.error ? wt('loginNotConnected') : wt('loginFailed'))
						} catch {
							loginNote.textContent = wt('loginFailed')
						} finally {
							loginBtn.classList.remove('saving')
							loginBtn.textContent = wt('loginBtn')
						}
					})()
				})

				document.body.appendChild(fab)
				document.body.appendChild(panel)

				// Start collapsed: the FAB is the persistent entry point and should
				// not disappear just because a previous session left the panel open.
				// Ignore any stale OPEN_KEY so the ball always shows on load.
				try { localStorage.removeItem(OPEN_KEY) } catch {}
				panel.hidden = true
				fab.classList.remove('on')
				refresh()
				const onVisibility = () => { if (document.visibilityState !== 'hidden' && !panel.hidden) { if (!sse) openStream(); syncWatch(selectedTabId || currentActiveId) } }
				document.addEventListener('visibilitychange', onVisibility)

				return () => {
					disposed = true
					if (liveFlushRaf != null) try { window.cancelAnimationFrame(liveFlushRaf) } catch {}
					if (followTimer) window.clearTimeout(followTimer)
					if (reconnectFallbackTimer) window.clearTimeout(reconnectFallbackTimer)
					document.removeEventListener('visibilitychange', onVisibility)
					if (watchRenewTimer) window.clearInterval(watchRenewTimer)
					if (watchStopTimer) window.clearTimeout(watchStopTimer)
					stopWatch(true); stopVideo()
					keyboardProxy.dispose()
					try { pickCtl.disable() } catch {}
					try { if (sse) sse.close() } catch {}
					fab.remove()
					panel.remove()
					style.remove()
				}
		}

		// ── Sidebar Tab (React UI + vanilla LivePreviewController) ─────────────
		// Registered via ctx.betterSidebar.registerTab() when the sidebar service
		// is available. The Tab reuses the same /api/bcdp/spaces + /api/bcdp/stream
		// data sources as the floating panel but renders through React into the
		// sidebar's tab content area instead of a fixed-position overlay.
		var INPUT_ROUTE = '/api/bcdp/input'
		var FLUSH_ROUTE = '/api/bcdp/flush'
		var FRAME_FOLLOW_MIN_MS = 350

		// ── Tab CSS (scoped under .dsh-ego-side-root) ──────────────────────────
		// Separate from PANEL_CSS (the floating panel's styles): the Tab lives
		// inside the sidebar's content area, so no fixed positioning / FAB / drag.
		// Selectors are class-scoped to avoid clashing with the floating panel's
		// #dsh-ego-* IDs (both paths can coexist in the bundle, only one runs).
		var TAB_CSS = `
.dsh-ego-side-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  overflow: hidden; color: inherit; background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.dsh-ego-side-root * { box-sizing: border-box; }

.dsh-ego-side-head {
  display: flex; align-items: center; gap: 4px; padding: 8px 10px;
  border-bottom: 1px solid rgba(128,128,128,.18); flex-shrink: 0;
}
.dsh-ego-side-title {
  flex: 1; font-size: 12.5px; font-weight: 600; letter-spacing: .2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  display: flex; align-items: center; gap: 5px; opacity: .85;
}
.dsh-ego-side-title svg { width: 14px; height: 14px; flex-shrink: 0; }
.dsh-ego-side-iconbtn {
  background: transparent; border: none; cursor: pointer;
  width: 26px; height: 26px; border-radius: 7px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  color: inherit; opacity: .6;
  transition: background .15s ease, opacity .15s ease;
}
.dsh-ego-side-iconbtn:hover { background: rgba(128,128,128,.18); opacity: 1; }
.dsh-ego-side-iconbtn.off { opacity: .4; }
.dsh-ego-side-iconbtn.spinning svg { animation: dsh-ego-side-spin .7s linear infinite; }
@keyframes dsh-ego-side-spin { to { transform: rotate(360deg); } }

/* ---- guide strips (login / captcha) ---- */
.dsh-ego-side-login, .dsh-ego-side-captcha {
  display: flex; align-items: center; gap: 7px; margin: 0 10px 7px; padding: 6px 9px;
  border-radius: 8px; font-size: 11px; line-height: 1.4;
}
.dsh-ego-side-login {
  border: 1px solid rgba(255,214,10,.3); background: rgba(255,214,10,.1);
}
.dsh-ego-side-captcha {
  border: 1px solid rgba(255,69,58,.4); background: rgba(255,69,58,.13);
}
.dsh-ego-side-login .dsh-ego-side-login-txt { flex: 1; min-width: 0; }
.dsh-ego-side-login .dsh-ego-side-login-txt b { color: #ffd60a; }
.dsh-ego-side-login-btn {
  flex: none; background: #0a84ff; color: #fff; border: none; border-radius: 7px;
  font-size: 10.5px; padding: 4px 9px; cursor: pointer; white-space: nowrap;
  transition: background .15s ease;
}
.dsh-ego-side-login-btn:hover { background: #338cff; }
.dsh-ego-side-login-btn.saving { opacity: .55; pointer-events: none; }
.dsh-ego-side-login-note { flex: none; font-size: 10px; opacity: .6; white-space: nowrap; }
.dsh-ego-side-captcha-txt { flex: 1; min-width: 0; }
.dsh-ego-side-captcha-txt b { color: #ff6961; }
.dsh-ego-side-captcha-kind {
  flex: none; font-size: 9.5px; padding: 2px 7px; border-radius: 999px;
  background: rgba(255,255,255,.15); text-transform: uppercase; letter-spacing: .3px;
}

/* ---- tab strip: frosted pills ---- */
.dsh-ego-side-tabs {
  display: flex; gap: 5px; padding: 7px 10px; flex-shrink: 0;
  border-bottom: 1px solid rgba(128,128,128,.12);
  overflow-x: auto; scrollbar-width: thin;
}
.dsh-ego-side-tabs:empty { display: none; }
.dsh-ego-side-tab {
  display: inline-flex; align-items: center; gap: 5px; max-width: 160px;
  white-space: nowrap; padding: 4px 10px; border-radius: 999px; cursor: pointer;
  font-size: 11px; flex-shrink: 0;
  border: 1px solid rgba(128,128,128,.2); background: rgba(128,128,128,.12);
  opacity: .7; transition: background .15s, opacity .15s, border-color .15s;
}
.dsh-ego-side-tab > .dsh-ego-side-tabtxt { overflow: hidden; text-overflow: ellipsis; }
.dsh-ego-side-tab:hover { opacity: 1; background: rgba(128,128,128,.2); }
.dsh-ego-side-tab.active {
  background: #0a84ff; color: #fff; border-color: transparent; opacity: 1;
  box-shadow: 0 2px 8px rgba(10,132,255,.3);
}
.dsh-ego-side-tabdot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .5; flex-shrink: 0; }
.dsh-ego-side-tab.active .dsh-ego-side-tabdot { background: #fff; opacity: 1; }
.dsh-ego-side-tabclose {
  flex-shrink: 0; width: 13px; height: 13px; line-height: 12px; text-align: center;
  border-radius: 50%; font-size: 11px; opacity: .5; margin-left: 1px;
}
.dsh-ego-side-tabclose:hover { background: rgba(255,255,255,.2); color: #ff453a; opacity: 1; }

/* ---- main body ---- */
.dsh-ego-side-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; }
.dsh-ego-side-empty { padding: 20px 12px; text-align: center; font-size: 12px; opacity: .5; line-height: 1.7; }

.dsh-ego-side-liveview { display: flex; flex-direction: column; gap: 7px; min-height: 60px; overflow: hidden; }
.dsh-ego-side-livebadge {
  font-size: 10.5px; opacity: .6; letter-spacing: .2px;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.dsh-ego-side-state-dot {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: #30d158; box-shadow: 0 0 5px #30d15888; flex-shrink: 0;
  animation: dsh-ego-side-breathe 2.4s ease-in-out infinite;
}
.dsh-ego-side-state-dot.busy { background: #30d158; box-shadow: 0 0 6px #30d158bb; animation: none; }
.dsh-ego-side-state-dot.pin { background: #0a84ff; box-shadow: 0 0 5px #0a84ff88; animation: none; }
@keyframes dsh-ego-side-breathe {
  0%, 100% { box-shadow: 0 0 2px #30d15822; opacity: .5; }
  50%      { box-shadow: 0 0 10px #30d158ee; opacity: 1; }
}
.dsh-ego-side-back {
  background: rgba(128,128,128,.18); border: 1px solid rgba(128,128,128,.2);
  border-radius: 6px; cursor: pointer; font-size: 10.5px; padding: 2px 8px;
  display: inline-flex; align-items: center; gap: 3px;
  transition: background .15s ease; color: inherit;
}
.dsh-ego-side-back:hover { background: rgba(128,128,128,.3); }
.dsh-ego-side-back.dsh-ego-pick-on { background: rgba(56,189,248,.28); color: #0ea5e9; }
.dsh-ego-side-liveimg {
  width: 100%; border-radius: 9px; display: block;
  max-height: 50vh; object-fit: contain;
  border: 1px solid rgba(128,128,128,.2); background: #000;
  user-select: none; -webkit-user-select: none; touch-action: none;
  will-change: transform; cursor: grab;
}
.dsh-ego-side-livetitle { font-size: 12px; font-weight: 600; }
.dsh-ego-side-liveurl { font-size: 10.5px; opacity: .55; word-break: break-all; }
.dsh-ego-side-liveurl.dsh-ego-side-hint { color: #75c2ff; font-style: italic; font-weight: 500; opacity: 1; }
.dsh-ego-side-hint { animation: dsh-ego-side-hint-in .2s ease; }
@keyframes dsh-ego-side-hint-in { from { opacity: .3 } to { opacity: 1 } }

/* ---- history overlay (covers the body area) ---- */
.dsh-ego-side-history {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  overflow: hidden;
}
.dsh-ego-side-historyhead {
  padding: 8px 10px; font-size: 11px; font-weight: 600; opacity: .6;
  display: flex; align-items: center; gap: 5px;
  border-bottom: 1px solid rgba(128,128,128,.1); flex-shrink: 0;
}
.dsh-ego-side-historyhead svg { width: 11px; height: 11px; }
.dsh-ego-side-historylist { overflow-y: auto; padding: 5px; }
.dsh-ego-side-hitem {
  display: flex; gap: 7px; align-items: center; padding: 5px; border-radius: 8px;
  cursor: pointer; transition: background .15s ease;
}
.dsh-ego-side-hitem:hover { background: rgba(128,128,128,.15); }
.dsh-ego-side-hitem.active { background: rgba(10,132,255,.15); }
.dsh-ego-side-hthumb {
  width: 52px; height: 38px; border-radius: 5px; object-fit: cover; background: #000;
  flex-shrink: 0; border: 1px solid rgba(128,128,128,.2);
}
.dsh-ego-side-hinfo { min-width: 0; flex: 1; }
.dsh-ego-side-htitle { font-size: 10px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-ego-side-hurl { font-size: 9.5px; opacity: .5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-ego-side-hactive { color: #30d158; font-size: 9.5px; }
.dsh-ego-side-hnone { padding: 16px 8px; text-align: center; font-size: 10.5px; opacity: .4; }
`

		// ── LivePreviewController ───────────────────────────────────────────────
		// Vanilla class holding all mutable watch state + SSE/poll/input/zoom
		// logic. Extracted from the floating panel's imperative DOM code so the
		// React Tab component can subscribe to a snapshot store and delegate
		// pointer/wheel events to controller methods. The controller holds a ref
		// to the live <img> element (set via setLiveImg) so it can swap src in
		// place at rAF cadence without triggering React re-renders per frame.
		// `ctx` is stored so the controller can call ctx.get('betterSidebar')
		// to auto-open the Tab on the first bcdp_* tool call.
		/**
		 * M1.6 — quote a picked element into the conversation composer.
		 * 2026-09-23 revision 2: NO auto-submit, ever. Elements from ONE page
		 * accumulate into ONE dictionary block, wrapped like the image
		 * attachments are — the block carries its source CDP connection
		 * (endpoint + targetId) so the agent can find the element's DOM again
		 * (backendNodeId is directly addressable via bcdp_cdp DOM.describeNode).
		 * Format inside the draft（@mention 精髓：被替换字段以 @ 开头）:
		 *   @"picks/<file>.json"
		 * — 显示层把该 token 替换成文件片；归档 JSON
		 *   {"cdpEndpoint":..., "targetId":..., "pageUrl":..., "elements":[...]}
		 *   存 <workspace>/picks/<file>.json，dock 卡按引用取回渲染。
		 */
		// ── 点选引用卡（conversation.input.dock 贡献者，order 0 = todo 同级）──
		// @mention 模型：composer 只留 @"picks/<file>.json" 短引用（宿主显示层
		// 把它替换成文件片），卡片按引用异步取回归档内容渲染 chip；同页合并
		// 改写归档后每 5s 重读刷新；✕ 只摘引用 token（归档文件保留）。样式走
		// 幂等 <style>（不透明实底 + input-traffic 同款限宽公式 + auto margins
		// 居中，亮暗双态）。
		// 诊断：window.__dshBrowserCdpDeco { stage, refs, draftLen }。
		function injectPickCardStyles() {
			if (document.getElementById('dsh-cdp-picks-styles') !== null) return
			var style = document.createElement('style')
			style.id = 'dsh-cdp-picks-styles'
			style.textContent = "[data-dsh-cdp-picks-card] {\n  box-sizing: border-box; flex: none;\n  display: grid; gap: 4px; padding: 8px 10px;\n  font: inherit; font-size: 12px;\n  color: #1d1d1f; background: #f7f7f9;\n  border: 1px solid rgba(0, 0, 0, 0.16); border-radius: 12px;\n  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);\n  /* input-traffic 同款限宽 + 居中：卡宽限制在内容列（拖动范围）内，两侧留出\n     clearance，auto margins 在 dock 带内居中，永不顶满整窗 */\n  margin-left: auto;\n  margin-right: auto;\n  width: min(\n    calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px)),\n    calc(var(--dsh-chat-content-width, 100%) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))\n  );\n  overflow-y: auto; max-height: 40vh;\n}\n@media (prefers-color-scheme: dark) {\n  [data-dsh-cdp-picks-card] { color: #f2f2f7; background: #1c1c1e; border-color: rgba(255, 255, 255, 0.18); }\n}\n[data-dsh-cdp-picks-card] .dsh-cdp-picks-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }\n[data-dsh-cdp-picks-card] .dsh-cdp-picks-sub { font-size: 11px; color: rgba(60, 60, 67, 0.62); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }\n[data-dsh-cdp-picks-card] .dsh-cdp-picks-chip { display: flex; align-items: baseline; gap: 6px; padding: 3px 8px; background: rgba(120, 120, 128, 0.12); border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 8px; min-width: 0; }\n[data-dsh-cdp-picks-card] .dsh-cdp-picks-num { font-weight: 700; flex: none; color: rgba(60, 60, 67, 0.62); }\n[data-dsh-cdp-picks-card] .dsh-cdp-picks-tag { font-weight: 600; flex: none; }\n[data-dsh-cdp-picks-card] .dsh-cdp-picks-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }\n[data-dsh-cdp-picks-card] .dsh-cdp-picks-close { margin-left: auto; flex: none; font: inherit; font-size: 12px; cursor: pointer; border: none; background: none; color: rgba(60, 60, 67, 0.62); padding: 0 2px; border-radius: 6px; }\n[data-dsh-cdp-picks-card] .dsh-cdp-picks-close:hover { background: rgba(120, 120, 128, 0.18); }\n@media (prefers-color-scheme: dark) {\n  [data-dsh-cdp-picks-card] .dsh-cdp-picks-sub { color: rgba(235, 235, 245, 0.62); }\n  [data-dsh-cdp-picks-card] .dsh-cdp-picks-chip { background: rgba(120, 120, 128, 0.24); border-color: rgba(255, 255, 255, 0.12); }\n  [data-dsh-cdp-picks-card] .dsh-cdp-picks-num { color: rgba(235, 235, 245, 0.62); }\n  [data-dsh-cdp-picks-card] .dsh-cdp-picks-close { color: rgba(235, 235, 245, 0.62); }\n  [data-dsh-cdp-picks-card] .dsh-cdp-picks-close:hover { background: rgba(120, 120, 128, 0.3); }\n}"
			document.head.appendChild(style)
		}
		function CdpPicksDockCard(props: any) {
			var input = props.input
			var h = React.createElement
			var tick = React.useState(0)
			var setTick = tick[1]
			// 宿主标准 props（SessionStandardProps）带 Session 身份 + 公共输入动作
			// ——latch 供 deliver 插原子引用片用（effect 里写，render 期无副作用）
			var offeredSession = props && props.sessionId !== undefined && props.sessionId !== null ? String(props.sessionId) : null
			var offeredActions = props && props.inputActions ? props.inputActions : null
			React.useEffect(function () {
				if (offeredSession === null) return
				latchPickInputActions(offeredSession, offeredActions)
			}, [offeredSession, offeredActions])
			// picks-load 的会话来源：inject 下发的字符串优先，宿主标准 props 兜底
			var sid = typeof props.session === 'string' && props.session !== '' ? props.session : offeredSession
			React.useEffect(function () {
				var timer = window.setInterval(function () { setTick(function (n: any) { return n + 1 }) }, 1000)
				return function () { window.clearInterval(timer) }
			}, [])
			var snap = readDraftText(input)
			var refRe = /@"(picks\/[^"\s]+\.json)"/g
			var refs: any[] = [], mm
			while ((mm = refRe.exec(snap)) !== null) refs.push({ file: mm[1], line: mm[0] })
			try { (window as any).__dshBrowserCdpDeco = { stage: refs.length ? 'rendered' : 'no-refs', refs: refs.length, draftLen: snap.length, sid: sid ? 'yes' : 'no', latch: pickInputActionsLatch.sessionId ? 'yes' : 'no' } } catch (e) {}
			var loadedState = React.useState({})
			var contents = loadedState[0], setContents = loadedState[1]
			var errState = React.useState({})
			var errs = errState[0], setErrs = errState[1]
			var filesKey = refs.map(function (r: any) { return r.file }).join('|')
			// 归档文件可能被同页合并改写（deliver 原文件重写），快照里看不出——
			// 每 5s 重读一次引用的归档（本地文件读，开销可忽略），token→归档名
			// 去掉 picks/ 前缀（网关文件名校验只收 basename）。失败显码不吞：
			// 计数恒 0 而用户看不到原因是上次真机排障的最大代价。
			React.useEffect(function () {
				var cancelled = false
				refs.forEach(function (r: any) {
					postJson('/bcdp/api/picks-load', { file: r.file.slice('picks/'.length), session: sid }).then(function (res: any) {
						if (cancelled) return
						if (res && res.ok !== false && res.value) {
							var content = String(res.value.content || '')
							setContents(function (prev: any) { var n = Object.assign({}, prev); n[r.file] = content; return n })
							setErrs(function (prev: any) { if (!(r.file in prev)) return prev; var n = Object.assign({}, prev); delete n[r.file]; return n })
						} else {
							var code = res && res.error && res.error.code ? String(res.error.code) : 'load-failed'
							setContents(function (prev: any) { var n = Object.assign({}, prev); n[r.file] = ''; return n })
							setErrs(function (prev: any) { var n = Object.assign({}, prev); n[r.file] = code; return n })
						}
					}).catch(function () {
						if (cancelled) return
						setContents(function (prev: any) { var n = Object.assign({}, prev); n[r.file] = ''; return n })
						setErrs(function (prev: any) { var n = Object.assign({}, prev); n[r.file] = 'load-failed'; return n })
					})
				})
				return function () { cancelled = true }
			}, [filesKey, Math.floor(tick[0] / 5)])
			if (refs.length === 0) return null
			function removeRef(line: any) {
				var cur = readDraftText(input)
				var idx = cur.indexOf(line)
				if (idx < 0) return
				var next = cur.slice(0, idx) + cur.slice(idx + line.length)
				next = next.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '')
				input.setDraft(next)
			}
			return h('div', { style: { display: 'grid', gap: '6px' } }, refs.map(function (r: any) {
				var content = contents[r.file]
				var elements: any[] = []
				var pageTitle = ''
				if (typeof content === 'string' && content !== '') {
					try { var obj = JSON.parse(content); elements = (obj && obj.elements) || []; pageTitle = (obj && obj.pageTitle) || '' } catch (e) { pageTitle = '' }
				}
				// 计数三态：空内容不给 0——要么加载中（…），要么亮错误码（⚠ no-workspace
				// / not-found / load-failed），用户看得见故障不再瞎猜。
				var countText: any
				if (typeof content !== 'string' || content === '') countText = errs[r.file] ? '⚠ ' + errs[r.file] : '…'
				else countText = wt('pickCardElements', { n: elements.length })
				var head = h('div', { className: 'dsh-cdp-picks-head' },
					h('span', { style: { fontWeight: 700 } }, '🌐 ' + wt('pickCardTitle')),
					h('span', { className: 'dsh-cdp-picks-sub' }, '@' + r.file),
					h('span', { className: 'dsh-cdp-picks-sub' }, pageTitle),
					h('span', { className: 'dsh-cdp-picks-sub' }, countText),
					h('button', { type: 'button', title: wt('pickCardRemove'), className: 'dsh-cdp-picks-close', onClick: function () { removeRef(r.line) } }, '✕'))
				var chips: any = []
				if (typeof content !== 'string') chips.push(h('div', { key: 'loading', className: 'dsh-cdp-picks-sub' }, '…'))
				for (var i = 0; i < elements.length && i < 6; i++) {
					var el = elements[i] || {}
					chips.push(h('div', { key: el.n || i, className: 'dsh-cdp-picks-chip' },
						h('span', { className: 'dsh-cdp-picks-num' }, '#' + (el.n || (i + 1))),
						h('span', { className: 'dsh-cdp-picks-tag' }, el.tag || '?'),
						h('span', { className: 'dsh-cdp-picks-desc' }, el.describe || el.name || '')))
				}
				if (elements.length > 6) chips.push(h('div', { key: 'more', className: 'dsh-cdp-picks-sub' }, '… +' + (elements.length - 6)))
				return h('div', { key: r.file, 'data-dsh-cdp-picks-card': '' }, head, chips)
			 }))
		}
		

		// ── 点选引用徽标（conversation.input.overlay 贡献者）────────────────
		// 草稿含我们的引用行时，composer 卡内浮出 🌐 徽标（paste-dock 文档徽标的
		// 同位）——悬停显示连接/页面/元素数。组件按会话探测，解析不了渲染 null。
		function CdpPicksBadge(props: any) {
			var h = React.createElement
			var tick = React.useState(0)
			var setTick = tick[1]
			React.useEffect(function () {
				var timer = window.setInterval(function () { setTick(function (n: any) { return n + 1 }) }, 1000)
				return function () { window.clearInterval(timer) }
			}, [])
			var refs: any[] = []
			try {
				var sessionId = props && props.sessionId !== undefined && props.sessionId !== null ? String(props.sessionId) : null
				var sid = sessionId
				if (sid) {
					var draft = typeof props.getDraft === 'function' ? String(props.getDraft() || '') : ''
					var refRe = /\[(?:🌐 )?CDP-PICKS/g
					var countRefs = (draft.match(refRe) || []).length
					var refRe2 = /@"(picks\/[^"\s]+\.json)"/g
					var mm
					while ((mm = refRe2.exec(draft)) !== null) refs.push({ file: mm[1] })
				}
			} catch (e) {}
			try { (window as any).__dshBrowserCdpDeco = Object.assign({}, (window as any).__dshBrowserCdpDeco, { badgeRefs: refs.length, blockMarkers: countRefs }) } catch (e) {}
			if (refs.length === 0) return null
			return h('div', { className: 'dsh-cdp-picks-badges' }, refs.map(function (r: any, i: any) {
				return h('span', { key: r.file, className: 'dsh-cdp-picks-badge', title: '🌐 @' + r.file }, '🌐' + (refs.length > 1 ? ' ×' + (i + 1) : ''))
			}))
		}

		// 注册：order 110 = 排在 paste-dock 徽标（90/100）之后。
		function mountPicksBadge(ctx: any) {
			ctx.slots.inject('conversation.input.overlay', function () {
				return ctx.slots.register({
					name: 'conversation.input.overlay',
					id: 'dsh-browser-cdp.picks-badge',
					order: 110,
					label: 'dsh-browser-cdp picks badge',
				}, CdpPicksBadge)
			}, 'dsh-browser-cdp: picks badge')
		}

		// 注册：order 0 = 与 todo 同级（带区上沿、浮在对话区一侧）；无 priority
		// 字段（独立 cell id）。dsh-input-traffic/paste-dock 同缝。
		function mountPicksDockCard(ctx: any) {
			injectPickCardStyles()
			try { (window as any).__dshBrowserCdpDeco = Object.assign({}, (window as any).__dshBrowserCdpDeco, { stage: 'registered' }) } catch (e) {}
			ctx.slots.inject('conversation.input.dock', function () {
				return ctx.slots.register({
					name: 'conversation.input.dock',
					id: 'dsh-browser-cdp.picks',
					locale: 'dsh-browser-cdp',
					order: 0,
					inject: function (sessionId: any) {
						var input: any = null, session: any = null
						try {
							var actx = ctx.sessions.scope(sessionId)
							var conversation = actx.get('conversation')
							input = conversation.input.for(actx)
							session = String(sessionId)
						} catch (e) { input = null; session = null }
						return {
							input: input,
							session: session,
							getDraft: function () { return readDraftText(input) }
						}
					},
				}, CdpPicksDockCard)
			}, 'dsh-browser-cdp: picks dock card')
		}
		// 草稿活值读取：0.1.7-rc.1+ 的 input 门面把 Lexical 编辑器的文本真值暴露为
		// `input.draft`（facade.ts `readonly draft: string`）；`input.state.getSnapshot()`
		// 是 InputState 组合快照（phase/queue/notices/projections），没有 draft 字段——
		// 读它恒得空串。门面字段优先，state 快照兜底。
		function readDraftText(input: any) {
			if (!input) return ''
			try { if (typeof input.draft === 'string') return input.draft } catch (e) {}
			try {
				var snap = input.state && input.state.getSnapshot ? input.state.getSnapshot() : null
			if (snap && typeof snap.draft === 'string') return snap.draft
			} catch (e) {}
			return ''
		}

		// 「当前会话」推导：宿主在 0.1.6-alpha.2（6830e1460d）把 list 快照的
		// `current` 字段删掉了（契约注释 "navigation belongs to view owners"），
		// 现行推导 = 扫 byId 找 retainedBy.mainView > 0 的行——与宿主侧边栏同款
		// （ui-workspace tree.ts:40）。≤0.1.6 快照仍有 current，兼容读取放最前。
		// （dsh-arrowkey-nav 同款破坏点：点选投递一直读 current，在 0.1.7/0.2.0
		// 上恒 undefined → no-active-session → 输入框无变化。）
		function currentSessionId(list: any) {
			if (!list || typeof list !== 'object') return ''
			if (typeof list.current === 'string') return list.current
			var byId = list.byId
			if (!byId || typeof byId !== 'object') return ''
			var ids = Object.keys(byId)
			for (var i = 0; i < ids.length; i++) {
				var row = byId[ids[i]]
				if (row && row.retainedBy && ((row.retainedBy.mainView ?? 0) > 0)) return ids[i]
			}
			return ''
		}

		// Session 槽位渲染时 latch 的公共输入动作（dsh-paste-dock 同款）：
		// captureInsertion() 是宿主 insertReference CAS 校验的 TokenSpan 唯一
		// 合法来源，只能在槽位组件 props（SessionStandardProps）里拿到。按
		// session 配对，切会话后旧 actions 不可跨用。
		var pickInputActionsLatch: any = { sessionId: null, actions: null }
		function latchPickInputActions(sessionId: any, actions: any) {
			if (!sessionId || !actions || typeof actions.captureInsertion !== 'function') return
			pickInputActionsLatch = { sessionId: String(sessionId), actions: actions }
		}
		// 引用片前的边界空格：宿主两处引用扫描都锚定 (^|\s)，片紧贴前字符时
		// 两处都看不见（paste-dock 2026-10-02 实测）。从 composer DOM 读 caret
		// 前文本；拿不准就给空格——多余空格无害，缺边界误整个特性。
		// 归档文件名 slug：时间戳名对识别没用（真机反馈），用首元素特征的开头
		// 几个字符（describe → name → tag 兜底页标题）——清成网关文件名白名单
		// [A-Za-z0-9._-]，中文等清空时回退时间戳。后缀保留 5 位 base36 时间：
		// 不同页面的同特征元素各归各档，防同名归档互相覆盖。
		function pickSlugOf(entry: any) {
			var raw = String((entry && entry.name) || (entry && entry.describe) || (entry && entry.tag) || '')
			raw = raw.replace(/["'`]/g, '').trim()
			return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '').slice(0, 12).replace(/-+$/, '')
		}
		function pickArchiveFileName(entry: any) {
			var slug = pickSlugOf(entry)
			var tail = Date.now().toString(36).slice(-5)
			return slug ? 'picks-' + slug + '-' + tail + '.json' : 'picks-' + tail + '.json'
		}
		function needsBoundarySpace() {
			var root: any = document.querySelector('[data-input-scroll] [contenteditable="true"]')
			var selection = window.getSelection()
			if (root === null || selection === null || selection.rangeCount === 0) return true
			var caret = selection.getRangeAt(0)
			if (!root.contains(caret.startContainer)) return true
			var before = document.createRange()
			before.selectNodeContents(root)
			before.setEnd(caret.startContainer, caret.startOffset)
			var text = before.toString()
			if (text === '') return false
			return !/\s/u.test(text.slice(-1))
		}
		// 把归档引用插成 composer 的原子引用片（ReferenceChipNode，宿主自家附件
		// 同款）：箭头跨步、退格整片删除、显示层就是"替换后的 @ 字段"。插入前
		// 先 serializeReference 做能力证明（发送路径读同一注册表，字符串应答 =
		// 发送不会抛）。任何一步不成 → false，调用方回退文本 token。
		async function tryInsertPickChip(ctx: any, sessionId: any, actx: any, input: any, token: any, label: any) {
			try {
				var latch = pickInputActionsLatch
				if (!latch.actions || latch.sessionId !== String(sessionId)) return false
				var triggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : null
				var controller = triggers && typeof triggers.sessionOf === 'function' ? triggers.sessionOf(actx) : null
				var modelText = controller && typeof controller.serializeReference === 'function'
					? await controller.serializeReference('reference', token, new AbortController().signal)
					: null
				if (typeof modelText !== 'string') return false
				if (needsBoundarySpace() && typeof input.insertText === 'function') {
					input.insertText(' ', latch.actions.captureInsertion())
				}
				// 空格编辑挪动了 draftRev，insertReference CAS 校验 span——必须重取
				var span = latch.actions.captureInsertion()
				return input.insertReference({ source: 'reference', ref: token, label: label || '🌐 ' + token.slice(1, -1), appearance: 'file', clipboardText: token }, span) === true
			} catch (e) {
				return false
			}
		}

		function deliverPickToConversation(ctx: any, element: any, action: any) {
			try {
				var describe = element && typeof element.describe === 'string' ? element.describe : ''
				if (describe === '') return { ok: false, code: 'empty-describe' }
				if (action !== 'quote') return { ok: false, code: 'bad-action' }
				var sessionId = currentSessionId(ctx.sessions.list.getSnapshot())
				if (!sessionId) return { ok: false, code: 'no-active-session' }
				var actx = ctx.sessions.scope(sessionId)
				if (!actx) return { ok: false, code: 'no-session-scope' }
				var conversation = ctx.get('conversation')
				if (!conversation || !conversation.input) return { ok: false, code: 'no-conversation-service' }
				var input = conversation.input.for(actx)
				if (!input || typeof input.setDraft !== 'function') return { ok: false, code: 'no-input-facade' }
				var draft = readDraftText(input)
				var src = element.source || { endpoint: '', targetId: '', pageUrl: '', pageTitle: '' }
				var entry = { n: 1, backendNodeId: element.backendNodeId, tag: element.tag, id: element.id, name: element.name, focusable: !!element.keyboardFocusable, describe: describe }
				// @mention 模型（dsh-paste-dock 的 @"…" 同精髓）：块体归档进会话工作区
				// 的 picks/ 目录（网关按 session 经 workspaceRegistry 解析），composer
				// 只留 @"picks/<file>.json" 短引用——被替换字段以 @ 开头，显示层替换
				// 成文件片，本插件的 dock 卡按引用取回归档渲染 chip。同页合并 = 扫
				// 草稿各引用 → 逐个读归档比对 cdpEndpoint → 命中者原文件重写（token
				// 不含元素数，草稿无需改动）。
				var reRef = /@"(picks\/([^"\s]+\.json))"/g
				var mentions: any[] = [], mm
				while ((mm = reRef.exec(draft)) !== null) mentions.push({ token: mm[0], file: mm[2] })
				void (async function () {
					try {
						var found: any = null, hit: any = null, obj: any = null
						for (var i = 0; i < mentions.length; i++) {
							var lres = await postJson('/bcdp/api/picks-load', { file: mentions[i].file, session: sessionId })
							if (!lres || lres.ok === false || !lres.value) continue
							obj = JSON.parse(lres.value.content)
							if (obj && obj.cdpEndpoint === src.endpoint) { found = mentions[i]; hit = obj.elements || []; break }
						}
						if (found) {
							// 同页合并：追加本元素 → 原文件重写（token 不变）
							var maxN = 0
							for (var k = 0; k < hit.length; k++) if (hit[k].n > maxN) maxN = hit[k].n
							entry.n = maxN + 1
							hit.push(Object.assign({}, entry))
							var page = { cdpEndpoint: obj.cdpEndpoint || src.endpoint, targetId: obj.targetId || src.targetId, pageUrl: obj.pageUrl || src.pageUrl, pageTitle: obj.pageTitle || src.pageTitle, elements: hit }
							await postJson('/bcdp/api/picks-save', { block: JSON.stringify(page, null, 2), file: found.file, session: sessionId })
							return
						}
						// 首次投递：新归档文件（首元素特征 slug 名，可识别）+ @"picks/…"
						// 引用入草稿——优先插原子引用片（宿主附件同款，显示层替换即片
						// 本体），插不进再回退文本 token（空框不加换行）。
						var pageNew = { cdpEndpoint: src.endpoint, targetId: src.targetId, pageUrl: src.pageUrl, pageTitle: src.pageTitle, elements: [Object.assign({ n: 1 }, entry)] }
						var newFile = pickArchiveFileName(entry)
						var sres = await postJson('/bcdp/api/picks-save', { block: JSON.stringify(pageNew, null, 2), file: newFile, session: sessionId })
						if (!sres || sres.ok === false || !sres.value) return
						var token = '@"picks/' + sres.value.file + '"'
						var chipLabel = '🌐 ' + (pickSlugOf(entry) || sres.value.file.replace(/\.json$/, ''))
						var chipOk = await tryInsertPickChip(ctx, sessionId, actx, input, token, chipLabel)
						if (!chipOk) {
							var cur = readDraftText(input)
							cur = cur ? cur + (cur.charAt(cur.length - 1) === '\n' ? '' : '\n') + token : token
							input.setDraft(cur)
						}
					} catch (e) {}
				})()
				return { ok: true, code: 'archiving', count: 1 }
			} catch (err) {
				return { ok: false, code: 'deliver-failed', message: String((err && err.message) || err) }
			}
		}
		// T5.3 — the panel pick state machine. Both observation windows share
		// this control: POST toggles the worker's resident-connection picker,
		// GET polls the state to observe (`lastPick`/`lastAction` arrive via
		// the worker's event subscription, never page polling). Tab switches
		// and unmount disable the mode and strip the injected UI (T5.21).
		// `deliver(element, action)` is the M1.6 seam — the conversation write
		// path — invoked exactly once per delivered pick.
		function createPickControl(onState: any, deliver: any) {
			var enabled = false
			var timer: any = null
			var seenPicks = 0
			var deliveredPicks = -1
			var request: any = null
			function emit(pick: any, message: any) { onState(pick, message) }
			function stopPolling() {
				if (timer) { window.clearInterval(timer); timer = null }
			}
			function post(enabledNow: any, targetId: any) {
				var body: { enabled: unknown; targetId?: string } = { enabled: enabledNow }
				if (targetId) body.targetId = targetId
				return fetch('/api/bcdp/pick', {
					method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
				}).then(function (r) { return r.json().catch(function (): any { return null }) }).catch(function (): any { return null })
			}
			function applyState(state: any) {
				if (!state || typeof state !== 'object') return
				// M1.6: deliver exactly once per pick — the worker re-arms fast,
				// so the reliable trigger is `picks` advancing with an action set.
				if (state.lastPick && state.lastAction && state.picks !== deliveredPicks && typeof deliver === 'function') {
					deliveredPicks = state.picks
					var result = deliver(state.lastPick, state.lastAction)
					if (result && result.ok) {
						emit('picked', wt('pickQuoted') + ' (' + result.count + ')')
					} else {
						emit('failed', wt('pickDeliverFailed') + (result && result.code ? ' (' + result.code + ')' : ''))
					}
				}
				if (state.picks !== seenPicks) seenPicks = state.picks
				if (state.enabled) {
					emit('on', state.code === 'picking' ? wt('picking') : (state.message || wt('picking')))
				} else if (state.code === 'picked') {
					// Intermediate: the element is captured and the page bar is
					// waiting for an action — not a failure, not yet delivered.
					emit('picked', state.lastPick ? state.lastPick.describe : wt('picked'))
				} else if (state.code && state.code !== 'idle' && state.code !== 'delivered') {
					emit('failed', state.message || state.code)
					enabled = false
					stopPolling()
				} else if (!state.enabled) {
					// Delivered or idle: the picker re-arms itself after an action,
					// so reaching here disabled means the worker is done.
					enabled = false
					stopPolling()
					if (state.code === 'idle' && !(state.lastPick && state.lastAction)) emit('off', '')
				}
			}
			function pollOnce() {
				if (request) return
				request = fetch('/api/bcdp/pick').then(function (r) { return r.json().catch(function (): any { return null }) }).catch(function (): any { return null })
				request.then(function (res: any) {
					request = null
					if (res && res.ok !== false && res.state) applyState(res.state)
					else { enabled = false; stopPolling(); emit('off', '') }
				})
			}
			function toggle(targetId: any) {
				if (enabled) { disable(); return }
				if (!targetId) { emit('failed', wt('noActivePages')); return }
				post(true, targetId).then(function (res) {
					var state = res && res.ok !== false ? res.state : null
					if (!state || state.enabled !== true) {
						// Lightpanda backend — the worker returns the engine-aware code;
						// map it so the panel shows a localized reason, not raw text.
						if (res && res.code === 'engine-unsupported') { emit('failed', wt('engineUnsupportedPick')); return }
						emit('failed', (state && state.message) || (res && res.error) || wt('pickFailed'))
						return
					}
					enabled = true
					seenPicks = state.picks || 0
					// deliveredPicks = the last pick whose ACTION was already
					// delivered. An actionless pick at arm time (lastAction null)
					// is still pending — its action must fire a delivery, so the
					// baseline sits one below. (Synchronising to picks would
					// swallow a pick made before the panel armed.)
					deliveredPicks = state.lastAction ? (state.picks || 0) : (state.picks || 0) - 1
					emit('on', wt('picking'))
					stopPolling()
					timer = window.setInterval(pollOnce, 1000)
				})
			}
			// T5.1b — coordinate fallback: a click on the live screenshot picks
			// via a server-side hit test instead of an Overlay inspect event.
			function clickAt(x: any, y: any, targetId: any) {
				if (!enabled || !targetId) return
				fetch('/api/bcdp/pick/click', {
					method: 'POST', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ targetId: targetId, x: x, y: y }),
				}).then(function (r) { return r.json().catch(function (): any { return null }) }).catch(function (): any { return null })
					.then(function (res) {
						if (res && res.ok !== false && res.state) applyState(res.state)
						else emit('failed', (res && (res.error || res.code)) || wt('pickFailed'))
					})
			}
			function disable() {
				var wasEnabled = enabled
				enabled = false
				stopPolling()
				emit('off', '')
				if (wasEnabled) post(false, '')
			}
			return {
				toggle: toggle, disable: disable, clickAt: clickAt,
				isEnabled: function () { return enabled },
			}
		}

		function LivePreviewController(ctx: any) {
			this.ctx = ctx
			this.store = ensureSnapshotStoreCreator()(this._initialState())
			this.frameCache = new Map()
			this.pageMeta = new Map()
			this.lastList = []
			this.pinned = null
			this.currentActiveId = null
			this.agentActiveId = null
			this.selectedTabId = null
			this.zoomState = { scale: 1, tx: 0, ty: 0 }
			this.liveCount = 0
			this.disposed = false
			this.visible = false
			this.clientId = 'sidebar-' + Math.random().toString(36).slice(2)
			this.watchStarted = false
			this.watchTargetId = null
			this.watchRenewTimer = null
			this.watchStopTimer = null
			this.watchRequest = null
			this.backend = 'cdp'
			this.streamGeneration = 0
			this.streamState = 'idle'
			this.streamMessage = ''
			this.engineUnsupported = false
			this.streamMime = 'video/mp4; codecs="avc1.42E01E"'
			this.liveVideo = null
			this.videoCleanup = null
			this.documentVisible = document.visibilityState !== 'hidden'
			this.onDocumentVisibility = this._handleDocumentVisibility.bind(this)
			this.sse = null
			this.reconnectFallbackTimer = null
			this.lastSawActive = false
			this.lastFrameAt = 0
			this.followTimer = null
			this.pendingLiveFrame = null
			this.liveFlushRaf = null
			this.liveImg = null
			this.liveImgTargetId = null
			this.wiringStale = false
			this._lastUnwiredAt = 0
			this._wiredRecomputeQueued = false
			this.historyOpen = false
			this._zoomHint = null
			this._zoomHintTimer = null
			this._pointerState = null
			var self = this
			this.keyboardProxy = createKeyboardProxy(function (targetId: any, type: any, params: any) { self.sendInput(targetId, type, params) })
			this.dismissedGuides = { login: false, captcha: false }
			this._pick = 'off'
			this._pickMessage = ''
			this._pickTargetId = null
			this.pickControl = createPickControl(function (pick: any, message: any) { self._setPickState(pick, message) }, function (el: any, a: any) { return deliverPickToConversation(ctx, el, a) })
		}
		LivePreviewController.prototype._initialState = function (): any {
			return {
				spaces: [],
				pinned: null,
				selectedTabId: null,
				currentTargetId: null,
				currentSpace: null,
				liveCount: 0,
				busy: false,
				showLoginGuide: false,
				captchaKind: null,
				historyOpen: false,
				zoomHint: null,
				wiringStale: false,
				backend: 'cdp', streamState: 'idle', streamMessage: '', streamGeneration: 0, streamMime: 'video/mp4; codecs="avc1.42E01E"', engineUnsupported: false,
				pick: 'off', pickMessage: '',
			}
		}
		LivePreviewController.prototype.subscribe = function (cb: any) {
			return this.store.subscribe(cb)
		}
		LivePreviewController.prototype.getSnapshot = function () {
			return this.store.getSnapshot()
		}
		LivePreviewController.prototype._setPickState = function (pick: any, message: any) {
			this._pick = pick
			this._pickMessage = message || ''
			var self = this
			this.store.update(function (s: any) {
				s.pick = self._pick
				s.pickMessage = self._pickMessage
			})
		}
		LivePreviewController.prototype._recompute = function () {
			var hasPage = this.lastList.some(function (s: any) { return s.url && !s.url.startsWith('about:') })
			var captchaHit = this.lastList.find(function (s: any) { return s.humanCheck && s.humanCheck.detected })
			var self = this
			var currentSpace: any = null
			var currentTargetId: any = null
			if (this.pinned) {
				currentSpace = this.pinned
				currentTargetId = this.pinned.targetId
			} else if (this.selectedTabId !== null) {
				currentSpace = this.lastList.find(function (s: any) { return s.targetId === self.selectedTabId }) || null
				currentTargetId = this.selectedTabId
				// spaces payloads no longer carry thumbnails; pull the latest
				// cached JPEG from the SSE frame pipeline so the view shows
				// something instead of "no screenshot yet".
				if (currentSpace && !currentSpace.thumbnail) {
					var cached = this.frameCache.get(currentTargetId)
					if (cached) currentSpace = Object.assign({}, currentSpace, { thumbnail: cached })
				}
			} else {
				var activeMarked = this.lastList.find(function (s: any) { return s.active === true })
				if (!activeMarked && this.lastList.length > 0) {
					activeMarked = this.lastList.slice().sort(function (a: any, b: any) { return (b.lastActive || 0) - (a.lastActive || 0) })[0]
				}
				if (activeMarked) {
					currentSpace = Object.assign({}, activeMarked)
					currentTargetId = activeMarked.targetId
					if (!currentSpace.thumbnail) {
						var cached2 = this.frameCache.get(currentTargetId)
						if (cached2) currentSpace.thumbnail = cached2
					}
				}
			}
			this.currentActiveId = currentTargetId
			// Wiring watchdog: the live <img>/<video> is bound to this controller by a
			// ref callback at attach time. If the binding was ever missed (mount-order
			// race) or the element was replaced, liveImgTargetId drifts from the
			// current target and every click/keypress would be silently dropped.
			// Surface the drift on the badge instead of hiding it.
			this.wiringStale = currentTargetId != null && this.liveImgTargetId !== currentTargetId
			var showLogin = hasPage && !captchaHit && !this.dismissedGuides.login
			var captchaKind = (captchaHit && !this.dismissedGuides.captcha) ? (captchaHit.humanCheck.kind || 'captcha') : null
			// T5.21: a tab switch leaves the picker pointing at the wrong page —
			// exit and strip the injected UI rather than picking into a hidden tab.
			if (this.pickControl.isEnabled() && currentTargetId !== this._pickTargetId) {
				this.togglePick()
			}
			this.store.update(function (s: any) {
				s.spaces = self.lastList
				s.pinned = self.pinned
				s.selectedTabId = self.selectedTabId
				s.currentTargetId = currentTargetId
				s.currentSpace = currentSpace
				s.liveCount = self.liveCount
				s.busy = self.lastSawActive
				s.showLoginGuide = showLogin
				s.captchaKind = captchaKind
				s.historyOpen = self.historyOpen
				s.zoomHint = self._zoomHint
				s.wiringStale = self.wiringStale
				s.backend = self.backend
				s.streamState = self.streamState
				s.streamMessage = self.streamMessage
				s.streamGeneration = self.streamGeneration
				s.streamMime = self.streamMime
				s.engineUnsupported = self.engineUnsupported
				s.pick = self._pick
				s.pickMessage = self._pickMessage
			})
			this._syncWatch(currentTargetId)
		}
		LivePreviewController.prototype.start = function () {
			document.addEventListener('visibilitychange', this.onDocumentVisibility)
			this._recompute()
			if (this.visible) { this.refresh(); this.openStream() }
		}
		LivePreviewController.prototype.togglePick = function () {
			var targetId = this.currentActiveId
			if (this.pickControl.isEnabled()) {
				this._pickTargetId = null
				this.pickControl.toggle(targetId)
				return
			}
			this._pickTargetId = targetId
			this.pickControl.toggle(targetId)
		}
		LivePreviewController.prototype.dispose = function () {
			this.keyboardProxy.dispose()
			this.disposed = true
			try { this.pickControl.disable() } catch (e) {}
			if (this.liveFlushRaf != null) try { window.cancelAnimationFrame(this.liveFlushRaf) } catch (e) {}
			if (this.followTimer) window.clearTimeout(this.followTimer)
			if (this.reconnectFallbackTimer) window.clearTimeout(this.reconnectFallbackTimer)
			if (this._zoomHintTimer) window.clearTimeout(this._zoomHintTimer)
			document.removeEventListener('visibilitychange', this.onDocumentVisibility)
			if (this.watchRenewTimer) window.clearInterval(this.watchRenewTimer)
			if (this.watchStopTimer) window.clearTimeout(this.watchStopTimer)
			this._stopWatch(true)
			this._destroyVideo()
			this.closeStream()
		}
		LivePreviewController.prototype._handleDocumentVisibility = function () {
			this.documentVisible = document.visibilityState !== 'hidden'
			if (this.documentVisible && this.visible) {
				this.refresh()
				if (!this.sse) this.openStream()
				this._syncWatch(this.currentActiveId)
			}
		}
		LivePreviewController.prototype.setVisible = function (v: any) {
			var changed = this.visible !== v
			this.visible = v
			var effective = v
			if (effective) {
				// On becoming visible again, do a one-shot fallback fetch to
				// re-sync immediately (the SSE `spaces` event will also catch
				// up on the next keepalive tick, but this avoids a blank gap).
				this.refresh()
				this.openStream()
				this._syncWatch(this.currentActiveId)
			} else {
				this.closeStream()
				this._stopWatch(false)
				this._destroyVideo()
			}
		}
		LivePreviewController.prototype._requestWatch = function (route: any, body: any) {
			if (this.watchRequest) return null
			var self = this
			this.watchRequest = postJson(route, body).finally(function () { self.watchRequest = null })
			return this.watchRequest
		}
		LivePreviewController.prototype._applyCaptureStatus = function (status: any) {
			if (!status || typeof status !== 'object') return
			if (Number.isFinite(status.generation) && status.generation < this.streamGeneration) return
			if (status.generation === this.streamGeneration && this.streamState === 'streaming' && status.state === 'starting') return
			var nextBackend = status.backend || this.backend
			var nextGeneration = status.generation ?? this.streamGeneration
			var nextState = status.state || this.streamState
			var generationChanged = this.streamGeneration !== nextGeneration
			this.backend = nextBackend; this.streamState = nextState; this.streamMessage = status.message || status.code || ''; this.streamGeneration = nextGeneration; this.streamMime = status.mime || this.streamMime
			this.engineUnsupported = status.engineUnsupported === true
			if (generationChanged || this.backend !== 'ffmpeg') this._destroyVideo()
			this._recompute()
		}
		LivePreviewController.prototype._syncWatch = function (targetId: any) {
			if (this.disposed || !this.visible || !targetId) return
			var self = this
			if (this.watchStopTimer) { window.clearTimeout(this.watchStopTimer); this.watchStopTimer = null }
			var route = this.watchStarted ? WATCH_SWITCH_ROUTE : WATCH_START_ROUTE
			if (this.watchStarted && this.watchTargetId === targetId) return
			var body = { clientId: this.clientId, targetId: targetId }
			var request = this._requestWatch(route, body)
			if (!request) { this.watchRequest.finally(function () { self._syncWatch(targetId) }); return }
			request.then(function (status: any) {
				self.watchStarted = status && status.ok !== false
				self.watchTargetId = status && status.targetId || targetId
				if (self.watchTargetId !== targetId) { self.selectedTabId = null; self.currentActiveId = self.watchTargetId }
				self._applyCaptureStatus(status)
				if (!self.visible) self._stopWatch(true)
			}).catch(function () {})
			if (!this.watchRenewTimer) this.watchRenewTimer = window.setInterval(function () {
				if (self.visible && self.watchTargetId) { var renewal = self._requestWatch(WATCH_START_ROUTE, { clientId: self.clientId, targetId: self.watchTargetId }); if (renewal) renewal.then(function (status: any) { self._applyCaptureStatus(status) }).catch(function () {}) }
			}, 5000)
		}
		LivePreviewController.prototype._stopWatch = function (immediate: any) {
			var self = this
			if (this.watchRenewTimer) { window.clearInterval(this.watchRenewTimer); this.watchRenewTimer = null }
			var stop = function () {
				self.watchStopTimer = null
				self.watchStarted = false; self.watchTargetId = null
				postJson(WATCH_STOP_ROUTE, { clientId: self.clientId }).catch(function () {})
			}
			if (immediate) stop()
			else { if (this.watchStopTimer) window.clearTimeout(this.watchStopTimer); this.watchStopTimer = window.setTimeout(stop, 1500) }
		}
		LivePreviewController.prototype._destroyVideo = function () {
			if (this.videoCleanup) try { this.videoCleanup() } catch (e) {}
			this.videoCleanup = null; this.liveVideo = null
		}
		LivePreviewController.prototype.setLiveVideo = function (video: any, targetId: any) {
			this._destroyVideo()
			this.liveVideo = video; this.liveImg = video; this.liveImgTargetId = targetId
			if (!video || this.backend !== 'ffmpeg' || this.streamState !== 'streaming') return
			var self = this
			this.videoCleanup = createMsePlayer(video, this.streamGeneration, this.streamMime, function (message: any) {
				self.streamState = 'failed'; self.streamMessage = message; self._recompute()
			})
		}
		LivePreviewController.prototype.setLiveImg = function (img: any, targetId: any) {
			this.liveImg = img
			this.liveImgTargetId = targetId
			if (img && targetId != null) {
				var cached = this.frameCache.get(targetId)
				if (cached) {
					try { img.src = cached } catch (e) {}
				}
			}
		}
		// `refresh` is NOT a polling loop anymore. It is a one-shot fallback
		// used at start / setVisible(true) / SSE reconnect to re-sync the tab
		// list immediately. The authoritative metadata source is the SSE
		// `spaces` event broadcast by the worker every ~500ms.
		LivePreviewController.prototype.refresh = function () {
			var self = this
			void (async function () {
				try {
					var res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
					if (self.disposed || !res.ok) { self._renderEmpty(); return }
					var data = await res.json()
					if (!data || data.ok !== true) { self._renderEmpty(); return }
					self._applyCaptureStatus(data.capture)
					self._processSpaces(data.spaces)
				} catch (e) {
					self._renderEmpty()
				}
			})()
		}
		LivePreviewController.prototype._renderEmpty = function () {
			if (this.lastList.length === 0) this._processSpaces([])
		}
		LivePreviewController.prototype._processSpaces = function (spaces: any) {
			if (this.disposed) return
			this.lastList = Array.isArray(spaces) ? spaces : []
			var self = this
			for (var i = 0; i < this.lastList.length; i++) {
				var s = this.lastList[i]
				var prev = this.pageMeta.get(s.targetId) || { targetId: s.targetId }
			var meta = {
				url: s.url,
				title: s.title,
				targetId: s.targetId,
			} as any
				if (Number.isFinite(s.viewportW)) meta.vw = s.viewportW
				else if (prev.vw !== undefined) meta.vw = prev.vw
				if (Number.isFinite(s.viewportH)) meta.vh = s.viewportH
				else if (prev.vh !== undefined) meta.vh = prev.vh
				this.pageMeta.set(s.targetId, meta)
			}
			var liveIds = new Set(this.lastList.map(function (s: any) { return s.targetId }))
			var pm = this.pageMeta
			pm.forEach(function (_: any, id: any) { if (!liveIds.has(id)) pm.delete(id) })
			var fc = this.frameCache
			fc.forEach(function (_: any, id: any) { if (!liveIds.has(id)) fc.delete(id) })
			var activeMarked = this.lastList.find(function (s: any) { return s.active === true })
			if (activeMarked) this.agentActiveId = activeMarked.targetId
			this.liveCount = this.lastList.length
			// Busy signal: derived from whether any page was touched recently.
			// Previously this lived in the now-removed polling scheduler; moved
			// here so the SSE `spaces` event keeps the status dot live.
			var busy = this.lastList.some(function (s: any) { return (Date.now() - (s.lastActive || 0)) <= ACTIVE_WINDOW_MS })
			if (busy !== this.lastSawActive) this.lastSawActive = busy
			this._recompute()
		}
		LivePreviewController.prototype.openStream = function () {
			if (this.disposed || !this.visible) return
			this.closeStream()
			var self = this
			fetch(WATCH_STATUS_ROUTE, { cache: 'no-store' }).then(function (res) { return res.ok ? res.json() : null }).then(function (status) { self._applyCaptureStatus(status) }).catch(function () {})
			try {
				this.sse = new EventSource('/api/bcdp/stream')
			} catch (e) { return }
			this.sse.addEventListener('frame', function (ev: any) {
				try {
					var m = JSON.parse(ev.data)
					if (!m || !m.targetId || !m.data) return
					if (Number.isFinite(m.vw) && Number.isFinite(m.vh)) {
						var cur = self.pageMeta.get(m.targetId) || { targetId: m.targetId }
						self.pageMeta.set(m.targetId, Object.assign({}, cur, { vw: m.vw, vh: m.vh }))
					}
					self.applyFrame(m.targetId, 'data:image/' + (m.fmt === 'png' ? 'png' : 'jpeg') + ';base64,' + m.data, m.vw, m.vh)
				} catch (e) {}
			})
			this.sse.addEventListener('spaces', function (ev: any) {
				if (self.disposed) return
				try {
					var list = JSON.parse(ev.data)
					if (Array.isArray(list)) {
						// _processSpaces is the authoritative path: it merges
						// pageMeta, prunes dead tabs from the caches, recomputes
						// the active page, and pushes a store snapshot. The
						// worker broadcasts this every keepalive tick (~500ms)
						// and on tab churn, replacing the old polling loop.
						self._processSpaces(list)
					}
				} catch (e) {}
			})
			this.sse.addEventListener('capture-status', function (ev: any) {
				try {
					self._applyCaptureStatus(JSON.parse(ev.data))
				} catch (e) {}
			})
			// Debounced reconnect fallback: EventSource auto-reconnects on
			// error; we also kick off a one-shot /api/bcdp/spaces fetch so the
			// panel re-syncs immediately after a successful reconnect, without
			// waiting for the worker's next keepalive broadcast. The 1.5s
			// delay lets EventSource reconnect first, avoiding a redundant
			// fetch on a momentary blip.
			this.sse.onerror = function () {
				if (self.reconnectFallbackTimer) return
				self.reconnectFallbackTimer = window.setTimeout(function () {
					self.reconnectFallbackTimer = null
					if (self.disposed || !self.visible) return
					self.refresh()
				}, 1500)
			}
		}
		LivePreviewController.prototype.closeStream = function () {
			try { if (this.sse) this.sse.close() } catch (e) {}
			this.sse = null
		}
		LivePreviewController.prototype.applyFrame = function (targetId: any, dataUrl: any, vw: any, vh: any) {
			if (this.disposed) return
			this.frameCache.delete(targetId)
			this.frameCache.set(targetId, dataUrl)
			var MAX_CACHED_FRAMES = 12
			if (this.frameCache.size > MAX_CACHED_FRAMES) {
				var self = this
				this.frameCache.forEach(function (_: any, id: any) {
					if (self.frameCache.size <= MAX_CACHED_FRAMES) return
					if (id === targetId || id === self.liveImgTargetId) return
					self.frameCache.delete(id)
				})
			}
			if (Number.isFinite(vw) && Number.isFinite(vh)) {
				var cur = this.pageMeta.get(targetId) || { targetId: targetId }
				this.pageMeta.set(targetId, Object.assign({}, cur, { vw: vw, vh: vh }))
			}
			if (this.liveImg && this.liveImgTargetId === targetId) {
				var self2 = this
				this.pendingLiveFrame = dataUrl
				if (!this.liveFlushRaf && !this.disposed) {
					this.liveFlushRaf = window.requestAnimationFrame(function () {
						self2.liveFlushRaf = null
						if (self2.disposed || !self2.liveImg || self2.pendingLiveFrame == null) return
						try { self2.liveImg.src = self2.pendingLiveFrame } catch (e) {}
						self2.pendingLiveFrame = null
					})
				}
				return
			}
			if (!this.pinned && this.selectedTabId === null && targetId === this.agentActiveId) {
				var now = Date.now()
				if (now - this.lastFrameAt >= FRAME_FOLLOW_MIN_MS) {
					this.lastFrameAt = now
					if (this.followTimer) window.clearTimeout(this.followTimer)
					var self3 = this
					this.followTimer = window.setTimeout(function () {
						if (self3.disposed || self3.pinned || self3.selectedTabId !== null) return
						if (self3.liveImg && self3.liveImgTargetId === targetId) return
						var meta = self3.pageMeta.get(targetId)
						if (!meta) return
						self3.currentActiveId = targetId
						self3._recompute()
					}, 0)
				}
			}
		}
		LivePreviewController.prototype.sendInput = function (targetId: any, type: any, params: any) {
			var targetValid = !!targetId
			if (!targetValid || this.disposed || ((type !== 'mouseReleased' && type !== 'keyUp') && !this.visible)) return
			var self = this
			void fetch(INPUT_ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(Object.assign({ targetId: targetId, type: type }, params)),
			}).then(function (res) {
				if (res.status === 409) {
					self.liveImgTargetId = null
					self._pointerState = null
					self.refresh()
				}
			}).catch(function () {})
		}
		LivePreviewController.prototype.browserXY = function (e: any) {
			if (this.liveImgTargetId == null || !this.liveImg) return null
			var m = this.pageMeta.get(this.liveImgTargetId)
			var vw = m && m.vw, vh = m && m.vh
			if (!Number.isFinite(vw) || !Number.isFinite(vh)) return null
			var img = this.liveImg
			var rect = img.getBoundingClientRect()
			var natW = img.naturalWidth || img.videoWidth || rect.width
			var natH = img.naturalHeight || img.videoHeight || rect.height
			if (!natW || !natH) return null
			var scale = Math.min(rect.width / natW, rect.height / natH)
			var contentW = natW * scale
			var contentH = natH * scale
			var ox = (rect.width - contentW) / 2
			var oy = (rect.height - contentH) / 2
			var rx = e.clientX - rect.left - ox
			var ry = e.clientY - rect.top - oy
			return { x: (rx / contentW) * vw, y: (ry / contentH) * vh }
		}
		LivePreviewController.prototype.pinTo = function (space: any) {
			if (this.disposed) return
			this.pinned = space
			this.selectedTabId = null
			this._recompute()
		}
		LivePreviewController.prototype.unpin = function () {
			this.pinned = null
			this._recompute()
		}
		LivePreviewController.prototype.selectTab = function (targetId: any) {
			if (this.selectedTabId === targetId) {
				this.selectedTabId = null
				this.pinned = null
			} else {
				this.selectedTabId = targetId
				this.pinned = null
			}
			this._recompute()
			this._syncWatch(this.selectedTabId || this.currentActiveId)
		}
		LivePreviewController.prototype.closeTab = function (targetId: any) {
			var self = this
			void (async function () {
				try {
					await fetch(EGO_CLOSE_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: targetId }) })
				} catch (e) {}
				if (self.selectedTabId === targetId) { self.selectedTabId = null; self.pinned = null }
				self.refresh()
			})()
		}
		LivePreviewController.prototype.toggleHistory = function () {
			this.historyOpen = !this.historyOpen
			this._recompute()
		}
		LivePreviewController.prototype.dismissGuide = function (which: any) {
			this.dismissedGuides[which] = true
			this._recompute()
		}
		LivePreviewController.prototype.flushLogin = function () {
			return (async function () {
				var r = await fetch(FLUSH_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
				return r.json()
			})()
		}
		// Zoom/pan/input handlers (called from React JSX)
		LivePreviewController.prototype._showHint = function (txt: any) {
			this._zoomHint = txt
			this._recompute()
			if (this._zoomHintTimer) window.clearTimeout(this._zoomHintTimer)
			var self = this
			this._zoomHintTimer = window.setTimeout(function () {
				self._zoomHint = null
				self._recompute()
			}, 2000)
		}
		// Called by the element ref callbacks right after a (re)bind. If the badge
		// was showing ⚠未接管, clear it via a microtask recompute — store updates
		// scheduled from the commit phase are safe and cannot loop (the flag is
		// already false when the next render runs).
		LivePreviewController.prototype.noteWired = function () {
			if (!this.wiringStale) return
			this.wiringStale = false
			if (this._wiredRecomputeQueued) return
			this._wiredRecomputeQueued = true
			var self = this
			Promise.resolve().then(function () {
				self._wiredRecomputeQueued = false
				if (!self.disposed) self._recompute()
			})
		}
		// Fail visible, never silent: a pointer/wheel intent that cannot be mapped
		// (browserXY → null because the live view was never wired) used to vanish
		// without a trace. Warn once per 5s and show a hint; _showHint triggers a
		// recompute → re-render → ref callback re-fires → the view rebinds, so the
		// NEXT click already works (self-healing through the retry).
		LivePreviewController.prototype._signalUnwired = function () {
			var now = Date.now()
			if (now - this._lastUnwiredAt < 5e3) return
			this._lastUnwiredAt = now
			try { console.warn('[dsh-browser-cdp] live view not wired (liveImgTargetId=' + this.liveImgTargetId + ', current=' + this.currentActiveId + ') — input dropped') } catch (e) {}
			this._showHint(wt('hintNotCaptured'))
		}
		LivePreviewController.prototype._applyZoom = function () {
			if (!this.liveImg) return
			this.liveImg.style.transformOrigin = '0 0'
			this.liveImg.style.transform = 'translate(' + this.zoomState.tx + 'px,' + this.zoomState.ty + 'px) scale(' + this.zoomState.scale + ')'
		}
		LivePreviewController.prototype.resetZoom = function () {
			this.zoomState = { scale: 1, tx: 0, ty: 0 }
			this._applyZoom()
			this._showHint(wt('hintReset'))
		}
		LivePreviewController.prototype.handleWheel = function (e: any) {
			e.preventDefault()
			e.stopPropagation()
			if (e.ctrlKey || e.metaKey) {
				if (!this.liveImg) return
				var rect = this.liveImg.getBoundingClientRect()
				var mx = e.clientX - rect.left, my = e.clientY - rect.top
				var next = Math.min(8, Math.max(1, this.zoomState.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
				if (next <= 1) { this.resetZoom(); return }
				this.zoomState.tx = mx - (mx - this.zoomState.tx) * (next / this.zoomState.scale)
				this.zoomState.ty = my - (my - this.zoomState.ty) * (next / this.zoomState.scale)
				this.zoomState.scale = next
				this._applyZoom()
				this._showHint(wt('hintPan'))
				return
			}
			var p = this.browserXY(e)
			if (p && this.liveImgTargetId) {
				this.sendInput(this.liveImgTargetId, 'mouseWheel', {
					x: p.x, y: p.y,
					deltaX: e.deltaX || 0,
					deltaY: e.deltaY || (e.deltaMode === 1 ? 40 : (e.deltaY || 100)),
				})
			} else {
				this._signalUnwired()
			}
		}
		LivePreviewController.prototype.handlePointerDown = function (e: any) {
			if (e.button !== 0) return
			// T5.1b: while picking, a click on the live image IS the pick — the
			// coordinates go to the hit-test fallback instead of the browser.
			if (this.pickControl.isEnabled()) {
				var pp = this.browserXY(e)
				if (pp) this.pickControl.clickAt(pp.x, pp.y, this.liveImgTargetId)
				return
			}
			this._pointerState = {
				viewPanning: false, browserDrag: false,
				sx: e.clientX, sy: e.clientY,
				stx: this.zoomState.tx, sty: this.zoomState.ty,
				lastDragPos: null, downButtons: 0, targetId: this.liveImgTargetId,
			}
			try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
			if (e.ctrlKey || e.metaKey) {
				this._pointerState.viewPanning = true
				e.currentTarget.style.cursor = 'grabbing'
				this._showHint(wt('hintScroll'))
				return
			}
			this._pointerState.browserDrag = true
			this.keyboardProxy.focusAt(e, this._pointerState.targetId)
			this._pointerState.downButtons = 1
			var p = this.browserXY(e)
			if (p) {
				this._pointerState.lastDragPos = p
				this.sendInput(this._pointerState.targetId, 'mousePressed', { x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
			} else {
				this._signalUnwired()
			}
		}
		LivePreviewController.prototype.handlePointerMove = function (e: any) {
			if (!this._pointerState) {
				var p = this.browserXY(e)
				if (p) this.sendInput(this.liveImgTargetId, 'mouseMoved', { x: p.x, y: p.y, buttons: 0 })
				return
			}
			if (this._pointerState.viewPanning) {
				this.zoomState.tx = this._pointerState.stx + (e.clientX - this._pointerState.sx)
				this.zoomState.ty = this._pointerState.sty + (e.clientY - this._pointerState.sy)
				this._applyZoom()
				return
			}
			if (this._pointerState.browserDrag) {
				var p2 = this.browserXY(e)
				if (p2) {
					this.sendInput(this._pointerState.targetId, 'mouseMoved', { x: p2.x, y: p2.y, buttons: this._pointerState.downButtons })
					this._pointerState.lastDragPos = p2
				}
			}
		}
		LivePreviewController.prototype.handlePointerUp = function (e: any) {
			if (!this._pointerState) return
			if (this._pointerState.viewPanning) {
				if (e.currentTarget) e.currentTarget.style.cursor = 'grab'
			}
			if (this._pointerState.browserDrag) {
				if (this._pointerState.lastDragPos && this._pointerState.targetId) {
					this.sendInput(this._pointerState.targetId, 'mouseReleased', {
						x: this._pointerState.lastDragPos.x, y: this._pointerState.lastDragPos.y,
						button: 'left', buttons: 0, clickCount: 1,
					})
				}
			}
			if (e.currentTarget) e.currentTarget.style.cursor = 'grab'
			this._pointerState = null
		}
		LivePreviewController.prototype.handleDoubleClick = function (e: any) {
			e.preventDefault()
			this.resetZoom()
		}

		// ── EgoBrowserTab: React component for the sidebar tab ─────────────────
		// Renders header + guide strips + tab strip + main live view (or history
		// overlay). Subscribes to the controller's snapshot store; delegates
		// pointer/wheel events on the live <img> to controller methods. The
		// controller holds a direct ref to the <img> so SSE frames swap src at rAF
		// cadence without triggering React re-renders per frame.
		function EgoBrowserTab(props: any) {
			var visible = props.visible
			var ctx = props.ctx
			var controllerRef = React.useRef(null)
			if (controllerRef.current === null) controllerRef.current = new (LivePreviewController as any)(ctx)
			var controller = controllerRef.current

			// Create the snapshot hook once per controller instance
			var useSnapshotRef = React.useRef(null)
			if (useSnapshotRef.current === null) {
				useSnapshotRef.current = bindSnapshotSelector(controller.store)
			}
			// bindSnapshotSelector returns a selector hook that REQUIRES a selector
			// function arg (it uses useSyncExternalStoreWithSelector internally).
			// Calling it with no args → "w is not a function" (w is the minified
			// selector param). Pass identity selector to get the whole snapshot.
			var state = useSnapshotRef.current(function (s: any) { return s })

			var imgRef = React.useRef(null)
			var videoRef = React.useRef(null)

			// Bind the live <img>/<video> to the controller the moment the element
			// attaches. The deps-based effect below only fires when target/backend/
			// generation change — but the <img> typically mounts LATER (placeholder →
			// first cached frame → thumbnail branch), with no dep change at that
			// moment, so the effect never wires it: liveImgTargetId stays null and
			// every click/keypress is silently dropped. A ref callback fires on every
			// attach, so the wiring cannot be missed regardless of mount order.
			var bindLiveImg = function (el: any) {
				imgRef.current = el
				if (el && state.currentTargetId != null &&
					(controller.liveImg !== el || controller.liveImgTargetId !== state.currentTargetId)) {
					controller.setLiveImg(el, state.currentTargetId)
					controller.noteWired()
				}
			}
			var bindLiveVideo = function (el: any) {
				videoRef.current = el
				if (el && state.currentTargetId != null &&
					(controller.liveImg !== el || controller.liveImgTargetId !== state.currentTargetId)) {
					controller.setLiveVideo(el, state.currentTargetId)
					controller.noteWired()
				}
			}

			React.useEffect(function () {
				controller.start()
				return function () { controller.dispose() }
			}, [controller])

			React.useEffect(function () {
				controller.setVisible(visible)
			}, [visible, controller])

			// Attach the live <img> to the controller whenever the target changes
			React.useEffect(function () {
				if (imgRef.current && state.currentTargetId != null) {
					controller.setLiveImg(imgRef.current, state.currentTargetId)
				}
				if (videoRef.current && state.currentTargetId != null) controller.setLiveVideo(videoRef.current, state.currentTargetId)
			}, [state.currentTargetId, state.backend, state.streamGeneration, state.streamState, controller])

			// Native wheel listener (React onWheel is passive, can't preventDefault)
			React.useEffect(function () {
				var img = imgRef.current || videoRef.current
				if (!img) return
				var handler = function (e: any) { controller.handleWheel(e) }
				img.addEventListener('wheel', handler, { passive: false })
				return function () { img.removeEventListener('wheel', handler) }
			}, [controller, state.currentTargetId, state.backend, state.streamGeneration])

			var h = React.createElement

			// Header
			var header = h('div', { className: 'dsh-ego-side-head' },
				h('span', { className: 'dsh-ego-side-title' },
					h('span', { dangerouslySetInnerHTML: { __html: ICON_GLOBE } }),
					h('span', { style: { marginLeft: '5px' } }, state.busy ? wt('titleLive') : wt('title'))
				),
				h('button', {
					className: 'dsh-ego-side-iconbtn' + (state.busy ? ' spinning' : ''),
					title: wt('refresh'),
					onClick: function () {
						controller.refresh()
					},
				}, h('span', { dangerouslySetInnerHTML: { __html: ICON_REFRESH } })),
				h('button', {
					className: 'dsh-ego-side-iconbtn' + (state.historyOpen ? '' : ' off'),
					title: state.historyOpen ? wt('historyHide') : wt('historyShow'),
					onClick: function () { controller.toggleHistory() },
				}, h('span', { dangerouslySetInnerHTML: { __html: ICON_CLOCK } }))
			)

			// History overlay: covers the body area
			if (state.historyOpen) {
				var sorted = state.spaces.slice().sort(function (a: any, b: any) { return (a.lastActive || 0) - (b.lastActive || 0) })
				return h('div', { className: 'dsh-ego-side-root' },
					header,
					h('div', { className: 'dsh-ego-side-history' },
						h('div', { className: 'dsh-ego-side-historyhead' },
							h('span', { dangerouslySetInnerHTML: { __html: ICON_CLOCK } }),
							' ' + wt('history')
						),
						h('div', { className: 'dsh-ego-side-historylist' },
							sorted.length === 0
								? h('div', { className: 'dsh-ego-side-hnone' }, wt('noHistory'))
								: sorted.map(function (s: any) {
									return h('div', {
										key: s.targetId,
										className: 'dsh-ego-side-hitem' + (s.targetId === state.currentTargetId ? ' active' : ''),
										onClick: function () { controller.pinTo(s); controller.toggleHistory() },
									},
										s.thumbnail
											? h('img', { className: 'dsh-ego-side-hthumb', src: s.thumbnail, alt: '' })
											: h('div', { className: 'dsh-ego-side-hthumb' }),
										h('div', { className: 'dsh-ego-side-hinfo' },
											h('div', { className: 'dsh-ego-side-htitle' }, s.title || s.url || wt('newTab')),
											h('div', { className: 'dsh-ego-side-hurl' }, s.url || '(about:blank)'),
											s.targetId === state.currentTargetId ? h('div', { className: 'dsh-ego-side-hactive' }, '● ' + wt('current')) : null
										)
									)
								})
						)
					)
				)
			}

			// Guide strips
			var guides = []
			if (state.showLoginGuide) {
				guides.push(h(EgoLoginGuide, { key: 'login', controller: controller }))
			}
			if (state.captchaKind) {
				guides.push(h(EgoCaptchaGuide, { key: 'captcha', kind: state.captchaKind, controller: controller }))
			}

			// Tab strip
			var tabsEl = state.spaces.length > 0
				? h('div', { className: 'dsh-ego-side-tabs' },
					state.spaces.map(function (s: any) {
						var isActive = s.targetId === state.selectedTabId || (state.selectedTabId === null && s.targetId === state.currentTargetId)
						return h('div', {
							key: s.targetId,
							className: 'dsh-ego-side-tab' + (isActive ? ' active' : ''),
							title: s.url || '',
							onClick: function () { controller.selectTab(s.targetId) },
						},
							h('span', { className: 'dsh-ego-side-tabdot' }),
							h('span', { className: 'dsh-ego-side-tabtxt' }, s.title || s.url || wt('newTab')),
							h('span', {
								className: 'dsh-ego-side-tabclose',
								title: wt('closeTab'),
								onClick: function (e: any) { e.stopPropagation(); controller.closeTab(s.targetId) },
							}, '×')
						)
					})
				)
				: null

			// Main live view
			var body
			var currentSpace = state.currentSpace
			if (!currentSpace) {
				body = h('div', { className: 'dsh-ego-side-body' },
					h('div', { className: 'dsh-ego-side-empty' },
						h('div', null, wt('noActivePages')),
						h('div', { style: { fontSize: '11px' } }, wt('noActiveHint'))
					)
				)
			} else {
				var liveImg = state.backend === 'ffmpeg'
					? h('video', {
						ref: bindLiveVideo, key: 'livevideo-' + state.streamGeneration, className: 'dsh-ego-side-liveimg', muted: true, autoPlay: true, playsInline: true,
						onPointerDown: function (e: any) { controller.handlePointerDown(e) }, onPointerMove: function (e: any) { controller.handlePointerMove(e) }, onPointerUp: function (e: any) { controller.handlePointerUp(e) }, onPointerCancel: function (e: any) { controller.handlePointerUp(e) }, onDoubleClick: function (e: any) { controller.handleDoubleClick(e) },
					})
					: currentSpace.thumbnail
					? h('img', {
						ref: bindLiveImg,
						key: 'liveimg',
						className: 'dsh-ego-side-liveimg',
						src: currentSpace.thumbnail,
						alt: 'live',
						draggable: false,
						onPointerDown: function (e: any) { controller.handlePointerDown(e) },
						onPointerMove: function (e: any) { controller.handlePointerMove(e) },
						onPointerUp: function (e: any) { controller.handlePointerUp(e) },
						onPointerCancel: function (e: any) { controller.handlePointerUp(e) },
						onDoubleClick: function (e: any) { controller.handleDoubleClick(e) },
					})
					: h('div', { className: 'dsh-ego-side-liveurl' }, state.engineUnsupported ? wt('engineUnsupportedBanner') : (state.streamMessage || wt('noScreenshot')))

				body = h('div', { className: 'dsh-ego-side-body' },
					h('div', { className: 'dsh-ego-side-liveview' },
						h('div', { className: 'dsh-ego-side-livebadge' },
							h('span', { className: 'dsh-ego-side-state-dot' + (state.pinned ? ' pin' : state.busy ? ' busy' : '') }),
							h('span', { style: { flex: 1 } }, (state.backend === 'ffmpeg' ? 'FFmpeg · H.264' : 'CDP') + ' · ' + (state.streamState === 'failed' ? (state.streamMessage || wt('failed')) : state.streamState === 'unsupported' ? wt('engineUnsupportedBanner') : state.streamState) + (state.currentTargetId ? (state.wiringStale ? ' · ' + wt('stale') : ' · ' + wt('captured')) : '')),
							state.pinned
								? h('button', {
									className: 'dsh-ego-side-back', type: 'button',
									onClick: function () { controller.unpin() },
								}, wt('backToLive'))
								: null,
							// T5.16 — pick-element toggle, LEFT of "open real page".
							h('button', {
								className: 'dsh-ego-side-back' + (state.pick === 'on' ? ' dsh-ego-pick-on' : ''),
								type: 'button',
								title: state.pick === 'failed' ? (state.message || wt('pickFailed')) : wt('pickModeHint'),
								onClick: function () { controller.togglePick() },
							}, state.pick === 'failed' ? wt('pickFailed') : state.pick === 'on' ? wt('picking') : wt('pickMode')),
							h('button', {
								className: 'dsh-ego-side-back', type: 'button',
								title: wt('openExternal'),
								onClick: function () {
									var url = currentSpace.url
									if (url && !url.startsWith('about:') && !url.startsWith('chrome://')) window.open(url, '_blank', 'noopener')
								},
							}, wt('openExternal')),
							// Raise the real agent window (issue #51): headless
							// instances get replaced by a headed one on the same
							// profile; headed ones just pop to the front.
							h('button', {
								className: 'dsh-ego-side-back', type: 'button',
								title: wt('raiseWindowHint'),
								onClick: function () {
									fetch('/api/bcdp/raise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
										.then(function (r) { return r.json().catch(function (): any { return null }) })
										.catch(function (): any { return null })
								},
							}, wt('raiseWindow'))
						),
						liveImg,
						h('div', { className: 'dsh-ego-side-livetitle' }, currentSpace.title || currentSpace.url || wt('newTab')),
						h('div', { className: 'dsh-ego-side-liveurl' + (state.zoomHint ? ' dsh-ego-side-hint' : '') }, state.zoomHint || currentSpace.url || '')
					)
				)
			}

			return h('div', { className: 'dsh-ego-side-root' }, header, guides, tabsEl, body)
		}

		function EgoLoginGuide(props: any) {
			var controller = props.controller
			var h = React.createElement
			var noteState = React.useState('')
			var note = noteState[0], setNote = noteState[1]
			var savingState = React.useState(false)
			var saving = savingState[0], setSaving = savingState[1]
			return h('div', { className: 'dsh-ego-side-login' },
				h('span', { className: 'dsh-ego-side-login-txt' },
					wt('loginTitle')
				),
				h('button', {
					className: 'dsh-ego-side-login-btn' + (saving ? ' saving' : ''),
					type: 'button',
					disabled: saving,
					onClick: function () {
						setSaving(true)
						setNote('')
						controller.flushLogin().then(function (j: any) {
							if (j && j.ok) setNote(wt('loginSaved', { n: j.total || '' }))
							else setNote(j && j.error ? wt('loginNotConnected') : wt('loginFailed'))
						}).catch(function () { setNote(wt('loginFailed')) }).finally(function () { setSaving(false) })
					},
				}, saving ? wt('loginSaving') : wt('loginBtn')),
				note ? h('span', { className: 'dsh-ego-side-login-note' }, note) : null,
				h('button', {
					className: 'dsh-ego-side-iconbtn', type: 'button', title: wt('loginDismiss'),
					onClick: function () { controller.dismissGuide('login') },
				}, '×')
			)
		}

		function EgoCaptchaGuide(props: any) {
			var controller = props.controller
			var kind = props.kind
			var h = React.createElement
			return h('div', { className: 'dsh-ego-side-captcha' },
				h('span', { className: 'dsh-ego-side-captcha-txt' },
					h('b', null, wt('captchaTitle')),
					' — ' + wt('captchaHint')
				),
				h('span', { className: 'dsh-ego-side-captcha-kind' }, kind),
				h('button', {
					className: 'dsh-ego-side-iconbtn', type: 'button', title: wt('captchaDismiss'),
					onClick: function () { controller.dismissGuide('captcha') },
				}, '×')
			)
		}

		// ── mountSidebarTab: register the CDP browser bridge watch tab ────────────────
		function mountSidebarTab(ctx: any, betterSidebar: any) {
			if (!betterSidebar) return function () {}
			// Inject Tab CSS once (cleaned up on dispose)
			var styleEl = document.createElement('style')
			styleEl.textContent = TAB_CSS
			document.head.appendChild(styleEl)

			var disposeTab = betterSidebar.registerTab({
				id: 'dsh-browser-cdp:watch',
				title: function () { return wt('title') },
				order: 70,
				single: true,
				// No urlTarget: this tab is a live screencast of the AGENT
				// browser, not a renderer for arbitrary URLs. Claiming http(s)
				// links here stole every chat link from the built-in browser
				// tab and dead-ended on the empty state (issue #48).
				component: EgoBrowserTab,
			})

			// ── Auto-open probe (SSE-driven, no polling) ─────────────────────
			// Listens for `tool-call` events on the SSE stream to detect when
			// the agent first calls an bcdp_* tool, then opens the sidebar Tab.
			// No /api/bcdp/spaces polling — the host-side markEgoToolCall()
			// pushes the event into the SSE stream the moment a tool runs.
			//
			// Why "increase beyond baseline" not "0 → >0": toolCallCount is a
			// host-process counter that persists across page reloads. The
			// baseline is fetched ONCE at mount via a single /api/bcdp/spaces
			// request; after that, only a NEW tool call (count goes up)
			// triggers the open.
			//
			// Per-session scope: the event carries the CALLING session id, so the
			// Tab opens with that session's scope — a background conversation's
			// tool call lands in ITS OWN sidebar instead of the sidebar the user
			// happens to be looking at. The one-shot guard is therefore per
			// session, and the probe stream stays open (a later session must
			// still be able to auto-open).
			var probeDisposed = false
			// Ordinary bcdp_* calls keep the tab collapsed. The agent explicitly
			// asks for it with bcdp_watch; only that SSE event (open:true) opens
			// the tab, scoped to the calling session.
			var openWatchTab = function (sessionId: any) {
				try {
					betterSidebar.openTab({ type: 'dsh-browser-cdp:watch' }, sessionId ? { sessionId: sessionId } : undefined)
				} catch (e) {}
			}
			var probeSse: any = null
			try { probeSse = new EventSource('/api/bcdp/stream') } catch (e) {}
			if (probeSse) {
				probeSse.addEventListener('tool-call', function (ev: any) {
					if (probeDisposed) return
					try {
						var m = JSON.parse(ev.data)
						if (!m || m.open !== true) return
						var sid = typeof m.sessionId === 'string' && m.sessionId !== '' ? m.sessionId : undefined
						openWatchTab(sid)
					} catch (e) {}
				})
			}

			return function () {
				probeDisposed = true
				try { if (probeSse) probeSse.close() } catch (e) {}
				disposeTab()
				styleEl.remove()
			}
		}

		function escapeHtml(s: any) {
			return String(s).replace(/[&<>"']/g, (c) => ({
				'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
			}[c]))
		}


export const name = 'dsh-browser-cdp'
export { apply, inject }
