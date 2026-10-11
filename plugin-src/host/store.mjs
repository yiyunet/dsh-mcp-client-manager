/**
 * dsh-mcp-client-manager —— 受管清单（真源）与自有层文件（生成物）。
 *
 * 模型：
 *   - 真源 = `$DSH_HOME/mcp-manager/servers.json`（0600），由本插件独占读写。
 *   - 生成物 = `$DSH_HOME/cordis.patch.yml`（home 层，0600），**全量重写**。
 *     home 层在 HMR 监听范围内（hmr/src/index.ts:215），落盘即热生效；
 *     该文件通常不存在，因此可安全独占。
 *   - 生成物带 `managed-by` 标记与 `rev`（正文 sha256）：被外部改动 → 面板判漂移并转只读。
 *
 * 只写**自己生成的行**，从不解析用户手写内容 —— 因此不需要 YAML 解析器，也不破坏任何注释。
 * @module dsh-mcp-client-manager/store
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 接管标记行：漂移检测的身份锚点。 */
export const MANAGED_MARK = '# managed-by: @yiyunet/dsh-mcp-client-manager'
/** 生成物里的 rev 行。 */
const REV_LINE = /^# rev: [0-9a-f]{64}\n/m
/** rev 行提取。 */
const REV_EXTRACT = /^# rev: ([0-9a-f]{64})$/m
/** home 层文件名（与 app-boot 的 PROFILE_PATCH_FILENAME 一致）。 */
export const HOME_PATCH_FILENAME = 'cordis.patch.yml'
/** 受管 MCP 行的模块名。 */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
/** 清单结构版本。 */
export const STORE_VERSION = 1

/** @param {string} home @returns {string} 清单目录 */
export function storeDir(home) { return join(home, 'mcp-manager') }

/** @param {string} home @returns {string} 清单文件绝对路径 */
export function storePath(home) { return join(storeDir(home), 'servers.json') }

/** @param {string} home @returns {string} 自有层文件绝对路径 */
export function homePatchPath(home) { return join(home, HOME_PATCH_FILENAME) }

/**
 * 空清单。
 * @param {string} [profileName]
 * @returns {object}
 */
export function emptyStore(profileName) {
  return { version: STORE_VERSION, forProfile: profileName ?? null, rev: '', servers: [] }
}

/**
 * 读清单；不存在或损坏时返回空清单（损坏另由 state 报出）。
 * @param {string} home
 * @param {string} [profileName]
 * @returns {Promise<object>}
 */
export async function readStore(home, profileName) {
  let text
  try {
    text = await readFile(storePath(home), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore(profileName)
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...emptyStore(profileName), corrupted: true }
  }
  return {
    version: STORE_VERSION,
    forProfile: typeof parsed?.forProfile === 'string' ? parsed.forProfile : (profileName ?? null),
    rev: typeof parsed?.rev === 'string' ? parsed.rev : '',
    servers: Array.isArray(parsed?.servers) ? parsed.servers.filter(isServerRecord).map(normalizeRecord) : [],
  }
}

/**
 * 写清单（原子替换 + 0600）。
 * @param {string} home
 * @param {object} store
 * @returns {Promise<void>}
 */
export async function writeStore(home, store) {
  await mkdir(storeDir(home), { recursive: true })
  await atomicWrite(storePath(home), `${JSON.stringify(store, null, 2)}\n`)
}

/** @param {string} home @returns {Promise<string | undefined>} */
export async function readPatchText(home) {
  return readTextIfExists(homePatchPath(home))
}

/**
 * 读任意文本文件；不存在返回 undefined（用于弱扫手写层 id）。
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
export async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 写自有层文件。
 * @param {string} home
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writePatch(home, text) {
  await atomicWrite(homePatchPath(home), text)
}

/**
 * 删除自有层文件（受管行清空时用；比留一个空数组文件更干净）。
 * @param {string} home
 * @returns {Promise<void>}
 */
export async function removePatch(home) {
  await rm(homePatchPath(home), { force: true })
}

/**
 * 渲染自有层文件正文 —— **纯函数、确定性**（同输入必同输出，可单测）。
 * @param {Array<object>} servers 受管行
 * @returns {{text: string, rev: string, empty: boolean}}
 */
export function renderPatch(servers) {
  const list = [...(servers ?? [])].sort((left, right) => String(left.id).localeCompare(String(right.id)))
  const body = buildBody(list)
  const rev = sha256(body)
  const text = body.replace(`${MANAGED_MARK}\n`, `${MANAGED_MARK}\n# rev: ${rev}\n`)
  return { text, rev, empty: list.length === 0 }
}

/**
 * profile patch 里的**顶层覆盖行** id：顶格 `- id: X`（即不带 insert 的覆盖行）。
 * 只取 id 用于「是否已被面板覆盖」的标记，不解析 YAML、不读正文。
 * （面板改写手写行时，官方配置编辑器会在 profile patch 末尾追加/更新这样一条覆盖行。）
 * @param {string | undefined} text
 * @returns {Set<string>}
 */
export function collectTopLevelOverrideIds(text) {
  const ids = new Set()
  if (typeof text !== 'string') return ids
  const re = /^- id:[ \t]*['"]?([A-Za-z0-9_.@/-]+)['"]?[ \t]*$/gm
  for (const match of text.matchAll(re)) ids.add(match[1])
  return ids
}

/**
 * 漂移检测：生成物是否仍是我们最后写下的那一份。
 * @param {string | undefined} text 生成物正文
 * @param {object} store 清单
 * @returns {{detected: boolean, reason: string, expected?: string, actual?: string}}
 */
export function checkDrift(text, store) {
  const servers = store?.servers ?? []
  if (typeof text !== 'string' || text.trim() === '') {
    return servers.length === 0
      ? { detected: false, reason: 'absent' }
      : { detected: true, reason: 'missing-file' }
  }
  if (!text.includes(MANAGED_MARK)) return { detected: true, reason: 'foreign-file' }
  const match = REV_EXTRACT.exec(text)
  if (match === null) return { detected: true, reason: 'no-rev' }
  const actual = sha256(text.replace(REV_LINE, ''))
  if (actual !== match[1]) {
    return { detected: true, reason: 'content-changed', expected: store?.rev ?? '', actual }
  }
  return { detected: false, reason: 'ok' }
}

// ── 内部 ─────────────────────────────────────────────────────────────────────

/** 接管说明头（三行固定文案 + 标记行）。 */
const IDENTITY = [
  '# ⚠️ 本文件由 @yiyunet/dsh-mcp-client-manager 生成并完全接管。',
  '# 手工编辑会被面板判为「外部改动」并转只读；要改请用面板，或直接删除本文件。',
  MANAGED_MARK,
]

function buildBody(list) {
  const lines = [...IDENTITY]
  if (list.length === 0) {
    lines.push('[]')
  } else {
    lines.push('- insert:')
    for (const server of list) lines.push(...renderRow(server))
  }
  return `${lines.join('\n')}\n`
}

function renderRow(server) {
  const lines = [
    `    - id: ${quote(server.id)}`,
    `      name: ${quote(MCP_CLIENT_MODULE)}`,
  ]
  // `disabled` 是**行级**选项（与 id/name/config 同级），不是 config 字段。
  if (server.disabled === true) lines.push('      disabled: true')
  lines.push(
    '      config:',
    `        serverName: ${quote(server.serverName)}`,
    `        transport: ${quote(server.transport)}`,
  )
  if (server.transport === 'stdio') {
    if (server.command) lines.push(`        command: ${quote(server.command)}`)
    const args = Array.isArray(server.args) ? server.args.filter((item) => typeof item === 'string' && item !== '') : []
    if (args.length > 0) {
      lines.push('        args:')
      for (const arg of args) lines.push(`          - ${quote(arg)}`)
    }
    const env = server.env && typeof server.env === 'object' ? Object.entries(server.env) : []
    if (env.length > 0) {
      lines.push('        env:')
      for (const [key, value] of env) lines.push(`          ${key}: ${quote(value)}`)
    }
    if (server.cwd) lines.push(`        cwd: ${quote(server.cwd)}`)
  } else if (server.url) {
    lines.push(`        url: ${quote(server.url)}`)
  }
  if (server.failOnStartupError === true) lines.push('        failOnStartupError: true')
  return lines
}

/** YAML 单引号标量：单引号自身双写；换行折叠为空格（校验已拦，双保险）。 */
function quote(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ')
  return `'${text.replace(/'/g, "''")}'`
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 原子替换写：临时文件 → rename；Windows 下 rename 被占用时重试。 */
async function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, { mode: 0o600 })
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, path)
      return
    } catch (error) {
      if (attempt >= 3) {
        await rm(tmp, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
    }
  }
}

function isServerRecord(value) {
  return value !== null && typeof value === 'object'
    && typeof value.id === 'string' && value.id !== ''
    && typeof value.serverName === 'string'
    && (value.transport === 'streamable-http' || value.transport === 'stdio')
}

function normalizeRecord(record) {
  return {
    id: record.id,
    serverName: record.serverName,
    transport: record.transport,
    ...(record.transport === 'stdio'
      ? {
        command: typeof record.command === 'string' ? record.command : '',
        args: Array.isArray(record.args) ? record.args.map(String) : [],
        env: record.env && typeof record.env === 'object'
          ? Object.fromEntries(Object.entries(record.env).map(([key, value]) => [key, String(value)]))
          : {},
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
      }
      : { url: typeof record.url === 'string' ? record.url : '' }),
    failOnStartupError: record.failOnStartupError === true,
    disabled: record.disabled === true,
    ...(typeof record.addedAt === 'string' ? { addedAt: record.addedAt } : {}),
    ...(typeof record.lastAppliedAt === 'string' ? { lastAppliedAt: record.lastAppliedAt } : {}),
  }
}
