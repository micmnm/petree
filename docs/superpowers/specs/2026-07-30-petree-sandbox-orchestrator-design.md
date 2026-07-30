# Petree — Local Sandbox Orchestrator for Claude Code

*Design spec — 2026-07-30. Petree: a Petri dish for growing code.*

## 1. Purpose

Run multiple Claude Code tasks in parallel on one Mac, each inside an isolated
Docker sandbox, working on one or more repos via TDD. A local web dashboard
shows progress, surfaces questions, and lets the user approve plans. Tasks run
either unattended or with user checkpoints. All sandboxes share one Claude Max
subscription, one set of skills/settings, and a place to leave findings for
future sandboxes.

Non-goals (for now): automated pushing (push stays manual, from the host),
multi-machine distribution, CI replacement.

## 2. Verified constraints

Checked against current Claude Code / Agent SDK documentation:

- Headless & automated use under a Max subscription is supported
  (`claude -p`, Agent SDK, `claude setup-token`).
- **Container auth**: on macOS, `/login` credentials live in the Keychain —
  mounting `~/.claude` into a Linux container does *not* carry them. The
  supported flow is `claude setup-token` run once on the host, producing a
  one-year OAuth token tied to the Max subscription; the orchestrator passes
  it to every container as `CLAUDE_CODE_OAUTH_TOKEN`. The same token may be
  used by several containers concurrently, needs no interactive login, and
  `claude -p` skips first-run trust dialogs. (`ANTHROPIC_API_KEY` must NOT be
  set — it would bill the API separately instead of using Max. Token has no
  auto-refresh: regenerate before the 1-year expiry.)
- Docker is the officially supported isolation path (Anthropic devcontainer
  feature; `--dangerously-skip-permissions` is sanctioned inside containers
  as non-root).
- The Agent SDK `canUseTool` callback blocks execution until a decision is
  returned — the primitive for remote plan-approval / question checkpoints.
  Hooks (`PreToolUse`, `Stop`, `SessionEnd`) and `--output-format stream-json`
  provide live progress events, including per-message token `usage`.
- **Rate limits are shared account-wide.** Concurrency multiplies usage-window
  burn. Petree therefore runs max **2–3 concurrent tasks** and queues the rest.
- Session transcripts live at `~/.claude/projects/<project>/<session-id>.jsonl`;
  sessions resume via `--resume <session-id>`.

## 3. Architecture

Three units, one narrow interface between them:

```
┌────────────────────── host (Mac) ──────────────────────┐
│  Orchestrator (Node/TS)                                │
│  ├─ SQLite task queue (max 2–3 running)                │
│  ├─ repos.yaml registry                                │
│  ├─ git service (clones with user's creds)             │
│  └─ web dashboard (localhost)                          │
│            │ Runner interface:                         │
│            │ start / events / answer / stop            │
│  ┌─────────┴─────────┐  ┌───────────────────┐          │
│  │ Sandbox (Docker)  │  │ Sandbox (Docker)  │  ...     │
│  │ runner + claude   │  │ runner + claude   │          │
│  │ /work/<repo>…     │  │ /work/<repo>…     │          │
│  └───────────────────┘  └───────────────────┘          │
└────────────────────────────────────────────────────────┘
```

### 3.1 Runner interface (the C→A upgrade path)

The orchestrator only knows four operations: `start(task)`, an outbound event
stream (progress, question, usage, done, error), `answer(questionId, reply)`,
and `stop()`. Two interchangeable implementations:

- **v1 — CLI runner**: `docker exec claude -p --output-format stream-json`,
  parse events, pause/resume with `--resume` when the user answers.
- **v2 — SDK runner**: an Agent SDK process in the container; plan approval
  and clarifying questions become blocking `canUseTool`/hook callbacks.

Start with v1; swap to v2 when stream-parsing shows its limits. Orchestrator
and dashboard are untouched by the swap.

### 3.2 Repo registry — `~/.petree/repos.yaml`

User-level state lives in `~/.petree/` (registry, SQLite db, `shared/`);
the Petree code itself lives in this repo.

```yaml
defaults:
  timeout_minutes: 30
  token_budget: 500000        # per task, resumable
  concurrency: 3

repos:
  druid-connector:
    url: git@github.com:org/Druid.Connector.git
    default_branch: develop
    image: sandbox-dotnet
    setup: ["dotnet restore"]
    test: ["dotnet test"]
    skills: [".claude/skills"]        # repo-local skills, mounted in
  admin-ui:
    url: git@github.com:org/admin-ui.git
    image: sandbox-node
    setup: ["pnpm install"]
    test: ["pnpm test"]

allow_clone:                  # private repos claude may request mid-task
  - git@github.com:org/shared-contracts.git
```

A task names the repos it needs; multi-repo tasks get them cloned side by side
under `/work/<repo>` in one sandbox. New stacks = new image name, no
orchestrator changes.

### 3.3 Sandboxes

One container per task, from per-stack base images (`sandbox-dotnet`,
`sandbox-node` initially).

- **Code**: the *host* clones with the user's git rights and copies into the
  sandbox volume. No git credentials ever enter the container.
- **Public repos**: network policy allows `github.com` HTTPS, so Claude may
  clone public repos directly.
- **Private repos mid-task**: a `sandbox-git clone <name|url>` helper calls the
  orchestrator; if the repo is in `repos:` or `allow_clone:`, the host clones
  and injects it. Otherwise denied.
- **Auth**: `CLAUDE_CODE_OAUTH_TOKEN` env var (from host-side
  `claude setup-token`, stored once in `~/.petree/`, mode 0600). Credentials
  are never in a mounted file; mounts carry config only.
- **Mounts**: skills/settings from `~/.claude` (ro), `shared/skills` (ro),
  `shared/findings` (rw), repo-local skills of the involved repos, plus a
  container-local `CLAUDE_CONFIG_DIR` volume for session state.
- **Network**: default-deny except Anthropic API, package feeds
  (NuGet/npm), `github.com`. Phase 3 widens per task.
- Claude runs with full permissions inside; the container is the boundary.

## 4. Tasks, modes, checkpoints

Task = prompt/spec + repo list + mode + limits. States:
`queued → provisioning → running → waiting-for-you → done | failed`
(plus `paused-rate-limit`, `paused-limit`).

- **Interactive mode**: starts in plan mode; the plan is posted to the
  dashboard and the task blocks until approved/commented (checkpoint 1).
  During execution Claude may raise clarifying questions that pause the task
  the same way (checkpoint 2).
- **Unattended mode**: no checkpoints; runs to completion, ends with tests run
  and a diff summary on the dashboard.
- **TDD** is enforced by the task prompt template plus the repo's `test`
  commands; a task is only `done` when its declared test command passes.
- **Push is always manual**: the user reviews the diff and pushes from the
  host. (A later "approve & push" button would still execute on the host.)

### Limits

- **Timeout**: 30 min default. On expiry the task pauses (session kept) and
  the dashboard asks "continue?" — one click resumes.
- **Token budget**: orchestrator accumulates per-message `usage` from the
  event stream; at the budget it pauses the same way ("resume with another N
  tokens?"). Both limits configurable in `defaults:` and per task.

## 5. Dashboard

Plain local web page, minimal first, enriched later:

- Task list: status badges, repo names, elapsed time, token spend.
- Task detail: live log/transcript stream, current plan, diff summary,
  pending question with reply box.
- "Needs your input" gets a red badge + macOS notification.

## 6. Shared brain

`~/.petree/shared/` mounted into every sandbox:

- `skills/` (ro) — skills available to all sandboxes, now and future.
- `findings/` (rw) — tasks write durable discoveries (build quirks, gotchas,
  skill drafts) here. The user manually promotes drafts into `skills/`, so a
  bad finding never silently poisons future sandboxes.
- Shared `settings.json` / CLAUDE.md fragments travel the same way.

## 7. Error handling

- Container/Claude crash → task `failed`, last 50 log lines surfaced, sandbox
  volume kept for inspection; retry resumes the session by id.
- Rate-limit hit → tasks `paused-rate-limit`, auto-resume when the usage
  window resets.
- Orchestrator restart → state re-read from SQLite; running containers
  re-attached, never orphaned.
- Timeout / token budget → pause + ask, never kill.

## 8. Testing Petree itself

- Queue/state machine: unit tests.
- Runner: integration tests against a fake `claude` binary emitting canned
  stream-json (no Max quota burned).
- One end-to-end smoke test: a trivial TDD task on a tiny fixture repo.

## 9. Build phases

1. **Phase 1**: registry, Docker sandboxes, queue, unattended mode, minimal
   dashboard (list/status/logs). Already useful alone.
2. **Phase 2**: interactive checkpoints (plan approval, questions),
   notifications, shared skills/findings, limits with resume.
3. **Phase 3** (long goal): per-task dev environments — sidecar DB containers
   on the sandbox's compose network, allowed URLs, kubeconfig mounts.
4. **Runner v1→v2**: swap CLI runner for SDK runner when needed; isolated
   behind the runner interface.
