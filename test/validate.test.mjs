/**
 * 纯函数层单测：`node --test test/`（无需宿主、无需构建、无网络）。
 * 断言的是**契约**，不是实现细节：合法/非法的边界、错误码字面量、前三重冲突检测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectPatchIds, idForServerName, normalizeInput, slugify, validateExternalPatch, validateServer,
} from '../plugin-src/host/validate.mjs'

test('slugify 把 serverName 收敛成安全 id 片段', () => {
  assert.equal(slugify('Sorftime'), 'sorftime')
  assert.equal(slugify('my_server.name'), 'my-server-name')
  assert.equal(slugify('--Weird--'), 'weird')
  assert.equal(slugify(''), 'unnamed')
  assert.equal(slugify('A'.repeat(50)).length, 32)
})

test('受管行 id 强制 mcpx- 前缀', () => {
  assert.equal(idForServerName('sorftime'), 'mcpx-sorftime')
  assert.ok(idForServerName('Sellersprite').startsWith('mcpx-'))
})

test('collectPatchIds 弱扫 patch 文本（含嵌在 insert 列表里的行）', () => {
  const text = [
    '- insert:',
    '    - id: mcp-sellersprite',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '- id: some-override',
    '  config:',
    "    note: 'id: not-a-row'",
  ].join('\n')
  const ids = collectPatchIds(text)
  assert.ok(ids.has('mcp-sellersprite'))
  assert.ok(ids.has('some-override'))
  assert.equal(ids.has('not-a-row'), false)
})

test('normalizeInput 把多行文本拆成 args / env', () => {
  const draft = normalizeInput({
    serverName: ' demo ',
    transport: 'stdio',
    command: ' npx ',
    args: '-y\n@modelcontextprotocol/server-github\n',
    env: 'GITHUB_TOKEN=abc\nEMPTY=\nBADLINE\n',
  })
  assert.equal(draft.serverName, 'demo')
  assert.equal(draft.command, 'npx')
  assert.deepEqual(draft.args, ['-y', '@modelcontextprotocol/server-github'])
  assert.deepEqual(draft.env, { GITHUB_TOKEN: 'abc', EMPTY: '' })
})

test('validateServer：http 建行合法 → 产出 mcpx- id 与三字段', () => {
  const result = validateServer(normalizeInput({
    serverName: 'sorftime', transport: 'streamable-http', url: 'https://mcp.sorftime.com?key=abc',
  }), { mode: 'create' })
  assert.equal(result.ok, true)
  assert.equal(result.value.id, 'mcpx-sorftime')
  assert.equal(result.value.url, 'https://mcp.sorftime.com?key=abc')
  assert.equal(result.value.failOnStartupError, false)
})

test('validateServer：建行缺 url / serverName 非法 / transport 不在枚举内', () => {
  const noUrl = validateServer(normalizeInput({ serverName: 'a', transport: 'streamable-http' }), { mode: 'create' })
  assert.equal(noUrl.ok, false)
  assert.equal(noUrl.errors[0].code, 'invalid-url')

  const badName = validateServer(normalizeInput({ serverName: '有中文', transport: 'streamable-http', url: 'https://x/mcp' }), { mode: 'create' })
  assert.equal(badName.ok, false)
  assert.equal(badName.errors[0].code, 'invalid-serverName')

  const badTransport = validateServer(normalizeInput({ serverName: 'a', transport: 'sse', url: 'https://x/mcp' }), { mode: 'create' })
  assert.equal(badTransport.ok, false)
  assert.equal(badTransport.errors[0].code, 'unsupported-transport')
})

test('validateServer：serverName 查重（保存前），但编辑自己不算冲突', () => {
  const context = {
    mode: 'create',
    liveNames: ['sorftime'],
    liveServers: [{ id: 'mcp-sorftime', serverName: 'sorftime' }],
  }
  const clash = validateServer(normalizeInput({ serverName: 'sorftime', transport: 'streamable-http', url: 'https://x/mcp' }), context)
  assert.equal(clash.ok, false)
  assert.ok(clash.errors.some((item) => item.code === 'duplicate-serverName'))

  const self = validateServer(normalizeInput({ serverName: 'sorftime', transport: 'streamable-http' }), {
    mode: 'edit',
    editingId: 'mcpx-sorftime',
    liveNames: ['sorftime'],
    liveServers: [{ id: 'mcpx-sorftime', serverName: 'sorftime' }],
    managedServers: [{ id: 'mcpx-sorftime', serverName: 'sorftime' }],
    managedNames: ['sorftime'],
  })
  assert.equal(self.ok, true, JSON.stringify(self.errors))
  assert.equal(self.value.url, '')
})

test('validateServer：id 冲突三级检测（活动行 / 受管清单 / 手写层）', () => {
  const draft = normalizeInput({ serverName: 'sorftime', transport: 'streamable-http', url: 'https://x/mcp' })
  const againstPatch = validateServer(draft, { mode: 'create', patchIds: new Set(['mcpx-sorftime']) })
  assert.equal(againstPatch.ok, false)
  assert.ok(againstPatch.errors.some((item) => item.code === 'id-conflict'))

  const againstLive = validateServer(draft, { mode: 'create', liveIds: new Set(['mcpx-sorftime']) })
  assert.equal(againstLive.ok, false)

  const againstManaged = validateServer(draft, { mode: 'create', managedIds: new Set(['mcpx-sorftime']) })
  assert.equal(againstManaged.ok, false)
})

test('validateServer：stdio 建行要 command；env 键名不合法要拦', () => {
  const noCommand = validateServer(normalizeInput({ serverName: 'gh', transport: 'stdio' }), { mode: 'create' })
  assert.equal(noCommand.ok, false)
  assert.ok(noCommand.errors.some((item) => item.code === 'invalid-command'))

  const badEnv = validateServer(normalizeInput({
    serverName: 'gh', transport: 'stdio', command: 'npx', env: '1BAD=x',
  }), { mode: 'create' })
  assert.equal(badEnv.ok, false)
  assert.ok(badEnv.errors.some((item) => item.code === 'invalid-env'))

  const ok = validateServer(normalizeInput({
    serverName: 'gh', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-github', env: 'GITHUB_TOKEN=t',
  }), { mode: 'create' })
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  assert.deepEqual(ok.value.args, ['-y', '@modelcontextprotocol/server-github'])
  assert.deepEqual(ok.value.env, { GITHUB_TOKEN: 't' })
})

test('validateExternalPatch：只校验凭据族字段的形态', () => {
  assert.deepEqual(validateExternalPatch('streamable-http', { url: 'not-a-url' }).map((item) => item.code), ['invalid-url'])
  assert.deepEqual(validateExternalPatch('stdio', { command: 'a\nb' }).map((item) => item.code), ['invalid-command'])
  assert.deepEqual(validateExternalPatch('stdio', { env: { '1BAD': 'x' } }).map((item) => item.code), ['invalid-env'])
  assert.deepEqual(validateExternalPatch('streamable-http', { url: 'https://ok/mcp' }), [])
})
