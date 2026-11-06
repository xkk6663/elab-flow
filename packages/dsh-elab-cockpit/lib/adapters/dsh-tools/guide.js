/**
 * agent 侧使用契约 —— 常驻系统提示段 + `elab_guide` 工具的正文。
 *
 * 渐进披露三层（每层只放该层该说的）：
 *   ① 常驻话术（AGENT_USAGE，进程级，跨工程生效）—— 只给**路由表**与纪律；
 *   ② `elab_guide`（按需拉）—— 完整意图树：每个入口带同义词、前置条件、调用示例；
 *   ③ `.agents/skills/elab-tools/SKILL.md`（工作区级）—— 任务级流程与排障。
 *
 * ★ 同义词与前置条件来自**真实约束**（domain/tools.ts 的 TOOL_GROUPS），
 *   不是编的：写门控来自 allowAgentWrite、串口让位来自内核互斥、
 *   调试可用性来自 capabilities.meta.debug。
 */
import { LEGACY_TOOLS, TOOL_CONTRACTS, TOOL_GROUPS } from "../../domain/tools.js";
/**
 * agent 侧使用契约（常驻系统提示段与 `elab_guide` 工具共用同一份文案）。
 * 只放编排话术与纪律；步骤标签 / 档位定义仍以内核 `STEP_META` / `KERNEL_PLANS` 为准。
 *
 * ★ 长度纪律：常驻段要短（它每轮都在上下文里）；细节留给 elab_guide。
 */
export const AGENT_USAGE = [
    'elab 驾驶舱插件已挂载（DSH 右栏 ELAB 面板）。',
    '- 嵌入式固件任务优先用 elab_* 工具，不要手写 cmake / openocd / pyocd 命令。',
    '- 先 elab_status 拿工程名与每步可用性，再按意图选门面：编译烧录闭环 → elab_run；串口 → elab_serial；调试 → elab_debug；帧协议 → elab_frame（管理）/ elab_frame_learn（自学习）；芯片包与工程接入 → elab_pkg。',
    '- 高频快捷入口：elab_log（读日志）、elab_serial_read（读字节）、elab_serial_wait（等一行）、elab_debug_inspect（看变量/寄存器）。',
    '- 单飞：同一会话同时只允许 1 个 run；串口监视会自动让位给烧录/调试（内核挂起并恢复），无需先关监视；串口写、适配写盘、录制受 allowAgentWrite 门控，被拒时告知用户开权限，不要绕路重试。',
    '- 你发起的 run 会实时出现在右栏面板，用户可见也可取消；「LED 均匀闪烁」只能由用户肉眼确认，你只凭串口 tick / toggles 判活。',
    '- 需要完整工具树与旧名迁移表时调 elab_guide。',
].join('\n');
/** 旧名 → 新调用写法（迁移表；agent 沿用老脚本时自纠用）。 */
export function migratedTools() {
    const out = {};
    for (const [legacy, targets] of Object.entries(LEGACY_TOOLS)) {
        out[legacy] = targets
            .map((t) => (t.action !== undefined ? `${t.tool} action="${t.action}"` : t.tool))
            .join(' 或 ');
    }
    return out;
}
/** 扁平工具索引（注册面快照；name 唯一、elab_ 前缀）。 */
export function toolIndex() {
    return Object.values(TOOL_CONTRACTS).map((c) => ({
        name: c.name,
        use: c.summary,
        kind: c.kind,
        group: c.group,
        ...(c.actions !== undefined ? { actions: c.actions } : {}),
    }));
}
/**
 * `elab_guide` 的结构化正文（渐进披露：常驻提示只留 AGENT_USAGE）。
 *
 * @param topic 只取一组（overview/run/serial/debug/frame/pkg）；缺省返回全树。
 */
export function agentGuidePayload(topic) {
    const wanted = topic !== undefined && topic !== '' ? topic.trim() : '';
    const groups = wanted === '' ? TOOL_GROUPS : TOOL_GROUPS.filter((g) => g.id === wanted);
    return {
        ok: true,
        usage: AGENT_USAGE,
        // 意图树：group → 入口（带同义词/前置条件/示例）
        groups: groups.map((g) => ({
            id: g.id,
            title: g.title,
            intent: g.intent,
            preconditions: [...g.preconditions],
            entries: g.entries.map((e) => ({
                tool: e.tool,
                ...(e.action !== undefined ? { action: e.action } : {}),
                use: e.use,
                synonyms: [...e.synonyms],
                preconditions: [...e.preconditions],
                example: e.example,
            })),
        })),
        // 扁平索引（注册面快照）
        tools: toolIndex(),
        // 旧工具名 → 新入口（老脚本/老记忆里的名字仍能自纠）
        migrated: migratedTools(),
        rules: [
            '同一会话单飞：最多 1 个 run；human-busy 时等结束或请用户取消，不要重试刷屏。',
            '串口让位：监视开着也能直接发起含烧录/调试的 run —— 内核自动挂起监视、释放口，run 收尾按 serial.resume_after_run 恢复；不要先让用户关监视。',
            '写门控：串口写 / 适配写盘 / 录制默认被 allowAgentWrite 拒绝；如实转告用户怎么开。',
            '可视化：发起 run 后右栏面板自动点亮阶梯与通道日志；失败时把对应通道日志尾转述给人。',
            '判活纪律：agent 只读串口 tick / toggles；「LED 均匀闪烁」必须由用户肉眼确认。',
        ],
        panel: '右栏 ELAB：工程行 · 适配横幅 · 阶段梯 · 三连/闭环/取消/预览 · 构建/烧录/调试/串口通道日志 · 串口四视图。',
    };
}
