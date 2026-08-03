import { execFile } from 'node:child_process'
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

export function containerName(taskId: string): string {
  return `petree-${taskId}`
}

export interface SandboxCommands {
  containerName: string
  create: string[]
  stream: string[]
  wait: string[]
  kill: string[]
  remove: string[]
  inspect: string[]
}

// Detached (-d, no --rm): the container is owned by the docker daemon and
// survives petree restarts; petree removes it explicitly once the turn is
// finalized. See docs/superpowers/specs/2026-08-03-restart-survival-design.md.
export function buildSandboxCommands(
  task: TaskRecord,
  cfg: PetreeConfig,
  workDir: string,
  oauthToken: string,
): SandboxCommands {
  const image = cfg.repos[task.repos[0]].image
  const name = containerName(task.id)
  const create = [
    'docker', 'run', '-d', '--init',
    '--name', name,
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
  if (task.sessionId && transcript && existsSync(transcript)) create.push('--resume', task.sessionId)
  return {
    containerName: name,
    create,
    stream: ['docker', 'logs', '-f', name],
    wait: ['docker', 'wait', name],
    kill: ['docker', 'stop', '-t', '5', name],
    remove: ['docker', 'rm', '-f', name],
    inspect: ['docker', 'inspect', '-f', '{{.State.Status}}', name],
  }
}

export type ContainerState = 'running' | 'exited' | 'absent'

// 'created' (never started) and other odd statuses map to 'absent' so recovery
// requeues instead of waiting forever on a container that will never speak.
export function inspectContainerState(inspect: string[]): Promise<ContainerState> {
  return new Promise((resolve) => {
    const [cmd, ...args] = inspect
    execFile(cmd, args, (err, stdout) => {
      if (err) return resolve('absent')
      const status = stdout.trim()
      if (status === 'running') return resolve('running')
      if (status === 'exited' || status === 'dead') return resolve('exited')
      resolve('absent')
    })
  })
}
