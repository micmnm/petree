# Petree Interview Questionnaire — Ask First, Then Write

**Date:** 2026-11-14
**Status:** Draft, waiting on the open questions (§11). Screens get built after those are answered.
**Builds on:** `docs/superpowers/specs/2026-11-13-petree-thread-inbox-design.md` (the "inbox spec"),
branch `inbox-engine`. Visuals follow `docs/design/handheld-arcade.md`.
**Mockups:** not built yet. `docs/design/interview-mockups.html` will follow once §11 is answered;
§5.1 lists the screens it must show.

## 1. Intent

Today SCOUT and PLAN run once each. The agent writes findings or a spec, and the user answers
with one free-text note (RETRY STAGE / CONTINUE). Real investigation and spec work is an
interview: the model asks, the user answers, and only then does the model write. Petree should
support that without turning a thread into a chat. Before writing, the agent sends **one batch
of questions**, each with its own guess and a short "why I'm asking". The user fills in a form
with the guesses already filled in and sends every answer at once. The agent then writes the
document. Threads run with the user's own `~/.claude` skills, so they ask and write the way the
user's own sessions do.

## 2. Goals

1. **Questionnaire gate**: at SCOUT and PLAN, the agent can stop with 4–8 questions in
   `_thread/questions.json` instead of a document. The thread shows them as a form with the
   guesses filled in.
2. **One send**: SEND ANSWERS (or accept the guesses, or skip) resumes the same session with
   all answers in one structured note. The agent then writes the document.
3. **Inbox**: a waiting questionnaire is YOUR MOVE. Its card shows the first question with the
   agent's guess, how many more there are, and a quick ACCEPT GUESSES.
4. **Kept, not lost**: answered questions stay visible later, both in the stage document's
   ANSWERS block and in the quest log, and the agent records them in the document itself.
5. **Quest option**: an INTERVIEW switch, on by default, next to PARTY MODE / AUTO-PLAY.
   AUTO-PLAY never waits on a questionnaire.
6. **User skills in the sandbox**: personal and plugin skills from the host's `~/.claude` are
   mounted read-only, so `interview-me`, `brainstorming`, `spec-driven-development` and others
   are there.

## 3. Non-goals

- One-question-at-a-time chat, live back-and-forth, or answering while a turn is running.
- Questions at CRAFT. The build prompt keeps "make a reasonable call and list open questions".
- Editing questions or adding your own questions in the form (the note box covers "you
  forgot to ask about X").
- Changing INTERVIEW after the quest is created (same as PARTY MODE / AUTO-PLAY).
- Mounting anything from `~/.claude` other than skills (CLAUDE.md, rules, settings, hooks,
  MCP servers, agents, commands). See open question 11.
- New task states, new routes, new tables.

## 4. Constraints

- **Reuse the engine**: the `waiting-for-you` gate, `followUp`, `POST /next`, session resume
  (`--resume` in `buildSandboxCommands`), the `contained()` + `readCapped()` reader, the
  status-file freshness rule (mtime ≥ `startedAt`), `cardFor`, the dashboard `tile()` pickers
  and `#thMove` note box. No new dependencies; validation is hand-written, like
  `readThreadStatus`.
- Everything the agent writes is untrusted. The questions file is size-capped, read with no
  follow and no blocking, validated field by field, clipped, and always escaped when rendered.
- Mounts stay read-only for anything that comes from the host. The sandbox still never sees
  git, `gh` or `az` credentials.
- Phone: every new screen works at 390 px.

## 5. Design

### 5.1 Screens

All screens below need a mockup. Layout details that depend on §11 are marked with the
question number.

#### (a) New quest: RULES OF PLAY

A third switch in `#nqSwitches`, after AUTO-PLAY, built with the existing `sw()` helper:

- **INTERVIEW** — "ask you a few questions before findings and spec; guesses filled in".
  Default **ON** (`nq.interview = true`, also reset to true after PRESS START).
- When STARTING LEVEL is CRAFT the switch is shown disabled with "only SCOUT and PLAN ask".
  The request still sends the value, and the engine ignores it at build.
- The line under the switches (`#nqAuto`) gets one more sentence:
  - INTERVIEW on, AUTO-PLAY off: "SCOUT and PLAN each start with a short questionnaire for you."
  - INTERVIEW on, AUTO-PLAY on: "The party still writes its questions down, but takes its own
    guesses and keeps going. You'll see them in the quest log." (§5.7, open question 2)
- Footer summary gains "· interview" when on.

#### (b) Thread page, questionnaire waiting (desktop 1280)

Same page as inbox spec §5.1(b), with these differences while a questionnaire waits (§5.2):

1. **YOUR MOVE! panel**: `card.action.label` "Answer 6 questions before the spec"
   (SCOUT: "…before the findings"), who/when as today, plus "round 1 of 2" (open question 1).
2. **Document section** becomes **THE PARTY ASKS** (`#thAsk`, replacing the `#thDoc` content).
   It opens with `intro` if the agent wrote one, then one block per question:
   - A Q-number chip (`Q1`), the question as a heading, and `why` as a small hint line
     ("why: decides whether POST calls need an idempotency key").
   - The input, by kind, reusing the New quest `tile()` pickers:
     - `choice`: radio tiles, plus an "Other…" tile with a text input when `allowOther`.
     - `multi`: checkbox tiles (+ Other…).
     - `yesno`: two tiles, YES / NO.
     - `number`: `<input type="number">` with `min`/`max`/`step` and the unit as a suffix.
     - `text`: a textarea (3 rows, grows).
   - The guess is filled in and tagged **GUESS**. Once the user changes it, the tag turns to
     **YOURS** and a small "reset to guess" link appears. A question without a valid guess is
     tagged **NEEDS AN ANSWER** and starts empty.
   - Answers are drafted in `localStorage` under `petree-ask:<id>:<startedAt>`. The 3 s poll
     paints the form only when that key changes, so typing is never wiped.
   - Earlier documents (e.g. findings, while PLAN asks) stay collapsed below, as today.
3. **YOUR NOTE TO THE PARTY** stays as it is. The note goes with whichever button is pressed
   and arrives as "Note from the user" under the answers (§5.5).
4. **Buttons** (`thMoves` gets a new first branch). Which buttons exist is open question 7.
   The recommended set is:

   | slot | button | does |
   |---|---|---|
   | primary | **ACCEPT ALL GUESSES ▶** "nothing changed · write the spec" when no answer differs from its guess, otherwise **SEND ANSWERS ▶** "2 changed · write the spec" | `POST /next {answers: {...}}` |
   | quiet | **SKIP** "just write it · use your guesses" | `POST /next {answers: 'skip'}` |
   | quiet | **GAME OVER** | `POST /drop`, as today |

   The primary button is disabled while a NEEDS AN ANSWER question is empty, and says which
   one ("answer Q4 first"). There is no RETRY STAGE, QUEST COMPLETE or "skip to CRAFT" at a
   questionnaire gate (open question 13).

#### (c) The same at phone width (390 px)

One column. Each question block stacks: chip + question, then why (one line, clamped), then
the tiles in a single column. Number and text inputs are full width. The buttons stack
primary, quiet. The YOUR MOVE panel moves above the form, as on the gate page today.

#### (d) Inbox: YOUR MOVE card with a question

The cartridge card's YOUR MOVE! block, when `card.ask` is set (open question 6):

```
YOUR MOVE!  Answer 6 questions before the spec
Q1 · Which REST tasks should retry?
GUESS ▸ Idempotent methods only (GET, PUT, DELETE)
+5 more                                  [ ACCEPT GUESSES ]
```

- The question is clamped to 2 lines, the guess to 1 line.
- **ACCEPT GUESSES** shows only when every question has a guess (`card.ask.allGuessed`).
  How it confirms is open question 5 (recommended: two taps, where the first tap turns it into
  "SURE? 6 GUESSES ▶" for 4 s). It sends `POST /next {answers: 'guesses'}`.
- Typing any custom answer means opening the card, which goes to `#/t/<id>` as today.
- **Markup change**: the card is an `<a>` today, and a `<button>` inside an `<a>` is invalid
  HTML. The card becomes a `<div class="cart">` holding a stretched link (`.cart-link::after
  { inset: 0 }`), with the button above it (`position: relative; z-index: 1`). The rest of the
  card renders as before.

#### (e) Later stage: answered Q&A recap

On the thread page, under each stage document whose stage ran a questionnaire, there is a
collapsed `<details>`:
**PLAN · 6 ANSWERS · 2 changed**. Opened, it lists each question, the final answer, and either
"guess kept" or "changed · guess was: 3 attempts". A skipped round reads "skipped · the party
used its guesses", and an AUTO-PLAY round reads "AUTO-PLAY took the guesses". Round 2, when
there was one, follows as "PLAN · ROUND 2 · 3 ANSWERS". The source is `Turn.interview`
(§5.6), so the recap survives the agent overwriting `questions.json`.

The quest log gets two entry kinds: "Asked 6 questions · PLAN" (at the end of the question
turn) and "You answered · 2 changed, 4 guesses kept" / "Accepted the guesses" / "Skipped the
questions" / "AUTO-PLAY took the guesses" (at the follow-up).

#### (f) QUESTING: preparing questions

While a question turn runs (`interviewPhase` is `ask` or `ask-again`, §5.4):

- The card line reads "Preparing questions · PLAN · 3m" instead of "Running PLAN · 3m".
- The thread page document placeholder reads "The party is reading the code, then writing
  questions for you… (3 min)", with the previous stage's document below, as today.
- PAUSE and QUEUE NOTE work as today. A queued note is folded into the next turn: the write
  turn when it comes after a questionnaire, or the round-2 turn.

### 5.2 Card data contract changes (`src/inbox.ts`)

`cardFor(task, status, cfg, now)` gains a parameter: `cardFor(task, status, cfg, now, asked)`,
where `asked` is the validated questionnaire (§5.3) or `null`. `withCard` in `server.ts`
reads it only when `task.state === 'waiting-for-you'` and `interviewPhase(task)` is `ask` or
`ask-again`. That is the same freshness rule as the status file, and costs one capped read per
waiting thread per poll.

**A questionnaire is waiting** when all of the following hold: `asked !== null`, the state is
`waiting-for-you`, the stage is `investigate` or `spec`, and the phase is `ask` / `ask-again`.
With phase `auto` (AUTO-PLAY) a questionnaire never waits.

New field:

| field | how it is produced |
|---|---|
| `card.ask` | `null`, or `{ stage, round: 1 \| 2, total, first: { q, guess }, allGuessed }` when a questionnaire is waiting. `first.q` is the first question clipped to 140 characters. `first.guess` is the guess rendered as text (option label(s), "yes"/"no", number + unit, text clipped to 80), or `null`. |

Changed rows:

| where | change |
|---|---|
| §5.2.1 state line | New row before "waiting-for-you": questionnaire waiting → "<N> questions before the <findings\|spec>". Running with phase `ask`/`ask-again` → "Preparing questions · <LEVEL> · <m>m". |
| §5.2.2 YOUR MOVE | New first row: questionnaire waiting → `action.label` "Answer <N> questions before the <findings\|spec>", `detail` = `status.needsYou` as today. |
| `card.summary` | Unchanged (agent status when fresh). |
| §5.2.3 progress | Unchanged: the stage is `current` with tone `needs-you`. |

The `(N) Petree` tab count includes questionnaire gates automatically, because they are
YOUR MOVE.

### 5.3 The questions file (`src/notes.ts`)

**File**: `/work/_thread/questions.json` (`<workDir>/_thread/questions.json` on the host),
next to `status.txt`. It is never committed (the `_thread/` rule).

**Schema** (the agent writes this; the TS types describe the result after validation):

```ts
type Kind = 'choice' | 'multi' | 'yesno' | 'number' | 'text'

interface Option { id: string; label: string }          // id: /^[a-z0-9-]{1,16}$/, label ≤ 80

interface Question {
  id: string               // /^[a-z0-9-]{1,32}$/, unique in the file
  kind: Kind
  q: string                // the question, 1..200 chars
  why: string              // why it matters, ≤ 160 (missing → '')
  options?: Option[]       // choice | multi only: 2..6, unique ids
  allowOther?: boolean     // choice | multi: offer an "Other…" free-text answer
  unit?: string            // number only, ≤ 12 ("attempts", "ms")
  min?: number; max?: number; step?: number   // number only, finite, min ≤ max
  guess: string | string[] | boolean | number | null
    // choice: option id · multi: option ids (0..n) · yesno: boolean
    // number: finite, within min..max · text: string ≤ 500 · null = no guess
}

interface Questionnaire {
  round: 1 | 2             // set by petree from the phase, never trusted from the file
  intro: string            // ≤ 200, optional one line: "Before I write the spec…"
  questions: Question[]    // 1..8 (round 2: 1..4)
  dropped: string[]        // why questions were dropped: "q7: unknown kind 'scale'"
}
```

Example the prompt shows the agent (trimmed):

```json
{
  "intro": "Before I write the retry spec, six things the code can't tell me.",
  "questions": [
    { "id": "scope", "kind": "choice", "q": "Which REST tasks should retry?",
      "why": "Retrying a POST can double-charge unless it has an idempotency key.",
      "options": [ { "id": "idem", "label": "Idempotent methods only (GET, PUT, DELETE)" },
                   { "id": "all", "label": "All methods, POST with an idempotency key" } ],
      "allowOther": true, "guess": "idem" },
    { "id": "attempts", "kind": "number", "q": "How many attempts at most?",
      "why": "Sets the worst-case latency of a failing task.", "unit": "attempts",
      "min": 1, "max": 10, "guess": 3 },
    { "id": "on-429", "kind": "yesno", "q": "Honour Retry-After on 429 and 503?",
      "why": "Some upstreams send hours; we may want a ceiling.", "guess": true }
  ]
}
```

**Reading**: `readThreadQuestions(workDir, since, round)` in `notes.ts`, built like
`readThreadStatus`:

- `contained(p, workDir)`, then `readCapped(p, QUESTIONS_MAX = 32 KiB)` (no follow, no block,
  regular files only). Then `mtimeMs ≥ Date.parse(since)`, so a file left over from an earlier
  turn or stage is ignored.
- `JSON.parse`. A parse failure returns `null` with no throw, and the reason is kept for
  Info (§8).
- **Validation salvages per question**: a question that breaks its rules (unknown kind, bad or
  duplicate id, missing `q`, options missing or out of range for choice/multi, `min > max`) is
  dropped and listed in `dropped`. A bad **guess** does not drop the question; the guess becomes
  `null` (NEEDS AN ANSWER). Strings are trimmed and clipped to their caps. Unknown fields are
  ignored. Beyond the cap (8, or 4 in round 2) the first N are kept, with the rest listed in
  `dropped` (open question 14).
- If no question survives, the result is `null`.

**Serving**: `GET /api/tasks/:id/thread` adds `questions: Questionnaire | null` (only while one
is waiting, §5.2) and `interview: InterviewRecord[]` for the recap (§5.6).

### 5.4 Prompt (`src/prompt.ts`)

**Phase**: a pure `interviewPhase(task): 'off' | 'ask' | 'ask-again' | 'auto' | 'write'`.

- `off` when `!task.interview` or the stage is `build`.
- `visit` is the trailing archived turns whose `stage === task.stage`, i.e. this stage's turns
  so far. The turn that moved the thread here is archived under the previous stage, so it isn't
  counted.
- `visit` empty → `task.autoPlay ? 'auto' : 'ask'`.
- Last `visit` turn has `interview.round === 1` and `how` is `answered` or `guesses` →
  `ask-again` (open question 1).
- Anything else → `write`. That covers after round 2, after a skip, and a RETRY STAGE once a
  document exists (open question 15).

`composePrompt` swaps the stage section by phase. `write` and `off` keep today's
`STAGE_INSTRUCTIONS`. In `write`, after a questionnaire, it also adds the line "Record the
user's answers from this thread under a `Decisions` heading in the document."
`DOC` = `findings.md` (investigate) or `spec.md` (spec), and `the document` = "findings" or
"spec".

**`ask`** (replaces the stage's "Do not ask interactive questions" instructions):

```
## Stage: spec — interview first

Before you write the spec, interview the user with ONE questionnaire.

1. Explore first: read the repos, `/work/_thread/findings.md` if present, and this thread,
   so you only ask what the code and the thread cannot tell you. Do not modify repo files.
2. If the `interview-me` skill is available, use it to decide what to ask
   (`brainstorming` and `spec-driven-development` may help too). Its one-question-at-a-time
   rule does not apply here: petree shows all your questions in one form and sends back all
   the answers at once.
3. Ask 4 to 8 questions (never more than 8) whose answers would change what you write.
   Give each your best guess and one short line on why you ask. Prefer choice, multi,
   yesno and number over text. Never ask something this thread already answered.
4. Write them to `/work/_thread/questions.json` in exactly this shape: <schema example §5.3>
5. Then stop. Do not write `/work/_thread/spec.md` this turn. In status.txt set
   needs-you to "Answer <N> questions".

If nothing is worth asking, do not write questions.json: write the spec now, following
the normal instructions: <today's STAGE_INSTRUCTIONS[stage]>
```

For SCOUT, step 1 reads "Explore the repos and the question first; do not modify any repo
files", and the document is the findings.

**`ask-again`** (in front of the stage instructions):

```
## Stage: spec — your questions were answered (above)

Write the spec now, following the instructions below, and record the answers under a
`Decisions` heading. Only if an answer opened a NEW question that blocks the spec, write
a second `/work/_thread/questions.json` instead (at most 4 questions, same shape) and stop;
there will be no third round.
```

**`auto`** (AUTO-PLAY, recommendation in open question 2):

```
## Stage: spec — interview, AUTO-PLAY

Steps 1–4 of a normal interview (as above), with a guess for EVERY question. AUTO-PLAY is
on, so nobody will answer: treat each guess as the answer, then write the spec in this same
turn, listing the guesses under `Decisions` marked "assumed (AUTO-PLAY)". Keep needs-you
"nothing" unless you are truly blocked.
```

**Skills section** (fixed, at every stage, only when §5.8 mounted any skill, placed before the
status section):

```
## Your skills

The user's own skills are available read-only. Some assume tools this sandbox does not
have (MCP servers, a browser, local model CLIs, files on the user's machine): skip those
steps and say so in your final message. Never copy skill text into repo files, documents,
commits or PRs.
```

### 5.5 How answers travel back (`src/server.ts`, `src/store.ts`)

**Route**: the existing `POST /api/tasks/:id/next` gains one optional body field:

```ts
answers?: Record<string, Answer> | 'guesses' | 'skip'
// Answer by kind:
//   choice → option id, or { other: string ≤ 500 }   (other only when allowOther)
//   multi  → option ids[], optionally { picks: ids[], other: string ≤ 500 }
//   yesno  → boolean     number → finite, within min..max     text → string ≤ 2000
```

With `answers` present, the route:

1. Requires a waiting questionnaire (§5.2), else 409 "no questions waiting".
2. Requires `stage` to be omitted or equal to `task.stage`, else 400.
3. Re-reads the questionnaire through `readThreadQuestions` (never trusts the client's copy).
   `'guesses'` uses every guess; it is 400 if any question has none. `'skip'` sends no answers.
   For an object, unknown ids are 400, a missing id takes its guess (400 when there is none),
   and each value is validated against its question's kind (400 "Q4: pick one of …").
4. Builds the `InterviewRecord` (§5.6) and the prompt below, then calls
   `store.followUp(id, prompt, undefined, task.stage, record)`. `followUp` folds in pending
   comments as today, keeps `sessionId`, and requeues. The launcher's existing `--resume`
   continues the same conversation, so the agent still has its own exploration and its
   questions in context.

The `prompt` body field stays the user's free-text note. It is appended after the answers.

**The structured note** (`renderAnswers(record, note)`, pure):

```
## Answers to your questions (PLAN, round 1)

The user answered in petree's form. "guess kept" means they left your guess as it was.

1. [scope] Which REST tasks should retry?
   Answer: Idempotent methods only (GET, PUT, DELETE) — guess kept
2. [attempts] How many attempts at most?
   Answer: 5 attempts — changed (your guess: 3 attempts)
3. [on-429] Honour Retry-After on 429 and 503?
   Answer: yes — guess kept
4. [jitter] Which jitter strategy?
   Answer: other: "full jitter, like the AWS guidance" — changed (your guess: Equal jitter)

## Note from the user

Also cap total retry time at 2 minutes.
```

Variants: `'guesses'` uses the header line "The user accepted all your guesses." and lists them
the same way. `'skip'` sends only "The user skipped your questions. Use your guesses as the
answers, write the <document> now, and list them under `Decisions` as assumed." Text answers
longer than one line are indented as a block. The stage section (§5.4, phase `ask-again` or
`write`) follows, as composed at launch.

**Why `/next`**: it is already "archive this turn, requeue with a prompt, same or moved
stage", with the 409s for binned and running threads. A new `/answers` route would repeat all
of that.

### 5.6 Where answered Q&A stays visible (`src/store.ts`)

`Turn` gains an optional field. It lives in the `turns` JSON column, so no migration is needed:

```ts
interface InterviewRecord {
  stage: Stage
  round: 1 | 2
  questions: Question[]                  // the validated questionnaire as asked
  answers: Record<string, Answer>        // final answers; {} when skipped
  how: 'answered' | 'guesses' | 'skipped' | 'auto'
  changed: number                        // answers that differ from the guess
}
interface Turn { /* … */ interview?: InterviewRecord }
```

- `followUp(id, prompt, model?, stage?, interview?)` stores `interview` on the turn it
  archives. That is the question turn, so its `result` (the agent's final message) sits next to
  it.
- Readers: the recap (§5.1e) and the quest log entries (§5.1e). Both come from `turns`, with
  nothing else stored.
- **The document carries it forward**: the `ask-again` / `write` / `auto` prompts tell the
  agent to record the answers under `Decisions` in findings/spec. CRAFT reads the spec, so the
  build sees the decisions even if session resume fails, and PARTY MODE subagents see them too
  (they don't share the session).
- An engine-written `_thread/answers.md` was rejected: it would be the first host write into
  the agent's `_thread/` outside the notes flow, and the document plus the session already
  carry the answers.

### 5.7 Quest option and AUTO-PLAY (`src/store.ts`, `src/server.ts`, `src/launcher.ts`)

- **Column**: `interview INTEGER NOT NULL DEFAULT 0`, added in the same migration loop as
  `party` / `auto_play`. Existing threads read as off and never change behaviour mid-quest.
- **Request**: `POST /api/tasks` accepts `interview` (boolean; 400 otherwise, like
  `party`/`autoPlay`). It defaults to **true** when omitted (open question 4). `store.create`
  takes `interview?: boolean`. `rowToTask` maps `interview: r.interview === 1`.
- **Shown** in Details › Info as "INTERVIEW on/off", next to PARTY MODE and AUTO-PLAY.
- **AUTO-PLAY** (recommendation; options in open question 2): the agent asks and writes in
  one turn (phase `auto`, §5.4), so AUTO-PLAY costs no extra turn. In the launcher's
  `autoPlay(id)`, the `waiting-for-you` branch reads `readThreadQuestions(workDir, startedAt,
  1)` first. When questions exist, it builds an `InterviewRecord` with `how: 'auto'` and
  answers = guesses, then calls `store.followUp(id, '', undefined, next, record)`. When there
  are none, it moves on as today. The existing rule still stops AUTO-PLAY when `needsYou` is set.
- **PARTY MODE**: no interaction. Questions are asked by the lead agent.

### 5.8 Skills mount (`src/sandbox.ts`, `src/config.ts`)

**Today** (`buildSandboxCommands`): `~/.petree/shared/skills → /home/dev/.claude/skills:ro`,
nested inside the rw session mount `~/.petree/sessions/<id> → /home/dev/.claude`. README step 5
copies the agent-skills plugin's skills into `shared/skills` by hand. `repos.yaml` per-repo
`skills:` is parsed (`config.ts`) but never used. It stays untouched, because it was meant for
repo-local skills.

**Constraints found**:
- `installed_plugins.json` records each plugin's `installPath` as an **absolute host path**
  (`/Users/<you>/.claude/plugins/cache/<marketplace>/<plugin>/<version>`). Mounting
  `~/.claude/plugins` as it is gives a container whose plugin records point nowhere.
- A bind mount can't exclude a subdirectory, so excluding single skills needs one mount per
  skill.
- Per-skill mounts can't be nested under the existing read-only `/home/dev/.claude/skills`.
  Docker would have to create mount points inside a read-only bind (and so on the host, in
  `shared/skills`).
- Claude Code loads `.claude/skills/<name>/SKILL.md` from every `--add-dir` directory
  (code.claude.com/docs/en/skills, "Skills from additional directories"). Verify this on the
  CLI version in the sandbox images (PR 4).

**Design**: one extra root, `/petree/skills`, with one read-only bind per skill and one
`--add-dir`:

```
-v <src>:/petree/skills/.claude/skills/<name>:ro      (one per skill)
claude … --add-dir /petree/skills
```

`skillMounts(cfg, claudeHome)` builds the list at launch. `claudeHome` is
`$CLAUDE_CONFIG_DIR` or `~/.claude` on the host. Sources, in precedence order (first name wins):

1. `~/.petree/shared/skills/*`: these names are only reserved, because that directory keeps its
   own mount.
2. **Personal**: each `<claudeHome>/skills/<name>/` that holds a `SKILL.md`. Entries without
   one are skipped; that includes `synced/`, which nests claude.ai-synced skills one level down
   (open question 16). Symlinked skill directories work, because Docker resolves a bind
   source on the host. (README step 5's warning was about symlinks inside a mounted tree.)
3. **Plugins**: for each key in `installed_plugins.json` (`version: 2`, `plugins[key][0]
   .installPath`) that `<claudeHome>/settings.json` `enabledPlugins[key]` sets to `true`, each
   `<installPath>/skills/<name>/SKILL.md`. Only `skills/` is mounted, never the plugin's
   hooks, MCP servers, agents or commands (open question 9). Plugin skills lose their
   `plugin:` prefix inside the sandbox.

Dropped from the list (no error): excluded names (config below), names already taken (open
question 12), and anything whose `SKILL.md` is unreadable. A missing or unparseable
`installed_plugins.json` / `settings.json` means no plugin skills. When the list is empty, no
`--add-dir` is added and the prompt's skills section is left out.

**Config** (`repos.yaml`, parsed in `config.ts`):

```yaml
defaults:
  claude_skills:            # host ~/.claude skills mounted read-only into every sandbox
    personal: true          # ~/.claude/skills
    plugins: true           # skills/ of enabled plugins
    exclude: [some-work-skill, a-skill-needing-a-local-llm]   # skill directory names
# or: claude_skills: false  (nothing from ~/.claude)
```

The default when the key is absent is `{ personal: true, plugins: true, exclude: [] }`, per the
user's decision. Open question 10 covers whether that default holds.

**Risks**:

| risk | what happens | mitigation |
|---|---|---|
| Personal or work data in skills | Every mounted skill's name and description is in the model's context each turn. A skill's body is read when the agent uses it. The agent could quote skill text into a spec, a commit or a PR on a public repo. | `exclude`; the prompt's skills section forbids copying skill text into outputs; mounts are read-only. Context goes to the same account as the host sessions, so there is no new recipient, but the PR is a new audience. |
| Writes | Every skill mount is `:ro`. The session dir stays rw as today, and the agent can create files under `/petree/skills/.claude` only in the container layer, which is gone with the container. | None needed. Covered by a sandbox test that every new `-v` ends in `:ro`. |
| Skills that assume missing tools | Skills that call MCP tools (context7, figma, playwright), a local LLM CLI, a browser, or host paths fail inside the sandbox. | The prompt's skills section ("skip and say so"); `exclude` for repeat offenders; no MCP or hooks are mounted. |
| Context cost | Around 80 skill descriptions is a few thousand tokens per turn (mostly cache reads). | Accepted; `exclude` trims it. |
| Name clashes | The same name exists in personal and plugin skills, or in two plugins. | First wins, in the order above; skipped names listed (open question 12). |
| Version drift | A plugin updated on the host changes mid-quest skills on the next turn. | Accepted. Same as the user's own sessions. |

The README's step 5 becomes optional ("only for skills you don't have in `~/.claude`").

## 6. What is reused, changed, or added

| piece | fate |
|---|---|
| Task states, `TRANSITIONS`, `waiting-for-you` gate | **Reused**, nothing new. A questionnaire is a gate with a different payload. |
| `POST /next`, `followUp`, comment folding, `--resume` | **Reused**; `/next` gains `answers`, `followUp` gains `interview`. |
| `readCapped`, `contained`, mtime ≥ `startedAt` freshness | **Reused** by `readThreadQuestions`. |
| `cardFor` | **Changed**: one parameter, one field, two rows. |
| `composePrompt`, `STAGE_INSTRUCTIONS` | **Changed**: `interviewPhase` picks a variant; the skills section is added. |
| Launcher `autoPlay` | **Changed**: records the AUTO-PLAY interview. |
| `buildSandboxCommands` | **Changed**: per-skill `:ro` mounts and `--add-dir`. |
| `GET /thread` | **Changed**: `questions`, `interview`. |
| Dashboard `tile()`, `sw()`, `thMoves`, `#thMove`, card | **Reused**/extended. The card's `<a>` becomes a stretched link (§5.1d). |
| New | `interview` column, `Turn.interview`, `readThreadQuestions` + validator, `renderAnswers`, `interviewPhase`, `skillMounts`, `claude_skills` config. No routes, tables or dependencies. |

## 7. API changes (`src/server.ts`)

Changed:
- `POST /api/tasks`: accepts `interview` (boolean, default `true`).
- `GET /api/tasks[/:id]`: each task gains `interview`; `card.ask` (§5.2); turns may carry
  `interview`.
- `GET /api/tasks/:id/thread`: adds `questions` (waiting questionnaire or `null`), `interview`
  (all `InterviewRecord`s, in turn order), and `questionsError` (parse error or `dropped`
  reasons, for Info).
- `POST /api/tasks/:id/next`: accepts `answers` (§5.5). It returns 409 "no questions waiting"
  when it is given without a waiting questionnaire, 400 on a stage move together with
  `answers`, and 400 per invalid answer.

New: none. Unchanged: everything else.

## 8. Error handling

- **questions.json missing, stale (mtime < `startedAt`), oversize, not JSON, or empty after
  validation**: no questionnaire. The gate falls back to today's document gate. The document is
  `findings.md`/`spec.md` if the agent wrote one, otherwise the turn's result (today's
  fallback), with CONTINUE / RETRY STAGE as usual. The panel adds "The party's questions
  couldn't be read: <reason>" from `questionsError`. Never a card error. (Auto-retrying the turn
  is open question 14.)
- **Some questions invalid**: the valid ones are shown, with "2 questions couldn't be read" and
  the reasons in Info.
- **Invalid guess**: that question is NEEDS AN ANSWER, and ACCEPT GUESSES is hidden on the card
  and disabled on the page.
- **Agent writes both questions and the document in an `ask` turn**: the questionnaire wins
  (the document stays as the "previous" doc until the write turn overwrites it).
- **Agent writes questions in a `write` turn** (after round 2, or a third round): ignored,
  because the phase doesn't allow it. The gate is a document gate.
- **Two tabs send answers**: the second `/next` gets 409 (the state is no longer
  `waiting-for-you`), as for any double gate action today.
- **Session transcript missing on resume**: the launcher already starts a fresh session. The
  follow-up prompt holds every question with its answer, and the original task prompt is in
  `turns[0]`, so the write turn still works.
- **Skills**: an unreadable `~/.claude`, a missing plugin path, or an unparseable JSON file
  means those skills are skipped with no launch failure. A Docker bind failure (e.g. the path is
  not shared with Docker Desktop) fails the turn with Docker's message, as any mount failure
  does today.

## 9. Delivery as small PRs

Each one ships on its own and fits one petree task. PRs 1–4 are engine changes that the current
dashboard tolerates; 5–6 are the UI.

1. **Questions file.** Types, `parseQuestions` (salvage rules), `readThreadQuestions`;
   `questions`/`questionsError` on `GET /thread`. *Tests:* each kind valid; each drop rule;
   bad guess → null; caps (8 / 4, 32 KiB); stale mtime; symlink escape; FIFO; non-JSON.
2. **Interview option + prompt.** `interview` column/request/Info; `interviewPhase`;
   `composePrompt` variants `ask` / `ask-again` / `auto` / `write`. *Tests:* phase table
   (first turn, after round 1, after round 2, after skip, retry after doc, back-move, build,
   off, autoPlay); prompt contains/omits the right section; existing rows read off; API
   default on.
3. **Answers path + cards.** `/next` `answers` validation; `renderAnswers`; `Turn.interview`
   via `followUp`; `cardFor` `ask`, line and action rows; AUTO-PLAY record in `autoPlay`.
   *Tests:* each answer kind valid/invalid; `'guesses'` with a missing guess → 400; 409
   without a questionnaire; stage move + answers → 400; rendered note snapshot; card table
   cases; AUTO-PLAY with the fake runner records `how: 'auto'` and moves on without a gate.
4. **Skills mount.** `claude_skills` config; `skillMounts` (personal, enabled plugins,
   exclude, precedence, `SKILL.md` check); per-skill `:ro` mounts and `--add-dir`; skills
   prompt section; README step 5. *Tests:* temp `claudeHome` fixture → exact `-v` list;
   all `:ro`; disabled plugin skipped; collision order; `claude_skills: false` → no flags.
   *Manual:* one real thread lists the mounted skills in its init event and uses `interview-me`.
5. **New quest switch.** INTERVIEW switch, CRAFT-disabled state, restated line, summary.
   *Check:* manual pass; server test for `interview` passthrough.
6. **Questionnaire UI.** Thread form (`#thAsk`, the kinds, GUESS/YOURS, draft, poll-safe
   paint), buttons per open question 7, inbox card block + ACCEPT GUESSES + stretched-link
   card markup, QUESTING line, recap details and quest log entries; phone layout.
   *Check:* the mockups (built after §11), 1280 and 390 px, light and dark; success criteria 1–5.

## 10. Success criteria

1. A new quest at SCOUT with INTERVIEW on (the default) stops at YOUR MOVE with 4–8 questions.
   The inbox card shows Q1 with its guess and "+N more" without opening the thread.
2. On the thread page every question shows its guess and why. Changing two answers and
   pressing SEND ANSWERS resumes the same session (same `sessionId`). The findings that come
   back carry a `Decisions` section matching the answers.
3. ACCEPT GUESSES on the card sends the guesses without opening the thread; the card moves to
   QUESTING.
4. After CONTINUE to PLAN, PLAN asks again but repeats none of SCOUT's questions. After the spec
   is written, PLAN · ANSWERS and SCOUT · ANSWERS are both visible on the thread page, and the
   quest log shows both rounds.
5. SKIP writes the document with the guesses listed as assumed.
6. With AUTO-PLAY on, a quest goes SCOUT → PLAN → CRAFT → PR with no stop for questions, and
   the quest log shows "AUTO-PLAY took the guesses" for SCOUT and PLAN.
7. A garbled `questions.json` never breaks the card; the gate falls back to the document or
   result with a "couldn't read the questions" line.
8. A quest with INTERVIEW off behaves exactly as before this change (prompt text identical
   apart from the skills section).
9. Inside the sandbox, the user's personal and enabled-plugin skills are listed, excluded ones
   are not, and writing into any of them fails (read-only).
10. Every new screen works at 390 px without horizontal scroll.

## 11. Open questions

Each one has a recommendation; nothing is built until they are answered.

1. **Is a second question round allowed, and with what cap?** After the user answers round 1,
   the agent may find that an answer opens a new, blocking question (e.g. "retry all methods" →
   "which idempotency-key header?").
   - (a) No second round: the agent must write the document, putting new questions under
     "Open questions" for RETRY STAGE.
   - (b) **One optional second round of at most 4 questions, then the document is forced**
     (engine-enforced through `interviewPhase`).
   - (c) Up to 3 rounds of at most 4 each.
   - (d) No cap; the agent asks until it is satisfied.
   *Recommendation: (b).* Answers often fork. Without round 2 the agent bakes a guess into a
   whole document, and correcting it with RETRY STAGE rewrites the document, which costs more
   than one short form. A hard stop at 2 keeps the quest from becoming a chat.

2. **How does INTERVIEW behave when AUTO-PLAY is on?**
   - (a) The agent asks, the engine immediately "answers" with the guesses, and a second turn
     writes the document (the original suggestion). This costs one extra turn per stage.
   - (b) **Same turn: the agent writes `questions.json` for the record, treats its guesses as
     answers and writes the document right away**; the engine records the round as "AUTO-PLAY
     took the guesses".
   - (c) AUTO-PLAY stops at every questionnaire (interview wins over auto-play).
   - (d) INTERVIEW is forced off when AUTO-PLAY is on.
   *Recommendation: (b).* It gives the same visible result as (a), with every guess on record,
   and saves a resumed turn per stage. (c) breaks AUTO-PLAY's promise of no stops before the
   PR; (d) loses the written-down assumptions.

3. **One INTERVIEW switch or one per stage?**
   - (a) **One switch covering SCOUT and PLAN.**
   - (b) Two switches: INTERVIEW AT SCOUT and INTERVIEW AT PLAN.
   - (c) One switch, plus a per-repo or global default in Options › GAME RULES.
   *Recommendation: (a).* That is the original decision, and New quest already has three
   switches. A quest started at PLAN only interviews at PLAN anyway.

4. **Where does the "on" default live?**
   - (a) **The API and the New quest form default to on; existing threads read as off.**
   - (b) A `defaults.interview` key in `repos.yaml` (on when absent), editable in GAME RULES.
   - (c) A per-repo `interview:` key (e.g. off for tiny repos).
   *Recommendation: (a).* It is the smallest. Add (b) only if switching it off every time gets
   tedious.

5. **How safe is ACCEPT GUESSES on the inbox card?** One tap commits every answer, including
   ones the user hasn't read.
   - (a) One tap, no confirmation.
   - (b) **Two taps: the first turns the button into "SURE? 6 GUESSES ▶" for 4 s.**
   - (c) Only shown when there are 3 or fewer questions.
   - (d) No card action; the card only links to the form.
   *Recommendation: (b).* Fast for the "yes, all fine" case, and hard to hit by accident on a
   phone.

6. **What does the YOUR MOVE card show for a questionnaire?**
   - (a) **The first question + its guess + "+N more" + ACCEPT GUESSES.**
   - (b) Only the count: "6 questions before the spec".
   - (c) Up to 3 questions with their guesses, one line each, then "+N more".
   *Recommendation: (a).* It gives enough to judge whether the agent understood the task,
   without making the card twice as tall. (c) is a phone-scrolling problem.

7. **Which buttons does the questionnaire page have?** The brief lists SEND ANSWERS, ACCEPT ALL
   GUESSES and skip-and-write.
   - (a) Three buttons: SEND ANSWERS (primary), ACCEPT ALL GUESSES (secondary: sends the
     guesses and ignores any edits), SKIP (quiet).
   - (b) **One primary that reads ACCEPT ALL GUESSES while nothing has changed and SEND ANSWERS
     · N changed once something has, plus SKIP (quiet).**
   - (c) SEND ANSWERS + SKIP only.
   *Recommendation: (b).* In (a), ACCEPT ALL GUESSES next to an edited form silently throws the
   edits away. (b) never does, and the per-question "reset to guess" link covers undo. SKIP
   stays because it means something different: "don't make me read these, use your judgement",
   which the agent records as assumed rather than confirmed.

8. **Is the free-text note box shown on the questionnaire page?**
   - (a) **Yes, unchanged; it rides along under the answers as "Note from the user".**
   - (b) No; each question's Other… field is enough.
   - (c) A per-question comment field instead.
   *Recommendation: (a).* "You forgot to ask about rate limits" needs somewhere to go, and the
   box and its draft already exist.

9. **Plugin skills: what exactly gets mounted?**
   - (a) **Skills only: each enabled plugin's `skills/<name>/` as a read-only mount under
     `/petree/skills`, loaded through one `--add-dir`.**
   - (b) Whole plugins: mount each enabled plugin read-only and pass `--plugin-dir` per plugin.
     Hooks, MCP servers, agents and commands come too, and skills keep their `plugin:` prefix.
   - (c) No plugin skills; keep README step 5 (copy by hand into `shared/skills`).
   *Recommendation: (a).* (b) runs the host's hooks in every sandbox, e.g. a hook that injects
   a persona into every subagent. It also starts MCP servers that have no auth or network
   there. (c) leaves the setup chore that caused this question.

10. **Which personal skills get in?** The host's `~/.claude/skills` holds skills for unrelated
    work (e.g. employer-specific ones) and some that need tools the sandbox lacks.
    - (a) **All of them, minus an `exclude` list in `repos.yaml` (empty by default).**
    - (b) An allowlist: only the names listed under `claude_skills.include`.
    - (c) All, with a per-repo `skills_exclude` so personal repos skip work skills (and vice
      versa).
    - (d) Off by default; the user switches `personal: true` on.
    *Recommendation: (a).* That matches the decision to behave like the user's own sessions.
    Add (c) if work skills show up in personal-repo threads.

11. **Also mount `~/.claude/CLAUDE.md` and `~/.claude/rules/`?** "Behave like my own sessions"
    could mean the global instructions too.
    - (a) **No, skills only.**
    - (b) Yes, both read-only.
    - (c) Only `rules/`.
    *Recommendation: (a).* Global instructions hold machine- and infra-specific content
    (cluster names, IPs, local tool habits) and rules that fight petree's own prompt (e.g.
    "ask before pushing", "use these MCP tools"). `repos.yaml` `defaults.instructions` is the
    place for sandbox-wide rules.

12. **Two skills with the same name: which one wins?**
    - (a) **First wins in the order shared → personal → plugins (in `installed_plugins.json`
      order); the others are skipped.**
    - (b) Rename the later ones' directories to `<plugin>-<name>`.
    - (c) Fail the launch with a list of clashes.
    *Recommendation: (a).* Personal skills over plugin ones matches how a user overrides a
    plugin skill. Renaming the directory doesn't help, because Claude Code reads the name from
    the `SKILL.md` front matter.

13. **What else can the user do at a questionnaire gate?**
    - (a) **Answer (send / accept / skip) or GAME OVER only.**
    - (b) Also RETRY STAGE "ask again" with the note (e.g. "these are the wrong questions").
    - (c) Also QUEST COMPLETE and "skip to CRAFT".
    *Recommendation: (a).* "Wrong questions" fits in the note sent with SKIP or SEND, and fewer
    buttons keep the form calm. Add (b) if it turns out the agent misreads the task often.

14. **What happens when `questions.json` is partly or fully invalid?**
    - (a) **Keep the valid questions and drop the rest (shown as "2 couldn't be read"). A file
      that is entirely invalid falls back to the document/result gate.**
    - (b) Any invalid question rejects the whole file (document/result gate).
    - (c) Automatically re-run the turn once with the validation errors in the prompt.
    *Recommendation: (a).* The agent's output is best-effort; a stray `"kind": "scale"` should
    not cost the other seven questions. (c) spends a turn without asking the user.

15. **When does a stage interview again?**
    - (a) **Only on the first turn of each visit to a stage. RETRY STAGE after a document
      does not ask again; moving back to a stage (CRAFT → PLAN) is a new visit and asks again.**
    - (b) Every time a stage has no document yet.
    - (c) Only the first visit to each stage in the whole thread; back-moves never ask.
    *Recommendation: (a).* A retry with a note is already the user steering, so asking again
    would be noise. A back-move from CRAFT to PLAN usually means the plan was wrong, where a
    fresh round helps.

16. **The claude.ai-synced skills under `~/.claude/skills/synced/<id>/<name>/`: mount them?**
    - (a) **No; only first-level `~/.claude/skills/<name>/SKILL.md`.**
    - (b) Yes, also descend into `synced/*/`.
    *Recommendation: (a)* for the first cut. The layout is the claude.ai client's internal
    format and may change. Switch to (b) if the user relies on synced skills.

17. **Does the QUESTING line promise questions?** A running `ask` turn may still end with no
    questions, if the agent decides nothing is worth asking.
    - (a) **"Preparing questions · PLAN · 3m".**
    - (b) Keep "Running PLAN · 3m", and show "questions first" only on the thread page.
    *Recommendation: (a).* It sets the expectation that a form is coming, which is the usual
    case. A turn that ends without questions just shows the document gate.

## Risks in the decisions (for the reviewer)

- **The `interview-me` skill is built on one question at a time.** The batch form overrides its
  core rule, so the prompt can only borrow its question selection, not its method. Expect
  weaker follow-up questions than in a live session. Round 2 (open question 1) partly
  compensates.
- **INTERVIEW on by default at SCOUT** doubles the stops on the cheapest stage: the user is
  asked before investigating and again at the findings gate. The prompt forces exploring
  before asking, which makes the first SCOUT turn longer.
- **"AUTO-PLAY accepts the guesses automatically" as a separate turn** gives the same result as
  INTERVIEW off plus a written assumptions list, at the cost of an extra turn per stage. Hence
  recommendation 2(b).
- **Mounting all personal skills** puts work-specific skill descriptions into every thread's
  context, and lets the agent quote them into PRs on unrelated (possibly public) repos. It also
  loads skills that depend on tools that are missing in the sandbox.
- **ACCEPT GUESSES from the inbox** answers questions the user never read. It is fine for
  trivial rounds, but the main way a wrong assumption reaches a spec unnoticed.
