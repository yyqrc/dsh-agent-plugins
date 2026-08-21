# @deepseek-ai/dsh-agent-plugins

Agent Plugins 1.0 compatibility layer.

Discovers agent-plugins.org plugin directories under the configured roots and mounts each plugin's contributions on the harness registries: skills from the plugin's `skills` directory register on `ctx.skills`, slash commands from the plugin's `commands` directory register on `ctx.commands`, and MCP servers from `mcp.json` mount as `dsh-mcp-client` instances whose tools surface under the `mcp__<serverName>__<tool>` namespace.

This package is a compatibility bridge for directory-form plugins. It does not implement the plugin marketplace format, remote plugin installation, or the Claude Code / Codex hook surfaces.

## Plugin

Requires `ctx.skills`, `ctx.commands`, and `ctx.agents` (`inject: ['skills', 'commands', 'agents']`).

### Config

| Field | Default | Meaning |
|---|---|---|
| `pluginDirs` | `[<dsh home>/agent-plugins]` | Absolute directories scanned for plugin subdirectories, in priority order. Earlier roots win duplicate plugin names. The default root sits under the DeepSeek Harness home (`~/.dsh/agent-plugins`, or `$DSH_HOME/agent-plugins` when configured). |
| `namespaceSkills` | `true` | Prefix skill names with the owning plugin name (`<plugin>-<skill>`), so same-named skills from different plugins stay addressable. |
| `namespaceCommands` | `true` | Prefix command names the same way (`<plugin>-<command>`). |
| `projectFilter` | `true` | Honor the global filter file at `<dsh home>/agent-plugins.yml` (see Plugin filter). |
| `autoUpdate` | `false` | Before discovery, refresh each root's plugins recorded in its `installed.json`: when the source directory's `plugin.json` version differs from the record, re-copy the source tree into the install root and rewrite the record (see Auto-refresh). |

### Plugin filter

When `projectFilter` is true, the global filter file `<dsh home>/agent-plugins.yml` selects which installed plugins are enabled:

```yaml
# Global whitelist: when non-empty, only these plugins are visible
# everywhere. This is also the default whitelist for every workspace.
enable:
  - sacha-orchestra
  - cgame-mcp
# Global blacklist: explicit disable; always wins over enable.
disable: []

# Per-workspace additions: a session whose cwd is under one of these
# path prefixes merges the entry's enable/disable onto the global lists.
workspaces:
  - paths:
      - D:/COD/Client
      - E:/MagicDawn/CGameEditorProject/LookDevProject
    enable:
      - cgame-unity
  - paths:
      - E:/CODM/UnitySource
    enable:
      - cgame-engine
```

Skills are filtered at catalog time with the workspace-merged filter, so disabled plugins disappear from the skill catalog and from `skill` lookups for that session. Commands stay registered but answer an error when their plugin is disabled in the session's workspace. MCP servers are process-wide and not filtered.

### Auto-refresh

With `autoUpdate: true`, activation refreshes installed plugins before scanning them. Each configured root may carry an `installed.json` bookkeeping file (written by a plugin installer) mapping a plugin name to its install facts:

```json
{
  "cgame-unity": {
    "source": "D:/cgame-marketplace/cgame-unity",
    "version": "0.5.13",
    "installedAt": "2026-08-20 14:38:02"
  }
}
```

For each record, the source directory's `plugin.json` `version` is compared with the recorded `version` by string equality. When they differ (including missing records or downgrades), the source tree is re-copied into `<root>/<name>` through a staging directory and the record is rewritten (`version`, `installedAt`; `source` and unknown fields survive). Because the refresh runs before discovery, the same activation loads the fresh copies — one DSH restart makes an update effective. `.git`, `.temp`, `__pycache__`, `node_modules`, `installed.json`, and `*.pyc` are never copied.

Records require an absolute `source` path and a plain directory name as key; anything else is skipped. Every failure inside one plugin's refresh (unreadable source, copy error, exceeded copy depth) skips that plugin with a warning and leaves the previous install intact — the refresh never blocks startup and never destroys a working plugin. Enable it through the profile patch:

```yaml
- insert:
    - id: agent-plugins
      name: '@deepseek-ai/dsh-agent-plugins'
      config:
        autoUpdate: true
```

## Discovery

Each configured root is scanned one level deep for directories containing a `plugin.json`. Within one plugin directory:

- `plugin.json` must be a JSON object with a non-empty string `name`; a missing or invalid manifest rejects the whole directory.
- `skills/<name>/SKILL.md` files parse YAML frontmatter with `name` (kebab-case), `description`, optional `whenToUse`, and optional `metadata`; the body becomes the skill content and the skill directory is its resource base. Registered skill names carry the plugin prefix by default (`<plugin>-<name>`).
- `commands/<name>.md` files parse frontmatter `description` and optional `argument-hint`; the body is a prompt template where `$ARGUMENTS` is replaced with the invocation input. The rendered template is injected into the receiving agent as `instructions`-form plugin context. Registered command names carry the plugin prefix by default.
- `mcp.json` (a JSON object with an optional `mcpServers` map) declares `stdio` servers (`command`, `args`, `env`, all with `${PLUGIN_ROOT}` expanded against the plugin root, `cwd` set to the plugin root) and `http` servers (mapped to the bridge's `streamable-http` transport). Each server mounts as a child `dsh-mcp-client` instance whose `serverName` is `ap_<plugin>_<serverKey>` normalized to the bridge namespace grammar and truncated to 32 characters.

Per-file problems (malformed frontmatter, invalid names, unsupported transport types) are logged and skip only that file; a plugin that fails its `plugin.json` is skipped whole. Duplicate plugin names resolve to the earliest root; duplicate normalized MCP server names skip later servers with a warning.

MCP child instances are awaited during this plugin's activation, so the loader reports a failed initial connection as a warning and leaves the rest of the plugin mounted.

## Model Experience

### Skill catalog entries

#### What the model sees

Each mounted skill contributes its `name`, `description`, and `whenToUse` to the session skill catalog that `dsh-tool-skill` publishes, and its body plus resource-base guidance to the `skill` tool result. The exact fields and framing belong to `@deepseek-ai/dsh-tool-skill`; this package supplies the registration content.

#### Token effect

Conditional: each discovered skill adds one catalog line plus its body on demand, proportional to the plugin author's frontmatter and body length.

#### KV Cache effect

Skill bodies enter retained tool history; a later plugin reload publishes a replacement catalog when the catalog digest changes.

### Injected command context

#### What the model sees

When a user runs a mounted slash command, the rendered command template is injected as a `plugin`-sourced `instructions`-form user message wrapped in an `<agent-plugin-command>` frame naming the command and plugin.

#### Token effect

Conditional: one injected message per command invocation, sized by the command template plus the user's argument text.

#### KV Cache effect

Append-only: each invocation appends one instruction message to the request history; repeated invocations of the same command do not deduplicate.

## Known Limitations and Deferred Work

- **No marketplace or remote installation** — only local plugin directories are discovered; `marketplace.json`, remote plugin fetching, version pinning, and enable/disable per plugin are not implemented.
- **No live re-discovery** — the configured roots are scanned once at plugin activation; adding or editing a plugin requires a plugin reload.
- **No hook or agent-file support** — the Agent Plugins hook and agent surfaces (and the Claude Code / Codex hook dialects) are not mapped; commands are the only executable contribution besides skills and MCP tools.
- **Command rendering is a literal template substitution** — `$ARGUMENTS` is replaced verbatim without shell quoting, and no structured-argument schema from the manifest is honored.
- **Normalized MCP server names can collide** — later colliding servers are skipped with a warning instead of being renamed.
- **Auto-refresh is bookkeeping-file driven and unclocked** — it reads only local `installed.json` records (no `marketplace.json`, no remote sources), runs once per activation with no cross-process lock, so concurrent DSH starts on the same root race with last-writer-wins on full snapshots; a running session keeps the version it loaded until the next activation.
- **Refreshed plugins still need an activation boundary** — the refresh happens before discovery, so new versions load on the next DSH restart or plugin reload; a long-running process never re-reads its plugin directories.
