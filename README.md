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

## Phase 1 limitations

- **Resume is partial.** The dashboard's "resume" button and the underlying
  `--resume` flag only fully work for tasks that failed before a Claude
  session started. Once a session exists, resuming won't restore it:
  sandboxes run with `--rm` and no persistent `CLAUDE_CONFIG_DIR` mount, so
  the session transcript is discarded when the container exits. Also,
  resuming a task that was paused for hitting its token budget will
  immediately re-pause (the budget isn't raised on resume). Full resume
  support (persistent config-dir mount, budget top-up) is planned for
  Phase 2.
- **No crash recovery yet.** If the orchestrator process is restarted while
  tasks are running, those tasks stay marked `running`/`provisioning` in
  `~/.petree/petree.db` and permanently consume scheduler concurrency slots
  (there is no startup reconciliation in Phase 1). To recover, stop petree
  and clear or update those rows in the SQLite DB manually before
  restarting. Automatic re-attach/reconciliation is planned for Phase 2.

## Test

    npm test
