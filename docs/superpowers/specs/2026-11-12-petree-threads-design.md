# Petree Threads — Follow an Idea from Investigation to Branches

**Date:** 2026-11-12
**Status:** Approved

## 1. Intent

Petree today runs *tasks*: a prompt goes in, a run comes out, follow-up turns
continue it. The user works on many ideas at once across work and personal
repos, and the link between "that investigation", "the spec it became" and "the
build that implemented it" lives only in their head. Verifying a bigger
multi-repo change means setting everything up locally by hand.

Petree should let the user **follow a thread**: one idea that moves
investigation → spec → build across one or more repos, stopping where the user
must decide, collecting the user's comments for the next turn, and ending in a
folder with every touched repo on its branch — ready to inspect, run, or push.

## 2. Goals

1. A thread has a visible **stage** (investigate, spec, build) and stops at two
   gates: after an investigation turn and after a spec turn.
2. The thread list shows which threads **need the user**, at the top.
3. The user can leave **comments** on a thread at any time (also while it runs);
   unconsumed comments go into the next turn's prompt. A comment never starts a
   run by itself.
4. One **lead agent per thread** sees all of the thread's repos, may use Claude
   Code subagents for parallel work, and runs each repo's build/test commands.
5. A finished thread offers two ways to verify:
   - **Push** — push branch / create PR per repo (exists today).
   - **Local** — the thread's folder on disk (full git history, every repo on its
     branch) plus each repo's `run:` commands, shown with a copy-path button.
6. agent-skills skills are available inside the sandbox (spec stage uses
   `spec-driven-development`).
7. **Per-repo notes** on the petree machine: read by the agent, changed only by
   the user accepting the agent's suggestions.

## 3. Non-goals (now)

- Evidence (agent-attached screenshots / proof) — keep the design open to it.
- Starting threads from a local Claude Code session (threads start in the dashboard).
- Notes committed into repos.
- Petree starting servers for the user (it only shows `run:` commands).
- Several agents working in the same repo at once as separate petree tasks.
- Memory database / vector store.
- OS / push notifications.
- PR status tracking, work-dir cleanup, polish of existing screens.

**Anti-goals:** a notes store the agent can rewrite unreviewed; a comment that
silently launches a run; a stage that advances without the user acting at a gate.

## 4. Constraints

- One Max subscription, existing concurrency cap (default 3).
- Pushing stays manual (host-side, as today).
- Reuse what exists: task/turn model, `waiting-for-you` state, per-task work
  and session dirs, `repos.yaml`, dashboard tabs. Shortest diff that works.
- `claude -p` is non-interactive: skills that normally ask the user questions
  must end the turn with their open questions instead.

## 5. Design

### 5.1 Thread = task with a stage *(design call: keep the code name `task`)*

A thread is today's task. The UI says "thread"; code, table and routes keep
`task` to avoid a rename across the codebase. Already in place: one workspace
(`~/.petree/work/<id>/`), one branch per repo (`petree/<id>`), one Claude
session resumed across turns, turn history.

New store fields (additive `ALTER TABLE` migrations, same pattern as `turns`):

| field | type | meaning |
|---|---|---|
| `stage` | `'investigate' \| 'spec' \| 'build'` | current stage; set at creation |
| `comments` | JSON `[{ text, at, consumed }]` | user comments; `consumed` set when folded into a turn |

`Turn` gains `stage` so history shows which stage each turn ran in. Existing
rows migrate to `stage = 'build'` (they behave exactly as today).

**Thread title** *(design call)*: commit messages, PR title/body and the list
label use the thread's *first* prompt (`turns[0].prompt`, or `prompt` when there
are no turns yet), not the current turn's prompt, which may be empty on approve.

### 5.2 Stages and gates

Creation picks the **starting stage** (default `investigate`). Small changes
start at `build` — which is today's task behaviour — so nothing is lost.

```
investigate ──turn ends──▶ waiting-for-you ──▶ more investigation (same stage)
                                            ├─▶ approve → spec
                                            ├─▶ approve → build (skip spec)
                                            └─▶ drop    → cancelled
spec ───────turn ends──▶ waiting-for-you ──▶ revise spec (same stage)
                                            ├─▶ approve → build
                                            └─▶ drop    → cancelled
build ──────turn ends──▶ done   (follow-up turns still allowed, as today)
```

State machine changes (`src/store.ts`):

- On a `done` stream event the launcher transitions to `waiting-for-you` when
  `stage` is `investigate` or `spec`, else `done`. (`running → waiting-for-you`
  is already legal.)
- Add `waiting-for-you → cancelled` (drop).
- Add `waiting-for-you` to `FOLLOWUP_STATES`.
- **Remove** `waiting-for-you` from `RESUMABLE_STATES` and the dashboard's resume
  button list (`dashboard.html:370`): a gate is left only by continue/approve/drop,
  never by re-running the same prompt.

`followUp(id, prompt, model?, stage?)` gains an optional `stage`; it archives
the turn (with its stage) and sets the new stage if given.

**Comments are snapshotted at `/next`** *(design call)*: `followUp` appends the
pending comments to the stored `prompt` (under a "Comments from the user since
the last turn" heading) and marks them consumed, in one transaction. The stored
prompt is then the single source for launch, `/resume` and recovery, so a
retried or reattached run sees the same comments exactly once. Comments added
after `/next` (including while the turn runs) wait for the following turn.

**Allowed stage changes** — enforced by the server (400 otherwise), not just the UI:

| from state | allowed `stage` on `/next` |
|---|---|
| `waiting-for-you` | same stage, or any later stage (investigate → spec or build; spec → build) |
| `done` / `failed` / `cancelled` | same stage, or any earlier stage (e.g. back to `spec` to revise) |

Forward moves happen only from `waiting-for-you`, i.e. only by the user acting
at a gate.

**Drop** *(design call)*: `cancelled` from a gate is not final — the thread can be
continued via `/next` (same stage or earlier), which ends at the gate again. A
`/resume` of a cancelled thread re-runs its current stage, so it also ends at
the gate: stage only ever advances through `/next`, which is the gate.

**Repo changes outside build** *(design call)*: the launcher keeps committing
whatever changed after every turn (nothing is lost); the thread page flags an
investigate/spec turn that produced commits ("this turn changed repo files").

### 5.3 Prompt composition (`src/prompt.ts`)

`composePrompt` builds the following sections. *(Plan call: the stored prompt
goes first, as today, then the stage instructions; the numbering below is
content, not order.)*

1. **Stage instructions** (fixed text per stage):
   - *investigate*: explore, don't modify repo files; end with findings, open
     questions, and a recommendation (worth a spec or not). Write findings to
     `/work/_thread/findings.md`.
   - *spec*: use the `spec-driven-development` skill; write the spec to
     `/work/_thread/spec.md` (not into a repo — it may span several); don't wait
     for answers — list open questions at the end of the spec and the message.
   - *build*: implement `/work/_thread/spec.md` when it exists (else the prompt
     plus `findings.md`). Maximise parallelism: first break the work down with
     `planning-and-task-breakdown` into tasks marked independent or dependent;
     dispatch every independent task to its own subagent **in parallel** (one
     message, several Agent calls — typically one per repo or per independent
     slice), each told to follow `incremental-implementation` and
     `test-driven-development`; run dependent tasks after their prerequisites;
     the lead agent integrates, then runs every Build/Tests command and fixes
     failures. Optionally a final `code-review-and-quality` pass by a subagent.
2. The stored **prompt** (user-typed text plus the comments snapshotted at
   `/next`, see 5.2; the typed part may be empty on approve).
3. **Notes and repo docs**: "For each repo, read `/petree/notes/<repo>/INDEX.md`
   if present and open a note only when relevant; read `/work/<repo>/CLAUDE.md`
   if present." (cwd is `/work`, so nested repo CLAUDE.md files are otherwise
   loaded only lazily.)
4. **Note suggestions** (every stage): "If you learned something non-obvious
   about a repo that code and tests don't show (how to run it, gotchas, why
   something is odd), write it as a short file in
   `/work/_thread/notes/<repo>/<topic>.md`. Never write anything else there."
5. Existing **repo conventions** block, unchanged.

`/work/_thread/` sits in the workspace root, which is not a git repo, so it is
never committed or pushed.

### 5.4 Sandbox (`src/sandbox.ts`, `images/`)

- **Skills**: change the existing `shared/skills` mount target from
  `/petree/skills` to `/home/dev/.claude/skills:ro` (nested inside the
  per-task `/home/dev/.claude` mount — Docker supports this). Populate
  `~/.petree/shared/skills/` by copying skill folders (copy, not symlink — host
  symlinks don't resolve in the container). A README step documents
  `cp -R ~/.claude/plugins/cache/addy-agent-skills/agent-skills/<ver>/skills/* ~/.petree/shared/skills/`.
- **Notes**: new mount `~/.petree/notes` → `/petree/notes:ro`.
- **Findings mount** (`/petree/findings`) is superseded by `/work/_thread/`;
  remove it and the `shared/findings` dir creation in `index.ts`.
- **Image**: add `images/full.Dockerfile` (Node 22 + .NET 8 SDK + claude-code),
  built by `scripts/build-images.sh` as `sandbox-full`. Image selection: if all
  of the thread's repos declare the same `image`, use it; otherwise
  `sandbox-full`. Existing single-image configs keep working. *(Design call:)*
  mixed images are allowed only when each is `sandbox-node` or
  `sandbox-dotnet`; any other mix is rejected at creation with a 400 naming the
  repos and images, instead of silently running without a toolchain.

### 5.5 Workspace (`src/git.ts`)

- Clone with full history (drop `--depth 1`) so the Local folder supports
  `git log`/diff against main. *(Partial clone `--filter=blob:none` was rejected:
  the sandbox has no git credentials to fetch missing blobs.)*
- Existing behaviour stays: clone reused across turns; nothing deletes work dirs.

### 5.6 Notes (`~/.petree/notes/<repo>/`)

```
~/.petree/notes/<repo>/
  INDEX.md        # one line per note: "- [run-locally](run-locally.md) — needs postgres + .env"
  run-locally.md
  auth-gotchas.md
```

Suggestions live in `~/.petree/work/<id>/_thread/notes/<repo>/*.md`. The thread
page lists them; per suggestion the user can **accept** (optionally editing the
text and the one-line index description first) or **drop**:

- accept → write `~/.petree/notes/<repo>/<topic>.md` and append/replace its line
  in `INDEX.md`; delete the suggestion file.
- drop → delete the suggestion file.

Topic names are validated as plain slugs (`^[a-z0-9-]+$`); repo must be one of
the thread's repos. Name clash with an existing note → accept overwrites after
an explicit confirm in the UI.

### 5.7 `repos.yaml`

- New optional per-repo key `run:` (string or list, same parsing as
  `setup`/`build`/`test`). Shown on the thread page, never executed. Not added
  to the prompt.
- The parsed-but-unused `skills:` key stays untouched (out of scope).

### 5.8 API (`src/server.ts`) *(shape is the builder's call; behaviour is fixed)*

- `POST /api/tasks` accepts optional `stage` (default `investigate`; validated).
- `POST /api/tasks/:id/comments` `{ text }` — allowed in any non-pruned state;
  never transitions state.
- `POST /api/tasks/:id/next` accepts optional `stage`; allowed from
  `waiting-for-you` too. Prompt may be empty when `stage` advances or pending
  comments exist; otherwise 400 as today.
- Drop: `POST /api/tasks/:id/stop` also accepts `waiting-for-you` → `cancelled`.
- `GET /api/tasks/:id/notes` → suggestions `[{ repo, topic, text }]`;
  `POST /api/tasks/:id/notes/accept` `{ repo, topic, text, summary }`;
  `POST /api/tasks/:id/notes/drop` `{ repo, topic }`.
- `GET /api/tasks/:id/diff` (exists) also returns each repo's absolute folder
  path and `run` commands, for the Local panel.
- `GET /api/tasks/:id/spec` / findings: or fold `_thread/spec.md` and
  `findings.md` contents into the task JSON — builder's call.

### 5.9 Dashboard (`src/dashboard.html`)

New behaviour; visual polish deferred.

- **Thread list**: stage badge per thread; threads in `waiting-for-you` sorted to
  the top; a "needs you: N" count in the header and the browser tab title.
- **Create form**: starting-stage selector (investigate / spec / build).
- **Thread page** (the existing task detail):
  - **Overview**: stage, state, turns with their stage, comment list + comment
    box (works while running).
  - **Gate actions** when `waiting-for-you`: *Approve → next stage* (optional
    extra prompt), *Continue this stage* (prompt), *Drop*. Pending comments are
    shown above the buttons as "will be included".
  - **Spec / Findings**: rendered `_thread/spec.md` and `findings.md` when present
    (existing escape-first `renderMarkdown`).
  - **Notes**: suggestion list with accept (editable) / drop.
  - **Result**: existing Log / Diff / Result tabs, plus a **Local** panel per repo
    — folder path with copy button, branch, `run:` commands — next to the
    existing Push / Create PR buttons.

## 6. Error handling

- Skills dir empty or missing → run proceeds; the stage prompt names skills but
  the agent works without them. Dashboard shows nothing special.
- `_thread/spec.md` missing when build starts → build uses the prompt alone.
- Notes accept with invalid topic/repo → 400; file system errors → 500 with
  message, suggestion kept.
- A run that ends without a terminal event keeps today's reconciliation (→
  `failed`); a gate is only entered on a successful `done` event.
- Recovery/reattach path (`launcher.reattach`) uses the same stage-aware
  finalization as a normal run.

## 7. Testing (vitest, existing patterns and `fake-claude` fixture)

- **store**: stage + comments migrations; `followUp` with stage archives turn
  stage and consumes comments; `waiting-for-you → cancelled`; not resumable.
- **launcher**: investigate/spec turn ending `done` → `waiting-for-you`; build
  → `done`; reattach does the same.
- **prompt**: per-stage text, pending comments included once, notes/CLAUDE.md
  lines present, conventions block unchanged.
- **sandbox**: skills mount target, notes mount, no findings mount, image choice
  (shared image vs `sandbox-full`).
- **git**: clone without `--depth`.
- **server**: create with stage; comments; `/next` from `waiting-for-you` with
  stage and empty prompt; drop; notes accept/drop incl. slug validation and path
  containment.
- **One manual check before building on it**: run a real sandbox with the skills
  mount and confirm `claude -p` lists and invokes a skill from
  `~/.claude/skills`. If it does not, stop and revisit 5.4.

## 8. Success criteria

1. Create a thread at `investigate` on two repos → it ends in "needs you" at the
   top of the list with findings visible.
2. Add two comments while it runs → both appear in the next turn's prompt (Raw
   log) and are marked consumed.
3. Approve → spec turn writes `_thread/spec.md`, shown on the page, gate again.
4. Approve → build turn commits on `petree/<id>` in each repo, thread `done`.
5. Local panel shows a folder where `git log main..petree/<id>` works, plus `run:`
   commands; Push / Create PR still work.
6. A note suggestion accepted from the page appears in
   `~/.petree/notes/<repo>/` and `INDEX.md`, and the next thread's sandbox sees it
   read-only.
7. A thread touching a `sandbox-node` repo and a `sandbox-dotnet` repo runs in
   `sandbox-full`.

## 9. Left to the builder

API route shapes (5.8 behaviour fixed), exact stage instruction wording, UI
layout, how spec/findings are served, migration ordering, task split, creating
`~/.petree/notes` at startup.
