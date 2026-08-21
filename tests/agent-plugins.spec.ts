/**
 * Tests for the agent-plugins loader plugin: discovery, skill and command
 * registry mounting, namespacing, project filtering, and command template
 * injection. MCP child mounting is covered in mcp-mount.spec.ts with a
 * static SDK mock.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'

// Isolate the global filter from the developer's real ~/.dsh: the harness
// home resolves to a per-suite temp directory for every test.
const { mockDshHome } = vi.hoisted(() => {
  const home = `${process.env.TEMP ?? '/tmp'}/dsh-agent-plugins-suite-home`
  return { mockDshHome: home }
})

vi.mock('@deepseek-ai/dsh-home-paths', () => ({
  resolveDshHome: () => mockDshHome,
  dshHomePath: (...segments: string[]) => join(mockDshHome, ...segments),
}))

import {
  name as pluginName,
  inject,
  apply,
  Config,
  filterForWorkspace,
  isPluginEnabled,
  namespacedName,
  NO_PROJECT_FILTER,
  readProjectFilter,
} from '../src/index.ts'
import { INSTALLED_FILE } from '../src/auto-update.ts'

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-loader-'))
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

/** Names only, for skill-list assertions. */
function listedSkillNames(skills: readonly { name: string }[]): string[] {
  return skills.map(skill => skill.name)
}

/** The version field of one installed plugin.json. */
async function readManifestVersion(pluginDir: string): Promise<string | undefined> {
  const manifest = JSON.parse(await readFile(join(pluginDir, 'plugin.json'), 'utf8')) as { version?: string }
  return manifest.version
}

function fakeAgent(id: string, injected: UserMessage[], cwd = process.cwd()): Agent {
  const session = Session.create(SessionId(id), [], { version: 0, id: SessionId(id), createdAt: 0, cwd })
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    cancel() {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(message: UserMessage): void {
      injected.push(message)
    },
  } as unknown as Agent
}

async function mount(
  root: string,
  config: Record<string, unknown> = {},
): Promise<{ ctx: Context; agent: Agent; injected: UserMessage[] }> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const injected: UserMessage[] = []
  const agent = fakeAgent('loader-agent', injected)
  ctx.agents.register(agent)
  await ctx.plugin({ name: pluginName, inject, apply }, { pluginDirs: [root], ...config })
  return { ctx, agent, injected }
}

describe('agent-plugins module exports', () => {
  it('declares its plugin name, injections, and config schema', () => {
    expect(pluginName).toBe('agent-plugins')
    expect(inject).toEqual(['skills', 'commands', 'agents'])
    expect(Config({})).toEqual({
      pluginDirs: [join(mockDshHome, 'agent-plugins')],
      namespaceSkills: true,
      namespaceCommands: true,
      projectFilter: true,
      autoUpdate: false,
    })
  })
})

describe('namespacedName()', () => {
  it('prefixes with a normalized plugin name', () => {
    expect(namespacedName('cgame-unity', 'xlua-hotfix')).toBe('cgame-unity-xlua-hotfix')
  })

  it('normalizes non-kebab plugin names', () => {
    expect(namespacedName('My Plugin', 'do-thing')).toBe('my-plugin-do-thing')
  })
})

describe('isPluginEnabled()', () => {
  it('shows everything under the empty filter', () => {
    expect(isPluginEnabled(NO_PROJECT_FILTER, 'cgame-unity')).toBe(true)
  })

  it('whitelists only enable-listed plugins', () => {
    expect(isPluginEnabled({ enable: ['cgame-unity'], disable: [] }, 'cgame-unity')).toBe(true)
    expect(isPluginEnabled({ enable: ['cgame-unity'], disable: [] }, 'cgame-engine')).toBe(false)
  })

  it('blacklists disable-listed plugins', () => {
    expect(isPluginEnabled({ enable: [], disable: ['cgame-engine'] }, 'cgame-engine')).toBe(false)
    expect(isPluginEnabled({ enable: [], disable: ['cgame-engine'] }, 'cgame-unity')).toBe(true)
  })

  it('explicit disable wins over the whitelist', () => {
    expect(isPluginEnabled({ enable: ['cgame-unity'], disable: ['cgame-unity'] }, 'cgame-unity')).toBe(false)
  })
})

describe('readProjectFilter()', () => {
  it('returns the empty parsed filter when no global filter file exists', async () => {
    expect(await readProjectFilter()).toEqual({ global: NO_PROJECT_FILTER, workspaces: [] })
  })

  it('reads the global filter file with workspace entries from the harness home', async () => {
    const filterFile = join(mockDshHome, 'agent-plugins.yml')
    await mkdir(mockDshHome, { recursive: true })
    await writeFile(filterFile, [
      'enable:',
      '  - sacha-orchestra',
      '  - cgame-mcp',
      'workspaces:',
      '  - paths:',
      '      - D:/COD/Client',
      '      - E:/MagicDawn/CGameEditorProject/LookDevProject',
      '    enable:',
      '      - cgame-unity',
      '  - paths:',
      '      - E:/CODM/UnitySource',
      '    enable:',
      '      - cgame-engine',
    ].join('\n'), 'utf8')
    const filter = await readProjectFilter()
    expect(filter.global).toEqual({ enable: ['sacha-orchestra', 'cgame-mcp'], disable: [] })
    expect(filter.workspaces).toEqual([
      { paths: ['D:/COD/Client', 'E:/MagicDawn/CGameEditorProject/LookDevProject'], enable: ['cgame-unity'], disable: [] },
      { paths: ['E:/CODM/UnitySource'], enable: ['cgame-engine'], disable: [] },
    ])
  })
})

describe('filterForWorkspace()', () => {
  const parsed = {
    global: { enable: ['sacha-orchestra', 'cgame-mcp'], disable: [] },
    workspaces: [
      { paths: ['D:/COD/Client', 'E:/MagicDawn/CGameEditorProject/LookDevProject'], enable: ['cgame-unity'], disable: [] },
      { paths: ['E:/CODM/UnitySource'], enable: ['cgame-engine'], disable: [] },
    ],
  }

  it('uses the global filter alone when the cwd matches no workspace', () => {
    expect(filterForWorkspace(parsed, 'D:/other/project')).toEqual(parsed.global)
    expect(filterForWorkspace(parsed, undefined)).toEqual(parsed.global)
  })

  it('merges workspace enable entries onto the global whitelist', () => {
    const filter = filterForWorkspace(parsed, 'D:/COD/Client/Assets')
    expect(filter.enable).toEqual(['sacha-orchestra', 'cgame-mcp', 'cgame-unity'])
    expect(filter.disable).toEqual([])
  })

  it('matches prefix paths on path boundaries', () => {
    const filter = filterForWorkspace(parsed, 'E:/CODM/UnitySource/Runtime')
    expect(filter.enable).toContain('cgame-engine')
    // A sibling path sharing a prefix string must not match.
    expect(filterForWorkspace(parsed, 'E:/CODM/UnitySourceExtra')).toEqual(parsed.global)
  })
})

describe('agent-plugins apply()', () => {
  beforeEach(async () => {
    // Fresh global-filter state per test: the suite home doubles as the
    // harness home and must not leak filter files across cases.
    try {
      const { rm } = await import('node:fs/promises')
      await rm(mockDshHome, { recursive: true, force: true })
    } catch {
      // Absent home is the expected pre-test state.
    }
  })

  it('namespaces discovered skills by plugin name by default', async () => {
    const root = await tempRoot()
    await writePlugin(root, 'demo', {
      'plugin.json': JSON.stringify({ name: 'demo' }),
      'skills/xlua-hotfix/SKILL.md': '---\nname: xlua-hotfix\ndescription: Hotfix skill\n---\n\n# Body\n',
    })
    const { ctx } = await mount(root)
    const listed = await ctx.skills.list({})
    expect(listed.map(skill => skill.name)).toEqual(['demo-xlua-hotfix'])
    const loaded = await ctx.skills.get('demo-xlua-hotfix', {})
    expect(loaded?.content).toBe('# Body')
  })

  it('keeps bare skill names when namespaceSkills is false', async () => {
    const root = await tempRoot()
    await writePlugin(root, 'demo', {
      'plugin.json': JSON.stringify({ name: 'demo' }),
      'skills/xlua-hotfix/SKILL.md': '---\nname: xlua-hotfix\ndescription: Hotfix skill\n---\n\n# Body\n',
    })
    const { ctx } = await mount(root, { namespaceSkills: false, projectFilter: false })
    const listed = await ctx.skills.list({})
    expect(listed.map(skill => skill.name)).toEqual(['xlua-hotfix'])
  })

  it('registers discovered commands with namespaced names and injects the rendered template', async () => {
    const root = await tempRoot()
    await writePlugin(root, 'demo', {
      'plugin.json': JSON.stringify({ name: 'demo' }),
      'commands/inspect.md': '---\ndescription: Inspect the project\nargument-hint: <target>\n---\nInspect $ARGUMENTS now.\n',
    })
    const { ctx, agent, injected } = await mount(root)
    const listed = ctx.commands.list(agent)
    expect(listed).toEqual([{ name: 'demo-inspect', description: 'Inspect the project', input: { hint: '<target>' } }])
    const execution = await ctx.commands.execute(agent, '/demo-inspect the scene', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(injected).toHaveLength(1)
    const text = injected[0]?.content[0]
    expect(text?.type).toBe('text')
    if (text?.type === 'text') {
      expect(text.text).toContain('<agent-plugin-command name="inspect" plugin="demo">')
      expect(text.text).toContain('Inspect the scene now.')
    }
  })

  it('rejects a command when the global filter disables its plugin', async () => {
    const root = await tempRoot()
    await writePlugin(root, 'demo', {
      'plugin.json': JSON.stringify({ name: 'demo' }),
      'commands/inspect.md': '---\ndescription: Inspect the project\n---\nInspect now.\n',
    })
    await mkdir(mockDshHome, { recursive: true })
    await writeFile(join(mockDshHome, 'agent-plugins.yml'), 'disable:\n  - demo\n', 'utf8')
    const { ctx, agent, injected } = await mount(root)
    const execution = await ctx.commands.execute(agent, '/demo-inspect', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('error')
    expect(injected).toHaveLength(0)
  })

  it('hides skills of plugins disabled by the global filter', async () => {
    const root = await tempRoot()
    await writePlugin(root, 'visible', {
      'plugin.json': JSON.stringify({ name: 'visible' }),
      'skills/keep/SKILL.md': '---\nname: keep\ndescription: Keep\n---\n',
    })
    await writePlugin(root, 'hidden', {
      'plugin.json': JSON.stringify({ name: 'hidden' }),
      'skills/drop/SKILL.md': '---\nname: drop\ndescription: Drop\n---\n',
    })
    await mkdir(mockDshHome, { recursive: true })
    await writeFile(join(mockDshHome, 'agent-plugins.yml'), 'disable:\n  - hidden\n', 'utf8')
    const { ctx } = await mount(root)
    const listed = await ctx.skills.list({})
    expect(listed.map(skill => skill.name)).toEqual(['visible-keep'])
  })

  it('tolerates a missing plugin root', async () => {
    const root = join(await tempRoot(), 'absent')
    const { ctx } = await mount(root, { projectFilter: false })
    expect(await ctx.skills.list({})).toEqual([])
  })

  it('skips plugins that failed to load while keeping the rest', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'broken'), { recursive: true })
    await writePlugin(root, 'demo', {
      'plugin.json': JSON.stringify({ name: 'demo' }),
      'skills/good/SKILL.md': '---\nname: good\ndescription: Good skill\n---\n',
    })
    const { ctx } = await mount(root, { projectFilter: false })
    const listed = await ctx.skills.list({})
    expect(listed.map(skill => skill.name)).toEqual(['demo-good'])
  })

  it('never refreshes installed plugins when autoUpdate is unset', async () => {
    const root = await tempRoot()
    const source = join(root, 'source', 'demo')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ name: 'demo', version: '2.0.0' }), 'utf8')
    await mkdir(join(source, 'skills', 'new-skill'), { recursive: true })
    await writeFile(join(source, 'skills', 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: New\n---\n', 'utf8')
    const install = join(root, 'install')
    await writePlugin(install, 'demo', {
      'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'skills/old-skill/SKILL.md': '---\nname: old-skill\ndescription: Old\n---\n',
    })
    const recordBefore = JSON.stringify({ demo: { source, version: '1.0.0', installedAt: '2020-01-01 00:00:00' } })
    await writeFile(join(install, INSTALLED_FILE), recordBefore, 'utf8')
    const { ctx } = await mount(install, { projectFilter: false })
    // Default config leaves the installed directory and record untouched.
    expect(listedSkillNames(await ctx.skills.list({}))).toEqual(['demo-old-skill'])
    expect(await readManifestVersion(join(install, 'demo'))).toBe('1.0.0')
    expect(await readFile(join(install, INSTALLED_FILE), 'utf8')).toBe(recordBefore)
  })

  it('refreshes installed plugins before discovery when autoUpdate is enabled', async () => {
    const root = await tempRoot()
    const source = join(root, 'source', 'demo')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ name: 'demo', version: '2.0.0' }), 'utf8')
    await mkdir(join(source, 'skills', 'new-skill'), { recursive: true })
    await writeFile(join(source, 'skills', 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: New\n---\n', 'utf8')
    const install = join(root, 'install')
    await writePlugin(install, 'demo', {
      'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'skills/old-skill/SKILL.md': '---\nname: old-skill\ndescription: Old\n---\n',
    })
    await writeFile(join(install, INSTALLED_FILE), JSON.stringify({
      demo: { source, version: '1.0.0', installedAt: '2020-01-01 00:00:00' },
    }), 'utf8')
    const { ctx } = await mount(install, { projectFilter: false, autoUpdate: true })
    // The refreshed tree is what this activation loads.
    expect(listedSkillNames(await ctx.skills.list({}))).toEqual(['demo-new-skill'])
    expect(await readManifestVersion(join(install, 'demo'))).toBe('2.0.0')
    const record = JSON.parse(await readFile(join(install, INSTALLED_FILE), 'utf8')) as {
      demo: { version?: string; installedAt?: string }
    }
    expect(record.demo.version).toBe('2.0.0')
    expect(record.demo.installedAt).not.toBe('2020-01-01 00:00:00')
  })
})
