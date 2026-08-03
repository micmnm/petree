import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PetreeConfig } from './config.js'
import { composePrompt } from './prompt.js'
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
    '-v', `${join(cfg.home, 'sessions', task.id)}:/home/dev/.claude`,
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`,
    '-w', '/work',
    image,
    'claude', '-p', composePrompt(task, cfg),
    ...(task.model ? ['--model', task.model] : []),
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
  ]
  // Resume only when the transcript from a previous run actually exists on the
  // host (cwd inside the container is always /work, so the project key is
  // stable). A stale sessionId with no transcript must start a fresh session,
  // not crash the run.
  const transcript = task.sessionId
    ? join(cfg.home, 'sessions', task.id, 'projects', '-work', `${task.sessionId}.jsonl`)
    : null
  if (task.sessionId && transcript && existsSync(transcript)) cmd.push('--resume', task.sessionId)
  return cmd
}
