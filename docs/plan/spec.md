# Spec：为 dsh-agent-plugins 增加 git 市场方式的插件安装（loader 侧市场同步）

> 状态：待批准（Planner 冻结稿，供 Human 批准后由 Executor 实施）

## 1. 目标

让 `@deepseek-ai/dsh-agent-plugins` 在激活时读取 git 市场仓库的插件清单，自动把清单中的插件同步到本地安装根（`Config.pluginDirs`），复用现有 `installed.json` 簿记与 fail-soft 语义。目标是取代当前「手工 git pull + 外部脚本 `install-dsh-plugins.ps1` 拷目录 + 写 `installed.json`」的安装方式，让 DSH 侧获得与市场仓库同步的能力。**不新增用户可调用的命令面。**

## 2. 范围

### 包含

- 读取 marketplace 插件清单：`<市场根>/.agents/plugins/marketplace.json` 的 `plugins[]`（条目字段 `name`、`source`、`description`）。
- `source` 三种形态：
  - 相对路径（相对市场仓库根）→ 本地复制；
  - 绝对路径 → 本地复制（与现有 `installed.json` 语义一致）；
  - git URL（`https://...` 或 `git@...`）→ git clone/fetch 后复制。
- 市场同步语义（已确认决定 A）：**始终跟随远端最新**。对 git 源先更新远端（clone 或 fetch）到默认分支最新，再读插件 `plugin.json` 的 `version`，与 `installed.json` 记录按字符串比较；不等才重拷并回写记录。不做 tag/commit 版本 pin。
- 复用现有原子替换与簿记逻辑：staging 目录 + rename 落位、排除名单（`.git`/`.temp`/`__pycache__`/`node_modules`/`installed.json`/`*.pyc`）、失败 fail-soft（跳过该插件 + 告警，不破坏旧安装、不阻断启动）。
- 激活时同步一次：`apply()` 中先于 `discoverPlugins()` 执行，因此本次激活加载同步后的新版本（与现有 `autoUpdate` 时机一致）。
- 新配置项 `marketplaceSync`，**默认关闭**；开启才产生 git 网络副作用。
- 文档同步：`README.md`、`INSTALL.md`、`AGENTS.md` 中的边界声明与用法说明。

### 不包含（Non-goals）

- 不新增 CLI/命令面（用户已确认本轮只做 loader 侧）。
- 不读 `.claude-plugin/marketplace.json`、`.codebuddy-plugin/marketplace.json`、`.cursor-plugin/marketplace.json` 等其他工具的清单（其他包职责）。
- 不做依赖解析、插件间版本兼容、卸载、回滚到旧版本。
- 不做插件市场 UI，不做按插件的 enable/disable（现有 `agent-plugins.yml` 过滤已覆盖）。

## 3. 项目事实与技术决定

| 事实/决定 | 内容 |
|---|---|
| 现有 loader 流程 | `src/index.ts` `apply()`：`autoUpdate` 可选 → `discoverPlugins(roots)` → 注册 skills/commands/MCP。 |
| 现有簿记 | `src/auto-update.ts` `refreshInstalledPlugins(root)`：读 `<root>/installed.json`，记录 key 为插件目录名，`source` 必须为绝对本地路径；版本字符串比较；staging + rename 原子替换；排除名单与深度上限 64。 |
| 实际市场形态 | `D:\plugin-sources` 是 git 仓库（远端正则 `https://git.example.com/team/plugin-sources.git`），含 `.agents/plugins/marketplace.json`、`.claude-plugin/marketplace.json` 等清单。 |
| 现存安装脚本 | `D:\plugin-sources\scripts\install-dsh-plugins.ps1`：手工 `git pull` + 读 `.agents/plugins/marketplace.json` + 拷目录 + 写 `installed.json`。loader 侧目前无任何市场概念。 |
| git 可用性 | 系统已装 git（实测 2.53.0.windows.1）；DSH 仓库无现成 git 封装（无 simple-git / isomorphic-git / spawn git 先例）→ 用 `node:child_process` spawn 系统 `git` CLI。 |
| 依赖面 | 本包依赖仅 `@deepseek-ai/schemastery` + `yaml`；本功能**零新增 npm 依赖**。 |
| 版本语义（已确认 A） | 不 pin tag；`git fetch` 远端默认分支最新 → 读 `plugin.json.version` 与记录字符串比较 → 不等才重拷。 |
| 清单路径约定 | 与现有脚本一致：每个市场根读 `<根>/.agents/plugins/marketplace.json`。 |
| 配置形态 | `Config` 新增：`marketplaceSync?: boolean`（默认 `false`）、`marketplaceRoots?: string[]`（默认 `[]`，市场仓库根目录列表，优先级同 `pluginDirs`）。 |
| 与 `autoUpdate` 关系 | 并存：`marketplaceSync` 处理「市场 git 仓库 → 安装根」，`autoUpdate` 处理「本地 source → 安装根」。两者都先于 discovery，互不依赖。 |

## 4. 实施前提与依赖

- 目标环境有 `git` CLI（实施时验证 `git --version`）。
- marketplace 清单为现有约定格式（`.agents/plugins/marketplace.json` 的 `plugins[]`，字段 `name`/`source`/`description`）；以 `D:\plugin-sources\.agents\plugins\marketplace.json` 为实测样例。
- 测试环境沿用 vitest + 临时目录模拟文件系统（同 `tests/auto-update.spec.ts` 模式）；git 行为用 mock 或真实 `git` 在临时仓库验证。
- 编译/验证走本仓库 `sync-to-dsh.ps1`（镜像 → tsc → tsdown → vitest → oxlint → constraints → lib 回拷）。

## 5. 实施方案

### 5.1 新增 `src/marketplace.ts`（不依赖 Cordis，仿照 `src/auto-update.ts` 结构）

模块职责：读清单 + git 同步 + 簿记，返回 per-plugin 结果，由 loader 决定日志。

1. **`readMarketplace(manifestPath)`**：读并解析 `<根>/.agents/plugins/marketplace.json` 的 `plugins[]`；坏 JSON/缺文件 fail-soft（返回空或明确错误，不 throw 阻断启动）。
2. **`resolvePluginSource(marketplaceRoot, entry)`**：按 `source` 形态解析为本地源目录或 git URL。
3. **`syncMarketplace(marketplaceRoot, installRoot)`**：
   - 对每个条目解析目标 `<installRoot>/<name>`；
   - 本地源：直接走版本比较 + staging 复制（与 `refreshOne` 同语义，可抽公共复制函数）；
   - git 源：`git clone`（目标不存在）或 `git fetch`（目标存在）到默认分支最新 → 读 `plugin.json.version` → 与记录比较 → 不等则 staging 复制替换 + 回写 `installed.json`（`source` 记 git URL，`version` 记实际版本）。
4. **git 调用封装** `runGit(args, cwd)`：`spawn` 系统 `git`，捕获 stderr，超时与失败返回错误（不 throw 出模块）。
5. **排除名单与深度上限**：与 `src/auto-update.ts` 完全一致；git 元数据（`.git`）本就在排除名单内。

### 5.2 修改 `src/index.ts`

- `Config` 新增 `marketplaceSync?: boolean`（默认 `false`）与 `marketplaceRoots?: string[]`（默认 `[]`）。
- `apply()`：`marketplaceSync === true` 时，在每个 `marketplaceRoots` 根执行 `syncMarketplace(root, installRoot)`（`installRoot` 取 `pluginDirs[0]`，与现有默认安装根一致），随后照常 `discoverPlugins()`。日志格式沿用 `auto-update refreshed` 的既有风格。
- 导出新增函数与类型（沿用现有 `export` 面）。

### 5.3 新增 `tests/marketplace.spec.ts`

- 清单解析（相对路径/绝对路径/git URL、坏 JSON fail-soft）。
- git 同步：clone 全新、fetch 已有、版本不变不更新、版本变化重拷+回写。
- 失败路径：git 命令失败、无 `plugin.json`、拷贝失败 → 跳过 + 旧安装完好 + 无 staging 残留。
- `marketplaceSync` 默认关零写入（集成在 `agent-plugins.spec.ts` 或本文件内验证 apply 不触发同步）。

### 5.4 文档同步

- `README.md`：新增 Config 表行（`marketplaceSync`/`marketplaceRoots`）与「Marketplace sync」小节；更新 Known Limitations（移除"no remote installation"表述，改为"无命令面/无版本 pin"等新边界）。
- `INSTALL.md`：新增开启方式与验证步骤。
- `AGENTS.md`：更新「不是插件市场、不是远程安装器」边界声明（改为「默认不读市场清单，仅显式开启 `marketplaceSync` 时读取」），并同步「测试必须覆盖的行为面」。

## 6. 验收标准

1. `marketplaceSync` 关闭（默认）时，`apply()` 行为与现状完全一致，**零写入**（不读清单、不碰 git、不写 `installed.json`）。
2. 开启时：读市场清单 → 同步 git 插件到 `pluginDirs[0]` → `discoverPlugins()` 加载同步后的新版本。
3. git 同步失败（网络不可达、git 缺失、坏版本）→ 仅告警跳过该插件，**不破坏旧安装、不阻断启动**。
4. `installed.json` 记录正确回写（`source` 为 git URL 或本地路径、`version` 为实际安装版本、`installedAt`）。
5. 版本字符串不变时不重拷、不写文件；变化时重拷 + 回写，排除名单生效。
6. 全绿：`sync-to-dsh.ps1` 内置 tsc / tsdown / vitest / oxlint / constraints 全部通过。
7. 文档三件套（`README.md`/`INSTALL.md`/`AGENTS.md`）与本行为一致，无相互矛盾表述。

## 7. 失败保护与回退

- **默认关闭**：不开启 `marketplaceSync` 则完全无远程副作用，现有用户零影响。
- **staging + rename 原子替换**：任何失败（网络中断、git 报错、校验失败、拷贝失败）→ 删除 staging → 旧安装完好 → 告警跳过该插件。
- **不写插件目录**：同步只写安装根与 `installed.json`，不修改已加载插件内容。
- **回退路径**：关闭 `marketplaceSync` + 手动重跑现有 `install-dsh-plugins.ps1` 即回到旧流程；`installed.json` 兼容现有格式（新字段只增不改）。

## 8. 风险与未验证项

| 风险/未验证 | 影响 | 验证方式 |
|---|---|---|
| marketplace 官方格式细节未核对（本轮 web 搜索工具无 key） | 若 `.agents/plugins/marketplace.json` 与 agent-plugins.org 官方标准不符，需对齐字段 | 实施时对照官方文档核对；本地以 `D:\plugin-sources` 现有清单为基准 |
| git URL 默认分支 fetch/checkout 语义 | 需真实远端验证 | 实施后可用 `https://git.example.com/team/plugin-sources.git` 做一次真实同步验证 |
| Windows 下 `spawn('git')` 参数与凭据（HTTPS credential manager）行为 | 命令参数、超时、凭据弹窗 | 实施时在本地真实 git 仓库实测 |
| 并发 DSH 启动同步竞争 | 与现有 `autoUpdate` 相同（last-writer-wins 全快照） | 沿用现有文档化并发上限，不做进程锁 |

## 9. 主要代码与资源位置

- `D:\dsh-agent-plugins\src\marketplace.ts`（新增）
- `D:\dsh-agent-plugins\src\index.ts`（Config + `apply()` 挂接 + 导出）
- `D:\dsh-agent-plugins\tests\marketplace.spec.ts`（新增）
- `D:\dsh-agent-plugins\tests\agent-plugins.spec.ts`（默认关零写入集成）
- `D:\dsh-agent-plugins\README.md` / `INSTALL.md` / `AGENTS.md`（文档同步）
- 参考：`src/auto-update.ts`（staging/簿记/排除名单）、`D:\plugin-sources\scripts\install-dsh-plugins.ps1`（现有约定）、`D:\plugin-sources\.agents\plugins\marketplace.json`（清单样例）
