import type { PetreeConfig, RepoConfig } from './config.js'
import type { TaskRecord } from './store.js'

// Builds the prompt actually handed to `claude -p`: the task the user typed,
// followed by the standing conventions the registry declares for the repos it
// touches (see config.ts / repos.yaml). Composition happens at launch time
// rather than at task creation, so edits to repos.yaml apply to re-runs and
// resumes without rewriting stored tasks.

function hasConventions(repo: RepoConfig): boolean {
  return Boolean(repo.instructions) || repo.setup.length > 0 || repo.build.length > 0 || repo.test.length > 0
}

function commandBlock(title: string, note: string, commands: string[]): string[] {
  if (!commands.length) return []
  return ['', `**${title}** — ${note}`, ...commands.map((c) => `- \`${c}\``)]
}

function repoSection(name: string, repo: RepoConfig): string {
  const lines = [`### ${name} — checked out at \`/work/${name}\``]
  if (repo.instructions) lines.push('', repo.instructions)
  lines.push(...commandBlock('Setup', 'run these before changing anything', repo.setup))
  lines.push(...commandBlock('Build', 'must pass before you report success', repo.build))
  lines.push(...commandBlock('Tests', 'must pass before you report success', repo.test))
  return lines.join('\n')
}

export function composePrompt(task: TaskRecord, cfg: PetreeConfig): string {
  const sections: string[] = []
  let hasGates = false
  for (const name of task.repos) {
    const repo = cfg.repos[name]
    // Unknown repo names are rejected at task creation; a task can still outlive
    // its entry in repos.yaml, in which case there is nothing to append for it.
    if (!repo || !hasConventions(repo)) continue
    sections.push(repoSection(name, repo))
    if (repo.build.length || repo.test.length) hasGates = true
  }

  const global = cfg.defaults.instructions
  if (!sections.length && !global) return task.prompt

  const out = [
    task.prompt,
    '',
    '---',
    '',
    '## Repo conventions',
    '',
    'These come from petree\'s repo registry (`~/.petree/repos.yaml`), not from the',
    'task author. They apply in addition to the task above. If a convention truly',
    'conflicts with the task, follow the task and say so in your final message.',
  ]
  if (global) out.push('', global)
  for (const section of sections) out.push('', section)
  if (hasGates) {
    out.push(
      '',
      'Before you finish, every Build and Tests command listed above must have been',
      'run in this session and passed. If one fails and you cannot fix it, state that',
      'plainly in your final message — do not report success.',
    )
  }
  return out.join('\n')
}
