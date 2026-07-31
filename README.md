# 🧫 Petree

Local sandbox orchestrator for Claude Code: queue tasks, run each unattended
in a Docker sandbox, watch progress on a local dashboard.
Spec: docs/superpowers/specs/2026-07-30-petree-sandbox-orchestrator-design.md

## Setup

1. `npm install`
2. Build sandbox images: `./scripts/build-images.sh`
3. Create `~/.petree/repos.yaml` (see the spec, section 3.2)
4. Auth: run `claude setup-token` on the host, save the printed token to
   `~/.petree/token` and `chmod 600 ~/.petree/token`.
   Never put ANTHROPIC_API_KEY in the environment — it would bypass your
   Max subscription and bill the API directly.

## Run

    npm run dev          # dashboard on http://localhost:4100

Create a task from the dashboard (prompt + repo names). Tasks run unattended
inside containers; diffs stay in ~/.petree/work/<task-id>/ for your review.
Pushing is always manual, from the host.

## Test

    npm test
