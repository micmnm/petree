import { describe, it, expect } from 'vitest'
import { parseStreamLine } from '../src/stream.js'

describe('parseStreamLine', () => {
  it('extracts session id from the init message', () => {
    const events = parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }))
    expect(events).toContainEqual({ type: 'session', sessionId: 's-1' })
  })

  it('extracts usage from assistant messages', () => {
    const line = JSON.stringify({ type: 'assistant', message: { id: 'msg-1', usage: { input_tokens: 100, output_tokens: 50 } } })
    expect(parseStreamLine(line)).toContainEqual({ type: 'usage', tokens: 150, messageId: 'msg-1' })
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

  it('emits error (not done) for error results', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })
    const events = parseStreamLine(line)
    expect(events).toContainEqual({ type: 'error', message: 'error_during_execution' })
    expect(events.filter((e) => e.type === 'done')).toEqual([])
  })

  it('always yields the raw log event first', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' })
    expect(parseStreamLine(line)).toEqual([{ type: 'log', line }, { type: 'session', sessionId: 's-1' }])
  })

  it('uses the result text for is_error results even when subtype is "success"', () => {
    // the real CLI reports auth failures as { is_error: true, subtype: 'success', result: '<message>' }
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid bearer token' })
    const events = parseStreamLine(line)
    expect(events).toContainEqual({ type: 'error', message: 'Failed to authenticate. API Error: 401 Invalid bearer token' })
    expect(events.filter((e) => e.type === 'done')).toEqual([])
  })
})
