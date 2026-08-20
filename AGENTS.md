# agent-plugins 维护规则（AI 必读）

本文件是 `@deepseek-ai/dsh-agent-plugins` 的维护规则 Owner。任何 AI 修改本目录前，先完整读取本文件与 `README.md`；修改行为后必须同步更新本文件、`README.md`、`INSTALL.md` 和对应测试。

## 这个插件是什么（一句话）

把 agent-plugins.org 1.0 目录格式的插件（`plugin.json` + `mcp.json` + `skills/` + `commands/`）翻译到 DeepSeek Harness 的注册表：skills 进 `ctx.skills`、commands 进 `ctx.commands`、MCP servers 动态挂载为 `dsh-mcp-client` 子实例。

## 这个插件不是什么（禁止改偏的边界）

- 不是插件市场、不是远程安装器：只扫描本地目录（`Config.pluginDirs`，默认 `<dsh home>/agent-plugins`），不读 `marketplace.json`，不做版本管理。
- 不是 Claude Code / Codex 插件系统兼容层：**不读** `.claude-plugin/`、`.codex-plugin/`、`.codebuddy-plugin/`、`hooks.json`、`AGENTS.md` 代理文件。这些属于其他包（如 `hooks-claude-code`）的职责，不要合并进来。
- 不实现 Agent Plugins 1.0 的 `agents/`、`hooks/` 目录面——只消费 skills、commands、MCP 三样。
- 不写插件目录本身：loader 只读插件文件，绝不修改被加载的插件。

## 核心设计决策（每个都有测试，改前必须看后果）

1. **命名空间默认开**：`namespaceSkills` / `namespaceCommands` 默认 `true`，技能/命令名变成 `<plugin>-<skill>`（如 `cgame-unity-xlua-hotfix`）。目的是让两个插件的同名技能都能被寻址。关掉会回归 first-wins 遮蔽——除非有明确需求，不要改默认值。
2. **过滤语义**：全局文件 `<dsh home>/agent-plugins.yml`。`enable` 是非空白名单；`disable` **恒胜**于 enable；`workspaces` 按 cwd 路径前缀（边界安全匹配）把该条目的 enable/disable **合并**到全局。`filterForWorkspace()` 是唯一合并点，改过滤必须同步改它和 `isPluginEnabled()`。
3. **MCP 不参与过滤**：MCP tools 挂在进程级 `ctx.tools`，按 workspace 过滤会破坏共享注册表。这是刻意设计，README 的 Limitations 里也写了；不要"顺手"把 MCP 塞进过滤。
4. **`${PLUGIN_ROOT}` 展开**：mcp.json 里的变量展开为插件根目录绝对路径，`cwd` 强制为插件根目录。这是 Agent Plugins 标准语义。
5. **serverName 规范化**：`ap_<plugin>_<serverKey>`，非法字符替换为 `_`，截断 32 字符；重名时后者跳过并警告（不自动改名）。
6. **fail-soft 边界**：单个 skill/command/mcp 条目坏 → 跳过该条目 + 日志警告；`plugin.json` 坏或缺失 → 拒绝整个插件；跨根同名插件 → 先者赢。不要改成"一个坏条目拖垮整个插件"。
7. **技能注册走 cwd 敏感 provider**（`PluginSkillProvider`）：因为要按会话 workspace 过滤，不能用一次性 `ctx.skills.register()`。provider 的 `list()` 每次读全局过滤文件并按 `options.cwd` 合并。

## 修改后的验证（必须全过才能声称完成）

在 DSH 仓库根目录（本包必须位于 DSH 的 pnpm workspace 内才能解析 `workspace:^` 依赖）：

```powershell
$env:PATH = "$env:LOCALAPPDATA\corepack-shims;$env:PATH"   # pnpm 必须是 11.7.0
pnpm exec tsc --build packages/extensions/agent-plugins/tsconfig.json
pnpm exec vitest run packages/extensions/agent-plugins/tests
pnpm exec oxlint packages/extensions/agent-plugins
pnpm run constraints
pnpm exec tsx scripts/verify-package-readme-model-experience.ts
pnpm exec tsx scripts/verify-package-readme-limitations.ts
pnpm exec tsx scripts/verify-agent-note-format.ts
```

改完源码必须重新构建 `lib/`（运行中的 DSH 从 `lib/index.js` 加载）：

```powershell
pnpm exec tsdown --env.DSH_BUILD_FACE host   # 全量较慢；lib 产物在本包 lib/
```

编译报错速查见 `INSTALL.md` 的「编译报错速查表」。

## 测试必须覆盖的行为面

- `manifest.spec.ts`：plugin.json 校验、skill/command frontmatter 解析、`${PLUGIN_ROOT}` 展开、stdio/http 两种 MCP、junction 目录发现、坏条目 fail-soft。
- `agent-plugins.spec.ts`：命名空间（开/关）、`isPluginEnabled` 语义、全局过滤文件解析、`filterForWorkspace` 前缀合并、命令注入、被禁用插件的技能隐藏与命令报错。
- `mcp-mount.spec.ts`：MCP 子插件挂载、config 传递、重名跳过。

新增行为 = 新增测试，不要在已有用例上凑合。
