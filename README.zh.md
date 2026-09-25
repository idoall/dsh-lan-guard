<h1 align="center">DSH LAN Guard</h1>

<p align="center">在手机上使用官方 DeepSeek Harness Web 界面——一个局域网内的门禁反向代理，不改动 DSH 自身的回环绑定。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-lan-guard"><img src="https://img.shields.io/npm/v/dsh-lan-guard?label=npm&color=CB3837" alt="npm 版本"></a>
  <a href="https://github.com/idoall/dsh-lan-guard/actions/workflows/ci.yml"><img src="https://github.com/idoall/dsh-lan-guard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F172A" alt="MIT"></a>
</p>

<p align="center"><a href="README.md">English</a> | 中文</p>

<p align="center">
  <a href="#能力">能力</a> ·
  <a href="#安装">安装</a> ·
  <a href="#使用">使用</a> ·
  <a href="#兼容性">兼容性</a> ·
  <a href="#配置">配置</a> ·
  <a href="#排障">排障</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#卸载">卸载</a> ·
  <a href="#开发">开发</a>
</p>

> DSH LAN Guard 是 DeepSeek Harness 的社区插件。它**不修改 DSH 核心**、**不改动 DSH 自身的监听地址**，并**原样复用官方 Web UI**。

DSH 的 Web 界面只监听 `127.0.0.1`，手机、平板无法访问；而 DSH 官方明确拒绝绑定 `0.0.0.0`。本插件不碰那个绑定，而是另开一个**带门禁的端口**，把官方界面代理到局域网：密码门禁、默认自签 HTTPS、手机扫码入口，以及可逐个吊销的设备配对。

## 能力

- **门禁反向代理**：完整转发 HTTP 与 WebSocket（含官方界面的 `/api/remote.mux` 长连接），改写 `Host`/`Origin`，剥离逐跳头，上游不可达时返回 `502`。
- **密码门禁**：PBKDF2-SHA256（600,000 次迭代）；**访问密码**（手机等访客）与**管理密码**（本管理台）分离；`dsh_` 免密链接；持久访客会话；按 IP 锁定与 CSRF 校验。
- **默认自签 HTTPS**：自动生成 `DSH LAN Guard CA`，按所选网卡地址签发叶证书；CA 身份跨重启不变，所以每台设备只需信任一次。
- **本机永不锁定**：直连 `127.0.0.1` 物理免锁；远程访问按 `auth.adminPolicy` 处理——只读（默认）、需密码解锁、或不锁。
- **设备配对**：远程设备通过门禁后自己命名一次，获得 HttpOnly 设备身份 cookie，出现在设置页（名称 / 创建时间 / 最近使用 / 来源 IP），可逐个吊销；被吊销的设备立刻收到 `403`。
- **设置挂在官方设置页内**：「局域网访问」分区含四个 tab——扫码访问、安全认证、已授权设备、连接与证书。排版与配色全部使用官方设计 token，**不替换任何官方布局**。
- **端口可配置**：默认 `3081`（DSH 端口 + 1），被占用时自动往后顺延（最多试 10 个），设置页可改并带可用性检查。
- **可选 mDNS**：默认关闭；开启后广播 `_dsh-lan-guard._tcp`。

## 安装

```sh
dsh plugin --profile web add dsh-lan-guard
```

然后**重启一次 DSH**（插件的服务端半边在启动时加载），打开 **设置 → 局域网访问**。

## 使用

1. 在 **设置 → 局域网访问 → 安全认证** 里设置**访问密码**（至少 8 位）。没设之前，门禁拒绝所有设备。
2. 在 **连接与证书** 里选择对外公布的网卡。配置后默认监听 `0.0.0.0`；想先本机试跑就把配置里的 `listenHost` 设为 `127.0.0.1`。
3. 打开 **扫码访问** tab，用手机扫描二维码。
4. 手机上：信任 `DSH LAN Guard CA` 证书（SHA-256 指纹在设置页可复制）、输入一次访问密码，然后在**配对页**给这台设备起个名字。
5. 手机现在运行的就是官方 DSH 界面。它会出现在 **已授权设备** 里，你可随时吊销。

> 远程设备默认是**只读**的（`adminPolicy: local_only`）：能用 DSH，但不能改插件设置。想让手机也能管理，在桌面把策略改掉。

## 兼容性

当前版本：插件 **`0.3.1`** 已在 DeepSeek Harness **`0.1.7-rc.2`**（最新候选版本）上验证通过。

### 插件版本与 DeepSeek Harness 版本的对应

| 插件 | 已验证的 DeepSeek Harness | npm 上 | 这个版本是什么 |
| --- | --- | --- | --- |
| **`0.3.1`** | **`0.1.7-rc.2`**、`0.1.7-rc.1` | `latest` | 针对 DSH `0.1.7-rc.2` 的验证版：**代码零改动**，只更新兼容元数据与本表 |
| `0.3.0` | `0.1.7-rc.1` | 已发布 | 设备批准与永久拉黑（F9）；修掉打开分享的 `?auth=` 链接时的空白页 |
| `0.2.0` | `0.1.7-rc.1` | 已发布 | 升级检测；移除右下角状态胶囊；间距修复 |
| `0.1.1` | `0.1.7-rc.1` | 已发布 | 文档版：中英双语用户 README |
| `0.1.0` | `0.1.7-rc.1` | 已发布 | 首个版本：门禁反向代理、自签 HTTPS、设备配对、设置页、扫码访问 |

- 声明范围 `>=0.1.7-rc.1 <0.2.0`（`dsh.engines.dsh`），`dsh.compatibility.dshReleases` 记录 **`0.1.7-rc.2: compatible`** 与 `0.1.7-rc.1: compatible`。
- **`0.3.1` 在 `0.1.7-rc.2` 上的验证方式**：本插件用到的宿主/客户端接口全部存在且未变——`webServer.register` / `indexTaps`、`connection.requestRejection`、`connection.authenticatedUrl`、追加型 `settings.section` 与 `shell.overlay` seat，以及 `@deepseek-ai/schemastery`——并在该版本上端到端跑通（设置页、扫码访问、门禁、代理）。**无需任何源码改动。**
- 未列入的 DSH 版本属**未验证**——请自行验证后再使用。
- 需要锁定版本时：

  ```sh
  dsh plugin --profile web add dsh-lan-guard@0.3.1
  ```

## 配置

插件从它的 Cordis 条目读取配置（profile patch 或 `dsh plugin` 配置）。默认值保守：**你不开口，它不对外公布。**

```yaml
enabled: true                    # 总开关
listenHost: 0.0.0.0              # 默认 127.0.0.1（仅回环）；要面向局域网需显式设置
listenPort: 3081                 # DSH 端口 + 1；被占用时自动顺延（最多 10 个）
upstreamOrigin: http://127.0.0.1:3080
dataDir: ~/.dsh/profiles/web/data/dsh-lan-guard
networkInterface: en0            # 可选：只在一个网卡上公布（留空 = 自动）
tls:
  mode: self-signed              # 'self-signed'（默认）| 'provided' | 'off'
  allowInsecureLan: false        # 局域网明文 HTTP 的显式风险确认
mdns:
  enabled: false                 # 广播 _dsh-lan-guard._tcp
auth:
  mode: token_and_password       # 'token_and_password' | 'password' | 'token'
  adminPolicy: local_only        # 'local_only'（默认）| 'password_unlock' | 'open'
  adminProtection: true          # 管理台需要管理密码
  allowLoopback: true            # 127.0.0.1 访客跳过门禁（物理免锁）
  requirePairing: true           # 新的远程设备必须先命名一次
```

以上各项也可在设置页修改（非敏感项声明为 volatile 配置字段）。

## 设备批准与永久拉黑

已配对的设备列在 **设置 → 局域网访问 → 已授权设备**，分三组：**待批准 / 已授权 / 已拉黑**。

- 打开 **「新设备需要管理员批准」**（默认关闭）后，新配对的设备需要你点「批准」才能进入；等待期间手机上显示「等待管理员批准」页。
- **「吊销并拉黑」** 会让该设备**永久失效**：身份被拒绝，换浏览器用访问密码重新配对也会被拒；**「解除拉黑」是唯一的恢复方式**。
- 这里刻意**不使用设备指纹**（换浏览器或升级系统就会失效）——由你决定，且决定是持久的。

## 升级

设置页会显示「当前版本 → npm 上最新版本」，并给出**可复制**的升级命令：

```sh
dsh plugin --profile web add dsh-lan-guard@latest
```

本插件**不会自己安装任何东西，也不会重启 DSH**——命令由你执行，执行后手动重启一次 dsh。检测只访问公开的 npm registry，结果缓存 6 小时；连不上时只在界面上提示，不影响门禁与代理。

## 排障

**手机提示证书不受信任。** CA 是自签的：每台设备安装/信任一次 `DSH LAN Guard CA`。信任前先比对 **连接与证书** 里显示的指纹。

**手机完全连不上。** 确认手机在同一网络、地址与二维码一致，并检查是否有 VPN 或「专用代理/中继」类功能拦截流量。设置页会显示监听器**实际绑定**的地址。

**「配置的端口 X 已被占用，已自动改用 Y」。** 端口被别的程序占着，插件已自行顺延。可在 **连接与证书** 换端口（带可用性检查），或释放该端口。

**「此设备已被移除访问权限」（403）。** 该设备已在 **已授权设备** 中被吊销。删除那条记录即可让它重新配对。

**我忘了访问密码。** 在运行 DSH 的电脑上直连 `http://127.0.0.1:3080`（本机直连物理免锁）重设。无头服务器则删除 `dataDir` 下的 `secrets.json` 后重设——在此之前门禁会拒绝所有设备。

**改过密码后所有设备都要重新输密码。** 这是有意的：更换访问密码或切换验证模式会**吊销所有已有访客会话**。

**局域网明文 HTTP 被拒绝。** `listenHost` + `tls.mode: 'off'` 会被拒绝，除非显式设置 `tls.allowInsecureLan: true`——否则门禁密码将明文传输。

## 安全边界

- DSH 自身的监听地址不被改动；本插件从不修改 DSH 配置或官方 UI。
- 密钥（`secrets.json`、`devices.json`、会话）存放在 `dataDir`，权限 `600`；设备令牌明文只返回一次，落盘只存 SHA-256 哈希。
- 门禁先于监听可用；代理给每个转发请求打上不可伪造的来源标记，宿主据此区分「本机操作者」与「经代理的访客」。
- 回环直连**按设计物理免锁**——能使用这台电脑的人本就能改这些设置。
- 访问密码是**共享**的：吊销设备会立即让该设备的身份 cookie 失效，但换个浏览器用密码仍可重新配对。要「同一台机器永久拉黑」需要设备指纹或每设备独立令牌。
- 只面向局域网：不做公网隧道、不做 IM Bot、不做端口转发。

## 卸载

```sh
dsh plugin --profile web remove dsh-lan-guard
rm -rf ~/.dsh/profiles/web/data/dsh-lan-guard   # 可选：删除密钥、设备记录与 CA
```

## 开发

```sh
pnpm install
pnpm test          # 单元 + 集成测试（含类型检查）
pnpm run build     # 打包 lib/index.js 与 lib/client.js
pnpm run verify    # 类型检查 + 测试 + 构建 + pack dry-run
```

设计与验证记录在 [`docs/`](docs/)：`SPEC.md`（要做什么）、`PLAN.md`（阶段门禁与逐项验证记录）、`RESEARCH.md`（已核实的 DSH 事实）、`GUARDRAILS.md`（红线）、`RELEASE.md`（发布流程）。

## 许可

[MIT](LICENSE)
