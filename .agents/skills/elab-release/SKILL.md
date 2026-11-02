---
name: elab-release
description: elab-Flow 主仓与 dsh-elab-cockpit 插件的版本更新、发版与维护流程（单仓单标签）：版本落点、门禁、内核 v* 标签、npm 发布、dsh-market 自动刷新与回滚。触发：用户说要发版 / 版本更新 / 升级版本 / 打 tag / npm publish / 发布插件 / 市场更新 / 维护仓库。
---

# elab-Flow 版本更新与发布

两个版本号**彼此独立**：内核（主仓）用 `vX.Y.Z`，插件用 npm 版本（`package.json`）。

维护链路只有一条：源码在主仓 `packages/dsh-elab-cockpit`，npm 与 DSH 市场都直接取该子目录。
**没有镜像仓 / 第二份插件副本，也不再打 `plugin-v*` tag** —— 标签体系只有 `vX.Y.Z`
（内核发版标记，插件自动下载内核归档时依赖它）；插件版本以 `package.json`、npm、
`CHANGELOG.md` 为准。插件单独发版不需要标签，也不需要改市场条目。

## 1. 版本落点（改哪里）

| 对象 | 位置 | 说明 |
|---|---|---|
| 内核版本 | [cockpit/server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py) `COCKPIT_VERSION` | 面板/`capabilities` 上报的版本 |
| 内核包版本 | [services/elab/__init__.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/__init__.py) `__version__` | 与上一处保持一致 |
| 插件版本 | `packages/dsh-elab-cockpit/package.json` | 用 `npm version X --no-git-tag-version`（同步 lockfile） |
| 插件默认内核 | `src/domain/envpack.ts` `DEFAULT_KERNEL_VERSION` | 跟随内核版本；UI 与宿主半共用 |
| 最低内核 | `src/domain/bootstrap.ts` `MIN_KERNEL_VERSION` | **兼容下限，不随内核升级**（仅提示、不阻断） |
| 变更日志 | `CHANGELOG.md` | 两条独立条目：`[Vx.y.z]` 与 `[DSH 插件 a.b.c]` |
| 文档事实 | 无需逐版更新 | 架构文档只记结构事实，版本以 `package.json` / npm 为准 |
| 版本引用 | `README.md`（`@0.4.x` 之类）、`screenshots.json` | 搜旧版本号清残留 |

> 历史 tag（`v2.1.0`、`plugin-v0.3.2`）保留不动；`plugin-v*` 已停用，新版本不再生成。

## 2. 发版前清理

- 临时文件：`tmp_*.txt`、`tmp_*` 配置、根目录调试脚本。
- 缓存：`__pycache__/`、`.pytest_cache/`、构建中间物（`.work/` 不入库）。
- 未引用截图：`git grep --fixed-strings <文件名>` 计数为 0 且不在 `screenshots.json` 的才删。
- 确认构建产物归属：`cockpit/web/dist/**` 与插件 `lib/**` 是**入库产物**，改源码后必须重建。

## 3. 门禁（缺一不可）

```powershell
# 插件（cwd = packages/dsh-elab-cockpit）
$env:USERPROFILE = "$env:TEMP\dsh-empty-home"   # 隔离本机持久化 elabRoot 配置
npm test                                        # boundary / style-rules / routes 等
npx tsc -p tsconfig.host.json --noEmit          # CI 会跑；npm run build 不覆盖
npx tsc -p tsconfig.client.json --noEmit        # 同上（client 只用自带的 React 最小面）
npm run build                                   # client bundle + 契约校验 + lib/ 重建

# 内核
python tests/test_serialwidgets.py -v           # unittest（仓库未装 pytest）
.\elab.cmd doctor                               # 环境体检
```

- **必须本地跑两条 `tsc --noEmit`**：`npm run build` 走 esbuild 打包，**不做完整类型检查**，
  CI 的 `plugin` 工作流才会跑 tsc；漏跑会得到「本地全绿、CI 红」的假绿。
  Client 侧没有 `@types/react`，只用 [env.d.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/dsh-web/env.d.ts)
  的最小声明 —— 新用到的 React 类型（如 `WheelEvent`）要先补进这里。
- `npm test` 里 `/elab/host` 会话 cwd 用例会被 `~/.dsh/dsh-elab-cockpit.config.json` 的
  `elabRoot` 干扰 → 用空 `USERPROFILE` 跑。
- `elab doctor` 报 `proj.at32_* 未知芯片` 是本机未装 `artery/at32` 适配包，**不是代码缺陷**。
- 插件 `npm run build` 结束时会打印 `PASS: client.js 满足宿主 ModuleLoader 契约` 与 5 个槽位；
  随后 `git diff --exit-code -- lib` 必须为空（CI 同样校验 lib 与源码同步）。

## 4. 提交、推送与标签（只有一套）

```powershell
git add <具体路径>            # 不要 git add -A
git commit -m "release(v3.0.0): ... （插件 0.4.0）"
git push origin main          # ① 先推 main，等 plugin 工作流转绿（badge 见 §8）

# 仅内核/整仓发版需要：
git tag -a v3.0.0 -m "elab-Flow v3.0.0"
git push origin v3.0.0        # ② 绿了再推 tag
```

- **只有 `vX.Y.Z` 一套标签**：它是内核发版标记，插件首次准备环境时按该 tag 下载内核归档。
- **插件单独发版不打 tag**：改 `package.json#version` + `CHANGELOG.md` → 门禁绿 → 推 main →
  `npm publish` 即可。没有分发工作流，也就没有"先 tag 后发布"的顺序问题。
- **顺序很重要**：先推 main 等 CI 绿，再打 tag，避免"标签自带红灯"。
- **标签默认不移动**：修问题发下一个版本。唯一例外：tag 刚推送、**未发 GitHub Release、
  未打新 npm 版本**，且只是补齐门禁（类型声明/测试）而非改产物时，可重指：
  ```powershell
  git tag -f -a v3.0.0 -m "elab-Flow v3.0.0" <修复提交>
  git push --force origin v3.0.0          # 在发布说明里注明
  ```
  产物（npm tarball）保持不变；若已发 npm 新版本，只改运行时行为就必须发下一版。

## 5. 网络与代理（GitHub 推送）

- 本机系统代理常为 `127.0.0.1:7890`（Clash mixed，HTTP/SOCKS 都收）。git 不读系统代理，
  需要显式给：
  ```powershell
  git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin main
  ```
- 节点抖动时会报 `schannel: failed to receive handshake` 或 `unexpected eof` —— **重试 1–2 次**
  通常就好；持续失败再换节点，不要误判为凭据问题。
- 无代理时 `api.github.com` 常不可达；`npm publish` 可直连，不用代理。

## 6. npm 发布

```powershell
cd packages/dsh-elab-cockpit
npm whoami                          # 应为包 owner
npm view dsh-elab-cockpit versions  # 先看已发布版本
npm pack --dry-run                  # 核对 files / assets / lib 体积
npm publish                         # 默认 latest
```

- **版本只能前进**：目标版本必须高于 npm `latest`；`0.3.0` 低于已发布的 `0.3.2` 会回退
  `latest`，应改 `0.3.3` / `0.4.0`。已发布版本不可覆盖，也不能 unpublish。
- `package.json#files` 决定包内容：`lib`、`envpacks/manifest.json`、`cordis.patch.yml`、
  `icon.svg`、`locale`、`README.md`、`screenshots.json`、`assets`。
- 回退展示版本：`npm dist-tag add dsh-elab-cockpit@<旧版本> latest`（不是删版本）。

## 7. dsh-market（awesome-dsh-plugin）

- 市场条目 `data/plugins/xkk6663__elab-flow--packages-dsh-elab-cockpit.yml` 只存
  `url/name/category/description`；版本、下载量、截图由**每日探针**从本仓刷新。
- 因此常规发版**不需要**改市场条目：npm 发布后等探针即可（市场按主仓子目录取内容）。
- 只有分类 / 简介 / 名字这类展示信息变化时才提 PR；投稿备份在
  `packages/dsh-elab-cockpit/docs/dsh-market-submission/`。
- 截图来源：插件根 `screenshots.json`（路径相对包根），新图必须同时进 `assets/`。

## 8. 发布后核对

| 项 | 命令 / 来源 |
|---|---|
| CI（main） | `https://github.com/xkk6663/elab-flow/actions/workflows/plugin.yml/badge.svg?branch=main`（**不需要 token、不限流**，注意缓存，加 `&cb=<随机数>`） |
| 主仓 tag | 仅内核发版需要：`git ls-remote --tags origin v3.0.0`（`^{}` 行才是提交） |
| npm | `npm view dsh-elab-cockpit version dist-tags` |
| 市场 | `awesome-dsh-plugin.com/p/xkk6663/elab-flow--packages-dsh-elab-cockpit/`（探针有延迟） |
| 面板 | DSH 里面板标题旁版本 / `GET /api/capabilities` 的 `cockpit.version` |

- **GitHub REST API 未认证时限流（60 次/小时，共享出口 IP 很容易 403）**：核对优先用
  badge，查 `actions/runs` 留给需要查看失败日志时。

## 9. 回滚

- 主仓：`git revert <commit>`；若内核版本已对外发布，再打新的 `v*` tag。**不要**强推 main。
- npm：只能发更高版本修，或用 `dist-tag` 把 `latest` 指回旧版本。
- 插件降级：用户侧固定旧版本安装；内核 `COCKPIT_VERSION` 与插件 `MIN_KERNEL_VERSION`
  决定兼容提示。

## 10. 纪律

- 业务层（`services/elab/**`、`cockpit/server.py`）与工具层（`packages/dsh-elab-cockpit/**`）
  不跨层 import；插件只走 loopback HTTP ICD。
- 芯片知识只写 `packs/**`；改包后 `elab pkg index` 重生成 `market/index.json`。
- 改 `cockpit/server.py` 后，本仓与用户的 elab 工作检出**两份都要同步**。
