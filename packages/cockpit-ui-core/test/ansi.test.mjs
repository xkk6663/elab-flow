import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lineTone, parseAnsi, stripAnsi } from '../src/index.ts'

test('无 ESC：整行一个默认 span', () => {
  assert.deepEqual(parseAnsi('hello'), [{ text: 'hello', cls: '' }])
  assert.deepEqual(parseAnsi(''), [])
})

test('色变是状态机：后续文本携带颜色（不产出空 span）', () => {
  const spans = parseAnsi('\u001b[31mred\u001b[0m')
  assert.deepEqual(spans, [{ text: 'red', cls: 'a-red' }])
})

test('粗体 + 绿色 + 复位粗体后颜色保留', () => {
  const spans = parseAnsi('a \u001b[1;32mgb\u001b[22m green\u001b[0m z')
  assert.deepEqual(spans, [
    { text: 'a ', cls: '' },
    { text: 'gb', cls: 'a-green a-bold' },
    { text: ' green', cls: 'a-green' },
    { text: ' z', cls: '' },
  ])
})

test('stripAnsi / lineTone', () => {
  assert.equal(stripAnsi('\u001b[31merror\u001b[0m'), 'error')
  assert.equal(lineTone('\u001b[31mfatal error\u001b[0m'), 'alert')
  assert.equal(lineTone('warning: deprecated'), 'warn')
  assert.equal(lineTone('ok'), 'normal')
})
