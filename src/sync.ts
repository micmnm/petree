import { syncClaudeHome } from './claude-home.js'
import { loadConfig } from './config.js'

// npm run sync [-- --dry-run]: the GAME RULES SYNC button, headless.
const report = syncClaudeHome(loadConfig(), { dryRun: process.argv.includes('--dry-run') })
console.log(report.summary)
for (const k of ['new', 'gone', 'changed'] as const) {
  for (const [kind, ids] of Object.entries(report[k])) if (ids.length) console.log(`  ${k} ${kind}: ${ids.join(', ')}`)
}
if ('error' in report.mcpFile) console.log(`  claude.mcp.json: ${report.mcpFile.error}`)
else if (!report.dryRun) console.log(`  claude.mcp.json: ${report.mcpFile.servers} servers${report.mcpFile.skipped.length ? ` · skipped ${report.mcpFile.skipped.join(', ')}` : ''}`)
