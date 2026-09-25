# SPEC — 技术规格

> 本文件定义**要做成什么样**。改动本文件需要用户批准（`AGENTS.md` §4）。
> 依赖的事实见 `docs/RESEARCH.md`；实施顺序见 `docs/PLAN.md`；红线见 `docs/GUARDRAILS.md`。

---

## 1. 目标

让**同一个局域网内的手机 / 平板浏览器**能安全地打开桌面上的 DSH 官方 Web 界面：

1. DSH 自身的 `127.0.0.1:<port>` 绑定**保持不变**；
2. 本插件在 `0.0.0.0:<自定义端口>` 上监听，提供反向代理；
3. 访问者必须通过**密码门禁**；
4. 官方 Web UI **原样复用，零改动**；
5. **默认自签 HTTPS**，可关闭；关闭时必须在设置页说明影响。

**一句话验收**：手机连同一个 Wi-Fi，浏览器打开 `http(s)://<电脑IP>:<端口>`，输入密码后能正常使用 DSH 会话、发送消息、看到工具调用，WebSocket 长连接不断。

---

## 2. 非目标（明确不做）

| 不做 | 原因 |
| --- | --- |
| 公网隧道（Cloudflare / cpolar / FRP / Tailscale） | 定位是局域网；公网暴露是另一个风险等级 |
| IM Bot（微信 / QQ / 飞书 / Telegram） | 与本插件目标无关 |
| 手机专属 UI（替换官方 layout） | 官方 UI 已自带响应式（`RESEARCH.md` §6.1），替换会带来强版本耦合 |
| 修改 DSH 的 `host` 绑定或任何 DSH 源码 | 见 `GUARDRAILS.md` §7「功能边界」 |
| 设备配对 / 二维码 / mDNS 发现 | P4 才由用户决定；当前不做 |
| 多用户账号体系 | 单密码门禁足够 |
| 解析 / 改写 / 缓存 DSH 业务 API | 透明转发即可；改业务流量会随 DSH 版本漂移 |
| 性能优化（压缩、分页、投影剥离） | dsh-bridge 做的那些是为公网带宽；局域网不需要 |
| 移动端 App | 只服务浏览器 |

---

## 3. 功能规格

### F1 反向代理（P1）

- 监听 `0.0.0.0:<listenPort>`（或指定网卡 IP）；
- HTTP：把请求转发到 `upstreamOrigin`（默认 `http://127.0.0.1:3080`）；
- WebSocket：处理 `upgrade` 事件，转发到上游，双向 pipe；
- **必须**支持：`/api/remote.mux`（Remote 流）、静态资源、`/api/*` 一元 RPC、`/plugins/*`（插件 bundle）；
- **必须**正确剔除 hop-by-hop 响应头（`connection`、`keep-alive`、`transfer-encoding`、`upgrade`、`te`、`trailer`、`proxy-*`）；
- **必须**正确转发 `multipart/form-data` 响应（0.1.7 的二进制结果传输依赖它）；
- 不缓冲大响应体（局域网无需，且缓冲会破坏流式语义）。

**DSH 0.1.6/0.1.7 的文档相对路由要求**（背景见 `RESEARCH.md` §7.1）：

- **只支持根路径挂载**——代理监听根，转发到上游根。**不做子路径挂载**（剥离前缀转发），也不从请求头推断挂载点；
- **必须做尾部斜杠规范化**：用户访问 `http://<IP>:<port>`（无尾斜杠）时规范化为 `/`，否则上游 `<base href="./">` 的解析目录会与预期不符；
- **保持透明，不改写资源 URL**：不重写 `/plugins/*`、`/assets/*` 的地址，不组装 bundle。上游已是文档相对形式，透明转发即正确；
- **不做缓存头改写**（若将来要做，只对 **200** 加 `immutable`，失败响应一律 `no-store`——见 `RESEARCH.md` §5.7 ②）。

### F2 请求头改写与上游认证（P1）

- 把 `host` 改写为 `127.0.0.1:<dshPort>`；
- 把 `origin`（若存在）改写为 `http://127.0.0.1:<dshPort>`；
- 注入一枚合法的 loopback 会话 cookie（`RESEARCH.md` §3.2/§3.4）；
- 不修改请求体、不修改业务语义。

**上游认证路线：A（已定，2026-09-24）**。

- 用 `ctx.connection.authenticatedUrl(origin)` 拿到带 launch token 的 URL，自行完成 `GET /?token=…` → 303 + `Set-Cookie` 交换，并缓存 cookie（30 天有效；launch token 变化时重新交换）。
- **不采用路线 B**（读凭据文件自签 cookie）。那条路依赖 DSH 私有格式，格式一变会静默 401。

### F3 密码门禁（P2）

> **规格参考 dsh-bridge**（字段语义与参数对齐，见 `RESEARCH.md` §5.5）。
> **`scope` 字段省略**：dsh-bridge 的 `all` / `public_only` / `lan_only` 是为「局域网 + 公网隧道」两种通道设计的；本项目只有局域网一种通道，三态没有意义。

**必须先于监听可用**（`GUARDRAILS.md` §3「网络行为边界」）。

**配置模型**：

| 字段 | 默认 | 语义 |
| --- | --- | --- |
| `auth.enabled` | `true` | 门禁总开关。**关闭时只允许监听 `127.0.0.1`**，启动时校验并拒绝其他组合 |
| `mode` | `token_and_password` | `password` / `token` / `token_and_password` |
| `adminPolicy` | `local_only` | `password_unlock` / `local_only` / `open` |
| `adminProtection` | `true` | 管理操作是否需额外管理员解锁 |
| `allowLoopback` | `true` | 本机回环访问是否豁免（默认豁免——本机用户已有 DSH 直接访问权） |

**管理面的来源判定（2026-09-24 用户决策，取代原先「本机也锁」的做法）**：

用户在实机对比参考实现后指出：*「他好像如果在本机登录的话，就直接是免锁的，只有在远程的时候才是需要锁定的；我们这个在本机也会锁上，用户体验就差了很多。」*

| 来源 | 判定依据 | 行为 |
| --- | --- | --- |
| **本机直连**（`127.0.0.1:3080`，未经过代理） | 回环来源 **且** 无访客标记头 | **物理免锁**：不需要任何密码即可读**写**；免密链接照常下发 |
| 远程（经代理端口访问） | 回环来源 **但带** `x-dsh-lan-guard-visitor: 1` | 按 `adminPolicy` 处理（见下） |
| 其他非回环来源 | 非回环 | 同上按 `adminPolicy` 处理 |

`adminPolicy` 在**远程**上的语义：

| 值 | 远程行为 |
| --- | --- |
| `local_only`（默认） | **只读**：所有写操作 `403 read_only_remote`；不提供解锁入口（「只有本机可以管理，其他设备只读」） |
| `password_unlock` | **需解锁**：先 `adminUnlock` 再写 |
| `open` | 不锁，远程也可写 |

**机制（必须如此，否则无法区分）**：代理在转发**每一个**请求时，先**删除**客户端可能带来的 `x-dsh-lan-guard-visitor` 头，再**固定**写入 `1`（`src/headers.ts` 的 `VISITOR_HEADER`）。代理把 `host` 改写成回环，所以 DSH 侧只能靠这个标记区分「本机操作者」与「经代理进来的访客」；因为代理先删后写，直连请求无法伪造该头。

**设备身份与配对（P4-g v2，2026-09-24 用户实测后定稿）**：

参考 dsh-mobile 的模型——**设备第一次进来时自己命名**，而不是管理员先预建设备：

| 项 | 规格 |
| --- | --- |
| 开关 | `auth.requirePairing`（volatile，默认 **true**）：是否要求新设备先命名 |
| 触发 | 远程访客（密码或链接通过门禁后）**没有设备身份 cookie** → 显示**配对页**（HTML）或对 `/api/*` 返回 `428 pairing_required` |
| 配对页 | 「确认这台设备」：设备名称输入框（按 User-Agent 预填，如「我的 iPhone」）+ **来源地址** + 「确认并进入 DSH」 |
| 配对结果 | 服务端生成设备令牌 → 写入 **HttpOnly 设备 cookie**（`dsh_lan_guard_device`，一年有效）+ 记录名称 / 创建时间 / 来源 IP |
| 之后每个请求 | 校验设备 cookie：**有效 → 放行并更新「最近使用」；记录被吊销/未知 → `403`「此设备已被移除访问权限」**（这就是「删除后它就进不来」） |
| 本机操作者 | 回环直连**永远不参与配对**（它是机器自己的操作者） |
| 改密码 / 切模式 | **立即吊销所有访客会话**——否则已登录的手机不会看到新要求（2026-09-24 用户实测：「我改成了需要密码，但用户却不需要输入」） |
| 已知边界 | 密码是共享的：吊销保证**该设备的身份 cookie 立即失效**；换浏览器用密码重新登录仍可再次配对。要「同一台机器永久拉黑」需要设备指纹/每设备独立令牌等更重方案 |

**原有的一次性链接模式（P4-g v1）**：除总免密令牌 `secretToken` 外，可**按设备**签发独立链接：

| 项 | 规格 |
| --- | --- |
| 令牌格式 | `dsh_dev_` + 36 位 hex（与总令牌 `dsh_` 前缀区分） |
| 存储 | **只存 SHA-256 哈希**，落 `<dataDir>/devices.json`（600）；明文令牌**只在创建时返回一次**，绝不落盘、绝不写日志 |
| 使用 | 与总令牌共用 `?auth=` 参数：命中后下发会话并 302 到干净 URL，同时记录该设备 `lastSeenAt` 与来源 IP |
| 吊销 | 逐个吊销；**吊销只影响那一台设备**，无需更换总密码 |
| 权限 | 列表 / 新增 / 吊销均属**管理面**写操作（本机操作者或已解锁的远程会话；`local_only` 下的远程为只读） |
| 端点 | `GET/POST /plugins/dsh-lan-guard/devices`（`action: add \| revoke`）、`GET /plugins/dsh-lan-guard/qr?text=<url>`（为设备链接渲染二维码，仅管理方可调） |
| 隐私 | 设备列表**只返回** id / 名称 / 创建时间 / 最近使用 / 来源 IP / 是否已吊销，**绝不返回令牌或其哈希** |

**行为要求**：

- 未认证访问 → HTML 请求给登录页，`/api/*` 给 `401 JSON`；
- **WebSocket upgrade 必须过门禁**：先 `verifyRequest` 再转发，未通过直接拒绝升级；
- **异步鉴权之前必须先挂 socket `error` handler**：门禁鉴权是异步的（查会话、记失败次数、可能读盘），而手机重连时会频繁断开 upgrade socket；若异步等待期间 socket 报错却没有 handler，Node 会抛未处理错误。必须在拿到 socket 后**立即**挂 `error` handler，再进入异步鉴权（dsh-mobile v0.4.5 的实战修复，见 `RESEARCH.md` §5.7 ①）；
- 登录成功后下发会话 cookie（`HttpOnly` + `SameSite=Strict`），会话持久化到插件私有 dataDir，DSH 重启后免重输；
- 管理员会话为**内存态**（重启即失效），有效期显著短于普通会话；
- **管理解锁必须豁免访问会话校验**——否则访问会话失效后管理入口永远解不开（dsh-bridge 记录的死锁教训，`RESEARCH.md` §5.5）；
- 密码用 **PBKDF2-SHA256**：迭代 `600000`、派生 32 字节、摘要 sha256；存储格式 `pbkdf2-sha256$<iterations>$<hex>`，并兼容旧的裸 hex（按 10000 次处理）；
- 所有哈希比较一律用 `timingSafeEqual`；
- 失败次数按 IP 计数并锁定（默认 5 次 / 60 秒），登录页需如实展示锁定状态；
- **双密码**：访问密码 + 独立管理密码（管理密码未设置时退回访问密码）；
- **`secretToken`**：免密链接令牌（`dsh_` + 36 位 hex），命中后下发 cookie 并 302 到**去掉 token 的干净 URL**；
- `GET /plugins/dsh-lan-guard/auth-status` 返回脱敏状态，**绝不暴露 `secretToken`、哈希或盐**；
- CSRF：状态改变请求校验 `Origin` / `Sec-Fetch-Site`。判定顺序（2026-09-24 手机实测后收紧为「宁可放行正常手机、只拒绝真正的跨站」）：
  1. `Sec-Fetch-Site: cross-site` → **拒绝**（权威信号，现代浏览器必带）；
  2. `same-origin` / `same-site` / `none` → **放行**；
  3. 无该头时回退到 `Origin`：`Origin` 缺失或为 **`null`**（部分应用内浏览器/隐私模式在同源表单提交时就是这样发的）或**无法解析** → **放行**；能解析则比较 authority（**容忍仅端口不同**），不匹配才拒绝。
- 登录页必须区分三种状态：密码错误、被锁定、**尚未设置任何密码**（避免出现「输入任意密码都能进」的假门禁）。

**存储位置（与 dsh-bridge 的刻意差异，务必遵守）**：

| 类别 | 存放位置 | 理由 |
| --- | --- | --- |
| 非敏感开关：`enabled` / `mode` / `adminPolicy` / `adminProtection` / `allowLoopback` | 插件 config（profile patch） | 可读、可分享、可纳入版本管理 |
| **敏感数据**：`passwordHash` / `passwordSalt` / `adminPasswordHash` / `adminPasswordSalt` / `secretToken` / 会话文件 | **插件私有 dataDir**（文件权限 600） | profile patch 是文本文件，可能被分享或提交；凭据不应出现在其中 |

### F4 自签 TLS（P3，**默认开启**）

> **决策（2026-09-24）**：TLS **默认开启**（`mode: 'self-signed'`），但允许用户关闭。

- **默认**生成自签 CA（长期，5 年）+ 按网卡**当前 IP** 签发的叶证书（短期）；
- CA 与叶证书分离；DHCP 换 IP 时**只重签叶证书、CA 身份跨重启保持不变**——否则手机上已信任的 CA 每次续期都要重装（dsh-mobile v0.4.5 的做法，`RESEARCH.md` §5.1）；
- 生成前校验 CA 与 key 匹配；私钥文件权限收紧（600）；
- **关闭 TLS 时，必须在设置页下方给出影响提示**，明确告知：
  1. 局域网内**明文传输**；
  2. 门禁密码与上游 cookie 可能被同网段嗅探；
  3. 浏览器部分能力不可用（clipboard、Service Worker 等需要 secure context）；
  4. 仅建议在**完全可信的私有网络**中使用。
- 提供"安装 CA 到手机"的指引（README + 设置页内）；
- 非回环监听 + TLS 关闭 = 必须要求配置显式确认（参考 dsh-mobile `src/config.ts:219` 的做法）。

### F5 地址展示与网卡选择（P3/P4）

- 枚举非内部 IPv4 网卡，标注虚拟网卡（WSL / VMware / Docker / Tailscale 等）并降权；
- 展示可访问的 URL；
- 支持在配置里指定网卡 / IP；
- 呈现方式：**通过 F6 的设置页**（不另做独立面板）。

### F8 升级检测（2026-09-24 用户要求，方案 A）

设置页展示「当前版本 → npm 上最新版本」，并给出**可复制的手动升级命令**。**宿主绝不执行安装、绝不重启 dsh。**

| 项 | 规格 |
| --- | --- |
| 数据源 | **只查一个外部端点**：`https://registry.npmjs.org/dsh-lan-guard/latest`（公开、无需鉴权、5s 超时） |
| 缓存 | 成功与失败结果都缓存 **6 小时**；「检查更新」按钮用 `?force=1` 绕过缓存 |
| 端点 | `GET /plugins/dsh-lan-guard/update[?force=1]` → `{ ok, current, latest, hasUpdate, checkedAtMs, error }`（管理面、只读、遵守原生栅栏） |
| 版本比较 | **自己实现**（`x.y.z` + 预发布后缀，遵循 semver 优先级）；**不引入 `semver` 依赖** |
| 失败处理 | 离线 → `error: 'registry_unavailable'`，**只报告、绝不抛错**，不影响门禁与代理 |
| UI | 分区内一枚芯片（绿「vX ✓ 最新」/ 蓝「vX ➔ vY」/ 灰「检查失败」）+「检查更新」+ 静态链接（GitHub / 更新日志 / 反馈 Issue）；有新版时展开面板：版本号、**可复制命令**、「需手动重启 dsh」提示 |
| 不做 | 不自动安装、不自动重启、不接 GitHub API |

### F5b mDNS 发现（P4-d，默认关闭）

- `mdns.enabled`（默认 **false**）：开启后广播 `_dsh-lan-guard._tcp`，TXT 记录带 `scheme` / `host` / `url`；
- **默认关的理由**：广播是新的可发现面，与本项目「默认关闭、显式打开」的立场一致；
- **诚实限制**（已写入 README）：iOS Safari 与 Android Chrome 在实践中**不会**为任意网页解析 `.local` 名字；mDNS 主要方便发现工具与桌面浏览器，**手机上的可靠路径仍是二维码**；
- 广播失败**绝不影响代理**（contained，仅告警）；插件关闭时 `unpublishAll` + `destroy`。

### F6 设置 UI（P2，参考 dsh-notify）

> **规格参考 dsh-notify**（`RESEARCH.md` §5.6）。UI 必须挂在**官方设置页**里，**不替换 layout、不新增独立面板**。

#### 技术路线：**乙（混合）**——已定（2026-09-24）

DSH 0.1.7 有**两条**可用路线（事实与源码证据见 `RESEARCH.md` §4.1）：

| 路线 | 非敏感配置（`enabled` / `mode` / `adminPolicy` / `allowLoopback`） | 敏感交互（密码、token、状态、网卡） | 代码量 |
| --- | --- | --- | --- |
| 甲：纯自定义（dsh-notify 模式） | 自己画表单 + 自己的 `/config` 端点 | 同左 | 中 |
| **乙：混合**（**已选**） | 声明为插件 `Config`（Schemastery），官方 `configForms` **自动生成表单**，零 UI 代码 | 自定义 `settings.section` 组件 + `/config` 端点 | 甲 + 约 90 行宿主声明 |

**两条硬约束（决定了不能只选甲或只选乙）**：

1. **官方表单在非回环页面不可写**：DSH 把非回环页面的 `mode` 固定为 `memory`，表单终态 `unavailable` 且永不写入。**手机通过代理端口访问设置页时正好是这种状态**——所以选乙**必须**额外保留一条自定义端点兜底（dsh-quick-replies 的 `hostDirectScope.ts` 就是干这个的）。
2. **敏感数据无论如何都不能放进 `Config`**：`Config` 的值会落进 `~/.dsh/profiles/web/cordis.patch.yml` 文本文件。密码哈希、`secretToken` 只能走自定义端点（见 F3 存储位置表）。

**实现要点**：非敏感字段声明为插件 `Config` 的 **volatile** 字段（编辑提交进运行引用、不重挂插件）；敏感交互由 `settings.section` 组件经 `/config` 端点读写。

#### 挂载位置

- 注册到官方 `settings.section` seat：
  `slots.inject('settings.section', () => slots.register({ id: 'dsh-lan-guard', order: 100, label: '局域网访问' }, SettingsSection))`
- 如需全帧提示（如「已开启，局域网可访问」），用 `shell.overlay`——官方明确的**追加型** seat，不替换任何东西。

**技术约束**：

- 纯 `React.createElement`，**不引入 JSX、不增加前端构建步骤**；
- 样式用内联 CSS 字符串，颜色与边框一律走官方 CSS 变量 `--dsw-alias-*`，保证明暗主题自动跟随；
- 响应式必须覆盖：`@media (hover:none) and (pointer:coarse)` → 触控目标 ≥44px；`@media(max-width:620px)` → 单列；
- 依赖的官方模块与 dsh-notify 一致：`dsh-client-ui-renderer`、`dsh-client-ui-layout`、`dsh-client-ui-settings`、`dsh-client-ui-settings-general`，写进 `package.json` 的 `dsh.client.inject`。

**读写通路**：

- 客户端 `fetch` 到 `/plugins/dsh-lan-guard/config`，`credentials: 'same-origin'`；
- 宿主端点**必须**先用 `connection.requestRejection(req)` 复用 DSH 原生栅栏（`RESEARCH.md` §5.6），非 GET 再校验同源；
- 只采纳已知键（白名单），补丁逐字段校验；未知键一律丢弃。

**页面结构**（**一个分区内做横向 tab**——2026-09-24 用户决策，取代原「单分区不拆 tab」的设计；实测确认单页堆叠会让用户滑很久且难以定位）：

| tab | 内容 |
| --- | --- |
| 1 **扫码访问** | 状态卡片：标题「局域网访问」+ 副标题「同一 Wi-Fi 下的设备可直接扫码访问」+ 右侧状态胶囊（`运行中` / `已停止`）→ 安全提示条（门禁已生效 / 未设密码时给「去设置访问密码」按钮）→ **唯一的访问地址等宽框** → `复制链接`（解锁时另有 `重新生成`）→ **二维码（F7，任何时刻只有一个）** → 「请在私密环境下使用」+ PWA 引导。**地址框显示的就是二维码的内容**（解锁时＝免密链接、否则＝普通链接），**不得同时展示两个地址**（2026-09-24 用户实测：「发两个地址，让用户很懵逼」） |
| 2 **安全认证** | 验证模式**大卡片三选一**（`扫码免密 + 密码` / `仅密码` / `仅安全 Token`）→ 访问密码设置 → 独立管理密码设置（`adminProtection`）→ `allowLoopback` 开关 |
| 3 **已授权设备** | **「新设备需要命名确认」开关**（`requirePairing`）+ 设备列表（名称、创建时间、最近使用、来源 IP）+ 逐个「吊销」（吊销后该设备被拒）与「删除记录」（删除后该设备可重新配对）。**本页不提供「创建设备」表单**——设备一律由**配对页**（手机侧自己命名）产生，重复的手动创建入口已于 2026-09-24 按用户要求删除 |
| 4 **连接与证书** | **监听端口（可编辑 + 可用性检查 + 顺延提示）**、网卡选择（F5）、TLS 开关与证书状态（F4）；**TLS 关闭时在此卡片下方显示影响提示** |

**帧级状态提示（P4-f，2026-09-24 完成）**：向官方**追加型** seat `shell.overlay` 注册一个紧凑胶囊（`id: dsh-lan-guard-status`），显示「🌐 局域网访问已开启」+ 当前可访问链接 + 「本次会话不再显示」。**只对本机操作者显示**（`localAccess`）——手机已经在控制台里，不需要再被告知自己的地址。它**不替换任何东西**，只是并排追加。

**锁定态**：当 `adminPolicy` 要求且未解锁时，tab 2 / tab 3 的内容替换为**居中锁定卡片**（照 `RESEARCH.md` §5.10 的参考实现形态，自上而下）：

1. 锁图标（🔒，`--dsw-font-xl-24`）；
2. 标题「管理控制台已锁定」（`--dsw-font-xl-24`，居中）；
3. 绿色胶囊「🔑 使用访问密码解锁」（`--dsw-font-xs-13` + `state-success-*`）；
4. 居中说明段落（`--dsw-font-s-14`，`label-secondary`；有独立管理密码与没有时文案不同）；
5. **全宽**密码输入框（左对齐占位符，与按钮同宽，`box-sizing: border-box`）；
6. **全宽主按钮**「解锁管理权限」（始终是**可用的主按钮**，不因输入框为空而变灰；为空时提交给出提示）；
7. 红色文字链接「❓ 忘记访问密码？」→ 展开「🛟 找回与重置访问密码指引」：① 本机直连修改（127.0.0.1 享有免锁特权，可随时修改或清除密码）；② 无头/服务器环境：删除 `dataDir` 下的 `secrets.json` 后重新设置（删除后门禁重新拒绝所有设备，直到设置新密码）。

> 该卡片在**本机直连时根本不会出现**（本机物理免锁，见 F3）；它只服务于远程访客。

**该卡片不得再有卡片标题头**——否则「管理控制台已锁定」会在同一张卡里出现两次（2026-09-24 用户实测指出）。

tab 1（扫码访问）仍可读，但只显示普通链接二维码（免密 token 在解锁前不下发）。

**首次配置不得被锁定态挡住**（2026-09-24 真实环境实测到的死锁）：**未设置任何访问密码**时，锁定态**不生效**——此时门禁本就拒绝一切设备，没有任何东西需要保护，而锁定卡片会把「设置第一个密码」的表单挡在后面。首次设置密码成功后，服务端顺带解锁本次管理会话，避免「刚设完又被要求再输一遍」。

**视觉规范**（提取自 dsh-bridge 实机截图，详见 `RESEARCH.md` §5.10）：

| 元素 | 规范 |
| --- | --- |
| 内容宽度 | 最大约 790px（与 dsh-notify 一致） |
| 卡片 | 白底、1px 浅灰边框、圆角约 14px、内边距约 20px、间距 16–20px |
| 卡片标题 | 走官方 token `--dsw-font-base-strong-16`（500 16px/24px）；副标题 `--dsw-font-xxs-12`（12px/18px） |
| 状态胶囊 | 全圆角；绿底 = 运行中、黑底 = 已启用 |
| 大卡片选择器 | **整张卡片可点**（不是 radio）；选中时 2px 主色边框 + 浅主色背景 |
| 主按钮 | 全宽、**品牌蓝 `--dsw-static-deepseek-500`（#4176e6）+ 官方白字 token `--dsw-static-neutral-bluish-00`**、圆角约 10px、高 ≥44px（2026-09-24 用户选定，取代原先主题相关的近白主按钮）；开关选中态与选中卡片边框同用品牌蓝 |
| 次按钮 | 白底 + 浅灰边框；与主按钮并排时等宽 |
| 提示条 | 绿（成功）、蓝（信息）、红（警示）；图标 + 文字 + 右侧动作链接 |
| 等宽信息框 | URL 用等宽字体、灰底、圆角 |
| 颜色 | **一律走官方 `--dsw-alias-*` 变量**，不硬编码（dsh-mobile 曾因引用不存在的 alias 导致暗色主题完全失效）；真实变量名见 `docs/RESEARCH.md` §4.2.10 |
| **瞬时反馈** | 「已保存」等确认信息用**自动消失的提示条**（约 2.5s），**不得**常驻占一行（2026-09-24 用户实测：「没必要一直停留在这里，很占页面空间」） |
| **解锁横幅** | 仅在**远程会话解锁后**出现，且必须**紧凑**（`--dsw-font-xxs-12` + 小号次按钮 `重新锁定`），文案说明用途（「本次会话内可直接修改下方设置」）；本机免锁时不显示 |
| **选项网格** | 大卡片选择器用 `repeat(auto-fit, minmax(190px, 1fr))`：两项（TLS）**均分整行**，不得挤在三分之一列里留白（2026-09-24 用户实测） |
| **长串** | CA 指纹等长串放进等宽信息框并允许折行（`word-break: break-all`），**不得溢出** |
| **密码说明** | 安全认证卡片必须有一行说明二者区别：**访问密码 = 访客设备登录用；管理密码 = 解锁设置页管理台用（未设置时退回访问密码）** |
| **tab 条** | 照官方**分段控件**（通用设置里的「外观 浅色/深色/跟随系统」）：所有项**同一字体、同一 `label-primary` 颜色**，选中态用 `bg-layer-3` 填充 + 边框改 `label-tertiary`；**不得**把未选项调暗或降字重（那是自创，2026-09-24 用户实测指出会让 2/3 个 tab 看起来「没跟上」） |
| **排版** | **字号 / 字重 / 行高一律走官方 `font` token**（`--dsw-font-base-strong-16` / `s-14` / `s-strong-14` / `xs-13` / `xxs-12`），**不得自定 `font-size`、`font-weight`、`line-height` 或 `letter-spacing`**；等宽信息框用官方 `--ds-font-family-code`。完整清单与实测对齐值见 `docs/RESEARCH.md` §4.2.13。只有确实需要区分的层级（标题 vs 正文 vs 小字）才换 token，不发明新尺寸 |

**借鉴但不要照搬**：

- ✅ 借鉴：卡片分组、状态胶囊、大卡片选择器、锁定态、解锁横幅、「请在私密环境下使用」文案；
- ❌ 不照搬：dsh-bridge 的 **5 类通道** tab 划分、版本升级提示卡片、运维监控看板、配置导入导出、服务重启按钮——这些超出本项目范围。（本项目自己的 3 个 tab 见上表，按**界面职责**划分，不是按通道划分。）

**安全约束**：

- 密码与 token **永不回显**，UI 只显示「已设置 / 未设置」；
- 修改密码需要当前密码或管理员解锁；
- 所有写操作走 POST + 同源校验。

**两套认证面不要混淆**（`RESEARCH.md` §5.6 末表）：

- 设置页属于**管理面**，用 DSH 原生栅栏（`connection.requestRejection`）；
- 代理端口属于**访客面**，用 F3 的密码门禁；
- 即：**能打开设置页 ≠ 能通过代理访问**，反之亦然。

### F7 局域网二维码访问（P3）

> **决策（2026-09-24）**：要做。目的是让手机用户**扫码即达**，免去手输 IP 与端口。
> 视觉参考已确认（dsh-bridge 实机截图，`RESEARCH.md` §5.10）。

**功能要求**：

| 项 | 要求 |
| --- | --- |
| 展示位置 | **设置页**（F6 的 `settings.section`）的**状态卡片**内；不在代理端口上展示 |
| 二维码内容 | 当前可访问的 URL，如 `https://192.168.1.5:3445/` |
| 两种链接 | ① **普通链接**——打开登录页，需输密码；② **免密链接**——带 `secretToken`，扫码即登录（展示前需管理员解锁）。**两者不是两个二维码**：任何时刻只渲染一个，见下方「单一二维码」 |
| 刷新时机 | 网卡选择变化、TLS 开关变化、端口变化、`secretToken` 重新生成时**必须**重新生成二维码 |
| 复制 | 提供「复制链接」按钮（两种链接各自可复制） |
| 提示 | 标注当前使用的网卡与地址；TLS 开启时提示手机需先信任 CA |

**区块布局**（照 `RESEARCH.md` §5.10 的状态卡片形态，自上而下）：

1. 安全提示条——已设密码时绿条「🛡️ 访问安全认证已生效」；未设密码时黄条「⚠️ 尚未设置访问密码，门禁不会放行任何设备」+「去设置访问密码」按钮（切到安全认证 tab）；
2. **访问地址等宽框**——显示当前普通链接全文；
3. `复制链接`（次按钮）；
4. **二维码**——白底小卡片、**居中**、码体约 **190px**、四周留白；**白框必须贴合二维码**（`width: fit-content` + 自动外边距），**不得撑满整行**（撑满会显得笨重，2026-09-24 用户实测反馈）；**默认展开**（用户目标是扫码，不该多一步点击）；
5. **底部提示**——「请在私密环境下使用」（12px 灰色）；
6. **PWA 引导**——「📱 提示：手机浏览器扫码打开后，在菜单点击「添加到主屏幕」即可作为独立全屏 App 运行。」（可照抄该文案）。

**⚠️ 单一二维码（2026-09-24 用户决策，取代原「两个链接各画一个码」）**：任何时刻**只渲染一个二维码，且它必须能用**。此前实现先画普通链接码、解锁后再多画一个免密码，用户实测反馈「两个二维码，搞不懂扫哪个」——且未设密码时那个码扫了只会看到「尚未设置访问密码」。

| 状态 | 二维码 |
| --- | --- |
| **未设置访问密码** | **不画二维码**，只显示「先设置访问密码，然后这里会出现可扫描的二维码」+ 跳转按钮 |
| 已设密码、管理台未解锁 | 画**普通链接**二维码（扫码后输密码），并提示「解锁管理控制台后会改为显示免密二维码」 |
| 已设密码、已解锁 | 画**免密链接**二维码（扫码即登录），普通链接降级为 `复制链接` 按钮；另给 `复制免密链接` 与 `重新生成` |

**实现要求**：

- 依赖 **`qrcode`**（参考见 `RESEARCH.md` §5.8）；
- 生成方式：**服务端出 SVG 字符串**——无 base64 膨胀、可随主题继承颜色（dsh-mobile 的做法）；
- 二维码由**宿主侧**生成（需要网卡与 token 的真实值），经 `/config` 或专用端点交给客户端渲染；
- **`secretToken` 不得进入客户端可任意读取的普通配置响应**——免密链接必须要求管理员解锁后才返回；
- 含 `secretToken` 的二维码内容**不得写进日志**（`GUARDRAILS.md` §4）。

**⚠️ 免密 token 的参数名（硬约束）**：

- 免密链接形如 `https://<IP>:<port>/?auth=<secretToken>`，**必须用 `?auth=`**（与 dsh-bridge 一致）；
- **绝对不能用 `?token=`**——那是 DSH 自身的 launch token 参数，代理需要把它**原样转发**给上游去换 cookie。两者同名会互相覆盖，导致 DSH 侧鉴权失败或代理侧免密失效；
- 代理识别 `?auth=` 后：校验 token → 下发自己的会话 cookie → **302 到去掉 `auth` 的干净 URL**（与 DSH 自身的 token 交换流程同构，见 `RESEARCH.md` §3.3）。

**安全约束**：

- 免密链接等同于密码，展示需管理员解锁（F3 的 `adminPolicy`）；
- 二维码本身不含密码明文，但含 token 时按凭据处理；
- 不提供「二维码自动登录」以外的旁路；
- 手机端（代理页面）**不提供**「分享给其他设备」入口——避免把含 token 的链接二次扩散；需要分享时由本机设置页复制。

---

## 4. 模块划分与工程栈

**语言：TypeScript**（2026-09-24 决策——用户统一约定，今后所有项目都用 TS）。

```
src/
├── index.ts            插件入口：inject、配置解析、生命周期、路由注册
├── config.ts           非敏感配置的 Config（Schemastery，含 volatile 字段）+ 校验
├── proxy.ts            HTTP 反向代理
├── websocket.ts        upgrade 事件与 WS 双向转发
├── headers.ts          Host/Origin 改写、hop-by-hop 头处理、cookie 注入
├── upstream-auth.ts    上游 loopback cookie 的获取与缓存（路线 A）
├── auth/
│   ├── manager.ts      双密码、PBKDF2 哈希、会话、secretToken、IP 锁定、统一 verifyRequest
│   └── login-page.ts   登录页渲染（错误 / 锁定 / 未设密码三态）
├── store/
│   ├── secrets.ts      敏感数据持久化（密码哈希与盐、secretToken、会话）→ 插件私有 dataDir，权限 600
│   └── preferences.ts  非敏感配置持久化 + 已知键白名单校验
├── settings/
│   └── routes.ts       /plugins/dsh-lan-guard/* 管理端点（用 connection.requestRejection 保护）
├── qrcode.ts           二维码生成（服务端出 SVG）+ 访问链接组装
├── tls/
│   ├── ca.ts           自签 CA 生成、加载、匹配校验
│   └── leaf.ts         按网卡 IP 签发叶证书
├── network.ts          网卡枚举与选择
└── client.ts           设置页 UI（React.createElement + 内联 CSS，注册 settings.section）
tests/
└── *.test.ts           单元与集成测试
```

**工程栈**（沿用 dsh-quick-replies 的 TS 栈，参考 `RESEARCH.md` §5.9）：

| 项 | 选择 |
| --- | --- |
| 语言 | TypeScript，`strict`、`noUncheckedIndexedAccess` |
| 模块 | ESM（`"type": "module"`） |
| 构建 | `tsdown`，产物目录 `lib/` |
| 类型检查 | `tsc --noEmit`（源码与测试各一套 tsconfig） |
| 测试 | `vitest` |
| 包管理器 | **pnpm**（与 dsh-quick-replies 一致） |

**说明**：

- 划分是建议性的。实施中若需调整，**在 `CHANGELOG.md` 记录调整原因并汇报**，不要静默改变结构；
- 构建产物目录与包管理器如要改动，先问用户（涉及 CI 与发布流程）。

### 依赖清单（新增依赖需用户批准，`AGENTS.md` §3.5）

**运行时依赖**——只允许以下两个：

| 依赖 | 用途 | 参考 |
| --- | --- | --- |
| `qrcode` | 二维码生成（服务端出 SVG） | dsh-mobile 与 dsh-bridge 都在用（`RESEARCH.md` §5.8） |
| `selfsigned` | 自签 CA 与叶证书 | dsh-mobile 唯一与证书相关的依赖（`RESEARCH.md` §5.1） |

**peer 依赖**（范围必须覆盖 `0.1.7-rc.1`，否则会被兼容性预检直接禁用，`RESEARCH.md` §8）：

| 包 | 用途 |
| --- | --- |
| `@deepseek-ai/cordis` | 插件框架 |
| `@deepseek-ai/dsh-host-webserver` | `ctx.webServer`（注册路由） |
| `@deepseek-ai/dsh-client-connection` | `ctx.connection`（`authenticatedUrl`、`requestRejection`） |
| `bonjour-service` | **可选**的 mDNS/DNS-SD 广播（P4-d，MIT）；仅在 `mdns.enabled: true` 时使用。2026-09-24 由用户批准引入 |
| `@deepseek-ai/schemastery` | 插件 `Config` 的 schema（F6 路线乙的 `.volatile()` 字段）。DSH 运行时自带，安装体积为零；2026-09-24 P1 由用户批准补入本表 |

**明确不引入**：

- ❌ 任何前端框架或 UI 库（React 由 DSH 提供，`client.ts` 只用 `React.createElement`）；
- ❌ 任何 HTTP 代理库（用 `node:http` 原生，保持透明）；
- ❌ 任何隧道 SDK（隧道本身是非目标）；
- ❌ 任何密码学库（用 `node:crypto`）。

---

## 5. 配置项

**只放非敏感开关**。敏感数据一律不进 config（理由见 F3 存储位置表）。

```yaml
# cordis.patch.yml 中本插件的 config
config:
  enabled: true                   # 插件总开关
  listenHost: '127.0.0.1'         # 默认只回环。对外时显式改为 '0.0.0.0' 或指定网卡 IP
  listenPort: 3081                # 默认 = DSH 端口 + 1；被占用时自动依次往后找（见下）
  upstreamOrigin: 'http://127.0.0.1:3080'
  networkInterface: null          # 多网卡时指定，如 en0
  dataDir: null                   # 敏感数据目录；未设置时拒绝启动（不猜测 profile 路径）
  auth:
    enabled: true                 # 门禁总开关（见 F3）
    mode: 'token_and_password'    # 'password' | 'token' | 'token_and_password'
    adminPolicy: 'local_only'     # 'password_unlock' | 'local_only' | 'open'
    adminProtection: true
    allowLoopback: true
    sessionMaxAgeMs: 2592000000   # 30 天
    adminSessionMaxAgeMs: 1800000 # 30 分钟
    maxFailedAttempts: 5
    lockoutMs: 60000
  tls:
    mode: 'self-signed'           # 'self-signed'(默认) | 'provided' | 'off'
    allowInsecureLan: false       # 非回环 + mode:'off' 的显式风险确认（P4-e）

  mdns:
    enabled: false                # 是否广播 _dsh-lan-guard._tcp（P4-d，默认关）
    caCertFile: null
    caKeyFile: null
    certFile: null
    keyFile: null
```

**敏感数据不放这里**，存 `<dataDir>/secrets.json`（文件权限 600）：

- `passwordHash` / `passwordSalt`
- `adminPasswordHash` / `adminPasswordSalt`
- `secretToken`
- 会话文件（普通会话持久化，管理员会话仅内存）

**端口选择（2026-09-24 用户决策）**：

- 默认 **3081**（DSH 的 3080 + 1，符合「3081/3082/3083 依次往后数」的直觉）；仍避开 3443 / 3444（dsh-mobile 占用）；
- **被占用时自动顺延**：从配置端口开始最多再试 **10** 个连续端口，用第一个可用的；真正的绑定动作本身就是探测（不额外开探测 socket，无竞态、无多余监听）。若发生顺延，设置页与日志都会说明「配置的端口 X 已被占用，已自动改用 Y」；
- 端口**可在设置页修改**（`listenPort` 为 volatile 字段，`连接与证书` tab 内有数字输入 + 保存 + 可用性检查），**修改后需重启 dsh 生效**；
- 可用性检查走 `GET /plugins/dsh-lan-guard/port-check?port=N`（管理面端点，受原生栅栏保护），探测**只绑 `127.0.0.1`**——绝不为探测打开对外监听（遵守「门禁先于监听」）。

**默认值原则**：

1. 默认**不**开启对外监听（`listenHost: '127.0.0.1'`），需显式配置才对外；
2. `dataDir` 未设置时**拒绝启动**并给出明确提示——插件从不猜测 profile 路径（dsh-notify 的做法）；
3. `auth.enabled: false` 时，**只允许**监听 `127.0.0.1`，启动时校验并拒绝其他组合；
4. **TLS 默认 `self-signed`**（2026-09-24 决策）；用户关闭时设置页必须给出影响提示（见 F4）。

---

## 6. 安全要求（不可妥协）

1. **门禁先于监听**：不允许出现"端口已对外可达、门禁未生效"的中间状态；
2. **非回环 + 无 TLS**：必须显式确认，不能默认允许。实现为 `tls.allowInsecureLan`（默认 **false**）：未开启时，非回环 `listenHost` + `tls.mode: 'off'` 在**配置校验阶段直接拒绝启动**并给出可操作提示；开启后允许，启动时打印明文警告，设置页显示影响提示（P4-e，2026-09-24 用户批准）；
3. **凭据处理**：密码不落盘明文；secret / token / 私钥只在内存持有，日志脱敏（见 `GUARDRAILS.md` §4）；
4. **WS 也过门禁**：`upgrade` 事件必须先 `verifyRequest`；
5. **CSRF**：状态改变请求校验 `Origin` / `Sec-Fetch-Site`（局域网内的恶意网页也可能打到这个端口）；
6. **不信任上游响应头**：WS 101 只放行必要头；不把上游 `Set-Cookie` 等敏感头透传给浏览器（除非确认必要）；
7. **登录接口限流**：按 IP 计数 + 锁定；
8. **默认关闭**：插件默认不对外暴露。

---

## 7. 测试要求

### 必须覆盖

| 类型 | 内容 |
| --- | --- |
| 单元 | Host/Origin 改写、hop-by-hop 头剔除、cookie 名与值生成、密码哈希与校验、IP 锁定计数、配置校验（非法值被拒） |
| 集成 | HTTP 转发往返、WS upgrade 转发、未认证时 `/api/*` → 401、未认证 HTML → 登录页、认证后放行 |
| 边界 | 大响应体不被缓冲、`multipart/form-data` 正确透传、上游不可达时的错误响应 |

### 约束

- 测试**不得依赖真实 DSH 进程**（用假上游服务器）；需要真实 DSH 的验证放到手工验收；
- 测试**不得使用真实密码 / secret**（用固定假值）；
- 测试**不得监听 `0.0.0.0`**（用 `127.0.0.1` + 端口 0）；
- 不得为了通过测试而放宽断言（`AGENTS.md` §7）。

### 验收命令（每阶段跑，具体见 `docs/PLAN.md`）

```sh
pnpm test          # 类型检查 + 单元/集成测试
pnpm run typecheck # 仅类型检查
pnpm run build     # tsdown 构建
```

---

## 8. 已确认的决策（2026-09-24 全部拍板）

| # | 事项 | 决定 |
| --- | --- | --- |
| 1 | 上游认证路线 | ✅ **A**——用 `ctx.connection.authenticatedUrl()` 完成 token→cookie 交换，**不自签** cookie |
| 2 | 门禁配置模型 | ✅ **参考 dsh-bridge**（`RESEARCH.md` §5.5）；`scope` 字段省略 |
| 3 | TLS 默认 | ✅ **默认开**（`mode: 'self-signed'`），**可以关**；关闭时**必须在设置页下方提示影响** |
| 4 | 设置 UI | ✅ **要做**，挂载与交互方式参考 dsh-notify（`RESEARCH.md` §5.6） |
| 4b | UI 技术路线 | ✅ **乙（混合）**——非敏感配置走官方 `configForms` 自动表单，敏感交互与手机场景走自定义端点 |
| 5 | 网卡选择 | ✅ 配置文件 + 自动探测，结果在 F6 设置页呈现 |
| 6 | 发布策略 | ✅ **保守（L0）**——不擅自发布，见 `docs/RELEASE.md` |
| 7 | 语言 | ✅ **TypeScript**（用户统一约定：今后所有项目都用 TS） |
| 8 | 局域网二维码 | ✅ **要做**——扫码访问（见 F7）；**视觉细节待用户提供参考图** |

**P1 的启动前置已全部满足。** 新会话可直接按 `docs/PLAN.md` 开工。

> 历史记录：本表此前有 7 项待决（其中第 1、3、7 项曾给出不同建议），已于 2026-09-24 由用户全部拍板，以本表为准。
