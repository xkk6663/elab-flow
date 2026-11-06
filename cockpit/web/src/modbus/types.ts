/**
 * Modbus 面板的视图类型 —— **已上移到共享层**。
 *
 * 2026-11-06：DSH 窄栏也长出了 Modbus 面板，两份定义会悄悄分叉，
 * 所以字段形状统一住在 `@elab/cockpit-ui-core/src/icd.ts`（权威仍是
 * `services/elab/modbusmaster.py`）。本文件只剩一个转发，
 * 让 `cockpit/web` 既有的 `from "../modbus/types"` 保持不动。
 */

export type {
  ModbusEngineState,
  ModbusMap,
  ModbusPointDef,
  ModbusPointLive,
  ModbusRunResult,
  ModbusStateResponse,
  ModbusStats,
  ModbusTxn,
} from "@elab/cockpit-ui-core";
