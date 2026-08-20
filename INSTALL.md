# agent-plugins 安装与故障速查（独立仓库形态）

本文面向把这个插件装进 DeepSeek Harness（DSH）的人或 AI。插件源码、`AGENTS.md`、`install.ps1` 和本文同目录。

## 前置条件（缺一不可，先查）

1. 本机有一个 DSH 仓库 checkout（例如 `C:\Users\shifengzhou\Documents\deepseek-harness`），且**本插件目录必须能被该仓库的 pnpm workspace 看到**——`package.json` 里的 `workspace:^` 依赖只有在 DSH workspace 内才能解析。独立 clone 出来的本仓库单独 `pnpm install` 是行不通的。
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
2. 再 junction 进 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-agent-plugins`；
3. 检查 `~/.dsh/profiles/web/cordis.patch.yml` 是否有 loader 行，缺失时给出要追加的内容（不自动改文件）。

### B. 手动装配（脚本不可用时）

```powershell
$src = "<本插件目录绝对路径>"
$cli = "<DSH仓库>\apps\cli\node_modules\@deepseek-ai\dsh-agent-plugins"
$prof = "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-plugins"
New-Item -ItemType Junction -Path $cli -Target $src -Force
New-Item -ItemType Junction -Path $prof -Target $cli -Force
```

### C. 编译（源码改动后必须做）

在 **DSH 仓库根目录**执行（不是在插件目录）：

```powershell
pnpm install --offline --prefer-offline        # 首次，注册 workspace 依赖
pnpm exec tsc --build packages/extensions/agent-plugins/tsconfig.json
pnpm exec tsdown --env.DSH_BUILD_FACE host     # 重新生成 lib/index.js（运行中的 DSH 读的是 lib）
```

### D. 重启 DSH 验证

重启后新开/恢复会话，检查技能目录里出现 `<plugin>-<skill>` 命名的条目（例如 `cgame-unity-xlua-hotfix`、`cgame-engine-native-debug`）。看不到就先按下面「故障排查」。

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

## 验证清单（装完 / 改完都要过）

```powershell
pnpm exec tsc --build packages/extensions/agent-plugins/tsconfig.json
pnpm exec vitest run packages/extensions/agent-plugins/tests
pnpm exec oxlint packages/extensions/agent-plugins
pnpm run constraints
```

三条全绿才叫"编译/测试通过"；运行态验证（技能目录出现、MCP 工具出现）需要重启 DSH 后看会话。

## 常见误操作（别人踩过的坑）

- **在插件目录里直接 `pnpm install`** → 会失败或装出一堆孤儿依赖；必须在 DSH 仓库根目录操作。
- **只改 `src/` 不重建 `lib/`** → 运行中的 DSH 用的是旧代码，改了半天不生效。
- **手动复制目录而不是 junction** → 源码更新后要重新复制，junction 会自动跟随。
- **改 README 结构** → README 受 DSH doc gate 约束（`## Model Experience` 与 `## Known Limitations and Deferred Work` 必须是最后两节，结构固定）。给 AI 或维护者看的说明放 `AGENTS.md` 或本文，不要塞进 README。
