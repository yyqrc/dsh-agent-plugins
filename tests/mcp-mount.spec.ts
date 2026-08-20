/**
 * Tests for MCP server mounting inside the agent-plugins loader.
 * The MCP SDK is mocked so no real server process spawns.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'

const { mockMcpApply } = vi.hoisted(() => ({
  mockMcpApply: vi.fn(async (_childCtx: Context, _config: unknown) => {}),
}))

const { mockDshHome } = vi.hoisted(() => ({
  mockDshHome: `${process.env.TEMP ?? '/tmp'}/dsh-agent-plugins-mcp-home`,
}))

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({
  name: 'mcp-client',
  apply: mockMcpApply,
  Config: {},
}))

// Isolate the global filter from the developer's real ~/.dsh.
vi.mock('@deepseek-ai/dsh-home-paths', () => ({
  resolveDshHome: () => mockDshHome,
}))

import { name as pluginName, inject, apply } from '../src/index.ts'

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-mcp-'))
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

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const session = Session.create(SessionId('mcp-agent'), [], { version: 0, id: SessionId('mcp-agent'), createdAt: 0, cwd: process.cwd() })
  const agent = {
    id: SessionId('mcp-agent'),
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
    inject: () => {},
  } as unknown as Agent
  ctx.agents.register(agent)
  await ctx.plugin({ name: pluginName, inject, apply }, { pluginDirs: [root] })
  return ctx
}

describe('agent-plugins MCP mounting', () => {
  it('mounts one stdio MCP server as a child mcp-client instance with expanded paths', async () => {
    mockMcpApply.mockClear()
    const root = await tempRoot()
    await writePlugin(root, 'demo', {
      'plugin.json': JSON.stringify({ name: 'demo' }),
      'mcp.json': JSON.stringify({
        mcpServers: { debug: { type: 'stdio', command: 'python.exe', args: ['${PLUGIN_ROOT}/debug.py'] } },
      }),
    })
    await mount(root)
    expect(mockMcpApply).toHaveBeenCalledTimes(1)
    const [, config] = mockMcpApply.mock.calls[0] ?? []
    expect(config).toMatchObject({ transport: 'stdio', serverName: 'ap_demo_debug' })
    const stdio = config as { cwd?: string; args?: string[] }
    expect(stdio.cwd).toBe(join(root, 'demo'))
    // The root is a resolved (backslash) path; the manifest's forward slash
    // survives expansion verbatim.
    expect(stdio.args?.[0]).toBe(`${join(root, 'demo')}/debug.py`)
  })

  it('mounts one http MCP server as a streamable-http instance', async () => {
    mockMcpApply.mockClear()
    const root = await tempRoot()
    await writePlugin(root, 'demo', {
      'plugin.json': JSON.stringify({ name: 'demo' }),
      'mcp.json': JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://example.test/mcp' } } }),
    })
    await mount(root)
    expect(mockMcpApply).toHaveBeenCalledTimes(1)
    const [, config] = mockMcpApply.mock.calls[0] ?? []
    expect(config).toMatchObject({ transport: 'streamable-http', url: 'https://example.test/mcp' })
  })

  it('mounts the first of two plugins whose names normalize to the same server name', async () => {
    mockMcpApply.mockClear()
    const root = await tempRoot()
    // Both names exceed the 32-character server-name bound, so the
    // ap_<name>_debug normalization truncates them to one identical name.
    await writePlugin(root, 'a-very-long-plugin-name-suffix-one', {
      'plugin.json': JSON.stringify({ name: 'a-very-long-plugin-name-suffix-one' }),
      'mcp.json': JSON.stringify({ mcpServers: { debug: { type: 'stdio', command: 'python.exe' } } }),
    })
    await writePlugin(root, 'a-very-long-plugin-name-suffix-two', {
      'plugin.json': JSON.stringify({ name: 'a-very-long-plugin-name-suffix-two' }),
      'mcp.json': JSON.stringify({ mcpServers: { debug: { type: 'stdio', command: 'python.exe' } } }),
    })
    await mount(root)
    expect(mockMcpApply).toHaveBeenCalledTimes(1)
  })
})
