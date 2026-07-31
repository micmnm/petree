// Emulates `claude -p --output-format stream-json`. First arg picks a scenario.
const mode = process.argv[2] ?? 'ok'
const out = (o) => console.log(JSON.stringify(o))

out({ type: 'system', subtype: 'init', session_id: 'sess-123' })
if (mode !== 'silent') {
  out({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 50 } } })
}

if (mode === 'ok') {
  out({ type: 'result', subtype: 'success', result: 'all tests pass' })
} else if (mode === 'dup-usage') {
  // stream-json repeats the same message (same id, same usage) per content block
  out({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 50 } } })
  out({ type: 'result', subtype: 'success', result: 'all tests pass' })
} else if (mode === 'big-usage') {
  out({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: 900000, output_tokens: 0 } } })
  setTimeout(() => out({ type: 'result', subtype: 'success', result: 'too late' }), 2000)
} else if (mode === 'slow') {
  setTimeout(() => out({ type: 'result', subtype: 'success', result: 'too late' }), 2000)
} else if (mode === 'crash') {
  process.exit(3)
} else if (mode === 'two-results') {
  // multi-turn / subagent run: an intermediate result, more work, then the final result
  out({ type: 'result', subtype: 'success', result: 'intermediate: launched exploration' })
  out({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: 40, output_tokens: 20 } } })
  out({ type: 'result', subtype: 'success', result: 'final answer' })
} else if (mode === 'silent') {
  // Exits 0 without ever emitting a done/error result line.
}
