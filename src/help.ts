/**
 * src/help.ts — tool index copy (EGO_HELP_INDEX).
 *
 * Pure data module: the `topic` lookup table for the bcdp_help tool. When you
 * add/change a tool, remember to sync an entry here or bcdp_help won't find it.
 */
export const EGO_HELP_INDEX: Record<string, string> = {
  overview:
    'CDP 浏览器代理：结构化浏览器工具。导航/交互/观察/表单/网络/等待/键鼠皆有专项工具，另提供 bcdp_help(本索引)、bcdp_doctor(体检)、bcdp_script(自由脚本逃生舱；verbatim:true 为裸 heredoc)。连接与激活见 topic=links。' +
    'If a bcdp_* tool is missing from your list, read topic=injection first: tools are tiered and only core stays resident. ' +
    '分类见: tools / navigate / observe / input / keyboard-mouse / form / wait / network / login / script / doctor / lightpanda / injection。用 `topic` 查询，或直接给工具名。',
  tools:
    '工具清单: bcdp_status, bcdp_space(+op:open/close/list/handoff/takeover), bcdp_snapshot, bcdp_navigate, bcdp_tab, bcdp_click(+double), bcdp_fill, bcdp_js, bcdp_cdp, bcdp_screenshot(+selector), bcdp_page_info, bcdp_wait(+op:duration/selector/url/response/load/function/request/event), bcdp_key(+text/type/insert), bcdp_hover, bcdp_read_element, bcdp_select, bcdp_drag, bcdp_scroll, bcdp_upload, bcdp_check, bcdp_dialog, bcdp_download, bcdp_http, bcdp_captcha, bcdp_auth_flush, bcdp_login_import, bcdp_diagnostics(+kind:network/console/pdf), bcdp_help, bcdp_doctor, bcdp_script(+verbatim), bcdp_jev_status, bcdp_jev_frame, bcdp_jev_attempt, bcdp_jev_ask, bcdp_jev_run。',
  links:
    '连接序列（设置面板）：有序列表，顺序即优先级，被激活的一项驱动每一次 bcdp_* 调用。两种类型——' +
    'CDP 端点（注入 EGO_LINUX_CDP_URL，指向已开调试端口的浏览器）与 本机 ego CLI（不注入端点，由本机 ego CLI 直接驱动 ego 浏览器；' +
    '仅限本机，全局至多一条）。cdpMode: auto=按激活项；remote=仅接受 CDP 端点；local=受管本地启动器。' +
    'cdpMode=remote 与「本机 ego CLI」组合会显式报 mode-kind-mismatch。remoteEnabled 只管远端 CDP，不影响本机 CLI 连接。',
  navigate: 'bcdp_navigate: 打开URL或切tab(同任务复用当前tab)。bcdp_wait op=url: 等跳转(登录/分页)。',
  observe:
    'bcdp_snapshot: 整页语义树(带[ref]/loc供点击); bcdp_page_info: url/标题/视口/滚动/对话框/人机验证; bcdp_read_element: 读单元素文本/HTML/值/属性/可见性/计数; bcdp_screenshot(+selector): 整页或元素截图。',
  input: 'bcdp_click(selector/坐标, double双击); bcdp_fill(填框); bcdp_key(press组合键 或 text连续键入); bcdp_check(勾选/取消); bcdp_select(下拉); bcdp_upload(文件上传); bcdp_dialog(接受/取消JS对话框)。',
  'keyboard-mouse':
    'bcdp_key: 键盘(press/text); bcdp_hover: 悬停; bcdp_drag: 拖拽(元素或坐标); bcdp_scroll: 滚轮/滚到元素; bcdp_click: 点击/双击。',
  form: 'bcdp_fill 填输入框; bcdp_select 下拉; bcdp_check checkbox/radio; bcdp_upload 文件; bcdp_key 回车/Tab导航; bcdp_dialog 处理提交弹窗。',
  wait: 'bcdp_wait 一个工具八个 op：duration(固定毫秒); selector(等元素出现/消失, 可带 state); url(等跳转); response(等网络响应, body=text|json 可读体); load(等加载状态); function(页内表达式变真); request(等请求); event(等下载)。',
  network:
    'bcdp_http: 发HTTP请求(默认浏览器上下文 fetch.browser, mode=server走Node fetch.server); bcdp_wait op=response: 等并读接口响应; bcdp_diagnostics kind=network: 读最近请求/响应(方法/URL/状态/类型/耗时/失败原因)。',
  diagnostics:
    'bcdp_diagnostics: 可选诊断工具(kind=network|console|pdf)。network/console 读取当前 target 的最近事件(1-300 条，默认 50)，用于排查接口、页面报错和控制台错误；pdf 用 Page.printToPDF 保存当前页到本地并返回 path。network/console 需要 worker 正在运行；targetId 可省略(默认为 worker active target)。',
  download: 'bcdp_download: 等下载事件并落到指定路径(triggerSelector/triggerScript + 可选 savePath)。',
  captcha: 'bcdp_captcha: 检测页面人机验证(CAPTCHA)并返回{detected,kind}; 检测到请让用户去 ego 浏览器完成; bcdp_page_info 也附带 humanCheck。',
  login: 'bcdp_auth_flush: 把登录cookie落盘到ego profile; 观察窗登录引导条+『已登录,保存』按钮触发同一动作。bcdp_login_import: 从系统浏览器(Chrome/Edge/Brave)按域名导入登录cookie(source/domains/dryRun; 先dryRun看可导入项; ego浏览器须已在运行)。',
  script: 'bcdp_script: 原样运行任意内置运行时 heredoc 脚本(page/browser/taskSpaces/site/fetch/cdp预载)。默认加 preamble(选区+激活真实 tab)并额外返回 duration/timedOut; verbatim:true 则完全原样、无 preamble(原 bcdp_cli 行为, 需自行 taskSpaces.useOrCreate)。',
  doctor: 'bcdp_doctor: 体检环境（浏览器候选、vendored runtime、状态目录、CDP端口、任务空间、引擎与降级清单）；首行附工具注入面快照。',
  injection:
    'SEALED TOOLS — read this first when a bcdp_* tool you expect is missing from your tool list. ' +
    'Under toolInjection=lazy (the default) only bcdp_status stays registered — it is the unlock entry: calling it re-opens the other batches for this session. ' +
    'Every other batch (act / observe / wait / power / session / escape / judge) is deregistered until browser activity re-opens them; an idle reaper pass or a restart seals them again. ' +
    'Missing from the list = sealed, not broken, and not a wrong name. ' +
    'Fix: call bcdp_status (it counts as browser activity), then retry the tool. ' +
    'A call made before that fails with "unknown tool" at the harness level, before this plugin sees it. ' +
    'To keep all 34 resident instead, set toolInjection=always in the profile config. ' +
    '—— 以下为原说明：' +
    '工具分级注入（不是工具，是出现时机）：34 个 bcdp_* 分八批——core（只 bcdp_status 一个：常驻且是解锁入口，不给开关）/ act（空间/导航/点击填写键鼠拖拽/tab 标签管理/指南/预检，13 个）/ observe（截图/页面信息/读取/js/snapshot，5 个）/ wait（bcdp_wait 全 op，1 个）/ power（裸CDP/HTTP/上传/下载/对话框，5 个）/ session（验证码/登录落盘/登录导入，3 个）/ escape（script 逃生舱，1 个）/ judge（bcdp_jev_*，5 个）——1+13+5+1+5+3+1+5=34。' +
    '设置旋钮（全 volatile）：toolInjection = lazy（默认，只常驻 bcdp_status，首次 bcdp_* 调用后按批次铺开）/ always（挂载即全量，历史行为）；toolBrowse（act+observe+wait=19，内部按 act→observe→wait 三波放行）/ toolExtended（power+session=8）/ toolEscape（script=1）/ toolJudge（judge=5）四把开关——开 = 开放注册，关 = 该批从工具列表移除（core 级不给开关，封了就没解锁入口）；judge 级即使开了仍需配 JEV/Laya Key。' +
    '**1.7.0 起 escape 与其它非 core 批同闸**：script 不再冷启动可用——先调 bcdp_status 即可拿到它；要回到「始终可达」，设 toolInjection=always。' +
    '封印 = 从工具列表里反注册，不是执行期报错；lazy 下闲置回收会把扩展面收回。' +
    '**若某个 bcdp_* 工具不在你的工具列表里**：它被分级封印了——先跑常驻的 bcdp_status（它算浏览器活动，会把面铺开），或让用户在设置页「工具封印」里打开对应档位的开关；别猜测不存在的工具名。',
  lightpanda:
    'Lightpanda 作为后端（无头文本渲染引擎，beta）：设置面板「添加 Lightpanda（受管）」——受管 serve 行（本机单例，插件负责拉起/复用/停止；win32 经 WSL2，linux/mac 本机直装），激活后 probe 自动识别 engine 并全链降级；也可用普通 CDP 端点接已自起的 serve（http://127.0.0.1:9222）。' +
    '**有头/无头与顺序语义**：CDP 端点/本机 Chrome/ego CLI 是有头类型——可人工兜底（手动输账号、过验证码），是兜底主力；Lightpanda 是无头类型——无法人工介入，只适合快速试验。顺序即优先级：把 Lightpanda 排在前面 = 快速场景优先用它；排在有头类型后面 = 有头兜底优先，Lightpanda 实际不会被启用。' +
    '安装——linux/macOS：`curl -fsSL https://pkg.lightpanda.io/install.sh | bash`（装入 ~/.local/bin，确保 PATH 含它），`lightpanda serve --host 127.0.0.1 --port 9222`；' +
    'Windows：无原生版，用 WSL2（管理员 `wsl --install`，WSL 内同上；WSL2 自动把端口映射到宿主 localhost）或 Docker（`docker run -d -p 127.0.0.1:9222:9222 lightpanda/browser:nightly`）。' +
    '可用：navigate/js/click/fill/key/snapshot(AX树)/http/login_import 等；降级：截图=PNG 文本渲染（jev 输出带 engine/rendering 元数据）；关闭：观察窗实时画面、面板点选、bcdp_download（调用即结构化报错）、auth_flush（返回 degraded）',
  judge:
    'JEV/Laya 判定（阶段 10）：机械采集「截图 + 编号 DOM + 意图 + 操作进度」→ 组装问题 → 取选择 → 执行 → 验证。' +
    '判定器只能回传编号，绝不给选择器（幻觉选择器在结构上不可能）。' +
    '四件套：bcdp_jev_status（先跑这个：判定链可用性 + 配置体检，不发任何请求）/ bcdp_jev_frame（采一帧，看判定器会看到什么）/' +
    'bcdp_jev_ask（组装请求体；dryRun 默认 true，可指定 round=control|chapter|pick|evaluate 逐级看）/ bcdp_jev_run（跑循环，返回逐步 trace）。' +
    'bcdp_jev_attempt（平的尝试循环）：给 url + goal，开页后每轮选项 = DOM 候选 + end 项，判定模型在 maxActions（默认 5）预算内行动或自选 end 结束，回执含每步 anchor；判定上下文只走 DOM 树文本（模型不读截图），完成后你用 bcdp_cdp/bcdp_screenshot 按 targetId 自行核验——回执是报告不是证明。' +
    '**三级缩小**：control（要不要动手，固定 5 项）→ chapter（哪个章节，按 AX 容器聚簇）→ pick（章节内哪个编号 + 风险度）。' +
    '分章节不是装饰：阈值按候选数分桶，把 20 选 1 拆成「几选 1 × 几选 1」会让两轮都落在更严的桶里。单章节时不问章节轮。' +
    '**判定上下文是隔离的**：只允许 INTENT / PROGRESS / FRAME / HISTORY 四段，**绝不带 agent 会话 session 前缀**；' +
    '多出任何一段都会在组装时直接抛错（不靠约定，靠断言）。PROGRESS 由循环自己机械生成，不让模型写（模型写的进度是第二个人幻觉通道）。' +
    '**评估开关 jevEvaluate（默认开）**：每步执行后判定器再判进度 inprogress/done/fail；fail 或「未验真的 done」不猜下一步，直接 escalate——带有序 RecoveryOption（reload 排第一，因陈旧渲染会藏住已写入的确认），交回你来恢复或停手。' +
    '被操作元素会保留 class 等定位特征（只剥离检视器外壳 token）随 escalate 回传，便于恢复。' +
    '**默认链路是 laya -> rule**：JEV 目前无法注册，所以默认不写它；将来可用时把 jev 加回跳序并填 URL 即可。' +
    '不可用的跳**跳过不调用**（laya-api 强制鉴权无匿名分支，缺 key 必然 401），每一跳的跳过与失败都记进 trace，绝不静默回落；refuse 是结果不是异常。' +
    '阈值一律用选中项概率 top（不是 confidence：后者是归一化熵，2 选 1 与 20 选 1 不可比）。' +
    '设置面板键：layaUrl/layaKey/layaModel（laya 端口 8000，不是 7789）、judgePrefer、jevChunkSize、jevMaxImageBytes、jevHistoryLimit、jevArchiveImage、jevStepBudget、jevWallMs；jevUrl/jevKey/jevModel 留空即可（JEV 未开放注册）。',
}
