# Petree Phase 3 — Review & Integrate Changes

*Design spec — 2026-07-31. Builds on Phase 1/2.*

## 1. Purpose

Today a code-producing task leaves edits in `~/.petree/work/<id>/<repo>` and
integration is entirely manual. Phase 3 makes each task's work a clean,
reviewable branch and gives the dashboard the surfaces to review it and (only
on an explicit click) push it — without ever putting credentials in the
sandbox. It also restructures and polishes the task detail view (tabs, copy
buttons, a nicer look) so the growing output stays usable.

Guiding principle: build the **foundation** (a committed task branch) that
unlocks every richer option — local cherry-pick, push to a branch, and the
later PAT / other-repo / auto-push enrichments — without re-architecting.

All git operations run on the **host** (which has the user's credentials); the
sandbox only edits files. No new dependencies.

## 2. Foundation — the task branch (host-side)

Each task's repo clone is put on a dedicated branch and its changes are
captured as a commit. This happens on the host, in the existing git service —
the sandbox never runs git.

- **At prepare time** (`prepareWorkspace`, after the shallow clone): create and
  check out `petree/<task-id>` from the cloned base branch. `origin/<base>`
  still points at the base commit, so the diff base is always available.
- **At finalize time** (new step after the run, on the host): for each repo, if
  `git status --porcelain` shows changes, stage and commit them on the branch
  with message `petree <task-id>: <first line of prompt>` and a fixed identity
  (`Petree <petree@localhost>`, set per-invocation via `-c`, not global config).
  If the working tree is clean (e.g. an investigation task), no commit is made.
- Finalize runs regardless of terminal state (done or failed) so partial work
  is still inspectable. It never pushes.

New git helpers (in `src/git.ts` or a focused `src/gitops.ts`):

- `createTaskBranch(repoDir, taskId)` — `git checkout -b petree/<taskId>`.
- `commitChanges(repoDir, taskId, message): boolean` — returns whether a commit
  was made (false when nothing changed).
- `repoStatus(repoDir)` — `{ hasChanges, ahead, baseBranch }` for the detail view.
- `diffBranch(repoDir): { stat, patch }` — `git diff origin/<base>...HEAD`
  (three-dot: merge-base), split into a `--stat` summary and the full patch.
- `pushBranch(repoDir, taskId, target): { ok, output }` —
  `git -c ... push origin petree/<taskId>:<target>` on the host. Rejects a
  `target` that is the base branch (never push to develop/main). `target`
  defaults to `petree/<taskId>`.

## 3. API

- `GET /api/tasks/:id/diff` → per-repo array:
  `[{ repo, branch, baseBranch, hasChanges, stat, patch, reviewCommand }]`,
  where `reviewCommand` is the ready-to-run local fetch/checkout command
  (Section 4). Reads only from the work dir; never mutates.
- `POST /api/tasks/:id/push` `{ repo, target }` → runs `pushBranch` on the host,
  returns `{ ok, output }`. Validates `repo` belongs to the task and `target`
  is not the base branch (400 otherwise). This is the only outward-facing
  action and only fires on an explicit dashboard click.
- The `:id` param keeps the Phase-1 traversal guard (`/^[0-9a-f-]{8,36}$/`).

## 4. Review — two non-blocking paths

- **Pull into your own local repo (default, zero credentials).** The diff
  response carries a `reviewCommand`:
  `git -C <your-repo-path> fetch <workdir>/<repo> petree/<id> && git checkout petree/<id>`
  Since `<your-repo-path>` isn't known to petree, the command uses a
  `<your-repo>` placeholder the user fills in; it fetches directly from the
  work-dir clone (a local path), so no remote or credentials are involved.
- **Push the branch to origin (explicit button, host creds).** Per Section 3's
  push endpoint, with an editable target branch, defaulting to `petree/<id>`.
  User then opens the PR in their forge.

## 5. Dashboard — tabs, copy buttons, polish

### 5.1 Tabbed task detail

The detail panel becomes tabbed so large output stays navigable:

- **Overview** — state, repos, model, tokens, session, created/updated, and
  (when failed) the error.
- **Result** — the markdown-rendered result (Phase 2), or a placeholder when
  none yet.
- **Changes** — per repo: the `--stat` summary, the diff (monospace,
  syntax-neutral, horizontally scrollable), the `reviewCommand`, and the push
  control (editable target + Push button + push output). Shows "no changes for
  this task" when clean.
- **Log** — the live stream (as today).

Tab state is per selected task; switching tasks resets to Overview. Only the
active tab's heavy content is rendered.

### 5.2 Copy buttons

A small reusable copy control (a button that writes text to the clipboard via
`navigator.clipboard.writeText` and briefly shows "copied"). Applied to: the
`reviewCommand`, the full diff patch, the result markdown source, the session
id, and the task id. No dependency — a ~15-line helper.

### 5.3 Visual polish

A cohesive, restrained refresh (still self-contained, no framework, no external
assets): a consistent spacing scale, refined typography (readable sans for
prose, mono only for code/ids), softer surfaces and borders, clearer state
badges, a tidy header, and sensible responsive behavior so wide diffs scroll
within their panel rather than the page. Light theme is the baseline; the
design should not preclude a later dark mode. Keep all existing safe-sink
rules: task fields via `esc()` or `textContent`, only `result` via the
escape-first `renderMarkdown`, diffs rendered as escaped text.

## 6. Error handling

- Push failure (auth, rejected, network): the endpoint returns `{ ok:false,
  output }` with the git stderr; the dashboard shows it in the push output area.
  Never crash the server.
- A repo with no `origin` or a shallow-clone push quirk surfaces as push
  output, not a 500.
- Diff/finalize on a missing work dir (e.g. cleaned): return `hasChanges:false`
  / empty rather than erroring.
- Finalize commit failure is recorded (like other launcher store errors) and
  does not change the task's terminal state.

## 7. Testing

- **gitops**: against temp fixture repos — branch creation; commit only when
  changed; diff stat/patch content; push to a second *local bare* repo (a file
  remote) with a valid target and rejection of the base-branch target. No
  network, no real Azure.
- **server**: `GET /api/tasks/:id/diff` shape (with and without changes);
  `POST /push` success against a local bare remote and 400 on base-branch/unknown
  repo.
- **launcher**: finalize commits a fixture task's change on the branch; a
  no-change run makes no commit.
- **dashboard**: manually verified (no DOM harness), but the copy helper and any
  pure formatting live in testable modules where practical.
- No test performs a real push to the user's Azure repos. The live smoke test
  (push to a real remote) is deferred to the user, using the local `demo` repo
  or a throwaway branch.

## 8. Out of scope (later, per the roadmap)

A stored **Petree PAT** for unattended auto-push to a designated integration
branch; pushing to a **different repo/remote**; a **per-task auto-push** toggle;
inline PR creation; and dark mode. The Section 2 foundation supports all of
these additively.
