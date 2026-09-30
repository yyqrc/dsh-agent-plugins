# agent-plugins 安装与故障速查（独立仓库形态）

本文面向把这个插件装进 DeepSeek Harness（DSH）的人或 AI。插件源码、`AGENTS.md`、`install.ps1` 和本文同目录。

## 前置条件（缺一不可，先查）

1. 本机有一个 DSH 仓库 checkout（默认路径 `%USERPROFILE%\Documents\deepseek-harness`，可用 `install.ps1 -DshRepo <路径>` 覆盖），且**本插件目录必须能被该仓库的 pnpm workspace 看到**——`package.json` 里的 `workspace:^` 依赖只有在 DSH workspace 内才能解析。独立 clone 出来的本仓库单独 `pnpm install` 是行不通的。
2. pnpm 版本 **11.7.0**（DSH 仓库锁死；其他版本会报 version check 错误）。检查：`pnpm --version`。没有就：
   ```powershell
   corepack enable --install-directory $env:LOCALAPPDATA\corepack-shims pnpm
   corepack prepare pnpm@11.7.0 --activate
   $env:PATH = "$env:LOCALAPPDATA\corepack-shims;$env:PATH"   # 或重开终端
   ```
3. Node ≥ 22.19（DSH 仓库要求）。
4. DSH 的 profile 装配里已有 loader 行（`~/.dsh/profiles/web/cordis.patch.yml`）：
   ```yaml
   - insert:
       - id: agent-plugins
         name: '@deepseek-ai/dsh-agent-plugins'
   ```
   没有就加，然后重启 DSH 才生效。

## 安装步骤（clone 后）

### A. 用脚本自动装配（推荐）

在 PowerShell 里跑 `install.ps1`（与本 README 同目录），脚本会：

1. 把本插件目录 junction 进 DSH 仓库的 `apps/cli/node_modules/@deepseek-ai/dsh-agent-plugins`；
2. 把本插件目录的 `node_modules` junction 到 DSH 编译锚点的 `packages/extensions/agent-plugins/node_modules`，让 Node 从独立仓真实路径解析 workspace 依赖；
3. 再 junction 进 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-agent-plugins`；
4. 检查 `~/.dsh/profiles/web/cordis.patch.yml` 是否有 loader 行，缺失时给出要追加的内容（不自动改文件）。

### B. 手动装配（脚本不可用时）

```powershell
$src = "<本插件目录绝对路径>"
$deps = "<DSH仓库>\packages\extensions\agent-plugins\node_modules"
$cli = "<DSH仓库>\apps\cli\node_modules\@deepseek-ai\dsh-agent-plugins"
$prof = "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-plugins"
New-Item -ItemType Junction -Path (Join-Path $src 'node_modules') -Target $deps
New-Item -ItemType Junction -Path $cli -Target $src -Force
New-Item -ItemType Junction -Path $prof -Target $cli -Force
```

### C. 编译（源码改动后必须做）

在本仓库目录直接跑一键脚本（它会镜像到 DSH 编译锚点，在 DSH 仓库根完成 tsc/tsdown/vitest/oxlint/constraints，再把 lib 拷回本仓库）：

```powershell
powershell -File <本仓库路径>\sync-to-dsh.ps1
```

> 为什么不能直接 `tsc --build <本仓库路径>\tsconfig.json`：本仓库 `tsconfig.json` 的 `references` 是按 DSH 仓库内 `packages\extensions\agent-plugins` 的位置写的相对路径，独立路径下解析不到（junction 只影响运行时 node_modules 解析，不影响 tsc 的相对路径）。分步等价命令见 `AGENTS.md` 的「迭代工作流」。

### D. 重启 DSH 验证

重启后新开/恢复会话，检查技能目录里出现 `<plugin>-<skill>` 命名的条目（例如 `demo-toolkit-apply-hotfix`、`sample-engine-native-debug`）。看不到就先按下面「故障排查」。

## 插件目录要满足什么（发现与清单）

每个扫描根下一层的目录，只要带下面**任一**清单就会被加载：

- 标准 `plugin.json`（Agent Plugins 1.0）
- `.codex-plugin/plugin.json`（Codex 部署清单）
- `.claude-plugin/plugin.json`（Claude Code 部署清单）

三者排名 `plugin.json` > `.codex-plugin` > `.claude-plugin`，且**每项配置各自取排名最高且提供了该项的清单**：名称、skills 根、MCP 声明互不牵连，方言只补标准没给的那一项（不做字段级合并，也不整体接管）。所以"标准 `plugin.json` 只写 name、skills 和 MCP 都写在 `.codex-plugin` 里"是受支持的常见形态。

- skills 根缺省是 `skills/`；方言声明了 `skills`（字符串或数组，插件相对路径）时以它为准。
- MCP 取**第一个有内容的来源**：标准 `mcp.json`，或方言的 `mcpServers`（内联 map，或插件相对 JSON 路径，如 `"./.claude-mcp.json"`）。
- `type` 可省略（按 `command`/`url` 推断）；`stdio`、`http`、`streamable-http` 三种拼写都接受，后两者都归一到 `streamable-http`。
- `${PLUGIN_ROOT}` 与 `${CLAUDE_PLUGIN_ROOT}` 都展开为插件根目录，`cwd` 强制为插件根。
- 只读**部署清单**：方言的 hook、agent、command、市场元数据都不实现，`.codebuddy-plugin/` 不读。

### 过滤名单按清单 `name` 匹配，不是目录名

`~/.dsh/agent-plugins.yml` 的 `enable`/`disable` 匹配的是 `plugin.json` 的 `name` 字段。**目录名与 `name` 不一致时，必须写 `name`**，否则插件虽已加载却会在技能目录里消失。已踩过的坑：目录 `cptools_mcp` 的清单 `name` 是 `cptools-mcp`，名单里写 `cptools_mcp` 会静默隐藏该插件。

排查手法：打印每个已装插件的清单名，与 `agent-plugins.yml` 的名单逐条比对。

## 编译报错速查表

| 报错 | 原因 | 处理 |
|---|---|---|
| `ERR_PNPM_NO_OFFLINE_META ... node-addon-require-builtin` | 离线缓存缺包 | 去掉 `--offline` 直接 `pnpm install`（需要网络） |
| `This project is configured to use 11.7.0 of pnpm. Your current pnpm is vX.Y.Z` | pnpm 版本不对 | 按「前置条件 2」装 11.7.0 |
| `error TS1443: Module declaration names may only use ' or " quoted strings` | 文件头 `@module` JSDoc 里用了反引号或 `/*` | 把 `@module` 注释里的反引号/斜线星号改写成普通文字 |
| `noImplicitAny / TS7006: Parameter 'x' implicitly has an 'any' type` | 严格模式 | 给参数补显式类型（DSH 全仓 `strict: true`，不允许 any 隐式） |
| `oxlint @stylistic(max-len): This line has a length of N. Maximum allowed is 140` | 行长超 140 | 换行拆开，别用 `// oxlint-disable` 除非有注释说明理由 |
| `oxlint typescript(no-unnecessary-type-assertion)` | 多余类型断言 | 删掉断言（DSH 规则：typed 同进程边界信任 TS，不加运行时防御） |
| `@deepseek-ai/dsh-invariants must be a workspace:^ peerDependency`（package-invariants gate） | 新包缺 invariant 配套 | package.json 的 peer/dev 都加 `@deepseek-ai/dsh-invariants: workspace:^`，tsconfig references 加 `../../runtime-diagnostics/invariants` |
| `package.json version must match root version X`（constraints gate） | 插件版本没跟 DSH 根版本同步 | 把 `version` 改成根 package.json 的版本 |
| `expected a package here (no package.json found)`（constraints gate） | DSH 仓库里存在没有 package.json 的残留目录（如被合并掉的 `client/web-react`） | 删除该残留目录（这不是插件的问题） |
| `session header cwd must be an absolute path`（测试失败） | 测试里 fake session 的 cwd 给了空串 | 用 `process.cwd()` 或绝对路径 |
| 测试全绿但运行中 DSH 看不到插件技能 | `lib/` 是旧的（改 src 后没跑 tsdown） | 重新跑「步骤 C」的 tsdown，然后重启 DSH |
| 技能目录里有插件技能，但模型工具表里看不到该插件的 MCP 工具 | 宿主工具面被收口（本机 Sacha 部署由 `sacha_tools` 控制可见性），MCP 工具已注册但默认 `hidden` | 见下方「MCP 工具默认不进模型工具表」——这是该部署的策略，不是挂载失败 |
| `ERR_MODULE_NOT_FOUND` 从独立插件仓的 `lib/` 报缺少 workspace 包 | 独立仓 `node_modules` 未 junction 到 DSH 编译锚点 | 先在 DSH 根运行 `pnpm install`，再运行 `install.ps1` 创建依赖 junction |

## MCP 工具默认不进模型工具表（不是故障）

改完 loader 重启后，常见误判是「技能出现了、但 MCP 工具没出现 = 挂载失败」。实际上**挂载、注册、进工具表是三件事**：

1. **挂载**：loader 把 `mcp.json` / 方言 `mcpServers` 的每个 server 作为 `dsh-mcp-client` 子插件拉起 → 看子进程是否存在（如 `python.exe .../native_debug_mcp.py`）、http 型看端口是否从仅 Listen 变为 Established。
2. **注册**：工具以 `mcp__ap_<plugin>_<server>__<tool>` 进 `ctx.tools` 注册表 → 用工具目录接口（本机是 `sacha_tools` 的 `catalog`）按关键字查得到即已注册。
3. **进工具表**：`request/header` 里模型实际看到的列表。**本机 Sacha 部署默认把 MCP 工具收口为 `hidden`**，只暴露 16 个常驻工具，所以注册表里有、工具表里没有是正常的策略结果。

判定方法：先按顺序确认 1、2 成立；要确认 3 的链路也通，把目标工具显式解锁（`sacha_tools` 的 `unlock`）后，**下一个** `request/header` 就会带上它（解锁当次不生效，提示原文是 "Unlocked tools become callable only after a later request header advertises them"）。实测：解锁 2 个 MCP 工具后工具表从 16 → 18。

> 该可见性策略属于宿主部署（`sacha_tools`），不归本 loader 管；loader 的职责只到第 2 步「注册进 `ctx.tools`」。如果第 1 或第 2 步就不成立，才回来查本插件（方言清单是否被读到、`serverName` 是否规范化、类型是否可识别）。

## 验证清单（装完 / 改完都要过）

`sync-to-dsh.ps1` 已内置全部步骤；要手动分步复跑（在 DSH 仓库根目录，锚点已镜像的前提下）：

```powershell
pnpm exec tsc --build packages/extensions/agent-plugins/tsconfig.json
pnpm exec vitest run packages/extensions/agent-plugins/tests
pnpm exec oxlint packages/extensions/agent-plugins
pnpm run constraints
```

全绿后把锚点 `lib\*` 拷回本仓库 `lib\`（sync 脚本第 3 步）。三条全绿才叫"编译/测试通过"；运行态验证（技能目录出现、MCP 工具出现）需要重启 DSH 后看会话。

## 迭代工作流（改了代码之后）

1. 在本仓库改 `src/` / `tests/`；
2. 跑 `powershell -File <本仓库路径>\sync-to-dsh.ps1`（镜像 + 编译 + 测试 + lint + constraints + lib 回拷）；
3. 重启 DSH，检查活跃会话技能目录符合全局过滤（`~/.dsh/agent-plugins.yml`）；
4. 全绿后在本仓库 `git add`（只加改动文件，`lib/` 被 ignore）→ commit → push。

详见 `AGENTS.md` 的「迭代工作流」——AI 接手时会先读那份。

## 可选：启动时自动更新已装插件

在 profile patch（`~/.dsh/profiles/web/cordis.patch.yml`）的 agent-plugins 行上加 `config.autoUpdate: true`：

```yaml
- insert:
    - id: agent-plugins
      name: '@deepseek-ai/dsh-agent-plugins'
      config:
        autoUpdate: true
```

开启后每次 DSH 启动会在扫描前读 `~/.dsh/agent-plugins/installed.json`，对比每个记录的 `source` 目录 `plugin.json` 版本与记录版本，不等就整目录重拷（排除 `.git`/`node_modules` 等）并回写记录；本次启动即加载新版本。任何失败只告警并跳过该插件，不影响启动。验证：把某个源目录的 `plugin.json` 版本号改大，重启 DSH，看日志出现 `auto-update refreshed "<name>" <old> -> <new>` 且 `installed.json` 的版本已更新。

## 可选：DSH 侧声明安装（sourcesFile）

`autoUpdate` 只处理「已装插件按 installed.json 的 source 刷新」。要**声明装哪些插件、每个从哪装**（本地路径或 git URL），用 `config.sourcesFile` 指向一个 DSH 侧声明文件（默认 `<dsh home>/agent-plugins/sources.yml`，存在即启用）：

```yaml
# ~/.dsh/agent-plugins/sources.yml —— DSH 侧安装声明，不依赖任何市场清单
plugins:
  demo-toolkit:
    source: D:/plugin-sources/demo-toolkit      # 本地绝对路径
  sample-engine:
    source: ./market/plugins/sample-engine       # 相对本文件的路径
  demo-mcp:
    # git URL；#子路径 选择仓库内子目录作为插件根（多插件共享一个仓库）
    source: git+https://git.example.com/team/plugin-sources.git#demo_mcp
```

默认路径已生效，无需改 patch；要显式指定或禁用，在 profile patch 里配置：

```yaml
- insert:
    - id: agent-plugins
      name: '@deepseek-ai/dsh-agent-plugins'
      config:
        sourcesFile: C:/Users/<you>/.dsh/agent-plugins/sources.yml
        # sourcesFile: false   # 完全禁用声明同步（不读文件、不碰 git、无网络）
```

每次 DSH 启动在扫描前读取声明文件，对每个声明的插件按 `source` 同步到 `pluginDirs[0]`（默认 `~/.dsh/agent-plugins`）：

- `source` 为绝对路径或相对声明文件的路径 → 本地复制，与 `autoUpdate` 同语义；
- `source` 为 git URL（`git+https://...` / `git+git@...`，`git+` 前缀可选）→ 先 `git clone`（首次）或 `git fetch`（已有缓存，缓存在 `~/.dsh/agent-plugins/.marketplace-git/`，同一仓库 URL 只克隆一份），取远端默认分支最新（**无版本 pin**），再按 `plugin.json` 版本与 `installed.json` 记录比较，不等才重拷 + 回写记录；`#子路径`（如 `git+https://...git#demo-toolkit`）把仓库内子目录作为插件根；
- 省略 `source` → 保留 installed.json 记录的 source（只声明"继续托管"）。

任何失败（git 不可用/网络错误/版本缺失/拷贝失败）只告警并跳过该插件，不破坏旧安装、不阻断启动。验证：把某插件的源版本改大后重启 DSH，看日志出现 `sources sync updated "<name>" <old> -> <new>`，`installed.json` 记录同步更新，本次会话加载新版本。

> 注意：声明文件不存在时同步为空（不报错）；`sourcesFile: false` 才完全禁用。未声明（或禁用）的插件即使已安装也保持不动。现有 `install-dsh-plugins.ps1` 手动流程仍可用，两者共用 `installed.json` 簿记格式。

## 常见误操作（别人踩过的坑）

- **在插件目录里直接 `pnpm install`** → 会失败或装出一堆孤儿依赖；必须在 DSH 仓库根目录操作。
- **只改 `src/` 不重建 `lib/`** → 运行中的 DSH 用的是旧代码，改了半天不生效。
- **手动复制目录而不是 junction** → 源码更新后要重新复制，junction 会自动跟随。
- **改 README 结构** → README 受 DSH doc gate 约束（`## Model Experience` 与 `## Known Limitations and Deferred Work` 必须是最后两节，结构固定）。给 AI 或维护者看的说明放 `AGENTS.md` 或本文，不要塞进 README。
