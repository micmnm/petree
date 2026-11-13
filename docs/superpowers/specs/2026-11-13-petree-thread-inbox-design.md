# Petree Thread Inbox — One Calm Screen for Every Thread

**Date:** 2026-11-13 (rev 2: Handheld Arcade design, bins, quest options, stats, Options screen)
**Status:** Draft
**Intent:** `docs/intent/thread-inbox.md` (confirmed 2026-11-13)
**Design:** `docs/design/handheld-arcade.md`; mockups on the
[Arcade canvas](https://claude.ai/artifact/4oB5gNGZSjgE4v7ATMMSHs)
**Baseline:** `main` at `db97ac1` (PR #16): Node 26 (`.nvmrc`, `engines`, sandbox
images), better-sqlite3 13, vitest 5, js-yaml 5 parsing `repos.yaml` with
`CORE_SCHEMA` plus merge keys. Run tests with `./scripts/test.sh`.

## 1. Intent

Threads work (2026-11-12 spec): investigate → spec → build, gates, comments,
notes, push/PR. The dashboard around them doesn't help. It is a table plus seven tabs
built around logs, and with several threads running the user loses track of them.
Petree should be **an inbox**. One screen lists every thread with its topic, its
state, how far it has got (investigate → spec → build → PR → merged) and what it
needs from the user. Opening a thread shows the short document for its current
stage, with approve and comment right there.

## 2. Goals

1. **Inbox**: every live thread on one screen, in **YOUR MOVE** and **QUESTING**,
   with finished ones on the **HALL OF FAME** shelf and dead ones in the **GAME
   OVER** bin. Each card says what the thread needs without opening it.
2. **Thread page**: the current stage's document (clamped, with a reader popup),
   one primary button, a note box. Stats, log, turns sit below in details.
3. **The agent writes the card**: after every turn it writes a short topic, a status
   line and a "needs you" line, which petree shows on the card.
4. **Progress runs through PR and merge**: petree learns that a PR exists and has
   merged, for GitHub (`gh`) and Azure DevOps (`az`), polled from the host.
5. **Start from the latest code**: petree warns before a thread starts if the
   user's local checkout holds work the agent will not see.
6. **Quest options**: model, PARTY MODE (subagents) and AUTO-PLAY (skip gates until
   the PR is open) are chosen per thread at creation.
7. **Quest stats**: effort and cost per thread and per stage, from data petree
   already captures.
8. **Options**: repos are edited as structured forms with usage stats; raw YAML
   stays as a power-user escape.
9. **Phone**: every screen works at 390 px (responsive, same page).

## 3. Non-goals

- Live log watching as a main view (the log stays, demoted to details).
- Code review in petree (it stays in the IDE or on the PR).
- Taking over a thread interactively.
- Multi-user, auth, a public product, a separate mobile app.
- Notifications.
- Merging from petree, even under AUTO-PLAY.

**Anti-goals:** a card that shows stale agent text as current; a thread that
advances past a gate without the user (unless the user switched AUTO-PLAY on for
that thread); petree folding unpushed local commits into a PR without the user
seeing them.

## 4. Constraints

- Keep the engine. Reuse stages, gates, comments, `followUp`, `readThreadFile`,
  `listSuggestions`, `/push`, `/pr`, `summarizeLog`. Add no new dependencies
  (see §5.10 for the one place this hurts).
- The dashboard stays one vanilla-JS file (`src/dashboard.html`), rewritten in place.
  It keeps `markdown.js` and `activity.js`. Visuals follow
  `docs/design/handheld-arcade.md` (tokens as CSS custom properties, light + dark).
- Pushing stays host-side and manual, with one opt-in exception: AUTO-PLAY opens
  the PR itself (§5.8). The sandbox never sees git, `gh` or `az` credentials.
- The API stays unauthenticated on 127.0.0.1, as today.

## 5. Design

### 5.1 Screens

One page with hash routes: `#/` (inbox), `#/t/<id>` (thread), `#/new` (new quest),
`#/options`. The HUD header (design §4.10) is on every screen; the browser tab
title stays `(N) Petree`, N = YOUR MOVE count. Page titles sit in `<main>` under a
**BACK** button. Every screen works at 390 px (design §5).

The header's tag filters (ALL, then each tag in use) filter the inbox lists and
are remembered in `localStorage`.

#### (a) Inbox — `#/`

| section | shows | default |
|---|---|---|
| **YOUR MOVE** | `card.group === 'your-move'` | expanded; empty → "Nothing needs you." and idle Sprout |
| **QUESTING** | `'questing'` | expanded; hidden when empty |
| **HALL OF FAME** | `'hall-of-fame'` (not archived) | trophy shelf; "Merged quests rest here for 3 days, then move to history." |
| **GAME OVER** | `'game-over'` (not archived) | collapsed with count; "Dropped and failed quests. Cleared after 14 days." |

Within a section, cards sort by `updatedAt`, newest first. The **cartridge card**
(design §4.1) shows: emblem + Q-number (§5.7), `card.topic`, `card.summary`
(2-line clamp), the YOUR MOVE! block with `card.action` or the QUESTING… block with
elapsed time, the level track (`card.progress`), repo chips with tags, age. GAME OVER
rows show the reason and **CONTINUE?** (`POST /restore`). The HUD's LV, XP and
streak are cut-first (§5.11).

**Screen states**: no threads → "No quests yet." + PRESS START; server unreachable
→ banner "petree not reachable — retrying", last list stays. Polls `GET /api/tasks`
every 3 s; nothing on it is editable.

#### (b) Thread, your move — `#/t/<id>`

One scrolling page (mockup `ArcadeThread`):

1. **Head**: BACK; emblem, Q-number, topic (h1), summary, level track with
   `PLAN · spec`, repo chips with tags, PR links per repo ("petree ↗ PR #42 open"),
   age, thread id in mono with copy.
2. **YOUR MOVE! panel**: `card.action` (+ the agent's needs-you line), who/when
   ("agent · end of the PLAN turn · 2h ago"), "N notes will be included".
3. **Document**: current stage's markdown via `renderMarkdown`, clamped (design
   §4.8) with READ ALL ▶ into the reader. *investigate*: FINDINGS
   (`_thread/findings.md`, fallback turn result); *spec*: SPEC (`_thread/spec.md`,
   fallback result); *build*: RESULT (turn `result`). Earlier documents sit
   collapsed below it.
4. **YOUR NOTE TO THE PARTY**: one textarea (draft in `localStorage` per thread),
   then the buttons. The note travels with whichever button is pressed:

   | situation | primary | secondary | quiet |
   |---|---|---|---|
   | gate, investigate | **CONTINUE ▶** "approve findings · write spec" → `POST /next {stage:'spec'}` (link: "skip to CRAFT" → `{stage:'build'}`) | **RETRY STAGE** "send note · redo findings" → `/next` same stage | **GAME OVER** → `POST /drop` |
   | gate, spec | **CONTINUE ▶** "approve spec · start build" → `/next {stage:'build'}` | RETRY STAGE | GAME OVER |
   | build done, repo(s) with commits, no PR | **SHIP IT** "open PR on GitHub/Azure" → `POST /pr` per repo, target `petree/<id>` | RETRY STAGE "send note · rework build" | GAME OVER |
   | PR open, local head ≠ PR head | **SHIP IT** "push update to PR #42" → `POST /push` | RETRY STAGE | GAME OVER |
   | PR open, in sync | *(none)*; action "Merge PR #42 on GitHub" with the PR link | RETRY STAGE | GAME OVER |
   | paused by you (`cancelled`, not binned) | **RESUME** "re-run the <stage> turn" → `/resume` | RETRY STAGE "send note · new turn" | GAME OVER |
   | build done, no commits, agent asked something | *(none)*; textarea focused | **RETRY STAGE** "send reply" | GAME OVER |

5. **QUEST STATS** (§5.9), **QUEST LOG** (§5.9), then **DETAILS**, each collapsed
   and rendered only when opened: ORIGINAL PROMPT (clamped, reader), CHANGES (the
   current Changes tab), STAGE RUNS (turn history), LOG (`renderActivity` once,
   plus "open raw log"), NOTE SUGGESTIONS (N) when N > 0 (current Notes tab), INFO
   (model, flags, tokens / budget, session id, created, updated, last error).

The page polls every 3 s and re-renders head, panel and document only; the
textarea and open details are left alone. Unknown id → "Quest not found" + BACK.

#### (c) Thread, questing

Same page while queued, provisioning, running or paused-rate-limit (mockup
`ArcadeRunning`): QUESTING… with elapsed time; a **NOW PLAYING** line (the latest
activity from the log tail, cut-first) with **PAUSE** "stop this turn" (`POST
/stop`, confirm); the document shows the previous turn's doc (the spec during
CRAFT) under "A new CRAFT turn is running (12 min)", or "Working on the <stage>…
started 12 min ago" with none. The note box offers only **QUEUE NOTE** "sent with
the next turn" (`POST /comments`) and shows the queued count. Stats carry `LIVE`.

#### (d) Reader popup

Opened from any READ ALL ▶ (design §4.8). Reuses the existing `#viewerOverlay`
(PR #15) restyled: title, path, word count and read time, CONTENTS from headings,
full markdown, CLOSE / Esc. On the gate document it repeats the gate buttons and
uses the same note draft.

#### (e) Victory

A merged thread's page (`card.group === 'hall-of-fame'` with outcome merged) opens
as the Victory layout (mockup `ArcadeVictory`): sword-up Sprout, QUEST COMPLETE /
VICTORY!, the level track all done, QUEST REPORT tiles: stages run, turns, files
changed (+/−), tokens, start to merge (`createdAt` → `mergedAt`), merged by. Then
NEXT QUEST (to inbox) and PRESS START. The note box is replaced by "Merged. Start
a new quest for more." Details stay reachable below. The REWARD tile is cut-first.

Hall-of-fame threads without a merge (§5.6) use the normal page with the outcome
line instead.

#### (f) New quest — `#/new`

Four steps on one page (mockup `ArcadeNew`); Cmd/Ctrl+Enter starts from anywhere.

1. **THE QUEST**: prompt textarea, character count, draft kept (`petree-draft`).
2. **CHOOSE YOUR PARTY**: chosen repos as chips with × and an expandable
   `repos.yaml` summary (branch, image, setup, test, model). **Typeahead**: a
   combobox over all repos (`role="combobox"`, ↑↓ move, Enter add, Esc close),
   matched prefix highlighted, each row "branch · image · last quest 5h ago",
   with the ALL/WORK/PERSONAL tag tiles above it. **RECENT**: up to 5 repos by
   latest quest (`usage.lastQuestAt`), one tap to add. The unpushed-work warning
   (§5.5) sits under each chosen repo that has local work.
3. **CHOOSE YOUR CLASS**: three selection tiles, SAGE · Opus / KNIGHT · Sonnet /
   ROGUE · Haiku. Preselected: `resolveModel(undefined, repo.defaultModel,
   defaults.defaultModel)` of the first chosen repo, tagged "default for <repo>"; if
   that resolves to null (CLI default), no tile is preselected and the request
   sends `default`.
4. **RULES OF PLAY**: STARTING LEVEL tiles (SCOUT · investigate "look around,
   write findings, stop for you" / PLAN · spec / CRAFT · build); switches **PARTY
   MODE** (default ON) and **AUTO-PLAY** (default OFF), with a line that restates
   the effect ("AUTO-PLAY is off, so the quest starts at SCOUT and stops at every
   gate for your OK").

Footer: summary "1 repo · KNIGHT · Sonnet · starts at SCOUT", **BACK** "to the
inbox, draft kept", **PRESS START** → `POST /api/tasks`, then `#/t/<id>`. A 400
shows inline. No repos configured → "No repos yet — open OPTIONS".

#### (g) Options — `#/options`

Replaces the settings modal (mockup `ArcadeSettings`).

- **THIS MONTH** tiles (all repos): quests started (N still in play), victories,
  game overs, win rate, time played, average window use (≈).
- **PARTY ROSTER**: one card per repo, SORT BY MOST USED / RECENT / A–Z. Collapsed:
  name, tags (or "idle" when no quest in 30 days), quests · won · game over, last
  quest, time played this month, 8-week sparkline, branch, image, local path,
  commands. **EDIT** opens the form in place: URL, DEFAULT BRANCH, IMAGE (tiles:
  sandbox-node / sandbox-dotnet / sandbox-full), TAGS (tiles from tags in use +
  free text), LOCAL CHECKOUT PATH, INSTRUCTIONS (textarea), COMMANDS (setup /
  build / test / run, one per line), default model (class tiles), plus a USAGE
  panel (where quests ended per level, avg turns, most used model). **DONE**
  keeps edits, **CANCEL** undoes, **DISMISS** removes the repo. **+ RECRUIT REPO**
  adds one. Edits are written by **SAVE** (`PUT/POST/DELETE /api/repos…`, §5.10).
- **GAME RULES**: concurrency, token budget, timeout (repos.yaml `defaults:`),
  window budget for the ≈ share (§5.9), GAME OVER clean-up days and HALL OF FAME
  days (DB settings).
- **EDIT RAW repos.yaml**: the existing raw editor (`/api/repos-yaml`) in a panel.
- Copy for build/test: "must pass before the agent reports success" (that is
  what the prompt enforces; petree itself does not gate SHIP on them).

#### (h) Phone

Same routes and markup, CSS only (design §5). Thread page order and the
`MORE STATS` collapse follow `ArcadeMobileThread`; inbox follows `ArcadeMobileInbox`.

### 5.2 Card data contract

`GET /api/tasks` (and `GET /api/tasks/:id`) returns each `TaskRecord` plus a
derived `card`. A pure `cardFor(task, status, cfg)` in a new `src/inbox.ts`
computes it, so the dashboard only renders and vitest covers the rules. `GET
/api/tasks` leaves out archived threads unless `?archived=1`.

| field | how it is produced |
|---|---|
| `card.q` | `task.seq`, rendered `Q-021` (§5.7) |
| `card.topic` | `status.topic` (§5.3) when fresh, else `threadTitle(task)` |
| `card.summary` | `status.status` when fresh, else `card.line` |
| `card.line` | §5.2.1 |
| `card.group` | `'your-move' \| 'questing' \| 'hall-of-fame' \| 'game-over'`, §5.2.2 |
| `card.action` | `{ label, detail }` or `null`; detail is `status.needsYou` |
| `card.reason` | bins only: "dropped by you", "out of tokens", "failed: <first line>", "PR closed without merge", "merged · PR #15", "finished · no code changes", "pushed · merge not tracked" |
| `card.progress` | `[{ step, mark, tone? }]` × 5, §5.2.3 |
| `card.repos` | `[{ name, tags }]` from `task.repos` + `cfg.repos[r].tags` |
| `card.prs` | `[{ repo, url, pr, number }]` from `delivery` (§5.4) |
| age | `updatedAt`, relative, client-side |

The emblem is computed client-side from `task.id` (design §4.2).

#### 5.2.1 State line

Engine state wins wherever it is the news; the agent's text is used only once a
turn has settled.

| condition | line |
|---|---|
| queued | "Queued" |
| provisioning | "Preparing workspace" |
| running | "Running <LEVEL> · <elapsed since startedAt>" |
| paused-rate-limit | "Waiting out a rate limit" |
| cancelled, not binned | "Paused by you" |
| binned | `card.reason` |
| any repo `pr: 'open'` | "PR #<n> open — waiting for merge" |
| waiting-for-you, or done before any PR | `status.status` when fresh, else "Findings ready" / "Spec ready" / "Build finished" |

#### 5.2.2 Group and action

**Bins first**: `task.bin` set → that group (§5.6).

**YOUR MOVE** (first matching row sets `action.label`):

| condition | `action.label` |
|---|---|
| waiting-for-you, stage investigate | "Read the findings, then approve or comment" |
| waiting-for-you, stage spec | "Read the spec, then approve or comment" |
| cancelled (paused by you) | "Paused — resume or send a note" |
| build done, a repo with `ahead > 0` has no target and no PR | "Open the PR" |
| a repo with `pr: 'open'` whose `prHead ≠ head` | "Push the update to PR #<n>" |
| a repo with `pr: 'open'` | "Merge PR #<n> on <GitHub\|Azure DevOps>" |
| build done, no commits, `status.needsYou` set | "Reply" |

**QUESTING**: queued, provisioning, running, paused-rate-limit.

An open PR counts as YOUR MOVE (open question 1 is resolved that way by the
mockups). Grouping comes from engine state; the agent's line only adds detail,
except in the last row.

#### 5.2.3 Progress steps

Steps `investigate`, `spec`, `build`, `pr`, `merged`, shown as SCOUT, PLAN, CRAFT,
SHIP, VICTORY. Marks `done`, `current`, `skipped`, `todo`; the current step's
tone is `running`, `needs-you` or `failed`.

- **investigate / spec / build**: steps before `stage` are `done` if a turn ran in
  them (`turns[].stage`), else `skipped`. `stage` is `current`, except build becomes
  `done` once the build turn is `done`. Later steps are `todo`; moving back resets
  them to `todo`.
- **pr (SHIP)**: `todo` until build is done; `current` while a repo with commits
  has no PR; `done` once every such repo has one (or was pushed, when untracked);
  `skipped` when build finished with no commits.
- **merged (VICTORY)**: `current` while any PR is open, `done` when every repo with
  commits has `pr: 'merged'`, `skipped` together with pr.

### 5.3 Agent-written status (`src/prompt.ts`, `src/notes.ts`)

**File**: `/work/_thread/status.txt` (`<workDir>/_thread/status.txt` on the host).
It sits next to `findings.md` and `spec.md`, so it is never committed or pushed.

**Prompt**: `composePrompt` gains one fixed section at every stage, placed after
the note-suggestion section and before the repo conventions:

```
## Thread status (do this last, every turn)

Overwrite `/work/_thread/status.txt` with exactly three lines:
topic: <the thread's subject in at most 6 words>
status: <one sentence: where the thread stands after this turn>
needs-you: <one sentence: the decision or action you need from the user, or "nothing">
```

**Reading**: a new `readThreadStatus(workDir, since)` in `notes.ts` reuses the same
`contained()` check as `readThreadFile` and returns
`{ topic, status, needsYou } | null`.
- The parse takes the first `key: value` line per key and trims it. Values are
  clipped (topic 60, status 140, needs-you 160 chars).
- `nothing`, `none` or an empty needs-you becomes `null`.
- Unknown lines are ignored.
- **Freshness**: the file's mtime must be ≥ the task's `startedAt`, i.e. written
  during the latest turn. Otherwise the function returns `null`. Deleting the
  file at launch was rejected: the agent controls `_thread/` and could make the
  delete follow a symlink.

**When the file is missing, stale or garbled**: topic falls back to
`threadTitle(task)` and the line to the engine text (§5.2.1). The action has a
label but no detail. Nothing is shown as an error. The content is always escaped
(`esc`) when rendered.

### 5.4 Progress through PR and merge (`src/store.ts`, `src/launcher.ts`, new `src/prs.ts`)

**Store**: a new column `delivery`, a JSON map from repo to entry, added by an
additive migration in the same pattern as `comments`:

```ts
interface Delivery {
  ahead: number      // commits on petree/<id> beyond origin/<base>, set at turn end
  head: string       // local HEAD sha of petree/<id>, set at turn end
  target?: string    // branch last pushed by /push or /pr
  url?: string       // PR web URL
  number?: number    // PR number (gh `number`, az `pullRequestId`)
  pr?: 'open' | 'merged' | 'closed'
  prHead?: string    // PR head sha (from gh/az, or what /push just pushed)
  mergedAt?: string  // gh `mergedAt`, az `closedDate` when completed
  mergedBy?: string  // gh `mergedBy.login`, az `closedBy.displayName`
  untracked?: string // why the PR state can't be read: "gh not installed", "az: not logged in", "unsupported host"
}
```

**Writers**:
- **Launcher, at turn end**: `runTurn` already loops over the repos to commit. It
  also records `ahead` (`repoStatus`) and `head` (`git rev-parse HEAD`) per repo via
  `store.setDelivery(id, repo, patch)`.
- **`/push` on success**: sets `target` and `prHead = head`.
- **`/pr` on success**: sets `target`, `url`, `number`, `pr: 'open'`, `prHead = head`.

  Both then trigger a poll of that thread.

**Host from the repo URL** (`prHost(url)` in `prs.ts`):
- `github.com[:/]owner/name(.git)` → GitHub, `owner/name`.
- `[user@]dev.azure.com/{org}/{project}/_git/{repo}` and
  `{org}.visualstudio.com/{project}/_git/{repo}` → Azure, parts URL-decoded.
- Anything else (e.g. `file://`) → `untracked: 'unsupported host'`.

**Polling** (`pollPrs(store, cfg)`, every 5 min from `index.ts` next to the sweep,
and once after `/push` or `/pr`):
- **Candidates**: unarchived threads with stage build that are not running, and
  repos with `ahead > 0` whose `pr` is not `merged` or `closed`.
- The branch queried is `target ?? petree/<id>`, so a PR opened by hand from the
  petree branch is found too.
- **GitHub**: `gh pr list --repo owner/name --head <branch> --state all --json
  url,number,state,headRefOid,mergedAt,mergedBy --limit 1`. `OPEN`/`MERGED`/`CLOSED`
  map to `open`/`merged`/`closed`.
- **Azure**: `az repos pr list --org https://dev.azure.com/<org> --project
  <project> --repository <repo> --source-branch <branch> --status all --top 1 -o
  json`. `active`/`completed`/`abandoned` map to `open`/`merged`/`closed`. URL =
  `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<pullRequestId>`,
  `prHead` from `lastMergeSourceCommit.commitId`.
- Both run through async `execFile` (never `execFileSync`). Each uses the host
  CLI's own auth, as `git push` and `gh pr create` do today.
- The store is written only when something changed, and only then does
  `updated_at` move.
- When every repo with commits is `merged` → `bin('hall-of-fame')`; when none is
  open and at least one is `closed` → `bin('game-over')` (§5.6).

**Create PR on Azure**: `createPullRequest` dispatches on `prHost`. GitHub keeps
`gh pr create`; Azure uses `az repos pr create --org … --project … --repository …
--source-branch <target> --target-branch <base> --title … --description … -o json`.

**When neither CLI is available, or it fails**:
- `ENOENT` → `untracked: '<cli> not installed'`; non-zero exit → `untracked:
  '<cli>: <first stderr line>'` (scrubbed with `scrubUrls`).
- **SHIP IT** returns the same error inline. The user can still push from
  Details › Changes; after a push to an untracked host the thread is binned to
  HALL OF FAME as "pushed · merge not tracked". Merged is never inferred.
- The poll keeps retrying, so installing or logging into the CLI later starts
  tracking without user action.

### 5.5 Start from the latest code (`src/config.ts`, `src/server.ts`)

**Problem**: `prepareWorkspace` clones `repo.url` (the remote) at the first launch,
which is already the latest *remote* code. Reused clones on later turns keep the
thread's branch base on purpose. The gap is **local work that was never pushed**,
which petree can't see because it doesn't know where the user's checkout lives
(PR #13).

**Options considered**:
1. *Fetch at launch*: already effectively true for the first turn; doesn't see
   unpushed work.
2. *Clone from the local checkout*: the user's unreviewed, unpushed commits ride
   along into the thread's diff and PR, and the checkout may sit on an unrelated
   branch. **Rejected.**
3. **Warn on the create form** when the local checkout holds unpushed or
   uncommitted work. **Chosen**: smallest change, never changes what the agent
   builds on, the user decides.

**Implementation**:
- New optional per-repo key `path:` in `repos.yaml`: the host path of the user's
  local checkout, with a leading `~/` expanded. Never mounted, never sent to the
  agent. Under js-yaml 5's YAML 1.2 core schema a bare `path: ~` is null ("no
  path"); `path: ~/x` stays a string. It inherits through `<<:` merge keys.
- `GET /api/repos` adds `local: { unpushed, dirty } | null` for repos with a
  `path:`, computed concurrently with async `execFile` using the hardened `git()`
  flags (`core.hooksPath=/dev/null`, `core.fsmonitor=false`):
  - `unpushed`: `git -C <path> rev-list --count --branches --not --remotes`.
  - `dirty`: `git -C <path> status --porcelain` is non-empty.
  - Missing path or not a git repo → `local: null`, no warning.
  - No fetch, so no network. Stale remote refs can only over-warn.
- The New quest screen shows the warning under each chosen repo with
  `unpushed > 0 || dirty`. The mockup's **PUSH FIRST** button is not built: petree
  never pushes the user's own checkout (open question 7).

### 5.6 Bins and retention (`src/store.ts`)

**Columns** (additive migration): `bin TEXT` (`'game-over' | 'hall-of-fame' |
NULL`), `binned_at TEXT`, `archived_at TEXT`. `store.bin(id, kind)` sets both bin
fields; `store.unbin(id)` clears them.

**Who bins**:

| event | bin | reason |
|---|---|---|
| `POST /drop` (GAME OVER button) from waiting-for-you, done or cancelled; from running it stops first | game-over | "dropped by you" |
| transition into `failed` | game-over | "failed: <first line>" |
| transition into `paused-limit` | game-over | "out of tokens" |
| poll: PR closed, none open | game-over | "PR closed without merge" |
| poll: every PR merged | hall-of-fame | "merged · PR #<n>" |
| build turn ends with no commits in any repo and no `needsYou` | hall-of-fame | "finished · no code changes" |
| `/push` succeeds on an untracked host | hall-of-fame | "pushed · merge not tracked" |

Drop does **not** change state for a settled thread; it only bins. **PAUSE**
(`/stop` while running) leaves the thread `cancelled` and unbinned, so it stays in
YOUR MOVE as "Paused by you".

**Restore** (`POST /api/tasks/:id/restore`, **CONTINUE?**): game-over and not
archived only, else 409. It unbins, then: `failed` → `resume`; `paused-limit` →
`resume` with `tokensUsed` reset to 0 (one more budget; replaces open question 6);
anything else → no state change (the thread is back in YOUR MOVE as it was).

Binned threads reject `/next`, `/resume`, `/comments` with 409 "restore first".

**Sweep** (replaces `prune()`, runs every 60 s as today): sets `archived_at` on
game-over threads binned more than `binDays` (default 14) ago and hall-of-fame
threads binned more than `hallOfFameDays` (default 3) ago. Archived threads leave
the inbox, can't be restored, and stay reachable by URL and in usage stats. **Rows
are no longer deleted** (`ponytail:` rows grow forever; add a hard delete after N
months if the DB ever matters). Work dirs, logs and sessions were never deleted by
petree and still aren't (known gap, out of scope).

**Settings**: the `settings` table gains `bin_days` and `hall_of_fame_days`;
`max_age_days` and `max_per_repo_group` stop being read. `GET/PUT /api/settings`
become `{ binDays, hallOfFameDays }`.

**Upgrade**: on migration, existing done/failed/cancelled rows older than 3 days
get `archived_at = now`; younger failed/cancelled ones are binned game-over, so the
first inbox isn't flooded with old "Open the PR" cards.

### 5.7 Quest identity

- **Emblem**: pure function of the thread id (design §4.2), coloured by the first
  repo's hue; computed in the dashboard. No storage.
- **Q-number**: new column `seq INTEGER`, set at `create()` to `MAX(seq) + 1`,
  backfilled by `created_at` order in the migration. Since rows are no longer
  deleted (§5.6), it is unique and stable. A hash of the id into 3 digits was
  rejected: with ~50 threads a collision is likely (open question 8).

### 5.8 Quest options (`src/store.ts`, `src/server.ts`, `src/sandbox.ts`, `src/prompt.ts`, `src/launcher.ts`)

`POST /api/tasks` accepts `model` (already validated against `MODELS`), and new
booleans `party` (default `true`) and `autoPlay` (default `false`). Stored as
columns `party INTEGER NOT NULL DEFAULT 1`, `auto_play INTEGER NOT NULL DEFAULT 0`
and shown in Details › Info. The model select deleted in rev 1 comes back as the
class tiles (open question 2 closed).

- **PARTY MODE off**: `buildSandboxCommands` adds `--disallowedTools Task Agent`
  (both names, as `activity.js` already handles both; check against the CLI
  version in the sandbox images), and `composePrompt` drops the build stage's
  "dispatch every independent task to its own subagent" paragraph.
- **AUTO-PLAY on**: in the launcher's `done` handler, instead of stopping at
  `waiting-for-you`:
  - investigate → `followUp(id, '', undefined, 'spec')`; spec → `followUp(id, '',
    undefined, 'build')`. Pending comments fold in as usual.
  - build done with commits → for each repo with `ahead > 0`, push and open the PR
    exactly as `POST /pr` does (target `petree/<id>`), recording delivery. Failures
    land as the usual YOUR MOVE "Open the PR" with the error in Info.
  - Never merges. A failed or out-of-tokens turn stops AUTO-PLAY (it bins as usual).
  - The quest log shows these moves as "auto: on to PLAN" (an empty-prompt stage
    move on an `autoPlay` thread; nothing extra stored).

### 5.9 Quest stats and quest log (new `src/stats.ts`)

**Source**: the raw Claude Code `stream-json` in `logs/<id>.log`, which is
append-only across turns; each run's slice starts at `task.logOffset`. Parse the
slice with `summarizeLog` from `activity.js` (already server-importable via
`activity.d.ts`), extended with the fields below.

```ts
interface TurnStats {        // one stage turn, summed across its resumes
  model: string | null       // system/init `model`
  wallMs: number             // Σ result `duration_ms`; fallback endedAt − startedAt
  turns: number              // Σ result `num_turns`
  tokensIn: number           // Σ input + cache_creation + cache_read tokens
  tokensOut: number          // Σ output tokens
  cacheRead: number          // shown in the subline
  costUsd: number | null     // Σ result `total_cost_usd` (API-equivalent, not billed on Max)
  subagents: Record<string, number> // Task/Agent tool_use by input.subagent_type
  tools: Record<string, number>     // tool_use counts by name (existing toolCounts)
  testRuns: number           // Bash tool_use whose command contains a repo `test:` command
  files: { repo: string; files: number; add: number; del: number }[]
}
```

| number | from | trust |
|---|---|---|
| model | `system`/`init` event `model` | exact |
| wall time | `result.duration_ms` | exact per run |
| turns | `result.num_turns` | exact |
| tokens in/out | `result.usage` when present, else Σ `assistant.message.usage` once per message id (the runner's dedup) | exact for the main agent; **gap**: whether `result.usage` includes subagent tokens is unverified, so sum `parent_tool_use_id` messages too and check against a real log in PR 7 |
| share of 5-h window | `costUsd / defaults.window_usd` | **estimate**, shown with ≈. Max-plan quota isn't exposed anywhere; `window_usd` is a user-calibrated value in GAME RULES (unset → tile says "set in GAME RULES"). Cost weights models correctly; it is "share of one window's worth", not of the current rolling window |
| subagents | `tool_use` named `Task`/`Agent`; running = no matching `tool_result` yet | exact |
| top tools | `tool_use` by name | exact |
| files changed | `git show --shortstat <turn commit>` per repo at turn end (one commit per turn already) | exact |
| test runs | Bash commands matching a repo's `test:` entries | heuristic count; **gap**: pass/fail per run ("3 of 5 green") isn't derivable |
| merged by / start to merge | `delivery.mergedBy`, `mergedAt` (§5.4) | exact when the CLI returns them |

**Storage**: column `turn_stats` (JSON) holds the current turn's stats; the
launcher computes it at turn end (after the commit) from the log slice and adds it
to what is there, so resumes accumulate. `followUp` copies it into the archived
`Turn` as `stats` and clears it. Pre-upgrade turns have no stats ("—").

**Route**: `GET /api/tasks/:id/stats` → `{ total, stages: [{ stage, ...TurnStats,
live }] }`, grouping turns by stage; a running turn's slice is parsed on request
(`live: true`).

**Quest log**: derived, no storage: "Quest started" (createdAt, prompt length,
repos), one entry per archived turn ("Findings ready", endedAt, result's first
lines, clamped), stage moves between consecutive turns ("Approved, on to PLAN",
with the follow-up note), comments, PR opened/merged from `delivery`, and the
current turn.

**Repo usage** (`src/usage.ts`, for Options and the typeahead): computed from all
rows including archived, per repo: quests, won (hall-of-fame merged), lost
(game-over), in play, `lastQuestAt`, time played this month (Σ `wallMs`), quests
per week for 8 weeks, where quests ended (highest level reached), avg turns, most
used model; plus the THIS MONTH totals. A few hundred rows in JS per request is
fine; no cache.

### 5.10 Options API (`src/server.ts`, new `src/repos-yaml.ts`)

| route | does |
|---|---|
| `GET /api/repos` | as today + `path`, `local` (§5.5), `usage` (§5.9) |
| `GET /api/repos/:name` | structured fields, `editable`, file `hash` |
| `PUT /api/repos/:name` | replace that repo's block |
| `POST /api/repos` | append a repo under `repos:` |
| `DELETE /api/repos/:name` | remove it; 409 while an unbinned, unarchived thread uses it (`pickImage` would throw) |
| `PUT /api/defaults` | concurrency, token budget, timeout, `window_usd` in `defaults:` |

**Writing back**: js-yaml can't round-trip comments, so the write is a **text
splice**: find the repo's block (its key line under `repos:` through the line
before the next key at the same indent), render only that block with js-yaml
`dump`, splice it in, run `parseConfigText` on the whole new text, and write via
temp file + rename. Everything outside the block (comments, anchors, other repos)
stays byte-for-byte. Then apply to `cfg` in place, as `PUT /api/repos-yaml` does.

**Risks, flagged**:
- Comments *inside* the edited block are lost.
- A block that defines an anchor (`&x`), uses an alias (`*x`) or a merge key
  (`<<:`) can't be re-rendered without inlining or breaking the sharing. Those
  repos come back `editable: false` and the form says "uses YAML anchors — edit
  in RAW". The alternative, eemeli's `yaml` package (comment-preserving Document
  API), needs a dependency exception (open question 9).
- Concurrent hand edits: each write sends the `hash` it read; a mismatch → 409
  "repos.yaml changed on disk — reload".
- `concurrency` still applies on restart (the scheduler holds a number), as with
  the raw editor today.

### 5.11 Nice to have, cut first

Cosmetic, derived from counts, no new storage. Build last; drop any of them
without touching the rest.

- **LV / XP / streak** in the HUD: XP = merged quests; LV = 1 + ⌊XP / 5⌋; bar =
  XP mod 5; streak = consecutive local days ending today or yesterday with ≥ 1
  merge. Served by `GET /api/hud` from `usage.ts`.
- Victory **REWARD** tile ("+1 XP · LV 3").
- **NOW PLAYING** line and the questing **trail** dots.
- Subagents "running now" count, per-stage table on phone.
- An agent-written TL;DR (3 bullets) for the phone thread page; until then the
  phone shows the clamped document.
- Sprout pose switching (one static pose is acceptable).

## 6. What gets deleted or demoted (`src/dashboard.html`, `src/activity.js`)

| current section | fate |
|---|---|
| Two-column `.layout`: thread table left, tab panel right | **Deleted.** Inbox cards (§5.1a) and the full-width thread page (§5.1b). |
| Create form pinned above the list | **Moved** to `#/new`, rebuilt as the four steps. The repo combo becomes the typeahead; draft handling is reused. |
| Model `<select>` on the create form | **Replaced** by the class tiles (§5.1f). On the follow-up form: **deleted** (`/next` keeps the thread's model). |
| Conventions preview (`#conventions`, `renderConventions`, `.conv*` CSS) | **Deleted.** The chosen-repo summary and Options show repo config. |
| Tab bar and the 7 tabs | **Deleted.** One page with details. |
| Overview `<dl>` | **Demoted** to Details › Info ("current turn" dropped). |
| Overview gate card and "next prompt" card | **Replaced** by the YOUR MOVE panel and the note box. |
| Spec / Findings tabs | **Replaced** by the Document section; earlier docs collapse under it. |
| Spec/Findings full-view popup (`#viewerOverlay`) | **Kept**, restyled as the reader (§5.1d). |
| Notes tab | **Demoted** to Details › Note suggestions (markup and handlers unchanged). |
| Result tab: history / PR section | **Demoted** to Details › Stage runs / **replaced** by SHIP IT and the PR links. |
| Changes tab | **Demoted** to Details › Changes, unchanged. |
| Log tab machinery (segments, follow, scroll keeping, its storage keys and CSS) | **Deleted.** Details › Log renders `renderActivity` once, with a raw link. |
| Poll guards (`resultShownFor`, `typing`/`drafting`, live-tab list) | **Deleted.** |
| Settings modal (retention + raw editor) | **Replaced** by `#/options`; the raw editor moves into it. |
| Current CSS (radius, palette) | **Replaced** by the design tokens. `activity.js` keeps its classes; restyle them with the tokens. |
| `activity.js` | **Kept**; also imported server-side by `stats.ts`. |

## 7. API changes (`src/server.ts`)

Changed:
- `GET /api/tasks[/:id]`: each task gains `card` (§5.2) and `seq`, `party`,
  `autoPlay`, `bin`, `binnedAt`, `archivedAt`; the list skips archived unless
  `?archived=1`.
- `POST /api/tasks`: accepts `party`, `autoPlay`.
- `GET /api/repos`: adds `path`, `local`, `usage`.
- `POST /push`, `POST /pr`: record `delivery`, trigger a poll; `/pr` works for Azure.
- `GET/PUT /api/settings`: `{ binDays, hallOfFameDays }`.
- `/next`, `/resume`, `/comments`: 409 on binned threads.
- `/stop`: running/queued/provisioning only from the UI (PAUSE); the gate path
  stays for compatibility, the UI uses `/drop`.
- `POST /api/prune` → runs the sweep.

New: `POST /api/tasks/:id/drop`, `POST /api/tasks/:id/restore`, `GET
/api/tasks/:id/stats`, `GET/PUT/DELETE /api/repos/:name`, `POST /api/repos`, `PUT
/api/defaults`, `GET /api/hud` (cut-first).

Unchanged: `/thread`, `/diff`, `/logs`, `/notes/*`, `/repos-yaml`.

## 8. Error handling

- Status file missing, stale or garbled → fallbacks in §5.3. Never a card error.
- `gh`/`az` missing, unauthenticated or erroring → `untracked` reason, the poll
  retries, no state change (§5.4).
- **SHIP IT** partly fails across repos → each repo's result inline; successes
  are recorded; the button stays for the rest. Same for AUTO-PLAY's PR step.
- Local-checkout check fails, or `path:` doesn't exist → `local: null`, no warning.
- Stats: unparseable log lines are skipped (as `summarizeLog` does); a missing log
  → zeros with "no log". A missing `window_usd` → no share, never a guess.
- Repo edit: YAML that fails `parseConfigText` after the splice → 400 with the
  parser message, nothing written; hash mismatch → 409; anchored block → 422.
- Restore of an archived or non-game-over thread → 409.

## 9. Delivery as small PRs

Each ships on its own and fits one petree task. 1–8 are engine/API changes the
current dashboard tolerates; 9–13 are the UI, one screen each; 14 is cut-first.

1. **Agent status file.** Status section in `composePrompt`; `readThreadStatus`;
   `src/inbox.ts` `cardFor` (topic, summary, line, group, action, progress for the
   first three steps); `card` on `GET /api/tasks[/:id]`. *Tests:* prompt section
   once per stage; parse, clip, `nothing`→null, stale mtime, symlink escape;
   `cardFor` table cases.
2. **Delivery record.** `delivery` column + `setDelivery`; launcher records
   `ahead`/`head` (normal and reattach); `/push`, `/pr` record target/url/number/
   prHead; `cardFor` SHIP/VICTORY steps and the PR actions. *Tests:* migration,
   per-repo records, `cardFor` PR cases.
3. **PR polling + Azure create.** `src/prs.ts`: `prHost`, `findPr`, `pollPrs`,
   Azure `createPullRequest`, `untracked`, `mergedAt`/`mergedBy`. *Tests:* URL
   parsing, state mapping from canned JSON, ENOENT → untracked,
   write-only-on-change.
4. **Bins, sweep, identity.** `bin`/`binned_at`/`archived_at`/`seq` columns,
   backfill and upgrade rule; binning on fail/out-of-tokens/drop/poll/no-commit
   build/untracked push; `/drop`, `/restore` (paused-limit resets tokens); sweep
   replaces prune; settings `binDays`/`hallOfFameDays`; 409s on binned threads;
   `cardFor` bins and reasons. *Tests:* each binning row, restore per state,
   sweep windows, no deletes, seq backfill and uniqueness.
5. **Local checkout warning.** `path:` in `config.ts` (`~` expansion, README line);
   `local` on `GET /api/repos`. *Tests:* config parsing; temp repo with an
   unpushed commit and a dirty file; missing path; `path: ~`; inherited via `<<:`.
6. **Quest options.** `party`/`auto_play` columns and request fields;
   `--disallowedTools` and the prompt paragraph; AUTO-PLAY steps in the launcher
   (follow-ups, PR open, stop on fail). *Tests:* command line per flag, prompt
   without the subagent paragraph, AUTO-PLAY moves investigate→spec→build→PR with
   a fake runner, never past a failure, never merges.
7. **Quest stats + usage.** `src/stats.ts` (extend `summarizeLog`), `turn_stats`
   column and copy into `Turn.stats`, files from the turn commit, `GET /stats`
   with live slice; `src/usage.ts` and `usage` on `GET /api/repos`; `window_usd`
   in config. *Tests:* canned stream-json → each field; resume accumulation;
   usage aggregates over fixture rows. Verify the subagent-token gap on one real
   log and record the answer in the code comment.
8. **Options API.** `src/repos-yaml.ts` block splice; repo GET/PUT/POST/DELETE,
   `PUT /api/defaults`, hash check, `editable`. *Tests:* splice keeps comments
   and other blocks byte-for-byte; anchored block → not editable; invalid result
   → 400 and file untouched; hash mismatch → 409; delete refused while in use.
9. **Shell + Inbox.** Tokens (light/dark), fonts, header, hash router, cartridge
   card, emblem, level track, labels, YOUR MOVE / QUESTING / HALL OF FAME / GAME
   OVER with CONTINUE?, tag filters, phone layout. Deletes the table and the
   pinned form's list. A card opens `#/t/<id>`, which in this PR still renders
   the old tab panel full-width. *Check:* page serves; manual pass at 1280 and
   390 px, light and dark.
10. **New quest.** The four steps: typeahead + recent, unpushed warning, class
    tiles with repo default, level tiles, PARTY MODE / AUTO-PLAY switches. Deletes
    the old create form, model select and conventions preview. *Check:* manual
    pass; one server test for `party`/`autoPlay` passthrough.
11. **Thread page (your move + questing) + reader.** Head, YOUR MOVE panel, clamped
    document, reader popup, note box with the state-aware buttons, PAUSE / QUEUE
    NOTE, details (prompt, changes, stage runs, log, notes, info). Deletes the tab
    panel, Log tab machinery and poll guards. *Check:* success criteria 1–3.
12. **Quest stats + log + Victory.** Stats tiles and per-stage table, quest log,
    the Victory layout for merged threads. *Check:* criteria 8–9.
13. **Options.** Roster with usage and sparkline, edit form, recruit/dismiss,
    GAME RULES, raw editor panel; deletes the settings modal. *Check:* criterion 10.
14. **Cut-first bucket** (§5.11): HUD LV/XP/streak + `/api/hud`, reward tile, now
    playing, trail, Sprout poses.

## 10. Success criteria

1. Away for a day, opening `#/` shows every thread at a gate or with an open PR
   under **YOUR MOVE**, each with its action line. Nothing needs a click to find out.
2. Opening a spec-gated thread shows the spec clamped with READ ALL ▶; **CONTINUE
   ▶** starts the build; the card moves to QUESTING with "Running CRAFT · 0m".
3. A note sent with RETRY STAGE revises the same stage and comes back to the gate.
4. After build, **SHIP IT** on a GitHub repo and an Azure repo creates both PRs;
   the card shows "Merge PR #n on …". Merging both moves it to HALL OF FAME within
   one poll; three days later it leaves the inbox and is still reachable by URL.
5. With `gh` renamed away, pushing lands the thread in HALL OF FAME as "pushed ·
   merge not tracked" and nothing errors.
6. With an unpushed commit in a repo's `path:` checkout, New quest warns under it.
7. GAME OVER on a gate thread moves it to the bin; CONTINUE? puts it back at the
   same gate. An out-of-tokens thread restored with CONTINUE? runs again.
8. A thread started with AUTO-PLAY at SCOUT reaches an open PR with no click and
   stops there; with PARTY MODE off its log shows no Task/Agent calls.
9. QUEST STATS for a finished thread shows model, time, turns, tokens in/out,
   tools, subagents, files and test runs per stage, matching the log; the window
   tile shows ≈ only when `window_usd` is set.
10. Editing a repo's test command in Options rewrites only that block of
    `repos.yaml`; comments elsewhere survive; the next quest's prompt uses it.
11. Every screen is usable at 390 px without horizontal scroll.

## 11. Open questions

1. **Does an open PR count as "needs you"?** *Resolved by the mockups:* yes,
   YOUR MOVE "Merge PR #n on GitHub". Cost: a work PR waiting on reviewers sits
   there for days. Revisit if that gets noisy (e.g. move PRs older than a day to
   QUESTING).
2. **Model selector?** *Resolved:* back, as class tiles defaulting to the repo's
   `default_model`.
3. **`path:` by hand, or auto-discovered?** *Default:* by hand (now also editable
   in Options).
4. **No CLI: allow a manual "mark merged"?** *Default:* no; pushing to an
   untracked host goes to HALL OF FAME as "pushed · merge not tracked".
5. **PR closed without merge: bin or YOUR MOVE?** *Default:* GAME OVER ("PR closed
   without merge"), restorable.
6. **paused-limit unstuck?** *Resolved:* it is binned as "out of tokens";
   CONTINUE? resumes with `tokensUsed` reset to 0.
7. **PUSH FIRST on New quest** pushes the user's own checkout. *Default:* not
   built; the warning says "push first". Building it would make petree push from a
   checkout it doesn't own, possibly a feature branch.
8. **Q-number "from the thread id"**: the brief asked for it deterministic from the
   id; a 3-digit hash collides around 45 threads. *Default:* stored sequence
   `seq`, stable per database. Say if it must be reproducible from the id alone.
9. **Comment-preserving YAML edits** need eemeli's `yaml` package (a new
   dependency). *Default:* text splice, anchored blocks read-only in the form.
10. **Ending a SCOUT-only quest**: there is no "finish here" button, so a quest
    that only wanted findings ends via GAME OVER ("dropped by you") and counts as
    lost in usage. *Default:* accept; add an END QUEST → HALL OF FAME button if it
    skews the stats.
11. **Failed straight to GAME OVER** hides a transient failure from YOUR MOVE.
    *Default:* as asked; the GAME OVER count shows in the inbox and CONTINUE?
    retries in one click.
