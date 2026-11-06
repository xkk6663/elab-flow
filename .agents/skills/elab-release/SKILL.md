---
name: elab-release
description: elab-Flow 主仓与 dsh-elab-cockpit 插件的版本更新、发版与维护流程（单仓单标签）：版本落点、门禁、内核 v* 标签、npm 发布、GitHub Release 同步发布、插件市场展示面（截图 + 简介）更新、dsh-market 自动刷新与回滚。触发：用户说要发版 / 版本更新 / 升级版本 / 打 tag / npm publish / 发布插件 / 发 release / 市场更新 / 换市场图 / 改市场简介 / 维护仓库。
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
  —— 反过来也成立：`screenshots.json` 里列了但 `assets/` 里没有 = 市场展示图裂了，发版前必查。
- 确认构建产物归属：`cockpit/web/dist/**` 与插件 `lib/**` 是**入库产物**，改源码后必须重建。
- 市场展示图与简介：见 §7（换图 = 改 `assets/` + 改 `screenshots.json` + 改市场条目简介）。

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

- **代理端口会变，每次先探测再推**，不要沿用文档里的旧端口：
  ```bash
  for p in 4507 7890 7891 10809; do
    timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/$p" 2>/dev/null && echo "$p OPEN" || echo "$p closed"
  done
  ```
  本机历史端口：`7890`（Clash mixed）、`7891`、`4507`（环境变量口）。**以实测为准**。
- git 不读系统代理，需要显式给：
  ```bash
  git -c http.proxy=http://127.0.0.1:<探测到的端口> -c https.proxy=http://127.0.0.1:<端口> push origin main
  ```
- 节点抖动时会报 `schannel: failed to receive handshake` 或 `unexpected eof` —— **重试 1–2 次**
  通常就好；持续失败再换节点，不要误判为凭据问题。
- **代理全关时**：`api.github.com` / `github.com` 不可达，但 `registry.npmjs.org` 通常直连可用。
  此时**只做本地改动**（版本号 + 物料 + 提交），push / publish / release 全部等指令；
  别反复重试网络（见 §8.3 与 §11 纪律）。

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

### 7.1 展示面 = 图 + 简介，两样必须一起更新

市场条目拆成两块，**由不同来源提供**，只改一块会露馅：

| 展示位 | 来源 | 改法 |
|---|---|---|
| 卡片图（多张轮播） | 插件根 `screenshots.json` → `assets/*.png` | 换图 + 改 `screenshots.json` 清单 |
| 卡片简介（中英） | 市场条目 yml 的 `description.en` / `description.zh` | 改 yml（备份在本仓 `docs/dsh-market-submission/`） |

**换图时两处都要动**：`screenshots.json` 是清单（决定展示哪几张、什么顺序），
`assets/` 是图本体。只加图不改清单 = 新图不展示；只改清单不换图 = 展示的还是旧 UI。

图的选择标准：**必须是当前 UI 的真机窄栏截图**，且覆盖版本的核心能力面。
不要用 WebUI 宽屏图（那是独立 WebUI，DSH 插件展示的是窄栏）。

**封面图（清单第一张）用「DSH 全窗口」图**：包含宿主左侧导航 + 中间对话区 +
右侧 ELAB 面板整栏（编译/烧录/调试校验/串口四个 tab 都在画面里），
让访客一眼看到「插件长什么样、装进 DSH 是什么效果」。
窄栏细节图排在后面。素材：`docs/tutorials/assets/dsh/01-auto-probe-full.png`
（主仓 README 与插件 README 已用同一张，三处保持一致）。

**压缩配方**（市场图进 npm 包，别把包撑大）：

```python
from PIL import Image
im = Image.open(src).convert('RGB')
w = 1200 if 'full-window' in dst else 900      # 封面全窗口图信息密度高，用 1200
r = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
r.quantize(colors=256, method=Image.FASTOCTREE,
           dither=Image.FLOYDSTEINBERG).save(dst, optimize=True)          # P256 量化
```

- LANCZOS 缩放 + 256 色调色板量化：244 KB → 83 KB，肉眼无色带、文字仍清晰。
- 宽度按信息密度定：窄栏特写 900，全窗口封面 1200（2559 → 1200 宽仍 77 KB）。
- **量化后必须目视复查**（看整图 + 裁一块放大看文字），别只看文件大小。
- `ffmpeg` 能用但压 PNG 收益差（只做 `scale` 反而变大），优先 Pillow。

**流程**：

1. 从 `docs/tutorials/assets/dsh/`（DSH 窄栏）与 `docs/tutorials/assets/wave/`（窄栏波形）
   挑真机图；`webui/` / `serial-frames/` 是独立 WebUI，**不要**用于插件市场。
2. 按上式压缩，落到 `packages/dsh-elab-cockpit/assets/<语义名>.png`。
   命名用语义（`dsh-full-window.png` / `dsh-closed-loop.png` / `dsh-serial-monitor.png` /
   `dsh-debug-source.png` / `dsh-serial-wave.png`），不要用序号 —— 删图后序号会错位。
3. 改 `screenshots.json` 清单（顺序 = 展示顺序，**第一张是封面，放全窗口图**）。
4. 改市场条目 yml 的 `description.en` / `description.zh`（本仓备份文件里改）。
5. `npm pack --dry-run` 核对包体积；`JSON.parse` 校验 json 合法。
6. 提交后推 main → 探针次日刷新；**简介变化要另提 awesome-dsh-plugin 的 PR**
   （展示信息不走探针刷新）。

### 7.2 什么时候必须提市场 PR

| 变化 | 走探针（推 main 即可） | 要提 PR |
|---|---|---|
| 版本号 / 下载量 | ✅ | |
| 卡片图（`screenshots.json` + `assets/`） | ✅ | |
| 简介 / 分类 / 名字 | | ✅ |

提 PR 前确认备份 yml 与目标一致（`packages/dsh-elab-cockpit/docs/dsh-market-submission/`）。

## 8. 主仓 GitHub Release（同步发布）

内核发版（打 `vX.Y.Z` tag）时，**GitHub Release 与 tag 一起发**，否则 tag 只是个指针，
用户点进去没有说明。插件单独发版**不发**主仓 Release。

### 8.1 Release 正文放仓库里，不临时现编

正文文件：**`docs/releases/vX.Y.Z.md`**（如 [v4.0.0.md](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/docs/releases/v4.0.0.md)），
入库、跟着版本走、可回溯。发布时直接把它当 body。

正文按这五块写（现成范例见 `docs/releases/v4.0.0.md`）：

1. **这是什么** —— 一句话定位 + 本版是主仓大版本还是插件版；
2. **本版要点** —— 按能力面分节，每节 3–6 条，动词开头（"新增…/支持…/迁移为…"），
   写**做了什么**而不是改了哪个文件；
3. **安装** —— 可直接复制的命令（npm / git clone / bootstrap）；
4. **升级注意** —— 破坏性变更、兼容下限、迁移提示（用户最需要的一段，别省）；
5. **验证状态** —— 门禁结果表 + 实机验证过的机型。

插件侧变更合并成正文里的一节（标注 `DSH 插件 x.y.z`），
**不要**在主仓 Release 里贴插件的完整 CHANGELOG 条目。

### 8.2 发布顺序

```bash
git push origin main                                  # ① 先推 main
# ② 等 CI 绿（badge: .../plugin.yml/badge.svg?branch=main&cb=<随机数>）
git tag -a v4.0.0 -m "elab-Flow v4.0.0"              # ③ 绿了再打 tag
git push origin v4.0.0                               # ④ 推 tag
gh release create v4.0.0 --title "elab-Flow v4.0.0" \
  --notes-file docs/releases/v4.0.0.md                # ⑤ 发 Release（挂在已有 tag 上）
```

- **顺序不变**：先 main、再 tag、最后 Release。反过来会让 tag 自带红灯。
- Release 必须**挂在已推送的 tag 上**（`gh release create vX.Y.Z`），不要让 GitHub 自动新建 tag ——
  自动建的 tag 可能指向错误的提交。
- 用 `--notes-file` 而不是 `--notes`（正文长，命令行转义容易出错）。

### 8.3 没有 gh CLI / 网络不通时

本机**无 `gh` CLI**，且 GitHub 网页与 `api.github.com` 在直连下常不可达（需代理）。
这种情况**只备料不发布**：把 `docs/releases/vX.Y.Z.md` 写好入库、tag 打本地，
等网络可用再执行 §8.2 的 ③④⑤ 步。**不要**为了发 Release 去动远端的其它状态。

发 Release 属于**发布动作**，不是「改文件」——用户说「先不推送」时，
只做到「物料备好 + tag 打本地」为止，push / publish / release 一律等明确指令。

### 8.4 发布后核对（Release 专属）

| 项 | 怎么查 |
|---|---|
| tag 存在且指向正确提交 | `git ls-remote --tags origin v4.0.0`（`^{}` 行才是提交） |
| Release 存在 | `https://github.com/xkk6663/elab-flow/releases/tag/v4.0.0` |
| Release 正文对得上 | 打开页面看首屏与「安装」段 |
| 市场卡片图已换 | `https://awesome-dsh-plugin.com/p/xkk6663/elab-flow--packages-dsh-elab-cockpit/`（探针有延迟；简介要等 PR 合） |

## 9. 发布后核对

| 项 | 命令 / 来源 |
|---|---|
| CI（main） | `https://github.com/xkk6663/elab-flow/actions/workflows/plugin.yml/badge.svg?branch=main`（**不需要 token、不限流**，注意缓存，加 `&cb=<随机数>`） |
| 主仓 tag | 仅内核发版需要：`git ls-remote --tags origin v3.0.0`（`^{}` 行才是提交） |
| npm | `npm view dsh-elab-cockpit version dist-tags` |
| 市场 | `awesome-dsh-plugin.com/p/xkk6663/elab-flow--packages-dsh-elab-cockpit/`（探针有延迟） |
| 面板 | DSH 里面板标题旁版本 / `GET /api/capabilities` 的 `cockpit.version` |

- **GitHub REST API 未认证时限流（60 次/小时，共享出口 IP 很容易 403）**：核对优先用
  badge，查 `actions/runs` 留给需要查看失败日志时。

## 10. 回滚

- 主仓：`git revert <commit>`；若内核版本已对外发布，再打新的 `v*` tag。**不要**强推 main。
- npm：只能发更高版本修，或用 `dist-tag` 把 `latest` 指回旧版本。
- 插件降级：用户侧固定旧版本安装；内核 `COCKPIT_VERSION` 与插件 `MIN_KERNEL_VERSION`
  决定兼容提示。

## 11. 纪律

- 业务层（`services/elab/**`、`cockpit/server.py`）与工具层（`packages/dsh-elab-cockpit/**`）
  不跨层 import；插件只走 loopback HTTP ICD。
- 芯片知识只写 `packs/**`；改包后 `elab pkg index` 重生成 `market/index.json`。
- 改 `cockpit/server.py` 后，本仓与用户的 elab 工作检出**两份都要同步**。
- **发版是发布，改文件是改文件**：用户说「先不推送 / 代理没开」时，只做到
  「版本号落地 + 物料备好 + 本地提交」，`push` / `npm publish` / `gh release create`
  一律等明确指令（见 §8.3）。
