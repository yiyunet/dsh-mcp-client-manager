/**
 * 生成物与漂移检测单测：`node --test test/`（不写任何文件，全部纯函数）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { MANAGED_MARK, MCP_CLIENT_MODULE, checkDrift, renderPatch } from '../plugin-src/host/store.mjs'

const http = {
  id: 'mcpx-sorftime',
  serverName: 'sorftime',
  transport: 'streamable-http',
  url: 'https://mcp.sorftime.com?key=SECRET',
  failOnStartupError: false,
}

const stdio = {
  id: 'mcpx-github',
  serverName: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: "it's-a-token" },
  cwd: '/tmp/work',
  failOnStartupError: true,
}

test('renderPatch：确定性（同输入必同输出）且带接管标记与 rev', () => {
  const first = renderPatch([http, stdio])
  const second = renderPatch([stdio, http])
  assert.equal(first.text, second.text, '排序后应与输入顺序无关')
  assert.equal(first.rev, second.rev)
  assert.ok(first.text.includes(MANAGED_MARK))
  assert.match(first.text, /^# rev: [0-9a-f]{64}$/m)
  assert.equal(first.empty, false)
})

test('renderPatch：http 行渲染三字段 + 模块名 + id', () => {
  const { text } = renderPatch([http])
  assert.ok(text.includes(`- id: 'mcpx-sorftime'`))
  assert.ok(text.includes(`name: '${MCP_CLIENT_MODULE}'`))
  assert.ok(text.includes(`serverName: 'sorftime'`))
  assert.ok(text.includes(`transport: 'streamable-http'`))
  assert.ok(text.includes(`url: 'https://mcp.sorftime.com?key=SECRET'`))
  assert.equal(text.includes('failOnStartupError'), false, '未开启时不渲染该键')
  assert.ok(text.includes('- insert:'))
})

test('renderPatch：stdio 行渲染 command/args/env/cwd，单引号双写', () => {
  const { text } = renderPatch([stdio])
  assert.ok(text.includes(`command: 'npx'`))
  assert.ok(text.includes(`- '-y'`))
  assert.ok(text.includes(`- '@modelcontextprotocol/server-github'`))
  assert.ok(text.includes(`GITHUB_TOKEN: 'it''s-a-token'`), '单引号必须双写')
  assert.ok(text.includes(`cwd: '/tmp/work'`))
  assert.ok(text.includes('failOnStartupError: true'))
})

test('renderPatch：空清单渲染顶层空数组', () => {
  const { text, empty } = renderPatch([])
  assert.equal(empty, true)
  assert.ok(text.includes('[]'))
  assert.equal(text.includes('- insert:'), false)
})

test('renderPatch：disabled 是行级键（与 id/name 同级）', () => {
  const { text } = renderPatch([{ ...http, disabled: true }])
  const lines = text.split('\n')
  const idLine = lines.findIndex((line) => line.includes('- id: '))
  assert.ok(lines[idLine + 1].includes('name: '))
  assert.equal(lines[idLine + 2].trim(), 'disabled: true')
})

test('checkDrift：我们自己写的文件 → 无漂移', () => {
  const { text, rev } = renderPatch([http, stdio])
  const result = checkDrift(text, { rev, servers: [http, stdio] })
  assert.equal(result.detected, false)
  assert.equal(result.reason, 'ok')
})

test('checkDrift：内容被改一个字 → content-changed', () => {
  const { text, rev } = renderPatch([http, stdio])
  const tampered = text.replace('sorftime', 'sorftime2')
  const result = checkDrift(tampered, { rev, servers: [http, stdio] })
  assert.equal(result.detected, true)
  assert.equal(result.reason, 'content-changed')
})

test('checkDrift：不是我们的文件（无标记）→ foreign-file', () => {
  const result = checkDrift('- insert:\n    - id: hand-written\n', { rev: '', servers: [http] })
  assert.equal(result.detected, true)
  assert.equal(result.reason, 'foreign-file')
})

test('checkDrift：有标记但缺 rev 行 → no-rev', () => {
  const { text } = renderPatch([http])
  const withoutRev = text.replace(/^# rev: [0-9a-f]{64}\n/m, '')
  const result = checkDrift(withoutRev, { rev: '', servers: [http] })
  assert.equal(result.detected, true)
  assert.equal(result.reason, 'no-rev')
})

test('checkDrift：清单有行但文件不在 → missing-file；清单为空且文件不在 → absent', () => {
  assert.equal(checkDrift(undefined, { rev: '', servers: [http] }).reason, 'missing-file')
  assert.equal(checkDrift(undefined, { rev: '', servers: [] }).reason, 'absent')
})
