# 🧫 Petree

Local sandbox orchestrator for Claude Code: queue tasks, run each unattended
in a Docker sandbox, watch progress on a local dashboard. One Claude Max/Pro
subscription and one repo registry are shared across every sandbox; pushing
is always manual, from the host.

Design spec: [`docs/superpowers/specs/2026-07-30-petree-sandbox-orchestrator-design.md`](docs/superpowers/specs/2026-07-30-petree-sandbox-orchestrator-design.md).
This is a personal tool (Phase 1 of the design above) rather than a maintained
product — see [Current limitations](#current-limitations) before relying on it.

## Prerequisites

- Node 22 (see `.nvmrc`) — `nvm use`
- Docker (Engine or Desktop), running
- `git`
- A Claude Max or Pro subscription, for `claude setup-token`
- (Optional) [GitHub CLI](https://cli.github.com) (`gh`), authenticated, if you
  want the dashboard's "Create PR" button

## Setup

1. `git clone https://github.com/micmnm/petree.git && cd petree && npm install`
2. Build sandbox images: `./scripts/build-images.sh` (builds `sandbox-node`
   and `sandbox-dotnet` from `images/*.Dockerfile`)
3. Create `~/.petree/repos.yaml` (see the spec, section 3.2, and
   [Per-repo settings](#per-repo-settings) below)
4. Auth: run `claude setup-token` on the host, save the printed token to
   `~/.petree/token` and `chmod 600 ~/.petree/token`.
   Never put `ANTHROPIC_API_KEY` in the environment — it would bypass your
   Max subscription and bill the API directly. The token is valid for one
   year with no auto-refresh; regenerate it before it expires.
5. (Optional) install and authenticate the [GitHub CLI](https://cli.github.com)
   (`gh auth login`) on the host to enable the "Create PR" button on a task's
   Result tab. Without it, you can still push branches and open PRs manually.

## Run

    npm run dev          # dashboard on http://localhost:4100

Create a task from the dashboard (prompt + repo names). Tasks run unattended
inside containers; diffs stay in `~/.petree/work/<task-id>/` for your review.
Pushing is always manual, from the host.

## Per-repo settings

`~/.petree/repos.yaml` carries standing instructions per repo. Petree appends
them to the prompt of every task touching that repo, so you don't retype
"run the tests" each time:

```yaml
defaults:
  instructions: |          # applied to every task, whatever its repos
    Write a failing test first, then make it pass.

repos:
  admin-ui:
    url: git@github.com:org/admin-ui.git
    image: sandbox-node
    instructions: |        # applied to tasks touching this repo
      Never edit src/generated/ — it is codegen output.
      Keep public component props backwards compatible.
    setup: ["pnpm install"]         # run before making changes
    build: ["pnpm build"]           # must pass before reporting success
    test: ["pnpm test", "pnpm typecheck"]
```

All four keys are optional; a command list may also be a bare string
(`test: pnpm test`). Repos with none of them behave exactly as before — the
prompt is passed through untouched.

The composed prompt is built at launch, not at task creation, so editing
`repos.yaml` also affects re-runs and resumes of existing tasks. The dashboard's
create form shows the conventions attached to the repos you select.

**These are prompt-level constraints, not a host-side gate.** When `build`/`test`
commands are configured, the prompt tells the agent it must run them and must not
report success on a failure — but petree does not itself re-run them after the
container exits. Check the Result and Log tabs before pushing.

The **Log** tab summarizes the run instead of dumping stream-json: what the
agent is doing now, its todo list, turn/tool/file/error counts, token budget
use, and a timeline of tool calls (click one for its input and output). Switch
to **Raw** for the unprocessed log.

## Security model

Petree gives an agent broad, largely unsupervised power (Docker, your git
remotes, your Claude subscription), so it's worth being explicit about the
trust boundaries:

- **The dashboard has no authentication** and binds to `127.0.0.1` only
  (`src/index.ts`) — by design, not by omission. Do not put it behind a
  reverse proxy or tunnel that exposes it beyond localhost without adding
  your own auth in front of it; anyone who can reach the port can create,
  inspect, push, and open PRs for tasks.
- **Git and GitHub credentials never enter the container.** Cloning,
  committing, pushing, and `gh pr create` all run on the host
  (`src/git.ts`, `src/gitops.ts`); the sandbox only ever receives the
  `CLAUDE_CODE_OAUTH_TOKEN` (mode 0600 file on the host, passed as an env
  var). Push output is scrubbed of embedded URLs/credentials before it
  reaches the API/dashboard.
- **Inside the container, Claude runs with `--dangerously-skip-permissions`.**
  The container — not the permission system — is the security boundary, so
  only run task prompts you'd trust to execute arbitrary commands as a
  non-root user inside that container.
- **Containers are not network-isolated.** There is currently no egress
  allowlist — a container can reach the open internet, not just
  `github.com`/package registries. (The original design doc aspired to
  default-deny egress; that was explicitly deferred to a future phase and is
  not implemented today. Don't assume it's contained.)
- Branch names accepted by `/push` and `/pr` are validated against
  refspec/`HEAD`/protected-branch tricks (`src/server.ts`), and task IDs are
  validated before touching the filesystem — but this has not had an
  independent security review. Treat it as a personal/local tool, not a
  multi-tenant service.

## Architecture

```
┌────────────────────── host ──────────────────────┐
│  Orchestrator (Node/TS)                          │
│  ├─ SQLite task queue (~/.petree/petree.db)       │
│  ├─ repos.yaml registry                           │
│  ├─ git/gh service (host-side credentials)        │
│  └─ web dashboard (127.0.0.1 only)                │
│  ┌───────────────────┐  ┌───────────────────┐     │
│  │ Sandbox (Docker)  │  │ Sandbox (Docker)  │ ... │
│  │ claude -p ...      │  │ claude -p ...     │     │
│  │ /work/<repo>       │  │ /work/<repo>      │     │
│  └───────────────────┘  └───────────────────┘     │
└────────────────────────────────────────────────────┘
```

One detached container per running task. Each mounts the cloned repo(s), a
read-only shared `skills/` dir, a read-write shared `findings/` dir, and a
per-task session dir (so `--resume` carries conversation context across
container restarts). See the design spec for the full rationale.

## Current limitations

- **Unattended only.** There are no interactive checkpoints yet (plan
  approval, clarifying questions mid-task) — that's a later phase in the
  design spec. Every task runs to completion, a pause, or a failure with no
  chance to intervene mid-run beyond Stop.
- **Resuming a paused-on-budget task doesn't raise the budget.** `/resume`
  re-runs the same task with the same `tokenBudget`; if it paused because it
  hit the budget, it will immediately re-pause unless you also adjust
  `tokenBudget` (currently only settable via `repos.yaml` defaults, not
  per-task in the dashboard).
- **No per-task network egress control.** See [Security model](#security-model).
- **No cleanup/retention policy yet** for `~/.petree/work/<task-id>/` or
  `~/.petree/sessions/<task-id>/` — old task workspaces and sessions
  accumulate on disk until you remove them by hand.

## Test

    npm test          # vitest
    npm run typecheck # tsc --noEmit

## License

No license file is included yet — add one (e.g. MIT) before treating this
repo as open source; without it, default copyright applies and others have
no legal right to use, modify, or redistribute the code.
