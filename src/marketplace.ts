/**
 * Declaration-driven plugin sync: reads a DSH-side `sources.yml` file that
 * maps plugin names to their sources and installs or updates the listed
 * plugins into an install root, mirroring the `installed.json` bookkeeping
 * and fail-soft semantics of the built-in auto-update refresh.
 *
 * The declaration file is the DSH-side installation decision; it does not
 * depend on any marketplace manifest. Each declared `source` may be:
 *
 * - a relative path (resolved against the declaration file's directory) —
 *   the plugin is copied from that directory;
 * - an absolute path — the plugin is copied from that directory;
 * - a git URL (`https://...` or `git@...`) — the plugin is fetched from that
 *   remote into a cache directory under the install root and copied from
 *   there. A `git+` prefix is accepted, and a `#subpath` suffix selects a
 *   subdirectory inside the repository as the plugin root (so several
 *   plugins can share one marketplace repository);
 * - omitted — the installed record's `source` is kept.
 *
 * Sync semantics (decision A, no version pinning): a git source is fetched
 * to the remote's default branch tip, then the plugin's `plugin.json`
 * `version` is compared with the `installed.json` record by string equality;
 * only a difference re-copies the tree and rewrites the record. Local sources
 * are compared the same way (identical to the auto-update refresh).
 *
 * The module depends on nothing Cordis-side: it returns per-plugin results
 * and the loader decides how to log them. Git runs through the system `git`
 * CLI; every failure inside one plugin's sync becomes a `skipped` result and
 * never throws out of the module.
 *
 * @module @deepseek-ai/dsh-agent-plugins/marketplace
 */

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  formatTimestamp,
  INSTALLED_FILE,
  isPlainName,
  stageReplace,
} from './auto-update.ts'

/** Manifest whose `version` the record's version is compared against. */
const MANIFEST_FILE = 'plugin.json'

/** Git cache directory name under the install root. */
export const GIT_CACHE_DIR = '.marketplace-git'

/** Copy recursion depth cap shared with the auto-update refresh. */
const MAX_COPY_DEPTH = 64

/** Names excluded from the copy, identical to the auto-update refresh. */
const EXCLUDED_NAMES = new Set(['.git', '.temp', '__pycache__', 'node_modules', 'installed.json'])

/** Python bytecode files are stripped everywhere, mirroring the install script. */
const BYTECODE_EXTENSION = '.pyc'

/** Whether a source string looks like a git remote URL (optionally with a
 *  `#subpath` suffix selecting a subdirectory inside the repository). The
 *  optional `git+` prefix is stripped before matching. */
function isGitUrl(source: string): boolean {
  const withoutPrefix = source.startsWith('git+') ? source.slice(4) : source
  const base = withoutPrefix.split('#', 1)[0] ?? ''
  return /^(https?|git|ssh|file):\/\//i.test(base) || /^git@[^:]+:/.test(base)
}

/** A parsed git source: the repository URL plus an optional subdirectory. */
interface ParsedGitSource {
  readonly url: string
  /** Subdirectory inside the repository treated as the plugin root. */
  readonly subpath?: string
}

/**
 * Parse a git source string. The `git+` prefix (if present) is stripped;
 * a trailing `#subpath` selects a subdirectory inside the repository that
 * is treated as the plugin root (its `plugin.json` must live there).
 */
function parseGitSource(source: string): ParsedGitSource {
  const withoutPrefix = source.startsWith('git+') ? source.slice(4) : source
  const hashIndex = withoutPrefix.indexOf('#')
  if (hashIndex === -1) return { url: withoutPrefix }
  const subpath = withoutPrefix.slice(hashIndex + 1).replace(/^\/+|\/+$/g, '')
  return {
    url: withoutPrefix.slice(0, hashIndex),
    ...subpath !== '' ? { subpath } : {},
  }
}

/**
 * Stable cache directory name for one repository URL: the plugin name is
 * unsuitable because several plugins may share one marketplace repository.
 * A short hash of the URL keeps the cache key stable across runs without
 * exposing the full URL in the directory name. Exported for tests.
 */
export function gitCacheName(url: string): string {
  let hash = 0
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0
  }
  return `repo-${(hash >>> 0).toString(36)}`
}

/** One entry of the marketplace `plugins` array. */
export interface MarketplaceEntry {
  /** Plugin name; also the install directory name under the install root. */
  readonly name: string
  /** Relative path, absolute path, or git URL of the plugin. */
  readonly source: string
  /** Optional human-readable description from the manifest. */
  readonly description?: string
}

/** One sync outcome, returned for logging and tests. */
export interface MarketplaceResult {
  /** Record key in installed.json — the installed directory name. */
  readonly plugin: string
  readonly action: 'installed' | 'updated' | 'up-to-date' | 'skipped'
  /** Why a plugin was skipped. */
  readonly reason?: string
  /** The installed version before an update, when known. */
  readonly from?: string | undefined
  /** The version the sync installed. */
  readonly to?: string | undefined
}

/** One entry of a DSH-side source declaration file (`sources.yml`). */
export interface DeclaredSource {
  /** Where the plugin comes from: absolute path, path relative to the
   *  declaration file, or a git URL. Omit to keep the installed record's
   *  source (declaration-only, no re-sync source change). */
  readonly source?: string
}

/**
 * Sync every plugin declared in a DSH-side `sources.yml` file into the
 * install root. The declaration maps plugin names to their sources and is
 * the DSH-side installation decision — it does not depend on any marketplace
 * manifest. Each declared entry runs through the same version-compare,
 * staging-replace and bookkeeping path as the built-in refresh. An absent
 * or invalid declaration file syncs nothing; never throws.
 *
 * A declared source may be:
 * - a git URL (`https://...` / `git@...`) — fetched to the default branch
 *   tip into the git cache, then compared and installed;
 * - an absolute path — copied from that directory;
 * - a path relative to the declaration file — resolved against the
 *   declaration file's directory;
 * - omitted — the installed record's `source` is kept (the entry only
 *   declares that the plugin stays managed).
 *
 * Concurrency ceiling, documented instead of locked: two DSH processes
 * booting simultaneously may sync the same root concurrently. Git fetch and
 * full directory snapshots are idempotent enough that the last writer wins
 * with a complete tree — never a partial one. Upgrade path: a cross-process
 * lock file around the per-root sync, as with the auto-update refresh.
 * @param sourcesFile - absolute path of the `sources.yml` declaration file.
 * @param installRoot - absolute install root (`Config.pluginDirs[0]`).
 * @returns one result per declared plugin.
 */
export async function syncDeclaredSources(
  sourcesFile: string,
  installRoot: string,
): Promise<readonly MarketplaceResult[]> {
  const declarations = await readDeclaredSources(sourcesFile)
  if (!declarations.ok) {
    return declarations.absent
      ? [] // no declaration file — nothing to sync
      : [{ plugin: '*', action: 'skipped', reason: declarations.reason }]
  }
  const results: MarketplaceResult[] = []
  const recordFile = join(installRoot, INSTALLED_FILE)
  const record = await readRecord(recordFile)
  for (const [name, declaration] of Object.entries(declarations.value.plugins)) {
    if (!isPlainName(name)) {
      results.push({ plugin: name, action: 'skipped', reason: 'declared name is not a plain directory name' })
      continue
    }
    const installedEntry = record[name]
    const recordSource = typeof installedEntry?.source === 'string' ? installedEntry.source : undefined
    const source = declaration.source ?? recordSource
    if (source === undefined || source.trim() === '') {
      results.push({ plugin: name, action: 'skipped', reason: 'no source declared and no installed record source' })
      continue
    }
    // Relative declared paths resolve against the declaration file's dir.
    const baseDir = dirname(sourcesFile)
    const resolved: MarketplaceEntry = {
      name,
      source: isGitUrl(source) || isAbsolute(source) ? source : resolve(baseDir, source),
    }
    results.push(await syncOne(baseDir, installRoot, resolved))
  }
  return results
}

/** Parse a `sources.yml` declaration file. */
async function readDeclaredSources(sourcesFile: string): Promise<
  | { ok: true; value: { plugins: Record<string, DeclaredSource> } }
  | { ok: false; reason: string; absent?: boolean }
> {
  let raw: string
  try {
    raw = await readFile(sourcesFile, 'utf8')
  } catch (error) {
    if (isAbsentError(error)) return { ok: false, reason: `missing ${sourcesFile}`, absent: true }
    return { ok: false, reason: `unreadable sources file ${sourcesFile}: ${String(error)}` }
  }
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (error) {
    return { ok: false, reason: `invalid sources file ${sourcesFile}: ${String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `sources file ${sourcesFile} must contain a YAML object` }
  }
  const root = parsed as Record<string, unknown>
  const rawPlugins = root.plugins
  if (typeof rawPlugins !== 'object' || rawPlugins === null || Array.isArray(rawPlugins)) {
    return { ok: false, reason: `sources file ${sourcesFile} has no "plugins" map` }
  }
  const plugins: Record<string, DeclaredSource> = {}
  for (const [name, rawEntry] of Object.entries(rawPlugins as Record<string, unknown>)) {
    if (typeof rawEntry === 'string') {
      plugins[name] = { source: rawEntry }
    } else if (typeof rawEntry === 'object' && rawEntry !== null && !Array.isArray(rawEntry)) {
      const source = (rawEntry as Record<string, unknown>).source
      plugins[name] = {
        ...typeof source === 'string' && source.trim() !== '' ? { source } : {},
      }
    } else {
      plugins[name] = {}
    }
  }
  return { ok: true, value: { plugins } }
}

/**
 * Sync one manifest entry. Git sources are fetched to the cache directory,
 * then the plugin tree is staged and swapped when its version differs from
 * the record. The record is rewritten in place (unknown fields survive).
 */
async function syncOne(
  marketplaceRoot: string,
  installRoot: string,
  entry: MarketplaceEntry,
): Promise<MarketplaceResult> {
  if (!isPlainName(entry.name)) {
    return { plugin: entry.name, action: 'skipped', reason: 'entry name is not a plain directory name' }
  }
  const recordFile = join(installRoot, INSTALLED_FILE)
  const record = await readRecord(recordFile)
  const installedVersion = record[entry.name]?.version
  let sourceDir: string
  let recordSource: string
  if (isGitUrl(entry.source)) {
    const fetched = await fetchGitSource(installRoot, entry)
    if (!fetched.ok) return { plugin: entry.name, action: 'skipped', reason: fetched.reason }
    sourceDir = fetched.path
    recordSource = entry.source
  } else {
    sourceDir = resolveSourceDir(marketplaceRoot, entry.source)
    recordSource = sourceDir
    const stats = await statSafe(sourceDir)
    if (!stats.ok) {
      return { plugin: entry.name, action: 'skipped', reason: `source directory is not readable: ${stats.reason}` }
    }
  }
  const version = await readPluginVersion(sourceDir)
  if (version === undefined) {
    return { plugin: entry.name, action: 'skipped', reason: 'source has no string version in plugin.json' }
  }
  if (installedVersion === version) {
    return { plugin: entry.name, action: 'up-to-date', from: installedVersion, to: version }
  }
  const destination = join(installRoot, entry.name)
  if (resolve(sourceDir) === resolve(destination)) {
    return { plugin: entry.name, action: 'skipped', reason: `source equals install directory ${destination}` }
  }
  try {
    await stageReplace(sourceDir, destination)
  } catch (error) {
    return { plugin: entry.name, action: 'skipped', reason: `sync copy failed: ${String(error)}` }
  }
  const next = {
    ...record[entry.name] ?? {},
    source: recordSource,
    version,
    installedAt: formatTimestamp(new Date()),
  }
  record[entry.name] = next
  await writeRecord(recordFile, record)
  return {
    plugin: entry.name,
    action: installedVersion === undefined ? 'installed' : 'updated',
    from: typeof installedVersion === 'string' ? installedVersion : undefined,
    to: version,
  }
}

/**
 * Ensure a git source is present and fetched to the remote's default branch
 * tip in the cache directory, then return the plugin's source directory
 * inside the checkout (the `#subpath` subdirectory when declared).
 */
async function fetchGitSource(
  installRoot: string,
  entry: MarketplaceEntry,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const parsed = parseGitSource(entry.source)
  const cacheRoot = join(installRoot, GIT_CACHE_DIR)
  const checkout = join(cacheRoot, gitCacheName(parsed.url))
  try {
    await mkdir(cacheRoot, { recursive: true })
    const existing = await statSafe(checkout)
    if (existing.ok) {
      const fetched = await runGit(['fetch', '--all', '--tags', '--prune'], checkout)
      if (!fetched.ok) return { ok: false, reason: fetched.reason }
    } else {
      const cloned = await runGit(['clone', '--quiet', parsed.url, checkout], installRoot)
      if (!cloned.ok) return { ok: false, reason: cloned.reason }
    }
    const reset = await runGit(['reset', '--hard', '@{upstream}'], checkout)
    if (!reset.ok) {
      // A fresh clone may have no upstream; a detached HEAD is fine — the
      // default branch tip is what we fetched. A checkout with a local
      // branch tracks its origin, so `@{upstream}` resolves.
      const branches = await runGit(['branch', '--show-current'], checkout)
      if (!branches.ok) return { ok: false, reason: branches.reason }
      const current = branches.stdout.trim()
      if (current === '') {
        const head = await runGit(['rev-parse', '--short', 'HEAD'], checkout)
        if (!head.ok) return { ok: false, reason: head.reason }
      }
    }
    const path = parsed.subpath !== undefined ? join(checkout, parsed.subpath) : checkout
    const stats = await statSafe(path)
    if (!stats.ok) {
      return { ok: false, reason: `git source subpath is not readable: ${stats.reason}` }
    }
    return { ok: true, path }
  } catch (error) {
    return { ok: false, reason: `git sync failed: ${String(error)}` }
  }
}

/**
 * Resolve a local plugin source. A relative source resolves against the
 * marketplace root; an absolute source is used as-is (matching the
 * auto-update record semantics).
 */
function resolveSourceDir(marketplaceRoot: string, source: string): string {
  return isAbsolute(source) ? resolve(source) : resolve(marketplaceRoot, source)
}

/** Read one plugin directory's `plugin.json` version, or undefined. */
async function readPluginVersion(pluginDir: string): Promise<string | undefined> {
  const manifest = await readJsonSafe(join(pluginDir, MANIFEST_FILE))
  if (!manifest.ok) return undefined
  const version = (manifest.value as Record<string, unknown> | undefined)?.version
  return typeof version === 'string' && version.trim() !== '' ? version : undefined
}

/** Read and parse the `installed.json` record, tolerating absence and malformed JSON. */
async function readRecord(recordFile: string): Promise<Record<string, Record<string, unknown>>> {
  const parsed = await readJsonSafe(recordFile)
  if (!parsed.ok) return {}
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) return {}
  return parsed.value as Record<string, Record<string, unknown>>
}

/** Write the record with a trailing newline, matching the auto-update format. */
async function writeRecord(recordFile: string, record: Record<string, Record<string, unknown>>): Promise<void> {
  await mkdir(join(recordFile, '..'), { recursive: true })
  await writeFileSafe(recordFile, `${JSON.stringify(record, null, 2)}\n`)
}

/** Run the system `git` CLI with captured output; never throws. */
async function runGit(
  args: readonly string[],
  cwd: string,
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return await new Promise((resolveResult) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill()
    }, 60_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveResult({ ok: false, reason: `git spawn failed: ${String(error)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolveResult({ ok: true, stdout })
      } else {
        resolveResult({ ok: false, reason: `git ${args[0] ?? ''} failed (exit ${String(code)}): ${stderr.trim() || stdout.trim()}` })
      }
    })
  })
}

/** Read one JSON file, distinguishing absence from malformed content. */
type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; absent?: boolean }

async function readJsonSafe(path: string): Promise<JsonReadResult> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsentError(error)) return { ok: false, reason: `missing ${path}`, absent: true }
    return { ok: false, reason: String(error) }
  }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${String(error)}` }
  }
}

/** stat one path; not found or unreadable → not ok. */
async function statSafe(path: string): Promise<{ ok: true; value: import('node:fs').Stats } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: await stat(path) }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
}

/** Write one file; never throws (fail-soft). */
async function writeFileSafe(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, 'utf8')
  } catch {
    // fail-soft: the loader logs the sync result; a failed bookkeeping
    // write-back must not throw out of the module.
  }
}

/** Whether the error is a missing path (ENOENT / ENOTDIR). */
function isAbsentError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** Copy one directory tree, skipping excluded names at every level. */
async function copyDirectory(source: string, destination: string, depth = 0): Promise<void> {
  if (depth > MAX_COPY_DEPTH) {
    throw new Error(`copy depth exceeded ${MAX_COPY_DEPTH} under ${source} (symlink cycle?)`)
  }
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (shouldExclude(entry.name)) continue
    await copyPath(join(source, entry.name), join(destination, entry.name), depth + 1)
  }
}

/** Copy one path, following symlinks and junctions like the loader's scan does. */
async function copyPath(source: string, destination: string, depth: number): Promise<void> {
  let stats
  try {
    stats = await stat(source)
  } catch (error) {
    throw new Error(`unreadable entry ${source}: ${String(error)}`)
  }
  if (stats.isDirectory()) {
    await copyDirectory(source, destination, depth)
  } else if (stats.isFile()) {
    await copyPathFile(source, destination)
  }
  // Other entry types (sockets, devices) do not occur in plugin trees.
}

/** Copy one file, propagating errors to the caller (fail-soft at plugin level). */
async function copyPathFile(source: string, destination: string): Promise<void> {
  await copyFile(source, destination)
}

/** Whether a directory-entry name is excluded from sync copies. */
function shouldExclude(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || name.endsWith(BYTECODE_EXTENSION)
}
