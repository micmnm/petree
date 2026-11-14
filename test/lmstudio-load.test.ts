import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect } from 'vitest'
import { defaultLoadLmStudioModel } from '../src/launcher.js'
import { LM_CONTEXT } from '../src/sandbox.js'

// A fake LM Studio: serves `loaded` from GET /api/v1/models and records every POST.
async function fakeLm(loaded: Array<{ id: string; ctx: number }>, loadStatus = 200) {
  const posts: Array<[string, unknown]> = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET') {
        res.end(JSON.stringify({ models: [{ key: 'm', loaded_instances: loaded.map((i) => ({ id: i.id, config: { context_length: i.ctx } })) }] }))
        return
      }
      posts.push([req.url!, JSON.parse(body)])
      if (req.url!.endsWith('/load') && loadStatus !== 200) {
        res.statusCode = loadStatus
        res.end(JSON.stringify({ error: { message: 'insufficient system resources' } }))
        return
      }
      res.end('{}')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, posts, close: () => srv.close() }
}

describe('defaultLoadLmStudioModel', () => {
  it('reuses the instance named by the key when its context is big enough', async () => {
    const lm = await fakeLm([{ id: 'm', ctx: LM_CONTEXT }])
    try {
      await defaultLoadLmStudioModel(lm.url, 'm')
      expect(lm.posts).toEqual([])
    } finally { lm.close() }
  })

  it('evicts too-small instances of the key, then loads one with enough context', async () => {
    const lm = await fakeLm([{ id: 'm', ctx: 8192 }, { id: 'm:2', ctx: 8192 }])
    try {
      await defaultLoadLmStudioModel(lm.url, 'm')
      expect(lm.posts).toEqual([
        ['/api/v1/models/unload', { instance_id: 'm' }],
        ['/api/v1/models/unload', { instance_id: 'm:2' }],
        ['/api/v1/models/load', { model: 'm', context_length: LM_CONTEXT }],
      ])
    } finally { lm.close() }
  })

  it("surfaces LM Studio's own error message when the load fails", async () => {
    const lm = await fakeLm([], 500)
    try {
      await expect(defaultLoadLmStudioModel(lm.url, 'm')).rejects.toThrow('loading model "m" in LM Studio failed: insufficient system resources')
    } finally { lm.close() }
  })
})
