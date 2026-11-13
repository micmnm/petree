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
5. Copy agent skills into `~/.petree/shared/skills/`:
   `cp -R ~/.claude/plugins/cache/addy-agent-skills/agent-skills/<version>/skills/* ~/.petree/shared/skills/`
   — copy, not symlink (a symlink would dangle inside the container).
6. (Optional) install and authenticate the [GitHub CLI](https://cli.github.com)
   (`gh auth login`) on the host to enable the "Create PR" button on a task's
   Result tab. Without it, you can still push branches and open PRs manually.

## Run locally

The quickest way, after the one-time [Setup](#setup) above:

    ./scripts/start.sh

The script asks whether to pull the latest changes first (default yes,
fast-forward only; if the pull fails — no network, diverged branch, local
conflicts — it reports the git error and stops instead of starting on an
unknown state). It then switches to Node 26 via nvm if you have it, installs
dependencies, and starts the dashboard on http://localhost:4100.
Pass `--pull` or `--no-pull` to skip the question (e.g. `--no-pull` while
working on local changes; when run non-interactively it pulls by default).

Or run the steps by hand:

    nvm use              # Node 26 — see .nvmrc
    npm install
    npm run dev          # dashboard on http://localhost:4100

Create a task from the dashboard (prompt + repo names). Tasks run unattended
inside containers; diffs stay in ~/.petree/work/<task-id>/ for your review.
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
    run: ["pnpm dev"]               # shown in the dashboard's Local panel; never run or sent to the agent
    tags: [work]                    # badge + filter chip in the dashboard's repo picker; never sent to the agent
```

Per-repo notes live in `~/.petree/notes/<repo>/` (an `INDEX.md` plus topic
files); they are mounted read-only into every sandbox at `/petree/notes`.
A thread touching repos with different images (node + dotnet) runs in the
`sandbox-full` image (the dotnet image, which also carries Node 26 and claude).

All six keys are optional; a command list or `tags` may also be a bare string
(`test: pnpm test`, `tags: work`). Repos with none of them behave exactly as before — the
prompt is passed through untouched.

`repos.yaml` is parsed as YAML 1.2, with anchors and `<<:` merge keys supported so
repos can share settings. An empty or fully commented-out file is valid and simply
configures no repos. Two YAML 1.1 spellings are no longer understood: binary
integers (`0b1010`), and explicit legacy tags such as `!!set` or `!!timestamp`,
which now fail with `unknown mapping tag` rather than being silently accepted.

Write numbers as plain digits: `token_budget: 500_000` parses as the *string*
`"500_000"`, not a number, which leaves the budget `NaN` and makes task creation
fail. (Same for any non-numeric value, e.g. `concurrency: three`.)

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

    ./scripts/test.sh    # switches to the .nvmrc Node, then runs vitest

`npm test` works too, and no longer has to be run on the pinned Node:
better-sqlite3 ships a prebuilt binary per platform rather than per Node ABI,
so the SQLite store loads on any Node the dev dependencies support (vitest
wants 22.12+, 24, or 26+). The dashboard itself still targets the `.nvmrc` Node.
