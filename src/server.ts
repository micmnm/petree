import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { resolveModel } from './config.js'
import type { PetreeConfig } from './config.js'
import type { Scheduler } from './scheduler.js'
import type { TaskStore } from './store.js'

export const MODELS = ['default', 'haiku', 'sonnet', 'opus']

export function makeApp(cfg: PetreeConfig, store: TaskStore, scheduler: Scheduler): express.Express {
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

  app.get('/', (_req, res) => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html'), 'utf8')
    res.type('html').send(html)
  })

  return app
}
