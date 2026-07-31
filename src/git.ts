import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PetreeConfig } from './config.js'
import { createTaskBranch } from './gitops.js'

export function prepareWorkspace(cfg: PetreeConfig, repoNames: string[], workDir: string, taskId: string): void {
  for (const name of repoNames) {
    if (!cfg.repos[name]) throw new Error(`unknown repo: ${name}`)
  }
  mkdirSync(workDir, { recursive: true })
  for (const name of repoNames) {
    const repo = cfg.repos[name]
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--branch', repo.defaultBranch, repo.url, join(workDir, name)],
      { stdio: 'pipe' },
    )
    createTaskBranch(join(workDir, name), taskId)
  }
}
