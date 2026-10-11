/**
 * dsh-mcp-client-manager —— 浏览器半侧（设置 → 侧栏「MCP 客户端」面板）。
 *
 * 零构建：本文件就是官方 module-loader 的工厂格式（同 templates/decoration/client.js），
 * 由 dsh-client-modules 从 package.json 的 `exports["./client"]` 取用并挂到
 * 「说明符恰为包名」的那一行 Loader 行上。
 *
 * 契约要点（宿主侧 plugin-src/host/index.mjs 同步）：
 *   - RPC：ctx.connection.rpc.call('/api','mcp-client-manager',{method,payload})
 *   - 密钥口径：宿主**永不回传** url 明文与 env 取值；
 *     「凭据族字段」留空 = 保留原值（未改不重写），要改必须整段重填。
 *   - transport 下拉两项都可选；无精准探活；手写行可改写/启停、不可删。
 */
window.__ModuleLoader__.load({
  id: '@yiyunet/dsh-mcp-client-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** RPC 端点名（不含 /api/ 前缀），必须与宿主一致。 */
    const RPC_ENDPOINT = 'mcp-client-manager'
    const TRANSPORTS = [
      { value: 'streamable-http', label: 'streamable-http（远端 HTTP MCP）' },
      { value: 'stdio', label: 'stdio（本地子进程 MCP）' },
    ]
    const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
    const POLL_MS = 5000

    // ── 样式（内联；只取主题 token，禁自带皮肤） ─────────────────────────────
    const S = {
      wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.7 },
      card: { border: '1px solid var(--dsh-border, #e3e5e8)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 },
      headRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      title: { fontSize: 13, fontWeight: 600, margin: '0 0 8px' },
      note: { opacity: 0.7, fontSize: 12, margin: '0 0 8px' },
      input: { flex: '1 1 240px', minWidth: 180, padding: '6px 8px', fontSize: 13, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5 },
      select: { padding: '6px 8px', fontSize: 13, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5 },
      textarea: { width: '100%', minHeight: 58, padding: '6px 8px', fontSize: 12, fontFamily: 'ui-monospace, monospace', border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5 },
      btn: { padding: '5px 12px', fontSize: 13, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5, cursor: 'pointer', background: 'transparent', color: 'inherit' },
      btnPrimary: { padding: '5px 12px', fontSize: 13, border: '1px solid transparent', borderRadius: 5, cursor: 'pointer', background: 'var(--dsh-accent, #3b6cf0)', color: '#fff' },
      btnDanger: { padding: '4px 10px', fontSize: 12, border: '1px solid rgba(200,60,60,.5)', borderRadius: 5, cursor: 'pointer', background: 'transparent', color: 'inherit' },
      btnMini: { padding: '3px 9px', fontSize: 12, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5, cursor: 'pointer', background: 'transparent', color: 'inherit' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      // 兜底：万一某行长文本把表格撑过容器，也只在本卡片内横向滚动，绝不溢出卡片
      tableWrap: { width: '100%', overflowX: 'auto' },
      th: { textAlign: 'left', padding: '5px 6px', borderBottom: '1px solid var(--dsh-border, #e3e5e8)', fontWeight: 600, whiteSpace: 'nowrap' },
      td: { padding: '5px 6px', borderBottom: '1px solid var(--dsh-border, #eef0f2)', verticalAlign: 'top', whiteSpace: 'nowrap' },
      tdActions: { padding: '5px 6px', borderBottom: '1px solid var(--dsh-border, #eef0f2)', verticalAlign: 'top' },
      // 行内操作：不换行（「修改｜禁用｜不可删（手写）」同排）；列宽交给内容自适应，不再强制 min-width
      rowActions: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'nowrap' },
      // 长文本兜底：截断 + 悬停看全文（避免把列撑宽）
      ellipsis: { display: 'inline-block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' },
      muted: { opacity: 0.65, fontSize: 12 },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
      ok: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(32,160,90,.16)' },
      bad: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(200,60,60,.16)' },
      warn: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(210,150,20,.18)' },
      idle: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(127,127,127,.16)' },
      banner: { border: '1px solid rgba(210,150,20,.45)', borderRadius: 6, padding: '8px 10px', marginBottom: 10, fontSize: 12 },
      errBox: { border: '1px solid rgba(200,60,60,.45)', borderRadius: 6, padding: '8px 10px', marginBottom: 10, fontSize: 12, whiteSpace: 'pre-wrap' },
      field: { marginBottom: 9 },
      label: { display: 'block', fontSize: 12, opacity: 0.75, marginBottom: 3 },
      actions: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
    }

    const Btn = (props) => h('button', {
      type: 'button',
      style: props.kind === 'primary' ? S.btnPrimary : props.kind === 'danger' ? S.btnDanger : props.kind === 'mini' ? S.btnMini : S.btn,
      disabled: props.disabled === true,
      onClick: props.onClick,
      title: props.title,
    }, props.label)

    const Field = (props) => h('div', { style: S.field },
      h('label', { style: S.label }, props.label + (props.hint ? `（${props.hint}）` : '')),
      props.children)

    /** 状态用大白话：能干活就说「已启用」，出问题才说别的。 */
    function statusText(row) {
      if (row.readOnlyReason !== undefined) return '配置冲突'
      if (row.enabled === false) return '已禁用'
      if (row.stage === 'missing') return '未加载'
      if (row.stage === 'failed') return '加载失败'
      if (row.stage === 'active') return row.toolCount > 0 ? '已启用' : '已启用 · 未发现工具'
      if (row.stage === 'unloading') return '已启用 · 停止中'
      return '已启用 · 加载中'
    }

    /** 状态格的悬停说明（把技术细节收进 title，不占列宽）。 */
    function statusHint(row) {
      if (row.toolCount > 0) {
        return `已发现 ${row.toolCount} 个工具${(row.toolSample ?? []).length > 0 ? `，例如 ${(row.toolSample ?? []).join('、')}` : ''}`
      }
      if (row.enabled === false) return '这一行已被禁用，不会连接'
      if (row.stage === 'failed') return '这一行加载失败，请看宿主日志'
      if (row.stage === 'missing') return '配置在，但当前进程里没有这一行（可能尚未加载）'
      return '这一行已加载，但没有发现它提供的工具（服务端可能没工具，或还在连接）'
    }

    /** 端点/命令摘要（http 给脱敏端点；stdio 给命令 + env 键名）。 */
    function endpointHint(row) {
      if (row.transport === 'stdio') {
        const args = Array.isArray(row.args) ? row.args : []
        const command = [row.command || '（未设置命令）', ...args].join(' ')
        return `${command}${row.envSet ? `　env: ${(row.envKeys ?? []).join(', ')}` : ''}`
      }
      return row.urlSet === true ? `端点：${row.urlMask || '（已设置）'}` : '端点：未设置'
    }

    /**
     * 「服务名」格下的那一行小字：**只放来源注记**。
     * 端点/命令**不在这里显示**（实测：会把首列撑宽、导致整表溢出）；
     * 端点掩码只在「修改」表单的 url 提示里出现（那才是需要它的地方），悬停 title 作为补充。
     */
    function rowSubline(row) {
      return Array.isArray(row.notes) && row.notes.length > 0 ? row.notes.join('；') : ''
    }

    function Panel(props) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [form, setForm] = React.useState(null)
      const [confirmId, setConfirmId] = React.useState('')

      const call = React.useCallback(async (method, payload) => {
        const result = await props.rpc(method, payload || {})
        if (result && result.ok === false) {
          const detail = result.error ?? {}
          const fields = Array.isArray(detail.details?.errors)
            ? '\n· ' + detail.details.errors.map((item) => `${item.field}: ${item.message}`).join('\n· ')
            : ''
          const failure = new Error(`${detail.code ?? 'error'}：${detail.message ?? '调用失败'}${fields}`)
          failure.code = detail.code
          throw failure
        }
        return result
      }, [props])

      const load = React.useCallback(async () => {
        try {
          const next = await call('list')
          setData(next)
          setError(null)
        } catch (failure) {
          setError(String(failure.message ?? failure))
        }
      }, [call])

      React.useEffect(() => {
        let alive = true
        const tick = () => { if (alive) void load() }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      const run = async (label, action) => {
        setBusy(label)
        setError(null)
        try {
          await action()
          await load()
          return true
        } catch (failure) {
          setError(String(failure.message ?? failure))
          return false
        } finally {
          setBusy('')
        }
      }

      const emptyDraft = { serverName: '', transport: 'streamable-http', url: '', command: '', argsText: '', envText: '', cwd: '', failOnStartupError: false }
      const draftOf = (row) => ({
        ...emptyDraft,
        serverName: row.serverName,
        transport: row.transport,
        failOnStartupError: row.failOnStartupError === true,
        failOnStartupErrorOriginal: row.failOnStartupError === true,
        command: row.command ?? '',
        commandOriginal: row.command ?? '',
        argsText: Array.isArray(row.args) ? row.args.join('\n') : '',
        argsOriginal: Array.isArray(row.args) ? row.args.join('\n') : '',
        cwd: row.cwd ?? '',
        cwdOriginal: row.cwd ?? '',
        external: row.origin === 'external',
        id: row.id,
        urlMask: row.urlMask ?? '',
        envKeys: row.envKeys ?? [],
        transportLabel: row.transport,
      })

      const submit = async () => {
        const payload = {
          serverName: form.serverName,
          transport: form.transport,
          expectedRev: data?.revision,
          ...(form.id ? { id: form.id } : {}),
        }
        if (form.external === true) {
          // 手写行：只提交**确实改过**的凭据族字段（未改不重写；空 url/command/env = 保留原值）
          if (form.transport === 'stdio') {
            if (form.command !== '' && form.command !== form.commandOriginal) payload.command = form.command
            if (form.argsText !== form.argsOriginal) payload.args = form.argsText
            if (form.envText.trim() !== '') payload.env = form.envText
            if (form.cwd !== form.cwdOriginal) payload.cwd = form.cwd
          } else if (form.url !== '') {
            payload.url = form.url
          }
          if (form.failOnStartupError !== form.failOnStartupErrorOriginal) payload.failOnStartupError = form.failOnStartupError
        } else {
          // 受管行：整条记录重写（args/cwd 按提交值直取，url/command/env 空 = 保留原值）
          payload.failOnStartupError = form.failOnStartupError
          if (form.transport === 'stdio') {
            payload.command = form.command
            payload.args = form.argsText
            payload.env = form.envText
            payload.cwd = form.cwd
          } else {
            payload.url = form.url
          }
        }
        await run('save', async () => {
          await call('save', payload)
          setForm(null)
        })
      }

      if (data === null && error === null) {
        return h('div', { style: S.wrap }, h('div', { style: S.muted }, '正在读取 MCP 列表…'))
      }

      const rows = data?.servers ?? []
      const writeEnabled = data?.writeEnabled !== false
      const banner = []

      if (data?.drift?.detected) {
        banner.push(h('div', { key: 'drift', style: S.banner },
          `自有层文件被外部改动（${data.drift.reason}）——面板已转只读。二选一处置：`,
          h('div', { style: { ...S.actions, margin: '6px 0' } },
            h(Btn, {
              label: '以清单为准重建文件',
              kind: 'mini',
              disabled: busy !== '',
              onClick: () => void run('heal', () => call('heal', { mode: 'overwrite' })),
            }),
            h(Btn, {
              label: '以文件为准清空清单',
              kind: 'mini',
              disabled: busy !== '',
              onClick: () => void run('heal', () => call('heal', { mode: 'forget' })),
            })),
          h('div', { style: S.note },
            '「重建」用面板清单**覆盖**该文件（若那是你手写的文件，内容会丢）；「清空清单」只清面板的受管记录，不动任何文件。')))
      }
      if (data?.toolsProbe === 'empty') {
        banner.push(h('div', { key: 'probe', style: S.banner },
          '工具探测返回 0：可能这些服务器都没连上，也可能本面板取不到宿主工具表——请把这一条提个 issue（状态列因此可能低估）。'))
      }
      if (writeEnabled === false && !data?.drift?.detected) {
        banner.push(h('div', { key: 'ro', style: S.banner }, '宿主服务未就绪（loader / profileContext 缺失），面板只读。'))
      }

      const list = h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.headRow },
            h('div', { style: S.title }, 'MCP 客户端'),
            h('div', { style: { flex: 1 } }),
            h(Btn, { label: busy === 'refresh' ? '刷新中…' : '刷新', onClick: () => void run('refresh', load), disabled: busy !== '' }),
            h(Btn, { label: '添加', kind: 'primary', onClick: () => setForm({ ...emptyDraft, external: false }), disabled: !writeEnabled || busy !== '' })),
          h('p', { style: S.note },
            '这里管的是「MCP 服务器」——给助手外挂额外工具的那些服务。',
            h('br'),
            '· 能做四件事：添加、改地址或密钥、临时关掉、删除（只有本面板自己添加的才能删）。',
            h('br'),
            '· 密钥不会显示出来：输入框留空就是"不改"；要换就把新的整条粘进去。',
            h('br'),
            '· 本面板添加的行记录在：',
            h('code', { style: S.mono }, data?.paths?.homePatch ?? '$DSH_HOME\\cordis.patch.yml'),
            '（原有手写行仍在 profiles 的 cordis.patch.yml 里，互不覆盖）',
            h('br'),
            '· 状态只说明这一行有没有加载、有没有发现工具，不代表对方服务一定正常。'),
          banner),
        error !== null ? h('div', { style: S.errBox }, error) : null,
        h('div', { style: S.card },
          rows.length === 0
            ? h('div', { style: S.muted }, '当前没有任何 MCP 行（受管或手写）。点右上角「添加」。')
            : h('div', { style: S.tableWrap }, h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', { style: S.th }, '服务名'),
                h('th', { style: S.th }, '行 id'),
                h('th', { style: S.th }, '来源'),
                h('th', { style: S.th }, '状态'),
                h('th', { style: S.th }, '操作'))),
              h('tbody', null, rows.map((row) => h('tr', { key: row.id },
                h('td', { style: S.td, title: endpointHint(row) }, h('span', { style: { ...S.mono, ...S.ellipsis }, title: row.serverName }, row.serverName || '—'),
                  rowSubline(row) === '' ? null : h('div', { style: S.muted }, rowSubline(row))),
                h('td', { style: S.td }, h('span', { style: { ...S.mono, ...S.ellipsis }, title: row.id }, row.id)),
                h('td', { style: S.td }, row.origin === 'managed'
                  ? '受管'
                  : h('span', null, '手写',
                    row.overridden === true ? h('span', { style: { ...S.idle, marginLeft: 6 } }, '已覆盖') : null)),
                h('td', { style: S.td, title: statusHint(row) }, statusText(row)),
                h('td', { style: S.tdActions }, h('div', { style: S.rowActions },
                  h(Btn, { label: '修改', kind: 'mini', disabled: busy !== '' || !writeEnabled, onClick: () => setForm(draftOf(row)) }),
                  h(Btn, {
                    label: row.enabled === false ? '启用' : '禁用',
                    kind: 'mini',
                    disabled: busy !== '' || !writeEnabled || row.readOnlyReason !== undefined,
                    onClick: () => void run('toggle', () => call('setEnabled', { id: row.id, enabled: row.enabled === false, expectedRev: data?.revision })),
                  }),
                  // 「不可删」紧贴"禁用/启用"之后，删除按钮仍只为受管行出现
                  row.origin === 'managed'
                    ? null
                    : h('span', {
                      style: S.muted,
                      title: '手写行不能删除：它在 profiles 的 cordis.patch.yml 里手写声明；如要移除请编辑该文件，或改用「禁用」',
                    }, '不可删'),
                  row.origin === 'external' && row.overridden === true
                    ? h(Btn, {
                      label: '撤销覆盖',
                      kind: 'mini',
                      disabled: busy !== '' || !writeEnabled,
                      title: '把该行还原为 profile patch 里 insert 行的原值（移除覆盖行）',
                      onClick: () => void run('revert', () => call('revert', { id: row.id, expectedRev: data?.revision })),
                    })
                    : null,
                  row.origin === 'managed'
                    ? (confirmId === row.id
                      ? h(Btn, {
                        label: busy === 'remove' ? '删除中…' : '确认删除',
                        kind: 'danger',
                        disabled: busy !== '',
                        onClick: () => void run('remove', async () => {
                          await call('remove', { id: row.id, expectedRev: data?.revision })
                          setConfirmId('')
                        }),
                      })
                      : h(Btn, { label: '删除', kind: 'mini', disabled: busy !== '' || !writeEnabled, onClick: () => setConfirmId(row.id) }))
                    : null)))))))),
        form !== null ? renderForm() : null)

      function renderForm() {
        const isStdio = form.transport === 'stdio'
        const editing = typeof form.id === 'string'
        const frozen = form.external === true
        return h('div', { style: S.card },
          h('div', { style: S.title }, editing ? `修改 ${form.id}${frozen ? '（原手写行）' : ''}` : '添加 MCP'),
          frozen
            ? h('p', { style: S.note }, '保存会在 profile patch 末尾写入 / 原地更新一条同 id 的覆盖行（DSH 官方配置编辑器行为），原来的 insert 行保持不变；列表里的「撤销覆盖」可还原原值。标识与协议在本面板不可改。')
            : null,
          h(Field, { label: 'serverName', hint: 'A-Z a-z 0-9 _ - ，1–32；全局唯一' },
            h('input', {
              style: S.input,
              value: form.serverName,
              disabled: frozen,
              placeholder: 'sorftime',
              onChange: (event) => setForm({ ...form, serverName: event.target.value }),
            })),
          h(Field, { label: 'transport', hint: '下拉选择，避免手写错值' },
            h('select', {
              style: S.select,
              value: form.transport,
              disabled: frozen,
              onChange: (event) => setForm({ ...form, transport: event.target.value }),
            }, TRANSPORTS.map((item) => h('option', { key: item.value, value: item.value }, item.label)))),
          isStdio ? h('div', null,
            h(Field, { label: 'command', hint: editing ? '留空 = 不改' : '必填' },
              h('input', { style: S.input, value: form.command, placeholder: 'npx', onChange: (event) => setForm({ ...form, command: event.target.value }) })),
            h(Field, { label: 'args', hint: '一行一个参数；留空 = 无参数（不改请保持原样）' },
              h('textarea', { style: S.textarea, value: form.argsText, onChange: (event) => setForm({ ...form, argsText: event.target.value }) })),
            h(Field, {
              label: 'env',
              hint: form.external || editing
                ? `KEY=VALUE，一行一条；留空 = 不改${(form.envKeys ?? []).length > 0 ? `（现有键：${form.envKeys.join(', ')}）` : ''}`
                : 'KEY=VALUE，一行一条；MCP 子进程会清洗宿主环境，密钥必须写这里',
            },
            h('textarea', { style: S.textarea, value: form.envText, onChange: (event) => setForm({ ...form, envText: event.target.value }) })),
            h(Field, { label: 'cwd', hint: '可留空' },
              h('input', { style: S.input, value: form.cwd, onChange: (event) => setForm({ ...form, cwd: event.target.value }) })))
            : h(Field, {
              label: 'url',
              hint: editing ? `留空 = 不改${form.urlMask ? `（现值掩码：${form.urlMask}）` : ''}` : '必填，http(s) 绝对 URL',
            },
            h('input', {
              style: S.input,
              value: form.url,
              placeholder: editing ? '（不回显；要改请粘贴完整 URL）' : 'https://example.com/mcp?key=…',
              onChange: (event) => setForm({ ...form, url: event.target.value }),
            })),
          h('label', { style: { ...S.muted, display: 'block', marginBottom: 10 } },
            h('input', {
              type: 'checkbox',
              checked: form.failOnStartupError === true,
              onChange: (event) => setForm({ ...form, failOnStartupError: event.target.checked }),
            }),
            ' failOnStartupError（开 = 端点坏时该行拒绝激活并标红；关 = 静默缺工具、靠自动重连）'),
          h('div', { style: S.actions },
            h(Btn, { label: busy === 'save' ? '保存中…' : '保存', kind: 'primary', disabled: busy !== '', onClick: () => void submit() }),
            h(Btn, { label: '取消', disabled: busy !== '', onClick: () => setForm(null) })),
          h('p', { style: S.note }, '只有点「保存」才写盘；保存后宿主热重载该行（不重启宿主）。'))
      }

      return h('div', { style: S.wrap }, list)
    }

    return {
      name: 'dsh-mcp-client-manager',
      inject: ['slots', 'connection'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-mcp-client-manager',
          order: 23,
          label: () => 'MCP 客户端',
          inject: () => ({
            /** 拆包：成功 = value 载荷；失败 = { ok:false, error }。 */
            rpc: (method, payload, signal) => ctx.connection.rpc.call('/api', RPC_ENDPOINT, { method, payload: payload || {} }, signal)
              .then((result) => (result && result.ok === true ? result.value : result)),
          }),
        }, Panel))
      },
    }
  },
})
