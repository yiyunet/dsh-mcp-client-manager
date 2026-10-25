# @yiyunet/dsh-mcp-client-manager

[简体中文](README.md) | English

A DSH plugin adding an **MCP Client** panel under **Settings → sidebar**: list, add, rewrite, enable/disable
and remove the MCP server rows mounted under `@deepseek-ai/dsh-mcp-client` —
**nothing is written until you press save, and nothing requires a host restart**.

> Written for the author's own daily use first; now published to npm ([`@yiyunet/dsh-mcp-client-manager`](https://www.npmjs.com/package/@yiyunet/dsh-mcp-client-manager)).
> Source is public under MIT. Capabilities and limits are stated below; **nothing outside this document is promised**.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) (currently v1.0.4).

## 1. How it works (one layer, one job)

| Layer | File | Written by | Purpose |
|---|---|---|---|
| Source of truth | `$DSH_HOME/mcp-manager/servers.json` | this plugin | the managed-server list (holds `url` / `env` secrets, mode `0600`) |
| Generated (own layer) | `$DSH_HOME/cordis.patch.yml` | this plugin, full rewrite | renders managed rows into MCP rows; the home layer is inside the HMR watch scope → **hot-applied on save** |
| Hand-written layer | `profiles/<profile>/cordis.patch.yml` | you / the official DSH config editor | **never rewritten directly by this plugin**: edits and toggles go through the official services (`ctx.configEditor` / `ctx.pluginManager`), and **the official services write into this very file** |

**Two write paths that never cross**

> **🔎 Looking for the file? Don't look in the wrong place (the #1 question)**
> Rows **added/removed** by this panel are written to **`$DSH_HOME\cordis.patch.yml`**
> (`$DSH_HOME` = your DSH data root, i.e. `%USERPROFILE%\.dsh`) — **not** to `profiles\<profile>\cordis.patch.yml`.
> The profile patch will only ever contain: ① the rows you hand-wrote; ② the override rows the **official config editor**
> appends when the panel rewrites them. The panel header shows that path in **symbolic** form (no username, no absolute path).

- **Managed rows** (id prefix `mcpx-`): add / rewrite / toggle / delete → written to the plugin's own layer.
- **Hand-written rows** (e.g. `mcp-sorftime`, `mcp-myserver`): only **credential-family fields** and **enable/disable**
  may be changed; **they cannot be deleted**, and `serverName` / `transport` are frozen (edit the profile patch by hand for that).
  Edits go through `ctx.configEditor.edit()` (atomic write, rollback on failure, refuses to write when overridden by a higher layer);
  toggles go through `ctx.pluginManager.setPluginEnabled()`.

**⚠️ Where a hand-written row edit actually lands (learned the hard way)** — the official config editor only recognises
**top-level** `- id:` rows and explicitly excludes `insert` rows (DSH source `packages/boot/config-editor/src/index.ts:117-128`).
Our rows live inside `- insert: [...]`, therefore:

- **First** edit of such a row: a **top-level override row** (`- id: … / name: … / config: …`) is appended at the **end** of
  `profiles/<profile>/cordis.patch.yml`; the original `insert` row stays untouched. Later in the same file = higher priority = the override wins.
- **Further** edits of the same row update that override **in place** — no growing pile.
- The panel marks such a row `手写` + `已覆盖` and offers an extra **"revert override"** button, which uses the official
  semantics (`next === inherited` removes the override) to restore the original `insert` value.
- Consequence: rows the panel never touched can still be edited via the `insert` row; rows the panel **has** overridden
  **ignore** changes to the `insert` row until you revert the override.

**Why the panel does not edit the profile patch directly**: the official edit service cannot address rows nested inside
`- insert: [...]`, writing YAML by hand would need a parser, and **a broken file means the host won't boot next time**.
The plugin's own layer avoids parsing (we only ever write what we generated) and is natively watched by HMR.

## 2. Security rules (hard constraints)

1. **`url` never travels back to the browser** — the panel only shows `protocol//host/…`: no path, no query string, no key fragment.
2. **`env` values of stdio rows never travel back** — only key names and "set / not set".
3. **An empty credential-family field means "keep the current value"** (nothing is rewritten); changing one requires pasting the full value: `url`, `command`, `env`.
4. `serverName` is de-duplicated before saving (live rows + managed list + current draft) — duplicates make the later row fail to load.
5. Managed ids are forced to the `mcpx-` prefix, with **three-level id conflict detection** (live rows / managed list / weak text scan of the hand-written layer). The same id declared twice makes the official side treat the row as `unaddressable` and lock its toggle.
6. **No protocol-level probing**: the status column is row phase + tool count (`mcp__<serverName>__*`); it is **not** a health check (while reconnecting, tools are still listed and only the call fails — documented `mcp-client` behaviour).

## 3. Install

> **Published to npm (easiest)**: `dsh plugin --profile web add @yiyunet/dsh-mcp-client-manager` — or pick one of the options below.

**Option A · local directory (recommended)**

> Sidebar **Plugins** → **Add plugin** → paste the **absolute path** of this repository → **Install**

```sh
# CLI equivalent (<this repo> = absolute path of this plugin directory)
dsh plugin --profile web add "<this repo>"
```

**Option B · install straight from GitHub**

```sh
dsh plugin --profile web add github:yiyunet/dsh-mcp-client-manager
```

> The package has **no `prepare` / build script**, so a git-source install never hits the "approve build scripts" step.
> ⚠️ **Guessed, not tested**: whether Option B works depends on your package manager and on how `dsh plugin` resolves git specifiers — fall back to Option A if it fails.

With `patchReload: live` and bundles inside the HMR watch scope, **no restart is normally needed**;
if the **MCP Client** panel does not appear, restart the host once.

## 4. Verify

| # | Action | Expected |
|---|---|---|
| 1 | Open Settings → sidebar | an **MCP Client** panel appears |
| 2 | Open the panel | hand-written rows are listed (origin = hand-written, sub-label "原手写行"), status is **enabled** or `enabled · no tools found`; endpoint masks / commands live in the tooltip of the "server name" cell (table keeps 5 columns: server / row id / origin / status / actions) |
| 3 | Add an http row (3 fields) → save | `$DSH_HOME/cordis.patch.yml` appears; a `mcpx-*` row is listed; tools become available once mounted |
| 4 | Add a stdio row (command/args/env) → save | same as above; `env` values are stored but never echoed |
| 5 | Change the url of a hand-written row → save | origin becomes "hand-written + overridden"; an override row is appended to `profiles/web/cordis.patch.yml`; the value takes effect immediately |
| 6 | Change the same row again | the override is updated **in place** — no second row |
| 7 | Press "revert override" | the override is removed and the value returns to the `insert` row |
| 8 | Disable / enable a hand-written row | a `disabled` override appears/updates in the profile patch |
| 9 | Delete a managed row | the row disappears from the plugin's own layer, tools go away (hand-written rows have no delete button) |
| 10 | Drift drill: edit `$DSH_HOME/cordis.patch.yml` by hand | the panel turns read-only with two escape hatches (rebuild / forget) |

Read-only inspection (⚠️ output contains keys — do not share):

```sh
dsh --profile web --dump-config
```

Pure-function tests + an integration smoke test (no DSH, no network, never touches your real `$DSH_HOME`):

```sh
cd <this repo>
node --check plugin-src/host/index.mjs
node --check plugin-src/host/store.mjs
node --check plugin-src/host/validate.mjs
node --check plugin-src/host/adapter.mjs
node --check plugin-src/client/client.js
# name the files explicitly: on Node 24, `node --test test` loads `test` as a module and fails with MODULE_NOT_FOUND
node --test test/validate.test.mjs test/store.test.mjs test/host-smoke.mjs
```

```sh
npm test          # the three test files above
npm run verify    # package contract assertions (scripts/verify-package.mjs)
```

`host-smoke.mjs` builds a fake host (a temp dir as `DSH_HOME`) and exercises list / add / duplicate check / toggle / remove /
hand-written-row rewrite / drift and escape hatches / RPC envelope and optimistic locking — and asserts that
**secrets (`url` and `env` values) never appear in any payload sent back to the browser**.

## 5. Rollback

GUI: sidebar **Plugins** → the bundle → **Uninstall**.

CLI:

```sh
dsh plugin --profile web remove "@yiyunet/dsh-mcp-client-manager"
# 2) clear the managed layer (managed MCP rows disappear; hand-written rows are unaffected)
Remove-Item "$env:USERPROFILE\.dsh\cordis.patch.yml"
# 3) clear managed data (optional)
Remove-Item -Recurse "$env:USERPROFILE\.dsh\mcp-manager"
```

## 6. Known limits

### 6.0 Reading the status column

| Shown | Meaning |
|---|---|
| **enabled** | the row loaded **and** this server's tools were discovered (**the only evidence that it really connected**) |
| enabled · no tools found | the row loaded, but no tools were found (server exposes none, or the connection has not finished) |
| enabled · loading / unloading | the row is mid-load / mid-unload |
| **disabled** | the row is switched off and will not connect |
| **failed** | the row failed to load / connect (check host logs) |
| not loaded | the config exists but there is no such row in this process |
| config conflict | the row id is declared by several layers; the official side locked its toggle — fix by hand |

### 6.1 Other limits

- A hand-written row's rewrite lands in the **profile patch** (that is where the official editor writes): first an appended
  top-level override, then in-place updates. Once overridden, editing the `insert` row has no effect until you revert.
  "Revert override" only removes `config`; it leaves other keys (`disabled`, …) on the same row alone.
- Only `streamable-http` / `stdio` are covered; `headers`, `reconnect`, `toolCallTimeoutMs`, `maxInstructionBytes` stay as
  they are in the file (the panel does not manage them; rewrites replace the config as a whole, carrying existing keys over).
- Hand-written rows cannot be deleted and their identity/transport cannot be changed (limits of the official edit service).
- **Drift means read-only**: once the plugin's own layer is modified externally (including newline changes), the panel stops writing.
- No build step and no runtime dependencies: the host half uses only `node:*` plus ctx services, the browser half uses the
  official module-loader factory format.

## 7. Feedback

Found a problem or want a new feature? [Open an issue](https://github.com/yiyunet/dsh-mcp-client-manager/issues/new/choose).
Include the **DSH version** and the **plugin version** — that makes a fix much faster.

The template asks which part broke: "installed but not taking effect" and "config got written wrong"
are two entirely different troubleshooting paths, so report them separately when you can.

**Remove tokens, API keys and internal hostnames before pasting config** — MCP server configs carry
credentials by nature.

## 8. License

MIT — see [LICENSE](LICENSE). Questions and bug reports: open an issue in this repository.
