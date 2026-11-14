import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeMounts, sandboxReport, scanClaudeHome, syncClaudeHome, writeMcpFile,
} from '../src/claude-home.js'
import { parseConfigText, type ClaudeHomeSettings, type PetreeConfig } from '../src/config.js'
import type { Launcher } from '../src/launcher.js'
import { composePrompt } from '../src/prompt.js'
import { buildSandboxCommands } from '../src/sandbox.js'
import { Scheduler } from '../src/scheduler.js'
import { makeApp } from '../src/server.js'
import { TaskStore, type TaskRecord } from '../src/store.js'

// Fixtures only: a temp claude-home and .claude.json, never the real ~/.claude or ~/.claude.json.
const put = (p: string, text: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }
const skill = (dir: string, name: string, desc: string) => put(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`)

let root: string, ch: string, petree: string, json: string, outsideDir: string

function plugin(key: string, version: string, files: Record<string, string>, installPath?: string) {
  const [name, market] = key.split('@')
  const dir = installPath ?? join(ch, 'plugins', 'cache', market, name, version)
  for (const [p, text] of Object.entries(files)) put(join(dir, p), text)
  const file = join(ch, 'plugins', 'installed_plugins.json')
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 2, plugins: {} }
  cur.plugins[key] = [{ scope: 'user', installPath: dir, version }]
  put(file, JSON.stringify(cur))
}

function claudeJson(servers: Record<string, unknown>, projects: Record<string, unknown> = {}) {
  put(json, JSON.stringify({ oauthAccount: { emailAddress: 'SECRET-EMAIL' }, mcpServers: servers, projects }))
}

const USER_SERVERS = {
  linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer SECRET1' } },
  notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
  local: { type: 'stdio', command: '/usr/bin/npx', args: ['-y', 'srv'], env: { TOKEN: 'SECRET2' }, extra: 'dropped' },
}
const PROJECT = { '/code/api': { mcpServers: { linear: { command: 'node', args: ['x.js'], env: { K: '${HOST_TOKEN}' } } }, history: ['SECRET3'] } }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'petree-ch-'))
  ch = join(root, 'claude')
  petree = join(root, 'petree')
  json = join(root, '.claude.json')
  outsideDir = join(root, 'elsewhere', 'evil')
  put(join(ch, 'CLAUDE.md'), '# me\n@~/notes/team.md and @rules/a.md and @/etc/hosts.\nmail me at me@example.com\n')
  put(join(ch, 'rules', 'a.md'), 'a')
  put(join(ch, 'rules', 'b.md'), 'b')
  skill(join(ch, 'skills'), 'alpha', 'Alpha does things.')
  skill(join(ch, 'skills'), 'beta', 'Beta, also in shared.')
  skill(join(ch, 'skills', 'synced'), 'cloud', 'never offered')
  mkdirSync(join(ch, 'skills', 'nodesc'), { recursive: true })
  plugin('agent-skills@addy', '0.6.15', { 'skills/interview-me/SKILL.md': 'x', 'skills/tdd/SKILL.md': 'x', '.claude-plugin/plugin.json': '{"name":"agent-skills"}' })
  plugin('ralph@official', '1.0.1', { 'hooks/hooks.json': '{"hooks":{"Stop":[]}}', 'skills/loop/SKILL.md': 'x' })
  plugin('figma@official', '2.2.0', { '.mcp.json': '{"mcpServers":{"figma":{"type":"http","url":"https://mcp.figma.com"}}}' })
  plugin('evil@x', '1.0.0', { 'skills/interview-me/SKILL.md': 'x' }, outsideDir)
  put(join(ch, 'settings.json'), JSON.stringify({ enabledPlugins: { 'ralph@official': false } }))
  claudeJson(USER_SERVERS, PROJECT)
  skill(join(petree, 'shared', 'skills'), 'beta', 'shared beta')
})

const config = (claudeHome?: ClaudeHomeSettings): PetreeConfig => ({
  home: petree,
  defaults: { timeoutMinutes: 30, tokenBudget: 1, concurrency: 1, defaultModel: null, instructions: '', claudeHome },
  repos: { demo: { url: 'x', defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], run: [], skills: [], tags: [], defaultModel: null } },
  allowClone: [],
  claudeHome: ch,
  claudeJson: json,
})

const task: TaskRecord = {
  id: 'abc123', prompt: 'fix it', repos: ['demo'], mode: 'unattended',
  state: 'provisioning', sessionId: null, tokensUsed: 0, tokenBudget: 1,
  timeoutMinutes: 30, error: null, result: null, model: null, turns: [], createdAt: '', updatedAt: '',
  restarts: 0, retryAt: null, startedAt: null, logOffset: 0, stage: 'spec', comments: [], delivery: {}, party: true, autoPlay: false,
  seq: 1, bin: null, binReason: null, binnedAt: null, archivedAt: null,
}

describe('scanClaudeHome', () => {
  it('lists instructions, personal skills, plugins and MCP servers', () => {
    const s = scanClaudeHome(config())
    expect(s.instructions).toEqual({ claudeMd: true, rules: 2, unresolvedImports: ['~/notes/team.md', '/etc/hosts'] })
    expect(s.skills).toEqual([{ name: 'alpha', description: 'Alpha does things.' }, { name: 'beta', description: 'Beta, also in shared.' }])
    const p = Object.fromEntries(s.plugins.map((x) => [x.key, x]))
    expect(p['agent-skills@addy']).toMatchObject({ name: 'agent-skills', marketplace: 'addy', version: '0.6.15', skills: ['interview-me', 'tdd'], interview: true, outside: false, enabled: null })
    expect(p['ralph@official']).toMatchObject({ hooks: ['Stop'], interview: false, enabled: false })
    expect(p['figma@official'].mcp).toEqual(['figma'])
    expect(p['evil@x']).toMatchObject({ outside: true, skills: [], interview: false })
    const m = Object.fromEntries(s.mcp.map((x) => [x.id, x]))
    expect(m.linear).toEqual({ id: 'linear', name: 'linear', scope: 'user', transport: 'http', target: 'mcp.linear.app', hasSecrets: true, hostEnv: false, needsLogin: false })
    expect(m.notion).toMatchObject({ needsLogin: true, hasSecrets: false })
    expect(m.local).toMatchObject({ transport: 'stdio', target: 'npx', hasSecrets: true })
    expect(m['linear@/code/api']).toMatchObject({ scope: '/code/api', target: 'node', hostEnv: true })
  })

  it('reads nothing without a configured claude home', () => {
    const s = scanClaudeHome({})
    expect(s.skills).toEqual([])
    expect(s.mcp).toEqual([])
    expect(claudeMounts({ ...config(), claudeHome: undefined }).volumes).toEqual([])
  })
})

describe('claudeMounts', () => {
  it('builds the exact read-only mounts and flags', () => {
    const cfg = config({ instructions: true, skills: ['alpha', 'beta', 'gone'], plugins: null, mcp: ['linear', 'linear@/code/api', 'vanished'] })
    writeMcpFile(petree, scanClaudeHome(cfg), cfg.defaults.claudeHome!.mcp)
    const m = claudeMounts(cfg)
    const agentDir = join(ch, 'plugins', 'cache', 'addy', 'agent-skills', '0.6.15')
    expect(m.volumes).toEqual([
      '-v', `${join(ch, 'CLAUDE.md')}:/home/dev/.claude/CLAUDE.md:ro`,
      '-v', `${join(ch, 'rules')}:/home/dev/.claude/rules:ro`,
      '-v', `${join(ch, 'skills', 'alpha')}:/petree/skills/.claude/skills/alpha:ro`,
      // N2: never saved → the interview plugin is allowed (the outside one is never read, so never picked).
      '-v', `${realpathSync(agentDir)}:/petree/plugins/agent-skills:ro`,
      '-v', `${join(petree, 'claude.mcp.json')}:/petree/mcp.json:ro`,
    ])
    expect(m.flags).toEqual(['--add-dir', '/petree/skills', '--plugin-dir', '/petree/plugins/agent-skills', '--mcp-config', '/petree/mcp.json'])
    expect(m.flags).not.toContain('--strict-mcp-config')
    expect(m.skipped).toEqual([
      'skill beta: name taken by shared', 'skill gone: missing', 'mcp vanished: gone from ~/.claude.json',
    ])
    expect(m.mcpNames).toEqual(['linear', 'linear-api'])
  })

  it('refuses a plugin whose install path is outside ~/.claude/plugins', () => {
    const m = claudeMounts(config({ instructions: false, skills: [], plugins: ['evil@x'], mcp: [] }))
    expect(m.volumes).toEqual([])
    expect(m.flags).toEqual([])
    expect(m.skipped).toEqual(['plugin evil@x: outside ~/.claude/plugins'])
  })

  it('slugs two allowlisted plugins sharing a name by marketplace', () => {
    plugin('figma@other', '1.0.0', { '.claude-plugin/plugin.json': '{"name":"figma"}' })
    const m = claudeMounts(config({ instructions: false, skills: [], plugins: ['figma@official', 'figma@other'], mcp: [] }))
    expect(m.flags).toEqual(['--plugin-dir', '/petree/plugins/figma-official', '--plugin-dir', '/petree/plugins/figma-other'])
  })

  it('puts every host mount read-only into docker run and the setup section into the prompt', () => {
    const cfg = config({ instructions: true, skills: ['alpha'], plugins: ['ralph@official'], mcp: [] })
    const create = buildSandboxCommands(task, cfg, '/w', 'tok').create
    const vols = create.flatMap((a, i) => (create[i - 1] === '-v' ? [a] : []))
    expect(vols.filter((v) => !v.endsWith(':ro'))).toEqual(['/w:/work', `${join(petree, 'sessions', task.id)}:/home/dev/.claude`])
    expect(create.slice(create.indexOf('--dangerously-skip-permissions') + 1))
      .toEqual(['--add-dir', '/petree/skills', '--plugin-dir', '/petree/plugins/ralph'])
    const prompt = create[create.indexOf('-p') + 1]
    expect(prompt).toContain("## The user's own setup")
    expect(prompt).toContain("The user's own instructions (`~/.claude/CLAUDE.md`, `~/.claude/rules/`), skills and plugins are loaded")
    expect(prompt.indexOf("own setup")).toBeLessThan(prompt.indexOf('## Thread status'))
  })

  it('leaves the prompt unchanged when nothing is mounted', () => {
    const none = config({ instructions: false, skills: [], plugins: [], mcp: [] })
    expect(composePrompt(task, none, claudeMounts(none).setup)).toBe(composePrompt(task, none))
  })
})

describe('writeMcpFile', () => {
  it('holds only allowlisted servers, with secrets, atomically at mode 0600', () => {
    const r = writeMcpFile(petree, scanClaudeHome(config()), ['local', 'linear@/code/api', 'linear'])
    expect(r).toEqual({ servers: 3, skipped: [] })
    const file = join(petree, 'claude.mcp.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: {
      local: { command: '/usr/bin/npx', args: ['-y', 'srv'], env: { TOKEN: 'SECRET2' } },
      linear: USER_SERVERS.linear,
      'linear-api': { command: 'node', args: ['x.js'], env: { K: '${HOST_TOKEN}' } },
    } })
  })

  it('keeps the old file and throws when .claude.json is unreadable', () => {
    writeMcpFile(petree, scanClaudeHome(config()), ['linear'])
    put(json, '{ not json')
    expect(() => writeMcpFile(petree, scanClaudeHome(config()), ['linear'])).toThrow(/kept as it was/)
    expect(readFileSync(join(petree, 'claude.mcp.json'), 'utf8')).toContain('SECRET1')
  })
})

describe('sandboxReport', () => {
  it('reads plugins, MCP status and skills from the init event', () => {
    const cfg = config({ instructions: false, skills: [], plugins: ['agent-skills@addy', 'ralph@official'], mcp: ['linear', 'notion'] })
    writeMcpFile(petree, scanClaudeHome(cfg), ['linear', 'notion'])
    const init = { type: 'system', subtype: 'init', skills: ['a', 'b', 'c'], plugins: [{ name: 'agent-skills', path: '/petree/plugins/agent-skills' }],
      mcp_servers: [{ name: 'linear', status: 'connected' }, { name: 'plugin:x:y', status: 'needs-auth' }] }
    const log = `{"type":"assistant"}\n${JSON.stringify(init)}\n{"type":"result"}\n`
    expect(sandboxReport(log, claudeMounts(cfg))).toEqual({
      plugins: [{ name: 'agent-skills', loaded: true }, { name: 'ralph', loaded: false }],
      mcp: [{ name: 'linear', status: 'connected' }, { name: 'plugin:x:y', status: 'needs-auth' }, { name: 'notion', status: 'failed' }],
      skills: 3,
      skipped: [],
    })
    expect(sandboxReport('{"type":"assistant"}\n', claudeMounts(cfg))).toBeNull()
  })
})

describe('config', () => {
  it('parses claude_home; absent plugins means never saved', () => {
    const d = (y: string) => parseConfigText(`defaults:\n  claude_home:\n${y}`).defaults.claudeHome
    expect(d('    skills: [a]\n')).toEqual({ instructions: true, skills: ['a'], plugins: null, mcp: [] })
    expect(d('    instructions: false\n    plugins: []\n    mcp: [x]\n')).toEqual({ instructions: false, skills: [], plugins: [], mcp: ['x'] })
    expect(parseConfigText('repos: {}\n').defaults.claudeHome).toBeUndefined()
  })
})

describe('syncClaudeHome', () => {
  const yaml = () => readFileSync(join(petree, 'repos.yaml'), 'utf8')
  const cfgFromYaml = () => ({ ...config(), defaults: parseConfigText(yaml()).defaults })

  it('reports new, gone and changed; drops gone items; never flips choices; dry run writes nothing', () => {
    put(join(petree, 'repos.yaml'), '# mine\ndefaults:\n  concurrency: 2\n  claude_home:\n    instructions: true\n    skills: [alpha]\n    mcp: [linear, local]\nrepos: {}\n')
    const first = syncClaudeHome(cfgFromYaml())
    expect(first.new.skills).toEqual(['alpha', 'beta'])
    expect(first.gone).toEqual({ skills: [], plugins: [], mcp: [] })
    expect(first.mcpFile).toEqual({ servers: 2, skipped: [] })
    expect(yaml()).not.toContain('plugins') // N2 still applies: never saved

    // one skill added, one allowlisted skill removed, one plugin and one server changed, one server added
    skill(join(ch, 'skills'), 'gamma', 'new one')
    rmSync(join(ch, 'skills', 'alpha'), { recursive: true })
    plugin('ralph@official', '1.0.2', { 'hooks/hooks.json': '{"hooks":{"Stop":[]}}' })
    claudeJson({ ...USER_SERVERS, linear: { ...USER_SERVERS.linear, url: 'https://mcp.linear.app/v2' }, fresh: { command: 'uvx' } }, PROJECT)

    const before = yaml()
    const dry = syncClaudeHome(cfgFromYaml(), { dryRun: true })
    expect(dry.summary).toBe('DRY RUN · 1 new skill · 1 new MCP server · 1 gone · 2 changed')
    expect(yaml()).toBe(before)
    const mcpBefore = readFileSync(join(petree, 'claude.mcp.json'), 'utf8')

    const cfg = cfgFromYaml()
    const r = syncClaudeHome(cfg)
    expect(r.new).toEqual({ skills: ['gamma'], plugins: [], mcp: ['fresh'] })
    expect(r.gone).toEqual({ skills: ['alpha'], plugins: [], mcp: [] })
    expect(r.changed).toEqual({ skills: [], plugins: ['ralph@official'], mcp: ['linear'] })
    expect(r.summary).toBe('SYNCED · 1 new skill · 1 new MCP server · 1 gone · 2 changed')
    // gone alpha removed, new gamma/fresh not ticked, the rest of the file kept
    expect(cfg.defaults.claudeHome).toEqual({ instructions: true, skills: [], plugins: null, mcp: ['linear', 'local'] })
    expect(yaml()).toContain('# mine')
    expect(yaml()).toContain('concurrency: 2')
    const mcp = JSON.parse(readFileSync(join(petree, 'claude.mcp.json'), 'utf8')).mcpServers
    expect(Object.keys(mcp)).toEqual(['linear', 'local'])
    expect(mcp.linear.url).toBe('https://mcp.linear.app/v2')
    expect(mcpBefore).not.toContain('/v2')

    expect(syncClaudeHome(cfgFromYaml()).summary).toBe('SYNCED · nothing new')
  })

  it('dry run on a fresh home writes no file at all', () => {
    syncClaudeHome(config(), { dryRun: true })
    expect(existsSync(join(petree, 'repos.yaml'))).toBe(false)
    expect(existsSync(join(petree, 'claude.mcp.json'))).toBe(false)
    expect(existsSync(join(petree, 'claude-home.seen.json'))).toBe(false)
  })
})

describe('claude-home API', () => {
  let server: Server, base: string
  beforeEach(async () => {
    put(join(petree, 'repos.yaml'), 'defaults:\n  concurrency: 2\nrepos: {}\n')
    const cfg = config()
    cfg.defaults = parseConfigText(readFileSync(join(petree, 'repos.yaml'), 'utf8')).defaults
    const store = new TaskStore(join(root, 'db'))
    const launch: Launcher = Object.assign(async () => {}, { stop: async () => false, reattach: async () => {} })
    const app = makeApp(cfg, store, new Scheduler(store, 0, launch), launch)
    await new Promise<void>((r) => { server = app.listen(0, () => r()) })
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => server.close())
  const send = (method: string, path: string, body: unknown) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('GET /api/claude-home returns names and flags, never secret values', async () => {
    const res = await fetch(`${base}/api/claude-home`)
    const text = await res.text()
    for (const secret of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET-EMAIL', 'Bearer', 'HOST_TOKEN', 'x.js']) expect(text).not.toContain(secret)
    const body = JSON.parse(text)
    expect(body.mcp.map((m: { id: string }) => m.id)).toEqual(['linear', 'notion', 'local', 'linear@/code/api'])
    expect(body.chosen).toEqual({ instructions: true, skills: [], plugins: ['agent-skills@addy'], mcp: [], pluginsSaved: false })
  })

  it('PUT /api/defaults validates claude_home, writes the MCP file, then repos.yaml', async () => {
    expect((await send('PUT', '/api/defaults', { claude_home: { instructions: true, skills: ['nope'], plugins: [], mcp: [] } })).status).toBe(400)
    expect(existsSync(join(petree, 'claude.mcp.json'))).toBe(false)
    const ok = await send('PUT', '/api/defaults', { claude_home: { instructions: false, skills: ['alpha'], plugins: [], mcp: ['notion'] } })
    expect(ok.status).toBe(200)
    expect(Object.keys(JSON.parse(readFileSync(join(petree, 'claude.mcp.json'), 'utf8')).mcpServers)).toEqual(['notion'])
    expect(parseConfigText(readFileSync(join(petree, 'repos.yaml'), 'utf8')).defaults.claudeHome)
      .toEqual({ instructions: false, skills: ['alpha'], plugins: [], mcp: ['notion'] })
    const chosen = (await (await fetch(`${base}/api/claude-home`)).json()).chosen
    expect(chosen).toMatchObject({ plugins: [], pluginsSaved: true })
  })

  it('POST /api/claude-home/sync returns the report', async () => {
    const r = await (await send('POST', '/api/claude-home/sync', {})).json()
    expect(r.summary).toBe('SYNCED · 2 new skills · 4 new plugins · 4 new MCP servers')
  })
})
