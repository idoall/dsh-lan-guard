# Changelog

## [Unreleased]

### 修复 — 设备操作按钮折行

「吊销并拉黑」等小号按钮在设备行里被挤窄后**折成两行**（用户截图实测）。原因：小号按钮缺 `white-space:nowrap` 与 `flex-shrink:0`，设备行的文本列也没有 `min-width:0` 让位。修复后浏览器实测按钮高度 **28px（单行）**、宽度 82px、文案完整。

### 新增 — 设备批准与永久拉黑（SPEC F9，方案 A，进行中）

第一步：**数据模型与设计文档**（本轮完成）

- `DeviceRecord` 新增 `status`（`pending` / `approved` / `blocked`）与 `decidedAtMs`；
- **加载时迁移**：F9 之前写入的记录没有 `status`，加载即视为 `approved`，不打断既有设备；
- 注册表新增三态 API：`add(label, { pending })`、`setStatus(id, status)`、`lookup(token)`（不论状态都能查到，供门禁渲染等待页）、`pendingCount`；
- `verify()` 收紧为**只认 `approved`**：`pending` 不放行（门禁给等待页）、`blocked` 永不放行且记录保留（这正是「永久拉黑」的实现方式，不依赖设备指纹）；
- 测试新增 4 项（待批准不放行但可查、批准后放行、拉黑后拒绝且记录保留、解除拉黑是唯一出路、旧记录迁移为已批准、空操作不写盘）；`pnpm test` **223 项**全绿。

待续：`auth.requireApproval` 开关、门禁等待页与 `blocked` 拒绝、批准/拉黑/解除端点、设置页三组列表与两个开关、手机侧等待批准页。

### 新增 — 设备批准与永久拉黑（SPEC F9，方案 A）

「吊销」只能让设备的身份 cookie 失效；F9 让**拉黑变得永久**——不依赖设备指纹，而是把放行权交给管理员。

- **三态数据模型**：`pending` / `approved` / `blocked`；F9 之前写入的记录加载时迁移为 `approved`（不打断既有设备）；
- **开关**：`auth.requireApproval`（默认 **false**＝保持现状）；开启后新设备命名完进入「待批准」；
- **门禁**：`pending` → 手机侧「等待管理员批准」页（`/api/*` 返回 `403 pending_approval`）；`blocked` → `403`「已被移除访问权限」，**重新配对仍被拒**（唯一出路是管理员「解除拉黑」）；
- **端点**：`POST /plugins/dsh-lan-guard/devices` 新增 `action: approve | block | unblock`（沿用管理面鉴权、CSRF 与远程只读规则）；
- **设置页**：「已授权设备」tab 新增第二个开关「新设备需要管理员批准」+ 三组列表（**待批准**：批准 / 拒绝并拉黑；**已授权**：吊销并拉黑；**已拉黑**：解除拉黑）+ 待批准提醒条；
- 测试新增 4 项（待批准显示等待页且 API 返回 `pending_approval`、批准后放行、拉黑后拒绝、端点 approve/block/unblock、快照 `pendingCount`）；`pnpm test` **229 项**全绿。

## [0.2.0] — 2026-09-25

### 新增 — 升级检测（SPEC F8，方案 A）

- **只读检测**：宿主查询 `https://registry.npmjs.org/dsh-lan-guard/latest`，与运行版本比较；成功/失败都缓存 **6 小时**，「检查更新」按钮可强制刷新（`?force=1`）。
- **新端点**：`GET /plugins/dsh-lan-guard/update[?force=1]`（管理面、只读、遵守原生栅栏）。
- **版本比较自实现**：支持 `x.y.z` 与预发布后缀（遵循 semver 优先级），**不引入 `semver` 依赖**。
- **失败即报告**：离线/注册表不可用 → `error: 'registry_unavailable'`，只提示、不抛错，不影响门禁与代理。
- **设置页 UI**：分区内芯片（绿「vX ✓ 最新」/ 蓝「vX ➔ vY」/ 灰「检查失败」）+「检查更新」+ 静态链接（GitHub / 更新日志 / 反馈 Issue）；有新版时展开面板给出**可复制的升级命令**并提示「需你手动重启 dsh 才生效」。
- **明确不做**：不自动安装、不自动重启、不接 GitHub API（更新亮点改为指向仓库 CHANGELOG 的静态链接）——宿主只报告，操作权留在人手里。
- 测试：新增 `tests/update-check.test.ts`（9 项：版本解析/比较/预发布优先级、缓存与 force、注册表失败与网络异常均不抛错）；`pnpm test` **219 项**全绿。

### 移除 — 右下角「局域网访问已开启」状态胶囊（P4-f）

用户反馈后移除。原因：该胶囊（官方追加型 seat `shell.overlay`）把**免密链接（含 `dsh_` token）常驻在屏幕右下角**——截屏或共享屏幕时会一并被拍到；且 `sessionStorage` 的「不再显示」只在当前标签页会话有效，**每次新会话都会再次出现**。

- 客户端不再注册任何 `shell.overlay` 内容（`StatusOverlay`、seat 常量与相关 CSS 一并删除）；
- 局域网状态改由设置页「扫码访问」tab 呈现（状态胶囊「运行中」+ 地址 + 唯一二维码）；
- SPEC F6 与 PLAN 的 P4-f 条目已标注为「移除」，不是「未实现」。

## [0.1.1] — 2026-09-25

### 文档

- **README 重写为中英双语用户文档**（README.md / README.zh.md，各 147 行，结构与 dsh-update-status 对齐）：徽章 + 语言互链 + 锚点导航 + 「能力 / 安装 / 使用 / 兼容性（含版本对应表）/ 配置（完整键表）/ 排障 / 安全边界 / 卸载 / 开发」；原先的「计划提供的能力」等实施前规划稿措辞已全部替换为已发布状态的描述。

## [0.1.0] — 2026-09-24

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

### 实现 — P2 门禁 + 设置 UI（2026-09-24）

- **门禁核心** `src/auth/manager.ts`：PBKDF2-SHA256（迭代 600000、派生 32 字节、存储格式 `pbkdf2-sha256$<iterations>$<hex>`、兼容旧裸 hex 按 10000 次）、全部比较走 `timingSafeEqual`、双密码（访问 + 独立管理）、`dsh_`+36 hex 免密令牌、普通会话落盘 / 管理员会话仅内存、按 IP 失败计数与锁定、统一 `verifyRequest`、`adminPolicy` / `allowLoopback` 判定、CSRF 校验。
- **敏感数据落盘** `src/store/secrets.ts`：`<dataDir>/secrets.json`（哈希/盐/令牌）与 `sessions.json`（普通会话），原子写 + 权限 **600**；损坏的 secrets.json **拒绝启动**而不是当作空密码（避免「任意密码都能进」）。
- **登录页** `src/auth/login-page.ts` + **访客门** `src/auth/gate.ts`：HTML 导航 → 登录页、`/api/*` 与静态资源 → 401 JSON、登录 POST（CSRF + 限流）、`?auth=<token>` → 302 到去掉 token 的干净 URL、门禁自有路径不转发上游；三态提示（密码错误 / 已锁定含剩余秒数 / **尚未设置密码**）。新增状态 `token-only`。
- **设置 UI**（路线乙）：非敏感开关 `enabled` / `auth.mode` / `auth.adminPolicy` / `auth.adminProtection` / `auth.allowLoopback` 声明为 `Config` 的 **volatile** 字段；`src/settings/routes.ts` 提供 `/plugins/dsh-lan-guard/config`（GET/POST）与 `/auth-status`，**先用 `connection.requestRejection`** 复用 DSH 原生栅栏；非敏感开关经宿主 `ctx.settings.update()` 写入（**单一数据源**，落 profile patch）；`src/client.ts` 注册官方 `settings.section`（`id: dsh-lan-guard`、`order: 100`、`label: 局域网访问`），纯 `React.createElement` + 内联 CSS + `--dsw-alias-*` 变量 + 两个响应式断点。
- **相位门禁**：非 loopback 的 `listenHost` 在 P3 之前仍直接拒绝启动。
- **测试 142 项**（新增 `tests/auth.test.ts` 25 项、`tests/gate.test.ts` 21 项、`tests/settings-routes.test.ts` 22 项，另扩充 config/plugin）。

### 实现 — P3 局域网 + 自签 TLS + 二维码（2026-09-24）

- **`src/network.ts`**：枚举非内部 IPv4 网卡，虚拟网卡（Docker/VMware/VPN/Tailscale/Apple P2P）与不可路由网段**识别并降权**而非隐藏；显式配置的网卡不存在时**返回空而不是回退**到别的地址。
- **`src/tls/ca.ts`**：自签 CA（`commonName: DSH LAN Guard CA`——**用户决策**；EC P-256 / sha256 / 5 年 / `basicConstraints cA:true critical` / `keyUsage keyCertSign`）；`assertMatchingCa()` 校验自签、CA 位与公私钥 SPKI 匹配；私钥 600、证书 644；**CA 身份跨重启保留**。
- **`src/tls/leaf.ts`**：按当前网卡 IP 签发叶证书（SAN 覆盖全部当前地址 + 回环），CA 不变时**只重签叶证书**；到期前 7 天自动续期。
- **`src/qrcode.ts`**：服务端出 **SVG**（`qrcode`，无 base64 膨胀），组装访问地址集 + 普通链接二维码 + 免密链接二维码（`?auth=`）；**每次请求重建**，因此网卡/端口/TLS/令牌变化即自动刷新；仅回环绑定时**不产出二维码**并说明原因。
- **`src/proxy.ts`**：支持 HTTPS 监听（`node:https`，证书由 `tls.mode` 决定）。
- **`src/index.ts`**：放开非回环监听；`tls.mode: 'self-signed'`（默认）自动准备 CA+叶证书；**非回环 + `tls.mode: 'off'` 直接拒绝启动**（明文会泄露门禁密码与上游 cookie，局域网 HTTP 属 P4-e，需显式风险确认）。
- **设置页**：状态卡片加入访问地址、`复制链接` / `显示·隐藏二维码`、二维码（默认展开）、免密链接与其二维码（仅管理员解锁时返回）+ 重新生成、`请在私密环境下使用`、PWA 引导；连接与证书卡片加入 TLS 关闭影响提示与 CA 指纹。
- **密码策略**：按**用户决策**实施最短 8 位（`MIN_PASSWORD_LENGTH`），前端提示 + 端点校验。
- **测试 170 项**（新增 `tests/network.test.ts` 9 项、`tests/tls.test.ts` 9 项、`tests/qrcode.test.ts` 7 项，另扩充 settings-routes 与 plugin）。
- **`docs/PLAN.md`**：经用户批准，P1/P2/P3 的「必须验证」勾选框已勾选，并在每节标注**验证方式**与**仍未验证的部分**（浏览器视觉呈现留给手机实测）。

### 实现 — P4-a 网卡选择交互（2026-09-24，用户选定范围内）

- `networkInterface` 升为 `Config` 的 **volatile** 字段（非敏感开关，符合 SPEC F6；也是经宿主 `settings.update()` 写入的前提），并在 `LiveSwitches` 中暴露；`access` 信息每次请求读取**实时值**，因此选择变化**无需重启**即刷新地址与二维码。
- `src/store/preferences.ts`：`networkInterface` 纳入偏好白名单与校验（空串 = 自动；只接受网卡名或地址字面量，非法值拒绝；未知键仍丢弃）。
- `src/client.ts`：连接与证书卡片加入**网卡下拉**（列出全部候选地址，标注虚拟网卡及原因），写入走同一 `/config` 端点。
- 新增/扩充测试 4 项（config 的 volatile 与校验、偏好清洗、设置端点写入、未知键丢弃）；合计 **174 项**。
- 真实验收（临时 DSH 实例）：默认自动 → `https://10.0.0.20:3471/` + 二维码；选不存在的 `en9` → **即时**变为无地址、无二维码并给出原因；切回自动 → 地址与二维码恢复；选择落进 profile patch。测试期间曾短暂绑定 `0.0.0.0:3471`（门禁与自签 TLS 生效），验收后立即关闭。

### 变更 — 安装进用户真实 profile（2026-09-24，用户当次明确授权）

按用户授权（`AGENTS.md` §3.1 红线的当次明确要求）把插件装入用户真实的 `web` profile，**未重启 dsh**：

- 备份：`~/.dsh/profiles/web/cordis.patch.yml.bak-lan-guard-20260924-195531`（原文件 3305 字节，权限 600 保留）；
- 软链：`~/.dsh/profiles/web/node_modules/dsh-lan-guard` → 本仓库（与该机既有约定一致，如 `dsh-free-search`、`dsh-mobile`）；
- 追加条目：`- id: dsh-lan-guard` + `name: dsh-lan-guard`，config 为 `listenHost: 0.0.0.0`、`listenPort: 3445`、`upstreamOrigin: http://127.0.0.1:3080`、`dataDir: ~/.dsh/profiles/web/data/dsh-lan-guard`（沿用该机既有约定）、`tls.mode: self-signed`、`auth.allowLoopback: true`；
- 重启前预检：patch YAML 解析通过（顶层 11 条）、模块可从 profile 目录解析、导出面与 `dsh` 元数据正确、`Config(row.config)` 解析出预期值、客户端 bundle 存在。

**修正一处不一致**：`auth.enabled`（门禁总开关）此前被标为 `.volatile()`，即可在设置页写入，但 `AuthManager` 读的是启动时的静态值——**可写却不生效**。按 `docs/PLAN.md` §5 工作项 9 的 volatile 清单，`auth.enabled` 已改回非 volatile（门禁总开关属启动期安全字段，见 SPEC §5 默认值原则 3）。可写开关现在恰好是：`enabled`、`networkInterface`、`auth.mode`、`auth.adminPolicy`、`auth.adminProtection`、`auth.allowLoopback`。

### 修复 — 手机访问导致 dsh 崩溃（2026-09-24，用户实测「手机一访问 DS 就崩溃」）

**根因（已用日志与复现双重确认）**：`writeJson` 使用**固定临时文件名** `${path}.tmp`。手机加载页面会**并发**发出几十个请求，而门禁在**每个**设备请求上都调用 `touch()` 重写 `devices.json` → 多个写并发写同一临时文件 → 一个 `rename` 成功、其余 `rename` 报 **ENOENT** → 该 rejection 逃出请求路径成为 **unhandled rejection** → Node 24 终止进程。

日志原话：`dsh: fatal load failure: Error: ENOENT: no such file or directory, rename '.../devices.json.tmp' -> '.../devices.json'`

**复现与验证**：
- 旧构建 + 40 个并发请求（非回环来源）→ 全部 `000`（无响应）+ 日志出现上述 fatal → **稳定复现崩溃**；
- 新构建 + 60 个并发请求 → **全部 200**、进程存活、日志**零** `fatal/ENOENT/unhandled`。

**四层修复**：
1. `writeJson` 改用**唯一临时名**（`${path}.${pid}.${random}.tmp`）；
2. 同一路径的写入**串行化**（每路径一个 promise 队列，前一个失败也继续下一个）；
3. `DeviceRegistry.touch` **节流**（同一设备同一地址 5 分钟内不重复写盘）——从根上消除「每请求一次写盘」；
4. **兜底捕获**：设备 touch 失败只记日志、绝不影响请求；`proxy.ts` 里 `gate.handleHttp` 外层加 catch，任何门禁异常都回 `500` 而**不再让 rejection 逃逸**（一次坏请求绝不能带走 dsh）。

**测试**：新增并发回归（30×`touch` + 30×`saveDevices` + 30×`saveSessions` 并发不得失败）与节流行为用例；`pnpm test` **210 项**全绿。

**教训（我先前判断错误）**：我曾用**顺序** curl 复现该路径并判定为「手机网络层问题」——顺序请求不会触发竞态，所以结论是错的。已改为按「用户描述的现象（崩溃）」去找崩溃源，而不是先相信自己的复现结论。

### 变更 — 移除重复的「创建设备」入口（2026-09-24，用户反馈）

用户指出：*「我们已经有扫码输入设备的页面，不需要再创建了。创建这个按钮和输入框没有意义。」*

配对页（手机侧自己命名）已经承担了设备创建的职责，控制台里的手动创建表单是旧模型（v1：管理员预建设备）的遗留，属于重复入口。已删除：

- 客户端：「已授权设备」tab 里的**名称输入框 + 「添加设备」按钮**，以及只为它存在的一次性链接与二维码展示（含 `addDevice()` 与相关状态）；
- 服务端：`POST /devices` 的 `action: "add"` 分支，以及**仅被该流程使用**的 `GET /plugins/dsh-lan-guard/qr?text=<url>` 端点（端点总数 5 → 4）；
- 原位置改为 **「新设备需要命名确认」开关**（`requirePairing`），并在说明里写明「设备由手机首次配对时自己命名」；
- 测试同步调整（设备列表/吊销用例改由注册表直接造数据；路由清单去掉 `/qr`）。`pnpm test` **208 项**全绿。

### 新增 — P4-d mDNS 发现（2026-09-24，用户批准引入依赖）

- 引入 **`bonjour-service@1.4.4`（MIT）** 作为运行时依赖（经用户批准，AGENTS §4 灰名单）；
- 新增 `src/mdns.ts`：把运行中的监听器描述成 mDNS 记录（`_dsh-lan-guard._tcp` + TXT `scheme`/`host`/`url`）并广播；**publisher 可注入**，因此生命周期在无多播的测试环境里也能验证；
- 新增配置 `mdns.enabled`（默认 **false**）：广播是新的可发现面，与本项目「默认关闭、显式打开」一致；
- **广播失败绝不影响代理**（contained，仅告警）；插件关闭时 `unpublishAll` + `destroy`；
- **诚实限制**（写入 README 与 SPEC F5b）：iOS Safari / Android Chrome 实践中不为任意网页解析 `.local`，mDNS 主要方便发现工具与桌面浏览器，**手机上的可靠路径仍是二维码**；
- 测试新增 4 项（记录构造 ×2、发布/释放生命周期、发布失败不抛）。`pnpm test` **208 项**全绿；build / verify 通过。

### 新增 — P4-e 局域网 HTTP 的显式确认开关（2026-09-24，用户批准）

SPEC §6.2 要求「非回环 + 无 TLS 必须显式确认」，此前只是**一律拒绝**。现补上确认路径：

- 新增 `tls.allowInsecureLan`（默认 **false**）；未开启时，非回环 `listenHost` + `tls.mode: 'off'` 在**配置校验阶段直接拒绝启动**，错误信息给出三条可操作出路（开 TLS / 绑回环 / 显式接受风险）；
- 开启后允许启动，并在启动日志打印**明文警告**（门禁密码不加密）；设置页的 TLS 卡片已有关闭 HTTPS 的影响提示；
- 测试：新增 3 项（未确认时拒绝、确认后允许、回环无需确认）。`pnpm test` **204 项**全绿。

**P4-d（mDNS 发现）仍待实施**：需引入 `bonjour-service`（MIT）作为新的运行时依赖，按已批准方案排在其后。

### 变更 — P4-g 改为 dsh-mobile 式设备身份模型（2026-09-24，用户实测反馈）

用户实测反馈三点，其中两点是真缺陷、一点是模型不对：

1. **「改成需要密码，手机却不用输」**：门禁顺序是「被锁定？→ 有有效会话？→ 放行 → 否则要密码」，手机里留着之前下发的 **30 天会话 cookie**，所以不必再输——而**改密码/切模式时我没有吊销旧会话**。已修：**设置/更换访问密码、或切换验证模式时立即吊销所有访客会话**（管理员会话一并清掉）。
2. **「看不到已授权设备」**：因为当时一台设备都没配对过（`devices.json` 不存在）。原 P4-g 是「管理员先预建设备」，与用户预期不符。
3. **按 dsh-mobile 模型重做**：设备**第一次进来时自己命名**——
   - 远程访客通过门禁但没有设备身份 → **配对页**「确认这台设备」（名称按 User-Agent 预填 + 显示来源地址）；`/api/*` 返回 `428 pairing_required`；
   - 确认后服务端生成设备令牌并下发 **HttpOnly 设备 cookie**（`dsh_lan_guard_device`，一年），同时记录名称 / 创建时间 / 来源 IP；
   - 之后每个请求都校验设备 cookie：**记录被吊销或未知 → `403`「此设备已被移除访问权限」**（即「删除后它就进不来」）；有效则更新「最近使用」；
   - **本机操作者（回环直连）永远不参与配对**；
   - 新增 volatile 开关 `auth.requirePairing`（默认 **true**），设置页「已授权设备」tab 可关；
   - 设备列表新增「删除记录」（删除后该设备可重新配对），与「吊销」（保持拒绝）区分。
4. **诚实的边界**：密码是共享的，吊销只保证**那台设备的身份 cookie 立即失效**；换浏览器用密码重新登录仍可再次配对。要做到「同一台机器永久拉黑」需要设备指纹或每设备独立令牌，属更重方案。

`pnpm test` **201 项**全绿（新增配对页、设备 cookie 识别、吊销拒绝、`428` API 提示等用例）；build / verify 通过。SPEC F3/F6、PLAN 已同步。

### 新增 — P4-g 完整设备配对（2026-09-24）

总免密令牌是「全有或全无」——吊销它等于把所有手机一起踢下线。设备配对给每台手机一条**可单独吊销**的凭据：

- **`src/store/devices.ts`**（新）：`DeviceRegistry`——创建（`dsh_dev_` + 36 hex）、校验（**恒定时间**）、吊销、记录最近使用与来源 IP；**只持久化 SHA-256 哈希**，明文令牌只在创建时返回一次；`devices.json` 权限 600。
- **门禁**：`?auth=<设备令牌>` 与总令牌共用同一入口，命中即下发会话并 302 到干净 URL；**已吊销的设备一律拒绝**。
- **管理端点**：`GET/POST /plugins/dsh-lan-guard/devices`（列表 / `action: add` / `action: revoke`）+ `GET /plugins/dsh-lan-guard/qr?text=<url>`（为设备链接渲染二维码）；均复用原生栅栏与 CSRF，且遵守 `local_only` 的远程只读。列表**绝不返回令牌或哈希**。
- **设置页**：新增第 4 个 tab **「已授权设备」**——设备列表（名称 / 创建 / 最近使用 / 来源 IP）、添加设备（新链接**只显示一次**，带二维码与复制）、逐个吊销。
- **测试**：新增 `tests/devices.test.ts`（6 项：令牌格式与校验、**明文不落盘**、吊销即失效、跨重启持久化、记录最近使用、空名称兜底）+ 门禁端到端（设备链接 302 且吊销后 401）+ 端点（列表/新增/吊销、远程只读拒绝、非法 action 400）。`pnpm test` **198 项**全绿。

**说明**：P4-d（mDNS，需引入新运行时依赖）与 P4-e（局域网 HTTP，需显式接受明文风险并改 SPEC §6.2）仍未实施。

### 变更 — P4 续做：品牌蓝、端口可配 + 自动顺延、状态浮层（2026-09-24）

用户指示：「换成参考图的品牌蓝，继续完善 P4」，并要求端口可配、被占用时给提示。

**1. 主按钮改品牌蓝**（用户拍板，取代原先主题相关的近白主按钮）
- 主按钮底色 `--dsw-static-deepseek-500`（#4176e6）+ 官方白字 token `--dsw-static-neutral-bluish-00`（#fff）；开关选中态与「大卡片选择器」选中边框同用品牌蓝。**仍是官方变量，无硬编码颜色**。
- 实测（browser-skill）：主按钮 `rgb(65,118,230)` / 白字、开关选中态同色。

**2. 端口可配置 + 被占用提示 + 自动顺延**（用户明确要求）
- **默认端口 3445 → 3081**（DSH 的 3080 + 1，符合「3081/3082/3083 依次往后数」的直觉）；仍避开 3443/3444（dsh-mobile）。
- **被占用自动顺延**：从配置端口起最多再试 10 个连续端口，取第一个可用的。**真正的绑定动作本身就是探测**——不额外开探测 socket，因此没有竞态、也不会出现「无门禁的探测监听」。
- **`listenPort` 升为 volatile**（可经设置页写入），`连接与证书` tab 新增端口数字输入 + `保存端口` + 可用性检查；发生顺延时设置页与日志都会说明「配置的端口 X 已被占用，已自动改用 Y」。
- 新端点 `GET /plugins/dsh-lan-guard/port-check?port=N`（受原生栅栏保护）：探测**只绑 127.0.0.1**，绝不为探测打开对外监听。
- 用户真实 profile 的显式 `listenPort: 3445` 已移除（改由插件默认 3081 决定；该行是 DSH 在设置页写入时回写的扁平行）。**下一次重启 dsh 后生效**，届时入口变为 `https://10.0.0.20:3081/`（若被占用则自动顺延）。

**3. P4-f：帧级状态提示浮层**
- 向官方**追加型** seat `shell.overlay` 注册紧凑胶囊（`id: dsh-lan-guard-status`）：「🌐 局域网访问已开启」+ 当前链接 + 「本次会话不再显示」；**只对本机操作者显示**（手机已在控制台内，无需再告知地址）；不替换任何官方内容。
- 实测：胶囊可见，文案含真实链接。

**4. P4 范围说明**
- **P4-d mDNS 未做**：Node 无内置 mDNS，需引入新运行时依赖（AGENTS §3.5/§4 灰名单，必须用户批准）或手写 DNS 报文（难验证）。
- **P4-e 局域网 HTTP 未做**：PLAN 原文即要求用户**显式接受明文风险**，且需改 SPEC §6.2。
- **P4-g 完整设备配对待做**。

`pnpm test` **188 项**全绿（新增端口校验、端口探测、代理端口顺延、端点注册等用例）；`pnpm run build` 与 `pnpm run verify` 通过。

### 验证 — P3 手机实测全部通过（2026-09-24）

用户实机反馈：**「这条是手机发布的消息。」**

- ✅ **发消息通过**：消息从手机经「门禁鉴权 → 反向代理 → DSH → Agent」送达，而发送路径就是 `/api/remote.mux` 那条 WebSocket 通道；回复也从同一通道回流到手机 → **WebSocket 长连接实际工作**。
- ✅ P3 退出条件（扫码打开 / 信任自签 CA / 密码登录 / 发消息 / 长连接）**全部满足**；官方 UI 零改动。
- 🔎 自查顺带发现并修掉一处**自己的违规**：`.lg-lock-emoji` 里残留了自定的 `line-height:1`，违反「客户端 CSS 自定排版属性必须为 0」这条不变量（实测 1 → 现为 **0**）。`pnpm test` 184 项全绿。
- 遗留观察项（非阻塞）：长时间挂起、走出 Wi-Fi 再回来时的重连表现；以及 P4-e（局域网 HTTP）场景。

### 验证 — 手机实机登录通过（2026-09-24）

用户实机反馈：**「无痕情况下可以访问，输入一次密码后即可」**。

- ✅ 上一次的 CSRF 误拒修复在**真机**上验证通过（此前手机侧 `Origin: null` 被误判为跨站）。
- ✅ 自签 CA 被手机接受（能打开页面即证书链通过）。
- ✅ 另确认：先前「重启后不需要密码」是**手机保留了 30 天有效期的普通会话 cookie**（非门禁失效）——已用非回环来源实测复核：无 cookie 时首页 `401` + 登录页、`/api/*` 为 `401`、伪造 token 为 `401`。
- 🔧 按承诺**移除**了 CSRF 错误态页面上那行临时诊断小字；同样的诊断信息改为**只写日志**（`sec-fetch-site` / `origin` / `host`），页面恢复干净。
- ⬜ 仍待用户确认：手机端**发一条消息**与 **WebSocket 长连接不断**（P3 退出条件的最后两项）。

### 修复 — 手机登录被 CSRF 判定误拒（2026-09-24，手机实测）

用户实测：「远程访问，输入密码也不对」→ 登录页返回「请求来源校验未通过」。

- **复现与定位**：从**非回环来源**（`curl --interface <LAN IP>`）经代理模拟手机提交：带正常头（`Origin` + `Sec-Fetch-Site: same-origin`）→ 通过（回「密码错误」）；无 `Origin` → 通过；仅显式 `cross-site` → 拒绝。说明判定逻辑本身没错，问题在手机发来的**非常规 Origin**——部分应用内浏览器/隐私模式在同源表单提交时发 `Origin: null`，而原实现在 `new URL(origin)` 抛错时直接 `return false`，把正常手机挡在门外。
- **修复**（`src/auth/manager.ts` 的 `passesCsrfCheck`）：`Sec-Fetch-Site` 作为权威信号（只拒绝显式 `cross-site`；`same-origin`/`same-site`/`none` 直接放行）；无该头时才回退到 `Origin`，且 **`Origin` 缺失 / 为 `null` / 无法解析一律放行**；能解析时比较 authority 并**容忍仅端口不同**。真正跨站必然带 `cross-site`，放宽不削弱防护。
- **可诊断性**：CSRF 拒绝时，登录页在该状态附一行灰色诊断（`sec-fetch-site` / `origin` / `host`），并把同样内容写进日志——万一下次仍失败，一次就能定位（此诊断行定位后即可移除）。
- 测试：`pnpm test` **184 项**全绿，新增走**真实代理 + 真实门禁**的端到端用例（`Origin: null` → 401「密码错误」而非 CSRF 页；显式 `cross-site` → 403）与 4 项判定单测。

### 修复 — 本机免锁语义 + 一批排版/文案问题（2026-09-24，用户实测反馈）

用户逐条反馈后集中修复。**分两类：客户端半刷新即生效；服务端半需要用户重启 dsh（模块代码不走 live reload）**。

**语义（服务端）**：
- **本机物理免锁**：用户指出参考实现「本机登录直接免锁，只有远程才需要锁定」，而我们本机也锁，体验差。现按来源判定：本机直连（回环 + 无访客标记）→ 免锁可写；远程（回环 + 带 `x-dsh-lan-guard-visitor: 1`）→ 按 `adminPolicy`：`local_only` **只读**（403 `read_only_remote`）、`password_unlock` **需解锁**、`open` 不锁。
- **机制**：代理转发时**先删后写** `x-dsh-lan-guard-visitor: 1`（`VISITOR_HEADER`），这是 DSH 侧区分「本机操作者」与「经代理访客」的唯一可靠信号（代理会把 `host` 改写成回环）；直连请求无法伪造。
- 免密链接改按「**可管理**」下发（本机操作者或已解锁的远程），而不是仅「已解锁」——否则本机免锁后反而看不到免密二维码。

**排版与文案（客户端）**：
1. 「已保存」改为 **2.5 秒自动消失**的提示条（原先常驻占一行）；
2. 解锁横幅**紧凑化**（`--dsw-font-xxs-12` + 小号次按钮），文案说明用途；本机免锁时不再显示；
3. TLS 两张卡片改用 `repeat(auto-fit, minmax(190px,1fr))`，**均分整行**（实测各 256px），不再挤在三分之一列；
4. CA 指纹放进等宽框并折行（实测高 62px、`scrollWidth == clientWidth`，**不再溢出**）；
5. 安全认证卡片新增一行说明：**访问密码 = 访客设备登录用；管理密码 = 解锁设置页管理台用（未设置时退回访问密码）**；
6. **只保留一个地址**：地址框显示的就是二维码内容（解锁＝免密链接、否则＝普通链接），去掉并存的第二个地址与重复的复制按钮（实测地址框仅 1 个、二维码 1 个）；
7. 锁定卡片的「忘记访问密码？」改为参考实现风格的「🛟 找回与重置访问密码指引」（本机直连免锁修改 / 无头环境删除 `secrets.json`）；
8. 远程只读时顶部给出说明条（「请在运行本程序的电脑上打开本控制台修改」）。

`pnpm test` **178 项**全绿（新增/改写 6 项覆盖本机免锁、远程只读、远程需解锁、访客标记不可伪造）。

### 修复 — tab 着色与锁定卡片照参考实现重做（2026-09-24，用户实测反馈）

- **tab 未选项「没跟上」**：我原先把未选 tab 调成 `label-secondary` 并把选中项加粗到 500，属于自创。实测官方**分段控件**（通用设置「外观 浅色/深色/跟随系统」）的规则是：所有项**同一字体、同一 `label-primary` 颜色**，选中态用 `bg-layer-3` 填充 + 边框改 `label-tertiary`。已照此重写 tab 条（胶囊形，与官方分段控件一致）。
- **锁定卡片照参考实现重做**（用户指出参考实现在锁定态「字体间距、颜色、文字大小」都更好）：
  - **去掉重复标题**：原先卡片标题头与居中标题都把「管理控制台已锁定」写了一遍（`Card` 现支持无标题）；
  - 标题与锁图标改用官方最大字号 token `--dsw-font-xl-24`（600 24px/32px）；
  - 说明段落从 13px 升为 `--dsw-font-s-14`（14px/22px，行距更舒展）；
  - 新增绿色胶囊「🔑 使用访问密码解锁」（`state-success-*`）；
  - 输入框改**全宽左对齐**（原先窄且居中），与按钮同宽（补 `box-sizing: border-box`，实测两者均 482px）；
  - 主按钮改为**始终可用的主按钮**（原先空输入即变灰），为空时提交给提示，并支持回车提交；
  - 恢复 `SPEC.md` F6 早就要求的「❓ 忘记访问密码？」红色链接（展开恢复说明）。
- 实测（真实 DSH，browser-skill 读 `getComputedStyle`）：锁定卡片 `0` 个重复卡片标题；标题 24/600/32；胶囊 13px 绿字深绿底；段落 14/400/22；输入框与按钮均 482px 且左对齐；主按钮为官方暗色主按钮（底 `#f9fafb` + 字 `#0f1115`）。**注**：dsh-bridge 的蓝色按钮用的是官方品牌蓝 `--dsw-static-deepseek-500`（#4176e6），与 DSH 官方暗色主按钮（近白）不同；本项目当前采用官方主按钮色，如需改蓝只需换一个 token。

### 修复 — 排版改用官方 font token（2026-09-24，用户实测反馈）

用户对比参考实现后反馈「输入框的字间距、按钮颜色和文字大小都很合理……我们是否可以读取它的字体大小，而不用自己设置？……你不觉得我们的字间距很难看吗？」。根因：我在设置页里**自己发明了字号/字重/行高**（16px/600、14px/600、12px/1.6 …），与官方规范脱节——官方每个尺寸都配了固定行高，自设 `line-height: 1.6` 会让中文行距松散，600 字重也比官方的 500 重。

修正：**字号、字重、行高三项全部改为官方 `font` 简写 token**，不再出现任何 `font-size` / `font-weight` / `line-height` / `letter-spacing` 声明（`grep -c` 结果为 0）：

| 元素 | 改前 | 改后（官方 token） |
| --- | --- | --- |
| 卡片标题 | 16px / 600 / normal | `--dsw-font-base-strong-16` → 16px / **500** / **24px** |
| 副标题、底部小字 | 12px / 400 / 1.6(19.2px) | `--dsw-font-xxs-12` → 12px / 400 / **18px** |
| tab、输入框、开关行 | 14px / 400–600 / normal | `--dsw-font-s-14` / `--dsw-font-s-strong-14` → 14px / **500** / **22px** |
| 主次按钮 | 14px / 600 / normal | `--dsw-font-s-strong-14` → 14px / 500 / 22px |
| 提示条、字段标签 | 13px / 400 | `--dsw-font-xs-13` → 13px / 20px |
| 等宽信息框 | 13px + 自定 mono 栈 | `--dsw-font-xs-13` + 官方 `--ds-font-family-code` |

实测对齐（真实 DSH，browser-skill 读 `getComputedStyle`）：`.lg-title` 16/500/24、`.lg-sub` 12/400/18、`.lg-btn` 14/500/22、`.lg-tab(选中)` 14/500/22、`.lg-mono` 13/400/20（SF Mono），**字距全部 `normal`**（与官方 nav 项一致）。官方 token 清单与「不许自定排版」的硬约束已写入 `docs/RESEARCH.md` §4.2.13 与 `docs/SPEC.md` F6 视觉规范表。

### 修复 — 二维码尺寸与白框（2026-09-24，用户实测反馈）

用户对比参考实现后反馈「别人做的二维码小而精致，你做的太大了」。根因两条：码体定成了 340px（`docs/RESEARCH.md` §5.10 的「约 340px」是把参考截图按 DPR 1 误读，按 DPR 2 重测应为约 190px），且白色底板用了 `display:flex; justify-content:center` 而**撑满整行**，视觉更笨重。

修正：码体 `190px × 190px`；白框改为 `width: fit-content` + `margin: auto` **贴合码体并居中**。实测（真实 DSH，browser-skill）：白框 212×212、码体 190×190、水平居中、卡片总高显著变短，且 `document.querySelectorAll('.lg-qr svg').length === 1` 仍成立。已同步修正 `docs/SPEC.md` F7 与 `docs/RESEARCH.md` §5.10 的尺寸记录。

### 变更 — 设置页改为 3 个 tab + 单一二维码（2026-09-24，用户实测反馈）

用户实测反馈：「安全认证和普通扫码可以分别做成两个 tab 页」「第一次进来没设密码有一个二维码，设了密码之后底下又出现一个二维码，搞不懂为什么要给两个二维码」。据此改版（用户选定 3 tab 方案）：

- **分区内做 3 个 tab**：**扫码访问**（状态 + 地址 + 唯一二维码）/ **安全认证**（模式三选一 + 双密码 + 回环免密）/ **连接与证书**（端口 + 网卡 + TLS + CA 指纹）。锁定态下 tab 2/3 显示居中锁定卡片，tab 1 仍可读。
- **任何时刻只渲染一个二维码，且它必须能用**：未设置访问密码 → **不画码**，只给「先设置访问密码」引导 + 跳转按钮（原先那个码扫了只会看到「尚未设置访问密码」）；已设密码未解锁 → **普通链接码** + 「解锁后可显示免密二维码」提示；已解锁 → **免密码**（扫码即登录），普通链接降级为 `复制链接`。
- 同步更新 `docs/SPEC.md` F6（页面结构 / 锁定态 / 首次配置不得被锁定态挡住）与 F7（单一二维码状态表）、`docs/PLAN.md`（改版说明与验收方式）。
- 真实验收（用户正在运行的 DSH，`patchReload: live` 热加载后刷新页面）：3 个 tab 均可切换；**`document.querySelectorAll('.lg-qr svg').length === 1`** 在解锁态与锁定态各验证一次；锁定后二维码由免密链接切换为普通链接并给出说明文案。截图存于 `.tmp/browser-proof/`（gitignored）。

### 修复 — 真实环境（用户正在运行的 dsh）暴露的两个缺陷（2026-09-24）

- **安装形式错误导致插件未激活**：profile patch 里的扁平 `- id: dsh-lan-guard` + `name:` 行只会「按 id 覆盖已存在条目」，对不存在的 id **被静默忽略**（无报错、无监听、设置页无分区）。已改为 `insert:` 列表形式；用户的 profile 设了 `dsh.profile.patchReload: "live"`，因此修正后**热加载进正在运行的 dsh（PID 不变、3080 会话不受影响），无需重启**。事实已写入 `docs/RESEARCH.md` §4.2.11。
- **首次安装死锁**：设置页初始为锁定态，而解锁需要密码——但此时**尚无任何密码**，于是「设置访问密码」的表单被锁在锁定卡片后面，永远到不了（真实环境复现）。两处修正：① 客户端在**未设置任何密码**时不进入锁定态（此时门禁本就拒绝一切设备，没有任何东西可保护）；② 服务端在**首次**设置访问密码成功后，顺带解锁本次管理会话，避免「刚设完就被要求再输一遍」。
- 真实验证（用户正在运行的 dsh）：插件热加载后 `*:3445` 监听、证书生成于 `~/.dsh/profiles/web/data/dsh-lan-guard/tls/`（私钥 600 / 证书 644）、设置页出现「局域网访问」分区与**可扫描二维码**、`--cacert` 对局域网 IP `https://10.0.0.20:3445/` 的**证书链校验通过**、非回环来源（模拟手机）被门禁拒绝为 `403 尚未设置访问密码`（**无暴露窗口**）。

### 修复 — 浏览器实测（browser-skill）发现的两个真实缺陷（2026-09-24）

> 这两条是**源码检查与 curl 测试都发现不了**的：前者是客户端状态刷新时序，后者是 CSS 变量名静默失效。

- **解锁后页面不刷新**：`write()` 原本用 POST 响应里的快照更新界面，而该快照是在响应 `Set-Cookie` 落库**之前**计算的，因此「管理员解锁」成功后页面仍显示锁定态、「重新锁定」后仍显示已解锁。现改为写操作后**重新 GET** 一次快照。
- **设置页用了一批不存在的官方 CSS 变量名**：`--dsw-alias-bg-elevated` / `-text-primary` / `-bg-secondary` / `-border-subtle` / `-bg-success` / `-bg-info` / `-bg-brand-weak` 等在 DSH 0.1.7 中**都不存在**，`getComputedStyle` 取空 → 样式静默退回硬编码回退值 → **暗色主题下白卡 + 近白文字**（与 `docs/RESEARCH.md` §5.6 记录的 dsh-mobile 事故同类）。已按实测出的真实变量名（`bg-layer-*` / `label-*` / `border-l*` / `state-*-primary|tertiary` / `button-primary-fill` / `label-primary-foreground`）重写设置页 CSS，并保留回退值；真实变量清单已写入 `docs/RESEARCH.md` §4.2.10。
- 复验：浏览器实测暗色（卡片 `#232324` + 文字 `#f9fafb` + 深绿提示条）与浅色（白卡 + 近黑文字）均正常；设置页分区、状态胶囊、安全提示条、访问地址、`复制链接`/`隐藏二维码`、**二维码真实渲染**、免密链接与二维码、三选一大卡片、密码不回显、网卡下拉、CA 指纹、锁定态与解锁横幅全部可见且可用。截图存于 `.tmp/browser-proof/`（gitignored）。

### 修复 — P2 实施中发现并修正的真实缺陷

- **`apply` 收到的是已解析配置**：Loader 会先用 `Config` 校验，volatile 字段此时是 `{ get() }` 引用而不是裸值，`parseConfig` 二次校验会把它当成非法布尔值。现先解包引用再校验（真实 DSH 实例上暴露，已加回归测试）。
- **首次设置密码死锁**：`setPassword` 一律要求当前密码，而首次根本没有密码（管理解锁又退回访问密码），导致全新安装无法启用门禁。现允许「未设置时」经原生栅栏引导设置。
- **`ctx.settings` 取不到**：未在 `inject` 声明时属性访问抛错，导致开关写入被降级为 400。改用 `ctx.get('settings')` 可选查询（声明依赖会让没有 settings 服务的 profile 直接无法加载插件）。
- **免密链接在 `password` 模式下挂起**：门禁把「忽略该参数」当成已处理，但实际没有写出任何响应，请求一直挂到超时。现返回「放行」由代理继续转发。
- **免密令牌没有生成入口**：改为管理员解锁时惰性生成，且只返回给已解锁的调用者。
- **插件总开关与门禁开关混淆**：`enabled`（插件，volatile）与 `auth.enabled`（门禁，静态）是两个开关，现已分开，`auth-status` 同时如实报告两者。

### 实现 — P1 骨架 + 最小反代（2026-09-24）

- **工程骨架**（`package.json` / `tsconfig.json` / `tsconfig.tests.json` / `tsdown.config.ts` / `vitest.config.ts` / `cordis.patch.yml`）：TypeScript + pnpm + tsdown + vitest，照 `docs/RESEARCH.md` §5.9 的 dsh-quick-replies 模板；`dsh.engines.dsh` 为 `>=0.1.7-rc.1 <0.2.0`，peer 范围覆盖 `0.1.7-rc.1`。
- **`src/config.ts`**：非敏感配置的 Schemastery `Config`（SPEC §5 全字段）+ 语义校验。被拒的非法值：缺 `dataDir`、非 IPv4 字面量的 `listenHost`、非 loopback 或非 `http:` 的 `upstreamOrigin`、`auth.enabled: false` 配非 loopback 监听、越界端口、未知 `mode` / `adminPolicy` / `tls.mode`、非正会话时长、`tls.mode: provided` 缺证书文件。
- **`src/headers.ts`**：Host/Origin 改写为上游 authority、注入 loopback cookie、剔除 hop-by-hop 头、响应侧丢弃上游 `set-cookie`、WS 101 只放行 5 个白名单头、请求目标规范化（裸 origin → `/`）。
- **`src/upstream-auth.ts`**：路线 A 的 token→cookie 交换与缓存（303 + `Set-Cookie` + `Location: ./`），并发去重、按 launch token 变化与过期前 60s 续换、401 后失效重换；token 与 cookie 只在内存，日志只记 cookie 名。
- **`src/proxy.ts` + `src/websocket.ts`**：`node:http` 原生反代，HTTP 流式转发（不缓冲）、WS upgrade 双向 pipe、`upgrade` 前立即挂 socket `error` handler、上游不可达 → 502、安全方法 401 后重试一次。
- **`src/index.ts`**：`inject = ['webServer', 'connection']`，`apply` 异步启动并把关闭注册为 fiber effect；**P1/P2 相位门禁**——非 loopback 的 `listenHost` 直接拒绝启动（P3 才放开）；拒绝与 DSH 自身端口冲突。
- **测试 71 项**（`tests/`，假上游绑 `127.0.0.1:0`）：配置校验、头改写、cookie 交换与缓存、HTTP/WS 转发、multipart 逐字节透传、大响应不缓冲、上游不可达、WS 断连不崩进程。

### 变更 — P1（2026-09-24）

- **新增 peer 依赖 `@deepseek-ai/schemastery`**（用户当次批准）：F6「路线乙」要求把非敏感开关声明为插件 `Config`（含 `.volatile()`），这必须用 Schemastery；已同步补进 `docs/SPEC.md` §4 的 peer 依赖表。
- **新增 `src/log.ts`**（`docs/SPEC.md` §4 模块清单之外的结构调整）：只放一个窄化的 `LanGuardLogger` 接口与 `noopLogger`，让宿主侧模块可在测试中用桩替换，并固定「任何日志调用都不得传入凭据」这条约束。SPEC §4 说明模块划分是建议性的。
- **`tsconfig.json` 的 `types` 为 `["node"]`**（模板为 `[]`）：本插件宿主侧必须用 `node:http` 等内置模块，没有 Node 类型无法通过类型检查；测试 tsconfig 继承同一设置。
- **新增事实回填 `docs/RESEARCH.md` §4.2**：`DSH_HOME` 覆盖、`--patch` 叠加层、`webServer` 注册签名、token 交换的精确语义、`/api` 栅栏细节、`evaluatePluginCompatibility` 只看 `@deepseek-ai/dsh*` peer、以及「loopback 上 `/plugins/*` 与 `/assets/*` 不受浏览器 cookie 栅栏保护」这一条（P2 门禁必须覆盖代理端口上的**全部**路径）。

### 新增

- 项目文档定稿：
  - `AGENTS.md` —— AI 协作总纲（职责、红线、停止点、工作流、漂移自检）
  - `docs/GUARDRAILS.md` —— 权限边界与职责矩阵
  - `docs/SPEC.md` —— 技术规格与未决事项
  - `docs/PLAN.md` —— 分阶段实施计划与验收标准
  - `docs/RESEARCH.md` —— 已核实的 DSH 事实基线
  - `docs/RELEASE.md` —— 发布流程与授权级别
- `README.md` / `README.zh.md` / `LICENSE` / `.gitignore`

### 变更（2026-09-24）

- **门禁规格定稿**：参考 dsh-bridge 的配置模型——`enabled` / `mode` / `adminPolicy` / `adminProtection` / 双密码（访问密码 + 独立管理密码）/ `secretToken` / `allowLoopback`，PBKDF2-SHA256 迭代 600000 带算法前缀，普通会话落盘、管理员会话仅内存。
  - `scope` 字段（`all` / `public_only` / `lan_only`）**省略**：本项目只有局域网一种通道。
  - **敏感数据改存插件私有 dataDir**（权限 600），不进 config——profile patch 是文本文件，可能被分享或提交。
  - 见 `docs/SPEC.md` F3、`docs/RESEARCH.md` §5.5。
- **设置 UI 定稿**：要做，参考 dsh-notify 的模式——注册官方 `settings.section` seat，纯 `React.createElement`（不引入 JSX），内联 CSS 使用官方 `--dsw-alias-*` 变量，覆盖触屏与窄屏两个断点；管理端点用 `connection.requestRejection()` 复用 DSH 原生栅栏。见 `docs/SPEC.md` F6、`docs/RESEARCH.md` §5.6。
- **实施计划调整**：P2 由「门禁」扩为「门禁 + 设置 UI」；原 P4-b「控制面板 UI」并入 P2；P1+P2+P3 预计约 1000–1350 行。
- **明确两套认证面**：设置页属**管理面**（DSH 原生栅栏），代理端口属**访客面**（本项目密码门禁）——能打开设置页 ≠ 能通过代理访问。
- **补充官方设置机制的事实与约束**（`docs/RESEARCH.md` §4.1）：DSH 0.1.7 移除了 `ctx.settings.register()`，改为 Config-derived forms——表单命名空间即 Loader 条目 id，`ctx.settings.describe()` 投影条目 `Config` 的 volatile 字段，客户端经 `ctx.configForms.get(entryId)` 读取，写入落 `cordis.patch.yml` 的 `<entry-id>.config`。
  - **关键约束**：官方表单在**非回环页面**（手机通过代理访问时）`mode` 被固定为 `memory`，终态 `unavailable` 且**永不写入**。
  - 由此在 F6 增设「技术路线」待确认项（甲：纯自定义端点 / 乙：混合，建议乙），并记入 SPEC §8 第 4b 项。
  - 参考实现：`dsh-quick-replies`（官方 configForms + 局域网直连兜底）与 `dsh-notify`（自定义 `/config` 端点），两者机制不同但都在本机运行。

### 复查（2026-09-24，dsh-mobile 0.3.14 → 0.4.5）

- **修正全部行号**：dsh-mobile 从 0.3.14 升到 0.4.5，代码量显著增长（`gateway.ts` 2353→2950、`plugin.ts` 831→1298、`mobile-layout.ts` 482→638），`docs/RESEARCH.md` 中所有引用行号已位移并逐个重新核对：证书实现 `managed-setup.ts` **217**（`assertMatchingCa`）/ **275**（`generate`）/ **369**（`refreshManagedServerCertificate`）、`cli.ts:110`、`config.ts:219`/`:256`；layout `mobile-layout.ts` **89**/`apply` **569**/`panelInfo` **586**。§5.1 已加注「行号对应 v0.4.5，引用前请重新核对」。
- **修正过时表述**：§8 原写「dsh-mobile 的 peer 止于 `^0.1.3-0`，会被 0.1.7 预检拦下」——v0.4.5 已放宽到 `^0.1.7-0`。
- **新增 `docs/RESEARCH.md` §5.7**：dsh-mobile v0.4.5 的四条实战教训——① WS upgrade 必须在异步鉴权**之前**挂 socket `error` handler（否则重连期断开会抛未处理错误）；② 失败的静态资源 404 不能按 `immutable` 缓存；③ 端口占用约定（`3080` DSH / `3443` 其局域网网关 / `3444` 其自带反代）；④ 它自 v0.4.2 起自带的反代 provider 与本项目的定位差异。
- **新增 `docs/RESEARCH.md` §7.1**：DSH 0.1.6/0.1.7 的**文档相对路由**（外壳 index 带 `<base href="./">`，浏览器侧用 `api/x`、`plugins/x`，服务端路由键仍为绝对路径），以及对本项目的四条影响（根路径不受影响 / 必须做尾斜杠规范化 / 不做子路径挂载 / 保持透明不改写资源 URL）。
- **SPEC 相应收紧**：默认端口 `3443` → **`3445`**（避开 dsh-mobile 占用的 3443/3444）；F1 增加「只支持根路径挂载、尾部斜杠规范化、不改写资源 URL、缓存头只对 200 加 immutable」；F3 增加「异步鉴权之前必须先挂 socket `error` handler」。
- **PLAN 相应补充**：P1 验收增加「插件 bundle（含文档相对形式）能加载」「尾斜杠规范化」「资源 URL 未被改写」三条；P2 验收增加「鉴权挂起期间断开 socket 不崩进程」。

### 拍板（2026-09-24：7 项未决事项 + 二维码）

- **7 项未决事项全部拍板**，`docs/SPEC.md` §8 由「未决事项」改为「**已确认的决策**」：

  | # | 决定 |
  | --- | --- |
  | 1 | 上游认证走 **A**——用 `ctx.connection.authenticatedUrl()` 完成 token→cookie 交换，**不自签** cookie |
  | 2 | 门禁配置模型参考 dsh-bridge（此前已定） |
  | 3 | **TLS 默认开启**（`mode: 'self-signed'`），可关闭；**关闭时设置页必须提示影响**（明文传输、凭据可被嗅探、secure context 能力受限、仅限可信私有网络） |
  | 4 | 设置 UI 要做（此前已定） |
  | 4b | UI 技术路线 **乙（混合）**——非敏感配置走官方 `configForms` 自动表单（volatile `Config`），敏感交互与手机场景走自定义端点 |
  | 5 | 网卡选择：配置文件 + 自动探测 |
  | 6 | 发布策略：保守 **L0** |
  | 7 | **语言：TypeScript**（用户统一约定：今后所有项目都用 TS） |

- **新增 `SPEC.md` F7 局域网二维码访问**（P3，**必做**）：设置页内展示二维码（内容为当前可访问 URL），支持**普通链接**与**免密链接**（带 `secretToken`，展示需管理员解锁）、复制按钮，并随网卡 / TLS / 端口 / token 变化**自动刷新**；依赖 `qrcode`，**建议服务端出 SVG**（dsh-mobile 做法，`RESEARCH.md` §5.8）。**视觉细节待用户提供参考图。**
- **`SPEC.md` §4 改为 TypeScript 工程栈**：模块划分全部改为 `.ts`；工程栈照 dsh-quick-replies（`RESEARCH.md` §5.9）——`tsdown` 构建、`vitest` 测试、`tsc --noEmit` 双 tsconfig、pnpm。
- **`PLAN.md` 相应调整**：P3 扩为「局域网可达 + 自签 TLS + 二维码」（150–200 → **350–500 行**）；原 P4-c 二维码并入 P3；P2 工作项 B 明确混合路线（volatile `Config` + **保留自定义端点兜底**）；P1 加入 TS 工程配置。P1+P2+P3 预计 **1200–1650 行**。
- **`RESEARCH.md` 去代码**：§5.1 中 dsh-mobile 的 `selfsigned` 调用示例改为**参数表格**，与「只借鉴参数、不复制代码」的约束一致。

### 视觉参考定稿（2026-09-24，用户提供 5 张 dsh-bridge 实机截图）

- **提取视觉语言**并写入 `docs/RESEARCH.md` §5.10：卡片分组（白底 / 1px 浅灰边框 / 圆角约 14px / 内边距约 20px / 间距 16–20px）、状态胶囊（绿=运行中、黑=已启用）、**大卡片选择器**（整卡可点、选中 2px 主色边框 + 浅主色背景）、锁定态、解锁横幅、等宽 URL 框、二维码白底卡片、内容宽度约 790px。
- **`docs/SPEC.md` F6 补充页面结构与视觉规范**：单分区四块——① 状态卡片 ② 安全认证卡片 ③ 连接与证书卡片 ④ 锁定态；并明确**不照搬** dsh-bridge 的横向 tab、版本升级提示、运维监控看板、配置导入导出、服务重启按钮（超出本项目范围）。
- **`docs/SPEC.md` F7 由「待参考图」改为定稿**：补上二维码区块的六步布局——安全提示条 → 等宽 URL 框 → 并排按钮（复制链接 / 显示·隐藏二维码）→ 二维码（**默认展开**）→「请在私密环境下使用」→ PWA「添加到主屏幕」引导文案。
- **新增一条硬约束**：免密 token **必须用 `?auth=`，绝不能用 `?token=`**——后者是 DSH 自身的 launch token 参数，代理需把它原样转发给上游换 cookie，同名会互相覆盖。代理识别 `?auth=` 后校验、下发自己的会话 cookie、**302 到去掉 token 的干净 URL**。
- 明确手机端**不提供**「分享给其他设备」入口，避免含 token 的链接二次扩散；需要分享时由本机设置页复制。

### 审计修正（2026-09-24）

- 阶段总览表与后文不一致：P3 仍写 150–200 行且不含二维码，P4 仍把控制面板和二维码当成待选。总览已与 P2/P3/P4 正文对齐。
- P0 仍把「§8 其余五项」标成未完成。已改为全部拍板；P0 仍不退出，直到用户明确说「开始 P1」。
- F2 仍写「上游认证待确认」。已改为路线 A 已定，路线 B 不采用。
- 配置示例把 `listenHost` 写成 `0.0.0.0`，与「默认不对外监听」矛盾。示例默认改回 `127.0.0.1`，对外必须显式修改。
- README（中英）和 `AGENTS.md` / `GUARDRAILS.md` 仍把 TLS 写成「可选」。已改为默认开启、可关闭并提示影响；README 补上二维码。
- F6 的「技术路线」「挂载位置」与 F6 同级，目录上像两条独立功能。已降为 F6 的子节。

### 说明

- **尚无实现代码。** 实施从 `docs/PLAN.md` 的 P1 阶段开始，需用户明确确认。
- 发布授权当前为 L0（保守，不发布）。见 `docs/RELEASE.md`。
