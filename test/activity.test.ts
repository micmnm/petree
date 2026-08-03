import { describe, it, expect } from 'vitest'
import { summarizeLog, renderActivity, MAX_ENTRIES } from '../src/activity.js'

const j = (o: unknown) => JSON.stringify(o)

const assistant = (id: string, content: unknown[], usage?: { input_tokens: number; output_tokens: number }) =>
  j({ type: 'assistant', message: { id, content, ...(usage ? { usage } : {}) } })

const toolResult = (id: string, content: string, isError = false) =>
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })

const RUN = [
  j({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5', tools: ['Bash', 'Read'], cwd: '/work' }),
  assistant('m1', [{ type: 'text', text: 'Looking at the failing test first.' }], { input_tokens: 100, output_tokens: 50 }),
  assistant('m2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'run tests' } }], { input_tokens: 20, output_tokens: 10 }),
  toolResult('t1', '2 failed, 8 passed'),
  assistant('m3', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/work/petree/src/store.ts' } }]),
  toolResult('t2', 'ok'),
  j({ type: 'result', subtype: 'success', result: 'Fixed the store bug.', duration_ms: 92_000, num_turns: 7, total_cost_usd: 0.42 }),
].join('\n')

describe('summarizeLog', () => {
  it('builds a timeline of turns, tool calls and the result', () => {
    const { entries, stats } = summarizeLog(RUN)
    expect(entries.map((e) => e.kind)).toEqual(['init', 'text', 'tool', 'tool', 'result'])
    expect(stats.sessionId).toBe('sess-1')
    expect(stats.model).toBe('claude-opus-5')
    expect(stats.toolCalls).toBe(2)
    expect(stats.toolCounts).toEqual({ Bash: 1, Edit: 1 })
    expect(stats.commands).toBe(1)
    expect(stats.files).toEqual(['…/src/store.ts'])
    expect(stats.durationMs).toBe(92_000)
    expect(stats.numTurns).toBe(7)
    expect(stats.finished).toEqual({ ok: true, text: 'Fixed the store bug.' })
  })

  it('summarizes each tool call in one human-readable line', () => {
    const { entries } = summarizeLog(RUN)
    const tools = entries.filter((e) => e.kind === 'tool')
    expect(tools[0].name).toBe('Bash')
    expect(tools[0].summary).toBe('npm test')
    expect(tools[1].summary).toBe('…/src/store.ts')
  })

  it('attaches tool results to their call, flagging failures', () => {
    const { entries, stats } = summarizeLog([
      assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls /nope' } }]),
      toolResult('t1', 'No such file or directory', true),
    ].join('\n'))
    expect(entries).toHaveLength(1)
    expect(entries[0].ok).toBe(false)
    expect(entries[0].output).toContain('No such file')
    expect(stats.errors).toBe(1)
  })

  it('counts usage and renders content once per message, not once per block', () => {
    // stream-json repeats a message (same id) once per content block
    const blocks = [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b/c.ts' } }]
    const { entries, stats } = summarizeLog([
      assistant('m1', [blocks[0]], { input_tokens: 100, output_tokens: 50 }),
      assistant('m1', blocks, { input_tokens: 100, output_tokens: 50 }),
    ].join('\n'))
    expect(entries.map((e) => e.kind)).toEqual(['text', 'tool'])
    expect(stats.turns).toBe(1)
    expect(stats.tokens).toBe(150)
  })

  it('tracks the latest todo list as the plan', () => {
    const { stats } = summarizeLog([
      assistant('m1', [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'in_progress' }] } }]),
      assistant('m2', [{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] } }]),
    ].join('\n'))
    expect(stats.todos).toHaveLength(2)
    expect(stats.todos[0].status).toBe('completed')
  })

  it('keeps non-JSON lines (stderr) as raw entries', () => {
    const { entries, stats } = summarizeLog('docker: pulling image\n')
    expect(entries).toEqual([expect.objectContaining({ kind: 'raw', summary: 'docker: pulling image' })])
    expect(stats.noise).toBe(1)
  })

  it('records an error result as a failure', () => {
    const { stats, entries } = summarizeLog(j({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }))
    expect(stats.errors).toBe(1)
    expect(stats.finished).toEqual({ ok: false, text: 'boom' })
    expect(entries[0].kind).toBe('error')
  })

  it('caps the timeline at the most recent events and reports what it dropped', () => {
    const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => assistant(`m${i}`, [{ type: 'text', text: `step ${i}` }])).join('\n')
    const { entries, hidden, total } = summarizeLog(many)
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(total).toBe(MAX_ENTRIES + 5)
    expect(hidden).toBe(5)
    expect(entries[entries.length - 1].summary).toBe(`step ${MAX_ENTRIES + 4}`)
  })

  it('survives a truncated final line (log read mid-write)', () => {
    const { entries, stats } = summarizeLog(RUN + '\n{"type":"assist')
    expect(stats.noise).toBe(1)
    expect(entries[entries.length - 1].kind).toBe('raw')
  })
})

describe('renderActivity', () => {
  it('escapes container-sourced text (no injection)', () => {
    const html = renderActivity([
      assistant('m1', [{ type: 'text', text: '<img src=x onerror=alert(1)>' }]),
      assistant('m2', [{ type: 'tool_use', id: 't1', name: '<script>', input: { command: '<i>x</i>' } }]),
      'plain <i>stderr</i> line',
    ].join('\n'))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<i>')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;i&gt;stderr')
  })

  it('shows progress stats and the current activity', () => {
    const html = renderActivity(RUN, { state: 'done', tokensUsed: 180, tokenBudget: 1000 })
    expect(html).toContain('tool calls')
    expect(html).toContain('finished')
    expect(html).toContain('Fixed the store bug.')
    expect(html).toContain('1m 32s')
  })

  it('meters the token budget with an escalating severity level', () => {
    expect(renderActivity(RUN, { tokensUsed: 100, tokenBudget: 1000 })).toContain('meter-fill ok')
    expect(renderActivity(RUN, { tokensUsed: 750, tokenBudget: 1000 })).toContain('meter-fill warn')
    const hot = renderActivity(RUN, { tokensUsed: 950, tokenBudget: 1000 })
    expect(hot).toContain('meter-fill critical')
    expect(hot).toContain('near budget') // severity is stated, never color alone
  })

  it('marks a live task and names what it is doing now', () => {
    const html = renderActivity(RUN.split('\n').slice(0, 3).join('\n'), { state: 'running' })
    expect(html).toContain('class="now live') // the live class drives the pulse dot
    expect(html).toContain('Bash')
  })

  it('stops pulsing once the log carries a result, even if the row still says running', () => {
    // the store only marks the task terminal after the container exits
    const html = renderActivity(RUN, { state: 'running' })
    expect(html).not.toContain('now live')
    expect(html).toContain('finished')
  })

  it('shows the plan once — in the header, not repeated per TodoWrite call', () => {
    const html = renderActivity(
      assistant('m1', [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'ship it', status: 'pending' }] } }]),
    )
    expect(html.match(/class="plan"/g)).toHaveLength(1)
    expect(html).toContain('1 steps done') // the call itself still reports progress
  })

  it('renders the plan with per-step status words', () => {
    const html = renderActivity(
      assistant('m1', [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'write tests', status: 'in_progress', activeForm: 'Writing tests' } ] } }]),
    )
    expect(html).toContain('Writing tests')
    expect(html).toContain('doing')
  })

  it('falls back to a placeholder for an empty log', () => {
    expect(renderActivity('')).toContain('No log output yet')
  })
})
