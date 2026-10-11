#!/usr/bin/env node
/**
 * 包契约断言 —— `npm run verify`（也是 CI 的第 ③ 关）。
 *
 * 纪律：**每条断言对应一个真实失败模式**，不为凑数而写。断言覆盖的是
 * 「本地看起来没事、换台机器/克隆一次就崩」的那类问题：
 *
 *   ① 必需文件缺失            → 克隆后加载不了 / 文档链接断
 *   ③ 包名三处不一致          → 浏览器半侧挂不上（官方只在「说明符恰为包名」的那行挂载）⇒ 设置面板根本不出现
 *   ④ RPC 端点两处不一致      → 面板在、但一切操作报未知方法
 *   ⑤ exports 指向不存在的文件 → 入口解析失败，同上
 *   ⑥ files 白名单自洽        → `link:` 本地装载下 files **完全不生效**，漏件在开发机永远不显形（B1/B2）
 *   ⑦ 声明了安装期脚本        → pnpm 10+ 直接拦死消费者安装（B7）
 *   ⑧ 宿主/客户端半侧引入外部包 → 破坏「零运行依赖 / git 源可装」的前提
 *   ⑨ 双语 locale 键不一致    → 切语言后界面缺文案
 *   ⑩ 版本三处不一致          → 文档事实停在旧版（历史踩过）
 *   ⑪ 私有词表命中            → 公开仓泄漏内部信息（词表由环境变量挂入，见下）
 *
 * 用法：
 *   npm run verify
 *   DSH_PRIVATE_TERMS=<仓库外词表绝对路径> npm run verify     # 可选；未设置则第 ⑪ 组标 skipped
 *
 * 退出码：0 = 全通过｜1 = 有失败。
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const problems = []
let passed = 0

const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}
const fail = (label, expected, actual) => {
  problems.push(label)
  console.log(`  ✗ ${label}`)
  console.log(`      期望：${expected}`)
  console.log(`      实际：${actual}`)
}
const group = (title) => console.log(`\n── ${title} ──`)

const readText = (rel) => readFile(join(ROOT, rel), 'utf8')
const readJson = async (rel) => JSON.parse(await readText(rel))
const isFile = (rel) => existsSync(join(ROOT, rel))
const isDir = (rel) => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isDirectory()

const HOST_FILES = ['plugin-src/host/index.mjs', 'plugin-src/host/store.mjs', 'plugin-src/host/validate.mjs', 'plugin-src/host/adapter.mjs']
const CLIENT_FILE = 'plugin-src/client/client.js'

// ── ① 必需文件 ───────────────────────────────────────────────────────────────
group('① 必需文件存在')
const REQUIRED = [
  'package.json', 'cordis.patch.yml', 'LICENSE', '.gitignore',
  'README.md', 'README.en.md', 'CHANGELOG.md',
  '.github/workflows/ci.yml', 'scripts/verify-package.mjs',
  ...HOST_FILES, CLIENT_FILE,
  'locale/zh.json', 'locale/en.json',
  'test/validate.test.mjs', 'test/store.test.mjs', 'test/host-smoke.mjs',
]
for (const rel of REQUIRED) {
  if (isFile(rel)) ok(rel)
  else fail(rel, '文件存在', '缺失')
}

// ── ② package.json 基本字段 ──────────────────────────────────────────────────
group('② package.json 基本字段')
const pkg = await readJson('package.json')
const BASIC = [
  ['name', (v) => typeof v === 'string' && v.startsWith('@')],
  ['version', (v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)],
  ['license', (v) => v === 'MIT'],
  ['type', (v) => v === 'module'],
  ['description', (v) => typeof v === 'string' && v.length > 20],
  ['engines', (v) => typeof v?.node === 'string'],
  ['dsh.bundle.patch', (v) => typeof v === 'string'],
]
for (const [path, test] of BASIC) {
  const value = path.split('.').reduce((node, key) => (node === undefined ? undefined : node[key]), pkg)
  if (test(value)) ok(`${path} = ${JSON.stringify(value)}`)
  else fail(`${path} 形态不合法`, `满足断言 ${path}`, JSON.stringify(value))
}

// ── ③ 包名三处一致（浏览器半侧挂载的唯一条件）────────────────────────────────
group('③ 包名一致性（package.json / cordis.patch.yml / client.js）')
const patchText = await readText('cordis.patch.yml')
const clientText = await readText(CLIENT_FILE)
const patchName = /name:\s*'([^']+)'/.exec(patchText)?.[1]
const clientId = /\n\s*id:\s*'([^']+)'/.exec(clientText)?.[1]
if (patchName === pkg.name) ok(`cordis.patch.yml name = ${patchName}`)
else fail('cordis.patch.yml 的 name 与包名不一致', pkg.name, String(patchName))
if (clientId === pkg.name) ok(`client.js 工厂 id = ${clientId}`)
else fail('client.js 工厂 id 与包名不一致', pkg.name, String(clientId))
{
  const declaration = /export const name = '([^']+)'/.exec(await readText('plugin-src/host/index.mjs'))?.[1]
  const rowId = /- id:\s*([A-Za-z0-9_.@/-]+)/.exec(patchText)?.[1]
  if (declaration !== undefined && rowId !== undefined && declaration === rowId) ok(`Loader 行 id = 宿主 name = ${rowId}`)
  else fail('Loader 行 id 与宿主 name 不一致', `${declaration} == ${rowId}`, `${declaration} vs ${rowId}`)
}

// ── ④ RPC 端点两处一致 ───────────────────────────────────────────────────────
group('④ RPC 端点一致性（宿主 / 浏览器半侧）')
const hostRpc = /export const RPC_ENDPOINT = '([^']+)'/.exec(await readText('plugin-src/host/index.mjs'))?.[1]
const clientRpc = /const RPC_ENDPOINT = '([^']+)'/.exec(clientText)?.[1]
if (hostRpc !== undefined && hostRpc === clientRpc) ok(`RPC_ENDPOINT = ${hostRpc}`)
else fail('RPC 端点两处不一致', `宿主 = ${hostRpc}`, `浏览器 = ${clientRpc}`)
if (/rpc\.call\(\s*'\/api'\s*,\s*RPC_ENDPOINT/.test(clientText)) ok('浏览器半侧按 /api/<endpoint> 调用')
else fail('浏览器半侧调用形态不符', "rpc.call('/api', RPC_ENDPOINT, …)", '未匹配')

// ── ⑤ exports 可达 ───────────────────────────────────────────────────────────
group('⑤ exports 指向的文件/目录存在')
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  const rel = String(value).replace(/^\.\//, '')
  if (key.endsWith('/*')) {
    const dir = rel.replace(/\*.*$/, '').replace(/\/$/, '')
    if (isDir(dir)) ok(`exports["${key}"] → ${dir}/（目录）`)
    else fail(`exports["${key}"] 指向的目录不存在`, dir, '缺失')
  } else if (isFile(rel)) ok(`exports["${key}"] → ${rel}`)
  else fail(`exports["${key}"] 指向的文件不存在`, rel, '缺失')
}

// ── ⑥ files 白名单自洽（B1/B2）──────────────────────────────────────────────
group('⑥ files 白名单自洽')
const files = Array.isArray(pkg.files) ? pkg.files : []
if (files.length === 0) fail('files 白名单为空', '至少覆盖 plugin-src / cordis.patch.yml / README', '[]')
else {
  for (const entry of files) {
    const rel = String(entry).replace(/\/$/, '')
    if (isFile(rel) || isDir(rel)) ok(`files: ${entry}`)
    else fail(`files 白名单条目在磁盘上不存在`, entry, '缺失')
  }
  const covered = (target) => files.some((entry) => {
    const base = String(entry).replace(/\/$/, '')
    return target === base || target.startsWith(`${base}/`)
  })
  const mustShip = [String(pkg.exports?.['.'] ?? '').replace(/^\.\//, ''), String(pkg.exports?.['./client'] ?? '').replace(/^\.\//, ''), 'cordis.patch.yml', 'package.json']
    .filter((item) => item !== '')
  for (const target of mustShip) {
    if (covered(target) || target === 'package.json') ok(`白名单覆盖发布必需件：${target}`)
    else fail(`发布必需件不在 files 白名单内（link 装载下本地看不见）`, `${target} 被某条白名单覆盖`, '未覆盖')
  }
}

// ── ⑦ 安装期脚本禁令（B7）────────────────────────────────────────────────────
group('⑦ 不得声明安装期脚本（pnpm 10+ 会拦死消费者安装）')
const FORBIDDEN_HOOKS = ['preinstall', 'install', 'postinstall']
const declared = Object.keys(pkg.scripts ?? {})
const hit = declared.filter((name) => FORBIDDEN_HOOKS.includes(name))
if (hit.length === 0) ok(`scripts 未声明 ${FORBIDDEN_HOOKS.join(' / ')}`)
else fail('声明了安装期脚本', '以上三个钩子均不得出现', hit.join(', '))

// ── ⑧ 零运行依赖：静态 import 只允许 node:* 与相对路径 ───────────────────────
group('⑧ 零运行依赖（宿主/浏览器半侧只允许 node:* 与相对路径）')
// 说明符抓取用两条正则：`… from "…"`（`\s` 可跨行，吃得下多行 import）与副作用式 `import "…"`。
// 刻意**不**吃 JSDoc 里的 `import('x')` 类型引用 —— 它不是运行时依赖。
const SPECIFIER_RES = [/\bfrom\s+['"]([^'"]+)['"]/g, /^\s*import\s+['"]([^'"]+)['"]/gm]
for (const rel of [...HOST_FILES, CLIENT_FILE]) {
  const text = await readText(rel)
  const specs = SPECIFIER_RES.flatMap((re) => [...text.matchAll(re)].map((match) => match[1]))
  const bad = specs.filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'))
  if (specs.length === 0) ok(`${rel}：无 import`)
  else if (bad.length === 0) ok(`${rel}：${specs.length} 条 import 全为 node:* / 相对路径（${specs.join(', ')}）`)
  else fail(`${rel} 引入了外部包`, '仅 node:* 与相对路径', bad.join(', '))
}

// ── ⑨ 双语 locale 键一致 ────────────────────────────────────────────────────
group('⑨ locale 双语键一致')
const flatKeys = (node, prefix = '') => Object.entries(node).flatMap(([key, value]) => {
  const path = prefix === '' ? key : `${prefix}.${key}`
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? flatKeys(value, path) : [path]
})
const zhKeys = flatKeys(await readJson('locale/zh.json')).sort()
const enKeys = flatKeys(await readJson('locale/en.json')).sort()
if (zhKeys.join('|') === enKeys.join('|')) ok(`zh/en 键一致（${zhKeys.join(', ')}）`)
else fail('zh/en locale 键不一致', zhKeys.join(', '), enKeys.join(', '))

// ── ⑩ 版本三处一致 ──────────────────────────────────────────────────────────
group('⑩ 版本一致性（package.json / CHANGELOG / README）')
const changelogText = await readText('CHANGELOG.md')
const readmeText = await readText('README.md')
if (changelogText.includes(`## [${pkg.version}]`)) ok(`CHANGELOG 有 [${pkg.version}] 条目`)
else fail('CHANGELOG 缺当前版本条目', `## [${pkg.version}]`, '未找到')
if (readmeText.includes(`**${pkg.version}**`)) ok(`README 变更历史含 **${pkg.version}**`)
else fail('README 变更历史未对齐当前版本', `**${pkg.version}**`, '未找到')

// ── ⑪ 私有词表扫描（可选）──────────────────────────────────────────────────
group('⑪ 私有词表扫描（DSH_PRIVATE_TERMS）')
const termsPath = (process.env.DSH_PRIVATE_TERMS ?? '').trim()
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', '.lib-staging', '.lib-backup', 'dist', 'coverage', '.cache'])
const TEXT_EXT = new Set(['.md', '.mjs', '.cjs', '.js', '.json', '.yml', '.yaml', '.txt', '.html', '.css'])
const EXTENSIONLESS = new Set(['LICENSE', 'NOTICE', '.gitignore', '.gitattributes', '.editorconfig'])
const walk = async (dir, prefix = '') => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...await walk(join(dir, entry.name), `${rel}/`))
    } else if (entry.isFile() && (EXTENSIONLESS.has(entry.name) || TEXT_EXT.has(extname(entry.name).toLowerCase()))) {
      out.push(rel)
    }
  }
  return out
}
if (termsPath === '') {
  console.log('  · skipped（未设置 DSH_PRIVATE_TERMS ⇒ 本组不产生判据；**skipped 不等于干净**）')
} else if (!existsSync(termsPath)) {
  fail('DSH_PRIVATE_TERMS 指向的文件读不到', termsPath, '不存在')
} else {
  // 词表必须放在仓库之外：放在仓库内会被 files 白名单原样打进发布包（防泄漏的机制自己泄漏）
  if (resolve(termsPath).startsWith(ROOT)) {
    fail('私有词表位于本仓库之内', '词表路径在仓库之外', termsPath)
  } else {
    const terms = (await readFile(termsPath, 'utf8')).split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => (line.includes(':') && /^C[1-5]:/.test(line) ? line.slice(line.indexOf(':') + 1) : line))
      .filter((line) => line !== '')
    // 正对照（同方法）：用**同一个匹配函数**扫一条必定命中的构造样本；
    // 若它不命中 ⇒ 说明词表没被读到或匹配失效 ⇒ 此时「0 命中」不可采信。
    const findHits = (text) => terms.filter((term) => text.includes(term))
    const sample = terms[0]
    if (sample === undefined) {
      console.log('  · skipped（词表为空）')
    } else {
      const controlHits = findHits(`control: ${sample}`)
      if (controlHits.length > 0) {
        ok(`正对照命中（词表首条「${sample}」）⇒ 词表已生效，「0 命中」可采信`)
        const files = await walk(ROOT)
        const hits = []
        for (const rel of files) {
          const text = await readFile(join(ROOT, rel), 'utf8')
          for (const hit of findHits(text)) hits.push(`${rel} ← ${hit}`)
        }
        if (hits.length === 0) ok(`全树（${files.length} 个文本文件）0 命中`)
        else fail('命中私有词表条目', '0 命中', hits.slice(0, 20).join(' ｜ '))
      } else {
        fail('正对照未命中 ⇒ 本组结论不可采信', '以词表首条构造的样本应命中', `样本：control: ${sample}`)
      }
    }
  }
}

// ── 结论 ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
if (problems.length === 0) {
  console.log(`✅ verify 通过：${passed} 项断言全为真。`)
  process.exit(0)
}
console.log(`✗ verify 未通过：${passed} 项通过，${problems.length} 项失败。`)
for (const item of problems) console.log(`  · ${item}`)
process.exit(1)
