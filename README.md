# @yiyunet/dsh-mcp-client-manager

简体中文 | [English](README.en.md)

DSH 插件：在 **设置 → 侧栏** 提供「**MCP 客户端**」面板，用来管理挂在 `@deepseek-ai/dsh-mcp-client`
下的 MCP 服务器行 —— 列出 / 添加 / 改写 / 启停 / 删除，**点保存才写盘，写完不重启宿主**。

> 本插件最初为**作者自用**而写（`package.json` 标 `private: true`，**未发布 npm**）。
> 源码公开、MIT 许可，按需自取；能力边界与已知限制全部写在本文档里，**不承诺文档之外的行为**。

## 变更历史

| 版本 | 变更 |
|---|---|
| **1.0.4** | 修**表格横向溢出**（实测反馈）：根因是 1.0.3 给操作列加的 `min-width: 300`，把表格最小宽度顶过容器 → 尾部横线溢出卡片。改法：① 去掉该强制宽度，列宽回归内容自适应（`修改｜禁用｜不可删`仍同排，因为行内 flex 仍 `nowrap`）；② 表格外套一层 `overflow-x: auto` 兜底——万一再超也只在本卡片内横向滚动；③ 服务名 / 行 id 加 `ellipsis` 截断（`max-width: 200`，悬停看全文）；④ 文案：`不可删（手写）` → **`不可删`**（悬停解释保留：手写行不能删、可改用禁用） |
| **1.0.3** | ① **操作列强制单行**（后于 1.0.4 取消强制宽度）；② 修正 1.0.2 挪位编辑引入的**括号配平错误**；③ **端点/命令不在列表显示**（会撑宽首列）——只保留在「修改」表单的 url 提示 + 悬停 title；首列小字恢复为仅「原手写行」 |
| **1.0.2** | ① **脱敏**：回传浏览器的路径改为符号化（`$DSH_HOME\…`），不再出现含用户名的绝对路径（`list`/`state` 均适用，单测加断言）；② **表格规整**：删除「端点 / 命令」整列，单元格禁折行；③ 手写行的「**不可删**」提示移到「禁用/启用」按钮**之后**（受管行为 `修改 ｜ 禁用 ｜ [撤销覆盖] ｜ 删除`，手写行为 `修改 ｜ 禁用 ｜ 不可删 ｜ [撤销覆盖]`） |
| **1.0.1** | 修 **F6**：状态列误读官方字段（应读 `fiberPhase`，且 `FiberState` 是数字枚举）→ 正常行被误报成"挂载/重连中"；状态口径改大白话（已启用 / 已启用·未发现工具 / 已禁用 / 加载失败 / 未加载 / 配置冲突），工具数收进悬停提示；顶部备注重写为普通用户可读，并**动态显示受管行的写入路径**（`list` 回传 `paths.homePatch`） |
| 1.0.0 | 首发：受管行（自有层）+ 手写行（官方通道）、三级 id 冲突检测、serverName 查重、漂移检测与两个逃生口、`撤销覆盖`、密钥永不出宿主 |

---

## 1. 它怎么工作（一层一张网）

| 层 | 文件 | 谁写 | 作用 |
|---|---|---|---|
| 真源（受管清单） | `$DSH_HOME/mcp-manager/servers.json` | 本插件 | 面板管理的服务器清单（含 url / env 等密钥字段，0600） |
| 生成物（自有层） | `$DSH_HOME/cordis.patch.yml` | 本插件，全量重写 | 把受管行渲染成 MCP 行；home 层在 HMR 监听范围内 → **落盘即热生效** |
| 手写层 | `profiles/<profile>/cordis.patch.yml` | 手工编辑 / DSH 官方配置编辑器 | **不由本插件直接改写**：改写与启停走官方通道（`ctx.configEditor` / `ctx.pluginManager`），而**官方的写入落点就是本文件**（见下） |

**两条写回路径，互不越界**

> **🔎 找文件时别找错地方（本条最常被问）**
> 本面板**添加/删除**的行写在 **`$DSH_HOME\cordis.patch.yml`**（`$DSH_HOME` = DSH 安装/数据根，即 `%USERPROFILE%\.dsh`）——
> **不在** `profiles\<profile>\cordis.patch.yml` 里。
> `profiles\<profile>\cordis.patch.yml` 只会有：① 你手写的那两行；② 面板改写它们时由 **DSH 官方配置编辑器**追加的覆盖行。
> 面板顶部显示的就是这个符号化路径（**不显示含用户名的绝对路径**）。

- **受管行**（行 id 前缀 `mcpx-`）：新增 / 改写 / 启停 / 删除 → 写自有层文件。
- **手写行**（例如 `mcp-sorftime`、`mcp-myserver`）：只能**改写凭据族字段**与**启用/禁用**；
  **不能删除**、**不能改 serverName / transport**（要改请手工编辑 profile patch）。
  改写走 `ctx.configEditor.edit()`（原子写 + 失败回滚 + 被更高层覆盖则拒写），
  启停走 `ctx.pluginManager.setPluginEnabled()`。

**⚠️ 手写行改写的落点（实测过一次，务必知道）**：官方配置编辑器只认**顶层** `- id:` 行，且明确排除 `insert` 行
（DSH 源码 `packages/boot/config-editor/src/index.ts:117-128`）。我们的两行嵌在 `- insert: [...]` 里 → 于是：

- **首次**改写该行：在 `profiles/<profile>/cordis.patch.yml` **末尾追加一条顶层覆盖行**（`- id: … / name: … / config: …`），
  原 `insert` 行**保持不变**；覆盖行在同文件内靠后 → 优先级更高 → 生效的是它。
- **之后**再改同一行：命中那条覆盖行并**原地更新**，不会越堆越多。
- 面板上该行会显示「手写」+`已覆盖` 标记，并多出一个「**撤销覆盖**」按钮 ——
  它调用官方语义（`next === inherited` 时移除覆盖行），把该行还原成 `insert` 行的原值。
- 后果提醒：**面板没改过的行**，你直接编辑 `insert` 行立刻生效；**已被面板覆盖的行**，改 `insert` 行**不生效**（被覆盖行压住），要先「撤销覆盖」。

**为什么不让面板直接改 profile patch**：官方编辑服务够不着嵌在 `- insert: [...]` 里的行，
自写 YAML 要自带解析器，而且**文件写坏 = 下次启动起不来**；自有层既避免解析（我们只写自己生成的内容），
又天然被 HMR 监听。

---

## 2. 安全口径（设计硬约束）

1. **url 永不回传浏览器** —— 面板只显示 `协议//主机/…`，不含路径、查询串或任何 key 片段。
2. **stdio 的 env 取值永不回传** —— 只回传键名与"已设置"。
3. **凭据族字段留空 = 保留原值**（未改不重写），要改必须整段重填：`url`、`command`、`env` 属此类。
4. `serverName` 保存前查重（活动行 + 受管清单 + 本次草稿）；重复会让后加载的那条加载失败。
5. 受管 id 强制 `mcpx-` 前缀 + **三级 id 冲突检测**（活动行 / 受管清单 / 手写层文本弱扫）——
   同 id 双声明会让官方把该行判成 `unaddressable` 并锁死开关。
6. **不做协议层探活**：状态列 = 行阶段 + 工具数（`mcp__<serverName>__*` 计数），**不代表链路健康**
   （断线重连期间工具仍会列出、调用才失败，这是 mcp-client 的既定行为）。

---

## 3. 安装

**方式 A · 本地目录（推荐：你手上这份 clone / 解压出来的目录）**

> 侧栏 **插件** → **添加插件** → 粘贴本仓库所在目录的**本地绝对路径** → **安装**

```sh
# 若偏爱命令行（<本仓库> = 本插件目录的绝对路径）
dsh plugin --profile web add "<本仓库>"
```

**方式 B · 直接从 GitHub 源安装**

```sh
dsh plugin --profile web add github:yiyunet/dsh-mcp-client-manager
```

> 本包**没有任何 `prepare` / 构建脚本**，因此 git 源安装不会触发"构建脚本批准"那一关。
> ⚠️ **推测（未实测）**：方式 B 的可用性取决于你的包管理器版本与 `dsh plugin` 对 git 说明符的解析；失败请回方式 A。

本 profile `patchReload: live`，且 bundles 变化在 HMR 监听范围内 → **通常无需重启**；
若设置里没出现「MCP 客户端」，重启一次宿主。

> 若 `dsh` 不在 PATH：可用 DSH 检出内的 CLI 入口 `node <DSH 检出>/apps/cli/lib/bin.js plugin …`，
> 或用 `npx -p @deepseek-ai/dsh dsh plugin …` 之类的等价形式（同样**推测**，未实测）。

## 4. 生效与验证

| # | 动作 | 预期观察 |
|---|---|---|
| 1 | 打开 设置 → 侧栏 | 出现「MCP 客户端」 |
| 2 | 打开面板 | 列出手写行（来源=手写，服务名下注「原手写行」），状态=**已启用**或`已启用 · 未发现工具`；**端点掩码/命令已收进"服务名"格的悬停提示**（表格只留 5 列：服务名 / 行 id / 来源 / 状态 / 操作） |
| 3 | 添加（http 三字段）→ 保存 | `$DSH_HOME/cordis.patch.yml` 出现；列表新增 `mcpx-*`；MCP 工具在该行挂载后可用 |
| 4 | 添加（stdio，command/args/env）→ 保存 | 同上；`env` 值落盘但不回显 |
| 5 | 改手写行 url → 保存 | 来源列变「手写 + 已覆盖」；`profiles/web/cordis.patch.yml` **末尾多出一条顶层 `- id: … / config: …` 覆盖行**（官方行为），原 insert 行不动；值立即生效 |
| 6 | 再改同一行一次 | 覆盖行**原地更新**，不新增第二条 |
| 7 | 点该行「撤销覆盖」 | 覆盖行被移除，值回到 `insert` 的原值；来源列恢复「手写」 |
| 8 | 禁用/启用手写行 | profile patch 出现/更新 `disabled` 覆盖 |
| 9 | 删除受管行 | 自有层文件该行消失，工具消失（手写行的"删除"按钮不存在） |
| 10 | 漂移演练：手工编辑 `$DSH_HOME/cordis.patch.yml` | 面板转只读 + 两个处置按钮（重建 / 清空清单） |

只读核对（⚠️ 输出含 key，别外传）：

```sh
dsh --profile web --dump-config
```

纯函数自测 + 集成冒烟（不需要 DSH、不需要网络、不碰真实 `$DSH_HOME`）：

```sh
cd <本仓库>
# 先做语法预检（零副作用，几秒钟；这一步能拦住任何手写笔误）
node --check plugin-src/host/index.mjs
node --check plugin-src/host/store.mjs
node --check plugin-src/host/validate.mjs
node --check plugin-src/host/adapter.mjs
node --check plugin-src/client/client.js
# 再跑三份测试（⚠️ 必须点明文件：Node 24 下 `node --test test` 会把 test 当模块加载而报 MODULE_NOT_FOUND）
node --test test/validate.test.mjs test/store.test.mjs test/host-smoke.mjs
```

`host-smoke.mjs` 会造一个假宿主（临时目录当 `DSH_HOME`）真跑一遍：list / 新增 / 查重 / 启停 / 删除 / 手写行改写 /
漂移与逃生口 / RPC 信封与乐观锁，并断言**密钥（url 与 env 取值）绝不出现在回传载荷里**。

契约与发布前自检（本仓库自带）：

```sh
npm test          # 同上三份测试
npm run verify    # 包契约断言（补齐 CLI 版本，见 scripts/verify-package.mjs）
```

## 5. 回滚

GUI：侧栏 **插件** → 找到本组合包 → **卸载**。

CLI：

```sh
dsh plugin --profile web remove "@yiyunet/dsh-mcp-client-manager"
# 2) 清受管层（受管 MCP 全消；手写行不受影响）
Remove-Item "$env:USERPROFILE\.dsh\cordis.patch.yml"
# 3) 清受管数据（可选）
Remove-Item -Recurse "$env:USERPROFILE\.dsh\mcp-manager"
```

---

## 6. 已知边界

### 6.0 状态列怎么读（大白话）

| 显示 | 含义 | 悬停提示 |
|---|---|---|
| **已启用** | 行已加载，且发现了该服务器的工具（**这是"确实连上了"的唯一证据**） | 已发现 N 个工具，例如 … |
| 已启用 · 未发现工具 | 行已加载，但没有发现工具（服务端本来就没有工具，或连接尚未完成） | 同上说明 |
| 已启用 · 加载中 | 行刚写入/重载，还没走完加载 | — |
| 已启用 · 停止中 | 行正在卸载 | — |
| **已禁用** | 该行被关掉，不会连接 | — |
| **加载失败** | 行加载/连接失败（看宿主日志） | — |
| 未加载 | 配置在，但当前进程里没有这一行 | — |
| 配置冲突 | 该行 id 被多层声明，官方已锁其开关，需手工处理 | — |

> 状态**只**说明"这行有没有加载、有没有发现工具"，**不代表对方服务健康**：断线重连期间工具仍会列出、调用才失败
> （mcp-client 的既定行为）。因此本面板不做探活。

### 6.1 其他边界

- **手写行的改写会落到 profile patch**（那是 DSH 官方配置编辑器的落点）：首次追加一条顶层覆盖行、之后原位更新；
  已被覆盖的行再改 `insert` **不生效**，需先点「撤销覆盖」（详见 §1）。「撤销覆盖」只删 `config`，不会动同一行上的 `disabled` 等其他键。
- **只覆盖 mcp-client 行的 `streamable-http` / `stdio` 两种传输**；`headers`、`reconnect`、
  `toolCallTimeoutMs`、`maxInstructionBytes` 等字段仍以文件为准（面板不动它们，改写时按"整段替换但带上现有键"处理）。
- **手写行不能删、不能改标识与协议**（官方编辑服务的能力边界）。
- **状态列不是健康检查**（见 §2.6）。
- **漂移即只读**：自有层文件一旦被外部改动（含换行符变化），面板停写并给出手工处置。
- 无构建步骤、无运行依赖：宿主半侧只用 `node:*` 与 ctx 服务，浏览器半侧用官方 module-loader 工厂格式。

---

## 7. 文档与许可

| 你想知道… | 看这里 |
|---|---|
| 装完一步步怎么确认它在工作 | [docs/安装与验证.md](docs/安装与验证.md) |
| 它到底怎么写盘：两层文件、两条写回路径、RPC 接口表、漂移与撤销覆盖 | [docs/架构与写回模型.md](docs/架构与写回模型.md) |
| 每个版本改了什么 | [CHANGELOG.md](CHANGELOG.md) |
| 文档总索引 | [docs/README.md](docs/README.md) |

MIT，见 [LICENSE](LICENSE)。问题与建议走本仓库 Issues。
