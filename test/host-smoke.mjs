/**
 * 宿主半侧集成冒烟测试（**假宿主**，不需要 DSH、不需要网络、不碰真实 $DSH_HOME）。
 *
 * 做法：造一个最小 ctx（loader / tools / profileContext / connection / configEditor / pluginManager），
 * 调 `apply(ctx)` 注册 RPC 端点，然后**按真实信封**驱动 list / save / remove / setEnabled / heal。
 * 覆盖的是最容易在真机上翻车的路径：写回顺序、幂等、冲突检测、漂移与逃生口、密钥不回传。
 *
 * 运行：node --test .\test\host-smoke.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, RPC_ENDPOINT } from '../plugin-src/host/index.mjs'

const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
const SECRET_URL = 'https://mcp.example.com/mcp?secret-key=TOPSECRET'
const SECRET_ENV = 'ENVTOPSECRET'

/** 造一个最小假宿主；返回 { ctx, rpc, files }。 */
function harness({ home, rows = [], schemas = [], inventory = [] }) {
  const box = { overrides: new Map() }
  const ctx = {
    logger: { info() {}, warn() {} },
    profileContext: {
      name: 'web',
      home,
      dir: join(home, 'profiles', 'web'),
      patchPath: join(home, 'profiles', 'web', 'cordis.patch.yml'),
      installAnchor: '',
      cwd: home,
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    },
    loader: { entries: () => rows },
    tools: { schemas: () => schemas },
    connection: { fetch: { register: (options) => { box.endpoint = options; return () => {} } } },
    configEditor: {
      // 模拟官方语义（config-editor/src/index.ts:117-128）：继承值 = insert 声明的原配置；
      // 已有覆盖时以覆盖值为当前值；next 等于继承值时移除覆盖行。
      edit: async (entry, change) => {
        const id = entry.options.id
        const inherited = entry.options.__inherited ?? {}
        const current = box.overrides.has(id) ? box.overrides.get(id) : inherited
        const next = change(current, inherited)
        if (JSON.stringify(next) === JSON.stringify(inherited)) {
          box.overrides.delete(id)
          entry.options.config = inherited
        } else {
          box.overrides.set(id, next)
          entry.options.config = next
        }
      },
    },
    pluginManager: {
      listPlugins: async () => inventory,
      setPluginEnabled: async (id, enabled) => { box.lastEnable = { id, enabled }; return { applied: 'live' } },
    },
    inject: (deps, callback) => { if (deps.every((dep) => ctx[dep] !== undefined)) return callback(ctx) },
    get: (name) => ctx[name],
  }

  /** 按真实连接信封打一次 RPC。 */
  const rpc = async (method, payload = {}) => {
    const request = new Request(`http://local/api/${RPC_ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `r-${method}`,
        method: RPC_ENDPOINT,
        payload: { method, payload },
      }),
    })
    const response = await box.endpoint.fetch(request)
    const body = await response.json()
    assert.equal(body.type, 'server-response')
    assert.equal(body.rpcId, `r-${method}`)
    return body.result
  }

  const files = {
    patch: join(home, 'cordis.patch.yml'),
    store: join(home, 'mcp-manager', 'servers.json'),
  }
  return { ctx, rpc, files, box }
}

/** 一个手写（外部）行的假 Loader entry；`__inherited` 模拟 insert 行声明的原值。 */
function externalEntry(id, config) {
  return {
    id,
    options: { id, name: MCP_MODULE, config, __inherited: structuredClone(config) },
    fiber: { state: 'active' },
  }
}

/** 每个用例一个临时 DSH_HOME，用完即删。 */
async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'mcp-mgr-'))
  try {
    return await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('list：手写行被识别为 external，且 url / env 取值绝不回传', async () => {
  await withHome(async (home) => {
    const rows = [externalEntry('mcp-sorftime', {
      serverName: 'sorftime', transport: 'streamable-http', url: SECRET_URL,
    })]
    const { ctx, rpc } = harness({
      home,
      rows,
      schemas: [{ name: 'mcp__sorftime__get_time' }, { name: 'mcp__sorftime__product_search' }],
      inventory: [{ entryId: 'mcp-sorftime', moduleName: MCP_MODULE, enabled: true, fiberPhase: 'active' }],
    })
    apply(ctx)

    const result = await rpc('list')
    assert.equal(result.ok, true)
    const serialized = JSON.stringify(result.value)
    // 回传的路径必须**符号化**：页面里不得出现含用户名的绝对路径（隐私要求）
    assert.equal(result.value.paths.homePatch, '$DSH_HOME\\cordis.patch.yml')
    assert.equal(result.value.paths.profilePatch.startsWith('$DSH_HOME\\profiles'), true)
    assert.equal(serialized.includes(home), false, '回传载荷不得含绝对主目录路径')
    assert.equal(serialized.includes('TOPSECRET'), false, '密钥绝不能出现在回传载荷里')
    assert.equal(serialized.includes('secret-key'), false)
    const row = result.value.servers.find((item) => item.id === 'mcp-sorftime')
    assert.equal(row.origin, 'external')
    assert.equal(row.stage, 'active')
    assert.equal(row.toolCount, 2)
    assert.ok(row.urlMask.startsWith('https://mcp.example.com/'))
    assert.equal(result.value.writeEnabled, true)
  })
})

test('受管行：新增 → 清单 + 自有层落盘；重复 serverName 被拒；启停写 disabled', async () => {
  await withHome(async (home) => {
    const { ctx, rpc, files } = harness({ home })
    apply(ctx)

    const created = await rpc('save', {
      serverName: 'demo', transport: 'streamable-http', url: SECRET_URL, failOnStartupError: true,
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    const patch = await readFile(files.patch, 'utf8')
    assert.ok(patch.includes("id: 'mcpx-demo'"))
    assert.ok(patch.includes("name: '@deepseek-ai/dsh-mcp-client'"))
    assert.ok(patch.includes("transport: 'streamable-http'"))
    assert.ok(patch.includes('failOnStartupError: true'))
    const store = JSON.parse(await readFile(files.store, 'utf8'))
    assert.equal(store.servers.length, 1)
    assert.equal(store.rev.length, 64)

    // 同名再建 → 查重拦住
    const dup = await rpc('save', { serverName: 'demo', transport: 'streamable-http', url: SECRET_URL })
    assert.equal(dup.ok, false)
    assert.equal(dup.error.code, 'invalid-input')
    assert.ok(dup.error.details.errors.some((item) => item.code === 'duplicate-serverName'))

    // 清单有、活行没有 → 显示为 missing，不假装运行中
    const listed = await rpc('list')
    const row = listed.value.servers.find((item) => item.id === 'mcpx-demo')
    assert.equal(row.origin, 'managed')
    assert.equal(row.stage, 'missing')

    // 禁用 → 自有层渲染行级 disabled
    const off = await rpc('setEnabled', { id: 'mcpx-demo', enabled: false })
    assert.equal(off.ok, true, JSON.stringify(off))
    const offPatch = await readFile(files.patch, 'utf8')
    assert.ok(/disabled: true/.test(offPatch))

    // 删除 → 清单空 + 文件被移除
    const gone = await rpc('remove', { id: 'mcpx-demo' })
    assert.equal(gone.ok, true, JSON.stringify(gone))
    await assert.rejects(readFile(files.patch, 'utf8'), /ENOENT/)
  })
})

test('stdio 行：command/args/env/cwd 正确渲染，env 取值不回传', async () => {
  await withHome(async (home) => {
    const { ctx, rpc, files } = harness({ home })
    apply(ctx)

    const created = await rpc('save', {
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      args: '-y\n@modelcontextprotocol/server-github',
      env: `GITHUB_TOKEN=${SECRET_ENV}`,
      cwd: 'D:/work',
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    const patch = await readFile(files.patch, 'utf8')
    assert.ok(patch.includes("command: 'npx'"))
    assert.ok(patch.includes("- '@modelcontextprotocol/server-github'"))
    assert.ok(patch.includes(`GITHUB_TOKEN: '${SECRET_ENV}'`))
    assert.ok(patch.includes("cwd: 'D:/work'"))

    const listed = await rpc('list')
    const serialized = JSON.stringify(listed.value)
    assert.equal(serialized.includes(SECRET_ENV), false, 'env 取值绝不回传')
    const row = listed.value.servers.find((item) => item.id === 'mcpx-github')
    assert.deepEqual(row.envKeys, ['GITHUB_TOKEN'])
    assert.equal(row.envSet, true)
  })
})

test('手写行：改写走官方 configEditor（保留原有键）；无改动即拒绝；不可删', async () => {
  await withHome(async (home) => {
    const entry = externalEntry('mcp-sellersprite', {
      serverName: 'sellersprite', transport: 'streamable-http', url: SECRET_URL, toolCallTimeoutMs: 1234,
    })
    const { ctx, rpc } = harness({
      home,
      rows: [entry],
      inventory: [{ entryId: 'mcp-sellersprite', moduleName: MCP_MODULE, enabled: true, fiberPhase: 'active' }],
    })
    apply(ctx)

    // 什么都不改（url 留空）→ 明确拒绝，而不是无谓写盘
    const noop = await rpc('save', { id: 'mcp-sellersprite', serverName: 'sellersprite', transport: 'streamable-http', url: '' })
    assert.equal(noop.ok, false)
    assert.equal(noop.error.code, 'nothing-to-save')

    // 改 url → 官方通道；原有 toolCallTimeoutMs 必须保留（整段替换语义）
    const changed = await rpc('save', {
      id: 'mcp-sellersprite', serverName: 'sellersprite', transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp?secret-key=NEWKEY',
    })
    assert.equal(changed.ok, true, JSON.stringify(changed))
    assert.equal(entry.options.config.url, 'https://mcp.example.com/mcp?secret-key=NEWKEY')
    assert.equal(entry.options.config.toolCallTimeoutMs, 1234)
    assert.equal(entry.options.config.serverName, 'sellersprite')

    // 启停走官方 pluginManager
    const off = await rpc('setEnabled', { id: 'mcp-sellersprite', enabled: false })
    assert.equal(off.ok, true, JSON.stringify(off))

    // 手写行不可删
    const removeAttempt = await rpc('remove', { id: 'mcp-sellersprite' })
    assert.equal(removeAttempt.ok, false)
    assert.equal(removeAttempt.error.code, 'external-row-readonly')
  })
})

test('撤销覆盖：列表标 overridden + 掩码无长度 + revert 还原 insert 原值', async () => {
  await withHome(async (home) => {
    const original = {
      serverName: 'sorftime', transport: 'streamable-http', url: 'https://mcp.example.com/mcp?secret-key=ORIGINAL',
    }
    const entry = externalEntry('mcp-sorftime', original)
    const { ctx, rpc, box } = harness({
      home,
      rows: [entry],
      inventory: [{ entryId: 'mcp-sorftime', moduleName: MCP_MODULE, enabled: true, fiberPhase: 'active' }],
    })
    apply(ctx)

    // 改写一次 → 覆盖存在
    const changed = await rpc('save', {
      id: 'mcp-sorftime', serverName: 'sorftime', transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp?secret-key=NEWKEY',
    })
    assert.equal(changed.ok, true, JSON.stringify(changed))
    assert.equal(box.overrides.has('mcp-sorftime'), true)

    // profile patch 里出现同 id 顶层覆盖行 → 列表标 overridden；notes 只有「原手写行」；掩码不带长度
    await mkdir(join(ctx.profileContext.dir), { recursive: true })
    await writeFile(ctx.profileContext.patchPath, [
      '- id: mcp-sorftime',
      '  name: "@deepseek-ai/dsh-mcp-client"',
      '  config:',
      '    serverName: sorftime',
    ].join('\n') + '\n', 'utf8')
    const listed = await rpc('list')
    const row = listed.value.servers.find((item) => item.id === 'mcp-sorftime')
    assert.equal(row.overridden, true)
    assert.deepEqual(row.notes, ['原手写行'])
    assert.equal(row.urlMask, 'https://mcp.example.com/…')

    // 撤销 → 覆盖移除、配置回到 insert 原值
    const reverted = await rpc('revert', { id: 'mcp-sorftime' })
    assert.equal(reverted.ok, true, JSON.stringify(reverted))
    assert.equal(box.overrides.has('mcp-sorftime'), false)
    assert.equal(entry.options.config.url, original.url)

    // 受管行不适用「撤销覆盖」
    await rpc('save', { serverName: 'demo', transport: 'streamable-http', url: 'https://x.example.com/mcp' })
    const notApplicable = await rpc('revert', { id: 'mcpx-demo' })
    assert.equal(notApplicable.ok, false)
    assert.equal(notApplicable.error.code, 'not-applicable')
  })
})

test('id 双声明：与手写层同 id 的受管行被拦下', async () => {
  await withHome(async (home) => {
    const { ctx, rpc, files } = harness({ home })
    apply(ctx)
    // 先在自有层造一行，再把手写层文本改成含有同 id（模拟双声明）
    await rpc('save', { serverName: 'clash', transport: 'streamable-http', url: SECRET_URL })
    const patch = await readFile(files.patch, 'utf8')
    assert.ok(patch.includes("id: 'mcpx-clash'"))
    // 手写层里出现 mcpx-clash（模拟有人手写同 id）→ 面板转只读 + 保存被拒
    const profilePatch = ctx.profileContext.patchPath
    await mkdir(join(ctx.profileContext.dir), { recursive: true })
    await writeFile(profilePatch, '- insert:\n    - id: mcpx-clash\n      name: \'x\'\n', 'utf8')
    const listed = await rpc('list')
    assert.equal(listed.value.writeEnabled, true, '自有层未被外部改动，仍可写')
    const attempt = await rpc('save', { serverName: 'clash', transport: 'streamable-http', url: SECRET_URL })
    assert.equal(attempt.ok, false)
    assert.ok(attempt.error.details.errors.some((item) => item.code === 'id-conflict'))
  })
})

test('漂移与逃生口：外部改动 → 只读；heal 两条路都能恢复', async () => {
  await withHome(async (home) => {
    const { ctx, rpc, files } = harness({ home })
    apply(ctx)
    await rpc('save', { serverName: 'demo', transport: 'streamable-http', url: SECRET_URL })

    // 外部把自有层文件改坏（例如手工编辑）
    await writeFile(files.patch, '# 别人手写的\n- insert:\n    - id: foreign\n      name: \'x\'\n', 'utf8')

    const drifted = await rpc('list')
    assert.equal(drifted.value.drift.detected, true)
    assert.equal(drifted.value.drift.reason, 'foreign-file')
    assert.equal(drifted.value.writeEnabled, false)

    const blocked = await rpc('save', { serverName: 'demo2', transport: 'streamable-http', url: SECRET_URL })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error.code, 'drift-detected')

    // 逃生口 A：以清单为准重建
    const healed = await rpc('heal', { mode: 'overwrite' })
    assert.equal(healed.ok, true, JSON.stringify(healed))
    const afterHeal = await rpc('list')
    assert.equal(afterHeal.value.drift.detected, false)
    assert.equal(afterHeal.value.writeEnabled, true)

    // 逃生口 B：以文件为准清空清单
    const forgot = await rpc('heal', { mode: 'forget' })
    assert.equal(forgot.ok, true, JSON.stringify(forgot))
    const afterForget = await rpc('list')
    assert.equal(afterForget.value.servers.length, 0)
  })
})

test('RPC 契约：非法信封 / 未知方法 / 乐观锁 revision', async () => {
  await withHome(async (home) => {
    const { ctx, rpc, box } = harness({ home })
    apply(ctx)

    // 未知方法
    const unknown = await rpc('nope')
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown-method')

    // 信封不合法
    const bad = await box.endpoint.fetch(new Request('http://local/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'wrong', rpcId: 'r1', method: RPC_ENDPOINT, payload: { method: 'list', payload: {} } }),
    }))
    const badBody = await bad.json()
    assert.equal(badBody.result.ok, false)
    assert.equal(badBody.result.error.code, 'bad-request')

    // 乐观锁：过期的 expectedRev 必须拒绝
    const created = await rpc('save', { serverName: 'demo', transport: 'streamable-http', url: SECRET_URL })
    assert.equal(created.ok, true)
    const stale = await rpc('save', {
      id: 'mcpx-demo', serverName: 'demo', transport: 'streamable-http', url: '', expectedRev: 'deadbeef',
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'stale-revision')
  })
})
