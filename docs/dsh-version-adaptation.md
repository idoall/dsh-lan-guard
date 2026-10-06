# DSH 版本适配 SOP

DSH 发新版本（`rc.3` / 正式版 / `0.3.x`）时按这份流程走一遍。
2026-10-01 以 `0.2.0-rc.1 → 0.2.0-rc.2` 首次走通全流程；2026-10-06 又走了 `0.2.0-rc.2 → 0.2.1-alpha.1`
（这一版多出了"vendor 连带升级"这一步，见第 4 步的 ⚠️）。

> 结论先行：`rc.2` 那次是**仅声明、零代码**。这很正常 —— DSH 在发布候选之间通常只动版本号，
> 真正的适配成本在"证明它没变"，而不在改代码。

## 第 1 步：定位官方源码与两个版本

- 官方源码：`/Volumes/SSD/Home/lionm4/my_project/_dsh/idoall/deepseek-harness`
- 运行时安装版：`$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下的各包

**以源码为准排查、以安装版为准签名。**

```sh
cd /Volumes/SSD/Home/lionm4/my_project/_dsh/idoall/deepseek-harness
git tag -l 'dsh-v0.2.0*'                 # 列出可用 tag
git diff --stat <旧tag> <新tag> | tail -3 # 总改动量（rc.1→rc.2 是 1022 files，别被吓到）
```

## 第 2 步：只 diff 本插件依赖的那几个面

本插件用到的宿主接口就是"要盯住的面"，其余都不用看：

| 接口 | 官方包路径 |
| --- | --- |
| `webServer.register` / `tapIndex` / `port` | `packages/host/webserver` |
| `connection.requestRejection` / `authenticatedUrl` | `packages/client/connection` |
| `slots.inject` / `slots.register` | `packages/client/ui-slots` |
| `settings.section` seat | `packages/client/ui-settings` |
| `dsh.client.inject` 声明的四个 UI 包 | `packages/client/ui-renderer`、`ui-layout`、`ui-settings`、`ui-settings-general` |

```sh
for p in packages/client/connection packages/host/webserver packages/client/ui-slots \
         packages/client/ui-settings packages/client/ui-layout packages/client/ui-renderer; do
  echo "=== $p ==="
  git diff --name-only <旧tag> <新tag> -- "$p"
done
```

**判读**：

- 只列出 `package.json` ⇒ 版本号改动，接口面没变（rc.2 就是这种情况，可以直接跳到第 4 步的验证）。
- 列出 `src/**` ⇒ 逐个读，重点确认上表那几个符号的签名。**必须读一眼才能下结论**，不能因为文件名眼熟就跳过。

两个已经出现过的"读了才知道无关"的例子：

| 版本 | 源码改动 | 为什么与本插件无关 |
| --- | --- | --- |
| `0.2.0-rc.2` | `ui-renderer/src/client/scoped-slots.tsx` 把 `nextAncestors` 提前到 `useMemo`（修 React hooks 顺序） | 本插件不注册 slot 组件 |
| `0.2.1-alpha.1` | `ui-layout` 把 frame 的网格行从 `100%` 改成 `minmax(0,1fr) auto`、新增 `shell.bottom` 槽与 `.bottomRow`；`ui-renderer` 删掉 `invariant.ts` | 本插件只占 `settings.section`，不渲染 `shell.bottom`；全仓只有 `experimental/inspector` 用它 ⇒ 实测该行为 `[0,844,390,0]`，不占高度 |

## 第 3 步：符号存在性核对

```sh
grep -rn "register(\|tapIndex" packages/host/webserver/src/index.ts | head
grep -rn "requestRejection\|authenticatedUrl" packages/client/connection/src/*.ts | head
```

期望：`register(route: WebRoute): () => void`、`tapIndex(transform): () => void`、
`authenticatedUrl(baseUrl: string): string`、`requestRejection(request: ConnectionTrustRequest)`。

## 第 4 步：升级宿主依赖并全量验证（本仓库）

```sh
# 先把 package.json 里 devDependencies 的宿主包升到新版本
pnpm install
pnpm run test      # typecheck + 全部用例
pnpm run verify    # 再加 build + npm pack --dry-run
```

**为什么必须升 devDependency 再跑**：只有用新版宿主的真实类型跑过，才能证明"接口面没变"，
否则只是拿着旧类型自说自话。

⚠️ **`0.2.1-alpha.1` 起，要升的不止那两个宿主包。** 新的
`@deepseek-ai/dsh-host-webserver` / `dsh-client-connection` 把 vendor 版本写进了
自己的 `peerDependencies`：`@deepseek-ai/cordis: ~4.0.5-alpha.1`、
`@deepseek-ai/schemastery: ~3.18.5-alpha.1`（本次 vendor 同步升到 `cordis 4.0.5-alpha.1`、
`schemastery 3.18.5-alpha.1`）。只升两个宿主包时 pnpm 会报
`unmet peer @deepseek-ai/cordis@~4.0.5-alpha.1: found 4.0.4`，而且 —— 更关键 ——
**`^4.0.4` 这类范围默认不含预发布版本**，`4.0.5-alpha.1` 落在它外面，所以必须显式钉到
`4.0.5-alpha.1`，类型环境才与运行环境一致。本插件的 `peerDependencies` 保持原样即可：
门禁只比对 `@deepseek-ai/dsh*`（见 [plugin-compatibility.ts](https://github.com/deepseek-ai/deepseek-harness) 的
`evaluatePluginCompatibility`，它 `continue` 掉所有非 `dsh*` 名字），cordis/schemastery 的 peer 不参与丢弃判定。

## 第 5 步：实测移动端（不依赖真机）

按 [mobile-regression.md](mobile-regression.md) 跑两个入口的四个量化判据。

**为什么这步不能省**：DSH 曾把右侧全屏面板的实现从 `position:fixed; inset:0` 换成
`position:absolute` + 内联 `width:100vw`（滑动/隐藏下移到内层 `[data-dockkit-host="dock"]`）。
这类改动**不会让任何用例变红**，只在窄屏几何上表现。判据有变化就记下来，例如：

| 判据 | `0.2.0-rc.1` | `0.2.0-rc.2` | `0.2.1-alpha.1` |
| --- | --- | --- | --- |
| 滚动层内部被裁层数 | 1（`EvIC1a_frame`） | **0** | **0** |
| 可滚范围 | 336px | **92343px** | 5084px（该会话本身较短） |
| `mobileScrollFix` 行为 | 动手补偿 | **空转**（每轮自检后整体撤销） | **空转**（`?lgdiag=1`：`clipping=0` → `ineffective -> reverted (stock page)`） |
| 右侧栏「展开」后可见面积 | — | 100% | **100%**（3080/3081 逐项一致） |

`0.2.1-alpha.1` 上还顺手加了第 5 条判据（可选）：把 `mobileTurnRail` 的注入脚本原样打进页面，
浮轨应从 `display:none` 变 `block`、rect `[357,355,24,52]`、5 格、间距 10px，且**其余 nav 不受影响**。
详见 [mobile-regression.md](mobile-regression.md) 第五节。

## 第 6 步：落声明、归档、发版

| 文件 | 改什么 |
| --- | --- |
| `package.json` | `dsh.compatibility.dshReleases` 加 `"<新版本>": "compatible"`；`version` 递增 |
| `README.md` / `README.zh.md` | 徽章、`已验证的 DeepSeek Harness`、兼容表新增一行 |
| `CHANGELOG.md` | 新增 `## [<版本>] — <日期>（…）` 段落 |
| `release-notes/v<版本>.md` | **必须**含 `<h3 id="cn-v<版本>">` 与 `<h3 id="en-v<版本>">` 两个锚点 |

```sh
git add -A && git commit -m "release: <版本> — 兼容 DSH <新版本>"
git tag v<版本>
git push origin main && git push origin v<版本>
```

推完就结束了 —— 剩下的 CI 全包。

## 附一：发版链路（本机不需要 npm token）

`.github/workflows/release.yml`，触发条件 `on: push: tags: ['v*']`，四段：

1. `version` 闸：tag 去掉 `v` 必须等于 `package.json` 的 version；release notes 的双语锚点必须齐，否则第一步就红
2. `package`：`pnpm install --frozen-lockfile` → `pnpm run verify` → `npm pack` 上传 artifact
3. `publish`：**OIDC Trusted Publishing**（`id-token: write`，无 `NODE_AUTH_TOKEN`）→ `npm publish --access public --provenance`
4. `release`：以 release notes 为正文建/更新 GitHub Release，并附上 `.tgz`

⚠️ **不要在本机跑 `npm publish`**。这条链路完全不经过本机凭据，本机 `~/.npmrc` 的 token
即使过期也不影响发布 —— 反过来说，在本机 publish 失败**不能说明发布会失败**。

## 附二：兼容性元数据有三处，别只改一处

| 位置 | 作用 |
| --- | --- |
| `dsh.compatibility.dshReleases` | 给人看的"已验证清单"，也是市场上架信息 |
| `dsh.engines.dsh` | 说明性范围，**不参与门禁** |
| `peerDependencies["@deepseek-ai/dsh-*"]` | **真正的门禁**：profile 加载时按 **DSH 运行时版本**比对（不是与该 peer 包自身版本比），范围不含运行版本就**静默**丢弃插件 |

`<0.3.0` 这个上界是 0.4.3 从 `<0.2.0` 放宽来的：裸的 `<0.2.0` 恰好排除 `0.2.0` 正式版，
正式版发布当天插件会被静默丢掉。**每次适配新版本时顺手确认上界仍然包住它。**
