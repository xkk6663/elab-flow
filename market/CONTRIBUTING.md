# 适配包贡献指南

本仓（elab-Flow）只维护**内置包** `packs/official/**` 与市场索引 `market/index.json`。
社区适配包一律放在**作者自己的 GitHub 仓库**，由机器人定时发现并生成索引上架 ——
**没有 PR、没有人工审核**。这份指南是贡献者的操作说明，也是机器准入规则的公开版。

> 一句话原则：**适配包是数据，不是代码**。贡献者不需要改内核，也不需要懂闭环实现 ——
> 只需要把一颗芯片的事实（参数 / 厂商指纹 / 平台坑位）按 schema 写对。

## 1. 包结构

```
<your-repo>/                     # 独立仓库（不得放进本仓 packs/official/**）
├── .gitattributes               # 必须：* -text（见 §5）
├── README.md                    # 包说明：支持哪些芯片、来源、已知坑位、验证到什么程度
├── LICENSE                      # 必须与 pack.yaml 的 license 一致
├── pack.yaml                    # 清单（schema_version: 1）
└── chips/
    ├── <chip-id>.yaml           # 每颗芯片一份
    └── ...
```

`pack.yaml`（最小可用）：

```yaml
schema_version: 1
name: acme/acme32            # vendor/platform，小写，全局唯一
vendor: acme
platform: acme32
version: 0.1.0               # 语义化；改内容必升
license: MIT
status: community            # 社区包用 community；official 仅维护者
description: ACME32 芯片适配包（工程指纹 + 芯片参数 + 平台坑位）

requires:
  kernel_api: ">=1 <2"       # 与当前内核自描述 API 版本握手
  schema_version: 1

vendor_fingerprints:         # 供 `elab adapt` 确定性探测（可选但强烈建议）
  - generator: <生成器名>
    gen_dir: <cmake 子目录>
    syms_var: <编译宏变量>
    project_glob: "*.<工程文件后缀>"
```

`chips/<id>.yaml` 至少包含：`id / vendor / platform / part / core / memory`；
建议同时给出 `debug`（openocd target）、`verify`、`pitfalls` / `ota_layout`（如适用）。
字段定义以本仓 `packs/official/st/stm32/chips/*.yaml` 为模板，**只写数据**，不写脚本。

## 2. 硬规则（机器准入逐条校验，不通过即不上架）

1. **相互独立**：包不得 `import`、`source`、`include` 或依赖另一个包；跨包能力走
   `pack.yaml` schema 或市场索引。
2. **与开发框架无关**：只描述芯片事实；不绑定 IDE、构建系统或厂商 SDK 的某个版本。
3. **芯片知识唯一宿主**：不得把芯片知识写进 `services/elab/**`、`cockpit/**` 或
   本仓 `packs/official/**`（除维护者）。
4. **无脚本 / 无二进制**：`.exe .dll .so .a .lib .o .bin .hex .elf .py .js .ts .sh
   .bat .ps1 …` 一律拒绝（安装时结构化审计）。C 源码（`.c/.h`）允许：它是可审阅源码，
   由用户自己的工具链现场编译。
5. **`requires` 必须诚实**：声明的 `kernel_api` 区间要真的覆盖你验证过的内核版本。
6. **一次只启用一套**：同一个厂商/平台不要拆成"必须同时装"的多个包。

## 3. 先本地跑通，再上架

```bash
# ① 用确定性探测帮你把事实填对（强烈建议：不要手抄寄存器）
./elab adapt /path/to/vendor-project --probe

# ② 装本地包（不校验哈希，便于迭代）
./elab pkg install ./my-pack --from ./my-pack

# ③ 校验结构/安全/内容哈希，并记下 sha256
./elab pkg verify acme/acme32

# ④ 真跑一遍闭环（至少 build；有硬件跑 triple）
./elab doctor -p <project> --deep
./elab build  -p <project>
./elab triple -p <project>      # 有探针时
```

`verify` 通过的判定：结构合法、没有禁用文件、`tree_hash` 与 `.installed.json` 一致。

**你不需要提供 sha256**：市场索引里的哈希由机器人在上架时用 `tree_hash` 亲自计算，
作者自报的数字不会被采用（也无法伪造 —— 安装时内核仍会强校验）。

## 4. 上架流程（零服务器）

1. 把包推到**独立 GitHub 仓库**（建议命名 `elab-pack-<vendor>-<platform>`），
   并带上 `.gitattributes`（§5）。
2. 给仓库加 topic **`elab-pack`**：仓库首页 → About 右侧 ⚙ → Topics →
   输入 `elab-pack` 保存。（仓库名里含 `elab-pack` 也会被搜到，但 topic 是正式
   上架标记，建议务必打上。）
3. （可选）打 tag `v0.1.0`。有语义化 tag 时索引固定到该 tag；没有 tag 时固定到
   **默认分支的 commit SHA** —— 两种情况都可复现，且 `sha256` 由机器人计算。

到此为止。市场仓 <https://github.com/xkk6663/elab-pack-market> 的 GitHub Actions
每小时自动执行：

```
GitHub 搜索发现（topic + 仓库名两条查询合并去重）
  → 逐仓 clone 到固定 ref
  → 机器校验（schema / 安全审计 / .gitattributes / 兼容性）
  → 机器人用 tree_hash 重算 sha256
  → 写入 index.json（有变化才提交）
```

一条命令都不需要你敲，也没有 PR / 评审 / 合并环节。**上架结果 = 校验结果**。

索引条目形如（机器生成，仅供排查参考）：

```json
{
  "name": "acme/acme32",
  "vendor": "acme",
  "platform": "acme32",
  "version": "0.1.0",
  "description": "ACME32 芯片适配包",
  "status": "community",
  "license": "MIT",
  "requires": { "kernel_api": ">=1 <2", "schema_version": 1 },
  "chips": ["acme/acme32x"],
  "source": { "type": "git", "url": "https://github.com/<you>/elab-pack-acme-acme32.git", "ref": "v0.1.0" },
  "sha256": "<机器人计算>"
}
```

`status` 恒为 `community`：`official` 只保留给随本仓分发的 `packs/official/**`，
作者无法自称官方。外置包同样支持 `"type": "archive"`（zip/tar.gz 直链）与
`subdir`（仓内子目录），但自动发现只认 git 仓库。

## 5. `.gitattributes`（必须）

内容哈希按**字节**计算，Windows/macOS 的换行转换会让 `sha256` 对不上。每个外置包
仓库根必须带：

```
* -text
```

否则贡献者本机 `verify` 通过、别人 `install` 失败，而且错误看起来像"哈希被篡改"。

## 6. 版本与更新

| 动作 | 要求 |
|---|---|
| 改芯片参数 / 指纹 / 坑位 | 升 `version`（建议同时打新 tag；`sha256` 由机器人重算） |
| 只改 README | 不必升版本（索引不记 README） |
| 修安全/兼容问题 | 升版本并在仓库 README/Release 说明影响面（哪些芯片受影响） |
| 下架 | 删掉仓库的 `elab-pack` topic（或归档仓库），下一轮自动移除；已装用户本地副本不受影响（`elab pkg remove`） |
| 紧急封禁 | 恶意包可让维护者在索引仓的 `blocklist.json` 加一行仓库地址（不属常规流程） |

同版本重装需要 `--force`；面板上对应「更新」按钮。

## 7. 机器准入清单（每轮自动执行，无需任何人审）

| # | 检查 | 不通过的结果 |
|---|---|---|
| 1 | `pack.yaml`：`schema_version=1`、必填字段齐全、`name=vendor/platform` 一致、semver 版本 | 跳过该仓库 |
| 2 | `requires.kernel_api` / `schema_version` 与当前内核握手 | 跳过（并注明要求的区间） |
| 3 | 安全审计：无脚本 / 无预编译二进制 / 无符号链接（`pkg.audit_dir`） | 跳过并列出命中文件 |
| 4 | 包内至少一颗 `chips/**/*.yaml`，且芯片 `vendor` 与包一致 | 跳过 |
| 5 | `.gitattributes` 含 `* -text` | 跳过 |
| 6 | 内容哈希由机器人用 `pkg.tree_hash` 重算（作者自报值一律忽略） | — |
| 7 | 同名包只保留版本最高者（其余记入报告） | 被取代者不上架 |

每一项的判定结果都写在市场仓 Actions 的 `report.json` 产物里（谁被拒、为什么被拒），
排查时看那一份即可 —— 这也是"无人工审核"能成立的前提：**规则公开、结果可查**。

## 8. 官方包（`status: official`）

由本仓维护者维护，源码在 `packs/official/**`，安装走 `elab pkg bootstrap` 或面板
「本机官方源」（离线）。当前内置：`st/stm32`。官方包同样遵守上述全部规则 ——
**它对格式是最好的自吃狗粮**；新增官方包也要走 `elab pkg index --check` 门禁。

官方包**不进**自动市场索引（它们随骨架分发，本来就离线可用），因此市场里也不会
出现 `status: official` 的条目。

## 9. 常见问题

- **安装报"内容哈希漂移"**：多半是换行（`.gitattributes` 缺失）或有人改了包没升版本。
- **`elab pkg search` 搜不到**：先确认仓库已打 `elab-pack` topic；索引每小时刷新，
  最长等 1 小时。远程索引还有 5 分钟内存缓存；文件不可达时会回退本仓
  `market/index.json`（只含内置包）。
- **怎么知道为什么没上架**：看 <https://github.com/xkk6663/elab-pack-market> 的
  Actions 运行记录，`report.json` 会给出具体拒绝原因。
- **面板市场页签报"市场索引读取失败"**：网络问题；已装/启用/卸载不依赖网络。
- **想同时保留多套芯片包**：直接装多套，`elab pkg activate <name>` 切换即可 ——
  一次只启用一套，但本地可以存很多套。
