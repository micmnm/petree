# Petree "Next" — Follow-up Turns on Finished Tasks

**Date:** 2026-08-03
**Status:** Approved

## Goal

Let the user resume a finished task from the dashboard with a follow-up prompt ("next" turn): continue an investigation into an implementation, or adjust an already performed implementation — in the same workspace, on the same branch, with Claude retaining the full conversation of the previous run.

## Verified foundations

- Containers are disposable (`docker run --rm`); nothing is kept "on hold". A fresh container per turn re-mounts the same host work dir. Container startup is ~1s.
- **Cross-container `--resume` works** when the container's `~/.claude` dir is persisted on the host and re-mounted: verified empirically with two separate `--rm` `sandbox-node` containers — the second, with `--resume <sessionId>` and the session dir mounted at `/home/dev/.claude`, recalled conversation content from the first. The transcript lives at `<sessions>/projects/-work/<sessionId>.jsonl` (cwd is always `/work`, so the project key is stable across turns). A missing `~/.claude.json` produces a harmless CLI warning only.
- Today `--resume` is passed (`sandbox.ts`) but the session dir is not mounted, so resume-with-context silently degrades; and `prepareWorkspace` re-clones into the existing `work/<id>/<repo>` dir on requeue, which fails. Both are fixed by this design and repair the existing `paused-limit`/`failed` resume path too.

## Design decisions (agreed)

1. **Fresh container per turn** — no `docker pause`/on-hold container.
2. **Full conversation resume** — persist per-task session state on the host; `--resume <sessionId>` in follow-up runs.
3. **Same task, new turn** — no linked child tasks. The task keeps its id, work dir, `petree/<id>` branch, and sessionId. Prior prompt/result are archived as turn history.
4. **Fresh budget per turn** — `tokensUsed` resets to 0 against the same `tokenBudget`; the timeout already applies per run.

## Components

### Sandbox (`src/sandbox.ts`)

- New mount on every run (first run included): host `join(cfg.home, 'sessions', task.id)` → container `/home/dev/.claude`.
- `--resume <sessionId>` is appended **only when the transcript exists on the host**: `join(cfg.home, 'sessions', task.id, 'projects', '-work', `${task.sessionId}.jsonl`)`. If missing (pre-feature task, wiped dir), the run starts a fresh session instead of crashing.
- The launcher creates the host sessions dir before the run (like it does `logs/`).

### Store (`src/store.ts`)

- New column `turns TEXT` (JSON array, additive `ALTER TABLE` migration like `result`/`model`). Each entry: `{ prompt, result, tokensUsed, endedAt }`.
- `TaskRecord` gains `turns: Turn[]` (default `[]`).
- State machine: `done` gains `['queued']`.
- New method `followUp(id, prompt, model?)`: valid only from `done`/`failed`/`cancelled`. Archives current `{prompt, result, tokensUsed, endedAt: now}` into `turns`, sets `prompt` to the new one (and `model` if given), resets `tokensUsed = 0` and `result = null`, transitions to `queued`. Error/`sessionId` are kept (`sessionId` is what makes resume work).

### Workspace (`src/git.ts`)

- `prepareWorkspace` becomes idempotent: if `join(workDir, name)` already exists, skip clone and branch creation for that repo (the clone is already on `petree/<taskId>` with prior commits). New repos in the list still clone as before.

### API (`src/server.ts`)

- `POST /api/tasks/:id/next` with body `{ prompt, model? }`:
  - 404 unknown id; 400 empty/missing prompt or unknown model; 409 if state is not `done`/`failed`/`cancelled`.
  - Resolves model like task creation (`resolveModel`) when provided; otherwise keeps the task's model.
  - Calls `store.followUp(...)`, then `scheduler.tick()`. Returns the updated task.
- Existing `/resume` unchanged (still re-runs the same prompt after a pause), but now benefits from session persistence and idempotent workspaces.

### Launcher (`src/launcher.ts`)

- Passes the sessions dir into the command build / ensures it exists.
- Post-run commit is unchanged: each turn's changes become an additional commit on `petree/<id>` (message uses the current turn's prompt first line), so a re-push updates an existing PR with all turns' commits.

### Dashboard (`src/dashboard.html`)

- On a task in `done`/`failed`/`cancelled`, the Overview tab shows a **Next prompt** textarea (Cmd/Ctrl+Enter submits) plus a model dropdown defaulting to the task's model, posting to `/api/tasks/:id/next`.
- Turn history: prior turns render collapsed (`<details>` — prompt + result via the existing escape-first `renderMarkdown`) above the current result in the Result tab, so earlier conclusions stay visible. Same safe-sink rules as today.

## Error handling

- Missing session transcript → fresh session (guard in sandbox), never a failed run.
- `followUp` from a wrong state → store throws, server maps to 409.
- Re-queued task with existing work dir → skipped clone (no more re-clone failure).
- Session dir mount failure surfaces as the normal docker/run error path.

## Testing (vitest, existing patterns)

- **store:** `followUp` archives a turn, resets tokens/result, keeps sessionId, transitions `done → queued`; rejects from `running`.
- **sandbox:** command includes the sessions mount; `--resume` present only when the host transcript file exists.
- **git:** `prepareWorkspace` re-entry on an existing work dir clones nothing and preserves the branch/commits.
- **server:** `/next` happy path + 400/404/409 cases.
- **launcher:** two-turn fake-claude flow — second launch reuses the workspace and commits a second commit on the task branch.

## Out of scope

- Multi-repo divergence per turn (repos list is fixed at task creation).
- Turn-level log separation (logs keep appending to the task's single log file).
- Cleaning up sessions/work dirs (no retention policy yet).
