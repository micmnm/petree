import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadAll as loadYamlAll, CORE_SCHEMA, mergeTag } from 'js-yaml'

export interface RepoConfig {
  url: string
  defaultBranch: string
  image: string
  /** Free-form prompt text prepended to every task touching this repo. */
  instructions: string
  setup: string[]
  build: string[]
  test: string[]
  run: string[]
  skills: string[]
  /** Free-form labels (e.g. work, personal) used to filter repos in the dashboard. */
  tags: string[]
  defaultModel: string | null
  /** Host path of the user's own checkout, used only for the unpushed/dirty warning; never mounted. */
  path?: string | null
}

export interface Defaults {
  timeoutMinutes: number
  /** CRAFT turns build and test, so they get their own, longer limit. */
  buildTimeoutMinutes?: number
  tokenBudget: number
  concurrency: number
  defaultModel: string | null
  /** Free-form prompt text prepended to every task, whatever its repos. */
  instructions: string
  /** User-calibrated API-equivalent dollars per 5-hour window; unset means no share is shown. */
  windowUsd?: number | null
  /** GAME RULES › FROM YOUR ~/.claude; undefined until repos.yaml has a claude_home block. */
  claudeHome?: ClaudeHomeSettings
}

export interface ClaudeHomeSettings {
  instructions: boolean
  skills: string[]
  /** null = never saved: the interview plugins count as allowed (decision N2). */
  plugins: string[] | null
  mcp: string[]
}

// Command lists accept either a YAML list or a bare string, so both
// `test: ["npm test"]` and `test: npm test` work.
function toList(value: unknown): string[] {
  if (value == null) return []
  const items = Array.isArray(value) ? value : [value]
  return items.map((v) => String(v).trim()).filter(Boolean)
}

function toText(value: unknown): string {
  return value == null ? '' : String(value).trim()
}

export interface PetreeConfig {
  home: string
  defaults: Defaults
  repos: Record<string, RepoConfig>
  allowClone: string[]
  /** Host ~/.claude and ~/.claude.json; unset (as in tests) means nothing from them is read or mounted. */
  claudeHome?: string
  claudeJson?: string
}

// js-yaml 5 loads with CORE_SCHEMA (strict YAML 1.2), which no longer enables
// !!merge. repos.yaml is hand-written and sharing settings between repos via an
// anchor and `<<:` is natural, so keep the merge tag; without it those keys land
// as a literal "<<" property and the merged settings silently disappear.
const SCHEMA = CORE_SCHEMA.withTags(mergeTag)

// An empty or fully commented-out repos.yaml means "no repos configured", but
// js-yaml 5's load() throws on input holding no document where v4 returned
// undefined. loadAll() reports document-less input as an empty list instead,
// which beats a text heuristic: only the parser can tell a comment-only file
// from a real document. Multiple documents stay an error, as they were in v4.
function loadReposYaml(text: string): unknown {
  const docs = loadYamlAll(text, { schema: SCHEMA })
  if (docs.length > 1) throw new Error('expected a single YAML document in repos.yaml')
  return docs[0]
}

function parseClaudeHome(c: Record<string, unknown>): ClaudeHomeSettings {
  return {
    instructions: c.instructions !== false,
    skills: toList(c.skills),
    plugins: c.plugins == null ? null : toList(c.plugins),
    mcp: toList(c.mcp),
  }
}

// Split out from loadConfig so the dashboard's repos.yaml editor can validate
// a candidate document (parse + same repo checks) before it's ever written
// to disk or applied to the running config.
export function parseConfigText(text: string): Omit<PetreeConfig, 'home'> {
  const raw = (loadReposYaml(text) ?? {}) as Record<string, unknown>
  const d = (raw.defaults ?? {}) as Record<string, unknown>
  const repos: Record<string, RepoConfig> = {}
  for (const [name, value] of Object.entries((raw.repos ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!value?.url) throw new Error(`repo ${name}: url is required`)
    if (!value?.image) throw new Error(`repo ${name}: image is required`)
    repos[name] = {
      url: String(value.url),
      defaultBranch: String(value.default_branch ?? 'main'),
      image: String(value.image),
      instructions: toText(value.instructions),
      setup: toList(value.setup),
      build: toList(value.build),
      test: toList(value.test),
      run: toList(value.run),
      skills: toList(value.skills),
      tags: toList(value.tags),
      defaultModel: value.default_model != null ? String(value.default_model) : null,
      path: value.path != null ? String(value.path).replace(/^~(?=\/|$)/, homedir()) : null,
    }
  }
  return {
    defaults: {
      timeoutMinutes: Number(d.timeout_minutes ?? 30),
      buildTimeoutMinutes: Number(d.build_timeout_minutes ?? 180),
      tokenBudget: Number(d.token_budget ?? 500_000),
      concurrency: Number(d.concurrency ?? 3),
      defaultModel: d.default_model != null ? String(d.default_model) : null,
      instructions: toText(d.instructions),
      windowUsd: d.window_usd != null ? Number(d.window_usd) : null,
      claudeHome: d.claude_home != null ? parseClaudeHome(d.claude_home as Record<string, unknown>) : undefined,
    },
    repos,
    allowClone: (raw.allow_clone as string[]) ?? [],
  }
}

export function loadConfig(
  home: string = process.env.PETREE_HOME ?? join(homedir(), '.petree'),
): PetreeConfig {
  // Claude Code keeps .claude.json inside $CLAUDE_CONFIG_DIR when set, else next to ~/.claude.
  const dir = process.env.CLAUDE_CONFIG_DIR
  return {
    home,
    ...parseConfigText(readFileSync(join(home, 'repos.yaml'), 'utf8')),
    claudeHome: dir ?? join(homedir(), '.claude'),
    claudeJson: dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json'),
  }
}

/** The time limit for a task's current turn: CRAFT turns get at least the build limit. */
export function turnMinutes(task: { stage: string; timeoutMinutes: number }, d: Defaults): number {
  return task.stage === 'build' ? Math.max(task.timeoutMinutes, d.buildTimeoutMinutes ?? task.timeoutMinutes) : task.timeoutMinutes
}

export function resolveModel(
  requested: string | null | undefined,
  repoDefault: string | null,
  globalDefault: string | null,
): string | null {
  const norm = (m?: string | null): string | null => (m && m !== 'default' ? m : null)
  return norm(requested) ?? norm(repoDefault) ?? norm(globalDefault) ?? null
}
