import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { resolveModel } from './config.js'
import type { PetreeConfig } from './config.js'
import { repoStatus, diffBranch, pushBranch, createPullRequest, taskBranch } from './gitops.js'
import type { Launcher } from './launcher.js'
import type { Scheduler } from './scheduler.js'
import type { TaskStore, TaskRecord } from './store.js'
import type { Response } from 'express'

export const MODELS = ['default', 'haiku', 'sonnet', 'opus']

// Shared by /push and /pr: a target must be a plain branch name, never the base
// branch, HEAD, or a refspec/ref-path trick that could redirect onto it.
function targetOrError(
  cfg: PetreeConfig,
  t: TaskRecord,
  repo: string | undefined,
  target: string | undefined,
  res: Response,
): string | null {
  if (!repo || !t.repos.includes(repo)) {
    res.status(400).json({ error: `unknown repo: ${repo}` })
    return null
  }
  const base = cfg.repos[repo]?.defaultBranch ?? 'main'
  const norm = String(target ?? '').trim().replace(/^refs\/heads\//, '')
  const valid = /^[\w.\-/]+$/.test(norm) && !norm.startsWith('refs/') && norm.toUpperCase() !== 'HEAD' && norm !== base
  if (!valid) {
    res.status(400).json({ error: 'invalid or protected target branch' })
    return null
  }
  return norm
}

export function makeApp(cfg: PetreeConfig, store: TaskStore, scheduler: Scheduler, launcher: Launcher): express.Express {
  const app = express()
  app.use(express.json())

  app.post('/api/tasks', (req, res) => {
    const { prompt, repos, model } = (req.body ?? {}) as { prompt?: string; repos?: string[]; model?: string }
    if (typeof prompt !== 'string' || !prompt || !Array.isArray(repos) || repos.length === 0) {
      res.status(400).json({ error: 'prompt and repos[] are required' })
      return
    }
    if (model !== undefined && !MODELS.includes(model)) {
      res.status(400).json({ error: `unknown model: ${model}` })
      return
    }
    for (const r of repos) {
      if (!Object.hasOwn(cfg.repos, r)) {
        res.status(400).json({ error: `unknown repo: ${r}` })
        return
      }
    }
    const effectiveModel = resolveModel(model, cfg.repos[repos[0]].defaultModel, cfg.defaults.defaultModel)
    const task = store.create({
      prompt,
      repos,
      tokenBudget: cfg.defaults.tokenBudget,
      timeoutMinutes: cfg.defaults.timeoutMinutes,
      model: effectiveModel,
    })
    void scheduler.tick()
    res.status(201).json(task)
  })

  app.get('/api/tasks', (_req, res) => { res.json(store.list()) })

  app.get('/api/repos', (_req, res) => {
    res.json(
      Object.entries(cfg.repos).map(([name, r]) => ({
        name,
        defaultBranch: r.defaultBranch,
        image: r.image,
        defaultModel: r.defaultModel,
      })),
    )
  })

  app.get('/api/tasks/:id', (req, res) => {
    const t = store.get(req.params.id)
    if (t) res.json(t)
    else res.sendStatus(404)
  })

  app.get('/api/tasks/:id/logs', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) {
      res.sendStatus(400)
      return
    }
    const file = join(cfg.home, 'logs', `${req.params.id}.log`)
    res.type('text/plain').send(existsSync(file) ? readFileSync(file, 'utf8') : '')
  })

  app.get('/api/tasks/:id/diff', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const out = t.repos.map((repo) => {
      const repoDir = join(cfg.home, 'work', t.id, repo)
      const baseBranch = cfg.repos[repo]?.defaultBranch ?? 'main'
      const branch = taskBranch(t.id)
      if (!existsSync(repoDir)) {
        return { repo, branch, baseBranch, hasChanges: false, stat: '', patch: '', reviewCommand: '' }
      }
      const st = repoStatus(repoDir, baseBranch)
      const d = st.hasChanges ? diffBranch(repoDir, baseBranch) : { stat: '', patch: '' }
      const reviewCommand = `git -C <your-repo> fetch ${repoDir} ${branch} && git checkout ${branch}`
      return { repo, branch, baseBranch, hasChanges: st.hasChanges, stat: d.stat, patch: d.patch, reviewCommand }
    })
    res.json(out)
  })

  app.post('/api/tasks/:id/push', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { repo, target } = (req.body ?? {}) as { repo?: string; target?: string }
    const norm = targetOrError(cfg, t, repo, target, res)
    if (!norm) return
    const repoDir = join(cfg.home, 'work', t.id, repo as string)
    if (!existsSync(repoDir)) { res.status(400).json({ error: 'no work dir for task' }); return }
    res.json(pushBranch(repoDir, t.id, norm))
  })

  app.post('/api/tasks/:id/pr', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { repo, target } = (req.body ?? {}) as { repo?: string; target?: string }
    const norm = targetOrError(cfg, t, repo, target, res)
    if (!norm) return
    const repoDir = join(cfg.home, 'work', t.id, repo as string)
    if (!existsSync(repoDir)) { res.status(400).json({ error: 'no work dir for task' }); return }
    const pushed = pushBranch(repoDir, t.id, norm)
    if (!pushed.ok) { res.json(pushed); return }
    const base = cfg.repos[repo as string]?.defaultBranch ?? 'main'
    const title = `petree ${t.id}: ${t.prompt.split('\n')[0].slice(0, 72)}`
    res.json(createPullRequest(repoDir, norm, base, title, t.prompt))
  })

  app.post('/api/tasks/:id/resume', (req, res) => {
    const t = store.get(req.params.id)
    if (!t) {
      res.sendStatus(404)
      return
    }
    try {
      res.json(store.transition(t.id, 'queued'))
      void scheduler.tick()
    } catch {
      res.status(409).json({ error: `cannot resume from state ${t.state}` })
    }
  })

  app.post('/api/tasks/:id/stop', async (req, res) => {
    const t = store.get(req.params.id)
    if (!t) {
      res.sendStatus(404)
      return
    }
    // Queued and not yet picked up by the scheduler: no process exists, so cancel
    // it directly rather than going through the launcher.
    if (t.state === 'queued') {
      try {
        res.json(store.transition(t.id, 'cancelled'))
      } catch {
        res.status(409).json({ error: `cannot stop from state ${t.state}` })
      }
      return
    }
    if (t.state !== 'provisioning' && t.state !== 'running') {
      res.status(409).json({ error: `cannot stop from state ${t.state}` })
      return
    }
    const stopped = await launcher.stop(t.id)
    if (!stopped) {
      res.status(409).json({ error: 'task has no active process to stop' })
      return
    }
    res.json(store.get(t.id))
  })

  app.get('/', (_req, res) => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html'), 'utf8')
    res.type('html').send(html)
  })

  // Browser modules the dashboard imports. Allowlisted by name — never a path
  // taken from the request.
  for (const name of ['markdown.js', 'activity.js']) {
    app.get(`/${name}`, (_req, res) => {
      const file = join(dirname(fileURLToPath(import.meta.url)), name)
      res.type('application/javascript').send(readFileSync(file, 'utf8'))
    })
  }

  return app
}
