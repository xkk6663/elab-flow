/** `node --import` 预载：注册测试期的共享层解析钩子（见 core-resolver.mjs）。 */
import { register } from 'node:module'

register('./core-resolver.mjs', import.meta.url)
