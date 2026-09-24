# RELEASE — 发布流程约定

> 本文件定义**何时、以什么形式发布**。改动本文件需要用户批准（`AGENTS.md` §4）。
> **红线提醒**：未经用户当次对话的明确授权，不得执行 `npm publish`、不得打 tag、不得建 GitHub Release、不得推送（`AGENTS.md` §3.4；职责归属见 `GUARDRAILS.md` §5）。

---

## 1. 默认策略：保守，不擅自发布

**在用户明确授权之前：**

- ❌ 不执行 `npm publish`；
- ❌ 不创建 git tag；
- ❌ 不创建 GitHub Release；
- ❌ 不 `git init` / 不建远程仓库 / 不 `git push`；
- ❌ 不合并任何分支到 `main`。

**"把代码写好"不等于"可以发布"。** 这两件事的授权是分开的。

> 用户对名下不同仓库的发布策略并不相同（有的要求"只推 Dev、不自动合 main、不发版"，有的授权"助手全权发布"）。
> **本仓库的授权状态必须由用户在当次对话中明确说明**，不要从其他仓库的惯例推断。

---

## 2. 授权状态

| 授权级别 | 允许的动作 | 当前状态 |
| --- | --- | --- |
| L0 默认 | 只写代码与文档，不碰 git 远程与发布 | 已被 L3 覆盖 |
| L1 可提交 | L0 + 本地 git 提交、推送到指定分支 | 已被 L3 覆盖 |
| L2 可合并 | L1 + 建 PR、合并到 `main` | 已被 L3 覆盖 |
| L3 可发布 | L2 + 打 tag、`npm publish`、建 GitHub Release | **✅ 已授权（2026-09-25）**：用户当次对话明确授权「仓库已创建，可以使用 gh 命令发布上去」，范围＝首次发布 v0.1.0 至 `idoall/dsh-lan-guard` |

用户授权时，请在本表把对应级别标注为已授权，并写明授权日期与范围。**级别只能由用户提升。**

---

## 3. 发布前检查清单（拿到 L3 授权后逐条执行）

- [ ] `docs/PLAN.md` 中目标阶段已完整验收通过；
- [ ] `pnpm test` 全绿（含类型检查）；
- [ ] `pnpm run typecheck` 通过；
- [ ] 版本号已在 `package.json` 更新（遵循 §5）；
- [ ] `CHANGELOG.md` 已记录本次变更；
- [ ] `package.json` 的 `dsh.engines.dsh` 与 `peerDependencies` 覆盖当前 DSH 基线（`RESEARCH.md` §8）；
- [ ] `dsh.compatibility.dshReleases` 已记录兼容矩阵；
- [ ] **release 说明文件已手写完成**，含中英两个锚点（§4）；
- [ ] `npm pack --dry-run` 的 `files` 清单不含测试、私钥、临时文件；
- [ ] 没有把任何凭据 / 私钥 / 密码提交进仓库（`GUARDRAILS.md` §4）；
- [ ] `docs/RESEARCH.md` 的复核清单已在当前 DSH 版本上跑过。

---

## 4. release 说明规范

### 唯一来源

GitHub Release 的正文**必须来自仓库内的手写文件**，不使用自动生成的提交标题。

约定路径（二选一，本项目建议前者，与 dsh-notify 一致）：

- `release-notes/v<version>.md` ← **建议**
- `docs/releases/v<version>.md`

发布工作流用 `gh release create --notes-file <该文件>` 读取。

### 结构：中英双语，各一份

顺序固定：

1. **标题**——最显眼处写「兼容的最新 DSH 版本」
2. **版本对应表**——同样把「兼容的最新 DSH 版本」放在最显眼位置
3. 六段正文（中英各一份）：
   - 版本对应
   - 为什么必须适配（**首发版本改写为「为什么做这个插件」**）
   - 改了什么
   - 谁受影响
   - 兼容性与升级
   - 限制

### 锚点门禁

文件必须包含两个 HTML 锚点，缺失时发布流程应直接失败：

```html
<h3 id="cn-vX.Y.Z">中文</h3>
...
<h3 id="en-vX.Y.Z">English</h3>
```

工作流里用 `grep` 校验这两个锚点存在后再发布。

### 首行摘要风格

首行一句话摘要，格式参考既有插件：

```
@idoall/dsh-lan-guard X.Y.Z — 已验证 DeepSeek Harness 0.1.7-rc.1（最新候选版本）
```

---

## 5. 版本号与 tag 约定

- 遵循语义化版本；
- 首发建议 `0.1.0`；
- tag 格式：轻量 tag `v<version>`（与既有插件一致）；
- `package.json` 的 `version` 必须与 tag 一致；
- 发布工作流应有**版本门禁**：`package.json` 版本与 tag 不一致时直接失败。

---

## 6. 发布后核对

- [ ] npm 上的 `latest` 版本正确；
- [ ] GitHub Release 正文与仓库内说明文件一致；
- [ ] Release 附件与 npm tarball 内容一致（可用哈希核对）；
- [ ] `dsh.engines.dsh` 声明的范围与 release 说明中「兼容的最新 DSH 版本」一致。

---

## 7. 与发布无关但常被混淆的两件事

- **"本地能用"不等于"可以发布"**——P3 的手机实测通过只是阶段验收；
- **"推送到 Dev 分支"不等于"可以发版"**——即使拿到 L1 授权，L3 仍需单独授权。
