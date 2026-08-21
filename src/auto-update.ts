/**
 * Built-in pre-load refresh for directory-form plugins installed with an
 * `installed.json` bookkeeping file.
 *
 * An install root (normally `<dsh home>/agent-plugins`) may carry an
 * `installed.json` written by a plugin installer. Each record maps a plugin
 * name to its install facts:
 *
 * ```json
 * {
 *   "cgame-unity": {
 *     "source": "D:/cgame-marketplace/cgame-unity",
 *     "version": "0.5.13",
 *     "installedAt": "2026-08-20 14:38:02"
 *   }
 * }
 * ```
 *
 * Refresh compares each record's `version` with the source directory's
 * `plugin.json` version by string equality (the comparison the install
 * script that writes the record uses) and, when they differ, re-copies the
 * source tree into the install root and rewrites the record. The loader runs
 * this before discovery, so this activation loads the fresh copies — content
 * that has already been loaded is never modified.
 *
 * The module depends on nothing Cordis-side: it returns per-plugin results
 * and the loader decides how to log them. Every failure inside one plugin's
 * refresh becomes a `skipped` result; a failed bookkeeping write-back is
 * reported the same way. The refresh itself never throws.
 *
 * @module @deepseek-ai/dsh-agent-plugins/auto-update
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

/** Bookkeeping file the installer writes next to the plugin directories. */
export const INSTALLED_FILE = 'installed.json'

/** Source manifest whose `version` the record's version is compared against. */
const MANIFEST_FILE = 'plugin.json'

/**
 * Names excluded from the copy so a plugin directory ships as its
 * publishable surface, not as a developer working tree (the same set the
 * install script uses). Excluded names are skipped at every level of the
 * copy, so nothing excluded ever reaches the install root.
 */
const EXCLUDED_NAMES = new Set(['.git', '.temp', '__pycache__', 'node_modules', 'installed.json'])

/** Python bytecode files are stripped everywhere, mirroring the install script. */
const BYTECODE_EXTENSION = '.pyc'

/**
 * Copy recursion depth cap: guards against junction/symlink cycles inside a
 * source tree (`stat` follows links). A publishable plugin tree is a handful
 * of levels deep; hitting the cap aborts that plugin's refresh with a
 * `skipped` result. Raise the cap only when a real plugin exceeds 64 levels.
 */
const MAX_COPY_DEPTH = 64

/** One bookkeeping outcome, returned for logging and tests. */
export interface RefreshResult {
  /** Record key in installed.json — the installed directory name. */
  readonly plugin: string
  readonly action: 'updated' | 'up-to-date' | 'skipped'
  /** Why a plugin was skipped, or why the bookkeeping write-back failed. */
  readonly reason?: string
  /** The installed version before an update, when known. */
  readonly from?: string | undefined
  /** The source version an update installed. */
  readonly to?: string | undefined
}

/**
 * Refresh every plugin recorded in one install root's `installed.json`.
 * Runs before discovery; an absent or invalid record refreshes nothing.
 * Never throws: every problem surfaces as a `skipped` result.
 *
 * Concurrency ceiling, documented instead of locked: two DSH processes
 * booting simultaneously may refresh the same root concurrently. Both copy
 * full directory snapshots, so the last writer wins and the outcome is one
 * of the two source versions — never a partial tree. Upgrade path: a
 * cross-process lock file around the per-root refresh.
 * @param root - absolute install root directory.
 * @returns one result per record entry, plus any bookkeeping problems.
 */
export async function refreshInstalledPlugins(root: string): Promise<readonly RefreshResult[]> {
  const recordFile = join(root, INSTALLED_FILE)
  const read = await readJson(recordFile)
  if (!read.ok) {
    if (read.absent) return [] // nothing recorded here — nothing to refresh
    return [{ plugin: '*', action: 'skipped', reason: read.reason }]
  }
  if (!isObject(read.value)) {
    return [{ plugin: '*', action: 'skipped', reason: `${INSTALLED_FILE} must contain a JSON object` }]
  }
  const record = read.value
  const results: RefreshResult[] = []
  let changed = false
  for (const [name, rawEntry] of Object.entries(record)) {
    const result = await refreshOne(root, name, rawEntry)
    if (result.action === 'updated') {
      changed = true
      // Rewrite the entry in place: unknown fields and key order survive.
      record[name] = {
        ...(isObject(rawEntry) ? rawEntry : {}),
        version: result.to,
        installedAt: formatTimestamp(new Date()),
      }
    }
    results.push(result)
  }
  if (changed) {
    try {
      await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } catch (error) {
      results.push({
        plugin: '*',
        action: 'skipped',
        reason: `plugins were refreshed but rewriting ${INSTALLED_FILE} failed: ${String(error)}`,
      })
    }
  }
  return results
}

/**
 * Refresh one record entry: compare versions and, when they differ, replace
 * the installed directory with the source tree through a staging directory.
 * @param root - absolute install root directory.
 * @param name - record key and installed directory name.
 * @param rawEntry - the record's entry value.
 * @returns the outcome for this entry.
 */
async function refreshOne(root: string, name: string, rawEntry: unknown): Promise<RefreshResult> {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return { plugin: name, action: 'skipped', reason: 'record key is not a plain directory name' }
  }
  const entry = isObject(rawEntry) ? rawEntry : {}
  const source = entry.source
  if (typeof source !== 'string' || source.trim() === '') {
    return { plugin: name, action: 'skipped', reason: 'record entry has no source path' }
  }
  if (!isAbsolute(source)) {
    // The installer records absolute source paths; resolving a relative one
    // against the wrong base could copy from an unintended directory.
    return { plugin: name, action: 'skipped', reason: `source path is not absolute: ${JSON.stringify(source)}` }
  }
  const manifest = await readJson(join(source, MANIFEST_FILE))
  if (!manifest.ok) {
    return {
      plugin: name,
      action: 'skipped',
      reason: manifest.absent
        ? 'source directory has no plugin.json'
        : `unreadable source plugin.json: ${manifest.reason}`,
    }
  }
  const version = isObject(manifest.value) ? manifest.value.version : undefined
  if (typeof version !== 'string' || version.trim() === '') {
    return { plugin: name, action: 'skipped', reason: 'source plugin.json declares no string version' }
  }
  const installedVersion = typeof entry.version === 'string' ? entry.version : undefined
  if (installedVersion === version) {
    return { plugin: name, action: 'up-to-date', from: installedVersion, to: version }
  }
  const destination = join(root, name)
  if (samePath(source, destination)) {
    return { plugin: name, action: 'skipped', reason: `source equals install directory ${destination}` }
  }
  // Staging keeps the previous install intact until the new tree is fully
  // copied: a failed refresh must never destroy a working plugin.
  const staging = `${destination}.refresh-${process.pid}`
  try {
    await rm(staging, { recursive: true, force: true })
    await copyDirectory(source, staging)
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    return { plugin: name, action: 'skipped', reason: `refresh copy failed: ${String(error)}` }
  }
  return { plugin: name, action: 'updated', from: installedVersion, to: version }
}

/**
 * Copy one directory tree, skipping excluded names at every level.
 * @param source - absolute source directory.
 * @param destination - absolute destination directory.
 * @param depth - current recursion depth.
 */
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
    await copyFile(source, destination)
  }
  // Other entry types (sockets, devices) do not occur in plugin trees.
}

/** Whether a directory-entry name is excluded from refresh copies. */
function shouldExclude(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || name.endsWith(BYTECODE_EXTENSION)
}

/** Read one JSON file, distinguishing absence from malformed content. */
type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; absent?: boolean }

async function readJson(path: string): Promise<JsonReadResult> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsentError(error)) return { ok: false, reason: `missing ${basename(path)}`, absent: true }
    return { ok: false, reason: String(error) }
  }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${String(error)}` }
  }
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

/** Whether two resolved paths name the same location on this platform. */
function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Timestamp in the installer's local `yyyy-MM-dd HH:mm:ss` format. */
function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(pad).join('-'),
    [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':'),
  ].join(' ')
}
