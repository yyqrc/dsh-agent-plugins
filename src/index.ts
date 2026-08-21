/**
 * Agent Plugins 1.0 compatibility layer.
 *
 * Discovers agent-plugins.org plugin directories under the configured roots
 * and mounts each plugin's contributions on the harness registries: skills
 * from the skills directory register on ctx.skills, slash commands from the
 * commands directory register on ctx.commands, and MCP servers from mcp.json
 * mount as dsh-mcp-client instances whose tools surface under the
 * mcp-prefixed server namespace.
 *
 * Skill and command names are namespaced by plugin name by default
 * (`<plugin>-<skill>`, `<plugin>-<command>`) so two plugins shipping the same
 * skill name both stay addressable. A per-project filter file
 * (`<projectRoot>/.dsh/agent-plugins.yml` with `enable`/`disable` plugin-name
 * lists) selects which plugins a workspace sees; skills and commands honor it
 * per session cwd, while MCP servers stay global (tools registry is shared).
 *
 * This package is a compatibility bridge for directory-form plugins; it does
 * not implement the plugin marketplace format, remote plugin installation, or
 * the Claude Code / Codex hook surfaces.
 *
 * With `autoUpdate` enabled (default false), each root's `installed.json`
 * bookkeeping is refreshed before discovery: plugins whose recorded version
 * differs from their source directory's plugin.json version are re-copied
 * from the source, so this activation loads the fresh copies. The refresh
 * writes only into the install root and never touches already-loaded
 * content; every failure inside one plugin is logged and skipped.
 *
 * @module @deepseek-ai/dsh-agent-plugins
 */

import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { refreshInstalledPlugins } from './auto-update.ts'
import {
  discoverPlugins,
  type CommandManifest,
  type LoadedPlugin,
  type McpServerManifest,
} from './manifest.ts'

export { INSTALLED_FILE, refreshInstalledPlugins } from './auto-update.ts'
export type { RefreshResult } from './auto-update.ts'
export { discoverPlugins, expandPluginRoot, loadPlugin, mcpServerName } from './manifest.ts'
export type {
  CommandManifest,
  LoadedPlugin,
  ManifestProblem,
  McpServerManifest,
  PluginManifest,
} from './manifest.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'agent-plugins'

/** Services required before plugin contributions can register. */
export const inject = ['skills', 'commands', 'agents']

/** Default plugin root: `<dsh home>/agent-plugins` (the harness home, `~/.dsh` by default). */
const DEFAULT_PLUGIN_DIR = join(resolveDshHome(), 'agent-plugins')

/** Provider name this package registers on `ctx.skills`. */
export const SKILL_PROVIDER = 'agent-plugins'

/** Global filter file inside the DSH home, next to the agent-plugins install dir. */
export const GLOBAL_FILTER_FILE = 'agent-plugins.yml'

/** Runtime skill rank: same tier as other runtime registrations, under project roots. */
const SKILL_RANK = 250

/** Plugin configuration. */
export interface Config {
  /**
   * Absolute directories scanned for plugin subdirectories, in priority
   * order. Earlier roots win duplicate plugin names. Defaults to
   * `<dsh home>/agent-plugins`.
   */
  pluginDirs?: string[]
  /**
   * Prefix skill names with the owning plugin name (`<plugin>-<skill>`).
   * Default true; disable to keep the manifest's bare names (duplicates
   * between plugins resolve first-wins).
   */
  namespaceSkills?: boolean
  /**
   * Prefix command names with the owning plugin name (`<plugin>-<command>`).
   * Default true.
   */
  namespaceCommands?: boolean
  /**
   * Honor the global filter file at `<dsh home>/agent-plugins.yml` selecting
   * which plugins are enabled. Default true; disable to expose every
   * installed plugin.
   */
  projectFilter?: boolean
  /**
   * Refresh installed plugins before discovery: read each root's
   * `installed.json` bookkeeping file, compare the recorded version with the
   * source directory's `plugin.json` version, and re-copy plugins whose
   * versions differ (staging replacement; failures skip the plugin with a
   * warning). Runs before scanning, so this activation loads the fresh
   * copies; discovery itself stays read-only. Default false — unless
   * enabled, the loader never writes into a plugin directory.
   */
  autoUpdate?: boolean
}

/** Validate and default the plugin configuration. */
export const Config: z<Config> = z.object({
  pluginDirs: z.array(z.string()).default([DEFAULT_PLUGIN_DIR]),
  namespaceSkills: z.boolean().default(true),
  namespaceCommands: z.boolean().default(true),
  projectFilter: z.boolean().default(true),
  autoUpdate: z.boolean().default(false),
})

/** Per-project plugin selection read from the filter file. */
export interface ProjectPluginFilter {
  /** Whitelist: when non-empty, only these plugin names are visible. */
  readonly enable: readonly string[]
  /** Blacklist: these plugin names are hidden unless the whitelist re-admits them. */
  readonly disable: readonly string[]
}

/** One workspace-scoped filter entry keyed by path prefixes. */
export interface WorkspaceFilterEntry {
  /** Absolute or prefix paths whose cwd descendants match this entry. */
  readonly paths: readonly string[]
  /** Extra whitelist entries merged onto the global whitelist. */
  readonly enable: readonly string[]
  /** Extra blacklist entries merged onto the global blacklist. */
  readonly disable: readonly string[]
}

/** Full parsed filter: global entries plus workspace-scoped additions. */
export interface ParsedPluginFilter {
  readonly global: ProjectPluginFilter
  readonly workspaces: readonly WorkspaceFilterEntry[]
}

/** Plugin-independent empty filter: everything visible. */
export const NO_PROJECT_FILTER: ProjectPluginFilter = Object.freeze({ enable: [], disable: [] })

/** Parsed empty filter with no workspace entries. */
export const NO_PARSED_FILTER: ParsedPluginFilter = Object.freeze({ global: NO_PROJECT_FILTER, workspaces: [] })

/**
 * Normalize an arbitrary plugin name into the skill/command name grammar.
 * @param pluginName - raw plugin.json name.
 * @returns kebab-case prefix safe to join with `-`.
 */
export function normalizePluginNamespace(pluginName: string): string {
  const normalized = pluginName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized.length > 0 ? normalized : 'plugin'
}

/**
 * Compose a namespaced skill or command name.
 * @param pluginName - raw plugin.json name.
 * @param skillName - manifest skill or command name.
 * @returns `<plugin>-<name>` under the kebab-case grammar.
 */
export function namespacedName(pluginName: string, skillName: string): string {
  return `${normalizePluginNamespace(pluginName)}-${skillName}`
}

/**
 * Read and parse the global plugin filter from `<dsh home>/agent-plugins.yml`.
 * @returns the parsed filter, or the empty filter when absent or unreadable.
 */
export async function readProjectFilter(): Promise<ParsedPluginFilter> {
  const path = join(resolveDshHome(), GLOBAL_FILTER_FILE)
  try {
    const raw = await readFile(path, 'utf8')
    return parseProjectFilterYaml(raw, path)
  } catch (error) {
    if (isAbsentError(error)) return NO_PARSED_FILTER
    throw new Error(`agent-plugins: unreadable plugin filter ${path}: ${String(error)}`)
  }
}

/**
 * Merge the global filter with the workspace entry whose path prefixes match
 * the given cwd. Workspace `enable` entries append to the global whitelist;
 * `disable` entries append to the global blacklist (disable always wins).
 * @param parsed - parsed global filter with workspace entries.
 * @param cwd - session workspace selector; empty cwd uses the global filter alone.
 * @returns the effective filter for this workspace.
 */
export function filterForWorkspace(parsed: ParsedPluginFilter, cwd: string | undefined): ProjectPluginFilter {
  if (cwd === undefined || cwd === '' || parsed.workspaces.length === 0) return parsed.global
  const normalized = resolve(cwd)
  const matching = parsed.workspaces.filter(entry =>
    entry.paths.some((path) => {
      const prefix = resolve(path)
      return normalized === prefix || normalized.startsWith(prefix + sep)
    }))
  if (matching.length === 0) return parsed.global
  return {
    enable: [...new Set([...parsed.global.enable, ...matching.flatMap(entry => entry.enable)])],
    disable: [...new Set([...parsed.global.disable, ...matching.flatMap(entry => entry.disable)])],
  }
}

/**
 * Whether one plugin name is visible under a project filter.
 * @param filter - parsed project filter.
 * @param pluginName - plugin.json name.
 * @returns true when the plugin is visible in this workspace.
 */
export function isPluginEnabled(filter: ProjectPluginFilter, pluginName: string): boolean {
  if (filter.disable.includes(pluginName)) return false
  if (filter.enable.length > 0 && !filter.enable.includes(pluginName)) return false
  return true
}

/** Parse the small YAML filter file; malformed content fails closed to the empty filter. */
function parseProjectFilterYaml(raw: string, path: string): ParsedPluginFilter {
  let data: unknown
  try {
    data = parseYaml(raw)
  } catch (error) {
    throw new Error(`agent-plugins: invalid project filter ${path}: ${String(error)}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return NO_PARSED_FILTER
  const record = data as Record<string, unknown>
  return {
    global: {
      enable: parseStringList(record.enable, path, 'enable'),
      disable: parseStringList(record.disable, path, 'disable'),
    },
    workspaces: parseWorkspaceEntries(record.workspaces, path),
  }
}

/** Parse the `workspaces` list of path-scoped entries. */
function parseWorkspaceEntries(value: unknown, path: string): readonly WorkspaceFilterEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`agent-plugins: project filter ${path} field "workspaces" must be a list`)
  }
  return value.map((entry, index): WorkspaceFilterEntry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`agent-plugins: project filter ${path} workspaces[${index}] must be an object`)
    }
    const record = entry as Record<string, unknown>
    const rawPaths = record.paths
    if (!Array.isArray(rawPaths) || rawPaths.length === 0
      || !rawPaths.every(entryPath => typeof entryPath === 'string' && entryPath.trim().length > 0)) {
      throw new Error(`agent-plugins: project filter ${path} workspaces[${index}] requires a non-empty "paths" list`)
    }
    return {
      paths: rawPaths as string[],
      enable: parseStringList(record.enable, path, `workspaces[${index}].enable`),
      disable: parseStringList(record.disable, path, `workspaces[${index}].disable`),
    }
  })
}

function parseStringList(value: unknown, path: string, field: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) {
    throw new Error(`agent-plugins: project filter ${path} field "${field}" must be a list of plugin names`)
  }
  return value
}

/**
 * Discover the configured plugin directories and register every parsed
 * contribution. When `autoUpdate` is enabled, each root's `installed.json`
 * is refreshed first, so discovery reads the fresh copies; the refresh is
 * fail-soft and never blocks a later plugin from loading. Discovery is
 * awaited at activation so a missing or broken plugin directory fails this
 * instance loud; per-file problems inside a discovered plugin are logged
 * and skip only that file.
 *
 * Skills register through a cwd-sensitive provider so the per-project filter
 * applies per session. Commands check the filter inside their handlers. MCP
 * bridges mount as child plugins and stay global; disposal disconnects them
 * through their own lifecycle.
 * @param ctx - plugin context carrying the skill and command registries.
 * @param config - plugin root configuration.
 * @returns activation readiness after discovery and registration settle.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const roots = (config.pluginDirs ?? [DEFAULT_PLUGIN_DIR]).map(root => resolve(root))
  if (config.autoUpdate === true) {
    for (const root of roots) {
      for (const result of await refreshInstalledPlugins(root)) {
        if (result.action === 'updated') {
          ctx.logger.info(`agent-plugins: auto-update refreshed "${result.plugin}" ${result.from ?? '?'} -> ${result.to ?? '?'}`)
        } else if (result.action === 'skipped') {
          ctx.logger.warn(`agent-plugins: auto-update skipped "${result.plugin}": ${result.reason ?? 'unknown reason'}`)
        }
      }
    }
  }
  const { plugins, problems } = await discoverPlugins(roots)
  for (const problem of problems) {
    ctx.logger.warn(`agent-plugins: ${problem.path}: ${problem.reason}`)
  }

  const settings = {
    namespaceSkills: config.namespaceSkills ?? true,
    namespaceCommands: config.namespaceCommands ?? true,
    projectFilter: config.projectFilter ?? true,
  }

  if (settings.projectFilter) {
    for (const plugin of plugins) {
      for (const command of plugin.commands) {
        ctx.effect(() => ctx.commands.register(registerCommand(ctx, plugin, command, settings.namespaceCommands)),
          `agent-plugins: register command ${command.name}`)
      }
    }
    ctx.effect(() => ctx.skills.registerProvider(
      control => new PluginSkillProvider(ctx, plugins, control, settings.namespaceSkills),
    ), 'agent-plugins: register skill provider')
  } else {
    for (const plugin of plugins) {
      for (const skill of plugin.skills) {
        ctx.effect(() => ctx.skills.register(namespacedSkill(plugin, skill, settings.namespaceSkills)),
          `agent-plugins: register skill ${skill.name}`)
      }
      for (const command of plugin.commands) {
        ctx.effect(() => ctx.commands.register(registerCommand(ctx, plugin, command, settings.namespaceCommands)),
          `agent-plugins: register command ${command.name}`)
      }
    }
  }

  const serverNames = new Set<string>()
  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) {
      if (serverNames.has(server.serverName)) {
        ctx.logger.warn(`agent-plugins: skipping MCP server "${server.serverName}": duplicate normalized server name`)
        continue
      }
      serverNames.add(server.serverName)
      await mountMcpServer(ctx, server)
    }
  }
}

/** Clone one parsed skill onto a namespaced runtime registration. */
function namespacedSkill(
  plugin: LoadedPlugin,
  skill: LoadedPlugin['skills'][number],
  namespace: boolean,
): typeof skill {
  if (!namespace) return skill
  return { ...skill, name: namespacedName(plugin.manifest.name, skill.name) }
}

/**
 * cwd-sensitive skill provider: `list()` filters plugins by the workspace's
 * project filter file, so per-project enable/disable applies to the skill
 * catalog and to `skill` tool lookups without touching global registrations.
 */
class PluginSkillProvider implements SkillProvider {
  readonly name = SKILL_PROVIDER

  constructor(
    private readonly ctx: Context,
    private readonly plugins: readonly LoadedPlugin[],
    private readonly control: SkillProviderControl,
    private readonly namespace: boolean,
  ) {}

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    let filter: ProjectPluginFilter
    try {
      filter = filterForWorkspace(await readProjectFilter(), options.cwd)
    } catch (error) {
      this.ctx.logger.warn(`agent-plugins: ${String(error)}`)
      filter = NO_PROJECT_FILTER
    }
    const candidates: SkillCandidate[] = []
    for (const plugin of this.plugins) {
      if (!isPluginEnabled(filter, plugin.manifest.name)) continue
      for (const skill of plugin.skills) {
        const registered = namespacedSkill(plugin, skill, this.namespace)
        candidates.push({
          name: registered.name,
          description: registered.description,
          ...registered.whenToUse !== undefined ? { whenToUse: registered.whenToUse } : {},
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'agent-plugin',
          provider: this.name,
          rank: SKILL_RANK,
          ...registered.resourceBase !== undefined ? { resourceBase: registered.resourceBase } : {},
          ...registered.path !== undefined ? { path: registered.path } : {},
          ...registered.metadata !== undefined ? { metadata: registered.metadata } : {},
          locator: registered,
        })
      }
    }
    this.control.signal.throwIfAborted()
    return candidates
  }

  get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as LoadedPlugin['skills'][number]
    return Promise.resolve({
      name: candidate.name,
      description: candidate.description,
      ...candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {},
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      ...candidate.resourceBase !== undefined ? { resourceBase: candidate.resourceBase } : {},
      ...candidate.path !== undefined ? { path: candidate.path } : {},
      ...candidate.metadata !== undefined ? { metadata: candidate.metadata } : {},
      content: locator.content,
    })
  }
}

/**
 * Register one plugin command whose handler injects the rendered template as
 * context for the receiving agent. The injection uses the durable
 * `plugin`-sourced user message, so the invocation stays reconstructable
 * from the session log. When the workspace's project filter hides the owning
 * plugin, the command answers an error instead of injecting.
 * @param ctx - plugin context used to resolve the receiving agent later.
 * @param plugin - owning plugin, named in the injected context.
 * @param command - parsed command template.
 * @param namespace - whether the registered command name carries the plugin prefix.
 * @returns the command definition for `ctx.commands.register()`.
 */
function registerCommand(
  ctx: Context,
  plugin: LoadedPlugin,
  command: CommandManifest,
  namespace: boolean,
): {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: CommandInvocation) => Promise<{ readonly kind: 'success' } | { readonly kind: 'error'; readonly text: string }>
} {
  const name = namespace ? namespacedName(plugin.manifest.name, command.name) : command.name
  return {
    name,
    description: command.description,
    ...command.argumentHint !== undefined ? { input: { hint: command.argumentHint } } : {},
    async handler(invocation) {
      const filter = filterForWorkspace(await readProjectFilter(), invocation.agent.session.header.cwd)
      if (!isPluginEnabled(filter, plugin.manifest.name)) {
        return { kind: 'error', text: `plugin "${plugin.manifest.name}" is disabled in this workspace's plugin filter` }
      }
      const rendered = command.body.replaceAll('$ARGUMENTS', invocation.rawInput.trim())
      const message = createUserMessage({
        content: [{
          type: 'text',
          text: [
            `<agent-plugin-command name="${command.name}" plugin="${plugin.manifest.name}">`,
            rendered,
            '</agent-plugin-command>',
          ].join('\n'),
        }],
        source: { kind: 'plugin', plugin: 'agent-plugins', form: 'instructions' },
      })
      ctx.agents.get(invocation.agent.id)?.inject(message)
      return { kind: 'success' }
    },
  }
}

/**
 * Mount one parsed MCP server as a child `dsh-mcp-client` plugin instance.
 * The child is awaited here so the loader's activation only completes once
 * the initial connection settled; teardown disconnects it through the child
 * fiber. A failed connection logs a warning and skips the server.
 * @param ctx - plugin context the child mounts under.
 * @param server - parsed server declaration with resolved config.
 * @returns readiness once the child fiber activated or failed.
 */
async function mountMcpServer(ctx: Context, server: McpServerManifest): Promise<void> {
  const child = ctx.plugin({
    name: `agent-plugins-mcp-${server.serverName}`,
    inject: ['tools'],
    apply: (childCtx: Context) => mcpClient.apply(childCtx, server.config as mcpClient.Config),
  })
  try {
    await child
  } catch (error) {
    ctx.logger.warn(`agent-plugins: MCP server "${server.serverName}" failed to connect: ${String(error)}`)
    await child.dispose()
    return
  }
  ctx.effect(() => () => child.dispose(), `agent-plugins: unmount MCP server ${server.serverName}`)
}

/** Whether the error is a missing path (ENOENT / ENOTDIR). */
function isAbsentError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
