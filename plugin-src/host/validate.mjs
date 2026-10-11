/**
 * dsh-mcp-client-manager —— 校验与冲突检测（纯函数层）。
 *
 * 设计约束（全部来自真源核实，非推测）：
 *   - `serverName` 必须匹配 [A-Za-z0-9_-]{1,32} 且在同一注册作用域内唯一；
 *     重复时**后加载的那条**在加载时以明确错误失败（mcp-client/src/index.ts:160-176）。
 *   - 受管行 id 强制 `mcpx-` 前缀；同一 id 被两层同时声明（insert+insert）会让
 *     插件页把该行判为 unaddressable 并锁死开关（plugin-manager/src/index.ts:261-269）。
 *   - mcp-client 的 Config 是 union：streamable-http 分支要 url；stdio 分支要 command。
 *
 * 本文件**无副作用**、不 import 任何 Host 包，便于 `node --test` 直接单测。
 * @module dsh-mcp-client-manager/validate
 */

/** serverName 的合法形态（与 mcp-client 的 SERVER_NAME_PATTERN 对齐）。 */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
/** 仅接受 http/https 绝对 URL；拒绝空白与换行。 */
export const URL_RE = /^https?:\/\/\S+$/
/** 环境变量名（stdio.env）。 */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 受管行 id 前缀。 */
export const ID_PREFIX = 'mcpx-'
/** 两种传输。两者都必须在面板可选。 */
export const TRANSPORTS = ['streamable-http', 'stdio']

/** 单字段长度上限，防止把整篇文本塞进配置文件。 */
export const LIMITS = { url: 2048, command: 512, cwd: 512, field: 512, args: 64, env: 64 }

/** 校验错误码（RPC 与会话共用同一套字面量）。 */
export const ERROR_CODES = {
  serverName: 'invalid-serverName',
  duplicateServerName: 'duplicate-serverName',
  url: 'invalid-url',
  command: 'invalid-command',
  transport: 'unsupported-transport',
  env: 'invalid-env',
  args: 'invalid-args',
  idConflict: 'id-conflict',
  field: 'invalid-field',
}

/**
 * 把 serverName 收敛成 id 片段：小写、非 [a-z0-9] 折成 `-`、去首尾、截断。
 * @param {string} serverName
 * @returns {string}
 */
export function slugify(serverName) {
  const slug = String(serverName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug === '' ? 'unnamed' : slug
}

/**
 * 受管行的行 id。
 * @param {string} serverName
 * @returns {string} 形如 `mcpx-sorftime`
 */
export function idForServerName(serverName) {
  return ID_PREFIX + slugify(serverName)
}

/**
 * 从 patch 文件**文本**里弱扫行 id —— 只用于冲突拦截与警示，**不做 YAML 解析**。
 * 命中形态：顶格或以 `- ` 开头的 `id: xxx`（含嵌在 insert 列表里的行）。
 * @param {string | undefined} text
 * @returns {Set<string>}
 */
export function collectPatchIds(text) {
  const ids = new Set()
  if (typeof text !== 'string') return ids
  const re = /^[ \t]*-[ \t]*id:[ \t]*['"]?([A-Za-z0-9_.@/-]+)['"]?[ \t]*$/gm
  for (const match of text.matchAll(re)) ids.add(match[1])
  return ids
}

/**
 * 判断 id 是否为受管 id（前缀裁决，唯一权威）。
 * @param {string} id
 * @returns {boolean}
 */
export function isManagedId(id) {
  return typeof id === 'string' && id.startsWith(ID_PREFIX)
}

/**
 * 归一化面板输入：去空白、把多行文本拆成数组、把 env 文本拆成对象。
 * 客户端可以直接送数组/对象；两者都接受。
 * @param {{serverName?: unknown, transport?: unknown, url?: unknown, command?: unknown, args?: unknown, env?: unknown, cwd?: unknown, failOnStartupError?: unknown}} input
 * @returns {object} 归一化后的草稿
 */
export function normalizeInput(input) {
  const source = input ?? {}
  const text = (value) => (typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim())
  const args = Array.isArray(source.args)
    ? source.args.map((item) => String(item).trim()).filter((item) => item !== '')
    : text(source.args).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  let env = {}
  if (Array.isArray(source.env)) {
    for (const entry of source.env) {
      const line = String(entry).trim()
      if (line === '') continue
      const at = line.indexOf('=')
      if (at <= 0) continue
      env[line.slice(0, at).trim()] = line.slice(at + 1)
    }
  } else if (source.env !== null && typeof source.env === 'object') {
    for (const [key, value] of Object.entries(source.env)) env[String(key).trim()] = String(value)
  } else {
    for (const line of text(source.env).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const at = trimmed.indexOf('=')
      if (at <= 0) continue
      env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1)
    }
  }
  return {
    serverName: text(source.serverName),
    transport: text(source.transport),
    url: text(source.url),
    command: text(source.command),
    args,
    env,
    cwd: text(source.cwd),
    failOnStartupError: source.failOnStartupError === true,
  }
}

/**
 * 校验一台服务器草稿 + 冲突检测。
 *
 * @param {object} draft - {@link normalizeInput} 的输出
 * @param {object} context
 * @param {Iterable<string>} [context.liveIds] - 活行 id 集（ctx.loader.entries()）
 * @param {Iterable<string>} [context.managedIds] - 受管清单 id 集（servers.json）
 * @param {Iterable<string>} [context.patchIds] - 手写层文本弱扫 id 集
 * @param {Iterable<string>} [context.liveNames] - 活行 serverName 集
 * @param {Iterable<string>} [context.managedNames] - 受管清单 serverName 集
 * @param {string} [context.editingId] - 正在编辑的受管行 id（改 serverName 时用于排除自身）
 * @param {boolean} [context.external] - true = 改写手写行（serverName/transport 冻结，只允许凭据族字段）
 * @returns {{ok: true, value: object} | {ok: false, errors: Array<{code: string, field: string, message: string}>, value?: object}}
 */
export function validateServer(draft, context = {}) {
  const errors = []
  const liveIds = new Set(context.liveIds ?? [])
  const managedIds = new Set(context.managedIds ?? [])
  const patchIds = new Set(context.patchIds ?? [])
  const liveNames = new Set(context.liveNames ?? [])
  const managedNames = new Set(context.managedNames ?? [])
  const editingId = typeof context.editingId === 'string' ? context.editingId : undefined
  const external = context.external === true
  const push = (code, field, message) => errors.push({ code, field, message })

  // ── transport（下拉，值必须在枚举内）
  if (!TRANSPORTS.includes(draft.transport)) {
    push(ERROR_CODES.transport, 'transport', `transport 只能是 ${TRANSPORTS.join(' / ')}`)
  }

  // ── serverName（保存前查重）
  if (draft.serverName === '') {
    push(ERROR_CODES.serverName, 'serverName', 'serverName 必填')
  } else if (!SERVER_NAME_RE.test(draft.serverName)) {
    push(ERROR_CODES.serverName, 'serverName', '只允许 A-Z a-z 0-9 _ - ，且长度 1–32')
  } else if (!external) {
    const clash = liveNames.has(draft.serverName) || managedNames.has(draft.serverName)
    if (clash && !clashOnlySelf(draft.serverName, editingId, context)) {
      push(ERROR_CODES.duplicateServerName, 'serverName', `serverName「${draft.serverName}」已被占用（重复会让后加载的那条加载失败）`)
    }
  }

  // ── 形态专属字段（modes：create 必填；edit 留空 = 保留原值不重写）
  const editing = context.mode === 'edit'
  if (draft.transport === 'streamable-http') {
    if (draft.url === '') {
      if (!editing) push(ERROR_CODES.url, 'url', 'url 必填')
    } else if (!URL_RE.test(draft.url) || draft.url.length > LIMITS.url) {
      push(ERROR_CODES.url, 'url', '必须是 http(s) 绝对 URL，且不含空白/换行，长度 ≤ 2048')
    }
  } else if (draft.transport === 'stdio') {
    if (draft.command === '') {
      if (!editing) push(ERROR_CODES.command, 'command', 'stdio 行的 command 必填')
    } else if (draft.command.length > LIMITS.command || /[\r\n]/.test(draft.command)) {
      push(ERROR_CODES.command, 'command', 'command 不能含换行，长度 ≤ 512')
    }
    if (draft.args.length > LIMITS.args) push(ERROR_CODES.args, 'args', `args 最多 ${LIMITS.args} 项`)
    for (const [key, value] of Object.entries(draft.env)) {
      if (!ENV_KEY_RE.test(key)) {
        push(ERROR_CODES.env, 'env', `环境变量名不合法：${key}`)
        break
      }
      if (/[\r\n]/.test(value)) {
        push(ERROR_CODES.env, 'env', `环境变量 ${key} 的值不能含换行`)
        break
      }
    }
    if (Object.keys(draft.env).length > LIMITS.env) push(ERROR_CODES.env, 'env', `env 最多 ${LIMITS.env} 项`)
  }
  if (draft.cwd.length > LIMITS.cwd || /[\r\n]/.test(draft.cwd)) {
    push(ERROR_CODES.field, 'cwd', 'cwd 不能含换行，长度 ≤ 512')
  }

  // ── id 冲突（三级检测）
  const id = external ? context.editingId : idForServerName(draft.serverName)
  if (typeof id !== 'string' || id === '') {
    push(ERROR_CODES.idConflict, 'serverName', '无法推导行 id')
  } else if (!external) {
    const elsewhere = [['活动行', liveIds], ['受管清单', managedIds], ['手写层', patchIds]]
    for (const [label, set] of elsewhere) {
      if (set.has(id) && id !== editingId) {
        push(ERROR_CODES.idConflict, 'serverName', `行 id「${id}」与${label}已声明的 id 冲突（同 id 双声明会让开关锁死）`)
        break
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      id,
      serverName: draft.serverName,
      transport: draft.transport,
      ...(draft.transport === 'streamable-http' ? { url: draft.url } : {
        command: draft.command,
        args: draft.args,
        env: draft.env,
        cwd: draft.cwd,
      }),
      failOnStartupError: draft.failOnStartupError,
    },
  }
}

/**
 * 改写**手写行**时的字段级校验（标识与协议冻结，只允许凭据族字段）。
 * 规则与 {@link validateServer} 同源，但跳过 id / serverName / 查重。
 * @param {'streamable-http' | 'stdio'} transport
 * @param {Record<string, unknown>} patch
 * @returns {Array<{code: string, field: string, message: string}>}
 */
export function validateExternalPatch(transport, patch) {
  const errors = []
  if (typeof patch.url === 'string' && (!URL_RE.test(patch.url) || patch.url.length > LIMITS.url)) {
    errors.push({ code: ERROR_CODES.url, field: 'url', message: '必须是 http(s) 绝对 URL，且不含空白/换行，长度 ≤ 2048' })
  }
  if (typeof patch.command === 'string' && (patch.command.length > LIMITS.command || /[\r\n]/.test(patch.command))) {
    errors.push({ code: ERROR_CODES.command, field: 'command', message: 'command 不能含换行，长度 ≤ 512' })
  }
  if (Array.isArray(patch.args) && patch.args.length > LIMITS.args) {
    errors.push({ code: ERROR_CODES.args, field: 'args', message: `args 最多 ${LIMITS.args} 项` })
  }
  if (patch.env !== undefined && patch.env !== null && typeof patch.env === 'object' && !Array.isArray(patch.env)) {
    const entries = Object.entries(patch.env)
    if (entries.length > LIMITS.env) {
      errors.push({ code: ERROR_CODES.env, field: 'env', message: `env 最多 ${LIMITS.env} 项` })
    }
    for (const [key, value] of entries) {
      if (!ENV_KEY_RE.test(key)) {
        errors.push({ code: ERROR_CODES.env, field: 'env', message: `环境变量名不合法：${key}` })
        break
      }
      if (/[\r\n]/.test(String(value))) {
        errors.push({ code: ERROR_CODES.env, field: 'env', message: `环境变量 ${key} 的值不能含换行` })
        break
      }
    }
  }
  if (typeof patch.cwd === 'string' && (patch.cwd.length > LIMITS.cwd || /[\r\n]/.test(patch.cwd))) {
    errors.push({ code: ERROR_CODES.field, field: 'cwd', message: 'cwd 不能含换行，长度 ≤ 512' })
  }
  void transport
  return errors
}

/**
 * 正在编辑的这台，其 serverName 只与**自己**重名时不算冲突。
 * @param {string} serverName
 * @param {string} editingId
 * @param {object} context
 * @returns {boolean}
 */
function clashOnlySelf(serverName, editingId, context) {
  const managed = Array.isArray(context.managedServers) ? context.managedServers : []
  const mine = managed.find((item) => item && item.id === editingId)
  if (mine === undefined || mine.serverName !== serverName) return false
  const otherManaged = managed.some((item) => item && item.id !== editingId && item.serverName === serverName)
  if (otherManaged) return false
  const live = Array.isArray(context.liveServers) ? context.liveServers : []
  const otherLive = live.some((item) => item && item.id !== editingId && item.serverName === serverName)
  return !otherLive
}
