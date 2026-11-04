/**
 * Client 侧的最小环境声明。
 *
 * 为什么需要它：Client 产物运行在宿主的模块表里（React 由 `require('react')`
 * 提供、`window.__ModuleLoader__` 由引导脚本注入），编译期既没有 react 的
 * 类型包、也没有这些全局声明。这里只声明**实际用到的那一小部分**，
 * 让 strict 能保留对真实逻辑的检查，而不是用 `noImplicitAny: false` 全放开。
 */

/** 宿主引导脚本注入的模块表加载器。 */
interface ModuleLoader {
  load(entry: { id: string; factory: (require: (name: string) => any) => unknown }): void
}

interface Window {
  __ModuleLoader__: ModuleLoader
}

/** React 的最小面（只声明本包用到的 API）。 */
declare module 'react' {
  export type ReactNode = unknown
  export type ReactElement = unknown
  export type CSSProperties = Record<string, string | number | undefined>
  export interface MutableRefObject<T> {
    current: T
  }
  export interface ResizeObserverEntryLike {
    target: Element
    contentRect: { width: number; height: number }
  }
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  export function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useRef<T>(initial: T): MutableRefObject<T>
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]): T
  export function useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T
}

/** 动态 Client 上下文的最小面。 */
interface ClientSlotContext {
  slots: {
    inject(ownerKey: string, callback: () => unknown): () => void
    register(entry: { name: string; id: string }, component: unknown): () => void
  }
}

/**
 * 经典 JSX 转换（tsconfig `jsx: "react"`）下需要的全局 JSX 命名空间。
 *
 * 为什么不用 `react-jsx`：那要求 `react/jsx-runtime` 的类型存在，而本包
 * 刻意不依赖 React 类型包（宿主提供 React，我们只声明用到的 API）。
 * 经典转换只要求全局 `JSX`，这里用最宽松的声明把类型检查留给我们的逻辑本身。
 */
declare namespace JSX {
  type Element = unknown
  interface IntrinsicElements {
    [elemName: string]: any
  }
}

declare module 'react' {
  const React: {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
    useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void]
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void
    useRef: <T>(initial: T) => { current: T }
    useMemo: <T>(factory: () => T, deps: readonly unknown[]) => T
    useCallback: <T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]) => T
    useSyncExternalStore: <T>(sub: (cb: () => void) => () => void, get: () => T, get2?: () => T) => T
  }
  export default React
}

declare namespace React {
  type CSSProperties = Record<string, string | number | undefined>
  type ReactElement = unknown
  interface KeyboardEvent<T = Element> { currentTarget: T; key: string }
  interface ChangeEvent<T = Element> { currentTarget: T }
  interface FormEvent<T = Element> { preventDefault(): void; currentTarget: T }
  /** 波形画布的缩放 / 拖拽手势（只声明用到的字段）。 */
  interface MouseEvent<T = Element> { currentTarget: T; clientX: number; clientY: number; shiftKey: boolean; preventDefault(): void }
  interface WheelEvent<T = Element> extends MouseEvent<T> { deltaY: number }
}
