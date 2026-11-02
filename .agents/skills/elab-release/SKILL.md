---
name: elab-release
description: elab-Flow 主仓与 dsh-elab-cockpit 插件的版本更新、发版与维护流程：版本落点、门禁、双标签、镜像仓强推、npm 发布、dsh-market 刷新与回滚。触发：用户说要发版 / 版本更新 / 升级版本 / 打 tag / 推镜像 / npm publish / 发布插件 / 市场更新。
---

# elab-Flow 版本更新与发布

两个版本号**彼此独立**：内核（主仓）用 `vX.Y.Z`，插件用 `plugin-vA.B.C` / npm 版本。

## 1. 版本落点（改哪里）

| 对象 | 位置 | 说明 |
|---|---|---|
| 内核版本 | [cockpit/server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py) `COCKPIT_VERSION` | 面板/`capabilities` 上报的版本 |
| 内核包版本 | [services/elab/__init__.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/__init__.py) `__version__` | 与上一处保持一致 |
| 插件版本 | `packages/dsh-elab-cockpit/package.json` | 用 `npm version X --no-git-tag-version`（同步 lockfile） |
| 插件默认内核 | `src/domain/envpack.ts` `DEFAULT_KERNEL_VERSION` | 跟随内核版本；UI 与宿主半共用 |
| 最低内核 | `src/domain/bootstrap.ts` `MIN_KERNEL_VERSION` | **兼容下限，不随内核升级**（仅提示、不阻断） |
| 变更日志 | `CHANGELOG.md` | 两条独立条目：`[Vx.y.z]` 与 `[DSH 插件 a.b.c]` |
| 文档事实 | `docs/architecture/架构分析和项目仓库的依赖关系.md` §11 | 插件版本 / 镜像 / npm / 市场快照 |
| 版本引用 | `README.md`（`@0.4.x` 之类）、`screenshots.json` | 搜 `0\.3\.` / `2\.1\.0` 清残留 |

> 历史 tag（`v2.1.0`、`plugin-v0.3.2`）**不移动、不复用**；新版本永远新 tag。

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
npm run build                                   # tsc + client bundle + 契约校验

# 内核
python tests/test_serialwidgets.py -v           # unittest（仓库未装 pytest）
.\elab.cmd doctor                               # 环境体检
```

- `npm test` 里 `/elab/host` 会话 cwd 用例会被 `~/.dsh/dsh-elab-cockpit.config.json` 的
  `elabRoot` 干扰 → 用空 `USERPROFILE` 跑。
- `elab doctor` 报 `proj.at32_* 未知芯片` 是本机未装 `artery/at32` 适配包，**不是代码缺陷**。
- 插件 `npm run build` 结束时会打印 `PASS: client.js 满足宿主 ModuleLoader 契约` 与 5 个槽位。

## 4. 提交与双标签

```powershell
git add <具体路径>            # 不要 git add -A
git commit -m "release(v3.0.0): ... （插件 0.4.0）"
git tag -a v3.0.0 -m "elab-Flow v3.0.0"
git tag -a plugin-v0.4.0 -m "dsh-elab-cockpit 0.4.0"
git push origin main
git push origin v3.0.0 plugin-v0.4.0
```

- `v*` tag → 内核发布；`plugin-v*` tag → 触发 `.github/workflows/publish-plugin.yml`。
- tag 一旦推送就不再移动；修问题发下一个版本。

## 5. 镜像仓（只读）

自动：`plugin-v*` tag → CI `git subtree split --prefix=packages/dsh-elab-cockpit`
→ `git push --force` 到 `xkk6663/dsh-elab-cockpit:main`（需 secret `PLUGIN_MIRROR_TOKEN`）。

手动（CI 无 secret / 本机代发）：

```powershell
.\scripts\mirror-plugin.ps1            # 等价逻辑
.\scripts\mirror-plugin.ps1 -DryRun    # 只切子树不推送
```

排障：

- 脚本要求**插件子树已提交**（dirty 直接退出）。
- CI 403 多半是 `PLUGIN_MIRROR_TOKEN` 缺失或 PAT 无镜像仓 `contents:write`。
- 镜像仓**禁止手工提交**，下次发布会被强推覆盖。

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
- 因此常规发版**不需要**改市场条目：推镜像 + npm 后等探针即可。
- 只有分类 / 简介 / 名字这类展示信息变化时才提 PR；投稿备份在
  `packages/dsh-elab-cockpit/docs/dsh-market-submission/`。
- 截图来源：插件根 `screenshots.json`（路径相对包根），新图必须同时进 `assets/`。

## 8. 发布后核对

| 项 | 命令 / 来源 |
|---|---|
| 主仓 tag | `git ls-remote --tags origin v3.0.0` |
| 镜像版本 | GitHub API `xkk6663/dsh-elab-cockpit/contents/package.json` |
| npm | `npm view dsh-elab-cockpit version dist-tags` |
| 市场 | `awesome-dsh-plugin.com/p/xkk6663/elab-flow--packages-dsh-elab-cockpit/`（探针有延迟） |
| 面板 | DSH 里面板标题旁版本 / `GET /api/capabilities` 的 `cockpit.version` |

## 9. 回滚

- 主仓：`git revert <commit>` + 新 tag；**不要**强推 main。
- 镜像：`scripts/mirror-plugin.ps1` 指向旧提交（脚本按当前 HEAD 切子树，回滚需先 revert）。
- npm：只能发更高版本修，或用 `dist-tag` 把 `latest` 指回旧版本。
- 插件降级：用户侧固定旧版本安装；内核 `COCKPIT_VERSION` 与插件 `MIN_KERNEL_VERSION`
  决定兼容提示。

## 10. 纪律

- 业务层（`services/elab/**`、`cockpit/server.py`）与工具层（`packages/dsh-elab-cockpit/**`）
  不跨层 import；插件只走 loopback HTTP ICD。
- 芯片知识只写 `packs/**`；改包后 `elab pkg index` 重生成 `market/index.json`。
- 改 `cockpit/server.py` 后，本仓与用户的 elab 工作检出**两份都要同步**。
