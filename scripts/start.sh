#!/usr/bin/env bash
# Start the petree dashboard, offering to pull the latest changes first.
# Usage: ./scripts/start.sh [--pull|--no-pull]   (no flag: ask, default yes)
set -euo pipefail
cd "$(dirname "$0")/.."

PULL=ask
for arg in "$@"; do
  case "$arg" in
    --pull) PULL=yes ;;
    --no-pull) PULL=no ;;
    *) echo "unknown option: $arg (supported: --pull, --no-pull)" >&2; exit 1 ;;
  esac
done

if [ "$PULL" = ask ]; then
  if [ -t 0 ]; then
    read -r -p "Pull latest before starting? [Y/n] " answer
    case "$answer" in
      [nN]*) PULL=no ;;
      *) PULL=yes ;;
    esac
  else
    PULL=yes   # non-interactive: keep the pull-by-default behavior
  fi
fi

if [ "$PULL" = yes ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "warning: working tree has local changes; pulling with --ff-only anyway" >&2
  fi
  if ! git pull --ff-only; then
    echo "" >&2
    echo "error: could not pull latest (see git output above)." >&2
    echo "Common causes: no network, diverged branch, or local conflicts." >&2
    echo "Fix the git issue, or start without updating: ./scripts/start.sh --no-pull" >&2
    exit 1
  fi
fi

# better-sqlite3's native module requires Node 22 (see .nvmrc)
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm install >/dev/null   # installs/uses the .nvmrc version
  nvm use >/dev/null
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" != "22" ]; then
  echo "error: Node 22 required (found $(node -v)); run 'nvm use' or install Node 22" >&2
  exit 1
fi

npm install
exec npm run dev
