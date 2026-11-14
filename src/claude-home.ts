import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { parseConfigText, type ClaudeHomeSettings, type PetreeConfig } from './config.js'
import { readCapped } from './notes.js'
import { setDefaults } from './repos-yaml.js'

// The user's ~/.claude in the sandbox (spec §5.8): listing for GAME RULES, read-only mounts,
// petree's own MCP file, and SYNC. Host files are the user's own, read capped and never mounted
// except as listed in claudeMounts.

const JSON_MAX = 64 * 1024 * 1024
const INTERVIEW_SKILLS = ['interview-me', 'brainstorming', 'spec-driven-development']
// A name goes into a `-v src:dst:ro` argument, so no colons or commas.
const SAFE = /^[\w.-]+$/

export interface PluginEntry {
  key: string; name: string; marketplace: string; version: string
  skills: string[]; hooks: string[]; mcp: string[]; outside: boolean; interview: boolean
  /** settings.json enabledPlugins on the host; null when it doesn't say. */
  enabled: boolean | null
}
export interface McpEntry {
  id: string; name: string; scope: 'user' | string
  transport: 'stdio' | 'http' | 'sse'; target: string
  hasSecrets: boolean; hostEnv: boolean; needsLogin: boolean
}
export interface ClaudeHomeListing {
  instructions: { claudeMd: boolean; rules: number; unresolvedImports: string[] }
  skills: { name: string; description: string }[]
  plugins: PluginEntry[]
  mcp: McpEntry[]
}
type McpDef = Record<string, unknown>
export interface ClaudeHomeScan extends ClaudeHomeListing {
  mcpError: string | null
  pluginPaths: Record<string, string>
  mcpDefs: Record<string, McpDef>
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }
const isFile = (p: string): boolean => { try { return statSync(p).isFile() } catch { return false } }
const dirs = (p: string): string[] => { try { return readdirSync(p).filter((n) => SAFE.test(n) && !n.startsWith('.') && isDir(join(p, n))) } catch { return [] } }

// readCapped refuses a symlinked last component; host dotfiles are often symlinks, so resolve first.
function readText(p: string, max = JSON_MAX): string | null {
  try { return readCapped(realpathSync(p), max)?.text ?? null } catch { return null }
}
function readJson(p: string): unknown {
  const text = readText(p)
  try { return text === null ? null : JSON.parse(text) } catch { return null }
}

function description(md: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? ''
  const m = /^description:[ \t]*(.*)\r?\n?(.*)/m.exec(fm)
  const first = m ? (/^[|>][-+]?$/.test(m[1].trim()) ? m[2] : m[1]) : ''
  return first.trim().replace(/^["']|["']$/g, '').slice(0, 140)
}

// @imports in CLAUDE.md that resolve outside claudeHome won't exist in the sandbox (decision N6).
function outsideImports(md: string, home: string): string[] {
  const out = new Set<string>()
  for (const [, raw] of md.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const ref = raw.replace(/[),.;:]+$/, '')
    const p = ref.startsWith('~/') ? join(homedir(), ref.slice(2)) : isAbsolute(ref) ? ref : resolve(home, ref)
    if (p !== home && !p.startsWith(home + sep)) out.add(ref)
  }
  return [...out]
}

export function scanClaudeHome(cfg: Pick<PetreeConfig, 'claudeHome' | 'claudeJson'>): ClaudeHomeScan {
  const scan: ClaudeHomeScan = {
    instructions: { claudeMd: false, rules: 0, unresolvedImports: [] },
    skills: [], plugins: [], mcp: [], mcpError: null, pluginPaths: {}, mcpDefs: {},
  }
  const home = cfg.claudeHome
  if (home) {
    const md = readText(join(home, 'CLAUDE.md'), 1024 * 1024)
    let rules = 0
    try { rules = (readdirSync(join(home, 'rules'), { recursive: true }) as string[]).filter((n) => n.endsWith('.md')).length } catch { /* none */ }
    scan.instructions = { claudeMd: md !== null, rules, unresolvedImports: md ? outsideImports(md, home) : [] }

    // synced/ holds claude.ai-synced skills, never offered (decision 16).
    scan.skills = dirs(join(home, 'skills')).filter((n) => n !== 'synced' && isFile(join(home, 'skills', n, 'SKILL.md')))
      .map((name) => ({ name, description: description(readText(join(home, 'skills', name, 'SKILL.md'), 64 * 1024) ?? '') }))

    const installed = obj(obj(readJson(join(home, 'plugins', 'installed_plugins.json'))).plugins)
    const enabled = obj(obj(readJson(join(home, 'settings.json'))).enabledPlugins)
    let root: string | null = null
    try { root = realpathSync(join(home, 'plugins')) } catch { /* no plugins dir */ }
    for (const [key, list] of Object.entries(installed)) {
      const inst = obj(Array.isArray(list) ? list[0] : null)
      if (typeof inst.installPath !== 'string') continue
      let real: string
      try { real = realpathSync(inst.installPath) } catch { continue }
      const [kname, marketplace = ''] = key.split('@')
      // A hand-edited installPath must not mount (or even be read from) an arbitrary host directory.
      const outside = !root || !real.startsWith(root + sep)
      const at = (...p: string[]) => (outside ? null : readJson(join(real, ...p)))
      const manifest = obj(at('.claude-plugin', 'plugin.json'))
      const mcpJson = obj(at('.mcp.json'))
      const skills = outside ? [] : dirs(join(real, 'skills')).filter((n) => isFile(join(real, 'skills', n, 'SKILL.md')))
      scan.plugins.push({
        key, name: typeof manifest.name === 'string' ? manifest.name : kname, marketplace,
        version: typeof inst.version === 'string' ? inst.version : '',
        skills, hooks: Object.keys(obj(obj(at('hooks', 'hooks.json')).hooks)),
        mcp: Object.keys(mcpJson.mcpServers ? obj(mcpJson.mcpServers) : mcpJson),
        outside, interview: skills.some((s) => INTERVIEW_SKILLS.includes(s)),
        enabled: key in enabled ? enabled[key] === true : null,
      })
      if (!outside) scan.pluginPaths[key] = real
    }
  }

  if (cfg.claudeJson) {
    const json = readJson(cfg.claudeJson)
    if (json === null) scan.mcpError = `${cfg.claudeJson} is missing or not JSON`
    const add = (name: string, scope: string, raw: unknown) => {
      const r = obj(raw)
      const remote = r.type === 'http' || r.type === 'sse'
      if (remote ? typeof r.url !== 'string' : typeof r.command !== 'string') return
      // Only what starts the server is copied; nothing else from ~/.claude.json.
      const def: McpDef = remote
        ? { type: r.type, url: r.url, ...(r.headers ? { headers: obj(r.headers) } : {}) }
        : { command: r.command, ...(Array.isArray(r.args) ? { args: r.args } : {}), ...(r.env ? { env: obj(r.env) } : {}) }
      const id = scope === 'user' ? name : `${name}@${scope}`
      let target = basename(String(r.command ?? ''))
      if (remote) try { target = new URL(String(r.url)).host } catch { target = '' }
      scan.mcpDefs[id] = def
      scan.mcp.push({
        id, name, scope, transport: remote ? (r.type as 'http' | 'sse') : 'stdio', target,
        hasSecrets: Object.keys(obj(def.env)).length + Object.keys(obj(def.headers)).length > 0,
        hostEnv: JSON.stringify(def).includes('${'),
        // Heuristic: a remote server with no headers in the config gets its token elsewhere.
        needsLogin: remote && !Object.keys(obj(def.headers)).length,
      })
    }
    const j = obj(json)
    for (const [name, def] of Object.entries(obj(j.mcpServers))) add(name, 'user', def)
    for (const [path, p] of Object.entries(obj(j.projects))) {
      for (const [name, def] of Object.entries(obj(obj(p).mcpServers))) add(name, path, def)
    }
  }
  return scan
}

export const listing = ({ instructions, skills, plugins, mcp }: ClaudeHomeScan): ClaudeHomeListing => ({ instructions, skills, plugins, mcp })

export const settingsOf = (cfg: PetreeConfig): ClaudeHomeSettings =>
  cfg.defaults.claudeHome ?? { instructions: true, skills: [], plugins: null, mcp: [] }

// Decision N2: until GAME RULES saves a list, the installed interview plugins are allowed.
export const pluginAllowlist = (s: ClaudeHomeSettings, scan: ClaudeHomeScan): string[] =>
  s.plugins ?? scan.plugins.filter((p) => p.interview).map((p) => p.key)

/** repos.yaml form: `plugins` stays absent while never saved, so N2 keeps applying. */
export const settingsYaml = (s: ClaudeHomeSettings): Record<string, unknown> =>
  ({ instructions: s.instructions, skills: s.skills, ...(s.plugins !== null ? { plugins: s.plugins } : {}), mcp: s.mcp })

/** Checks a PUT body against the listing; a string is the 400 message. */
export function validateSettings(body: unknown, scan: ClaudeHomeScan): ClaudeHomeSettings | string {
  const b = obj(body)
  if (typeof b.instructions !== 'boolean') return 'claude_home.instructions must be a boolean'
  const out: ClaudeHomeSettings = { instructions: b.instructions, skills: [], plugins: [], mcp: [] }
  const known = { skills: scan.skills.map((s) => s.name), plugins: scan.plugins.map((p) => p.key), mcp: scan.mcp.map((m) => m.id) }
  for (const k of ['skills', 'plugins', 'mcp'] as const) {
    const v = b[k]
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `claude_home.${k} must be a list of names`
    const unknown = v.find((x) => !known[k].includes(x))
    if (unknown !== undefined) return `claude_home.${k}: unknown ${unknown}`
    out[k] = [...new Set(v as string[])]
  }
  return out
}

// User scope first so it keeps the plain name; a clashing project server gets `-<dir>`.
function mcpFileServers(scan: ClaudeHomeScan, ids: string[]): { servers: Record<string, McpDef>; skipped: string[] } {
  const skipped = scan.mcpError ? [`mcp: ${scan.mcpError}`] : ids.filter((id) => !scan.mcpDefs[id]).map((id) => `mcp ${id}: gone from ~/.claude.json`)
  const picked = scan.mcp.filter((m) => ids.includes(m.id)).sort((a, b) => Number(a.scope !== 'user') - Number(b.scope !== 'user'))
  const servers = new Map<string, McpDef>()
  for (const m of picked) servers.set(servers.has(m.name) ? `${m.name}-${basename(m.scope)}` : m.name, scan.mcpDefs[m.id])
  return { servers: Object.fromEntries(servers), skipped }
}

const mcpFile = (petreeHome: string) => join(petreeHome, 'claude.mcp.json')

// Atomic and 0600: it holds the allowlisted servers' secrets. A running container keeps its
// bound inode, so it sees the old file until its next turn.
function writePrivate(file: string, text: string): void {
  const tmp = `${file}.tmp`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, file)
}

/** Rewrites <petree home>/claude.mcp.json with only the allowlisted servers. */
export function writeMcpFile(petreeHome: string, scan: ClaudeHomeScan, ids: string[]): { servers: number; skipped: string[] } {
  if (ids.length && scan.mcpError) throw new Error(`${scan.mcpError}; claude.mcp.json kept as it was`)
  const { servers, skipped } = mcpFileServers(scan, ids)
  writePrivate(mcpFile(petreeHome), JSON.stringify({ mcpServers: servers }, null, 2) + '\n')
  return { servers: Object.keys(servers).length, skipped }
}

export interface ClaudeMounts {
  volumes: string[]
  flags: string[]
  skipped: string[]
  /** What the prompt's "user's own setup" section names (instructions, skills, plugins). */
  setup: string[]
  plugins: { name: string; slug: string }[]
  mcpNames: string[]
}

export function claudeMounts(cfg: PetreeConfig, scan: ClaudeHomeScan = scanClaudeHome(cfg)): ClaudeMounts {
  const out: ClaudeMounts = { volumes: [], flags: [], skipped: [], setup: [], plugins: [], mcpNames: [] }
  const home = cfg.claudeHome
  if (!home) return out
  const s = settingsOf(cfg)
  const ro = (src: string, dst: string) => out.volumes.push('-v', `${src}:${dst}:ro`)

  // Nested in the rw session mount; Docker creates the mount points there.
  if (s.instructions) {
    if (scan.instructions.claudeMd) ro(join(home, 'CLAUDE.md'), '/home/dev/.claude/CLAUDE.md')
    if (isDir(join(home, 'rules'))) ro(join(home, 'rules'), '/home/dev/.claude/rules')
    if (out.volumes.length) out.setup.push('instructions (`~/.claude/CLAUDE.md`, `~/.claude/rules/`)')
  }

  // Not under the read-only shared skills mount (Docker would create mount points on the host
  // inside it); Claude Code loads .claude/skills/ from --add-dir directories instead.
  const shared = new Set(dirs(join(cfg.home, 'shared', 'skills')))
  const before = out.volumes.length
  for (const name of s.skills) {
    if (!scan.skills.some((k) => k.name === name)) out.skipped.push(`skill ${name}: missing`)
    else if (shared.has(name)) out.skipped.push(`skill ${name}: name taken by shared`)
    else ro(join(home, 'skills', name), `/petree/skills/.claude/skills/${name}`)
  }
  if (out.volumes.length > before) { out.flags.push('--add-dir', '/petree/skills'); out.setup.push('skills') }

  const picked: PluginEntry[] = []
  for (const key of pluginAllowlist(s, scan)) {
    const p = scan.plugins.find((x) => x.key === key)
    if (!p) out.skipped.push(`plugin ${key}: not installed`)
    else if (p.outside) out.skipped.push(`plugin ${key}: outside ~/.claude/plugins`)
    else picked.push(p)
  }
  for (const p of picked) {
    const base = picked.filter((x) => x.name === p.name).length > 1 ? `${p.name}-${p.marketplace}` : p.name
    const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    ro(scan.pluginPaths[p.key], `/petree/plugins/${slug}`)
    out.flags.push('--plugin-dir', `/petree/plugins/${slug}`)
    out.plugins.push({ name: p.name, slug })
  }
  if (picked.length) out.setup.push('plugins')

  // No --strict-mcp-config: it would also drop the allowlisted plugins' MCP servers (§11.3 S1).
  if (s.mcp.length) {
    const { servers, skipped } = mcpFileServers(scan, s.mcp)
    out.skipped.push(...skipped)
    out.mcpNames = Object.keys(servers)
    if (existsSync(mcpFile(cfg.home))) {
      ro(mcpFile(cfg.home), '/petree/mcp.json')
      out.flags.push('--mcp-config', '/petree/mcp.json')
    }
  }
  return out
}

export interface SandboxReport {
  plugins: { name: string; loaded: boolean }[]
  mcp: { name: string; status: string }[]
  skills: number
  skipped: string[]
}

/** From the run's system/init stream event; null before the first one. */
export function sandboxReport(log: string, m: ClaudeMounts): SandboxReport | null {
  const line = log.split('\n').reverse().find((l) => l.includes('"subtype":"init"'))
  let init: Record<string, unknown>
  try { init = obj(JSON.parse(line ?? '')) } catch { return null }
  if (init.type !== 'system') return null
  const list = (v: unknown) => (Array.isArray(v) ? v.map(obj) : [])
  const loaded = list(init.plugins)
  const mcp = list(init.mcp_servers).map((x) => ({ name: String(x.name), status: String(x.status) }))
  for (const name of m.mcpNames) if (!mcp.some((x) => x.name === name)) mcp.push({ name, status: 'failed' })
  return {
    plugins: m.plugins.map((p) => ({ name: p.name, loaded: loaded.some((x) => x.name === p.name || x.path === `/petree/plugins/${p.slug}`) })),
    mcp,
    skills: Array.isArray(init.skills) ? init.skills.length : 0,
    skipped: m.skipped,
  }
}

// ---- SYNC: compare the host setup with what petree saw last time ----

interface Seen { skills: string[]; plugins: Record<string, string>; mcp: Record<string, string> }
type Lists = { skills: string[]; plugins: string[]; mcp: string[] }
export interface SyncReport {
  dryRun: boolean
  new: Lists
  gone: Lists
  changed: Lists
  summary: string
  mcpFile: { servers: number; skipped: string[] } | { error: string }
}

const SEEN_FILE = 'claude-home.seen.json'
// Detects a changed command, url, token or env without keeping any value.
const fingerprint = (def: McpDef) => createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16)

function seenOf(scan: ClaudeHomeScan): Seen {
  return {
    skills: scan.skills.map((s) => s.name),
    plugins: Object.fromEntries(scan.plugins.map((p) => [p.key, p.version])),
    mcp: Object.fromEntries(Object.entries(scan.mcpDefs).map(([id, d]) => [id, fingerprint(d)])),
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * New items stay unticked; gone items leave the allowlists; existing choices never flip.
 * Writes only the removal of gone items (repos.yaml), claude.mcp.json and the seen snapshot.
 */
export function syncClaudeHome(cfg: PetreeConfig, opts: { dryRun?: boolean } = {}): SyncReport {
  if (!cfg.claudeHome) throw new Error('no ~/.claude configured')
  const scan = scanClaudeHome(cfg)
  const s = settingsOf(cfg)
  const raw = obj(readJson(join(cfg.home, SEEN_FILE)))
  const prev: Seen = {
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
    plugins: obj(raw.plugins) as Record<string, string>,
    mcp: obj(raw.mcp) as Record<string, string>,
  }
  const now = seenOf(scan)
  const keys = (x: Seen): Lists => ({ skills: x.skills, plugins: Object.keys(x.plugins), mcp: Object.keys(x.mcp) })
  const [was, is] = [keys(prev), keys(now)]
  const allowed: Lists = { skills: s.skills, plugins: s.plugins ?? [], mcp: s.mcp }
  const gone = (k: keyof Lists) => [...new Set([...was[k], ...allowed[k]])].filter((id) => !is[k].includes(id))
  const report: SyncReport = {
    dryRun: !!opts.dryRun,
    new: { skills: is.skills.filter((x) => !was.skills.includes(x)), plugins: is.plugins.filter((x) => !was.plugins.includes(x)), mcp: is.mcp.filter((x) => !was.mcp.includes(x)) },
    // An unreadable ~/.claude.json is not a removal.
    gone: { skills: gone('skills'), plugins: gone('plugins'), mcp: scan.mcpError ? [] : gone('mcp') },
    changed: {
      skills: [],
      plugins: is.plugins.filter((k) => k in prev.plugins && prev.plugins[k] !== now.plugins[k]),
      mcp: is.mcp.filter((k) => k in prev.mcp && prev.mcp[k] !== now.mcp[k]),
    },
    summary: '',
    mcpFile: { servers: 0, skipped: [] },
  }
  const next: ClaudeHomeSettings = {
    instructions: s.instructions,
    skills: s.skills.filter((x) => !report.gone.skills.includes(x)),
    plugins: s.plugins && s.plugins.filter((x) => !report.gone.plugins.includes(x)),
    mcp: s.mcp.filter((x) => !report.gone.mcp.includes(x)),
  }
  const n = report.new, g = report.gone, c = report.changed
  const goneCount = g.skills.length + g.plugins.length + g.mcp.length
  const changedCount = c.plugins.length + c.mcp.length
  const parts = [
    n.skills.length && `${plural(n.skills.length, 'new skill')}`,
    n.plugins.length && `${plural(n.plugins.length, 'new plugin')}`,
    n.mcp.length && `${plural(n.mcp.length, 'new MCP server')}`,
    goneCount && `${goneCount} gone`,
    changedCount && `${changedCount} changed`,
  ].filter(Boolean)
  report.summary = `${opts.dryRun ? 'DRY RUN' : 'SYNCED'} · ${parts.length ? parts.join(' · ') : 'nothing new'}`
  if (opts.dryRun) return report

  try { report.mcpFile = writeMcpFile(cfg.home, scan, next.mcp) } catch (err) { report.mcpFile = { error: String(err instanceof Error ? err.message : err) } }
  if (JSON.stringify(next) !== JSON.stringify(s)) writeClaudeHome(cfg, next)
  writePrivate(join(cfg.home, SEEN_FILE), JSON.stringify(now) + '\n')
  return report
}

/** Splices claude_home into repos.yaml's defaults block and applies it to cfg in place. */
export function writeClaudeHome(cfg: PetreeConfig, s: ClaudeHomeSettings): void {
  const file = join(cfg.home, 'repos.yaml')
  const next = setDefaults(existsSync(file) ? readFileSync(file, 'utf8') : '', { claude_home: settingsYaml(s) })
  const parsed = parseConfigText(next)
  writeFileSync(`${file}.tmp`, next)
  renameSync(`${file}.tmp`, file)
  cfg.defaults = parsed.defaults
}
