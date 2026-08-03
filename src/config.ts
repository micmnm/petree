import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

export interface RepoConfig {
  url: string
  defaultBranch: string
  image: string
  /** Free-form prompt text prepended to every task touching this repo. */
  instructions: string
  setup: string[]
  build: string[]
  test: string[]
  skills: string[]
  defaultModel: string | null
}

export interface Defaults {
  timeoutMinutes: number
  tokenBudget: number
  concurrency: number
  defaultModel: string | null
  /** Free-form prompt text prepended to every task, whatever its repos. */
  instructions: string
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
}

export function loadConfig(
  home: string = process.env.PETREE_HOME ?? join(homedir(), '.petree'),
): PetreeConfig {
  const raw = (yaml.load(readFileSync(join(home, 'repos.yaml'), 'utf8')) ?? {}) as Record<string, unknown>
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
      skills: toList(value.skills),
      defaultModel: value.default_model != null ? String(value.default_model) : null,
    }
  }
  return {
    home,
    defaults: {
      timeoutMinutes: Number(d.timeout_minutes ?? 30),
      tokenBudget: Number(d.token_budget ?? 500_000),
      concurrency: Number(d.concurrency ?? 3),
      defaultModel: d.default_model != null ? String(d.default_model) : null,
      instructions: toText(d.instructions),
    },
    repos,
    allowClone: (raw.allow_clone as string[]) ?? [],
  }
}

export function resolveModel(
  requested: string | null | undefined,
  repoDefault: string | null,
  globalDefault: string | null,
): string | null {
  const norm = (m?: string | null): string | null => (m && m !== 'default' ? m : null)
  return norm(requested) ?? norm(repoDefault) ?? norm(globalDefault) ?? null
}
