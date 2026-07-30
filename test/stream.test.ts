import { describe, it, expect } from 'vitest'
import { parseStreamLine } from '../src/stream.js'

describe('parseStreamLine', () => {
  it('extracts session id from the init message', () => {
    const events = parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }))
    expect(events).toContainEqual({ type: 'session', sessionId: 's-1' })
  })

  it('extracts usage from assistant messages', () => {
    const line = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } })
    expect(parseStreamLine(line)).toContainEqual({ type: 'usage', tokens: 150 })
  })

  it('emits done for the result message without counting its cumulative usage', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 999, output_tokens: 999 } })
    const events = parseStreamLine(line)
    expect(events).toContainEqual({ type: 'done', result: 'ok' })
    expect(events.filter((e) => e.type === 'usage')).toEqual([])
  })

  it('treats non-JSON lines as plain logs', () => {
    expect(parseStreamLine('warming up...')).toEqual([{ type: 'log', line: 'warming up...' }])
  })

  it('treats non-object JSON lines (null, numbers, strings) as plain logs', () => {
    expect(parseStreamLine('null')).toEqual([{ type: 'log', line: 'null' }])
    expect(parseStreamLine('42')).toEqual([{ type: 'log', line: '42' }])
    expect(parseStreamLine('"hi"')).toEqual([{ type: 'log', line: '"hi"' }])
  })
})
