/**
 * Tests for the declaration-driven plugin sync (`sources.yml`): declaration
 * parsing (string/object entries, relative/absolute/git sources), version
 * compare re-copy with staging replacement, record write-back, fail-soft
 * behavior, and the DSH-side installation decision. Git paths run against
 * real repositories (file:// URLs) so clone/fetch/reset semantics are
 * exercised, not mocked.
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { GIT_CACHE_DIR, gitCacheName, syncDeclaredSources } from '../src/marketplace.ts'
import { INSTALLED_FILE } from '../src/auto-update.ts'

const run = promisify(execFile)

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-marketplace-'))
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content, 'utf8')
  }
}

/** Create a local git repository at `path` whose root is the plugin directory. */
async function gitRepo(path: string, files: Record<string, string>): Promise<void> {
  await writeTree(path, files)
  await run('git', ['init', '-q', path])
  await run('git', ['-C', path, 'config', 'user.email', 'test@example.com'])
  await run('git', ['-C', path, 'config', 'user.name', 'Test'])
  await run('git', ['-C', path, 'add', '.'])
  await run('git', ['-C', path, 'commit', '-q', '-m', 'initial'])
}

/** Read one installed plugin.json manifest. */
async function readManifest(pluginDir: string): Promise<{ name?: string; version?: string }> {
  return JSON.parse(await readFile(join(pluginDir, 'plugin.json'), 'utf8')) as { name?: string; version?: string }
}

/** Read the installed.json record from one install root. */
async function readRecord(install: string): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(join(install, INSTALLED_FILE), 'utf8')) as Record<string, Record<string, unknown>>
}

/** Entry names directly under one directory, sorted. */
async function entryNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort()
}

describe('syncDeclaredSources() declaration handling', () => {
  it('returns no results when the declaration file is absent', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    await mkdir(install, { recursive: true })
    expect(await syncDeclaredSources(join(root, 'no-such', 'sources.yml'), install)).toEqual([])
  })

  it('skips with one problem when the declaration file is invalid YAML', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    await mkdir(install, { recursive: true })
    const sourcesFile = join(root, 'sources.yml')
    await writeFile(sourcesFile, 'plugins:\n  demo: [unclosed', 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results).toHaveLength(1)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('invalid sources file')
  })

  it('skips a bad declaration and keeps other entries working', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourcesFile = join(root, 'sources.yml')
    const sourceDir = join(root, 'demo-source')
    await writeTree(sourceDir, { 'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }) })
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, [
      'plugins:',
      '  "../escape":',
      '    source: "./demo-source"',
      '  demo:',
      `    source: ${JSON.stringify(sourceDir)}`,
    ].join('\n'), 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('plain directory name')
    expect(results[1]?.action).toBe('installed')
  })
})

describe('syncDeclaredSources() local sources', () => {
  it('installs a plugin from an absolute source and writes the record', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourceDir = join(root, 'demo-source')
    const sourcesFile = join(root, 'sources.yml')
    await writeTree(sourceDir, {
      'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'skills/a/SKILL.md': '---\nname: a\ndescription: A\n---\n',
    })
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, [
      'plugins:',
      '  demo:',
      `    source: ${JSON.stringify(sourceDir)}`,
    ].join('\n'), 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results).toEqual([{ plugin: 'demo', action: 'installed', from: undefined, to: '1.0.0' }])
    expect(await readManifest(join(install, 'demo'))).toEqual({ name: 'demo', version: '1.0.0' })
    const record = (await readRecord(install)).demo
    expect(record?.version).toBe('1.0.0')
    expect(record?.installedAt).toBeTruthy()
  })

  it('installs from a source relative to the declaration file', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourcesFile = join(root, 'sources.yml')
    await writeTree(join(root, 'demo-source'), { 'plugin.json': JSON.stringify({ name: 'demo', version: '2.0.0' }) })
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, [
      'plugins:',
      '  demo:',
      '    source: ./demo-source',
    ].join('\n'), 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('installed')
    expect((await readManifest(join(install, 'demo'))).version).toBe('2.0.0')
  })

  it('does not re-copy when the installed version is unchanged', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourceDir = join(root, 'demo-source')
    const sourcesFile = join(root, 'sources.yml')
    await writeTree(sourceDir, {
      'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'sentinel.txt': 'keep',
    })
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(sourceDir)}\n`, 'utf8')
    await syncDeclaredSources(sourcesFile, install)
    const before = await readFile(join(install, 'demo', 'sentinel.txt'), 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('up-to-date')
    expect(await readFile(join(install, 'demo', 'sentinel.txt'), 'utf8')).toBe(before)
  })

  it('re-copies and rewrites the record when the version changes', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourceDir = join(root, 'demo-source')
    const sourcesFile = join(root, 'sources.yml')
    await writeTree(sourceDir, {
      'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'stale.txt': 'old',
    })
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(sourceDir)}\n`, 'utf8')
    await syncDeclaredSources(sourcesFile, install)
    // Bump the version and replace the tree.
    await writeFile(join(sourceDir, 'plugin.json'), JSON.stringify({ name: 'demo', version: '2.0.0' }), 'utf8')
    await writeFile(join(sourceDir, 'new.txt'), 'new', 'utf8')
    await rm(join(sourceDir, 'stale.txt'))
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('updated')
    expect((await readManifest(join(install, 'demo'))).version).toBe('2.0.0')
    const installed = await entryNames(join(install, 'demo'))
    expect(installed).toContain('new.txt')
    expect(installed).not.toContain('stale.txt')
    expect((await readRecord(install)).demo?.version).toBe('2.0.0')
  })

  it('strips excluded names from the copied tree', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourceDir = join(root, 'demo-source')
    const sourcesFile = join(root, 'sources.yml')
    await writeTree(sourceDir, {
      'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      '.git/HEAD': 'ref',
      'node_modules/pkg/index.js': 'js',
      '__pycache__/mod.pyc': 'bytecode',
      '.temp/debug.log': 'log',
    })
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(sourceDir)}\n`, 'utf8')
    await syncDeclaredSources(sourcesFile, install)
    const flattened = await readdir(join(install, 'demo'), { recursive: true })
    expect(flattened.join('\n')).not.toContain('.git')
    expect(flattened.join('\n')).not.toContain('node_modules')
    expect(flattened.join('\n')).not.toContain('__pycache__')
    expect(flattened.join('\n')).not.toContain('.pyc')
    expect(flattened.join('\n')).not.toContain('.temp')
  })

  it('leaves the previous install intact when the copy fails', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourceDir = join(root, 'demo-source')
    const sourcesFile = join(root, 'sources.yml')
    await writeTree(sourceDir, {
      'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'sentinel.txt': 'keep',
    })
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(sourceDir)}\n`, 'utf8')
    await syncDeclaredSources(sourcesFile, install)
    // Bump the version and add a source directory nested deeper than the
    // copy depth cap: the re-copy aborts deterministically.
    await writeFile(join(sourceDir, 'plugin.json'), JSON.stringify({ name: 'demo', version: '2.0.0' }), 'utf8')
    const deep = join(sourceDir, ...Array.from({ length: 70 }, () => 'a'))
    await mkdir(deep, { recursive: true })
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('copy depth exceeded')
    expect(await readFile(join(install, 'demo', 'sentinel.txt'), 'utf8')).toBe('keep')
    expect((await readRecord(install)).demo?.version).toBe('1.0.0')
  })

  it('skips a local source without plugin.json', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourceDir = join(root, 'demo-source')
    const sourcesFile = join(root, 'sources.yml')
    await mkdir(sourceDir, { recursive: true })
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(sourceDir)}\n`, 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('no string version')
  })

  it('keeps the installed record source when the declaration omits source', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourceDir = join(root, 'demo-source')
    const sourcesFile = join(root, 'sources.yml')
    await writeTree(sourceDir, { 'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }) })
    await mkdir(install, { recursive: true })
    // Install once with a source, then declare without source.
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(sourceDir)}\n`, 'utf8')
    await syncDeclaredSources(sourcesFile, install)
    await writeFile(sourcesFile, 'plugins:\n  demo: {}\n', 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('up-to-date')
    expect((await readRecord(install)).demo?.source).toBe(sourceDir)
  })
})

describe('syncDeclaredSources() git sources', () => {
  // Each git test runs several real `git` invocations (init, commit, clone,
  // fetch) which is far slower than the vitest default timeout on Windows.
  const GIT_TIMEOUT = 30_000

  it('clones a git source and installs the plugin', async () => {
    const root = await tempRoot()
    const repo = join(root, 'repo')
    await gitRepo(repo, { 'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }) })
    const install = join(root, 'install')
    const sourcesFile = join(root, 'sources.yml')
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, [
      'plugins:',
      '  demo:',
      `    source: ${JSON.stringify(`file://${repo.replaceAll('\\', '/')}`)}`,
    ].join('\n'), 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results).toEqual([{ plugin: 'demo', action: 'installed', from: undefined, to: '1.0.0' }])
    expect((await readManifest(join(install, 'demo'))).version).toBe('1.0.0')
    expect((await readRecord(install)).demo?.source).toBe(`file://${repo.replaceAll('\\', '/')}`)
  }, GIT_TIMEOUT)

  it('installs from a git subpath (git+url#subpath) sharing one repository', async () => {
    const root = await tempRoot()
    const repo = join(root, 'market-repo')
    // One repository hosting two plugins in subdirectories, plus a root
    // without plugin.json (proves the subpath is used as the plugin root).
    await gitRepo(repo, {
      'demo-one/plugin.json': JSON.stringify({ name: 'one', version: '1.0.0' }),
      'demo-two/plugin.json': JSON.stringify({ name: 'two', version: '2.0.0' }),
      'README.md': 'marketplace readme',
    })
    const url = `git+file://${repo.replaceAll('\\', '/')}#demo-one`
    const install = join(root, 'install')
    const sourcesFile = join(root, 'sources.yml')
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, `plugins:\n  one:\n    source: ${JSON.stringify(url)}\n`, 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results).toEqual([{ plugin: 'one', action: 'installed', from: undefined, to: '1.0.0' }])
    expect((await readManifest(join(install, 'one'))).version).toBe('1.0.0')
    // The record keeps the full git+...#subpath source.
    expect((await readRecord(install)).one?.source).toBe(url)
  }, GIT_TIMEOUT)

  it('fetches a changed git source and updates the plugin', async () => {
    const root = await tempRoot()
    const repo = join(root, 'repo')
    await gitRepo(repo, { 'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }) })
    const url = `file://${repo.replaceAll('\\', '/')}`
    const install = join(root, 'install')
    const sourcesFile = join(root, 'sources.yml')
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(url)}\n`, 'utf8')
    await syncDeclaredSources(sourcesFile, install)
    // Change the plugin version in the repo and commit.
    await writeFile(join(repo, 'plugin.json'), JSON.stringify({ name: 'demo', version: '2.0.0' }), 'utf8')
    await run('git', ['-C', repo, 'add', '.'])
    await run('git', ['-C', repo, 'commit', '-q', '-m', 'bump'])
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('updated')
    expect(results[0]?.from).toBe('1.0.0')
    expect(results[0]?.to).toBe('2.0.0')
    expect((await readManifest(join(install, 'demo'))).version).toBe('2.0.0')
    expect((await readRecord(install)).demo?.version).toBe('2.0.0')
  }, GIT_TIMEOUT)

  it('keeps an unchanged git source up-to-date without rewriting', async () => {
    const root = await tempRoot()
    const repo = join(root, 'repo')
    await gitRepo(repo, { 'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }) })
    const url = `file://${repo.replaceAll('\\', '/')}`
    const install = join(root, 'install')
    const sourcesFile = join(root, 'sources.yml')
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(url)}\n`, 'utf8')
    await syncDeclaredSources(sourcesFile, install)
    const before = await readFile(join(install, 'demo', 'plugin.json'), 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('up-to-date')
    expect(await readFile(join(install, 'demo', 'plugin.json'), 'utf8')).toBe(before)
  }, GIT_TIMEOUT)

  it('skips a git source that fails to clone', async () => {
    const root = await tempRoot()
    const install = join(root, 'install')
    const sourcesFile = join(root, 'sources.yml')
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, 'plugins:\n  demo:\n    source: file:///nonexistent/repo.git\n', 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('git clone failed')
    expect(await entryNames(install)).toEqual([GIT_CACHE_DIR])
  })

  it('keeps the previous install when a git update fails', async () => {
    const root = await tempRoot()
    const repo = join(root, 'repo')
    await gitRepo(repo, { 'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }) })
    const url = `file://${repo.replaceAll('\\', '/')}`
    const install = join(root, 'install')
    const sourcesFile = join(root, 'sources.yml')
    await mkdir(install, { recursive: true })
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(url)}\n`, 'utf8')
    await syncDeclaredSources(sourcesFile, install)
    // Break the cache so the next fetch fails. The cache dir is keyed by a
    // hash of the repository URL (not the plugin name), because several
    // plugins may share one repository.
    const cache = join(install, GIT_CACHE_DIR, gitCacheName(`file://${repo.replaceAll('\\', '/')}`))
    await run('git', ['-C', cache, 'remote', 'set-url', 'origin', 'file:///nonexistent/repo.git'])
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('skipped')
    expect(results[0]?.reason).toContain('git fetch failed')
    expect((await readManifest(join(install, 'demo'))).version).toBe('1.0.0')
    expect((await readRecord(install)).demo?.version).toBe('1.0.0')
  }, GIT_TIMEOUT)

  it('rewrites the record source to the git URL on install', async () => {
    const root = await tempRoot()
    const repo = join(root, 'repo')
    await gitRepo(repo, { 'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }) })
    const url = `file://${repo.replaceAll('\\', '/')}`
    const install = join(root, 'install')
    const sourcesFile = join(root, 'sources.yml')
    await mkdir(install, { recursive: true })
    // A stale record exists (e.g. from a previous local install).
    await writeFile(join(install, INSTALLED_FILE), JSON.stringify({
      demo: { source: 'C:/old/source', version: '0.9.0' },
    }), 'utf8')
    await writeFile(sourcesFile, `plugins:\n  demo:\n    source: ${JSON.stringify(url)}\n`, 'utf8')
    const results = await syncDeclaredSources(sourcesFile, install)
    expect(results[0]?.action).toBe('updated')
    expect((await readRecord(install)).demo?.source).toBe(url)
  }, GIT_TIMEOUT)
})
