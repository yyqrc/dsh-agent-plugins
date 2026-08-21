/**
 * Tests for the built-in installed.json refresh: bookkeeping-file parsing,
 * version comparison, re-copy with the exclusion list, staging replacement,
 * record write-back, and fail-soft behavior. The refresh must never destroy
 * the previous install. The activation-level wiring (autoUpdate flag, refresh
 * before discovery) lives in agent-plugins.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { INSTALLED_FILE, refreshInstalledPlugins } from '../src/auto-update.ts'

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-refresh-'))
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content, 'utf8')
  }
}

/**
 * One install root plus one source tree for a `demo` plugin, with the
 * installed.json record already pointing source -> install.
 */
async function fixture(options: {
  readonly recordVersion: string
  readonly sourceVersion: string
  readonly sourceFiles?: Record<string, string>
  readonly installedFiles?: Record<string, string>
  readonly entry?: Record<string, unknown>
}): Promise<{ install: string; source: string }> {
  const root = await tempRoot()
  const install = join(root, 'install')
  const source = join(root, 'source')
  await writeTree(join(install, 'demo'), {
    'plugin.json': JSON.stringify({ name: 'demo', version: options.recordVersion }),
    ...options.installedFiles,
  })
  await writeTree(source, {
    'plugin.json': JSON.stringify({ name: 'demo', version: options.sourceVersion }),
    ...options.sourceFiles,
  })
  await writeFile(join(install, INSTALLED_FILE), JSON.stringify({
    demo: { source, installedAt: '2020-01-01 00:00:00', version: options.recordVersion, ...options.entry },
  }), 'utf8')
  return { install, source }
}

/** One record entry inside the rewritten installed.json. */
interface RecordEntry {
  source?: string
  version?: string
  installedAt?: string
  note?: string
}

/** Read the rewritten record from one install root. */
async function readRecord(install: string): Promise<Record<string, RecordEntry>> {
  return JSON.parse(await readFile(join(install, INSTALLED_FILE), 'utf8')) as Record<string, RecordEntry>
}

/** Read one installed/source plugin.json manifest. */
async function readManifest(pluginDir: string): Promise<{ name?: string; version?: string }> {
  return JSON.parse(await readFile(join(pluginDir, 'plugin.json'), 'utf8')) as { name?: string; version?: string }
}

/** Entry names directly under one directory, sorted. */
async function entryNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort()
}

describe('refreshInstalledPlugins()', () => {
  it('returns no results when installed.json is absent', async () => {
    const root = await tempRoot()
    expect(await refreshInstalledPlugins(root)).toEqual([])
  })

  it('skips with one problem when installed.json is invalid JSON', async () => {
    const root = await tempRoot()
    await writeFile(join(root, INSTALLED_FILE), '{not json', 'utf8')
    const results = await refreshInstalledPlugins(root)
    expect(results).toHaveLength(1)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('invalid JSON')
  })

  it('skips with one problem when installed.json is not an object', async () => {
    const root = await tempRoot()
    await writeFile(join(root, INSTALLED_FILE), '[1, 2]', 'utf8')
    const results = await refreshInstalledPlugins(root)
    expect(results).toHaveLength(1)
    expect(results[0]?.reason).toContain('JSON object')
  })

  it('skips a record whose key is not a plain directory name', async () => {
    const root = await tempRoot()
    await writeFile(join(root, INSTALLED_FILE), JSON.stringify({ '../escape': { source: root } }), 'utf8')
    const results = await refreshInstalledPlugins(root)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('plain directory name')
  })

  it('skips a record with a relative source path and leaves the install untouched', async () => {
    const { install } = await fixture({ recordVersion: '1.0.0', sourceVersion: '2.0.0' })
    // Overwrite the record with a relative source.
    await writeFile(join(install, INSTALLED_FILE), JSON.stringify({
      demo: { source: './source', version: '1.0.0' },
    }), 'utf8')
    const results = await refreshInstalledPlugins(install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('not absolute')
    expect((await readManifest(join(install, 'demo'))).version).toBe('1.0.0')
  })

  it('skips a record whose source directory has no plugin.json', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const emptySource = join(root, 'empty-source')
    await mkdir(install, { recursive: true })
    await mkdir(emptySource, { recursive: true })
    await writeFile(join(install, INSTALLED_FILE), JSON.stringify({
      demo: { source: emptySource, version: '1.0.0' },
    }), 'utf8')
    const results = await refreshInstalledPlugins(install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('no plugin.json')
  })

  it('skips a record whose source plugin.json has no string version', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const source = join(root, 'source')
    await mkdir(install, { recursive: true })
    await writeTree(source, { 'plugin.json': JSON.stringify({ name: 'demo' }) })
    await writeFile(join(install, INSTALLED_FILE), JSON.stringify({
      demo: { source, version: '1.0.0' },
    }), 'utf8')
    const results = await refreshInstalledPlugins(install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('no string version')
  })

  it('reports up-to-date and rewrites nothing', async () => {
    const { install } = await fixture({
      recordVersion: '1.0.0',
      sourceVersion: '1.0.0',
      installedFiles: { 'sentinel.txt': 'keep' },
    })
    const before = await readFile(join(install, INSTALLED_FILE), 'utf8')
    const results = await refreshInstalledPlugins(install)
    expect(results).toEqual([{ plugin: 'demo', action: 'up-to-date', from: '1.0.0', to: '1.0.0' }])
    expect(await readFile(join(install, INSTALLED_FILE), 'utf8')).toBe(before)
    expect(await readFile(join(install, 'demo', 'sentinel.txt'), 'utf8')).toBe('keep')
  })

  it('re-copies a plugin whose source version differs and rewrites the record', async () => {
    const { install, source } = await fixture({
      recordVersion: '1.0.0',
      sourceVersion: '2.0.0',
      sourceFiles: {
        'skills/new/SKILL.md': '---\nname: new\ndescription: New\n---\n',
        'stale-gone.txt': 'stale content',
      },
      installedFiles: { 'skills/old/SKILL.md': 'old', 'stale.txt': 'stale' },
      entry: { note: 'preserve me' },
    })
    const results = await refreshInstalledPlugins(install)
    expect(results).toEqual([{ plugin: 'demo', action: 'updated', from: '1.0.0', to: '2.0.0' }])
    // The installed directory is the new source tree: new content present,
    // content removed from the source is gone.
    const installedManifest = await readManifest(join(install, 'demo'))
    expect(installedManifest.version).toBe('2.0.0')
    expect(await readFile(join(install, 'demo', 'skills', 'new', 'SKILL.md'), 'utf8')).toContain('name: new')
    expect(await entryNames(join(install, 'demo'))).toContain('stale-gone.txt')
    // The record carries the new version, a fresh installedAt, and unknown fields.
    const record = await readRecord(install)
    expect(record.demo.version).toBe('2.0.0')
    expect(record.demo.source).toBe(source)
    expect(record.demo.note).toBe('preserve me')
    expect(record.demo.installedAt).not.toBe('2020-01-01 00:00:00')
  })

  it('treats a missing record version as outdated', async () => {
    const { install, source } = await fixture({ recordVersion: '1.0.0', sourceVersion: '2.0.0' })
    await writeFile(join(install, INSTALLED_FILE), JSON.stringify({ demo: { source } }), 'utf8')
    const results = await refreshInstalledPlugins(install)
    expect(results[0]?.action).toBe('updated')
    expect(results[0]?.from).toBeUndefined()
    const record = await readRecord(install)
    expect(record.demo.version).toBe('2.0.0')
  })

  it('strips excluded names and bytecode from the copied tree', async () => {
    const { install } = await fixture({
      recordVersion: '1.0.0',
      sourceVersion: '2.0.0',
      sourceFiles: {
        '.git/HEAD': 'ref',
        '.temp/debug.log': 'log',
        '__pycache__/mod.pyc': 'bytecode',
        'node_modules/pkg/index.js': 'js',
        'compiled.pyc': 'bytecode',
        'nested/__pycache__/mod.pyc': 'bytecode',
        'skills/real/SKILL.md': '---\nname: real\ndescription: Real\n---\n',
      },
    })
    await refreshInstalledPlugins(install)
    const flattened = await readdir(join(install, 'demo'), { recursive: true })
    expect(flattened.join('\n')).not.toContain('node_modules')
    expect(flattened.join('\n')).not.toContain('.git')
    expect(flattened.join('\n')).not.toContain('__pycache__')
    expect(flattened.join('\n')).not.toContain('.pyc')
    expect(flattened.join('\n')).not.toContain('.temp')
    expect(await readFile(join(install, 'demo', 'skills', 'real', 'SKILL.md'), 'utf8')).toContain('name: real')
  })

  it('leaves the previous install intact when the copy fails', async () => {
    const { install, source } = await fixture({
      recordVersion: '1.0.0',
      sourceVersion: '2.0.0',
      installedFiles: { 'sentinel.txt': 'keep' },
    })
    // Deeply nested source directories exceed the copy depth cap and abort
    // the refresh deterministically (symlink cycles hit the same guard).
    // 70 single-character levels nest deeper than the cap of 64.
    const deep = join(source, Array.from({ length: 70 }, () => 'a').join(sep))
    await mkdir(deep, { recursive: true })
    const results = await refreshInstalledPlugins(install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('copy depth exceeded')
    expect(await readFile(join(install, 'demo', 'plugin.json'), 'utf8')).toContain('1.0.0')
    expect(await readFile(join(install, 'demo', 'sentinel.txt'), 'utf8')).toBe('keep')
    // No staging directory is left behind.
    expect((await entryNames(install)).join('\n')).not.toContain('.refresh-')
    // The record was not rewritten.
    expect((await readRecord(install)).demo.version).toBe('1.0.0')
  })

  it('skips a record whose source equals the install directory', async () => {
    const { install } = await fixture({ recordVersion: '1.0.0', sourceVersion: '2.0.0' })
    // Point the record at the install directory itself: versions differ, so
    // only the same-path guard stops a self-overwriting refresh.
    await writeFile(join(install, INSTALLED_FILE), JSON.stringify({
      demo: { source: join(install, 'demo'), version: '0.9.0' },
    }), 'utf8')
    const results = await refreshInstalledPlugins(install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('equals install directory')
    expect((await readManifest(join(install, 'demo'))).version).toBe('1.0.0')
  })
})
