/**
 * dsh-mcp-client-manager —— 活行读取、状态采集与**官方通道**改写。
 *
 * 全部能力都走 ctx 服务（不 import 任何 Host 包），因此本插件零运行依赖：
 *   - 读活行           ：`ctx.loader.entries()`
 *   - 行阶段/可管理判定 ：`ctx.pluginManager.listPlugins()`（含 readOnlyReason）
 *   - 改写手写行的配置   ：`ctx.configEditor.edit(entry, change)`
 *   - 启用/禁用手写行    ：`ctx.pluginManager.setPluginEnabled(entryId, enabled)`
 *   - 工具探测          ：`ctx.tools.schemas()`
 *
 * 安全口径：
 *   url **永不回传**（只给 `协议//主机/…`）；stdio 的 env **只回传键名**。
 *   args 回传（命令行参数通常不含密钥；若含，面板提示改用 env）。
 * @module dsh-mcp-client-manager/adapter
 */

import { MCP_CLIENT_MODULE } from './store.mjs'

/** 携带错误码的插件错误。 */
export class ManagerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'ManagerError'
    this.code = code
    this.details = details ?? {}
  }
}

/**
 * 找一个 Loader 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} id 行 id
 * @returns {object | undefined}
 */
export function findEntry(ctx, id) {
  const loader = ctx.get('loader')
  if (loader === undefined) return undefined
  for (const entry of loader.entries()) {
    if (entry.options?.id === id || entry.id === id) return entry
  }
  return undefined
}

/**
 * 收集所有挂在 mcp-client 下的活行（含阶段与可管理判定）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{rows: Array<object>, inventory: string}>}
 */
export async function listRows(ctx) {
  const loader = ctx.get('loader')
  const entries = loader === undefined ? [] : [...loader.entries()]
  const manager = ctx.get('pluginManager')
  let inventory = []
  let source = 'loader'
  if (manager !== undefined && typeof manager.listPlugins === 'function') {
    try {
      inventory = await manager.listPlugins()
      source = 'pluginManager'
    } catch {
      inventory = []
      source = 'loader'
    }
  }
  const byEntry = new Map()
  for (const item of inventory) {
    if (typeof item?.entryId === 'string') byEntry.set(item.entryId, item)
  }
  const rows = []
  for (const entry of entries) {
    if (entry.options?.name !== MCP_CLIENT_MODULE) continue
    const id = typeof entry.options.id === 'string' ? entry.options.id : String(entry.id)
    const info = byEntry.get(id) ?? byEntry.get(String(entry.id))
    const config = entry.options.config
    rows.push({
      id,
      entryId: id,
      moduleName: MCP_CLIENT_MODULE,
      stage: stageOf(entry, info),
      enabled: enabledOf(entry, info),
      ...(typeof info?.readOnlyReason === 'string' ? { readOnlyReason: info.readOnlyReason } : {}),
      ...(typeof info?.patchId === 'string' ? { patchId: info.patchId } : {}),
      config: config !== null && typeof config === 'object' && !Array.isArray(config) ? config : undefined,
    })
  }
  return { rows, inventory: source }
}

/**
 * 行阶段：官方清单字段名是 **`fiberPhase`**（host/plugin-inventory/src/types.ts:8-25），
 * 取值 `pending | loading | active | failed | unloading | null`；读不到才退回 Loader 的 fiber.state。
 * @param {object} entry
 * @param {object | undefined} info
 * @returns {'active' | 'failed' | 'loading' | 'pending' | 'unloading' | 'unknown'}
 */
function stageOf(entry, info) {
  const phase = info?.fiberPhase
  if (typeof phase === 'string' && phase !== '') return phase
  if (phase === null) return 'unknown'
  const fiber = entry?.fiber
  if (fiber === undefined || fiber === null) return 'pending'
  return mapFiberState(fiber.state)
}

/**
 * cordis 的 FiberState 是**数字 const enum**（PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5）——
 * 早先按字符串匹配会全部落空并把正常行误报成"加载中"。另兼容字符串形态。
 * @param {unknown} raw
 * @returns {'active' | 'failed' | 'loading' | 'pending' | 'unloading' | 'unknown'}
 */
function mapFiberState(raw) {
  if (typeof raw === 'number') {
    switch (raw) {
      case 2: return 'active'
      case 3: return 'failed'
      case 1: return 'loading'
      case 4: return 'unloading'
      case 5: return 'unloading'
      default: return 'pending'
    }
  }
  const value = String(raw ?? '').toLowerCase()
  if (value === '') return 'unknown'
  if (value.includes('active')) return 'active'
  if (value.includes('fail')) return 'failed'
  if (value.includes('unload') || value.includes('dispos')) return 'unloading'
  if (value.includes('load')) return 'loading'
  if (value.includes('pend')) return 'pending'
  return 'unknown'
}

/**
 * 是否启用：优先取官方清单，其次读行上的 disabled 覆盖。
 * @param {object} entry
 * @param {object | undefined} info
 * @returns {boolean}
 */
function enabledOf(entry, info) {
  if (typeof info?.enabled === 'boolean') return info.enabled
  return entry?.options?.disabled !== true
}

/**
 * 某台服务器的模型可见工具名（只读探测；不做协议层探活）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} serverName
 * @returns {string[]}
 */
export function toolNamesFor(ctx, serverName) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.schemas !== 'function') return []
  let schemas
  try {
    schemas = tools.schemas()
  } catch {
    return []
  }
  const prefix = `mcp__${serverName}__`
  return schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string' && name.startsWith(prefix))
}

/**
 * URL 掩码：只保留 `协议//主机`，不暴露路径、查询串与任何 key 片段，也不透露长度。
 * @param {string} url
 * @returns {string}
 */
export function maskUrl(url) {
  const text = String(url ?? '')
  if (text === '') return ''
  try {
    const parsed = new URL(text)
    return `${parsed.protocol}//${parsed.host}/…`
  } catch {
    return '（已设置）'
  }
}

/**
 * 把活行 + 清单记录整理成面板 DTO（绝不包含 url 明文或 env 取值）。
 * @param {object} row 活行
 * @param {object | undefined} managed 清单里对应的受管记录
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {(name: string) => string[]} toolsOf
 * @returns {object}
 */
export function toDto(row, managed, toolsOf) {
  const config = row.config
  const readable = config !== undefined
  const serverName = readable && typeof config.serverName === 'string' ? config.serverName : (managed?.serverName ?? '')
  const transport = readable && typeof config.transport === 'string'
    ? config.transport
    : (managed?.transport ?? 'streamable-http')
  const origin = managed !== undefined ? 'managed' : 'external'
  const tools = serverName === '' ? [] : toolsOf(serverName)
  const notes = []
  if (!readable) notes.push('行配置是表达式或非对象，面板只读展示')
  if (row.readOnlyReason === 'unaddressable') notes.push('该行 id 被多层声明或无法唯一定位：官方已锁其开关')
  if (origin === 'external') notes.push('原手写行')
  const dto = {
    id: row.id,
    origin,
    serverName,
    transport,
    enabled: row.enabled,
    stage: row.stage,
    configReadable: readable,
    toolCount: tools.length,
    toolSample: tools.slice(0, 2),
    failOnStartupError: readable && config.failOnStartupError === true,
    notes,
    ...(row.readOnlyReason === undefined ? {} : { readOnlyReason: row.readOnlyReason }),
  }
  if (transport === 'stdio') {
    const env = readable && config.env !== undefined && config.env !== null && typeof config.env === 'object' && !Array.isArray(config.env)
      ? config.env
      : undefined
    dto.command = readable && typeof config.command === 'string' ? config.command : ''
    dto.args = readable && Array.isArray(config.args) ? config.args.map(String) : []
    dto.cwd = readable && typeof config.cwd === 'string' ? config.cwd : ''
    dto.envKeys = env === undefined ? [] : Object.keys(env)
    dto.envSet = dto.envKeys.length > 0
    dto.envValuePolicy = '取值不回传：不改则留空；要改请整段重填'
  } else {
    const url = readable && typeof config.url === 'string' ? config.url : ''
    dto.urlSet = url !== ''
    dto.urlMask = maskUrl(url)
    dto.urlValuePolicy = '取值不回传：不改则留空；要改请粘贴完整 URL'
  }
  return dto
}

/** 取官方配置编辑器与目标行；缺任一即抛出可读错误。 */
function requireEditorEntry(ctx, id) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.edit !== 'function') {
    throw new ManagerError('adapter-unavailable', '宿主未提供 configEditor 服务，无法改写手写行')
  }
  const entry = findEntry(ctx, id)
  if (entry === undefined) {
    throw new ManagerError('row-vanished', `找不到行 ${id}（可能刚被外部改动移除）`)
  }
  const current = entry.options.config
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new ManagerError('row-not-editable', `行 ${id} 的配置是表达式或非对象，面板不代改（请手工编辑）`)
  }
  return { editor, entry }
}

/**
 * 用官方编辑服务改写手写行的配置（整段替换语义：必须带上现有键）。
 * 注意：官方编辑器的写入落点是 **profile patch** —— 首次会追加一条顶层覆盖行，
 * 之后同一 id 会命中该行并原地更新（config-editor/src/index.ts:117-128）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} id 行 id
 * @param {Record<string, unknown>} patch 要覆盖的键
 * @returns {Promise<void>}
 */
export async function overwriteExternalConfig(ctx, id, patch) {
  const { editor, entry } = requireEditorEntry(ctx, id)
  await editor.edit(entry, (raw) => ({ ...raw, ...patch }))
}

/**
 * 撤销手写行的面板覆盖：把配置还原为**继承值**。
 * 官方编辑器在 `next === inherited` 时会移除该覆盖行（config-editor/src/index.ts:120-126），
 * 因此这是"删除覆盖、让 profile patch 里的 insert 行重新生效"的官方途径。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} id 行 id
 * @returns {Promise<void>}
 */
export async function revertExternalConfig(ctx, id) {
  const { editor, entry } = requireEditorEntry(ctx, id)
  await editor.edit(entry, (_raw, inherited) => inherited)
}

/**
 * 用官方管理服务启用/禁用手写行（写 profile patch 的 disabled 覆盖）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} entryId
 * @param {boolean} enabled
 * @returns {Promise<object>}
 */
export async function setRowEnabled(ctx, entryId, enabled) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || typeof manager.setPluginEnabled !== 'function') {
    throw new ManagerError('adapter-unavailable', '宿主未提供 pluginManager 服务，无法启停该行')
  }
  const result = await manager.setPluginEnabled(entryId, enabled)
  return result ?? {}
}

/**
 * 适配器就绪状态（面板与 state 自检共用）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {{loader: boolean, tools: boolean, configEditor: boolean, pluginManager: boolean, connection: boolean, profileContext: boolean}}
 */
export function adapterState(ctx) {
  const has = (name, method) => {
    const service = ctx.get(name)
    return service !== undefined && (method === undefined || typeof service[method] === 'function')
  }
  return {
    loader: has('loader', 'entries'),
    tools: has('tools', 'schemas'),
    configEditor: has('configEditor', 'edit'),
    pluginManager: has('pluginManager', 'listPlugins'),
    connection: has('connection'),
    profileContext: ctx.get('profileContext') !== undefined,
  }
}
