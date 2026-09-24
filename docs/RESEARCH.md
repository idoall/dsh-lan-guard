# RESEARCH — 已核实的技术事实基线

> **用途**：本文件记录本项目所依赖的、**已经过源码核实**的事实。实施时先查这里，**不要重新调研，也不要凭记忆改写**。
> **时效性**：事实对应 `@deepseek-ai/dsh@0.1.7-rc.1`。DSH 升级后必须重跑 §7 的复核清单，并更新本文件。
> **核实日期**：2026-09-24。完整调研报告：`/Users/lionm5/my_project/_dsh/dsh-lan-access-research.md`（421 行）。

---

## 1. 环境基线

| 项 | 值 |
| --- | --- |
| DSH 版本 | `@deepseek-ai/dsh@0.1.7-rc.1` |
| DSH 安装路径 | `/Users/lionm5/.nvm/versions/node/v24.14.1/lib/node_modules/@deepseek-ai/dsh/` |
| DSH 子包路径 | 上述路径下 `node_modules/@deepseek-ai/`（每个包一个目录） |
| 上游源码副本 | `/Users/lionm5/my_project/_dsh/deepseek-harness`（含 tag `dsh-v0.1.7-rc.1`、`dsh-v0.1.5-rc.3`） |
| 参考项目 A | `/Users/lionm5/my_project/_dsh/dsh-mobile`（分支 `local/0.1.5-lan`，v0.3.14，**Apache-2.0**） |
| 参考项目 B | `/tmp/dsh-bridge-inspect`（v2.10.13，**MIT**）——临时克隆，若不存在则 `gh repo clone wenbin-wb/dsh-bridge` |
| 本机 web profile | `dsh --profile web`，DSH 监听 `127.0.0.1:3080` |

> 下文出现的 `dsh-xxx/lib/...` 路径，均相对 DSH 子包路径 `.../node_modules/@deepseek-ai/`。

---

## 2. 监听与官方限制

### 2.1 官方显式拒绝把 Web GUI 绑到 `0.0.0.0`

`dsh-web-app/lib/startup.js:40`：

```js
if (options.host === "0.0.0.0") program.error("error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead");
```

**这条事实决定了本项目的存在理由**：不能靠改 DSH 绑定来获得局域网访问。

### 2.2 但 webserver 层接受 `0.0.0.0`

`dsh-host-webserver/lib/index.js:142`：

```js
host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
port: z.natural().max(65535).required(),
```

`dsh-host-webserver` 的 README 明确：**该服务器自身不携带 TLS、认证或来源策略**。安全全靠上层。

### 2.3 框架已为 LAN 预留信任路径

`dsh-web-app/lib/index.js:83-88` 的 `resolveLanTrust(bindHost, extra)`：当 `bindHost === '0.0.0.0'` 时，**自动把所有非内部 IPv4 地址加入 `trustedHosts`**（用 port-less 的 IP 字面量，注释说明「DNS rebinding 需要攻击者可控的域名，而 IP 字面量的 Host 在任何端口都安全」）。

→ 说明 LAN 场景在框架层是被考虑过的，只是 CLI 层没开。

---

## 3. `/api` 鉴权栅栏（必须理解，否则反代必然 401）

### 3.1 栅栏入口

`dsh-client-connection/lib/index.js:586`：

```js
requestRejection(request) {
  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
  return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
}
```

两道检查，顺序固定：

1. **Host/Origin fence**：Host 必须是 loopback 或 `trustedHosts` 之一，且附带的浏览器标记必须同源 → 否则 `403`；
2. **浏览器 cookie 鉴权** → 否则 `401`。

### 3.2 cookie 格式（逐字段核实）

| 项 | 值 | 位置 |
| --- | --- | --- |
| 凭据记录键 | `client-connection/browser-session` | `:223` |
| cookie 名前缀 | `dsh-auth-` | `:227` |
| 载荷版本 | `1` | `:228` |
| cookie 名 | `dsh-auth-` + `base64url(sha256(authority))` | `:284` |
| cookie 值 | `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, body))>` | `:302` `encodeCookie` |
| 载荷 | `{ version: 1, authority, issuedAt, expiresAt }` | 同上 |
| 密钥 | 32 字节 base64url，存于上述凭据记录的 `payload.secret` | `:272` `storedSecret` |
| 校验 | `:433` `isAuthenticated`——必须 `payload.authority === 请求的 authority`，且未过期 | `:433` |

### 3.3 token 与 cookie 的生命周期

- **launch token 是进程级的**：`PROCESS_LAUNCH_TOKENS`（WeakMap），每次 DSH 启动新生成；
- **cookie 签名 secret 是持久的**：存在凭据记录里，cookie 默认有效期 30 天；
- 换取方式：`GET /?token=<launchToken>` → 校验通过后 `Set-Cookie` 并 303 重定向到干净的 `./`。

### 3.4 由此推出的实现约束

> 浏览器持有的是**代理 origin** 的 cookie，而 DSH 期望的 cookie 绑定 `127.0.0.1:<dshPort>` 这个 authority。
> 二者不是同一个 → **反代必须自行注入一枚合法的 loopback 会话 cookie**，否则一律 401。

两条可选路线（`docs/SPEC.md` 会定稿选哪条）：

| 路线 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A（推荐） | 用公开 seam `ctx.connection.authenticatedUrl(origin)` 拿到带 launch token 的 URL，自己完成 token→cookie 交换并缓存 | 不依赖私有格式 | 需要自己实现交换逻辑 |
| B | 直接读 `~/.dsh/.credentials.yaml` 的 secret，按 §3.2 格式自签 | 无需交换、无状态 | **依赖 DSH 私有实现**，格式一变就静默 401 |

---

## 4. 可用的公开 seam

| seam | 能力 | 证据 |
| --- | --- | --- |
| `ctx.webServer` | `host` / `port` getter；`register` / `registerUpgrade` / fallback 路由注册 | `dsh-host-webserver/lib/types/index.d.ts:97` `registerUpgrade` |
| `ctx.connection.authenticatedUrl(baseUrl)` | 返回带本进程 launch token 的完整 URL | `dsh-client-connection/lib/index.js:600`（`BrowserAuth` 侧实现在 `:374`） |
| 自行 `createServer().listen()` | 插件可自行在任意 `0.0.0.0:<port>` 监听，不必改 DSH 绑定 | dsh-mobile `src/gateway.ts:892` 即如此 |

dsh-mobile 的用法示例（可借鉴其思路，不复制代码）：`src/plugin.ts:92` 的 `upstreamAuthenticatedUrl(ctx, upstreamOrigin)`，`inject = ['webServer', 'commands', 'connection']`（`src/plugin.ts:63`）。

### 4.1 官方设置机制：Config-derived forms（0.1.7 新增，两条路线的前提）

DSH 0.1.7 **移除了** `ctx.settings.register(namespace, schema, options)` 与 client 侧 `settingsScope`。取而代之的是 **Config-derived forms**：

| 事实 | 内容 |
| --- | --- |
| 表单来源 | `ctx.settings.describe()` 投影每个活跃 Loader 条目**自身 `Config` 的 volatile 字段** |
| 命名空间 | **就是 Loader 条目 id**（如 `dsh-lan-guard`），不再有独立注册名 |
| 注册调用 | **没有了**——插件的 `Config` **就是**它的设置 schema |
| volatile 字段 | 标 `.volatile()` 的字段提交进运行引用并发 `loader/volatile-update`，**不重挂插件** |
| 客户端通道 | `ctx.configForms.get(entryId)`（`@deepseek-ai/dsh-client-ui-settings` 提供的 `configForms` 服务，`lib/client.js:1264`、`:1284`） |
| 表单快照 | `status` / `value` / `base` / `user` / `revision` / `writable` / `mode` |
| 写入落点 | `~/.dsh/profiles/web/cordis.patch.yml` 的 `<entry-id>.config` |
| 写被拒语义 | `mutate` 返回 `false` → 调用方**必须表现为冲突/失败**，不能假装写入成功 |
| bundle 纯度 | client bundle 禁止跨插件 **value import**，所以 `configForms` 只能**结构化读取**（照 `ConfigFormSnapshotLike` 的形状，不 import 类型值） |

**最需要注意的一条**：

> **`mode` 在非回环页面被 DSH 固定为 `memory`**——表单终态为 `unavailable` 且**永不写入**。

也就是说：**手机通过代理端口访问设置页时，官方表单是只读的。** 这正是 `dsh-quick-replies` 在官方通道之外**额外保留**一条「局域网 `remote.settings` 直连兜底」（`src/client/settings/hostDirectScope.ts`，333 行）的原因。

**本机已验证的参考实现**：`/Users/lionm5/my_project/_dsh/dsh-quick-replies`

| 文件 | 职责 |
| --- | --- |
| `src/host/settings.ts`（89 行） | 宿主半：`Config` 即设置 schema；`schemaVersion` / `items` 标 `.volatile()`；命名空间取 bundle patch 的 entry id `dsh-quick-replies` |
| `src/client/settings/configFormScope.ts`（117 行） | 把官方 `ctx.configForms.get(entryId)` 投影成插件自己的 `SettingsScopeLike`；把 `mutate=false` 翻译成拒绝 |
| `src/client/settings/hostDirectScope.ts`（333 行） | **局域网兜底**：官方表单在非回环下不可写时，改走 Host Remote 直连 |
| `src/client/settings/settingsChannel.ts`（194 行） | 在两套通道之间选择 |

**与 dsh-notify 的差异**（两者都是本机在跑的有效做法，但机制不同）：

| 插件 | 设置机制 | 适用 |
| --- | --- | --- |
| `dsh-quick-replies` | **官方 configForms**（`Config` + volatile 字段 + `ctx.configForms.get(entryId)`），另有局域网直连兜底 | 配置项是**结构化数据**、希望 DSH 自动渲染表单 |
| `dsh-notify` | **自定义**：宿主 `registerSensitive(..., '/config', ...)` 端点 + client 自己画 `settings.section` 组件，`fetch` 读写 | 需要**自定义交互**（自测按钮、上传音频）或**不能放进 config 的数据** |

---

### 4.2 P1 实施期间新核实的事实（2026-09-24）

> 全部在 `@deepseek-ai/dsh@0.1.7-rc.1` 上核实，核实方式为「读源码 + 在仓库内临时 DSH 实例上实测」。

#### 4.2.1 隔离测试实例：`DSH_HOME` 覆盖 + `--patch` 叠加层

| 事实 | 证据 |
| --- | --- |
| `$DSH_HOME` 可覆盖默认 `~/.dsh`（`resolveDshHome()` 每次调用时解析，注释明说「test or launcher 可在 import 后设置」） | `dsh-home-paths/lib/index.js`（`DSH_HOME_ENV = "DSH_HOME"`、`defaultDshHome()`） |
| `dsh --patch <path>` 可重复，作为 profile 层之后的额外 patch 叠加 | `dsh/lib/bin.js:104`（`--patch`，`collect`） |
| 未初始化的 profile 由 shipped 模板就地创建（`web` = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`） | `dsh-app-boot/lib/index.js:521` `PROFILE_TEMPLATES`、`profile-boot-CO0MPY31.js:139` `initializeProfileFromDefault` |
| `dsh --profile web` 的 app 参数：`--host` / `--port`（`0` 交给系统）/ `--trusted-host` / `--no-open`；`--host 0.0.0.0` 在**这一层**被拒绝 | `dsh-web-app/lib/startup.js:22`（命令定义）、`:40`（拒绝 0.0.0.0） |
| webserver 条目的 Loader id 是 **`webserver`**，端口来自 `ctx.webStartup.port ?? 3080` | `dsh --profile web --dump-config` 输出 |

**对本项目的价值**：可以在**仓库内**（`DSH_HOME=<repo>/.tmp/dsh-home`）跑一个独立 DSH 实例做真实端到端验收——不碰 `~/.dsh`、不重启用户的 dsh。P1 验收就是这么做的。

#### 4.2.2 `ctx.webServer` 注册签名（P1 用到，P2 继续用）

`dsh-host-webserver/lib/types/index.d.ts`：

| 方法 | 签名要点 |
| --- | --- |
| `register(route)` | `{ kind: 'exact' \| 'prefix', path, handler }`；`path` **不带尾斜杠**；`prefix` 匹配 `p` 与 `p/<anything>`；重复 `(kind, path)` 抛错 |
| `registerUpgrade(route)` | `{ path, handler(req, socket: Duplex, head: Buffer) }`，**只支持 exact 路径**；重复路径抛错 |
| `registerFallback(handler)` | 唯一所有者 |
| `port` / `host` getter | `port` 在 `port: 0` 时返回 OS 实配端口 |

#### 4.2.3 token→cookie 交换的精确语义（路线 A 的实现依据）

`dsh-client-connection/lib/index.js` 的 `BrowserAuth.authorizeIndex`（`:395` 起）：

| 条件 | 行为 |
| --- | --- |
| `GET /` + **恰好一个** `?token=` 且等于本进程 launch token | `303` + `location: ./` + `set-cookie`（`cache-control: no-store`、`referrer-policy: no-referrer`） |
| `GET /` + `?token=` 但 cookie 已有效 | `303` → `./`（不带新 cookie） |
| `GET /` + `?token=` 其他情况 | 与未认证相同的最小 `401` 文本 |
| 无 `?token=` | 有有效 cookie → 交给调用方渲染 index；否则 `401` |

cookie 属性（`sessionCookie()`，`:317`）：`Max-Age`、`Path=/`、`Expires`、`HttpOnly`、`SameSite=Strict`；名字 = `dsh-auth-` + `base64url(sha256(authority))`，其中 authority 取自请求的 **Host** 头。

#### 4.2.4 `/api` 栅栏的两个细节（反代头改写的依据）

`isTrustedApiRequest`（`:205` 起）：

1. `sec-fetch-site: cross-site` → **直接拒绝**（不看 Origin）；
2. 有 `origin` 头时，`new URL(origin).host` 必须**等于** Host 的 host —— 所以反代把 Host 与 Origin **成对**改写成同一个 `127.0.0.1:<dshPort>` 是必须的，只改一个就会被判 `403`。

#### 4.2.5 loopback 上「哪些路径受保护」——P2 门禁范围的关键事实

实测（P1 临时实例，`127.0.0.1:3470`）：

| 路径 | 不带 cookie 直连上游 |
| --- | --- |
| `/`（index） | `401` |
| `/api/remote.mux`（upgrade） | `401` |
| `/plugins/??...&rev=...`（插件 bundle） | **`200`** |
| `/assets/index-*.js`（静态资源） | **`200`** |

**结论**：DSH 自身的栅栏只保护 index 与 `/api/*`；静态资源在 loopback 上是裸的。这不是 DSH 的问题（它只监听 loopback），但意味着**本项目的门禁必须覆盖代理端口上的全部路径**，不能只保护 `/api/*`（`docs/SPEC.md` F3 的「未认证 HTML → 登录页」必须对静态资源同样生效）。

#### 4.2.6 兼容性预检的作用范围

`evaluatePluginCompatibility`（`dsh-app-boot/lib/index.js:286`）**只检查 `peerDependencies` 里名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的条目**，用 `semver.satisfies(runtime, range, { includePrerelease: true })`；不匹配即返回 issue，调用方禁用该行。

→ 因此 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 的 peer 范围**不参与**该预检，但 `dsh-client-connection` / `dsh-host-webserver` 必须覆盖 `0.1.7-rc.1`。本项目实测 `evaluatePluginCompatibility(manifest)` 返回 `undefined`（无 issue）。

#### 4.2.7 Schemastery 的「null 默认值 = 无默认值」陷阱

`schemastery@3.18.4` 的 `Schema.resolve`：当字段缺省时取 `schema.meta.default`，若该 fallback 为 `null`/`undefined` 则**直接返回原值**（`lib/index.cjs:288` `if (isNullable(fallback)) return [data]`）。

→ `.default(null)` 的字段被省略时结果是 `undefined` 而不是 `null`。本项目把 SPEC §5 里文档化为 `null` 的字段（`networkInterface` / `dataDir` / `tls.*File`）在 schema 里声明为 `.default('')`，再在 `parseConfig()` 里归一化成 `null`；patch 里显式写 `null` 同样会被归一化。

#### 4.2.8 `ctx.settings` 的写入契约（P2 路线乙的实现依据）

`dsh-settings/lib/index.js` 的宿主服务（`SettingsForms`）：

| 事实 | 证据 |
| --- | --- |
| 写入 API 为 `update(ns, patch, expectedRevision)` / `replace` / `mutate(ns, ops, expectedRevision)`，`ns` 就是 Loader 条目 id | `:470`（`update`）、`:488`（`mutate`） |
| **只有 volatile 字段可写**：`write()` 对非 volatile 路径抛 `Config field "x" is not volatile`；条目没有任何 volatile 字段则抛 `Plugin entry "x" has no volatile fields` | `:507` 起（`write`） |
| 写入落点由 `configEditor.edit(entry, …)` 完成（即 profile patch），与页面是否回环无关 | 同上 |
| **被 home patch 或命令行 `--patch` 叠加层覆盖的条目拒绝写入**：`Configuration for "x" is overridden by a home patch or command-line overlay` | 同上（P2 真机实测复现） |
| `ctx.settings` 是**服务**，未在插件 `inject` 声明时属性访问会抛错；`ctx.get('settings')` 是可选取用方式（返回 undefined 表示缺失） | `context.d.ts`（`get`）、P2 实测 |
| `describe()` 的行含 `ns` 与 `revision`；`revision` 用于乐观并发校验（不匹配抛 `SettingsConflictError`） | `:413`（`describe`）、`:519` |

**对本项目的结论**：非敏感开关必须声明为 volatile 才能被设置页写入；且**验收/自测时不能把插件条目放在 `--patch` 命令行叠加层里**，否则开关写入必然失败（这不是缺陷，是 DSH 的保护）。P2 的真机验收因此改为写进临时 profile 自身的 `cordis.patch.yml`。

#### 4.2.9 volatile 字段在 `apply` 处的形态

Loader 会**先用**条目的 `Config` 校验，再把结果交给 `apply`。因此 `apply` 收到的是**已解析**配置：`.volatile()` 字段是 `cosmokit` 的稳定引用 `{ get(): T, [write](v) }`（`cosmokit/lib/index.js:102` `createVolatile`），**不是裸值**。

两条实现约束：

1. 插件若对收到的配置做二次校验，必须先把引用解包（否则报 `expected boolean but got [object Object]`）；
2. 想在运行期读取编辑后的值时，要保留引用并每次经 `.get()` 读——这正是「编辑进运行引用、不重挂插件」的实现方式。

#### 4.2.10 ⚠️ 官方 CSS 变量名（P2 设置页的真实依据）

`docs/SPEC.md` F6/§5.10 要求「颜色一律走官方 `--dsw-alias-*` 变量」，但**没有列出真实变量名**。P3 收尾时用浏览器实测发现：按「看起来合理」的名字（`--dsw-alias-bg-elevated` / `--dsw-alias-text-primary` / `--dsw-alias-bg-secondary` / `--dsw-alias-border-subtle` / `--dsw-alias-bg-success` …）写 CSS，**这些变量在 DSH 0.1.7 里全部不存在**，`getComputedStyle` 取到空字符串，样式会静默退回到硬编码回退值——暗色主题下表现为「白卡 + 近白文字」，与 dsh-mobile 踩过的坑完全同类。

**核实方式**：在运行中的页面上遍历 `document.styleSheets` 收集全部自定义属性名，再读取 `getComputedStyle(设置对话框)` 的实际取值。以下为 `@deepseek-ai/dsh@0.1.7-rc.1` 的真实变量（括号内为暗色 / 浅色实测值）：

| 用途 | 真实变量名 | 暗色 | 浅色 |
| --- | --- | --- | --- |
| 页面底色 | `--dsw-alias-bg-base` | `#151517` | `#ffffff` |
| 卡片 / 层 1 | `--dsw-alias-bg-layer-1` | `#232324` | `#ffffff` |
| 对话框 / 层 2 | `--dsw-alias-bg-layer-2` | `#2c2c2e` | `#ffffff` |
| 抬升面 / 层 3 | `--dsw-alias-bg-layer-3` | `#353638` | — |
| 主文字 | `--dsw-alias-label-primary` | `#f9fafb` | `#0f1115` |
| 次文字 | `--dsw-alias-label-secondary` | `#cfd3d6` | — |
| 三级 / 说明文字 | `--dsw-alias-label-tertiary` | `#adb2b8` | — |
| 主色按钮上的文字 | `--dsw-alias-label-primary-foreground` | `#0f1115` | — |
| 边框（弱 → 强） | `--dsw-alias-border-l1` / `-l2` / `-l3` | `#ffffff0f` / `#ffffff1f` / `#ffffff29` | `rgba(0,0,0,.1)`（l2） |
| 主色 / 主按钮填充 | `--dsw-alias-brand-primary` / `--dsw-alias-button-primary-fill` | `#f9fafb` | — |
| 交互悬停底色 | `--dsw-alias-interactive-bg-hover` | `#ffffff14` | — |
| 成功（前景 / 弱底） | `--dsw-alias-state-success-primary` / `--dsw-alias-state-success-tertiary` | `#22c55e` / `#233c2c` | `#22c55e` / `#e6faed` |
| 警告（标签 / 弱底） | `--dsw-alias-state-warn-label` / `--dsw-alias-state-warn-tertiary` | `#dd8629` / `#27241f` | — |
| 错误（前景） | `--dsw-alias-state-error-primary`（**无** `-tertiary`） | `#f25a5a` | — |
| 信息（前景 / 弱底） | `--dsw-alias-state-business-primary` / `--dsw-alias-state-business-tertiary` | `#7aaaff` / `#34415b` | — |

**结论**：设置页 CSS 必须只用上表的名字，并**始终保留硬编码回退值**（登录页在代理 origin 上没有任何 DSH 样式表可用）。错误的名字不会报错，只会静默退化——这正是必须用浏览器实测而不能只做源码检查的原因。

#### 4.2.13 官方排版 token（设置页字体的唯一来源）

`docs/SPEC.md` F6 原写「卡片标题 15–16px 加粗；副标题 12–13px 灰色」等**自定字号**——这是错的：DSH 0.1.7 已经把所有页面的排版规范成一套 `font` 简写 token，插件不应自己发明字号/字重/行高（用户 2026-09-24 反馈「输入框的字间距、按钮颜色和文字大小都很合理……你不觉得我们的字间距很难看吗？」）。

**核实方式**：在运行中的设置对话框上枚举样式表里的自定义属性并读取 `getComputedStyle` 实际值。官方 token（每个都是完整 `font` 简写，**尺寸与行高成对**）：

| token | 值 | 用途（本项目映射） |
| --- | --- | --- |
| `--dsw-font-base-16` | `16px/24px` 常规 | — |
| `--dsw-font-base-strong-16` | `500 16px/24px` | 卡片标题、锁定卡片标题 |
| `--dsw-font-s-14` | `14px/22px` | tab、输入框、开关行 |
| `--dsw-font-s-strong-14` | `500 14px/22px` | 主/次按钮、选中 tab、大卡片标题 |
| `--dsw-font-xs-13` | `13px/20px` | 提示条、字段标签、等宽信息框、锁定卡片说明 |
| `--dsw-font-xxs-12` | `12px/18px` | 副标题、底部小字、胶囊 |
| `--dsw-font-xxxs-11` | `11px/14px` | 极小字（本项目暂未用） |
| `--dsw-font-xl-24` | `600 24px/32px` | **官方最大字号 token**；本项目用于锁定卡片的标题与锁图标 |

另有两个**等宽字体**变量（本项目 URL 框用第一个）：

- `--ds-font-family-code` = `"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"`
- `--dsw-font-markdown-code-font-family` = 同上

**官方分段控件（tab）的规则**（实测「外观 浅色/深色/跟随系统」三个按钮）：**所有项文字同为 14px/400/`label-primary`**；未选 = 透明底 + `0.5px` `border-l2` 边框 + 圆角 20px；选中 = 底色 `bg-layer-3` + 边框 `label-tertiary`。**选中不靠变暗、不靠加粗**——把未选项调暗/降字重会让它们看起来「没跟上主题」（本项目踩过）。

**按钮配色（2026-09-24 用户拍板：用品牌蓝）**：`--dsw-alias-button-primary-fill` 在暗色下是 `#f9fafb`（近白）+ `label-primary-foreground` 深色字（DSH 官方暗色主按钮）；`--dsw-static-deepseek-500 = #4176e6` 是官方**品牌蓝**，其上的文字用官方白字 token **`--dsw-static-neutral-bluish-00 = #fff`**（两种主题都是白）。本项目主按钮/开关选中态/选中卡片边框统一用品牌蓝，**未硬编码任何颜色**。

**要点**：每个 token 还有 `-font-family` / `-font-size` / `-font-weight` / `-line-height` / `-font-style` 拆分子变量。字距官方一律 `normal`（不要自设 `letter-spacing`）；行高不要自设 1.6 之类的比例值——那会与官方「尺寸↔行高」的配对脱节，中文看起来就松散难看。实测对齐结果（真实 DSH）：`.lg-title` 16/500/24、`.lg-sub` 12/400/18、`.lg-btn` 14/500/22、`.lg-mono` 13/400/20 + SF Mono，字距均为 `normal`。

#### 4.2.14 手机浏览器会发 `Origin: null`（CSRF 判定的真实世界约束）

2026-09-24 手机实测反馈：「远程访问，输入密码也不对」——登录表单提交被回以「请求来源校验未通过」。用 curl 从**非回环来源**模拟手机复现后确认：带正常头（`Origin: https://<ip>:<port>` + `Sec-Fetch-Site: same-origin`）**能通过**、无 `Origin` 也能通过，只有显式 `cross-site` 才被拒；因此问题出在手机侧发来的**非常规 Origin**。

已知真实世界行为：**部分应用内浏览器（微信/QQ 等 WebView）与隐私模式在同源表单提交时会发送 `Origin: null`**，也有客户端发不可解析的值。原实现把「无法解析 Origin」当作失败（`catch { return false }`），于是把正常手机挡在登录页外。

**结论（已写入 SPEC F3）**：`Sec-Fetch-Site` 是权威信号（只拒绝显式 `cross-site`）；`Origin` 缺失、为 `null`、或无法解析都视为「无可用信号」而放行；能解析时比较 authority 并容忍仅端口不同。真正的跨站页面必然带 `Sec-Fetch-Site: cross-site`，所以放宽这一条不削弱防护。

#### 4.2.11 真实 profile 的插件安装形式与 live patch reload

在用户的真实 `web` profile 上实测得到的两条关键事实（P1–P3 交付时踩到）：

| 事实 | 证据 |
| --- | --- |
| profile 的 `cordis.patch.yml` 里，**扁平的 `- id: X` + `name: Y` 行只是「按 id 覆盖已存在条目的 config」**；对一个尚未存在的 id，它**被静默忽略**，插件不会激活（无报错、无监听、设置页也不出现分区） | 真实 profile 实测：扁平形式写入后重启 dsh（20:09:39），`0.0.0.0:3445` 未监听 |
| 新增条目必须用 **`insert:` 列表**形式（profile patch 模板注释原文即「id-targeted config overrides, disables, and **insert lists**」） | 同上：改为 `- insert: [- id: dsh-lan-guard …]` 后立即激活 |
| profile 的 `package.json` 里 `dsh.profile.bundles` 是**加载哪些 bundle** 的清单，`dependencies` 是包解析清单；第三方插件的条目由**各自 bundle 的 `cordis.patch.yml`** 里的 `insert:` 产生，profile patch 只做覆盖 | `~/.dsh/profiles/web/package.json`（9 个 dependencies + 13 个 bundles）与本仓库 `cordis.patch.yml`（`- insert:`）对照 |
| `dsh.profile.patchReload: "live"` 时，**改 profile patch 会热加载新条目，无需重启 dsh** | 真实环境实测：改 patch 后数秒内 `*:3445` 开始监听，原进程 PID 不变，3080 会话不受影响 |
| 客户端半（`dsh.client`）的模块表在**页面加载时**注入，因此插件热加载后需要**刷新页面**才会出现设置分区 | 与既有记忆一致（「需刷新 3080 后才加载客户端模块」）；实测刷新后分区出现 |

**对本项目的结论**：本地开发插件装入真实 profile 的正确做法 = `node_modules` 软链 + profile patch 的 **`insert:`** 行（本次即如此修正）。若 profile 开了 live reload，则连重启都不需要。

> ⚠️ **live reload 只覆盖「配置」，不覆盖「模块代码」**（2026-09-24 实测确认）：`patchReload: live` 会在 patch 变化时重载条目/配置，但插件的 JS 是启动时 `import` 进 Node 模块缓存的——**改了 `lib/*.js` 必须重启 dsh 才生效**；只有**客户端半**（`dsh.client` 的 bundle，由 web 层按内容哈希实时提供）刷新页面即可更新。因此「新客户端 + 旧服务端」这种混合状态是可能的，插件两端都要对缺失的新字段做优雅降级。

#### 4.2.12 真实环境实测结论（P1–P3 交付验收）

在仓库内临时 DSH 实例（DSH `127.0.0.1:3470`，代理 `127.0.0.1:3471`）上实测：

| 检查 | 结果 |
| --- | --- |
| 经代理 `GET /` | `200`，32959 字节 HTML（含 `<base href="./">`） |
| 经代理裸 origin（无尾斜杠） | `200`，同一份 HTML |
| 直连上游 `GET /`（无 cookie） | `401` ← 证明代理的 cookie 注入才是放行原因 |
| 经代理取文档相对形式的插件 bundle | `200`，5.5 MB JS |
| 经代理取 `assets/index-*.js` | `200` |
| 经代理 `/api/remote.mux` upgrade | `101 Switching Protocols`，握手后 1.5s socket 仍打开 |
| 直连上游同一 upgrade（无 cookie） | `401 Unauthorized` |

**P2 追加实测**（同一临时实例，`allowLoopback: false`）：

| 检查 | 结果 |
| --- | --- |
| 未认证 HTML 导航 | `401` + 登录页 |
| 未认证 `/api/*` | `401` JSON |
| 未设置密码时 | `403` + 登录页明示「尚未设置访问密码」，且任何密码都进不去 |
| 正确密码 | `302` + `Set-Cookie`，随后首页 `200`（33295 字节） |
| 经原生栅栏 GET `/plugins/dsh-lan-guard/config` | 有 DSH cookie `200`；无 cookie `401` |
| 首次设置密码（引导） | `200`（修正死锁后） |
| 写 `mode` 开关 | `200`，落进临时 profile 的 `cordis.patch.yml`；**同一进程内立即生效**（`?auth=` 由 302 变 401，再切回 302） |
| 首页是否加载客户端半 | 是：`plugins/??dsh-lan-guard/client.js&rev=…`，经代理取回 `200`（18 KB，`window.__ModuleLoader__.load` 工厂） |
| `/auth-status` | 无 `pbkdf2` / `dsh_` / `secretToken` / `Salt` 字样 |
| 重启插件后 | 访客会话仍有效（`200`）；管理员会话已失效且不再返回 `secretToken` |
| `secrets.json` / `sessions.json` | 权限 `600` |

---

## 5. 参考实现可借鉴点

### 5.1 证书：dsh-mobile 的做法（Apache-2.0，只借鉴参数）

> **行号对应 dsh-mobile v0.4.5**（2026-09-24 核对）。该仓库更新频繁，引用行号前请先重新核对。

`src/managed-setup.ts:275` 用 `selfsigned` 生成自签 CA。**只借鉴参数，不复制其代码**：

| 参数 | 值 |
| --- | --- |
| 主体 | `commonName = "DeepSeek Harness Mobile CA"` |
| 密钥 | `keyType: 'ec'`、`curve: 'P-256'` |
| 摘要 | `algorithm: 'sha256'` |
| 有效期 | `notBefore` = 生成前 5 分钟；`notAfter` = 生成时 + 5 年 |
| 扩展 | `basicConstraints: { cA: true, critical: true }` |
| 扩展 | `keyUsage: { digitalSignature: true, keyCertSign: true, cRLSign: true, critical: true }` |
| 输出 | `cert`（PEM）与 `private`（PEM），分别落到 `ca.pem` / `ca-key.pem` |

四个已经踩过的坑：

1. **CA 与服务器叶证书分开**：`ca.pem` / `ca-key.pem` 长期不变（5 年），叶证书按网卡**当前 IP** 重新签发（`src/managed-setup.ts:369` `refreshManagedServerCertificate`），这样 DHCP 换 IP 不会让证书失效；
2. **私钥文件权限收紧**：`src/private-file.ts` 的 `restrictPrivateFile()`；
3. **CA 与 key 必须校验匹配**：`src/managed-setup.ts:217` 的 `assertMatchingCa()`——检查 `certificate.ca`、`subject === issuer`、`certificate.verify(certificate.publicKey)`，再比对 `createPublicKey(createPrivateKey(keyPem))` 与 `certificate.publicKey` 的 SPKI DER；
4. **手机需一次性安装 CA**：`src/cli.ts:110` 会提示。

另有一条值得采纳的设计约束：`src/config.ts:219`——**非回环监听强制要求 TLS**（`'TLS may be disabled only on an IP loopback listener'`），且非回环监听必须提供 `publicAuthorities`（`:256`）。

**v0.4.5 追加的做法（值得照抄）**：*"retain the CA identity across restarts, and renew the ingress leaf without replacing its CA"*——**续期只换叶证书、CA 身份跨重启保持不变**。否则手机上已信任的 CA 每次续期都要重装一遍。

### 5.2 门禁：dsh-bridge 的设计（MIT，只借鉴设计）

`lib/auth/manager.js`（596 行，纯 Node，零三方依赖）：

| 能力 | 实现要点 | 位置 |
| --- | --- | --- |
| 密码哈希 | PBKDF2-SHA256，带算法前缀 `pbkdf2-sha256$<iterations>$<hex>`，兼容旧的裸 hex 以便平滑升级 | `:17-22`、`:121`、`:139` |
| 恒定时间比较 | `timingSafeEqual` | `:141`、`:447` |
| 会话持久化 | `PersistentSessionMap`（Map + 落盘），重启不掉线 | `:35` |
| 分级会话 | 管理员会话（默认 30 分钟）与普通访问会话分开 | `:299`、`:453` |
| 令牌校验 | `validateSession` / `validateSecretToken` | `:466`、`:442` |
| IP 失败锁定 | `isIpBlocked` / `recordFailedAttempt` / `recordSuccess` | `:486`、`:500`、`:512` |
| 统一入口 | `verifyRequest(req)`，HTTP 与 WS upgrade 共用 | `:523` |

衔接方式（`lib/index.js`）：先 `verifyRequest` 判定；`fromToken` 时下发自己的 cookie 并 302 到干净 URL；未通过则 HTML 请求给登录页、`/api/*` 给 401 JSON；通过后再转发。

### 5.3 反代：dsh-bridge 的 `ProxyServer`（约 340 行）

| 要点 | 位置 |
| --- | --- |
| `loopbackHeaders(headers, targetPort)`：把 `host` / `origin` 改写为 `127.0.0.1:<dshPort>`，再注入 loopback cookie | `lib/index.js:214` |
| `class ProxyServer`：`http.request` 反代 + `upgrade` 事件手工代理 WebSocket | `lib/index.js:313` |
| WS 101 响应只放行 5 个白名单头（`connection`、`upgrade`、`sec-websocket-accept`、`sec-websocket-extensions`、`sec-websocket-protocol`），避免上游任意头透传 | `lib/index.js:572` 附近 |
| 剔除 hop-by-hop 响应头（`connection` / `transfer-encoding` / `upgrade` 等） | `lib/index.js:239` |
| **HTML 注入仅 3 个浏览器 polyfill，无任何布局改动** | `lib/index.js:193-197` |

### 5.4 dsh-mobile 的**不采纳**部分

`src/mobile-layout.ts`（v0.4.5 为 638 行）替换了整个官方 layout：`:569` 的 `apply()` 注册自己的 `MobileAppFrame`（`:369`），`:586` 接管官方根 hook `panelInfo`。函数注释原文即 *"Replace the desktop layout module on the authenticated mobile surface"*。这是**手机专属界面**方案，与「复用官方 UI」的定位冲突，**本项目不采纳**。详见 §6.2。

### 5.5 门禁配置模型：dsh-bridge 的完整字段（本项目规格参考）

`lib/auth/manager.js` 构造函数（`:83` 起）暴露的配置面：

| 字段 | 默认值 | 语义 |
| --- | --- | --- |
| `enabled` | — | 门禁总开关 |
| `mode` | `token_and_password` | 认证方式 |
| `scope` | `all` | 防护范围：`all` / `public_only` / `lan_only` |
| `adminPolicy` | `password_unlock` | 管理解锁策略：`password_unlock` / `local_only` / `open` |
| `adminProtection` | `true` | 管理保护独立开关（关闭后管理操作免 adminToken） |
| `passwordHash` / `passwordSalt` | `''` | 访问密码 |
| `adminPasswordHash` / `adminPasswordSalt` | `''` | **独立**的管理密码 |
| `secretToken` | 自动生成 | 免密链接令牌，格式 `dsh_` + `randomBytes(18).toString('hex')` |
| `allowLoopback` | `true` | 本机回环访问是否豁免 |

参数与持久化（`:12`、`:19-21`、`:25-32`）：

| 项 | 值 |
| --- | --- |
| PBKDF2 迭代 | `600000`（注释：约数百毫秒，故必须异步，同步会卡住事件循环） |
| 兼容旧哈希 | `LEGACY_PBKDF2_ITERATIONS = 10000` |
| 派生长度 | `PBKDF2_KEYLEN = 32`，摘要 `sha256` |
| 哈希存储格式 | `pbkdf2-sha256$<iterations>$<hex>`，裸 hex 视为旧的 10000 次 |
| 会话有效期 | `DEFAULT_SESSION_MAX_AGE_MS = 30 天` |
| 会话持久化 | `~/.dsh/dsh-bridge/sessions.json`，权限 600；宿主重启后免重输 |
| 管理员会话 | **内存态**（`adminSessions` Map），重启即失效 |
| 过期清理 | 每小时一次 `setInterval`，`.unref()` |

端点与流程（`lib/index.js`）：

| 端点 / 行为 | 位置 |
| --- | --- |
| `GET /__dsh_bridge__/auth-status`——严格脱敏，**不暴露 secretToken** | `:381` |
| `/dsh-bridge/authAdminUnlock`——管理密码解锁，**豁免访问会话校验**（否则访问会话失效后锁屏永远解不开，死锁） | `:436` |
| `fromToken` 命中 → 下发自己的 cookie + 302 到干净 URL（去掉 `?auth=` / `?token=`） | `:443` |
| 未认证：HTML 请求给登录页、`/api/*` 给 401 JSON | `:461` 起 |

登录页：`lib/auth/login-template.js`（417 行），入口 `renderLoginPage({ error, hasPassword, locked, noPasswordConfigured, mode })`，完整 HTML + 内联 CSS + `<form>` + `<input type="password" autofocus>`，支持错误、锁定、未设密码三种状态。

**本项目采纳 / 不采纳**：

- **采纳**：`enabled`、`mode`、`adminPolicy`、`adminProtection`、双密码（访问密码 + 独立管理密码）、`secretToken`、`allowLoopback`、PBKDF2 600k + 算法前缀、会话持久化与管理员会话内存态、`auth-status` 脱敏、管理解锁豁免死锁的处理；
- **不采纳 `scope`**：本项目只有局域网一种通道（无公网隧道），`all` / `public_only` / `lan_only` 三态没有意义。字段省略，未来若加通道再引入；
- **改进**：dsh-bridge 把 `passwordHash` 存在插件 config 里；本项目改为**敏感字段存插件私有 dataDir**，非敏感开关存 config（理由见 §5.6）。

### 5.6 设置 UI：dsh-notify 的模式（本项目 UI 规格参考）

**客户端侧**（`src/client.js`，1085 行）：

| 项 | 做法 | 位置 |
| --- | --- | --- |
| 注入 | `inject = ['slots']` | `:8` |
| 组合声明 | `CLIENT_COMPOSITION = { service: 'slots', modules: [...], seats: ['settings.section', 'shell.overlay'] }` | `:1066` |
| 依赖的官方模块 | `dsh-client-ui-renderer`、`dsh-client-ui-layout`、`dsh-client-ui-settings`、`dsh-client-ui-settings-general` | 同上 + `package.json` 的 `dsh.client.inject` |
| 设置页注册 | `slots.inject('settings.section', () => activate('settings.section', { id: 'dsh-notify', order: 100, label: '通知', inject: ... }, SettingsSection))` | `:1080` |
| 浮层注册 | `slots.inject('shell.overlay', ...)` → toast 组件 | `:1082` |
| 组件写法 | 纯 `React.createElement`，**不引入 JSX / 不增加构建复杂度** | `:1053` 起 |
| 样式 | 内联 CSS 字符串常量（`SETTINGS_CSS`），使用官方 CSS 变量 `--dsw-alias-*` | `:101` |
| 响应式 | `@media (hover:none) and (pointer:coarse)` → 44px 触控目标；`@media(max-width:620px)` → 单列 | `:147` |
| 读写设置 | `fetchJson('/config')` 读、`POST /config` 写，`credentials: 'same-origin'` | `:1042`、`:1048`、`:347` |

**宿主侧**（`src/index.js`）：

| 项 | 做法 | 位置 |
| --- | --- | --- |
| 端点前缀 | `const BASE = '/plugins/dsh-notify'` | `:21` |
| 保护管理端点 | `registerSensitive(ctx, webServer, connection, '/config', ['GET','POST'], handler)` | `:536` |
| **复用的公开 seam** | 内部先调 `connection.requestRejection(req)` 拿到 `401`/`403`，非 GET 再校验同源 | `:153-165` |
| 持久化 | `createSettings({ dataDir, keys: SETTING_KEYS })`；只采纳已知键（`pickSettings`），补丁逐字段校验（`validSettingsPatch`） | `:167-172`、`:44-50` |

> **`connection.requestRejection()` 是本项目的重要 seam**：插件可以用它复用 DSH 原生的 Host/Origin fence + cookie 鉴权来保护**自己的管理端点**，不必自己实现一套。

**由此确定本项目的两套认证面**（务必区分，不要混淆）：

| 认证面 | 保护对象 | 机制 |
| --- | --- | --- |
| **管理面** | 设置页 UI、`/plugins/dsh-lan-guard/*` 管理端点 | `connection.requestRejection()`——DSH 原生栅栏，只有本机 DSH 用户可用 |
| **访客面** | 代理端口上的所有流量 | 本项目自己的密码门禁（§5.5 模型） |

### 5.7 dsh-mobile v0.4.5 的实战教训（直接适用于本项目）

> 来源：其 CHANGELOG 的 0.4.4–0.4.5 条目 + `src/gateway.ts`（行号对应 v0.4.5）。这几条正是本项目 P1/P2 会踩的坑。

**① WebSocket upgrade 必须先挂 socket error handler，再做异步鉴权**

CHANGELOG 原文：*"Guard WebSocket upgrade sockets before asynchronous authentication so disconnects during reconnect cannot emit an unhandled socket error"*。

实现：`src/gateway.ts:890` 的 `guardUpgradeSocket(socket)` 在拿到 socket 后**立即**挂 `socket.on('error', ...)`；`:1147` 在进入异步鉴权**之前**就调用它。

**为什么适用**：本项目的门禁鉴权是异步的（查会话、记失败次数、可能读盘）。手机端重连时会频繁断开 upgrade socket——若异步等待期间 socket 报错而没有 handler，Node 会抛未处理错误。**P2 必须照做。**

**② 失败的静态资源 404 不能按 immutable 缓存**

CHANGELOG 原文：*"Keep failed revisioned plugin scripts and hashed assets on `no-store` instead of caching their 404 responses as immutable for a year"*。

背景：`/plugins/*?rev=<hash>` 与 `/assets/*-<hash>.js` 会被设为 `private, max-age=31536000, immutable`（`src/gateway.ts:743` 的 `revisionedStaticCacheControl`）。但若失败的 404 也被这样缓存，用户会在**一年内**都拿不到修好的资源。

**为什么适用**：本项目若在 P1 做任何缓存头处理，必须只对 **200** 加 immutable，失败响应一律 `no-store`。

**③ 端口占用约定（决定本项目的默认端口）**

| 端口 | 归属 |
| --- | --- |
| `3080` | DSH 自身 |
| `3081` | **本项目默认**（= DSH + 1；被占用时自动顺延最多 10 个） |
| `3443` | **dsh-mobile 的局域网网关**（其 `listenPort` 默认值，`src/config.ts:243`） |
| `3444` | dsh-mobile 的「自带反代 origin」默认端口 |

**结论：本项目默认端口必须避开这三个**——SPEC §5 的默认已因此从 3443 改为 **3445**。

**④ dsh-mobile v0.4.2 起自带了一个反代 provider（与本项目功能部分重叠）**

CHANGELOG：*"Add an Own reverse proxy provider under Remote → Self-hosted for an existing user-managed HTTPS proxy. It provides a separate authenticated private HTTP origin (default 3444), strict private bind/source-CIDR validation..."*

**差异**：它服务的是**公网隧道 / 自建反代**场景（Remote → Self-hosted），需要用户自备 HTTPS 代理；本项目服务**局域网直连**，自带密码门禁与自签证书，且官方 UI 零改动。两者定位不同，但**端口要错开**。

### 5.8 二维码：两个项目的现成做法

两个参考项目都用 **`qrcode`**（npm 包），只是输出形式不同：

| 项目 | 导入 | 调用 | 输出 |
| --- | --- | --- | --- |
| dsh-mobile | `import * as QRCode from 'qrcode'`（`src/gateway.ts:25`） | `QRCode.toString(appPairUrl, { type: 'svg', margin: 1 })`（`:2855`） | **SVG 字符串**（服务端生成，直接嵌进 HTML） |
| dsh-bridge | `import QRCode from 'qrcode'`（`lib/index.js:16`、`lib/bridge-rpc.js:4`） | `QRCode.toDataURL(text, {...})`（`lib/index.js:120`、`lib/bridge-rpc.js:43`） | **data URL**（base64 PNG，交给浏览器显示） |

**本项目的选择**：**服务端出 SVG**（dsh-mobile 的做法）——无 base64 膨胀，且 SVG 可以用 `currentColor`/CSS 变量跟随主题。规格见 `SPEC.md` F7。

### 5.9 TypeScript 工程栈：dsh-quick-replies 的现成配置

> 2026-09-24 用户决定「今后所有项目统一使用 TypeScript」，本项目的工程栈因此改以 dsh-quick-replies（本机最成熟的 TS 项目）为模板。

`/Users/lionm5/my_project/_dsh/dsh-quick-replies` 的配置：

| 文件 | 内容 |
| --- | --- |
| `tsconfig.json` | `target: ES2022`、`module: ESNext`、`moduleResolution: Bundler`、`lib: [ES2022, DOM, DOM.Iterable]`、`jsx: react-jsx`、`strict: true`、`noEmit: true`、`skipLibCheck: true`、`isolatedModules: true`、`allowImportingTsExtensions: true`、`verbatimModuleSyntax: true`、`noUncheckedIndexedAccess: true`、`types: []` |
| `tsconfig.tests.json` | 测试专用（与源码分开检查） |
| `tsdown.config.ts` | 构建配置（产物 `lib/`） |
| `vitest.config.ts` | 测试配置 |
| `package.json` scripts | `build: tsdown`；`typecheck: tsc --noEmit && tsc --noEmit -p tsconfig.tests.json`；`test: pnpm run typecheck && vitest run`；`verify: pnpm run test && pnpm run build && pnpm pack --dry-run` |
| 包管理器 | **pnpm**（有 `pnpm-lock.yaml`、`pnpm-workspace.yaml`） |

**注意**：另一个已发布插件 dsh-notify 用的是 npm + `node --test`（JS 项目）。本项目按 TS 栈走 pnpm + tsdown + vitest，与 dsh-quick-replies 对齐；若要改回 npm，属于工程配置变更，需先问用户（`AGENTS.md` §4）。

### 5.10 设置页的视觉参考（dsh-bridge 实机截图，2026-09-24 用户提供）

用户提供了 5 张 dsh-bridge 设置页的实机截图作为 UI 参考。以下提取的是**视觉语言**；本项目功能范围更小（无公网隧道 / IM 机器人 / 运维监控），因此**不照搬它的横向 tab**，只借鉴组件形态——见 `SPEC.md` F6。

**布局骨架**：

| 元素 | 规范 |
| --- | --- |
| 分区导航 | 左侧竖排（官方设置页提供）；每个插件注册自己的分区——dsh-bridge 是「远程访问」、dsh-notify 是「通知」 |
| 内容区 | 单列；卡片间距约 16–20px；内容最大宽度约 790px（与 dsh-notify 的 `max-width:790px` 一致） |
| 卡片 | 白底、1px 浅灰边框、圆角约 14px、内边距约 20px |
| 卡片标题 | 15–16px 加粗；副标题 12–13px 灰色 |
| 状态胶囊 | 全圆角：绿底 = 运行中、黑底 = 已启用、蓝底 = 版本号 |
| **大卡片选择器** | **整张卡片可点**（不是 radio）；选中时 2px 主色边框 + 浅主色背景 |
| 主按钮 | 全宽、主色（蓝紫）、白字、圆角约 10px、高约 44px |
| 次按钮 | 白底 + 浅灰边框；与主按钮并排时等宽 |
| 提示条 | 绿（成功 / 已生效）、蓝（信息）、红（警示）；图标 + 文字 + 右侧动作链接 |
| 等宽信息框 | URL 用等宽字体、灰底、圆角 |
| 二维码 | 白底卡片**贴合码体**、居中、码体约 **190px**、四周留白（原记录「约 340px」是把参考截图按 DPR 1 误读所致，2026-09-24 按用户提供的实机截图按 DPR 2 重测修正） |
| 底部小字 | 12px 灰色 |

**可直接借鉴的四个组件形态**：

1. **状态卡片**（截图 3）：标题 + 副标题 + 右侧状态胶囊 → 绿色安全提示条（带「设置 →」）→ URL 等宽框 → 并排按钮（复制链接 / 隐藏二维码）→ 二维码 → 底部提示。
2. **大卡片选择器**（截图 4）：用于「验证模式」与「防护生效通道」三选一；每张卡带图标 + 标题 + 说明；选中态明显。
3. **锁定态**（截图 1）：居中卡片 = 锁图标 + 「管理控制台已锁定」+ 绿色胶囊 + 居中说明 + 密码框 + 全宽主按钮 + 红色文字链接（忘记密码）。
4. **解锁横幅**（截图 2 顶部）：浅蓝背景条 = 锁图标 + 「管理员权限已解锁（当前临时会话有效）」+ 右侧「重新锁定后台」按钮。

**两条值得照抄的文案**：

- **「请在私密环境下使用」**——放在二维码下方，提醒二维码本身含凭据；
- **「📱 提示：手机浏览器扫码打开后，在菜单点击「添加到主屏幕」即可作为独立全屏 App 运行。」**——引导手机用户做成 PWA。

**⚠️ 一处必须避开的参数名冲突**：dsh-bridge 的免密链接形如 `http://10.0.0.30:3082/?auth=dsh_2135a0…`，用的是 **`?auth=`**。本项目的代理**不能复用 DSH 自身的 `?token=`**——那是 DSH 的 launch token 参数，代理需要把它**原样转发**给上游去换 cookie。因此本项目的免密 token **必须用独立参数名**（建议 `?auth=`，与 dsh-bridge 一致）。已写入 `SPEC.md` F7。

---

## 6. 官方 Web UI：复用而非替换

### 6.1 官方 UI 自带响应式与触屏适配

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 窄屏自动折叠 | `deepseek-harness/packages/client/ui-layout/src/client/columns.ts:23` `SIDEBAR_AUTO_COLLAPSE = 1024` | 视口 < 1024px 时侧栏折叠成 56px 图标 rail（`:19` `SIDEBAR_COLLAPSED = 56`） |
| 窄屏手动展开 | `.../stores.ts:110` `narrowExpanded` | 窄屏下可重新展开并覆盖被挤压的中间列 |
| 中间列保底 | `.../columns.ts:11` `CENTER_MIN = 400` | 右侧栏先收缩、再失去轨道，之后中间列才允许跌破最小值 |
| 窄屏判定 | `.../AppFrame.tsx:178` `const narrow = viewport < SIDEBAR_AUTO_COLLAPSE` | 列宽由 JS 计算，不是纯 CSS 媒体查询 |
| 触屏目标 | 多处 `@media (pointer: coarse)` | 如 `ui-deliverables/.../ChangedFiles.module.css:31` 行高抬到 44px |
| 局部窄屏 / 悬停 | `ui-chat/.../TurnUsagePanel.module.css:59`、`ui-chat/.../MessageIconActions.module.css:42` | 手机上换排布；触屏不依赖悬停 |

**实证**：dsh-bridge 的局域网通道零布局改动（§5.3 最后一行），用户即在手机浏览器里使用官方界面。

### 6.2 官方 slot 的替换型 / 追加型语义

`deepseek-harness/packages/client/ui-layout/src/client/index.ts:61-105`：

| slot | 类型 | 语义 |
| --- | --- | --- |
| `sidebar` | 替换型（OCCUPIED） | 注册会**整体替换**导航列 |
| `rightbar` | 替换型（OCCUPIED） | 整体替换右列 |
| `main` | keyed | 保留 key `conversation` 给会话面板 |
| **`shell.overlay`** | **追加型（明确无主）** | 官方注释：*"This is the additive seat for a frame-wide surface of your own: a fresh `id` is added beside the shipped entries instead of replacing them."* |
| `shell.leading` | 替换型（OCCUPIED） | 只在侧栏完全隐藏时挂载 |

→ **如果将来要做增量 UI 改进，入口是 `shell.overlay`，不是替换 layout。** 本项目当前不做任何 UI 改动。

---

## 7. DSH 0.1.7 的协议变更（对本项目透明，但要知道）

| 变更 | 内容 | 对本项目的影响 |
| --- | --- | --- |
| Remote 双向流 | 同一条 `/api/remote.mux` WebSocket 上新增 Client→Host 的 `item` / `end` 帧；方法签名 `RemoteStream<Out, In>`；Host 用 `ctx.invocation.uplink()`。提交 `021bd03b70`（PR #4648） | **无影响**。代理按字节转发 |
| 二进制结果传输 | Typert 递归识别 `Uint8Array`，改走 `multipart/form-data`（JSON 元数据 + 字节附件）；仅限一元结果。提交 `ecf6acfb15` | **无影响**。是 HTTP 响应体编码变化 |
| `readBytes` 统一 | 旧 `readBytes` + `readAll` + `readRelated`（base64）合并为一个 `readBytes(path, { range?, baseFile? })`，返回 `Uint8Array` | **无影响**。本项目不使用 `workspaceFiles` |

**WebSocket 路径未变**：`dsh-api-gateway/lib/index.js:12` `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"`，`dsh-v0.1.5-rc.3` 与 `dsh-v0.1.7-rc.1` 一致。

### 7.1 ⚠️ 文档相对路由（document-relative app routes）——**与反代直接相关**

引入提交：`eeb9b03465`、`29182514ed`（在 `dsh-v0.1.5-rc.3` 之后，属 0.1.6/0.1.7）。
架构 Note：`.agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.zh.md`。

| 项 | 内容 |
| --- | --- |
| 外壳 index | 携带唯一的 `<base href="./">`，拼接在起始 head 标签之后、先于插件资源行 |
| 浏览器侧引用 | **文档相对**：`api/x`、`plugins/x`（不再是 `/api/x`、`/plugins/x`） |
| 服务端路由键 | **仍是绝对路径**：`/api`、`/plugins/??...&rev=...` |
| 常量命名 | `*_PATH`（绝对，服务端）与 `*_ROUTE`（相对，浏览器）并列 |
| `authenticatedUrl` | 保留 authority 与挂载；token 交换重定向到 `./`（去掉 query token、保留目录） |
| Host/Origin 栅栏与 cookie 规则 | **不变** |

**对本项目的四条影响**：

1. **根路径反代不受影响**：文档相对路径在根目录下与绝对路径等价。本项目是 `http://<LAN IP>:<port>/` → `127.0.0.1:3080/` 的根路径转发，相对路径解析正确。
2. **必须做尾部斜杠规范化**：Note 明确 *"裸挂载仍需依赖代理自身的规范化补齐尾部斜杠"*。若用户访问 `http://<IP>:<port>`（无尾斜杠），代理应规范化到 `/`，否则 `<base href="./">` 的解析目录会与预期不符。→ 已写进 SPEC F1 与 PLAN P1 验收。
3. **不要试图剥离前缀或推断挂载点**：Note 明确否决了「从转发前缀请求头推断挂载点」与「配置 base URL」两条路。本项目**只支持根路径挂载**，不做子路径挂载（SPEC F1 的非目标）。
4. **保持透明，不要改写资源 URL**：dsh-mobile v0.4.5 曾因为用绝对 `/plugins/` 前缀组装 mobile boot batch，遇到 0.1.7 的相对 `plugins/` 形式而返回 `502 upstream_unavailable`（其 `src/gateway.ts:126` 的 `upstreamPluginBundleUrl` 现在同时接受两种前缀）。本项目是**透明反代**，不组装 bundle，天然规避——**不要为了"优化"去改写资源 URL**。

---

## 8. 插件清单规范（`package.json` 的 `dsh` 字段）

参考本机已装插件 `@idoall/dsh-notify` 的写法：

```json
"dsh": {
  "manifestVersion": 1,
  "engines": { "dsh": ">=0.1.7-rc.1 <0.2.0" },
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": ["..."] },
  "compatibility": { "dshReleases": { "0.1.7-rc.1": "compatible" } }
}
```

**关键**：0.1.7 新增插件兼容性预检 `evaluatePluginCompatibility`，用 `semver.satisfies(runtime, range, { includePrerelease: true })` 检查 `@deepseek-ai/dsh*` peer，**不满足会直接禁用该插件行**（不再只是警告）。所以 `dsh.engines.dsh` 与 `peerDependencies` 必须覆盖 `0.1.7-rc.1`。

（背景：dsh-mobile 的 peer 范围在 **v0.4.5 已放宽到 `^0.1.7-0`**，覆盖 0.1.7；此前止于 `^0.1.3-0` 时会被该预检拦下。）

---

## 9. DSH 升级后的复核清单

每次升级 DSH 基线版本，**必须重跑本清单并把结果更新回本文件**：

- [ ] `--host 0.0.0.0` 是否仍被拒绝（`dsh-web-app/lib/startup.js`）？若已解禁，评估是否改用官方方案
- [ ] `/api` 栅栏逻辑是否变化（`dsh-client-connection/lib/index.js` 的 `requestRejection`）
- [ ] cookie 前缀、载荷版本、凭据记录键是否变化（`:223`、`:227`、`:228`、`:284`）
- [ ] `ctx.connection.authenticatedUrl()` 是否仍在
- [ ] WebSocket 路径是否仍为 `/api/remote.mux`
- [ ] `ctx.webServer` 的 `registerUpgrade` 签名是否变化
- [ ] `dsh.engines.dsh` 与 peer 范围是否需要放宽
- [ ] 官方 UI 的断点常量（`SIDEBAR_AUTO_COLLAPSE` 等）是否变化
- [ ] `resolveLanTrust` 行为是否变化

---

## 10. 事实来源

- 上游 release notes：`gh release view dsh-v0.1.7-rc.1 --repo deepseek-ai/deepseek-harness`
- 本机安装包：`.../node_modules/@deepseek-ai/dsh-*/lib/*.js`（行号见正文）
- 上游源码副本：`/Users/lionm5/my_project/_dsh/deepseek-harness`（tag 对照用 `git show`）
- 完整调研报告：`/Users/lionm5/my_project/_dsh/dsh-lan-access-research.md`
