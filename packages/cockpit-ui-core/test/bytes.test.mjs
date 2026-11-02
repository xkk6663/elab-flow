import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  asciiOf,
  b64ToBytes,
  byteClass,
  bytesToB64,
  captureText,
  hexDump,
  hexDumpRows,
  hexOf,
  textOf,
} from '../src/index.ts'

test('HEX / ASCII 投影', () => {
  const bytes = new Uint8Array([0x00, 0x41, 0x7f, 0xff])
  assert.equal(hexOf(bytes), '00 41 7F FF')
  assert.equal(asciiOf(bytes), '.A..')
})

test('hexDump 与 hexDumpRows 排版一致（16 字节一行、补齐 ..）', () => {
  const bytes = new Uint8Array([0x41, 0x42])
  const line = hexDump(bytes)[0]
  assert.match(line, /^0000  41 42 .. .. .. .. .. ..  .. .. .. .. .. .. .. ..  \|AB\|$/)

  const row = hexDumpRows(bytes)[0]
  assert.equal(row.offset, '0000')
  assert.equal(row.cells[0].text, '41')
  assert.equal(row.cells[2].cls, 'pad')
  assert.equal(row.ascii[0].text, 'A')
})

test('字节分类', () => {
  assert.equal(byteClass(0x00), 'ctl')
  assert.equal(byteClass(0x7f), 'del')
  assert.equal(byteClass(0x41), 'print')
  assert.equal(byteClass(0xff), 'high')
})

test('base64 往返', () => {
  const bytes = new Uint8Array([0, 1, 2, 254, 255])
  assert.deepEqual(b64ToBytes(bytesToB64(bytes)), bytes)
})

test('textOf：非 UTF-8 编码回退不抛', () => {
  const bytes = new TextEncoder().encode('hello')
  assert.equal(textOf(bytes, 'utf8'), 'hello')
  assert.equal(textOf(bytes, 'hex'), '68 65 6C 6C 6F')
})

test('captureText 带头部与逐批 HEX', () => {
  const text = captureText([{ seq: 3, dir: 'rx', t: '12:00:00', bytes: new Uint8Array([0x41]) }])
  assert.match(text, /# elab serial capture/)
  assert.match(text, /# chunks: 1/)
  assert.match(text, /#00003 RX 12:00:00 \(1 B\)/)
})
