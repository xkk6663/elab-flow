import { createRoot } from "react-dom/client";
import "./theme/global.css";
import App from "./App";

/**
 * 入口。
 *
 * ★ 刻意**不套 `<StrictMode>`**。React 18 的 StrictMode 在开发模式下会
 *   "挂载 → 卸载 → 再挂载"每个 effect，用来暴露清理不干净的问题。但本项目
 *   的 SSE 流与命令式日志渲染本来就是有副作用的：
 *     - 双挂载会开出两条 `/api/events` 连接，事件被**重复归约**（日志翻倍）；
 *     - 生产构建下 StrictMode 不双挂载，于是"开发时正常、构建后正常"，
 *       唯独 `npm run dev` 里日志错乱 —— 这种只在一种模式下出现的假 bug
 *       会白白吃掉排查时间。
 *   真正的清理正确性由 LogView / sse.ts 的 `close()` 保证，不靠 StrictMode。
 */
const host = document.getElementById("root");
if (!host) throw new Error("找不到 #root 容器");

createRoot(host).render(<App />);
