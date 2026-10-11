/**
 * dsh-mcp-client-manager —— 宿主半侧入口。
 *
 * 职责：面板 RPC（list / save / remove / setEnabled / state）+ 写回编排。
 * 写回模型：
 *   - 受管行（`mcpx-*`）：写自有层 `$DSH_HOME/cordis.patch.yml`（全量重写，HMR 热生效）。
 *   - 手写行（profile patch 里的行）：只走**官方通道**改写凭据族字段 / 启停，不删除、不改标识与协议。
 *   - url 与 env 取值**永不回传**；未改的凭据族字段不重写。
 *
 * 降级策略：`connection` 只在 web 平面存在，故走可选注入（写进顶层 inject 会让本插件
 * 在 headless/tui 平面永远停在 inactive —— 实测踩过该坑）。
 * @module dsh-mcp-client-manager
 */

import {
  ManagerError, adapterState, listRows, overwriteExternalConfig, revertExternalConfig, setRowEnabled, toDto, toolNamesFor,
} from './adapter.mjs'
import {
  checkDrift, collectTopLevelOverrideIds, homePatchPath, readPatchText, readStore, readTextIfExists, removePatch,
  renderPatch, storePath, writePatch, writeStore, MANAGED_MARK,
} from './store.mjs'
import { collectPatchIds, normalizeInput, validateExternalPatch, validateServer } from './validate.mjs'

/** 插件名（Loader 行 id 与本文件无关，但保持一致便于排查）。 */
export const name = 'mcp-client-manager'
/** 顶层注入：任何 profile 启动的宿主都有这三个服务。 */
export const inject = ['loader', 'tools', 'profileContext']
/** RPC 端点名（不含 /api/ 前缀）—— 客户端必须用同一个。 */
export const RPC_ENDPOINT = 'mcp-client-manager'

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {void}
 */
export function apply(ctx) {
  const profile = ctx.profileContext
  const home = profile.home
  const paths = { home, homePatch: homePatchPath(home), store: storePath(home), profilePatch: profile.patchPath, profileDir: profile.dir }
  const api = createApi(ctx, profile)

  /** RPC 注册状态（供 state 自检）。 */
  const rpcState = { registered: false, reason: '等待 connection 服务（仅 web 平面存在）' }
  ctx.inject(['connection'], (rpcCtx) => {
    const dispose = registerRpc(rpcCtx, api)
    rpcState.registered = typeof dispose === 'function'
    rpcState.reason = rpcState.registered ? 'ok' : 'connection.fetch.register 不可用'
    ctx.logger?.info?.(`[mcp-client-manager] RPC ${rpcState.registered ? '已注册' : '未注册'}：${rpcState.reason}`)
    return dispose
  })

  ctx.logger?.info?.(`[mcp-client-manager] 就绪：自有层 ${paths.homePatch}`)
}

/**
 * 组装 RPC 方法表。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{home: string, name: string}} profile
 * @returns {Record<string, (payload: any) => Promise<object>>}
 */
function createApi(ctx, profile) {
  const home = profile.home
  const profileName = profile.name
  const toolsOf = (serverName) => toolNamesFor(ctx, serverName)

  /** 一次性快照：清单 + 活行 + 生成物 + 漂移 + 适配器状态。 */
  async function snapshot() {
    const store = await readStore(home, profileName)
    const { rows, inventory } = await listRows(ctx)
    const patchText = await readPatchText(home)
    // 三级 id 冲突检测的第三级：手写层（profile patch）文本弱扫 —— 只取 id，绝不把该文件正文带出
    const profilePatchText = await readTextIfExists(ctx.profileContext.patchPath)
    const scannedIds = new Set([
      ...collectPatchIds(patchText),
      ...collectPatchIds(profilePatchText),
    ])
    // 手写行是否已被面板覆盖（profile patch 里存在同 id 的顶层覆盖行）
    const overriddenIds = collectTopLevelOverrideIds(profilePatchText)
    const byId = new Map(rows.map((row) => [row.id, row]))
    const servers = []
    for (const record of store.servers) {
      const live = byId.get(record.id)
      if (live !== undefined) {
        const dto = toDto(live, record, toolsOf)
        dto.enabled = live.enabled
        dto.stage = live.stage
        servers.push(dto)
      } else {
        servers.push(managedOrphan(record))
      }
    }
    for (const row of rows) {
      if (store.servers.some((record) => record.id === row.id)) continue
      const dto = toDto(row, undefined, toolsOf)
      dto.overridden = overriddenIds.has(row.id)
      servers.push(dto)
    }
    const drift = checkDrift(patchText, store)
    const adapters = adapterState(ctx)
    return {
      store,
      rows,
      servers,
      drift,
      patchText,
      patchIds: scannedIds,
      adapters,
      inventory,
      probe: servers.some((item) => item.toolCount > 0) ? 'ok' : (servers.length === 0 ? 'no-servers' : 'empty'),
    }
  }

  /** 写回：先清单后生成物；生成物写失败则回滚清单。 */
  async function persist(previousStore, nextServers) {
    const rendered = renderPatch(nextServers)
    const nextStore = {
      version: previousStore.version,
      forProfile: profileName,
      rev: rendered.rev,
      servers: nextServers,
    }
    await writeStore(home, nextStore)
    try {
      if (rendered.empty) await removePatch(home)
      else await writePatch(home, rendered.text)
    } catch (error) {
      await writeStore(home, previousStore).catch(() => {})
      throw new ManagerError('write-failed', `写自有层失败：${String(error?.message ?? error)}`)
    }
    return { rendered, nextStore }
  }

  /** 等热重载落地，然后回读该行状态（400ms 是经验值；失败也只是回读旧状态）。 */
  async function afterApply(id) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    try {
      const next = await snapshot()
      return next.servers.find((item) => item.id === id) ?? null
    } catch {
      return null
    }
  }

  const guards = (snap, payload) => {
    if (snap.drift.detected) {
      throw new ManagerError('drift-detected', '自有层文件被外部改动，面板已转只读：请先在面板里处理漂移', { reason: snap.drift.reason })
    }
    const expected = typeof payload?.expectedRev === 'string' && payload.expectedRev !== '' ? payload.expectedRev : undefined
    if (expected !== undefined && expected !== snap.store.rev) {
      throw new ManagerError('stale-revision', '清单已被其它页面改动，请刷新后重试')
    }
  }

  /** 回传给浏览器的路径一律**符号化**：页面里绝不出现含用户名的绝对路径。 */
  const symbolic = (absolute) => {
    const text = String(absolute ?? '')
    if (text === '') return ''
    if (home !== '' && text.startsWith(home)) {
      return `$DSH_HOME${text.slice(home.length).replace(/[\\/]+/g, '\\')}`
    }
    return text.replace(/[\\/]+/g, '\\')
  }

  return {
    /** 自检：路径、服务就绪、漂移、清单规模。 */
    async state() {
      const snap = await snapshot()
      return {
        profile: profileName,
        paths: {
          homePatch: symbolic(homePatchPath(home)),
          store: symbolic(storePath(home)),
          profilePatch: symbolic(ctx.profileContext.patchPath),
        },
        adapters: snap.adapters,
        inventory: snap.inventory,
        drift: snap.drift,
        toolsProbe: snap.probe,
        counts: {
          managed: snap.store.servers.length,
          live: snap.rows.length,
          managedMissingLive: snap.servers.filter((item) => item.stage === 'missing').length,
          scannedIds: snap.patchIds.size,
        },
      }
    },

    /** 列表：受管行 + 手写行（含状态与工具数）。 */
    async list() {
      const snap = await snapshot()
      return {
        profile: profileName,
        paths: {
          homePatch: symbolic(homePatchPath(home)),
          store: symbolic(storePath(home)),
          profilePatch: symbolic(ctx.profileContext.patchPath),
        },
        servers: snap.servers,
        revision: snap.store.rev,
        drift: snap.drift,
        adapters: snap.adapters,
        toolsProbe: snap.probe,
        writeEnabled: snap.adapters.loader && snap.adapters.profileContext && !snap.drift.detected,
        inventory: snap.inventory,
      }
    },

    /** 新增（无 id）或改写（有 id）。 */
    async save(payload = {}) {
      const snap = await snapshot()
      guards(snap, payload)
      const editingId = typeof payload.id === 'string' && payload.id !== '' ? payload.id : undefined
      const managed = editingId === undefined ? undefined : snap.store.servers.find((item) => item.id === editingId)
      const externalRow = editingId === undefined
        ? undefined
        : snap.rows.find((row) => row.id === editingId && managed === undefined)

      if (editingId !== undefined && managed === undefined && externalRow === undefined) {
        throw new ManagerError('not-found', `找不到行 ${editingId}`)
      }

      const draft = normalizeInput(payload)

      // ── 手写行：官方通道，只改凭据族字段（标识与协议冻结：官方编辑服务的能力边界）
      if (externalRow !== undefined) {
        const transport = externalRow.config?.transport === 'stdio' ? 'stdio' : 'streamable-http'
        const patch = {}
        if (transport === 'stdio') {
          if (payload.command !== undefined && draft.command !== '') patch.command = draft.command
          if (payload.args !== undefined) patch.args = draft.args
          if (payload.env !== undefined && Object.keys(draft.env).length > 0) patch.env = draft.env
          if (payload.cwd !== undefined) patch.cwd = draft.cwd
        } else if (payload.url !== undefined && draft.url !== '') {
          patch.url = draft.url
        }
        if (payload.failOnStartupError !== undefined) patch.failOnStartupError = draft.failOnStartupError
        if (Object.keys(patch).length === 0) {
          throw new ManagerError('nothing-to-save', '没有检测到改动（凭据族字段留空 = 保留原值）')
        }
        const fieldErrors = validateExternalPatch(transport, patch)
        if (fieldErrors.length > 0) throw new ManagerError('invalid-input', '校验未通过', { errors: fieldErrors })
        await overwriteExternalConfig(ctx, editingId, patch)
        return { ok: true, applied: 'live', revision: snap.store.rev, row: await afterApply(editingId) }
      }

      // ── 受管行：校验 → 写清单 → 重写自有层
      const mode = managed === undefined ? 'create' : 'edit'
      const result = validateServer(draft, {
        liveIds: snap.rows.map((row) => row.id),
        managedIds: snap.store.servers.map((item) => item.id),
        patchIds: snap.patchIds,
        liveNames: snap.rows.map((row) => row.config?.serverName).filter((value) => typeof value === 'string'),
        managedNames: snap.store.servers.map((item) => item.serverName),
        managedServers: snap.store.servers,
        liveServers: snap.rows.map((row) => ({ id: row.id, serverName: row.config?.serverName })),
        editingId,
        mode,
      })
      if (!result.ok) throw new ManagerError('invalid-input', '校验未通过', { errors: result.errors })

      const value = result.value
      const now = new Date().toISOString()
      const record = {
        id: value.id,
        serverName: value.serverName,
        transport: value.transport,
        failOnStartupError: value.failOnStartupError,
        disabled: managed?.disabled === true,
        addedAt: managed?.addedAt ?? now,
        lastAppliedAt: now,
      }
      if (value.transport === 'stdio') {
        // command / env 属凭据族：空 = 保留原值；args / cwd 由面板预填，按提交值直取（清空即清空）
        record.command = value.command !== '' ? value.command : (managed?.command ?? '')
        if (record.command === '') throw new ManagerError('invalid-input', '校验未通过', { errors: [{ code: 'invalid-command', field: 'command', message: 'stdio 行的 command 必填' }] })
        record.args = value.args
        record.env = Object.keys(value.env).length > 0 ? value.env : (managed?.env ?? {})
        record.cwd = value.cwd
      } else {
        record.url = value.url !== '' ? value.url : (managed?.url ?? '')
        if (record.url === '') throw new ManagerError('invalid-input', '校验未通过', { errors: [{ code: 'invalid-url', field: 'url', message: 'url 必填' }] })
      }

      const nextServers = [...snap.store.servers.filter((item) => item.id !== editingId && item.id !== record.id), record]
      const { rendered } = await persist(snap.store, nextServers)
      return {
        ok: true,
        applied: 'live',
        revision: rendered.rev,
        created: mode === 'create',
        row: await afterApply(record.id),
      }
    },

    /** 删除受管行（手写行拒绝，请改用启停）。 */
    async remove(payload = {}) {
      const snap = await snapshot()
      guards(snap, payload)
      const id = typeof payload.id === 'string' ? payload.id : ''
      if (id === '') throw new ManagerError('bad-request', '需要 id')
      const managed = snap.store.servers.find((item) => item.id === id)
      if (managed === undefined) {
        throw new ManagerError('external-row-readonly', '手写行不能删除（可禁用；要删除请编辑 profile patch）')
      }
      const nextServers = snap.store.servers.filter((item) => item.id !== id)
      const { rendered } = await persist(snap.store, nextServers)
      return { ok: true, applied: 'live', revision: rendered.rev, remaining: nextServers.length }
    },

    /** 撤销手写行的面板覆盖（还原为 profile patch 里 insert 行的原值）。 */
    async revert(payload = {}) {
      const snap = await snapshot()
      guards(snap, payload)
      const id = typeof payload.id === 'string' ? payload.id : ''
      if (id === '') throw new ManagerError('bad-request', '需要 id')
      if (snap.store.servers.some((item) => item.id === id)) {
        throw new ManagerError('not-applicable', '受管行没有"覆盖"概念：直接保存或删除即可')
      }
      if (snap.rows.find((row) => row.id === id) === undefined) {
        throw new ManagerError('not-found', `找不到行 ${id}`)
      }
      await revertExternalConfig(ctx, id)
      return { ok: true, applied: 'live', revision: snap.store.rev, row: await afterApply(id) }
    },

    /** 漂移处置（逃生口）：overwrite = 以清单为准重写生成物；forget = 清空受管清单（以文件为准）。 */
    async heal(payload = {}) {
      const mode = payload.mode === 'forget' ? 'forget' : 'overwrite'
      const snap = await snapshot()
      if (mode === 'forget') {
        await writeStore(home, { version: snap.store.version, forProfile: profileName, rev: '', servers: [] })
        if (typeof snap.patchText === 'string' && snap.patchText.includes(MANAGED_MARK)) await removePatch(home)
        return { ok: true, healed: 'forget', revision: '', droppedServers: snap.store.servers.length }
      }
      const overwroteForeign = typeof snap.patchText === 'string' && !snap.patchText.includes(MANAGED_MARK)
      const { rendered } = await persist(snap.store, snap.store.servers)
      return { ok: true, healed: 'overwrite', revision: rendered.rev, overwroteForeign }
    },

    /** 启用/禁用：受管行改自有层；手写行走官方 pluginManager。 */
    async setEnabled(payload = {}) {
      const snap = await snapshot()
      guards(snap, payload)
      const id = typeof payload.id === 'string' ? payload.id : ''
      const enabled = payload.enabled !== false
      if (id === '') throw new ManagerError('bad-request', '需要 id')
      const managed = snap.store.servers.find((item) => item.id === id)
      if (managed === undefined) {
        const row = snap.rows.find((item) => item.id === id)
        if (row === undefined) throw new ManagerError('not-found', `找不到行 ${id}`)
        if (row.readOnlyReason !== undefined) {
          throw new ManagerError('external-row-readonly', `该行官方判定为不可管理（${row.readOnlyReason}），请手工处理`)
        }
        const change = await setRowEnabled(ctx, id, enabled)
        return { ok: true, applied: 'live', revision: snap.store.rev, change }
      }
      const nextServers = snap.store.servers.map((item) => (item.id === id ? { ...item, disabled: !enabled, lastAppliedAt: new Date().toISOString() } : item))
      const { rendered } = await persist(snap.store, nextServers)
      return { ok: true, applied: 'live', revision: rendered.rev, row: await afterApply(id) }
    },
  }
}

/** 清单里有、活行里没有的受管行（例如刚被外部改动或尚未挂载）。 */
function managedOrphan(record) {
  return {
    id: record.id,
    origin: 'managed',
    serverName: record.serverName,
    transport: record.transport,
    enabled: record.disabled !== true,
    stage: 'missing',
    configReadable: true,
    toolCount: 0,
    toolSample: [],
    failOnStartupError: record.failOnStartupError === true,
    notes: ['清单里有、当前没有活行：可能是刚保存尚未热挂载，或该行被更高层覆盖'],
    ...(record.transport === 'stdio'
      ? { command: record.command ?? '', args: record.args ?? [], cwd: record.cwd ?? '', envKeys: Object.keys(record.env ?? {}), envSet: Object.keys(record.env ?? {}).length > 0 }
      : { urlSet: typeof record.url === 'string' && record.url !== '' }),
  }
}

/**
 * 注册 RPC 端点。信封形状是硬性的（客户端 connection/rpc 的解析器是唯一裁判）：
 *   请求 {type:'client-request', rpcId, method:'<endpoint>', payload:{method,payload}}
 *   应答 {type:'server-response', rpcId, result:{ok:true,value:<载荷>}} 或 {ok:false,error:{...}}
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, Function>} api
 * @returns {(() => void) | undefined}
 */
function registerRpc(ctx, api) {
  const register = ctx?.connection?.fetch?.register
  if (typeof register !== 'function') {
    ctx.logger?.warn?.('[mcp-client-manager] connection.fetch.register 不可用 —— 设置面板不可用')
    return undefined
  }
  const reply = (rpcId, result) => {
    if (result?.ok === false) {
      return Response.json({
        type: 'server-response',
        rpcId,
        result: { ok: false, error: { ...result.error, details: result.error?.details ?? {} } },
      })
    }
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: result } })
  }
  return register({
    path: `/api/${RPC_ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message?.payload
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== RPC_ENDPOINT || call === null || typeof call !== 'object'
        || typeof call.method !== 'string') {
        return reply(rpcId, { ok: false, error: { code: 'bad-request', message: '请求信封不合法' } })
      }
      const handler = api[call.method]
      if (typeof handler !== 'function') {
        return reply(rpcId, {
          ok: false,
          error: { code: 'unknown-method', message: `未知方法：${call.method}`, details: { available: Object.keys(api) } },
        })
      }
      try {
        return reply(rpcId, await handler(call.payload ?? {}))
      } catch (error) {
        ctx.logger?.warn?.(`[mcp-client-manager] RPC ${call.method} 失败：${error?.message ?? error}`)
        return reply(rpcId, {
          ok: false,
          error: {
            code: error instanceof ManagerError ? error.code : 'handler-failed',
            message: String(error?.message ?? error),
            details: error instanceof ManagerError ? error.details : {},
          },
        })
      }
    },
  })
}
