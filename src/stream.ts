export type RunnerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'log'; line: string }
  | { type: 'usage'; tokens: number; messageId: string | null }
  | { type: 'done'; result: string }
  | { type: 'limit'; reason: 'timeout' | 'token-budget' }
  | { type: 'error'; message: string }

export function parseStreamLine(line: string): RunnerEvent[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return [{ type: 'log', line }]
  }
  if (msg === null || typeof msg !== 'object') return [{ type: 'log', line }]
  const events: RunnerEvent[] = [{ type: 'log', line }]
  if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
    events.push({ type: 'session', sessionId: msg.session_id })
  }
  if (msg.type === 'assistant' && msg.message?.usage) {
    const u = msg.message.usage
    events.push({ type: 'usage', tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0), messageId: msg.message.id ?? null })
  }
  if (msg.type === 'result') {
    // is_error can arrive with subtype 'success' (subtype is the result
    // category, not a pass/fail flag) — prefer the human-readable result text
    if (msg.is_error) events.push({ type: 'error', message: String(msg.result ?? msg.subtype ?? 'error') })
    else events.push({ type: 'done', result: msg.result ?? '' })
  }
  return events
}
