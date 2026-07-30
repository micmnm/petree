import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

export interface RepoConfig {
  url: string
  defaultBranch: string
  image: string
  setup: string[]
  test: string[]
  skills: string[]
}

export interface Defaults {
  timeoutMinutes: number
  tokenBudget: number
  concurrency: number
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
  const d = (raw.defaults ?? {}) as Record<string, number>
  const repos: Record<string, RepoConfig> = {}
  for (const [name, value] of Object.entries((raw.repos ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!value?.url) throw new Error(`repo ${name}: url is required`)
    if (!value?.image) throw new Error(`repo ${name}: image is required`)
    repos[name] = {
      url: String(value.url),
      defaultBranch: String(value.default_branch ?? 'main'),
      image: String(value.image),
      setup: (value.setup as string[]) ?? [],
      test: (value.test as string[]) ?? [],
      skills: (value.skills as string[]) ?? [],
    }
  }
  return {
    home,
    defaults: {
      timeoutMinutes: d.timeout_minutes ?? 30,
      tokenBudget: d.token_budget ?? 500_000,
      concurrency: d.concurrency ?? 3,
    },
    repos,
    allowClone: (raw.allow_clone as string[]) ?? [],
  }
}
