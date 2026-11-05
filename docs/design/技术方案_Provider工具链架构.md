# 技术方案：Provider 工具链架构（P1/P2 已实现）

> 状态：**P1/P2 已实现并在 ESP32-S31-Korvo 实机闭环通过**（2026-11-04）。
> P3（外带 GDB-MI 调试）按 §1.2 非目标继续搁置。
> 上游文档：[技术方案_ESP32接入与工具链解耦](技术方案_ESP32接入与工具链解耦.md) §3/附录 B、
> [技术方案_闭环驾驶舱](技术方案_闭环驾驶舱.md)、[ICD_cockpit_events](ICD_cockpit_events.md)。
> 本文是 Provider 阶段的**可执行蓝本**：契约、解析算法、文件级改动、验收命令、分期与回滚。

---

## 0. 决策记录（已拍板）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **provider 不塞进芯片包**，走独立的 `provider.yaml` 数据包与独立市场条目 | 芯片知识与工具链知识解耦；包协议本来就禁止可执行内容 |
| D2 | **允许默认链与外带链混用，但必须显式**（项目 YAML 或单步绑定） | 不搞隐式猜测；预览能解释每一步来自谁 |
| D3 | **provider 缺某步骤 → 该步骤报错/不可用，不回退原生链** | 避免“一半 IDF、一半 ARM”的隐性混搭 |
| D4 | **`ctx.provide()` 只给内核服务用**，provider 数据不通过它注入执行器 | provider 是声明式数据；执行器只接受不可变的 `ResolvedToolchain` |

补充边界（本轮同样拍板）：

- `monitor` **永远不可外包**：串口三态与 `serial/*` 事件是内核契约。
- 本轮**不做**代码 provider / 插件型 provider；provider 只能是纯数据。
- 本轮**不做** DAP/GDB-MI 外带调试；外带链的 `debug` 先只声明 `backend` 与 `features`。

---

## 1. 范围与非目标

### 1.1 范围

1. Provider manifest 契约（schema v1）。
2. Provider 注册、解析、绑定、版本匹配。
3. 默认链（内置 `NativeProvider`）与外带链（`DataProvider`）同构执行。
4. 产物契约（artifacts）泛化：内存占位、烧录参数不再写死。
5. 可用性（host/probe/serial）与 doctor/面板派生字段。
6. 分发：独立市场条目、安装落点、版本锁定、可复现。
7. 模板命名空间与 fail-fast 规则。

### 1.2 非目标

- 不把 provider 变成可执行插件，不放宽 `pkg.py` 的 `_DENY_EXTS`。
- 不让 provider 定义新步骤、改写步骤语义、接管 `monitor`。
- 不在本轮实现外带 GDB/DAP 调试。
- 不改动现有事件契约；只增补可选字段。
- 不让内核出现任何 `if vendor == ...` 分支。

---

## 2. 角色分工（三层数据 + 一层执行）

| 角色 | 宿主 | 声明什么 | 不得做什么 |
|---|---|---|---|
| **芯片包 `pack.yaml`** | `packs/**` | 芯片参数、指纹、可选的 `provider_hint`（软提示） | 携带命令模板；依赖/导入 provider；含可执行文件 |
| **Provider `provider.yaml`** | `providers/installed/**` | 规范步骤的命令模板、env、产物、主机前提、调试后端 | 定义新步骤；接管 monitor；写工程文件；执行任意脚本 |
| **项目 `projects/*.yaml`** | `projects/**` | 绑定哪个 provider；哪些步骤本地覆盖；项目 own 的 root/serial | 重复 provider 公共 env（应由 provider `defaults` 承担） |
| **内核** | `services/elab/**` | 解析、materialize、执行、事件、产物解析、可用性 | 为厂商开分支；把 provider 数据当代码 import |

`provider_hint` 只是**软提示**：`adapt` 看到 `kind: idf` 指纹时，会把
`provider: espressif/idf@>=1 <2` 写进生成的项目 YAML。它不是依赖，不自动安装；
未安装时项目加载直接报“缺 provider”，不会静默回退。

---

## 3. 总体架构

```text
                       ┌──────────────────────────────┐
                       │  elab.host.yaml: providers.roots │
                       └───────────────┬──────────────┘
                                       │ 发现
   pack.yaml                           ▼
 vendor_fingerprints ──adapt──▶  ProviderRegistry
   provider_hint                  ├─ NativeProvider（内置，代码）
                                  └─ DataProvider（外带，provider.yaml）
                                       │ resolve(cfg, project)
                                       ▼
                              ResolvedToolchain（不可变）
                              ├─ provider: name@version / source
                              ├─ steps: {step → StepDecl}
                              ├─ artifacts: {elf/bin/map/flash_args}
                              ├─ debug: {backend, features}
                              └─ unavailable: [{step, code, message, hint}]
                                       │
                                       ▼
                                统一执行器（run.py）
                        kind=native → builder/flash/doctor/debug
                        kind=external → argv/cwd/env/timeout/materialize
                        kind=unavailable → fail-fast（不回落）
                                       │
                                       ▼
                          规范步骤名 + 既有事件契约（不变）
```

`--dry-run` 与真实执行**共享同一个 `ResolvedToolchain`**：
预览只是打印 materialize 结果，不允许另写一套拼命令逻辑。这是防漂移的硬约束。

---

## 4. Provider manifest 契约（schema v1）

### 4.1 文件与位置

```text
providers/installed/<vendor>/<name>/provider.yaml     # 安装落点（不入库）
tests/fixtures/providers/<vendor>/<name>/provider.yaml # 测试夹具
```

发现根：`elab.host.yaml: providers.roots`（默认 `${ELAB_ROOT}/providers/installed`，
可被测试/用户覆盖）；与 `packs.roots` 同构。

### 4.2 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema_version` | ✅ | 固定 `1` |
| `provider_api` | ✅ | 固定 `1`（与 `kernel_api` 区分：前者是 manifest 结构版本） |
| `name` | ✅ | `<vendor>/<toolchain>`，如 `espressif/idf` |
| `version` | ✅ | 严格 semver |
| `license` | ✅ | SPDX 标识 |
| `requires.kernel_api` | ✅ | 如 `">=1 <2"` |
| `requires.host` | 可选 | 主机前提检查列表 |
| `requires.probe` | 可选 | 默认 `false` |
| `requires.serial` | 可选 | 默认由步骤是否引用 `${serial_port}` 推导 |
| `defaults` | 可选 | 所有步骤共享的 `cwd/env/env_from_cmd/timeout_s` |
| `artifacts` | 可选 | 产物契约 |
| `steps` | ✅ | 规范步骤 → 命令声明；至少一个键 |
| `debug` | 可选 | `{backend, features}` |
| `toolchain` | 可选 | 安装引导（**纯展示，永不执行**）：`name` / `version` / `docs` / `install`（平台 → 命令列表）/ `host_keys` |
| `description` | 可选 | 人读描述 |

未知顶层键 → **加载失败**（防拼写错静默变成 no-op）。扩展字段统一用 `x-` 前缀。

`toolchain` 只被 `elab setup` 与装包后的自动自检读取：`requires.host` 缺失时把当前平台的
安装命令原文、文档链接和要回填的 `host_keys` 打印给用户；内核不执行这些命令、
不下载工具链、也不写 `elab.host.yaml`。

### 4.3 示例（ESP-IDF）

```yaml
schema_version: 1
provider_api: 1
name: espressif/idf
version: 1.2.0
license: Apache-2.0
description: ESP-IDF（EIM 安装；工具链路径由 host 层提供）

requires:
  kernel_api: ">=1 <2"
  host:
    - { key: tools.idf.python, check: file }
    - { key: tools.idf.idf_path, check: dir }
    - { key: tools.idf.tools_path, check: dir }
  probe: false
  serial: true

defaults:
  cwd: ${root}
  env:
    IDF_PATH: "${host:tools.idf.idf_path}"
    IDF_TOOLS_PATH: "${host:tools.idf.tools_path}"
    IDF_PYTHON_ENV_PATH: "${host:tools.idf.venv}"
    IDF_PY: "${host:tools.idf.python}"
    ESP_IDF_VERSION: "${host:tools.idf.version}"
  env_from_cmd:
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf_tools.py", "export", "--format", "key-value"]
    format: key-value
    path_key: PATH

artifacts:
  elf: ${work_dir}/${name}.elf
  bin: ${work_dir}/${name}.bin
  map: ${work_dir}/${name}.map
  flash_args: ${work_dir}/flasher_args.json

steps:
  doctor:
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py", "--version"]
    timeout_s: 120
  build:
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py", "-B", "build", "build"]
    timeout_s: 1800
  flash:
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py", "-B", "build", "-p", "${serial_port}", "flash"]
    timeout_s: 600
  debug_verify:
    cmd: ["${env:IDF_PY}", "-m", "esptool", "--chip", "${chip.flash_chip}",
          "--port", "${serial_port}", "--baud", "${project.serial.baud}",
          "verify-flash",
          "${json_args:${work_dir}/flasher_args.json#flash_files}"]
    timeout_s: 300

debug:
  backend: esp-idf
  features: [flash_verify]     # 明确：不是 GDB 调试
```

### 4.4 合并规则（`defaults` → `steps.<step>`）

- `env` / `env_from_cmd`：**键级合并**，step 覆盖 defaults。
- `cmd` / `cwd` / `timeout_s`：step 有值即覆盖，否则继承。
- `result`：step 级，不继承（标记解析是步骤特有的）。
- `artifacts`：provider 级；项目 YAML 的 `artifacts` 覆盖同名键（项目更具体）。
- 合并由内核完成（本仓 `_yaml.py` 不支持锚点/别名，禁止依赖 `&x/*x`）。

### 4.5 校验规则（加载时 fail-fast）

1. `steps` 的键 ∈ `run.ALL_STEPS - {"monitor", "doctor_deep"}`；`monitor`/`doctor_deep`
   出现即报错（前者是内核串口契约，后者依赖内核 configure 探测，只能由项目内联覆盖）。
2. 每个 `steps.<step>` 必须有非空 `cmd`（字符串按空格切分只允许作为兼容形态，
   新 provider 必须写列表）。
3. `timeout_s`：外部 `build/flash/debug_verify` 未显式声明时取默认
   `build=1800 / flash=600 / debug_verify=300`；`doctor=120`。**不接受 0/负数**。
4. 模板引用在 materialize 时校验；出现未知命名空间立即报错，不把 `${...}` 漏给子进程。
5. `requires.host[].check` ∈ `{file, dir, exe, nonempty}`。
6. `debug.backend` ∈ `{native, esp-idf}`（P3 再扩）。
7. `debug.features` ⊆ 内核已知能力集合（与 `DEBUG_META` 同源）。

---

## 5. 绑定与解析优先级

### 5.1 项目 YAML 新增字段

```yaml
provider: espressif/idf@>=1 <2     # 可选；缺省 = 内置 NativeProvider
steps:                             # 可选；单步显式覆盖
  build: tool:my_custom_build      # 现有语义，优先级最高
  # flash: tool:my_flash
```

版本范围子集：`>=`、`<`、`^`、精确版本。无法匹配 → 加载失败并列出已安装版本。

### 5.2 解析算法（确定性，可单测）

```python
def resolve(cfg, project) -> ResolvedToolchain:
    proj = cfg.resolved_project(project)
    ref = proj.get("provider")
    if ref:
        provider = registry.resolve_ref(ref)          # 缺失/版本不匹配 → RunError
        base = provider.resolve(cfg, proj)
    else:
        base = NativeProvider().resolve(cfg, proj)    # 内置默认链

    steps = {}
    for step in run.ALL_STEPS:
        spec = (proj.get("steps") or {}).get(step)
        if isinstance(spec, str) and spec.startswith(run.TOOL_PREFIX):
            steps[step] = inline_decl(step, spec, proj)        # 1) 项目内联覆盖
        elif spec is not None:
            raise RunError(f"steps.{step} 只接受 tool:<name>：{spec!r}")
        elif step == "monitor":
            steps[step] = StepDecl(kind="native", native="monitor")  # 内核保留
        elif step in base.steps:
            steps[step] = base.steps[step]                     # 2) provider 提供
        elif ref:
            steps[step] = StepDecl(kind="unavailable",
                                   reason=f"{ref} 未提供 steps.{step}")  # 3) 不回退
        else:
            steps[step] = native_decl(step)                    # 4) 无 provider → 原生

    artifacts = merge(proj.get("artifacts") or {}, base.artifacts)
    return ResolvedToolchain(provider=base.ref, steps=steps, artifacts=artifacts,
                             debug=base.debug, unavailable=base.unavailable)
```

优先级（高 → 低）：**项目 `steps.tool:` → provider `steps` → 无 provider 时的原生链**。

补充规则：

- `monitor` 即使项目写了 `steps.monitor: tool:x` 也在 `validate_delegation` 阶段报错
  （现有行为保留，双保险）。
- `doctor_deep` 不由 provider 提供：它依赖内核的 configure 探测；项目只可内联覆盖。
- 同一层出现两个绑定（例如两个 provider 同名）→ 注册表加载失败。

### 5.3 显式混用的合法写法

```yaml
# 外带 IDF 构建 + 内核原生 monitor（默认即如此）
provider: espressif/idf@>=1 <2

# 外带 IDF 构建 + 项目自己的烧录脚本（显式覆盖）
provider: espressif/idf@>=1 <2
steps:
  flash: tool:my_flash
```

禁止的写法：项目声明了 `provider` 但某步骤 provider 未提供，却期待自动用原生链。

---

## 6. 默认链：内置 `NativeProvider`

### 6.1 为什么默认链必须是代码

默认链需要内核状态：`.map` 解析、链接脚本/内存模型、SVD、GDB/MI 会话、
串口三态、guard 快照。这些**不是命令模板能表达的**。因此：

> 判定一条能力是否可外包的标准：**是否依赖内核状态**。
> 依赖 → 必须原生；只是“跑 CLI + 看退出码/标记” → 可以外带。

`NativeProvider` 只是把现有函数包成统一的 `StepDecl`，**不改变任何既有行为**。

### 6.2 数据结构

```python
@dataclass(frozen=True)
class ProviderRef:
    name: str                 # "espressif/idf" | "elab/native"
    version: str              # "1.2.0" | "builtin"
    source: str               # "builtin" | "provider"
    path: str = ""            # provider.yaml 路径（builtin 为空）

@dataclass(frozen=True)
class StepDecl:
    step: str
    kind: Literal["native", "external", "unavailable"]
    native: str = ""          # doctor / build / flash / debug_verify / monitor
    tool_name: str = ""       # external：项目内联 tools.<name> 或 provider steps.<step>
    cmd: tuple[str, ...] = ()
    cwd: str = ""
    env: Mapping[str, str] = field(default_factory=dict)
    env_from_cmd: Mapping = field(default_factory=dict)
    env_prepend_path: tuple[str, ...] = ()
    timeout_s: int = 0
    result: Mapping = field(default_factory=dict)
    reason: str = ""          # kind=unavailable 时

@dataclass(frozen=True)
class ResolvedToolchain:
    provider: ProviderRef
    steps: Mapping[str, StepDecl]
    artifacts: Mapping[str, str]
    debug: Mapping
    unavailable: tuple[dict, ...] = ()

class ToolchainProvider(Protocol):
    ref: ProviderRef
    def resolve(self, cfg, project) -> ResolvedToolchain: ...
```

### 6.3 原生步骤映射

| step | native 实现 | 说明 |
|---|---|---|
| `doctor` | `doctor_mod.run` | 主机/工具链/工程体检 |
| `doctor_deep` | `doctor_mod.run(deep=True)` | 只可由项目内联覆盖，不由 provider 提供 |
| `build` | `builder.build_project` | 原生 CMake/Arm GCC；构建后 `.map` 兜底 |
| `flash` | `flash_mod.flash` | 需要探针 |
| `debug_verify` | 现有调试校验 | 需要探针 |
| `monitor` | 内核串口 | **任何 provider 都不可提供** |

### 6.4 执行器改造点

`run._execute` 改为消费 `StepDecl`：

```python
decl = toolchain.steps[step]
if decl.kind == "native":
    return _execute_native(cfg, project, step, decl.native, sink)
if decl.kind == "external":
    out = _run_tool(cfg, project, decl, sink)       # 复用现有 _run_tool，入参改为 decl
    out.extra["provider"] = toolchain.provider.name
    out.extra["provider_version"] = toolchain.provider.version
    out.extra["delegated_to"] = f"{TOOL_PREFIX}{decl.tool_name}"  # 兼容旧字段
    return out
raise RunError(decl.reason)
```

`_run_tool` 的现有能力（env、env_from_cmd、timeout、preview、preflight）**全部保留**，
只把“从 `tools.<name>` 取字段”改成“从 `StepDecl` 取字段”。项目内联 `tools`
在解析阶段被翻译成 `StepDecl(kind="external")`，因此只有一条执行路径。

---

## 7. 模板与事实命名空间

| 命名空间 | 来源 | 允许的键 |
|---|---|---|
| 项目 | 已插值项目 | `${root}` `${work_dir}` `${name}` `${runs_dir}` `${serial_port}` |
| 主机 | `elab.host.yaml` | `${host:...}`（点路径或 Host 属性短名） |
| 环境 | provider/defaults + 进程 | `${env:NAME}` |
| 工程事实 | 内核白名单投影 | `${chip.flash_chip}` `${chip.target}` `${project.serial.baud}` |
| 构建事实 | 读 JSON | `${json_args:FILE#KEY}` |

规则：

1. 四个命名空间可嵌套（`${env}` ↔ `${host}`），解析到稳定为止。
2. 白名单之外的键 → materialize 失败，错误消息带出键名与来源文件。
3. provider 不允许直接读芯片 YAML 任意字段；需要新事实时，先在内核白名单增加键，
   并同步测试。这是“provider 不耦合芯片内部结构”的保证。
4. `${json_args:FILE#KEY}` 仅当**整个 argv 元素**时展开；file 相对 JSON 所在目录
   或绝对路径；映射按 offset 数值排序。

---

## 8. 产物契约与内存/烧录泛化

### 8.1 `artifacts`

| 键 | 用途 | 谁消费 |
|---|---|---|
| `elf` | 调试符号、反汇编、变量 | 调试工作区、doctor |
| `bin` | 烧录前存在性检查 | `build` 成功判据、UI |
| `map` | RAM/FLASH 占位 | 委托/原生 build 后统一解析 |
| `flash_args` | 偏移与产物对 | `${json_args}` 展开（可选声明） |

解析优先级：项目 `artifacts` > provider `artifacts` > 原生推导（`plan_for`）。
`build` 成功后统一：

```python
if decl.kind in ("native", "external") and ok:
    for key in ("bin", "elf"):
        if artifacts.get(key) and not Path(artifacts[key]).is_file():
            ok = False; detail = f"构建成功但产物缺失：{key}"
    if artifacts.get("map") and Path(artifacts["map"]).is_file():
        extra["memory"] = builder.parse_map_memory(artifacts["map"])
        extra["memory_source"] = "map"
```

这样 ESP-IDF、未来其他外带链、原生链的内存表来源完全一致。

### 8.2 `flash_args`

provider 可直接写：

```yaml
"${json_args:${work_dir}/flasher_args.json#flash_files}"
```

不要求 provider 自己解析 offset；由内核的 `_expand_json_args` 负责。
若 provider 想换键名（例如 `flash_files` 之外），只需换 `#KEY`。

---

## 9. 可用性与 doctor

### 9.1 `requires` 求值

| check | 语义 |
|---|---|
| `file` | 路径存在且是文件 |
| `dir` | 路径存在且是目录 |
| `exe` | 文件存在 + 可执行（Windows 看扩展名/`PATHEXT`） |
| `nonempty` | 字符串非空 |

`requires.probe=true` → 该项目必须有可用探针；`requires.serial=true` → 需要能选出串口。
求值结果：

```python
{"available": bool, "reasons": [{"code": "host.missing", "key": "tools.idf.python",
                                 "message": "...", "hint": "用 EIM 安装 ESP-IDF"}],
 "checked_at": "..."}
```

### 9.2 面板派生字段（`/api/projects` 每张卡片）

```json
{
  "provider": {"name": "espressif/idf", "version": "1.2.0", "source": "provider"},
  "provider_available": true,
  "provider_reasons": [],
  "steps": {
    "build": {"kind": "external", "available": true, "source": "espressif/idf"},
    "flash": {"kind": "external", "available": false,
              "reason": "串口不可用", "source": "espressif/idf"},
    "monitor": {"kind": "native", "available": true, "source": "kernel"}
  },
  "debug_features": ["session", "control", "...", "rtos"]
}
```

兼容性：保留现有 `debug_backend`、`delegated`；新增字段均为附加字段。

### 9.3 doctor 行为

- provider 已声明但未安装 → **失败**，给出安装命令与 `provider_hint` 来源。
- provider 版本不满足 → 失败，列出已安装版本。
- `requires.host` 不满足 → 失败（带 hint，不启动后续步骤）。
- `requires.probe` 不满足 → `flash/debug_verify` 不可用，`doctor` 本身可过。
- doctor **不执行** provider 的 `steps.doctor` 以外的命令；不因“检查”顺带跑 `build`。

---

## 10. 分发、注册表、版本与可复现

### 10.1 市场条目（`market/index.json`）

现有条目缺省 `kind: "pack"`（向后兼容）。新增：

```json
{
  "name": "espressif/idf",
  "kind": "provider",
  "version": "1.2.0",
  "license": "Apache-2.0",
  "source": {
    "type": "git",
    "url": "https://github.com/xkk6663/elab-provider-espressif-idf",
    "ref": "v1.2.0"
  },
  "sha256": "<安装器按内容回填>",
  "requires": {
    "kernel_api": ">=1 <2",
    "provider_api": 1,
    "host": ["tools.idf.python"]
  }
}
```

- `elab pkg index --check` 扩展为同时校验 provider 条目：`kind`、`provider_api`、sha256 格式。
- 外置仓库必须带 `.gitattributes`（`* -text`），内容哈希按字节计算。

### 10.2 安装与 CLI

P2 新增（复用 `market.py` / `pkg.py` 的下载与校验逻辑）：

```bash
elab provider list
elab provider search <kw>
elab provider install espressif/idf[@<range>]
elab provider remove espressif/idf
```

落点：`providers/installed/<vendor>/<name>/provider.yaml`，`installed.json` 记录来源与 sha256。
**安装不执行任何命令**；只有显式 `run` / `doctor` 才会拉起 provider 命令。

### 10.3 版本锁定（`elab.lock.yaml`，入项目组仓）

```yaml
# 建议放在工作区根，和 elab.host.yaml 同级
packs:
  espressif/esp32: 0.1.0
providers:
  espressif/idf: 1.2.0
host:
  idf_version: "6.1"
```

- `run/doctor` 校验实际安装版本与 lock 一致；不一致 → **warn**（不阻断），并打印差异。
- 团队协作/CI 可用 `elab doctor --strict-lock` 升级为失败。
- lock 的内容来自安装器回填，不靠人写。

### 10.4 与 `provider_hint` 的关系

`pack.yaml: vendor_fingerprints[].provider` 是可选字符串（只写 name，不写版本）。
`adapt` 规则：

1. 指纹命中且 provider 已安装 → 写 `provider: <name>@>=<当前 major> <next major>`。
2. 指纹命中但未安装 → 仍写 `provider:`（项目加载会明确报缺），并在适配报告里给安装提示。
3. 用户显式 `--no-provider` → 退回内联 `tools`（现状），不写 `provider:`。

---

## 11. 安全与执行边界

1. **只允许 argv，不解释 shell**；不做字符串拼接执行。
2. **env 白名单**：provider 只能设置 `env`/`env_from_cmd`/`env_prepend_path` 声明过的键；
   进程继承的基础环境不打印、不落盘敏感值。
3. **超时必须存在**：外部步骤均有上限；超时走 `_kill_tree`（Windows `taskkill /T /F`）。
4. **输出上限**：单行长度与累计输出有上限；超限截断并记事件，不撑爆内存/事件文件。
5. **预览可审计**：`elab run --dry-run --json` 必须显示 `provider.name/version/source` 与
   每一步的完整 argv、cwd、env 键集合、timeout。
6. **provider 不写工程**：唯一写工程文件的仍是 `adapt`，且只写 `projects/*.yaml`；
   guard 的 `untouched` 快照必须保持通过。
7. **信任模型**：provider 数据 = 可提案任意主机命令。安装源必须是市场 sha256 校验过的
   数据包；项目内联 `tool:` 与现状同信任级。**不做静默安装、不做静默执行**。

---

## 12. 调试与 `monitor` 边界

- `debug.backend`：P1/P2 允许 `native`（ARM GDB/MI）与 `esp-idf`（仅 `flash_verify`）。
- `debug.features` 与 P0-4 的收敛链合并：
  `snapshot.features ?? project.debug_features ?? provider.debug.features ?? DEBUG_META.features`。
- 外带 GDB-MI（P3）声明式字段草案：

```yaml
debug:
  backend: gdb-mi
  arch: riscv:rv32
  server:
    cmd: ["${host:openocd_esp32}", "-f", "board/esp32s3-builtin.cfg"]
    port_ready: { kind: line, pattern: "Listening on port .* for gdb connections" }
    timeout_s: 20
  gdb:
    cmd: ["${host:gdb_riscv}", "-q", "-iex", "target extended-remote :3333"]
```

- DAP（P3+）另文设计；本轮不承诺。
- `monitor`：provider 不可提供。若未来要支持“串口后端 provider”，它是**内核串口后端**
  的替换点，不属于工具链 provider；需单独立 RFC，且 `serial/*` 事件契约不变。

---

## 13. `ctx.provide()` 的边界（D4 的落地规则）

`ctx.provide(name, service)` 只允许**内核内部模块**调用，用于注册代码服务，例如：

| 服务名 | 提供者 | 消费者 |
|---|---|---|
| `kernel.events` | `kernel/events.py` | `run` / `server` |
| `kernel.runs` | 运行管理器 | `server` / 工具层 ICD |
| `kernel.serial` | 串口后端 | `monitor` |
| `kernel.providers` | ProviderRegistry | `run` / `server` / `doctor` |

禁止事项：

1. **禁止**把 `provider.yaml` 的 `steps` 通过 `ctx.provide()` 注册成可执行回调；
   执行器只接受 `ResolvedToolchain`。
2. **禁止** provider 数据引用内核对象、Python 路径或 `import`。
3. 未来如出现“代码 provider”，它属于 DSH 工具层插件（`packages/**`），通过独立的
   `toolchain` 扩展点注册；**不进芯片包市场**，且必须另行评审信任模型。本轮不做。

---

## 14. 文件级实施清单

### P1：加载器 + 同构执行（不碰市场）

| 文件 | 改动 | 验收 |
|---|---|---|
| `services/elab/provider.py`（新增） | `ProviderRef/StepDecl/ResolvedToolchain/ToolchainProvider`；`NativeProvider`、`DataProvider`、`ProviderRegistry.resolve(cfg, project)`；manifest 校验；`defaults` 合并 | 单测覆盖校验/合并/优先级 |
| `services/elab/run.py` | `_execute` 按 `StepDecl` 分派；`_run_tool` 入参改 `StepDecl`；`preview` 输出 provider 来源；保留 `delegated_to` 兼容字段 | 预览 argv 与现状逐字节一致 |
| `services/elab/config.py` | `providers.roots` 读取（与 `packs.roots` 同构）；项目 `provider` 字段保持原样 | host 覆盖生效 |
| `cockpit/server.py` | 项目卡片增 `provider` / `provider_available` / 每步 `kind/source/available` | 面板能显示 provider 与缺失原因 |
| `tests/fixtures/providers/espressif/idf/provider.yaml` | P1 测试数据 | 夹具可加载 |
| `tests/test_provider_manifest.py`（新增） | 必填/未知键/monitor 拒绝/超时默认 | 全绿 |
| `tests/test_provider_resolve.py`（新增） | 优先级矩阵、缺步骤报错、显式混用、版本范围 | 全绿 |
| `tests/test_delegated_steps.py` | 增“provider 与内联等价”用例 | 全绿 |

P1 完成判据：

1. 现有全部内联 `tool:` 项目行为不变（`test_delegated_steps` 不改断言即过）。
2. ESP32 夹具 provider 的 `build/flash/debug_verify` 与当前项目 YAML
   `--dry-run --json` 的 argv、cwd、env 键集合**完全一致**。
3. `monitor` 无法被 provider 提供（负例测试）。
4. provider 缺步骤时 `--dry-run` 直接失败并给出 step 名。

### P2：分发与可复现

| 文件 | 改动 |
|---|---|
| `services/elab/market.py` | 识别 `kind: provider`；搜索/过滤；版本范围解析 |
| `services/elab/pkg.py` 或 `provider_install.py` | 下载、sha256 校验、落盘 `providers/installed/**`、`installed.json` |
| `services/elab/__main__.py` | `elab provider list/search/install/remove` |
| `services/elab/adapt.py` | 读取 `provider_hint`，写 `provider:`；`--no-provider` 退回内联 |
| `market/index.json` | 新增 provider 条目；`elab pkg index --check` 扩展校验 |
| `services/elab/lock.py`（新增） | `elab.lock.yaml` 读取/比对；`doctor --strict-lock` |
| 外置仓 `xkk6663/elab-provider-espressif-idf` | `provider.yaml` + README + `.gitattributes` |

P2 完成判据：

1. `elab provider install espressif/idf` → 项目 `provider:` 能解析并跑通三步预览。
2. 删掉 provider → 项目加载失败，错误里含安装命令。
3. `elab.lock.yaml` 版本漂移 → `doctor` warn；`--strict-lock` 失败。
4. `elab pkg index --check` 同时覆盖 pack 与 provider。

### P3：外带调试

- `services/elab/debugsession.py` 增 `DebugBackend` 解析层：native / gdb-mi（先）。
- `provider.py` 校验 `debug.server/gdb` 声明。
- DAP 另立文档，不阻塞 P1/P2。

---

## 15. 验收命令（可复制执行）

```powershell
# 1) 单元测试
$env:PYTHONPATH="services"
python -m unittest tests.test_provider_manifest tests.test_provider_resolve tests.test_delegated_steps -v

# 2) 预览等价（P1 的核心门禁）
.\elab.cmd run -p esp32s31_korvo --steps build,flash,debug_verify --dry-run --json > .work\preview.provider.json
#   迁移前先存一份 inline 预览，做逐字段 diff（允许新增 provider 字段，不允许 argv/cwd/env 键漂移）

# 3) 真实闭环（有板/有串口时）
.\elab.cmd run -p esp32s31_korvo --steps doctor,build,debug_verify -q

# 4) 既有回归
.\elab.cmd doctor
.\elab.cmd pkg index --check        # P2 起同时校验 provider
```

门禁规则：

- `--dry-run` 输出中不得出现未替换的 `${...}`。
- 事件 `step-exit` 的 `step` 仍为规范名；新增 `provider` 字段不得改变既有字段语义。
- `guard.untouched`（adapt 不改工程）必须保持通过。

---

## 16. 迁移步骤（ESP32 项目，P1 验收样例）

1. 在 `providers/installed/espressif/idf/provider.yaml` 放置第 4.3 节清单。
2. 项目 YAML 改为：

```yaml
name: esp32s31_korvo
root: ${ELAB_ROOT}/examples/ESP32S31_Korvo
pack: espressif/esp32
chip: esp32s31
provider: espressif/idf@>=1 <2

artifacts:
  elf: ${root}/build/esp32s31_korvo.elf
  bin: ${root}/build/esp32s31_korvo.bin
  map: ${root}/build/esp32s31_korvo.map

serial:
  port: auto
  baud: 115200

step_labels:
  debug_verify: 烧录校验
```

3. 删除 `tools:` 四个块（`idf_env_check` / `idf_build` / `idf_flash` / `idf_verify`）。
4. 比较迁移前后 `--dry-run --json`：argv/cwd/env 键集合一致；只允许出现
   `provider` 相关新增字段。
5. 跑 `doctor,build,debug_verify`；确认 `memory_source=map` 仍出现。

回滚：把 `provider:` 去掉并恢复内联 `tools`/`steps` 即可，内核不需要回滚版本；
两种形态在 P1 期间**同时支持**。

---

## 17. 风险与对策

| 风险 | 对策 |
|---|---|
| provider 命令模板与预期 argv 漂移 | `--dry-run` 黄金用例；CI diff |
| provider 版本升级破坏项目 | semver range + `elab.lock.yaml` + `doctor` 漂移告警 |
| provider 数据执行任意主机命令 | 市场 sha256、安装显式、预览可审计、超时/杀树 |
| 缺步骤被误判为“跑过了” | `kind=unavailable` 明确失败；事件里写原因 |
| 默认链与外部链产物不一致 | `artifacts` 契约统一；内存/烧录只读产物 |
| 市场包与 provider 混淆 | `kind` 字段；CLI 分开；文档与校验同步 |
| 未来代码 provider 破坏边界 | 明确列为非目标；要变更先改本文件与分层规则 |

---

## 18. 完成定义（Definition of Done）

- [ ] P1 契约与解析器合入，`--dry-run` 等价门禁通过。
- [ ] ESP32 项目迁移到 `provider:`，内联形态仍可用。
- [ ] 项目卡片能显示 provider 名称/版本/来源与每步可用性。
- [ ] `monitor` 被 provider 提供时加载失败。
- [ ] 缺 provider/缺步骤/版本不匹配的错误消息均含可执行修复建议。
- [ ] `ctx.provide()` 未新增任何“provider 命令注入”用途（代码评审项）。
- [ ] P2 市场条目、安装器、lock 校验通过后，再单独开 P3 调试设计。
