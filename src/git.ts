import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PetreeConfig } from './config.js'
import { createTaskBranch } from './gitops.js'

const execFileAsync = promisify(execFile)

// Clones run in a child process via execFile (not execFileSync): the scheduler
// invokes this synchronously from the tick that also has to answer the
// POST /api/tasks request, so a blocking clone here would freeze the whole
// event loop — and with it every other request, including UI polling — for
// as long as the clone takes.
export async function prepareWorkspace(cfg: PetreeConfig, repoNames: string[], workDir: string, taskId: string): Promise<void> {
  for (const name of repoNames) {
    if (!cfg.repos[name]) throw new Error(`unknown repo: ${name}`)
  }
  mkdirSync(workDir, { recursive: true })
  for (const name of repoNames) {
    // Requeued tasks (follow-up turns, resume after pause/failure) already have
    // their clone on the petree/<taskId> branch with prior commits — reuse it.
    if (existsSync(join(workDir, name))) continue
    const repo = cfg.repos[name]
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', '--branch', repo.defaultBranch, repo.url, join(workDir, name)],
    )
    createTaskBranch(join(workDir, name), taskId)
  }
}
