# 芯片适配包市场（market）

**一切芯片差异皆包**：内核（`services/elab`）不认识任何厂商，芯片参数、厂商指纹、
平台坑位全部来自适配包（`pack.yaml` + `chips/*.yaml`）。本目录只放**市场索引**，
不放包内容 —— 包留在作者自己的仓库，索引只记录元数据与内容哈希。

- 市场索引：`market/index.json`（本仓离线兜底 + 生成/校验的单一入口）
- 远程市场索引：<https://github.com/xkk6663/elab-pack-market>
  （`elab.host.yaml: packs.market` 指向它的 raw URL；不可达时自动回退本仓索引）。
  **该仓由 GitHub Actions 每小时自动生成**：作者仓库打上 `elab-pack` topic 即自动
  上架，没有 PR、没有人工审核（见下文「自动维护」）
- 外置包示例：<https://github.com/xkk6663/elab-pack-artery-at32>

## 设计约束（与本仓分层规则一致）

| 约束 | 含义 |
|---|---|
| **零服务器** | 市场 = 一份 `index.json` + 作者仓库里的包；没有注册中心、没有数据库 |
| **包相互独立** | 包不得 `import` 或依赖另一个包；跨包共享能力走 `pack.yaml` 协议或索引 |
| **与开发框架无关** | 包只描述芯片事实（参数/指纹/坑位），不绑定 IDE、构建系统或厂商 SDK 版本 |
| **按需使用** | `packs/official/**` 只是**源**；装到 `packs/installed/<name>/` 才生效 |
| **一次只启用一套** | `packs/installed/active.json` 记住当前启用的包；`Config.chips` 只读它 |
| **本地可存多套** | 其余已装包保留在本地，切换只改 `active.json`（不重装、不联网） |
| **打开即用** | 安装完成即重生成平台 skill；面板/agent 立刻能看到新芯片 |
| **芯片知识只写包** | 不得写进 `services/elab/**` 或 `cockpit/**`，内核不为任何厂商开分支 |

安装/卸载/启用期间，内核会**冻结闭环**（`POST /api/run` 返回 409），避免半装状态下
读到半成品芯片数据。

## 索引格式（`index.json`，schema_version = 1）

```json
{
  "schema_version": 1,
  "packs": [
    {
      "name": "artery/at32",
      "vendor": "artery",
      "platform": "at32",
      "version": "0.1.0",
      "description": "AT32F421 芯片适配包",
      "status": "official",
      "license": "MIT",
      "requires": { "kernel_api": ">=1 <2", "schema_version": 1 },
      "chips": ["artery/at32f421g8"],
      "source": {
        "type": "git",
        "url": "https://github.com/xkk6663/elab-pack-artery-at32.git",
        "ref": "main"
      },
      "sha256": "605d71e2…"
    }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | `vendor/platform`，小写、`[a-z0-9._-]`，全局唯一 |
| `version` | ✅ | 语义化版本 `x.y.z`（改包内容必须升版本） |
| `status` | ✅ | `official`（官方维护）/ `community`（社区贡献） |
| `license` | ✅ | SPDX 标识（如 `MIT`） |
| `requires` | ✅ | `kernel_api`（`>=1 <2` 这类区间）+ `schema_version`；不满足时安装 fail-fast |
| `chips` | ✅ | 包内 `chips/*.yaml` 的 `vendor/id` 清单（界面/搜索用） |
| `source.type` | ✅ | `local`（本仓 `packs/official`，仅随仓索引用）/ `git` / `archive` |
| `source.path` | local | 相对索引 `_base` 的目录（本仓索引的基准是**仓库根**） |
| `source.url` / `ref` / `subdir` | git | 仓库 URL、分支/tag、仓内包子目录（缺省 = 根） |
| `source.url` | archive | zip / tar.gz 的直链 |
| `sha256` | ✅ | **整包内容哈希**（按字节），安装时强校验；不一致即拒绝 |

`source.type=local` 只用于本仓 `packs/official/**`（索引基准 = 仓库根）。
远程索引（GitHub raw）里的 `local` 条目无法解析 —— 外置包必须是 `git` / `archive`。

## 安装通道

| 通道 | 命令 | 说明 |
|---|---|---|
| 内置包（离线） | `./elab pkg bootstrap` / 面板「本机官方源」 | 装 `packs/official/**` 全部官方包（当前为 `st/stm32`） |
| 市场搜索 | `./elab pkg search at32` | 读索引，按名称/厂商/平台/芯片/描述匹配 |
| 市场安装 | `./elab pkg install artery/at32` | 来源与 `sha256` 由内核从索引解析，**只收包名** |
| 本地开发 | `./elab pkg install ./my-pack --from ./my-pack` | 自测自己的包（不校验哈希） |
| git 直装 | `./elab pkg install --git <url> [--ref main] [--subdir <path>]` | 作者仓库直装 |
| 压缩包 | `./elab pkg install --archive <url>` | 离线分发 |

装完 / 启用后：

```bash
./elab pkg list                 # 看已装包与「启用」标记
./elab pkg activate artery/at32 # 切换启用的包（其余保留在本地）
./elab pkg verify               # 逐包校验结构/安全/内容哈希
./elab pkg update               # 按索引升级（同版本需 --force）
```

## 驾驶舱 / DSH 面板

DSH 驾驶舱面板右上角 **⚙** 进入设置视图（整幅覆盖侧边栏）：

- **市场**：输入名称即搜（`GET /api/packs?market=1&q=`），点「安装」走异步 job
  （202 + 500ms 轮询 `/api/pkg/job`），安装期间闭环冻结；
- **已安装**：启用 / 校验 / 更新 / 卸载；
- **内核设置**：宿主配置（仓库根、python、回收秒数、发现深度）。

同一能力对 agent 暴露为工具 `elab_pkg`（status / search / install / activate /
remove / update / verify），agent 可自行安装（安装不要求 `allowAgentWrite`）。

## 自动维护（无人工审核）

市场仓 `xkk6663/elab-pack-market` 的 `.github/workflows/index.yml` 每小时（cron）
及手动触发时执行：

```bash
python -m elab pkg index --remote --out index.json --report report.json
```

流程：GitHub 搜索发现（`topic:elab-pack` + 仓库名含 `elab-pack` 两条查询合并去重）
→ 逐仓 clone 到固定 ref（最高 semver tag；无 tag 用默认分支 commit SHA）
→ 机器校验（`pack.yaml` schema / `requires` 握手 / 安全审计 / `.gitattributes`）
→ 机器人用 `tree_hash` 重算 `sha256` → 有变化才提交（bot 身份，无人工合并）。

- **准入 = 机器校验**，规则见 [CONTRIBUTING.md](CONTRIBUTING.md) §7；不合格仓库只是
  跳过并写进 `report.json`，不影响其他包上架。
- **紧急刹车**：索引仓根目录可选 `blocklist.json`（`{"repos": ["<url>", "owner/repo"]}`），
  命中的仓库直接跳过 —— 仅用于恶意包，不属常规审核流程。
- 本机跑同一套逻辑：`./elab pkg index --remote --out index.json --report report.json`
  （`GITHUB_TOKEN` 可选，配了额度更高）。

## 维护本仓索引

```bash
./elab pkg index                    # 重生成 market/index.json（本仓官方包自吃狗粮）
./elab pkg index --check            # 只校验：包内容与索引是否漂移（CI 同款）
```

- 改 `packs/official/**` 的**任何字节**（含换行）都会变 `sha256` → 必须重生成索引；
- 外置条目（`git`/`archive`）由作者仓库负责，不参与本仓 `--check` 比对；
- `.work/` 里的远程索引缓存只用于"网络不可达时回退"，不是事实源。

贡献新包（含上架流程、模板、评审清单）见 [CONTRIBUTING.md](CONTRIBUTING.md)。
