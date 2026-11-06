/**
 * 工具目录（domain）—— **Tool 概念属 domain，实现属 adapters**。
 *
 * 为什么契约在这里（§4.4 分层）：
 *   工具的 name / description / parameters 是**业务词汇**，不是传输细节；
 *   放在 adapters/dsh-tools 里等于让适配器定义业务（分层债）。
 *   本文件是纯数据：零 I/O、零宿主、零框架，只准 import 同目录（boundary 守卫）。
 *
 * 这里是「工具树」的**唯一事实源**：
 *   - `TOOL_CONTRACTS` —— 注册面（12 个工具：6 门面 + 8 细粒度）。
 *     适配器只提供 execute，契约（描述/参数/动作枚举）在这里定。
 *   - `TOOL_GROUPS` —— 意图树（group → action），带**同义词**与**前置条件**。
 *     渐进披露三层：常驻话术（AGENT_USAGE）→ 本树（elab_guide）→ .agents/skills。
 *   - `LEGACY_TOOLS` —— 旧工具名 → 新入口的迁移表（兼容层与迁移提示都读它）。
 *
 * ★ 同义词与前置条件必须来自**真实约束**（源码里的写门控、串口互斥、能力探测），
 *   不得臆造 —— 见各组 `preconditions` 的注释出处。
 */
// ── 注册面（12 个工具）───────────────────────────────────────────────
/**
 * 细粒度直调工具（8 个）—— 高频、参数少、意图单一，给 agent 最短路径。
 * 门面工具里也有等价 action（见 TOOL_GROUPS 的 `shortcut` 注记）。
 */
const STATUS_TOOL = {
    name: 'elab_status',
    summary: '工程列表 + 每步可用性 + 当前 run + 串口现状（只读）',
    description: '查看 elab 驾驶舱状态：工程列表（含各步骤可用性与原因）、当前 run 归属与步骤、cockpit 进程健康，' +
        '以及串口现状（端口候选 / 当前监视会话 / 租约剩余）。只读。写操作前先调它确认工程名与端口。',
    parameters: {},
    kind: 'read',
    group: 'overview',
};
const GUIDE_TOOL = {
    name: 'elab_guide',
    summary: '工具树全文（按 topic 只取一组）+ 旧名迁移表 + 纪律',
    description: '返回 elab 驾驶舱的 agent 使用契约：按意图分组的工具树（每个入口带同义词、前置条件与调用示例）、' +
        '旧工具名迁移表、调用顺序与单飞/串口让位/写门控纪律。只读、不启动内核；' +
        '不确定该用哪个 elab_* 工具、接手新工程、或沿用老脚本里的旧工具名时先调它。',
    parameters: {
        topic: { type: 'string', description: '只取一组（overview/run/serial/debug/frame/pkg）；缺省返回全树' },
    },
    kind: 'read',
    group: 'overview',
};
const LOG_TOOL = {
    name: 'elab_log',
    summary: '读 run 日志尾部 N 行，可按步骤过滤',
    description: '读取某个 run 的日志尾部 N 行纯文本（默认 200，可按步骤过滤）。run 缺省 = 当前活动 run。',
    parameters: {
        run: { type: 'string', description: 'run id；缺省 = 当前活动 run' },
        step: { type: 'string', description: '只看某一步（doctor/build/flash/debug_verify/monitor）' },
        tail: { type: 'number', description: '尾部行数（默认 200，上限 2000）' },
    },
    kind: 'read',
    group: 'run',
};
const SERIAL_READ_TOOL = {
    name: 'elab_serial_read',
    summary: '按游标读串口字节（rx/tx/all）',
    description: '增量读取串口监视会话的原始字节（带方向/时间/序号）。返回 next_after 游标与 text/hex 投影；' +
        '没有会话时先 elab_serial action=monitor。只读，不写硬件。',
    parameters: {
        after: { type: 'number', description: '上次返回的 next_after（缺省 0 = 从当前环起点）' },
        direction: { type: 'string', description: 'all / rx / tx（默认 all；rx=设备输出，tx=我们写出的）' },
        limit: { type: 'number', description: '最多返回多少批次（默认 500，上限 4096）' },
    },
    kind: 'read',
    group: 'serial',
};
const SERIAL_WAIT_TOOL = {
    name: 'elab_serial_wait',
    summary: '等匹配正则的串口行（判心跳/等日志）',
    description: '等待串口监视流里出现匹配文本（正则或子串），返回匹配时刻前后的批次。超时返回 ok=false。' +
        '用于“发命令后等设备回 OK/数据”这类时序断言。只读。',
    parameters: {
        pattern: { type: 'string', required: true, description: '要等待的正则表达式（大小写敏感）' },
        after: { type: 'number', description: '起始游标（缺省 = 当前环起点之后的新数据）' },
        direction: { type: 'string', description: 'all / rx / tx（默认 rx）' },
        timeout_ms: { type: 'number', description: '超时毫秒（默认 5000，上限 60000）' },
        poll_ms: { type: 'number', description: '轮询间隔毫秒（默认 150）' },
    },
    kind: 'read',
    group: 'serial',
};
const SERIAL_CAPTURE_TOOL = {
    name: 'elab_serial_capture',
    summary: '录制串口到文件（证据，可回放；可布防）',
    description: '显式录制串口字节（证据，可回放）：start 开始录、stop 收尾返回文件路径与统计、' +
        'status 查当前录制。文件是有界 JSONL（默认上限 5 MiB），到顶自动停录并标 truncated。' +
        '只存原始字节（bytes_b64），不存文本投影。' +
        '可**布防**：给 trigger 就只在命中时落盘（含 pre_bytes 预录），适合"等故障发生再录"。',
    parameters: {
        action: { type: 'string', required: true, description: 'start / stop / status' },
        project: { type: 'string', description: '工程名（可省略；用于文件命名与留档关联）' },
        max_bytes: { type: 'number', description: '录制文件上限（字节；缺省 5 MiB）' },
        trigger: {
            type: 'string',
            description: '触发条件 JSON：{"pattern":"aa55"} 或 {"field":{"name":"v","op":"gt","value":40}} 或 {"frame_index":10}',
        },
        pre_bytes: { type: 'number', description: '命中前预录多少字节（默认 0；建议 4096）' },
    },
    kind: 'edit',
    group: 'serial',
};
const SERIAL_WIDGET_TOOL = {
    name: 'elab_serial_widget',
    summary: '自定义发送组件（定时/循环发）',
    description: '工程级「串口发送组件」（参数 + send/delay/wait 序列 + 周期发送）。' +
        'action=list 列组件；preview 只渲染字节；run 执行（写硬件！需要 allowAgentWrite；' +
        '返回 running 时用 status 轮询到终态）；status 查任务（job_id 缺省 = 当前任务）；' +
        'cancel/pause 停止/暂停（人的停止永远优先，agent 也可主动让路）；save/delete 改配置（需要 allowAgentWrite）。' +
        '组件配置在 projects/<name>.widgets.json，写操作带 rev 乐观锁（冲突时重读再存）。',
    parameters: {
        action: {
            type: 'string',
            required: true,
            description: 'list / preview / run / status / cancel / pause / resume / save / delete',
        },
        project: { type: 'string', description: '工程名（list/preview/run/save/delete 必填）' },
        id: { type: 'string', description: '组件 id（preview/run/save/delete 必填）' },
        params: { type: 'string', description: '参数 JSON，如 {"n":3}（缺省 = 组件默认值）' },
        repeat: { type: 'boolean', description: 'run 时 true = 按组件 repeat 配置周期跑' },
        confirm: { type: 'boolean', description: 'run 时 true = 已确认（组件 confirm=true 必须）' },
        job_id: { type: 'string', description: 'status/cancel/pause 的任务 id；缺省 = 当前任务' },
        widget: { type: 'string', description: 'save 时组件定义 JSON（字符串）' },
        rev: { type: 'number', description: 'save/delete 时的乐观锁版本（来自 list 的 rev）' },
    },
    kind: 'edit',
    group: 'serial',
};
const DEBUG_INSPECT_TOOL = {
    name: 'elab_debug_inspect',
    summary: '调试只读视图：栈/变量/寄存器/内存/反汇编',
    description: '读取调试数据（只读）：session / stack / variables / registers / breakpoints / memory / disasm / evaluate。' +
        '目标运行时返回 debug-target-running；先 pause。',
    parameters: {
        what: { type: 'string', required: true, description: 'session/stack/variables/registers/breakpoints/memory/disasm/evaluate' },
        frame: { type: 'number', description: '栈帧号（variables/evaluate 用）' },
        scope: { type: 'string', description: 'locals/args/children（variables）' },
        var: { type: 'string', description: '要展开的变量名（scope=children）' },
        thread: { type: 'number', description: '线程 id（stack）' },
        group: { type: 'string', description: 'core/fpu/all（registers）' },
        format: { type: 'string', description: 'natural/hex（registers）' },
        addr: { type: 'string', description: 'memory/disasm 起始地址' },
        count: { type: 'number', description: 'memory 字节数（≤4096）/ disasm 指令数（≤128）' },
        expr: { type: 'string', description: 'evaluate 表达式（如 dwTickCount）' },
    },
    kind: 'read',
    group: 'debug',
};
// ── 门面工具（6 个）───────────────────────────────────────────────────
const RUN_TOOL = {
    name: 'elab_run',
    summary: '闭环执行门面：编译/烧录/三连/闭环/指定步骤/预览/取消',
    description: '闭环执行门面：编译 / 烧录 / 三连 / 完整闭环 / 指定步骤 / 预览 / 取消。' +
        'action 决定做什么（build=只编译、triple=编译+烧录+调试校验、loop=体检→编译→烧录→调试校验→串口闭环、' +
        'step=显式步骤组合、preview=只读预览将执行的命令、cancel=取消 run）。' +
        '写操作全部落 POST /api/run（与面板按钮同源），返回 run id；进度在 DSH 面板实时可见，日志用 elab_log。' +
        '同一会话单飞：至多 1 个 run 在跑，人在跑就等结束或请用户取消，不要重试刷屏。',
    parameters: {
        action: {
            type: 'string',
            required: true,
            enum: ['build', 'triple', 'loop', 'step', 'preview', 'cancel'],
            description: '要执行的动作',
        },
        project: { type: 'string', description: '工程名（elab_status 查；build/triple/loop/step/preview 必填）' },
        steps: { type: 'string', description: 'action=step：逗号分隔，如 build 或 flash,debug_verify 或 tool:ota' },
        clean: { type: 'boolean', description: '先删除工作目录再执行（不可逆，谨慎）' },
        jobs: { type: 'number', description: '并行度 -j（默认由工程决定）' },
        run: { type: 'string', description: 'action=cancel：要取消的 run id；缺省 = 当前活动 run' },
        reason: { type: 'string', description: 'action=cancel：取消原因（记入日志）' },
    },
    kind: 'execute',
    group: 'run',
    actions: ['build', 'triple', 'loop', 'step', 'preview', 'cancel'],
};
const SERIAL_TOOL = {
    name: 'elab_serial',
    summary: '串口门面：监视/写/解码/共享解码帧/帧级统计',
    description: '串口门面：监视生命周期、写串口、无状态解码、读共享解码帧、帧级健康度。' +
        'action 决定做什么（monitor=开/关监视与切换共享解码器、write=向串口写数据、decode=无状态解码一帧、' +
        'decoded=增量读会话级共享解码帧、stats=帧率与错误分类）；monitor 的子动作用 op=open/close/decoder/clear/pause/resume。' +
        '★ 高频读写有细粒度快捷入口：读字节用 elab_serial_read，等匹配行用 elab_serial_wait' +
        '（等价 action=read / action=wait）。' +
        'write 需 allowAgentWrite；monitor 默认带 lease_s 租约，到期自动释放端口。',
    parameters: {
        action: {
            type: 'string',
            enum: ['monitor', 'write', 'decode', 'decoded', 'stats', 'read', 'wait'],
            description: '要执行的动作；缺省时按参数推断（带 data → write）。'
                + 'monitor 的子动作用 op=open/close/decoder/clear/pause/resume',
        },
        project: { type: 'string', description: '工程名（monitor/write 时用于解析端口与波特率）' },
        port: { type: 'string', description: '显式端口（缺省取工程配置）' },
        baud: { type: 'number', description: '显式波特率（缺省取工程配置）' },
        lease_s: { type: 'number', description: 'monitor 时监视会话租约秒数（缺省 120；0 = 无租约）' },
        op: { type: 'string', description: 'monitor 的子动作：open / close / decoder / clear / pause / resume' },
        decoder: { type: 'string', description: 'monitor op=decoder：justfloat / firewater / profile（配合 project+profile_id）；空串 = 关闭共享解码' },
        after: { type: 'number', description: 'read/decoded：上次返回的 next_after（缺省 0 = 从环起点）' },
        direction: { type: 'string', description: 'read/wait：all / rx / tx（默认 all / rx）' },
        limit: { type: 'number', description: 'read：最多返回多少批次（默认 500，上限 4096）；decoded：帧数（默认 200，上限 1024）' },
        pattern: { type: 'string', description: 'wait：要等待的正则表达式（大小写敏感）' },
        timeout_ms: { type: 'number', description: 'wait：超时毫秒（默认 5000，上限 60000）' },
        poll_ms: { type: 'number', description: 'wait：轮询间隔毫秒（默认 150）' },
        data: { type: 'string', description: 'write：要写入的内容（不含换行符；hex 格式时为十六进制串）' },
        format: { type: 'string', description: 'write：auto / utf8 / ascii / gbk / hex（默认 utf8）' },
        eol: { type: 'string', description: 'write：none / lf / crlf（默认 crlf；hex 自动 none）' },
        encoding: { type: 'string', description: 'write：文本编码（默认 utf-8）' },
        interval_ms: { type: 'number', description: 'write：定时发送间隔（毫秒，≥20）。给了就是周期任务' },
        count: { type: 'number', description: 'write：定时发送轮次；0 = 直到手动停止（最长 600s）' },
        window_s: { type: 'number', description: 'stats：统计窗口秒数（默认 10，1..60）' },
        profile: { type: 'string', description: 'decode：profile 草稿 JSON（字符串；可解码未保存配置）' },
        hex: { type: 'string', description: 'decode：样本字节（十六进制串）' },
        data_b64: { type: 'string', description: 'decode：样本字节（base64；与 hex 二选一）' },
        channels: { type: 'number', description: 'decode：显式通道数（缺省自动推断）' },
    },
    kind: 'execute',
    group: 'serial',
    actions: ['monitor', 'write', 'decode', 'decoded', 'stats', 'read', 'wait'],
};
const DEBUG_TOOL = {
    name: 'elab_debug',
    summary: '调试门面：开会话/驱动执行/读数据/管断点/等停止/关会话',
    description: '调试门面：开会话、驱动执行、读数据、管断点、等停止、关会话。' +
        'action 决定做什么（open=起 openocd+gdb 停在 main、control=continue/pause/单步/reset/run_to、' +
        'inspect=只读视图（栈/变量/寄存器/内存/反汇编）、breakpoint=断点增删查、wait=等下一个 stop、' +
        'close=关闭并恢复运行）；子动作用 op=（control/breakpoint）与 what=（inspect）。' +
        '★ 高频读数有细粒度快捷入口：看变量/寄存器用 elab_debug_inspect（等价 action=inspect）。' +
        '需内核 capabilities.meta.debug 声明可用、探针在位且未被别的会话占用；' +
        'close 默认复位并恢复运行（resume=false 才留在 halt）。',
    parameters: {
        action: {
            type: 'string',
            required: true,
            enum: ['open', 'control', 'inspect', 'breakpoint', 'wait', 'close'],
            description: '要执行的动作',
        },
        project: { type: 'string', description: '工程名（open 必填）' },
        stop_at: { type: 'string', description: 'open：停在 main（默认）/ reset / none' },
        load: { type: 'boolean', description: 'open：是否下载 ELF；默认按工程声明' },
        lease_s: { type: 'number', description: 'open：agent 租约秒数（默认 600，60–1800；到期自动关闭并恢复运行）' },
        addr: { type: 'string', description: 'control/run_to 的目标地址（如 0x080001a4）；memory/disasm 起始地址' },
        confirm: { type: 'boolean', description: 'control/reset：true = 确认复位目标' },
        wait_s: { type: 'number', description: 'control：单步等待秒数（默认 8，上限 20）' },
        op: { type: 'string', description: '子动作：control=continue/pause/step_over/step_in/step_out/stepi/reset/restart/run_to；breakpoint=list/add/update/toggle/remove' },
        what: { type: 'string', description: 'inspect：session/stack/variables/registers/breakpoints/memory/disasm/evaluate' },
        frame: { type: 'number', description: 'inspect：栈帧号（variables/evaluate 用）' },
        scope: { type: 'string', description: 'inspect：locals/args/children（variables）' },
        var: { type: 'string', description: 'inspect：要展开的变量名（scope=children）' },
        thread: { type: 'number', description: 'inspect：线程 id（stack）' },
        group: { type: 'string', description: 'inspect：core/fpu/all（registers）' },
        format: { type: 'string', description: 'inspect：natural/hex（registers）' },
        count: { type: 'number', description: 'inspect：memory 字节数（≤4096）/ disasm 指令数（≤128）' },
        expr: { type: 'string', description: 'inspect：evaluate 表达式（如 dwTickCount）' },
        id: { type: 'string', description: 'breakpoint：断点 id（update/toggle/remove）' },
        kind: { type: 'string', description: 'breakpoint：func（默认）/ addr' },
        location: { type: 'string', description: 'breakpoint：函数名或地址' },
        condition: { type: 'string', description: 'breakpoint：条件表达式（可选）' },
        enabled: { type: 'boolean', description: 'breakpoint/update：启用/禁用' },
        hardware: { type: 'boolean', description: 'breakpoint：硬件断点（-h）' },
        after_seq: { type: 'number', description: 'wait：只认比它大的 stop_seq；缺省 = 当前会话的 stop.seq' },
        timeout_s: { type: 'number', description: 'wait：等待秒数（默认 10，上限 60）' },
        resume: { type: 'boolean', description: 'close：默认 true 复位并运行；false = 保持 halt' },
    },
    kind: 'execute',
    group: 'debug',
    actions: ['open', 'control', 'inspect', 'breakpoint', 'wait', 'close'],
};
const FRAME_TOOL = {
    name: 'elab_frame',
    summary: '帧协议 profile 管理：list/get/preview/save/delete/encode/templates/import',
    description: '帧协议 profile 管理（Agent 只写**声明式 JSON**，不生成可执行解码器）：' +
        'list/get 读工程配置；preview 无硬件试解字节（支持未保存草稿）；encode 字段值→字节；' +
        'templates 列只读模板库；save/delete/import 改配置（需要 allowAgentWrite，rev 乐观锁）。' +
        '★ 协议自学习（learn/verify/auto/codegen）在 elab_frame_learn。' +
        'profile 支持位域（bit_offset/bit_length/bit_order）、变长（frame.length_field）、' +
        '多 ID（frame.id_field + variants）、校验预设（crc8/crc16/crc32 + cover/offset）、' +
        '转义（escape）、多帧头（frame.heads）、空闲分包（idle_gap_ms）、' +
        '数组/字符串/f16/位标志（array/str/bits）。' +
        'schema 的权威定义在 GET /api/serial/meta 的 SERIAL_META.frames.schema。',
    parameters: {
        action: {
            type: 'string',
            required: true,
            enum: ['list', 'get', 'preview', 'save', 'delete', 'encode', 'templates', 'import'],
            description: '要执行的动作',
        },
        project: { type: 'string', description: '工程名（templates 外基本都必填）' },
        id: { type: 'string', description: 'profile id（get/preview/delete/encode 用）' },
        rev: { type: 'number', description: 'save/delete/import 的乐观锁版本（来自 list 的 rev）' },
        profile: { type: 'string', description: 'profile JSON（字符串；preview/save/encode 可传未保存草稿）' },
        values: { type: 'string', description: 'encode 的字段值 JSON（字符串），如 {"rpm":100,"mode":"RUN"}' },
        variant: { type: 'string', description: 'encode 的 variant id（"1" 或 "0x03"；多 variant 必填）' },
        length_value: { type: 'number', description: 'encode 时显式覆盖 length_field 原始值（须与帧长一致）' },
        hex: { type: 'string', description: '样本字节（十六进制串，可含空格/0x；preview/encode 用）' },
        b64: { type: 'string', description: '样本字节（base64；与 hex 二选一）' },
        template: { type: 'string', description: 'templates 时可筛选模板 id；import 时必填' },
        new_id: { type: 'string', description: 'import 时新 profile id（缺省沿用模板 id）' },
    },
    kind: 'edit',
    group: 'frame',
    actions: ['list', 'get', 'preview', 'save', 'delete', 'encode', 'templates', 'import'],
};
const FRAME_LEARN_TOOL = {
    name: 'elab_frame_learn',
    summary: '协议自学习：learn/verify/auto/codegen',
    description: '协议自学习闭环：**从抓包学出草稿**（learn，不落盘）→ 证伪（verify，解→编→再解的 round-trip）→ ' +
        '在一组 profile 里挑最像的（auto）→ 生成 C 头文件（codegen）。' +
        '遇到不认识的二进制协议时先 learn，再用 verify 证伪，最后用 elab_frame preview 看字段，确认后才 save。' +
        '样本来源：hex / b64 单帧，frames 帧数组，或 capture 抓包文件（录制的 .jsonl，只取 dir=rx）。',
    parameters: {
        action: {
            type: 'string',
            required: true,
            enum: ['learn', 'verify', 'auto', 'codegen'],
            description: '要执行的动作',
        },
        project: { type: 'string', description: '工程名（codegen/verify 定位 profile 时必填）' },
        id: { type: 'string', description: 'profile id（verify/codegen 用；learn 出草稿时是草稿 id 前缀）' },
        profile: { type: 'string', description: 'profile 草稿 JSON（字符串；verify/codegen 可传未保存草稿）' },
        hex: { type: 'string', description: '样本字节（十六进制串，可含空格/0x）' },
        b64: { type: 'string', description: '样本字节（base64；与 hex 二选一）' },
        capture: { type: 'string', description: '抓包样本：录制的 .jsonl 文件路径（限本工程 .work/.cockpit/）或 JSONL 文本；'
                + '只取 dir=rx。抓包 → learn → save → decoder=profile:<id> 是完整闭环' },
        frames: { type: 'string', description: 'learn 的帧数组 JSON（["aa55..","aa55.."]）；已知帧边界时用它' },
        hints: { type: 'string', description: 'learn 提示 JSON，如 {"heads":["aa55"]}' },
        field_count: { type: 'number', description: 'learn 时预期字段数（均分 payload；不知道就省略）' },
        name: { type: 'string', description: 'learn 出的草稿 id 前缀（默认 learned）' },
        apply: { type: 'boolean', description: 'auto 命中后直接设为会话解码器' },
        write: { type: 'boolean', description: 'codegen 是否落盘到 generated/<id>.h' },
        overwrite: { type: 'boolean', description: 'codegen 覆盖已存在的头文件' },
    },
    kind: 'edit',
    group: 'frame',
    actions: ['learn', 'verify', 'auto', 'codegen'],
};
const PKG_TOOL = {
    name: 'elab_pkg',
    summary: '芯片适配包管理与工程接入（status…verify/adapt）',
    description: '芯片适配包与工程接入（一切芯片差异皆包）：status 查看已装/启用、search 搜索社区市场、' +
        'install 安装（按包名，source/sha256 由内核解析；official=true 装本机官方源内置包）、' +
        'activate 启用（一次只启用一套，其余保留在本地）、remove/update/verify 卸载/更新/校验；' +
        'adapt 把一个工程目录接入 elab（write=false 只读探测，write=true 落盘，需 allowAgentWrite）。' +
        '★ install 不受 allowAgentWrite 限制（只写 packs/installed/，不碰硬件与业务工程）；' +
        '内核同一时刻只允许一个包操作，有闭环在跑会 409。',
    parameters: {
        action: {
            type: 'string',
            required: true,
            enum: ['status', 'search', 'install', 'activate', 'remove', 'update', 'verify', 'adapt'],
            description: '要执行的动作',
        },
        name: { type: 'string', description: '包名（如 st/stm32、artery/at32；install/activate/remove 必填）；action=adapt 时是适配名' },
        query: { type: 'string', description: 'search 关键词（名称 / 厂商 / 平台，如 stm32、at32）' },
        official: { type: 'boolean', description: 'install 时 true = 装本机官方源（离线，如 st/stm32）' },
        force: { type: 'boolean', description: 'install/update 时强制重装同版本' },
        wait_s: { type: 'number', description: 'install/remove/update 等待秒数（默认 180；超时则返回后台 job 状态）' },
        path: { type: 'string', description: 'adapt：工程目录绝对路径' },
        write: { type: 'boolean', description: 'adapt：true = 写入适配文件（需 allowAgentWrite）；缺省 false = 只读探测' },
    },
    kind: 'edit',
    group: 'pkg',
    actions: ['status', 'search', 'install', 'activate', 'remove', 'update', 'verify', 'adapt'],
};
const MODBUS_TOOL = {
    name: 'elab_modbus',
    summary: 'Modbus RTU 主站：读/写/轮询/点表（挂在已开的串口会话上）',
    description: 'Modbus RTU 主站操作，**挂在已打开的串口会话上**（不新开口、不复制读线程，' +
        '与面板看到的是同一份字节）。meta 取词汇表（功能码中文名/类型/限制/异常码）；' +
        'status 只读快照（引擎状态 + 寄存器值 + 增量事务流水），引擎没起来也回点表；' +
        'open 打开主站（可 probe 读一次设备 ID，把上电首帧抖动吸收在 open 里）；' +
        'read 单次读（FC01/02/03/04，count 上限 125 寄存器 / 2000 位）；' +
        'write 单次写（FC05/06/0F/10，**必须 confirm=true 且需 allowAgentWrite**，会真的动物理世界）；' +
        'start/stop 起停轮询（按点表分组，同功能码相邻地址自动合并成一条读，单飞 + 退避）；' +
        'transactions 读增量事务流水（?after= 游标）；map 不带参读点表、带 map+rev 保存（乐观锁）。' +
        '★ 点表是声明式 JSON（projects/<name>.modbus.json），现场语义全在里面：地址/类型/字序/换算/单位。',
    parameters: {
        action: {
            type: 'string',
            required: true,
            enum: ['meta', 'status', 'open', 'close', 'read', 'write', 'start', 'stop',
                'transactions', 'map'],
            description: '要执行的动作',
        },
        project: { type: 'string', description: '工程名（open/read/map 必填；status 可选）' },
        port: { type: 'string', description: 'open 时显式指定端口（缺省用工程 serial.port / 自动探测）' },
        baud: { type: 'number', description: 'open 时的波特率（缺省取工程配置，常见 9600/115200）' },
        unit_id: { type: 'number', description: '从站地址 1..247（广播写用 broadcast 而不是 0）' },
        fc: { type: 'number', description: '功能码：读 1/2/3/4；写 5/6/15/16' },
        address: { type: 'number', description: '协议地址（0 基；40001 → 0）' },
        count: { type: 'number', description: '读取数量（寄存器 ≤125，位 ≤2000）' },
        value: { type: 'number', description: 'FC05/06 的单个值（FC05 只认 0/1，内核转 0xFF00/0x0000）' },
        values: { type: 'string', description: 'FC15/16 的批量值 JSON 数组（字符串），如 "[1,0,1,0]"' },
        confirm: { type: 'boolean', description: '写操作必须显式 true（内核拒绝无确认的写）' },
        broadcast: { type: 'boolean', description: '写广播（unit=0，不等应答；从站执行但不回）' },
        probe: { type: 'boolean', description: 'open 后顺手读一次 FC03 addr=0 count=2（默认 true）' },
        timeout_ms: { type: 'number', description: 'open 时的事务超时（默认 120ms；USB-CDC 桥建议 ≥60）' },
        retries: { type: 'number', description: 'open 时的重试次数（默认 2；超时重试，异常码不重试）' },
        groups: { type: 'string', description: 'start 的分组覆盖 JSON 数组（缺省用点表里的 groups）' },
        map: { type: 'string', description: 'map 动作：点名表 JSON（带上则保存，必须同时给 rev）' },
        rev: { type: 'number', description: 'map 保存的乐观锁版本（来自上一次读点表）' },
        after: { type: 'number', description: 'status/transactions 的增量游标（上次返回的 next_after）' },
    },
    kind: 'edit',
    group: 'modbus',
    actions: ['meta', 'status', 'open', 'close', 'read', 'write', 'start', 'stop',
        'transactions', 'map'],
};
/** 注册面：工具名 → 契约。适配器按这张表注册，缺实现即注册失败（有守卫测试）。 */
export const TOOL_CONTRACTS = {
    elab_status: STATUS_TOOL,
    elab_guide: GUIDE_TOOL,
    elab_log: LOG_TOOL,
    elab_run: RUN_TOOL,
    elab_serial: SERIAL_TOOL,
    elab_serial_read: SERIAL_READ_TOOL,
    elab_serial_wait: SERIAL_WAIT_TOOL,
    elab_serial_capture: SERIAL_CAPTURE_TOOL,
    elab_serial_widget: SERIAL_WIDGET_TOOL,
    elab_debug: DEBUG_TOOL,
    elab_debug_inspect: DEBUG_INSPECT_TOOL,
    elab_frame: FRAME_TOOL,
    elab_frame_learn: FRAME_LEARN_TOOL,
    elab_pkg: PKG_TOOL,
    elab_modbus: MODBUS_TOOL,
};
// ── 意图树（渐进披露的第二层）────────────────────────────────────────
export const TOOL_GROUPS = [
    {
        id: 'overview',
        title: '工程现状与入口',
        intent: '先搞清楚「有哪些工程、跑到哪、串口什么状态、该用哪个工具」。',
        preconditions: ['只读，任何时候可调；写操作前先 elab_status 拿工程名与端口'],
        entries: [
            {
                tool: 'elab_status',
                use: '工程列表 + 每步可用性 + 当前 run + 串口现状',
                synonyms: ['工程有哪些', '有哪些工程', '当前状态', '跑了吗', '串口状态', '端口'],
                preconditions: ['无（只读）'],
                example: 'elab_status',
            },
            {
                tool: 'elab_guide',
                use: '工具树全文（按 topic 只取一组）+ 旧名迁移表 + 纪律',
                synonyms: ['该用哪个工具', '工具清单', '怎么用', '指南', 'help'],
                preconditions: ['无（只读）'],
                example: 'elab_guide(topic="serial")',
            },
        ],
    },
    {
        id: 'run',
        title: '编译 / 烧录 / 闭环',
        intent: '编译、烧录、跑闭环、预览计划、取消、看日志。',
        preconditions: [
            '需要工程名（elab_status 查，别用目录名猜）',
            '单飞：同一会话至多 1 个 run 在跑；human-busy 时等结束或请用户取消，不要重试刷屏',
            '含硬件步骤（flash/debug_verify/monitor）需板子在位',
        ],
        entries: [
            {
                tool: 'elab_run',
                action: 'build',
                use: '只编译（plan=basic）',
                synonyms: ['编译', 'build', 'make', 'cmake', '编一下'],
                preconditions: ['工程已适配（elab_status 里有它）'],
                example: 'elab_run action="build" project="demo"',
            },
            {
                tool: 'elab_run',
                action: 'triple',
                use: '编译 + 烧录 + 调试校验（三连）',
                synonyms: ['三连', 'triple', '编译烧录', '烧录加校验'],
                preconditions: ['板子在位', 'debug_verify 需要探针与可用的调试能力'],
                example: 'elab_run action="triple" project="demo"',
            },
            {
                tool: 'elab_run',
                action: 'loop',
                use: '完整闭环（体检→编译→烧录→调试校验→串口闭环；缺项自动剔除）',
                synonyms: ['闭环', 'loop', '全流程', '一键'],
                preconditions: ['板子在位', '串口配置就绪（monitor 步骤需要端口）'],
                example: 'elab_run action="loop" project="demo"',
            },
            {
                tool: 'elab_run',
                action: 'step',
                use: '指定步骤组合（doctor/build/flash/debug_verify/monitor 或 tool:<name>）',
                synonyms: ['只烧录', '单步', 'flash', '烧录', '烧进去', 'download', '刷写'],
                preconditions: ['步骤必须在工程里可用；不可用会直接报错（不静默剔除）'],
                example: 'elab_run action="step" project="demo" steps="flash,debug_verify"',
            },
            {
                tool: 'elab_run',
                action: 'preview',
                use: '预览将执行的计划（命令/产物/超时），不落盘',
                synonyms: ['预览', 'preview', '会执行什么', 'dry-run', '先看看'],
                preconditions: ['无（只读）'],
                example: 'elab_run action="preview" project="demo"',
            },
            {
                tool: 'elab_run',
                action: 'cancel',
                use: '取消当前 run（杀整棵进程树，人发的也能取消）',
                synonyms: ['取消', 'cancel', '停掉', '停下'],
                preconditions: ['有活动 run'],
                example: 'elab_run action="cancel"',
            },
            {
                tool: 'elab_log',
                use: '读 run 日志尾部 N 行，可按步骤过滤',
                synonyms: ['日志', 'log', '输出', '报错信息', '失败原因'],
                preconditions: ['有 run id 或当前有活动 run'],
                example: 'elab_log run="r-123" step="build" tail=100',
            },
        ],
    },
    {
        id: 'serial',
        title: '串口',
        intent: '看设备输出、判心跳、等某行、写串口、录制、解码、帧率健康度、定时发送组件。',
        preconditions: [
            '除只读解码/统计外，先 elab_serial action=monitor 开监视（没有会话的读会直接返回 active=false）',
            '写串口 / 录制 / 组件发送受 allowAgentWrite 门控（默认关，被拒就转告用户，不要绕路重试）',
            'run 期间内核自动让位串口（挂起监视并在收尾恢复），不必先让用户关监视',
        ],
        entries: [
            {
                tool: 'elab_serial',
                action: 'monitor',
                use: '串口监视生命周期与共享解码器切换（op=open/close/decoder/clear/pause/resume）',
                synonyms: ['开串口', '打开串口', '监视', 'monitor', '关串口', '解码器切换'],
                preconditions: ['硬件在位', '端口未被别的会话占用', 'open 默认带 lease_s 租约，到期自动释放'],
                example: 'elab_serial action="monitor" op="open" project="demo"',
            },
            {
                tool: 'elab_serial_read',
                use: '按游标读串口批次（rx/tx/all）—— 高频快捷入口（等价 elab_serial action=read）',
                synonyms: ['读串口', '串口输出', 'read', '字节流', '读到哪'],
                preconditions: ['已有监视会话'],
                example: 'elab_serial_read after=0 direction="rx"',
            },
            {
                tool: 'elab_serial',
                action: 'read',
                use: '按游标读串口批次（同 elab_serial_read；门面侧等价入口）',
                synonyms: ['读串口', '字节流'],
                preconditions: ['已有监视会话'],
                example: 'elab_serial action="read" after=0 direction="rx"',
            },
            {
                tool: 'elab_serial_wait',
                use: '等匹配正则的串口行（判心跳/等日志）—— 高频快捷入口（等价 elab_serial action=wait）',
                synonyms: ['等一行', '等待', '心跳', 'heartbeat', '等日志', '等到'],
                preconditions: ['已有监视会话'],
                example: 'elab_serial_wait pattern="\\[alive\\]" timeout_ms=5000',
            },
            {
                tool: 'elab_serial',
                action: 'wait',
                use: '等匹配正则的串口行（同 elab_serial_wait；门面侧等价入口）',
                synonyms: ['等一行', '心跳'],
                preconditions: ['已有监视会话'],
                example: 'elab_serial action="wait" pattern="\\[alive\\]"',
            },
            {
                tool: 'elab_serial',
                action: 'write',
                use: '向串口写数据（可给 interval_ms 做定时发送）',
                synonyms: ['写串口', '发送命令', '发指令', 'write', '下发'],
                preconditions: ['allowAgentWrite 已开', '端口空闲'],
                example: 'elab_serial action="write" project="demo" data="LED ON"',
            },
            {
                tool: 'elab_serial',
                action: 'decode',
                use: '无状态解码一帧（justfloat/firewater/profile）',
                synonyms: ['解码', 'decode', '解一帧', '解析数据'],
                preconditions: ['无（无状态）'],
                example: 'elab_serial action="decode" decoder="justfloat" hex="00 00 80 3f 00 00 00 7f"',
            },
            {
                tool: 'elab_serial',
                action: 'decoded',
                use: '增量读会话级共享解码帧（与面板波形同源）',
                synonyms: ['解码帧', '共享解码', '波形数据', 'decoded'],
                preconditions: ['已有监视会话且已落 decoder'],
                example: 'elab_serial action="decoded" after=0',
            },
            {
                tool: 'elab_serial',
                action: 'stats',
                use: '帧级健康度：帧率/到达间隔 p95/错误分类',
                synonyms: ['帧率', '健康度', 'stats', '错帧', '丢帧', '间隔'],
                preconditions: ['无（没有会话时返回空表）'],
                example: 'elab_serial action="stats" window_s=10',
            },
            {
                tool: 'elab_serial_capture',
                use: '录制串口到文件（证据，可回放；可布防等故障再录）',
                synonyms: ['录制', 'capture', '录下来', '抓包存盘'],
                preconditions: ['start/stop 需 allowAgentWrite', '文件有界（默认 5 MiB），到顶自动停录'],
                example: 'elab_serial_capture action="start" project="demo"',
            },
            {
                tool: 'elab_serial_widget',
                use: '自定义发送组件（定时/循环发）',
                synonyms: ['定时发送', '循环发送', 'widget', '周期发'],
                preconditions: ['run/save/delete 需 allowAgentWrite', '改配置带 rev 乐观锁'],
                example: 'elab_serial_widget action="list" project="demo"',
            },
        ],
    },
    {
        id: 'debug',
        title: '调试',
        intent: '打断点、单步、看变量/寄存器、挂 gdb、停在断点。',
        preconditions: [
            '需内核 capabilities.meta.debug 声明可用（否则先同步内核，不要在工具层为新字段写死兼容分支）',
            '需探针在位且未被别的会话占用（一个 SWD 目标只能被一个 GDB 附着）',
            'close 默认复位并恢复运行（resume=false 才留在 halt，仅排障用）',
        ],
        entries: [
            {
                tool: 'elab_debug',
                action: 'open',
                use: '起 openocd+gdb，停在 main（可 reset/none）',
                synonyms: ['打开调试', '挂gdb', '调试会话', 'debug open', '停在main'],
                preconditions: ['探针在位', '工程有可调试产物'],
                example: 'elab_debug action="open" project="demo"',
            },
            {
                tool: 'elab_debug',
                action: 'control',
                use: 'continue/pause/单步/reset/restart/run_to（op=子动作）',
                synonyms: ['单步', 'step', '继续', 'continue', '运行到', 'run_to', '暂停', '复位'],
                preconditions: ['已有调试会话'],
                example: 'elab_debug action="control" op="step_over"',
            },
            {
                tool: 'elab_debug_inspect',
                use: '只读视图：栈/变量/寄存器/内存/反汇编 —— 高频快捷入口（等价 elab_debug action=inspect）',
                synonyms: ['变量', '寄存器', '内存', '反汇编', '栈', '查看', 'inspect', 'disasm'],
                preconditions: ['已有调试会话', '目标运行时先 pause'],
                example: 'elab_debug_inspect what="variables" frame=0 scope="locals"',
            },
            {
                tool: 'elab_debug',
                action: 'inspect',
                use: '只读视图（what=session/stack/variables/registers/breakpoints/memory/disasm/evaluate）',
                synonyms: ['变量', '寄存器', '内存', '反汇编', '栈'],
                preconditions: ['已有调试会话', '目标运行时先 pause'],
                example: 'elab_debug action="inspect" what="registers" group="core"',
            },
            {
                tool: 'elab_debug',
                action: 'breakpoint',
                use: '断点增删查（op=list/add/update/toggle/remove）',
                synonyms: ['断点', 'breakpoint', '打点'],
                preconditions: ['已有调试会话', '窄栏没有源码 gutter —— 用函数名或地址断点'],
                example: 'elab_debug action="breakpoint" op="add" kind="func" location="main"',
            },
            {
                tool: 'elab_debug',
                action: 'wait',
                use: '等待下一个 stop（命中断点/单步结束）',
                synonyms: ['等断点', '等停', 'wait', '等到命中'],
                preconditions: ['已有调试会话'],
                example: 'elab_debug action="wait" timeout_s=10',
            },
            {
                tool: 'elab_debug',
                action: 'close',
                use: '关闭调试会话并恢复运行',
                synonyms: ['关闭调试', '退出调试', 'close'],
                preconditions: ['有调试会话'],
                example: 'elab_debug action="close"',
            },
        ],
    },
    {
        id: 'frame',
        title: '帧协议',
        intent: '学协议、验协议、生成 C 代码、编解码、profile 管理与模板。',
        preconditions: [
            'learn 需要样本字节（先抓到未知字节；capture 可给 .jsonl 抓包文件，只取 dir=rx）',
            'save/delete/import 写盘需 allowAgentWrite 且要 rev 乐观锁（先 action=list 取 rev 再重试）',
            '先 preview 试解、看懂字段，确认后才 save',
        ],
        entries: [
            {
                tool: 'elab_frame',
                action: 'list',
                use: '列工程的 profile（含 rev 乐观锁版本）',
                synonyms: ['profile 列表', '有哪些协议', '列出'],
                preconditions: ['工程名'],
                example: 'elab_frame action="list" project="demo"',
            },
            {
                tool: 'elab_frame',
                action: 'get',
                use: '取单个 profile 定义',
                synonyms: ['看 profile', '协议定义', 'get'],
                preconditions: ['工程名 + profile id'],
                example: 'elab_frame action="get" project="demo" id="telemetry"',
            },
            {
                tool: 'elab_frame',
                action: 'preview',
                use: '无硬件试解字节（可传未保存草稿）',
                synonyms: ['试解', 'preview', '解一下看看'],
                preconditions: ['工程名+id，或 profile 草稿'],
                example: 'elab_frame action="preview" project="demo" id="telemetry" hex="aa 55 01 02"',
            },
            {
                tool: 'elab_frame',
                action: 'save',
                use: '保存 profile（写工程文件）',
                synonyms: ['保存', 'save', '存下来'],
                preconditions: ['allowAgentWrite', 'rev 乐观锁', 'profile JSON'],
                example: 'elab_frame action="save" project="demo" rev=3 profile="{...}"',
            },
            {
                tool: 'elab_frame',
                action: 'delete',
                use: '删除 profile（写工程文件）',
                synonyms: ['删除', 'delete', '删掉'],
                preconditions: ['allowAgentWrite', 'rev 乐观锁'],
                example: 'elab_frame action="delete" project="demo" id="telemetry" rev=3',
            },
            {
                tool: 'elab_frame',
                action: 'encode',
                use: '字段值 → 字节（发命令用）',
                synonyms: ['编码', 'encode', '组帧', '生成字节'],
                preconditions: ['工程名+id，或 profile 草稿', '多 variant 时须给 variant'],
                example: 'elab_frame action="encode" project="demo" id="telemetry" values="{\\"rpm\\":100}"',
            },
            {
                tool: 'elab_frame',
                action: 'templates',
                use: '列只读模板库（telemetry/mavlink/modbus/dlt645）',
                synonyms: ['模板', 'templates', '现成的协议'],
                preconditions: ['无'],
                example: 'elab_frame action="templates"',
            },
            {
                tool: 'elab_frame',
                action: 'import',
                use: '把模板导入为工程 profile（写工程文件）',
                synonyms: ['导入', 'import', '用模板'],
                preconditions: ['allowAgentWrite', 'rev 乐观锁', 'template id'],
                example: 'elab_frame action="import" project="demo" template="modbus-rtu" rev=3',
            },
            {
                tool: 'elab_frame_learn',
                action: 'learn',
                use: '从抓包学出协议草稿（不落盘，返回 confidence/evidence）',
                synonyms: ['学协议', '自学习', 'learn', '猜协议', '认帧'],
                preconditions: ['样本字节或抓包文件'],
                example: 'elab_frame_learn action="learn" hex="aa 55 01 02"',
            },
            {
                tool: 'elab_frame_learn',
                action: 'verify',
                use: '解→编→再解 的 round-trip 证伪',
                synonyms: ['验证', 'verify', '证伪', '回环'],
                preconditions: ['工程名+id，或 profile 草稿', '样本字节'],
                example: 'elab_frame_learn action="verify" project="demo" id="telemetry" hex="aa 55 01 02"',
            },
            {
                tool: 'elab_frame_learn',
                action: 'auto',
                use: '在一组 profile 里挑最像的',
                synonyms: ['自动识别', 'auto', '猜是哪个'],
                preconditions: ['样本字节或抓包文件'],
                example: 'elab_frame_learn action="auto" hex="aa 55 01 02"',
            },
            {
                tool: 'elab_frame_learn',
                action: 'codegen',
                use: '生成 C 头文件（可落盘到 generated/<id>.h）',
                synonyms: ['生成代码', 'codegen', '出头文件', 'C 代码'],
                preconditions: ['工程名+id，或 profile 草稿'],
                example: 'elab_frame_learn action="codegen" project="demo" id="telemetry" write=true',
            },
        ],
    },
    {
        id: 'pkg',
        title: '芯片包与工程接入',
        intent: '查/装芯片包、接新工程到 elab。',
        preconditions: [
            'pkg install 不受 allowAgentWrite 限制（只写 packs/installed/，不碰硬件与业务工程）',
            '内核同一时刻只允许一个包操作，有闭环在跑会 409',
            'adapt write=true 写盘需 allowAgentWrite',
        ],
        entries: [
            {
                tool: 'elab_pkg',
                action: 'status',
                use: '已装/启用/官方源包清单',
                synonyms: ['包状态', 'pkg status', '装了什么'],
                preconditions: ['无'],
                example: 'elab_pkg action="status"',
            },
            {
                tool: 'elab_pkg',
                action: 'search',
                use: '搜索社区市场',
                synonyms: ['搜包', 'search', '找芯片包'],
                preconditions: ['网络可达（不可达时市场回退本仓索引）'],
                example: 'elab_pkg action="search" query="at32"',
            },
            {
                tool: 'elab_pkg',
                action: 'install',
                use: '安装芯片适配包',
                synonyms: ['装包', 'install', '安装'],
                preconditions: ['没有别的包操作在跑'],
                example: 'elab_pkg action="install" name="st/stm32"',
            },
            {
                tool: 'elab_pkg',
                action: 'activate',
                use: '启用某套包（一次只启用一套）',
                synonyms: ['启用', 'activate', '切换包'],
                preconditions: ['包已安装'],
                example: 'elab_pkg action="activate" name="st/stm32"',
            },
            {
                tool: 'elab_pkg',
                action: 'remove',
                use: '卸载包',
                synonyms: ['卸载', 'remove', '删包'],
                preconditions: ['没有别的包操作在跑'],
                example: 'elab_pkg action="remove" name="st/stm32"',
            },
            {
                tool: 'elab_pkg',
                action: 'update',
                use: '更新包',
                synonyms: ['更新', 'update', '升级包'],
                preconditions: ['没有别的包操作在跑'],
                example: 'elab_pkg action="update" name="st/stm32"',
            },
            {
                tool: 'elab_pkg',
                action: 'verify',
                use: '校验包内容哈希',
                synonyms: ['校验', 'verify', '查哈希'],
                preconditions: ['包已安装'],
                example: 'elab_pkg action="verify" name="st/stm32"',
            },
            {
                tool: 'elab_pkg',
                action: 'adapt',
                use: '接入工程目录（write=false 只读探测，write=true 落盘）',
                synonyms: ['接入工程', '适配', 'adapt', '新工程', '绑定工程'],
                preconditions: ['write=true 需 allowAgentWrite'],
                example: 'elab_pkg action="adapt" path="C:/work/demo"',
            },
        ],
    },
    {
        id: 'modbus',
        title: 'Modbus RTU 主站（读写/轮询/点表）',
        intent: '按点表读从站、写寄存器、起停轮询、改点表 —— 语义全在工程的 .modbus.json 里。',
        preconditions: [
            '主站挂在**已打开的串口会话**上（open 会复用/代开会话，不新开口）',
            '写操作需 confirm=true 且 allowAgentWrite（总线上写会动物理世界）',
            '点表保存走 rev 乐观锁，409 = 别人先改了，重读再改，不要覆盖',
        ],
        entries: [
            {
                tool: 'elab_modbus',
                action: 'meta',
                use: '词汇表：功能码中文名/类型/限制/异常码/端点',
                synonyms: ['功能码', 'fc 有哪些', '异常码', 'modbus 文档', '类型怎么配'],
                preconditions: ['无（只读）'],
                example: 'elab_modbus action="meta"',
            },
            {
                tool: 'elab_modbus',
                action: 'status',
                use: '只读快照：引擎状态 + 寄存器值 + 增量事务（引擎没起来也回点表）',
                synonyms: ['modbus 状态', '读到了吗', '寄存器当前值', '事务', '丢帧'],
                preconditions: ['无（只读）'],
                example: 'elab_modbus action="status" project="STM32F411_modbus"',
            },
            {
                tool: 'elab_modbus',
                action: 'open',
                use: '打开主站（复用串口会话；probe 顺手读设备 ID）',
                synonyms: ['连从站', '打开 modbus', '开始通信', 'connect'],
                preconditions: ['工程有点表或先给了 unit_id', '串口没被闭环/调试占着'],
                example: 'elab_modbus action="open" project="STM32F411_modbus"',
            },
            {
                tool: 'elab_modbus',
                action: 'read',
                use: '单次读（FC01/02/03/04）',
                synonyms: ['读寄存器', '读线圈', 'read holding', '看一下值'],
                preconditions: ['主站已 open'],
                example: 'elab_modbus action="read" fc=3 address=0 count=6',
            },
            {
                tool: 'elab_modbus',
                action: 'write',
                use: '单次写（FC05/06/0F/10，必须 confirm，需 allowAgentWrite）',
                synonyms: ['写寄存器', '点灯', 'write', '改值', '下发'],
                preconditions: ['主站已 open', 'confirm=true', 'allowAgentWrite 已开'],
                example: 'elab_modbus action="write" fc=6 address=16 value=1 confirm=true',
            },
            {
                tool: 'elab_modbus',
                action: 'start',
                use: '起轮询（按点表分组，相邻地址自动合并）',
                synonyms: ['轮询', '开始采集', 'poll', '周期读', '采起来'],
                preconditions: ['主站已 open', '点表里有 enabled 的 groups'],
                example: 'elab_modbus action="start"',
            },
            {
                tool: 'elab_modbus',
                action: 'stop',
                use: '停轮询（keep 会话与引擎，随时可再 start）',
                synonyms: ['停止轮询', 'stop poll', '别采了'],
                preconditions: ['轮询在跑'],
                example: 'elab_modbus action="stop"',
            },
            {
                tool: 'elab_modbus',
                action: 'map',
                use: '读/存点表（存要 rev，走乐观锁）',
                synonyms: ['点表', '寄存器映射', '地址表', '加个点位'],
                preconditions: ['存点表需 allowAgentWrite + rev'],
                example: 'elab_modbus action="map" project="STM32F411_modbus"',
            },
            {
                tool: 'elab_modbus',
                action: 'transactions',
                use: '增量事务流水（?after= 游标）：谁发的、耗时、错在哪类',
                synonyms: ['事务流水', '通信记录', '耗时多少', '为什么超时'],
                preconditions: ['主站已 open'],
                example: 'elab_modbus action="transactions" after=0',
            },
            {
                tool: 'elab_modbus',
                action: 'close',
                use: '关主站（释放引擎，串口会话本身不关）',
                synonyms: ['断开从站', '关闭 modbus', 'close', '松开总线'],
                preconditions: ['主站已 open'],
                example: 'elab_modbus action="close"',
            },
        ],
    },
];
/** 旧工具名 → 新入口。旧名已下线但仍可映射时保留（兼容层据此生成别名工具）。 */
export const LEGACY_TOOLS = {
    elab_build: [{ tool: 'elab_run', action: 'build' }],
    elab_triple: [{ tool: 'elab_run', action: 'triple' }],
    elab_loop: [{ tool: 'elab_run', action: 'loop' }],
    elab_step: [{ tool: 'elab_run', action: 'step' }],
    elab_preview: [{ tool: 'elab_run', action: 'preview' }],
    elab_cancel: [{ tool: 'elab_run', action: 'cancel' }],
    elab_serial_monitor: [{ tool: 'elab_serial', action: 'monitor' }],
    elab_serial: [{ tool: 'elab_serial', action: 'write' }],
    elab_serial_decode: [{ tool: 'elab_serial', action: 'decode' }],
    elab_serial_decoded: [{ tool: 'elab_serial', action: 'decoded' }],
    elab_serial_stats: [{ tool: 'elab_serial', action: 'stats' }],
    elab_debug_open: [{ tool: 'elab_debug', action: 'open' }],
    elab_debug_control: [{ tool: 'elab_debug', action: 'control' }],
    elab_debug_breakpoint: [{ tool: 'elab_debug', action: 'breakpoint' }],
    elab_debug_wait: [{ tool: 'elab_debug', action: 'wait' }],
    elab_debug_close: [{ tool: 'elab_debug', action: 'close' }],
    elab_frame_profile: [
        {
            tool: 'elab_frame',
            actions: ['list', 'get', 'preview', 'save', 'delete', 'encode', 'templates', 'import'],
        },
        { tool: 'elab_frame_learn', actions: ['learn', 'verify', 'auto', 'codegen'] },
    ],
    elab_adapt: [{ tool: 'elab_pkg', action: 'adapt' }],
};
