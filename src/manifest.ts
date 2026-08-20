/**
 * Agent Plugins 1.0 directory manifest parsing and validation.
 *
 * This package reads the file surface an agent-plugins.org plugin directory
 * exposes: plugin.json, mcp.json, one SKILL.md per skills subdirectory, and
 * one markdown file per command. Every value here crosses a durable-file
 * boundary, so each parser validates its input and returns a typed record or
 * a rejection reason; the loader decides whether a rejection skips one file
 * or one plugin.
 *
 * @module @deepseek-ai/dsh-agent-plugins/manifest
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** Root-relative subdirectories of one agent plugin. */
export const SKILLS_DIR = 'skills'
export const COMMANDS_DIR = 'commands'
export const MANIFEST_FILE = 'plugin.json'
export const MCP_FILE = 'mcp.json'

/** The one manifest field the loader must keep to identify a plugin. */
export interface PluginManifest {
  /** Canonical plugin name; drives duplicate detection across roots. */
  readonly name: string
  /** Human-readable summary, carried for diagnostics and future surfaces. */
  readonly description?: string
}

/** Parsed and validated command template from `commands/<name>.md`. */
export interface CommandManifest {
  /** Command name without the leading slash (the file stem). */
  readonly name: string
  /** Frontmatter description shown by command discovery surfaces. */
  readonly description: string
  /** Optional frontmatter input hint shown by capable clients. */
  readonly argumentHint?: string
  /** Template body; `$ARGUMENTS` is replaced with the invocation input. */
  readonly body: string
}

/** One MCP server declaration translated into the harness bridge config. */
export interface McpServerManifest {
  /** Harness-side namespace: `ap_<plugin>_<key>`, normalized to the bridge grammar. */
  readonly serverName: string
  /** Bridge config with `${PLUGIN_ROOT}` expanded; mcp-client defaults are added at mount. */
  readonly config:
    | {
      readonly transport: 'stdio'
      readonly serverName: string
      readonly command: string
      readonly args: readonly string[]
      readonly env: Readonly<Record<string, string>>
      readonly cwd: string
    }
    | {
      readonly transport: 'streamable-http'
      readonly serverName: string
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
    }
}

/** Everything one discovered plugin directory contributes. */
export interface LoadedPlugin {
  /** Absolute plugin root directory. */
  readonly root: string
  /** Validated `plugin.json` manifest. */
  readonly manifest: PluginManifest
  /** Skills parsed from `skills/`, ready for `ctx.skills.register()`. */
  readonly skills: readonly SkillRegistration[]
  /** Commands parsed from `commands/`, ready for `ctx.commands.register()`. */
  readonly commands: readonly CommandManifest[]
  /** MCP servers parsed from `mcp.json`, ready for `dsh-mcp-client` mounting. */
  readonly mcpServers: readonly McpServerManifest[]
}

/** A rejected file or plugin: the loader logs it and skips that unit. */
export interface ManifestProblem {
  /** Absolute path the rejection names. */
  readonly path: string
  /** Stable one-line reason for the log. */
  readonly reason: string
}

/** Result of loading one candidate plugin directory. */
export type LoadPluginResult =
  | { readonly ok: true; readonly plugin: LoadedPlugin; readonly problems: readonly ManifestProblem[] }
  | { readonly ok: false; readonly problems: readonly ManifestProblem[] }

/** Frontmatter required by every Agent Plugins skill file. */
interface SkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Frontmatter expected from a command markdown file. */
interface CommandFrontmatter {
  readonly description: string
  /** The Agent Plugins spelling; normalized to the harness `input.hint`. */
  readonly 'argument-hint'?: string
}

/** Entry points a mcp.json server may declare under this adapter's scope. */
type McpServerEntry =
  | { readonly type: 'stdio'; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
  | { readonly type: 'http'; readonly url: string; readonly headers?: Readonly<Record<string, string>> }

interface McpManifestFile {
  readonly mcpServers?: Readonly<Record<string, unknown>>
}

/**
 * Load one plugin directory: manifest first, then skills, commands, and MCP
 * servers. A missing or invalid `plugin.json` rejects the whole directory;
 * problems inside the other files degrade to per-file problems so one broken
 * skill does not hide the rest of the plugin.
 * @param root - absolute plugin directory.
 * @returns the loaded plugin or the rejection with its accumulated problems.
 */
export async function loadPlugin(root: string): Promise<LoadPluginResult> {
  const problems: ManifestProblem[] = []
  const manifestFile = join(root, MANIFEST_FILE)
  const manifest = await readJson(manifestFile)
  if (!manifest.ok) {
    return { ok: false, problems: [{ path: manifest.path, reason: manifest.reason }] }
  }
  const parsed = parsePluginManifest(manifest.value)
  if (!parsed.ok) {
    return { ok: false, problems: [{ path: manifestFile, reason: parsed.reason }] }
  }
  const skills = await loadSkills(join(root, SKILLS_DIR), problems)
  const commands = await loadCommands(join(root, COMMANDS_DIR), problems)
  const mcpServers = await loadMcpServers(join(root, MCP_FILE), root, parsed.value.name, problems)
  return { ok: true, plugin: { root, manifest: parsed.value, skills, commands, mcpServers }, problems }
}

/**
 * Discover plugin directories one level under each configured root, in root
 * order. A directory without a `plugin.json` is skipped with a problem; a
 * plugin name already seen from an earlier root is skipped with a problem so
 * earlier roots win deterministically.
 * @param roots - absolute scan roots.
 * @returns loaded plugins plus every problem, both orders preserved.
 */
export async function discoverPlugins(roots: readonly string[]): Promise<{
  readonly plugins: readonly LoadedPlugin[]
  readonly problems: readonly ManifestProblem[]
}> {
  const plugins: LoadedPlugin[] = []
  const problems: ManifestProblem[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    for (const entry of await listDirectories(root, problems)) {
      const loaded = await loadPlugin(entry)
      problems.push(...loaded.problems)
      if (!loaded.ok) continue
      if (seen.has(loaded.plugin.manifest.name)) {
        problems.push({
          path: loaded.plugin.root,
          reason: `plugin "${loaded.plugin.manifest.name}" is already loaded from an earlier root`,
        })
        continue
      }
      seen.add(loaded.plugin.manifest.name)
      plugins.push(loaded.plugin)
    }
  }
  return { plugins, problems }
}

/**
 * Expand the Agent Plugins `${PLUGIN_ROOT}` variable in one manifest string.
 * @param value - raw manifest string.
 * @param root - absolute plugin root directory.
 * @returns the expanded string.
 */
export function expandPluginRoot(value: string, root: string): string {
  return value.replaceAll('${PLUGIN_ROOT}', root)
}

/** Read one plugin's skills directory into validated skill registrations. */
async function loadSkills(dir: string, problems: ManifestProblem[]): Promise<readonly SkillRegistration[]> {
  const skills: SkillRegistration[] = []
  for (const entry of await listDirectories(dir, problems)) {
    const file = join(entry, 'SKILL.md')
    const raw = await readText(file)
    if (!raw.ok) {
      problems.push({ path: file, reason: raw.reason })
      continue
    }
    const parsed = parseFrontmatter(raw.value)
    if (!parsed.ok) {
      problems.push({ path: file, reason: parsed.reason })
      continue
    }
    const front = parsed.value as Partial<SkillFrontmatter>
    const name = front.name
    const description = front.description
    if (typeof name !== 'string' || !isSkillName(name)) {
      problems.push({ path: file, reason: `invalid skill name "${String(name)}" (kebab-case required)` })
      continue
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      problems.push({ path: file, reason: 'skill description must not be empty' })
      continue
    }
    skills.push({
      name,
      description,
      ...typeof front.whenToUse === 'string' ? { whenToUse: front.whenToUse } : {},
      ...isObject(front.metadata) ? { metadata: front.metadata } : {},
      content: parsed.body,
      source: 'agent-plugin',
      resourceBase: { kind: 'directory', path: entry },
      path: file,
    })
  }
  return skills
}

/** Read one plugin's commands directory into validated command templates. */
async function loadCommands(dir: string, problems: ManifestProblem[]): Promise<readonly CommandManifest[]> {
  const commands: CommandManifest[] = []
  for (const file of await listFiles(dir, '.md', problems)) {
    const raw = await readText(file)
    if (!raw.ok) {
      problems.push({ path: file, reason: raw.reason })
      continue
    }
    const parsed = parseFrontmatter(raw.value)
    if (!parsed.ok) {
      problems.push({ path: file, reason: parsed.reason })
      continue
    }
    const front = parsed.value as Partial<CommandFrontmatter>
    const description = front.description
    if (typeof description !== 'string' || description.trim().length === 0) {
      problems.push({ path: file, reason: 'command description must not be empty' })
      continue
    }
    const name = basename(file, '.md')
    if (!/^[a-z][a-z0-9_-]*$/u.test(name)) {
      problems.push({ path: file, reason: `invalid command name "${name}"` })
      continue
    }
    const argumentHint = front['argument-hint']
    commands.push({
      name,
      description,
      ...typeof argumentHint === 'string' && argumentHint.trim().length > 0
        ? { argumentHint }
        : {},
      body: parsed.body,
    })
  }
  return commands
}

/** Read one plugin's mcp.json into bridge-ready server declarations. */
async function loadMcpServers(
  file: string,
  root: string,
  pluginName: string,
  problems: ManifestProblem[],
): Promise<readonly McpServerManifest[]> {
  const raw = await readJson(file)
  if (!raw.ok) {
    if (raw.absent) return []
    problems.push({ path: file, reason: raw.reason })
    return []
  }
  const parsed = parseMcpManifest(raw.value)
  if (!parsed.ok) {
    problems.push({ path: file, reason: parsed.reason })
    return []
  }
  const servers: McpServerManifest[] = []
  for (const [key, entry] of Object.entries(parsed.value)) {
    const value = entry
    const serverName = mcpServerName(pluginName, key)
    if (value.type === 'stdio') {
      servers.push({
        serverName,
        config: {
          transport: 'stdio',
          serverName,
          command: expandPluginRoot(value.command, root),
          args: (value.args ?? []).map(argument => expandPluginRoot(argument, root)),
          env: value.env === undefined
            ? {}
            : Object.fromEntries(Object.entries(value.env).map(([name, envValue]) => [name, expandPluginRoot(envValue, root)])),
          cwd: root,
        },
      })
    } else {
      servers.push({
        serverName,
        config: {
          transport: 'streamable-http',
          serverName,
          url: expandPluginRoot(value.url, root),
          headers: value.headers === undefined ? {} : { ...value.headers },
        },
      })
    }
  }
  return servers
}

/** Validate the plugin.json envelope; only the name is load-bearing. */
function parsePluginManifest(value: unknown): { ok: true; value: PluginManifest } | { ok: false; reason: string } {
  if (!isObject(value)) return { ok: false, reason: 'plugin.json must be a JSON object' }
  const name = value.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, reason: 'plugin.json requires a non-empty string name' }
  }
  const description = value.description
  return {
    ok: true,
    value: {
      name: name.trim(),
      ...typeof description === 'string' && description.trim().length > 0 ? { description: description.trim() } : {},
    },
  }
}

/** Validate the mcp.json envelope into one entry per server key. */
function parseMcpManifest(value: unknown): { ok: true; value: Readonly<Record<string, McpServerEntry>> } | { ok: false; reason: string } {
  if (!isObject(value)) return { ok: false, reason: 'mcp.json must be a JSON object' }
  const mcpServers = (value as McpManifestFile).mcpServers
  if (mcpServers === undefined) return { ok: true, value: {} }
  if (!isObject(mcpServers)) return { ok: false, reason: 'mcp.json mcpServers must be a JSON object' }
  const entries: Record<string, McpServerEntry> = {}
  for (const [key, entry] of Object.entries(mcpServers)) {
    const parsed = parseMcpServerEntry(key, entry)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    entries[key] = parsed.value
  }
  return { ok: true, value: entries }
}

/** Validate one mcp.json server entry. */
function parseMcpServerEntry(key: string, value: unknown): { ok: true; value: McpServerEntry } | { ok: false; reason: string } {
  if (!isObject(value)) return { ok: false, reason: `mcp server "${key}" must be an object` }
  const type = value.type
  if (type === 'stdio') {
    const command = value.command
    if (typeof command !== 'string' || command.trim().length === 0) {
      return { ok: false, reason: `stdio server "${key}" requires a non-empty command` }
    }
    const args = value.args
    if (args !== undefined && (!Array.isArray(args) || !args.every(argument => typeof argument === 'string'))) {
      return { ok: false, reason: `stdio server "${key}" args must be an array of strings` }
    }
    const env = value.env
    if (env !== undefined && !isStringMap(env)) {
      return { ok: false, reason: `stdio server "${key}" env must map strings to strings` }
    }
    return {
      ok: true,
      value: {
        type: 'stdio',
        command,
        ...args !== undefined ? { args } : {},
        ...env !== undefined ? { env } : {},
      },
    }
  }
  if (type === 'http') {
    const url = value.url
    if (typeof url !== 'string' || url.trim().length === 0) {
      return { ok: false, reason: `http server "${key}" requires a non-empty url` }
    }
    const headers = value.headers
    if (headers !== undefined && !isStringMap(headers)) {
      return { ok: false, reason: `http server "${key}" headers must map strings to strings` }
    }
    return {
      ok: true,
      value: {
        type: 'http',
        url,
        ...headers !== undefined ? { headers } : {},
      },
    }
  }
  return { ok: false, reason: `mcp server "${key}" has unsupported type "${String(type)}" (expected stdio or http)` }
}

/**
 * Normalize a plugin name and server key into the harness bridge namespace
 * grammar (`[A-Za-z0-9_-]{1,32}`). Collisions stay detectable and loud: the
 * loader warns on duplicates before mounting.
 * @param pluginName - canonical plugin name.
 * @param serverKey - mcp.json server key.
 * @returns the normalized serverName.
 */
export function mcpServerName(pluginName: string, serverKey: string): string {
  const normalized = `ap_${pluginName}_${serverKey}`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 32)
  return normalized.length > 0 ? normalized : 'ap_server'
}

/** Parse YAML frontmatter plus the trimmed body that follows it. */
function parseFrontmatter(
  raw: string,
): { ok: true; value: Readonly<Record<string, unknown>>; body: string } | { ok: false; reason: string } {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    return { ok: false, reason: 'missing YAML frontmatter (--- ... ---)' }
  }
  const closing = findClosingFrontmatter(raw, firstLineEnd + 1)
  if (closing === undefined) return { ok: false, reason: 'unterminated YAML frontmatter' }
  let data: unknown
  try {
    data = parseYaml(raw.slice(firstLineEnd + 1, closing.start))
  } catch (error) {
    return { ok: false, reason: `invalid YAML frontmatter: ${String(error)}` }
  }
  if (!isObject(data)) return { ok: false, reason: 'frontmatter must be a YAML object' }
  return { ok: true, value: data, body: raw.slice(closing.bodyStart).trim() }
}

/** Locate the frontmatter closing `---` line. */
function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/** Read one JSON file, distinguishing absence from malformed content. */
type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; path: string; reason: string; absent?: boolean }

async function readJson(path: string): Promise<JsonReadResult> {
  const raw = await readText(path)
  if (!raw.ok) {
    if (isAbsentError(raw.error)) return { ok: false, path, reason: raw.reason, absent: true }
    return { ok: false, path, reason: raw.reason }
  }
  try {
    return { ok: true, value: JSON.parse(raw.value) }
  } catch (error) {
    return { ok: false, path, reason: `invalid JSON: ${String(error)}` }
  }
}

/** Read one UTF-8 text file with absence detection. */
async function readText(path: string): Promise<{ ok: true; value: string } | { ok: false; reason: string; error: unknown }> {
  try {
    return { ok: true, value: await readFile(path, 'utf8') }
  } catch (error) {
    if (isAbsentError(error)) return { ok: false, reason: 'missing file', error }
    return { ok: false, reason: `unreadable file: ${String(error)}`, error }
  }
}

/**
 * List directory entries, following symlinks and junctions (Windows plugin
 * links); a missing or unreadable directory is an empty scan with one problem.
 */
async function listDirectories(path: string, problems: ManifestProblem[]): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isAbsentError(error)) return []
    problems.push({ path, reason: `unreadable directory: ${String(error)}` })
    return []
  }
  const directories: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const candidate = resolve(path, entry.name)
    try {
      const target = await stat(candidate)
      if (!target.isDirectory()) continue
    } catch (error) {
      if (isAbsentError(error)) continue
      problems.push({ path: candidate, reason: `unreadable entry: ${String(error)}` })
      continue
    }
    directories.push(candidate)
  }
  return directories.sort()
}

/** List plain files with one extension; a missing directory scans empty. */
async function listFiles(path: string, extension: string, problems: ManifestProblem[]): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isAbsentError(error)) return []
    problems.push({ path, reason: `unreadable directory: ${String(error)}` })
    return []
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(extension))
    .map(entry => resolve(path, entry.name))
    .sort()
}

/** Whether the error is a missing path (ENOENT / ENOTDIR). */
function isAbsentError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** Whether the value is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether the value maps strings to strings. */
function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every(entry => typeof entry === 'string')
}
