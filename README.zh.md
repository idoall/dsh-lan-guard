<h1 align="center">DSH LAN Guard</h1>

<p align="center">把桌面 DSH 的官方 Web 界面安全地开放到局域网：带门禁的反向代理 + 默认自签 HTTPS + 手机扫码入口。DSH 自身的回环监听与官方 UI 零改动。</p>

<p align="center">
  <a href="https://github.com/idoall/dsh-lan-guard/actions/workflows/ci.yml"><img src="https://github.com/idoall/dsh-lan-guard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/dsh-lan-guard"><img src="https://img.shields.io/npm/v/dsh-lan-guard?label=npm&color=CB3837" alt="npm 版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F172A" alt="MIT"></a>
  <img src="https://img.shields.io/badge/DSH-0.1.7--rc.2-4B6BFB" alt="DSH 0.1.7-rc.2">
</p>

<p align="center"><a href="README.md">English</a> | 中文</p>

<p align="center">
  <a href="#能做什么">能做什么</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#设置">设置</a> ·
  <a href="#兼容性">兼容性</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#排障">排障</a> ·
  <a href="CHANGELOG.md">更新记录</a>
</p>

> DSH LAN Guard 是 DeepSeek Harness 社区插件。它只注册官方设置页里的一个区块（`settings.section`），不替换任何官方布局，也不修改 DSH 源码或 DSH 自身的监听绑定。

DSH 的 Web 界面只监听 `127.0.0.1`，而官方明确拒绝绑定 `0.0.0.0`。本插件不碰那个绑定，而是在另一个端口上再开一个**带门禁的**监听，把官方界面原样代理出去：密码门禁、默认自签 HTTPS、手机扫码入口，以及可逐个批准与拉黑的设备配对。**装完重启一次即可用**——不需要手写任何配置。

<p align="center">
  <img src="./assets/settings-access.png" width="78%" alt="设置 → 局域网访问 → 扫码访问：运行中状态、免密链接与可扫描二维码">
</p>

## 能做什么

- **门禁反向代理**：完整转发 HTTP 与 WebSocket（含官方界面的 `/api/remote.mux` 长连接），改写 `Host`/`Origin`，剥离逐跳头，上游不可达时返回 `502`。DSH 自身的绑定与配置一动不动。
- **默认对外可用，但对外可达 ≠ 可以进入**：默认监听 `0.0.0.0`，所以安装后**只需重启一次**就能用；门禁默认开启，**未设访问密码时拒绝所有设备**，且默认自签 HTTPS——不存在明文传输。想只在本机使用，在设置页切到「仅本机」即可。
- **双密码门禁**：PBKDF2-SHA256（600,000 次迭代）。**访问密码**给手机等访客设备登录用，**管理密码**用于解锁本设置页的管理台（未设置时退回访问密码）；另有 `dsh_` 免密链接、持久访客会话、按 IP 锁定与 CSRF 校验。
- **默认自签 HTTPS，CA 身份跨重启不变**：自动生成 `DSH LAN Guard CA`，按所选网卡地址签发叶证书。换 IP 只重签叶证书，所以每台设备只需信任一次。
- **本机永不锁定**：直连 `127.0.0.1` 享有物理免锁特权（能用这台电脑的人本就能改这些设置）；远程访问按 `adminPolicy` 处理——只读（默认）、需密码解锁、或不锁。
- **设备配对与永久拉黑**：手机首次通过门禁时自己命名一次，获得 HttpOnly 设备身份 cookie，出现在 **已授权设备** 里（名称 / 创建时间 / 最近使用 / 来源 IP），可逐个「吊销并拉黑」。拉黑不依赖设备指纹——换浏览器用密码重新配对也会被拒，「解除拉黑」是唯一的恢复方式。
- **设置挂在官方设置页内**：「局域网访问」分区含四个 tab——扫码访问、安全认证、已授权设备、连接与证书。排版与配色全部使用官方设计 token，**不替换任何官方布局**。
- **端口与监听范围可配**：默认 `3081`（DSH 端口 + 1），被占用时自动往后顺延（最多试 10 个）；设置页可改端口并带可用性检查，也可在「局域网（默认）/ 仅本机」之间切换（两者都需重启 dsh 生效）。
- **可选 mDNS**：默认关闭；开启后广播 `_dsh-lan-guard._tcp`。
- **升级检测**：设置页显示「当前版本 → npm 上最新版本」并给出可复制的升级命令；插件**不会自己安装或重启任何东西**。

## 快速开始

环境要求：

- 带 Web profile 的 DeepSeek Harness
- Node.js 20 或更新
- 已验证的 DeepSeek Harness：`0.1.7-rc.2`

从 npm 安装：

```sh
dsh plugin --profile web add dsh-lan-guard@latest
```

从 GitHub 安装：

```sh
dsh plugin --profile web add "github:idoall/dsh-lan-guard"
```

从本地克隆安装：

```sh
git clone https://github.com/idoall/dsh-lan-guard.git
cd dsh-lan-guard
pnpm install && pnpm run build
dsh plugin --profile web add "link:$(pwd)"
```

然后**重启一次 DSH**，打开 **设置 → 局域网访问**。重启后插件已经在对外监听（默认 `0.0.0.0:3081`，自签 HTTPS + 门禁），你只需要：

1. 在 **安全认证** 里设置**访问密码**（至少 8 位）。没设之前，门禁拒绝所有设备。
2. 在 **连接与证书** 确认**监听范围**（默认「局域网」），并选择对外公布的网卡——网卡决定二维码/访问地址用哪个 IP、自签证书签哪些地址。
3. 在 **扫码访问** 扫码，手机上信任一次 `DSH LAN Guard CA`、输入访问密码、给设备命名。之后手机运行的就是官方 DSH 界面。

> 远程设备默认是**只读**的（`adminPolicy: local_only`）：能用 DSH，但不能改插件设置。想让手机也能管理，在桌面把策略改掉。

## 设置

设置项集中在 **设置 → 局域网访问** 的四个 tab 里。非敏感开关（`enabled`、`listenPort`、`listenHost`、`networkInterface`、`auth.mode`、`auth.adminPolicy`、`auth.adminProtection`、`auth.allowLoopback`、`auth.requirePairing`、`auth.requireApproval`）可直接改；`listenPort` 与 `listenHost` 需重启 dsh 生效；`dataDir` 与 `tls.*` 属启动期字段，需在 profile patch 里改。

| 设置项 | 默认 | 作用 |
| --- | --- | --- |
| 监听范围 | **局域网 `0.0.0.0`** | 决定局域网能否访问这个端口。切到「仅本机 `127.0.0.1`」更保守，需重启 dsh。两种选择都保留门禁与自签 HTTPS。 |
| 代理端口 | **3081** | DSH 端口 + 1；被占用时自动往后顺延（最多试 10 个），带可用性检查。需重启 dsh。 |
| 对外公布的网卡 | 自动选择 | 决定二维码/访问地址用哪个 IP、自签证书签哪些地址；虚拟网卡会被降权标注。 |
| 验证模式 | **扫码免密 + 密码** | 也可选「仅密码」或「仅安全 Token」。切换会**吊销所有已有访客会话**。 |
| 访问密码 | 未设置 | 手机等访客设备的登录密码。**未设置时门禁拒绝所有设备**。 |
| 管理密码 | 未设置 | 解锁本设置页的管理台；未设置时退回访问密码。 |
| 本机回环访问免密 | **开** | `127.0.0.1` 直连跳过门禁（物理免锁）。 |
| 新设备需要命名确认 | **开** | 新设备首次通过门禁时要自己命名一次，之后才出现在设备列表里。 |
| 新设备需要管理员批准 | 关 | 开启后，命名完还要你在设备列表点「批准」才能进入。 |
| TLS | **自签 HTTPS** | 关闭会明文传输门禁密码；非回环 + 关闭 TLS 必须显式设置 `tls.allowInsecureLan: true`，否则**拒绝启动**。 |

<p align="center">
  <img src="./assets/settings-connection.png" width="78%" alt="连接与证书：监听范围「局域网（默认）/ 仅本机」开关、代理端口与可用性检查、网卡选择">
</p>

插件从它的 Cordis 条目读取配置。**所有字段都有可用默认值，装完即可用**：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（可选：只写你想改的字段）
- id: dsh-lan-guard
  config:
    listenHost: 0.0.0.0              # 默认面向局域网；'127.0.0.1' = 仅本机，或写具体网卡 IP
    listenPort: 3081                 # DSH 端口 + 1；被占用时自动顺延
    networkInterface: en0            # 可选：只在一个网卡上公布（留空 = 自动）
    dataDir: ~/.dsh/profiles/web/data/dsh-lan-guard   # 可选；缺省即用这个推导路径
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

`dataDir` 是唯一需要解释的一项：**不写就用** `<当前 profile>/data/dsh-lan-guard`（例如 `~/.dsh/profiles/web/data/dsh-lan-guard`），**写了就优先用你写的**（支持 `~` 前缀）。它只影响插件私有数据（密码哈希、设备令牌哈希、会话、自签 CA）的落点，不影响可用性。

<p align="center">
  <img src="./assets/settings-security.png" width="78%" alt="安全认证：验证模式三选一、访问密码与管理密码设置、本机回环免密开关">
</p>

<p align="center">
  <img src="./assets/settings-devices.png" width="78%" alt="已授权设备：命名确认与管理员批准开关，以及可吊销并拉黑的设备列表">
</p>

## 兼容性

当前版本：插件 **`0.3.2`** 已在 DeepSeek Harness **`0.1.7-rc.2`** 上验证。

| 插件 | 已验证的 DeepSeek Harness | 这个版本是什么 |
| --- | --- | --- |
| **`0.3.2`** | **`0.1.7-rc.2`**、`0.1.7-rc.1` | 装完即用：默认对外监听 + `dataDir` 自动推导；设置页液体玻璃与官方尺寸；访问地址改为单行滚动 |
| **`0.3.1`** | **`0.1.7-rc.2`**、`0.1.7-rc.1` | 针对 `0.1.7-rc.2` 的验证版：代码零改动，只更新兼容元数据 |
| `0.3.0` | `0.1.7-rc.1` | 设备批准与永久拉黑；修掉打开分享的 `?auth=` 链接时的空白页 |
| `0.2.0` | `0.1.7-rc.1` | 升级检测；移除右下角状态胶囊；间距修复 |
| `0.1.1` | `0.1.7-rc.1` | 文档版：中英双语用户 README |
| `0.1.0` | `0.1.7-rc.1` | 首个版本：门禁反向代理、自签 HTTPS、设备配对、设置页、扫码访问 |

- 声明范围 `>=0.1.7-rc.1 <0.2.0`（`dsh.engines.dsh`）；未列入的 DSH 版本属**未验证**，请自行验证后再使用。
- 本插件用到的宿主/客户端接口：`webServer.register` / `indexTaps`、`connection.requestRejection`、`connection.authenticatedUrl`、追加型 `settings.section` seat、`@deepseek-ai/schemastery`，以及 `profileContext`（用于推导默认数据目录）。
- **破坏性默认值变更（`0.3.2` 起）**：`listenHost` 默认由 `127.0.0.1` 改为 `0.0.0.0`，装完重启一次即可用；`0.3.1` 及更早默认仅回环。门禁与自签 TLS 的默认值未变（未设密码仍拒绝所有设备）。详见 [CHANGELOG](CHANGELOG.md)。

官方 UI 零改动复用，手机视口下自动适配：

<p align="center">
  <img src="./assets/mobile.png" width="30%" alt="390px 手机视口下的官方 DSH 界面：插件只做代理，界面由官方原样提供">
</p>

## 安全边界

- DSH 自身的监听地址不被改动；本插件从不修改 DSH 配置、会话数据或官方 UI。
- **门禁先于监听**：监听器只在门禁对象构造完成之后才打开。默认对外监听之所以可接受，是因为 `auth.enabled` 默认为真、**未设访问密码时门禁拒绝所有非回环设备**、且 TLS 默认自签——三者必须同时成立。
- 密钥（`secrets.json`、`devices.json`、会话）存放在 `dataDir`，权限 `600`；密码只存 PBKDF2-SHA256 哈希，设备令牌明文只返回一次，落盘只存 SHA-256 哈希，**免密链接的 token 不写日志**。
- 代理给每个转发请求打上不可伪造的来源标记，宿主据此区分「本机操作者」与「经代理的访客」。
- 回环直连**按设计物理免锁**——能使用这台电脑的人本就能改这些设置。
- 访问密码是**共享**的：吊销设备会立即让该设备的身份 cookie 失效，但换个浏览器用密码仍可重新配对。要「同一台机器永久拉黑」需要设备指纹或每设备独立令牌，本项目刻意不用指纹。
- 只面向局域网：不做公网隧道、不做 IM Bot、不做端口转发。
- 插件自己**不安装、不重启、不推送**任何东西：升级命令由你复制执行。

## 排障

**手机提示证书不受信任。** CA 是自签的：每台设备安装/信任一次 `DSH LAN Guard CA`。信任前先比对 **连接与证书** 里显示的 SHA-256 指纹。

**手机完全连不上。** 确认手机在同一网络、地址与二维码一致，并检查是否有 VPN 或「专用代理/中继」类功能拦截流量；也确认 **监听范围** 没有被切成「仅本机」。

**设置页显示「端口已对局域网开放，但尚未设置访问密码」。** 这是预期的中间状态：端口可达，但门禁拒绝所有设备，不会泄露数据。去 **安全认证** 设一个访问密码即可。

**「配置的端口 X 已被占用，已自动改用 Y」。** 端口被别的程序占着，插件已自行顺延。可在 **连接与证书** 换端口（带可用性检查），或释放该端口。

**「此设备已被移除访问权限」（403）。** 该设备已在 **已授权设备** 中被吊销或拉黑。删除那条记录即可让它重新配对（被拉黑的需先「解除拉黑」）。

**我忘了访问密码。** 在运行 DSH 的电脑上直连 `http://127.0.0.1:3080`（本机直连物理免锁）重设。无头服务器则删除 `dataDir` 下的 `secrets.json` 后重设——在此之前门禁会拒绝所有设备。

**改过密码后所有设备都要重新输密码。** 这是有意的：更换访问密码或切换验证模式会**吊销所有已有访客会话**。

**局域网明文 HTTP 被拒绝。** 非回环 `listenHost` + `tls.mode: 'off'` 会被拒绝，除非显式设置 `tls.allowInsecureLan: true`——否则门禁密码将明文传输。

## 升级

设置页会显示「当前版本 → npm 上最新版本」，并给出**可复制**的升级命令：

```sh
dsh plugin --profile web add dsh-lan-guard@latest
```

插件**不会自己安装任何东西，也不会重启 DSH**——命令由你执行，执行后手动重启一次 dsh。检测只访问公开的 npm registry，结果缓存 6 小时；连不上时只在界面上提示，不影响门禁与代理。

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

客户端半边注册到官方追加型 seat `settings.section`，宿主半边通过包内 `cordis.patch.yml` 挂载。

## 发版

发版由 tag 驱动。更新 `package.json`、把对应 CHANGELOG 段落移出 `Unreleased`、编写带中英双锚点的 `release-notes/v<版本>.md` 后，推送发版提交与 tag：

```sh
git tag v0.3.1
git push origin v0.3.1
```

发版工作流会校验 tag 与 `package.json` 版本一致、要求发布说明含中英双锚点，然后运行 `pnpm run verify`、打包插件、通过 npm trusted publishing（OIDC）发布，并创建附带 tarball 的 GitHub Release。

## 许可

[MIT](LICENSE)
