import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PetreeConfig } from './config.js'
import type { TaskRecord } from './store.js'

export function readToken(home: string): string {
  const file = join(home, 'token')
  if (!existsSync(file)) {
    throw new Error(
      `missing ${file} — run \`claude setup-token\` on the host and save the printed token to that file (chmod 600)`,
    )
  }
  return readFileSync(file, 'utf8').trim()
}

export function buildDockerCommand(
  task: TaskRecord,
  cfg: PetreeConfig,
  workDir: string,
  oauthToken: string,
): string[] {
  const image = cfg.repos[task.repos[0]].image
  const cmd = [
    'docker', 'run', '--rm', '--init',
    '--name', `petree-${task.id}`,
    '-v', `${workDir}:/work`,
    '-v', `${join(cfg.home, 'shared', 'skills')}:/petree/skills:ro`,
    '-v', `${join(cfg.home, 'shared', 'findings')}:/petree/findings`,
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`,
    '-w', '/work',
    image,
    'claude', '-p', task.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
  ]
  if (task.sessionId) cmd.push('--resume', task.sessionId)
  return cmd
}
