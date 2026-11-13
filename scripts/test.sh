#!/usr/bin/env bash
# Run the test suite on the .nvmrc Node (better-sqlite3's native module needs it).
# Usage: ./scripts/test.sh [vitest args...]
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use >/dev/null
fi

# .claude/worktrees holds agent checkouts whose tests would run twice.
exec npx vitest run --exclude '.claude/**' --exclude '**/node_modules/**' "$@"
