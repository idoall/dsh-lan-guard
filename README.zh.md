# dsh-lan-guard

把桌面 DeepSeek Harness 的官方 Web 界面**安全地**开放到局域网。

> **当前状态：实施中（P1 已完成）。** 工程骨架与最小反代已实现并通过测试；门禁与设置页（P2）、局域网监听 + 自签 TLS + 二维码（P3）尚未实现。**在门禁就位之前，监听只绑回环地址。** 实施计划见 [`docs/PLAN.md`](docs/PLAN.md)。

---

## 这是什么

dsh-lan-guard 是一个 DeepSeek Harness（DSH）插件。它让同一个局域网内的手机、平板、另一台电脑能用浏览器打开你桌面上的 DSH：

- **DSH 自身的回环监听不变**——不修改 DSH 的任何配置，不碰它的源码；
- **官方 Web UI 原样复用**——不替换、不劫持界面，手机上看到的就是官方界面；
- **带密码门禁**——端口不是敞开就完事，进来的人得先过门；
- **默认自签 HTTPS**——可关闭；关闭时设置页会说明明文传输和浏览器能力受限。

---

## 为什么还需要一个

npm 上已经有 16 个以上名字相近的 `dsh-lan-*` 插件。它们大多在解决同一个问题：**怎么把 DSH 的端口打开到局域网**。

dsh-lan-guard 关注的是下一个问题：**打开之后，谁进得来。**

具体差异：

| 维度 | 常见做法 | dsh-lan-guard |
| --- | --- | --- |
| 门禁 | 无，或依赖 DSH 自身的 cookie 栅栏 | 自带密码门禁 + IP 失败锁定 |
| UI | 有的替换官方界面做手机专属布局 | **官方 UI 零改动**（因此不随 DSH 版本漂移） |
| DSH 配置 | 有的把 `host` 改成 `0.0.0.0` | 不动 DSH 绑定，代理在另一个端口 |
| 传输 | 多为明文 HTTP | 默认自签 HTTPS，可关闭 |

---

## 计划提供的能力

- 反向代理：HTTP 与 WebSocket（含 DSH 0.1.7 的 Remote 流 `/api/remote.mux`）
- 请求头改写与上游会话 cookie 注入（让代理流量在 DSH 看来是本机回环请求）
- 密码门禁：访问密码 + 独立管理密码、免密链接令牌、持久会话、按 IP 的失败锁定
- 设置界面：挂在 **DSH 官方设置页**里（注册官方 seat，不替换官方 UI），用于配置门禁、查看访问地址和扫码
- 默认自签 HTTPS：长期 CA + 按网卡 IP 签发的叶证书；可关闭，关闭时提示影响
- 局域网二维码：设置页展示当前地址，支持普通链接和需管理员解锁的免密链接
- 多网卡识别与选择（虚拟网卡降权）
- 官方 Web UI 零改动

---

## 明确不做

- ❌ 公网隧道（Cloudflare / cpolar / FRP / Tailscale）
- ❌ IM Bot（微信 / QQ / 飞书 / Telegram）
- ❌ 手机专属界面（官方界面已自带响应式适配）
- ❌ 修改 DSH 源码或其 `host` 绑定
- ❌ 多用户账号体系

---

## 文档

本仓库的文档分为两类：**面向使用者**和**面向 AI 助手**。

### 面向使用者

| 文档 | 内容 |
| --- | --- |
| [`README.md`](README.md) / `README.zh.md` | 项目说明（本文件） |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更记录 |
| [`docs/SPEC.md`](docs/SPEC.md) | 技术规格：做成什么样、明确不做什么 |
| [`docs/PLAN.md`](docs/PLAN.md) | 分阶段实施计划与验收标准 |

### 面向 AI 助手（实施时必读）

| 文档 | 内容 |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | **AI 协作总纲**：职责、红线、停止点、工作流、漂移自检 |
| [`docs/GUARDRAILS.md`](docs/GUARDRAILS.md) | 权限边界：可做 / 不可做 / 必须先问、职责矩阵 |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | 已核实的 DSH 事实基线（含文件路径与行号） |
| [`docs/RELEASE.md`](docs/RELEASE.md) | 发布流程与授权级别 |

> 如果你是把本项目交给 AI 实施：**先让它读 `AGENTS.md`。** 那份文件专门用于防止 AI 跑偏。

---

## 安全说明

- 本插件默认**不**对外监听；需要显式配置才开放；
- 局域网不是可信网络。同网段的任何设备都能尝试连接，因此门禁是必需项而非可选项；
- 自签 HTTPS 需要在手机上一次性信任 CA 证书；
- 密码以 PBKDF2-SHA256 哈希存储，仓库内不会出现任何明文凭据或私钥。

- **mDNS 发现是可选项且默认关闭**（`mdns.enabled`）。即便打开，iOS Safari 与 Android Chrome 在实践中也不会为任意网页解析 `.local` 名字——**手机上的可靠路径仍是二维码**。

---

## 开发

需要 Node ≥ 20 与 pnpm。

```sh
pnpm install
pnpm test        # 类型检查（源码 + 测试）+ vitest
pnpm run build   # tsdown → lib/
```

---

## 许可

[MIT](LICENSE)
