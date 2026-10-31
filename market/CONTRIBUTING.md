# 适配包贡献指南

本仓（elab-Flow）只维护**内置包** `packs/official/**` 与市场索引 `market/index.json`。
社区适配包一律放在**作者自己的 GitHub 仓库**，通过市场索引上架。这份指南是贡献者
和评审者的共同清单。

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

## 2. 硬规则（评审会逐条看）

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
**`sha256` 就来自这一步**（输出里的 `sha256` 字段），上架时原样填入索引。

## 4. 上架流程（零服务器）

1. 把包推到**独立 GitHub 仓库**（建议命名 `elab-pack-<vendor>-<platform>`）。
2. 打 tag（`v0.1.0`），用 tag 作为索引里的 `source.ref`（比 `main` 可复现）。
3. 在 <https://github.com/xkk6663/elab-pack-market> 提 PR，在 `index.json` 增加条目：

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
  "sha256": "<第 3 步 verify 的 sha256>"
}
```

4. PR 里附：仓库地址、验证过的内核版本、`doctor --deep` / `build`（有硬件再加
   `triple`）的输出摘要、已知坑位。
5. CI 会拉包安装并做 schema 校验 + `sha256` 强校验；通过后合入，`elab pkg search`
   即可搜到。

外置包也支持 `"type": "archive"`（zip/tar.gz 直链）与 `subdir`（仓内子目录）。

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
| 改芯片参数 / 指纹 / 坑位 | 升 `version` + 重新算 `sha256` + 新 tag |
| 只改 README | 不必升版本（索引不记 README） |
| 修安全/兼容问题 | 升版本并在 PR 说明影响面（哪些芯片受影响） |
| 下架 | 在索引 PR 里删条目；已装用户本地副本不受影响（可用 `elab pkg remove`） |

同版本重装需要 `--force`；面板上对应「更新」按钮。

## 7. 评审清单（维护者用）

- [ ] `name` / `vendor` / `platform` / `version` 合法且唯一
- [ ] `license` 与仓库 LICENSE 一致
- [ ] `requires.kernel_api` 覆盖实测内核版本
- [ ] `chips` 与 `chips/*.yaml` 实际文件一一对应
- [ ] 无禁用扩展名文件；无网络/子进程调用
- [ ] `.gitattributes` 含 `* -text`
- [ ] `sha256` 与 tag 内容一致（CI 会复核）
- [ ] 包不依赖其他包；芯片知识与本仓内核无关
- [ ] 起码 `build` 级验证有输出证据（有硬件建议 `triple`）

## 8. 官方包（`status: official`）

由本仓维护者维护，源码在 `packs/official/**`，安装走 `elab pkg bootstrap` 或面板
「本机官方源」（离线）。当前内置：`st/stm32`。官方包同样遵守上述全部规则 ——
**它对格式是最好的自吃狗粮**；新增官方包也要走 `elab pkg index --check` 门禁。

## 9. 常见问题

- **安装报"内容哈希漂移"**：多半是换行（`.gitattributes` 缺失）或有人改了包没升版本。
- **`elab pkg search` 搜不到**：远程索引 5 分钟内存缓存；等 TTL 或重启驾驶舱。索引
  文件不可达时会回退本仓 `market/index.json`（只含内置包）。
- **面板市场页签报"市场索引读取失败"**：网络问题；已装/启用/卸载不依赖网络。
- **想同时保留多套芯片包**：直接装多套，`elab pkg activate <name>` 切换即可 ——
  一次只启用一套，但本地可以存很多套。
