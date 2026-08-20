/**
 * Tests for the Agent Plugins 1.0 directory manifest parser.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverPlugins, expandPluginRoot, loadPlugin, mcpServerName } from '../src/manifest.ts'

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-'))
}

async function writePlugin(root: string, name: string, files: Record<string, string>): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const file = join(dir, relative)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content, 'utf8')
  }
  return dir
}

const MANIFEST = JSON.stringify({ name: 'demo', version: '1.0.0', description: 'Demo plugin' })

describe('mcpServerName()', () => {
  it('normalizes plugin and server key into the bridge grammar', () => {
    expect(mcpServerName('cgame-unity', 'managed-debug')).toBe('ap_cgame-unity_managed-debug')
  })

  it('replaces characters outside the grammar', () => {
    expect(mcpServerName('a.b', 'c d')).toBe('ap_a.b_c_d'.replace(/[^A-Za-z0-9_-]/g, '_'))
  })

  it('caps the name at the 32-character grammar bound', () => {
    const name = mcpServerName('x'.repeat(40), 'y'.repeat(40))
    expect(name.length).toBeLessThanOrEqual(32)
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })
})

describe('expandPluginRoot()', () => {
  it('expands every ${PLUGIN_ROOT} occurrence', () => {
    expect(expandPluginRoot('${PLUGIN_ROOT}/server.py --root ${PLUGIN_ROOT}', 'C:/plugins/demo'))
      .toBe('C:/plugins/demo/server.py --root C:/plugins/demo')
  })

  it('leaves strings without the variable unchanged', () => {
    expect(expandPluginRoot('python.exe', 'C:/plugins/demo')).toBe('python.exe')
  })
})

describe('loadPlugin()', () => {
  it('rejects a directory without plugin.json', async () => {
    const root = await tempRoot()
    const result = await loadPlugin(join(root, 'missing'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]?.reason).toContain('missing file')
  })

  it('rejects a plugin.json without a name', async () => {
    const root = await tempRoot()
    const dir = await writePlugin(root, 'anon', { 'plugin.json': '{}' })
    const result = await loadPlugin(dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]?.reason).toContain('non-empty string name')
  })

  it('loads skills, commands, and stdio MCP servers with ${PLUGIN_ROOT} expanded', async () => {
    const root = await tempRoot()
    const dir = await writePlugin(root, 'demo', {
      'plugin.json': MANIFEST,
      'skills/xlua-hotfix/SKILL.md': '---\nname: xlua-hotfix\ndescription: Hotfix skill\nwhenToUse: hotfix tasks\n---\n\n# Body\n',
      'commands/inspect.md': '---\ndescription: Inspect the project\nargument-hint: <target>\n---\nInspect $ARGUMENTS now.\n',
      'mcp.json': JSON.stringify({
        mcpServers: {
          debug: { type: 'stdio', command: 'python.exe', args: ['${PLUGIN_ROOT}/server/debug.py'], env: { ROOT: '${PLUGIN_ROOT}' } },
        },
      }),
    })
    const result = await loadPlugin(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugin.manifest).toEqual({ name: 'demo', description: 'Demo plugin' })
    expect(result.problems).toEqual([])
    expect(result.plugin.skills).toHaveLength(1)
    const skill = result.plugin.skills[0]
    expect(skill).toMatchObject({
      name: 'xlua-hotfix',
      description: 'Hotfix skill',
      whenToUse: 'hotfix tasks',
      content: '# Body',
      source: 'agent-plugin',
    })
    expect(result.plugin.commands).toEqual([{
      name: 'inspect',
      description: 'Inspect the project',
      argumentHint: '<target>',
      body: 'Inspect $ARGUMENTS now.',
    }])
    expect(result.plugin.mcpServers).toEqual([{
      serverName: 'ap_demo_debug',
      config: {
        transport: 'stdio',
        serverName: 'ap_demo_debug',
        command: 'python.exe',
        args: [`${dir}/server/debug.py`],
        env: { ROOT: dir },
        cwd: dir,
      },
    }])
  })

  it('loads http MCP servers as streamable-http configs', async () => {
    const root = await tempRoot()
    const dir = await writePlugin(root, 'demo', {
      'plugin.json': MANIFEST,
      'mcp.json': JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } } } }),
    })
    const result = await loadPlugin(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugin.mcpServers).toEqual([{
      serverName: 'ap_demo_remote',
      config: {
        transport: 'streamable-http',
        serverName: 'ap_demo_remote',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer t' },
      },
    }])
  })

  it('collects per-file problems without rejecting the whole plugin', async () => {
    const root = await tempRoot()
    const dir = await writePlugin(root, 'demo', {
      'plugin.json': MANIFEST,
      'skills/broken/SKILL.md': '---\nname: Broken Name\ndescription: invalid name\n---\n',
      'skills/good/SKILL.md': '---\nname: good-skill\ndescription: fine\n---\n',
      'commands/no-frontmatter.md': 'plain text\n',
    })
    const result = await loadPlugin(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugin.skills.map(skill => skill.name)).toEqual(['good-skill'])
    expect(result.plugin.commands).toEqual([])
    expect(result.problems).toHaveLength(2)
  })

  it('rejects an mcp.json entry with an unsupported transport type', async () => {
    const root = await tempRoot()
    const dir = await writePlugin(root, 'demo', {
      'plugin.json': MANIFEST,
      'mcp.json': JSON.stringify({ mcpServers: { bad: { type: 'sse' } } }),
    })
    const result = await loadPlugin(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugin.mcpServers).toEqual([])
    expect(result.problems.some(problem => problem.reason.includes('unsupported type'))).toBe(true)
  })
})

describe('discoverPlugins()', () => {
  it('discovers one level of plugin directories and keeps earlier roots on duplicates', async () => {
    const first = await tempRoot()
    const second = await tempRoot()
    await writePlugin(first, 'demo', { 'plugin.json': MANIFEST, 'skills/a/SKILL.md': '---\nname: a\ndescription: A\n---\n' })
    await writePlugin(second, 'demo', { 'plugin.json': JSON.stringify({ name: 'demo', description: 'Second copy' }) })
    const result = await discoverPlugins([first, second])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]?.root.startsWith(first)).toBe(true)
    expect(result.problems.some(problem => problem.reason.includes('already loaded'))).toBe(true)
  })

  it('reports directories without a manifest as problems', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'not-a-plugin'), { recursive: true })
    await writePlugin(root, 'demo', { 'plugin.json': MANIFEST })
    const result = await discoverPlugins([root])
    expect(result.plugins).toHaveLength(1)
    expect(result.problems).toHaveLength(1)
  })

  it('discovers a plugin behind a symlinked plugin directory', async () => {
    const realRoot = await tempRoot()
    const scanRoot = await tempRoot()
    await writePlugin(realRoot, 'demo', {
      'plugin.json': MANIFEST,
      'skills/a/SKILL.md': '---\nname: a\ndescription: A\n---\n',
    })
    await symlink(join(realRoot, 'demo'), join(scanRoot, 'demo'), 'junction')
    const result = await discoverPlugins([scanRoot])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]?.skills.map(skill => skill.name)).toEqual(['a'])
    expect(result.problems).toEqual([])
  })
})
