# Petree Interview Questionnaire — Ask First, Then Write

**Date:** 2026-11-14 (rev 3: the follow-up questions N1–N6 decided, MCP servers allowlist, §5.8.4)
**Status:** Draft; decisions settled, one open question (§11.3)
**Builds on:** `docs/superpowers/specs/2026-11-13-petree-thread-inbox-design.md` (the "inbox spec"),
branch `inbox-engine`. Visuals follow `docs/design/handheld-arcade.md`.
**Mockups:** `docs/design/interview-mockups.html`, screens (a)–(g) of §5.1, light and dark.

## 1. Intent

Today SCOUT and PLAN are one-shot: the agent writes findings or a spec, and the user replies
with one free-text note (RETRY STAGE / CONTINUE). Real investigation and spec work is an
interview, and petree should support one without turning a thread into a chat. Before
writing, the agent sends **a batch of questions**, each with its own guess and a short "why
I'm asking". The user fills in a form with the guesses already filled in and sends every answer
at once. The agent then writes the document, or asks one more batch if the answers raised
something that blocks it. Threads run with the user's own `~/.claude` instructions, chosen
skills and chosen plugins, so they ask and write the way the user's own sessions do.

## 2. Goals

1. **Questionnaire gate**: at SCOUT and PLAN the agent can stop with 1–8 questions in
   `_thread/questions.json` instead of a document. The thread shows them as a form with the
   guesses filled in.
2. **Rounds the model decides**: after any answered round the agent may ask another (it
   says why, and whether it expects more). The user can always press **WRITE IT NOW** to end
   the questions.
3. **One send**: the main button sends every answer at once and resumes the same session with
   one structured note.
4. **Inbox**: a waiting questionnaire is YOUR MOVE, even with AUTO-PLAY on. Its card shows the
   first question with the guess, "+N more" and a two-tap ACCEPT GUESSES.
5. **Kept, not lost**: answered rounds stay visible in the stage document's ANSWERS block and
   in the quest log, and the agent records them in the document itself.
6. **Quest option**: one INTERVIEW switch, on by default, next to PARTY MODE / AUTO-PLAY.
7. **The user's `~/.claude` in the sandbox**, all read-only:
   - `CLAUDE.md` and `rules/`;
   - an allowlist of personal skills;
   - an allowlist of whole plugins (skills, hooks, MCP servers);
   - an allowlist of MCP servers from the host's Claude Code config, copied into petree's own
     MCP file.

   All three allowlists are edited in Options › GAME RULES. Anything that can't start in the
   sandbox is reported in INFO.

## 3. Non-goals

- One-question-at-a-time chat, or answering while a turn runs.
- Questions at CRAFT. The build prompt keeps "make a reasonable call and list open questions".
- Editing the agent's questions or adding your own (the note box covers "you forgot X").
- Changing INTERVIEW after the quest is created (same as PARTY MODE / AUTO-PLAY).
- Mounting anything else from the host: `~/.claude.json` (OAuth tokens, project history),
  `settings.json`, and agents or commands outside allowlisted plugins. MCP servers from
  `~/.claude.json` reach the sandbox only as copied definitions in petree's own file (§5.8.4).
- MCP servers that log in with OAuth tokens kept outside the config (claude.ai connectors, the
  keychain). They show "needs login".
- New task states or tables. The only new route is the read-only `GET /api/claude-home`
  (§5.8).

## 4. Constraints

- **Reuse the engine**:
  - the `waiting-for-you` gate, `followUp`, `POST /next` and session resume (`--resume` in
    `buildSandboxCommands`);
  - `contained()` + `readCapped()` and the status-file freshness rule (mtime ≥ `startedAt`);
  - `cardFor`, `PUT /api/defaults`;
  - the dashboard's `tile()` pickers, `sw()` switches and `#thMove` note box.

  No new dependencies; validation is hand-written, like `readThreadStatus`.
- Everything the agent writes is untrusted: the questions file is size-capped, read with no
  follow and no blocking, validated field by field, clipped, and always escaped when rendered.
- Everything mounted from the host is `:ro`. The sandbox still never sees git, `gh` or `az`
  credentials, nor `~/.claude.json`. The only secrets it gets are the env/header values of MCP
  servers the user allowlisted (§5.8.4).
- Phone: every new screen works at 390 px.

## 5. Design

### 5.1 Screens

Each screen below is in `docs/design/interview-mockups.html`.

#### (a) New quest: RULES OF PLAY

A third switch in `#nqSwitches`, after AUTO-PLAY, built with the existing `sw()` helper:

- **INTERVIEW** — "ask you a few questions before findings and spec; guesses filled in".
  Default **ON** (`nq.interview = true`, also reset to true after PRESS START).
- STARTING LEVEL CRAFT → the switch is disabled, with "only SCOUT and PLAN ask". The value is
  still sent, and the engine ignores it at build.
- `#nqAuto` gains one sentence:
  - INTERVIEW on: "SCOUT and PLAN each start with a questionnaire for you."
  - INTERVIEW on + AUTO-PLAY on: "AUTO-PLAY still stops at every questionnaire; after you
    answer it runs on."
- Footer summary gains "· interview".

#### (b) Thread page, questionnaire waiting (desktop 1280)

Same page as inbox spec §5.1(b), with these differences while a questionnaire waits (§5.2):

1. **YOUR MOVE! panel**: "Answer 6 questions before the spec" (SCOUT: "…before the
   findings"), who/when as today.
2. **Document section** becomes **THE PARTY ASKS** (`#thAsk`, in place of the `#thDoc`
   content):
   - **Round header**: "ROUND 2", then the agent's `whyMore` for round ≥ 2 ("Your answer on
     POST retries raised two questions about idempotency keys"), then the outlook chip from
     `outlook`: "LIKELY THE LAST ROUND" or "EXPECT ANOTHER ROUND". Round 1 shows `intro`
     instead of `whyMore`.
   - **Per question**:
     - a Q chip and the question as a heading, with `why` as a hint line;
     - the input, built from the New quest `tile()` pickers:
       - `choice`: radio tiles, plus "Other…" with a text input when `allowOther`;
       - `multi`: checkbox tiles (+ Other…);
       - `yesno`: YES / NO tiles;
       - `number`: `<input type="number">` with min/max/step and a unit suffix;
       - `text`: a textarea;
     - a **GUESS** tag on the filled-in guess. Once the answer changes, the tag reads
       **YOURS** and a "reset to guess" link appears. A question with no valid guess is
       tagged **NEEDS AN ANSWER** and starts empty.
   - The answers draft lives in `localStorage` under `petree-ask:<id>:<startedAt>`. The 3 s
     poll repaints the form only when that key changes.
   - Earlier documents stay collapsed below, as today.
3. **YOUR NOTE TO THE PARTY**: unchanged. It goes with either button and arrives as "Note from
   the user" under the answers (§5.5).
4. **Buttons** (`thMoves` gets a new first branch). Gate actions are only these:

   | slot | button | does |
   |---|---|---|
   | primary (smart) | **ACCEPT ALL GUESSES ▶** "nothing changed · send" while every answer equals its guess; **SEND ANSWERS ▶** "N changed · send" once one differs | `POST /next {answers}` — the agent may write, or ask another round |
   | quiet | **WRITE IT NOW** "no more questions · use these answers" | `POST /next {answers, final: true}` |
   | quiet | **GAME OVER** | `POST /drop` |

   - The primary is disabled while a NEEDS AN ANSWER question is empty ("answer Q4 first").
   - WRITE IT NOW is never disabled. It sends the form as it stands: edits kept, untouched
     answers as "guess kept", an empty no-guess question as "no answer — decide yourself"
     (decision N1).

#### (c) The same at phone width (390 px)

One column. The round header wraps: ROUND chip and outlook chip on one line, `whyMore` below.
Each question stacks: chip and question, why (clamped to 2 lines), tiles in one column.
Inputs are full width. Buttons stack: primary, then the quiet ones.

#### (d) Inbox: YOUR MOVE card with a question

```
YOUR MOVE!  Answer 6 questions before the spec
ROUND 1 · Q1 Which REST tasks should retry?
GUESS ▸ Idempotent methods only (GET, PUT, DELETE)
+5 more                                  [ ACCEPT GUESSES ]
```

- The question is clamped to 2 lines, the guess to 1. The round chip shows only for round ≥ 2.
- **ACCEPT GUESSES** shows only when `card.ask.allGuessed`, and takes **two taps**. The first
  tap arms it: "SURE? 6 GUESSES ▶", with a 4 s countdown bar. The second tap within 4 s sends
  `POST /next {answers: 'guesses'}`. Otherwise it disarms. Esc or a blur also disarm it.
- Any other click on the card opens `#/t/<id>`.
- **Markup**: the card is an `<a>` today, and a button inside an `<a>` is invalid HTML. The
  card becomes `<div class="cart">` with a stretched `<a class="cart-link">` (`::after {
  inset: 0 }`), and the button sits above it (`position: relative; z-index: 1`).

#### (e) Later stage: answered Q&A recap

Under each stage document whose stage asked questions, there is one collapsed `<details>` per
round: **PLAN · ROUND 1 · 6 ANSWERS · 2 changed**. It lists each question, the final answer,
and "guess kept" or "changed · guess was: 3 attempts". A round ended with WRITE IT NOW is
tagged "· you ended the questions". The source is `Turn.interview` (§5.6).

Quest log entries:
- at the end of the question turn: "Asked 6 questions · PLAN round 1";
- at the follow-up: "You answered · 2 changed, 4 guesses kept", "Accepted the guesses", or
  "… · write it now".

#### (f) QUESTING: preparing questions

While a turn runs in phase `ask` (§5.4):

- The card line reads "Preparing questions · PLAN · 3m".
- The thread page placeholder reads "The party is reading the code, then writing questions for
  you… (3 min)", with the previous stage's document below.
- PAUSE and QUEUE NOTE work as today.

#### (g) Options › GAME RULES › FROM YOUR ~/.claude

A section in the existing GAME RULES panel, in the Options page style, fed by
`GET /api/claude-home` (§5.8) and saved with the rest of GAME RULES through `PUT /api/defaults`:

- **INSTRUCTIONS** switch — "CLAUDE.md + 3 rules files, read-only. Contains machine and
  infrastructure details." Default ON. When `CLAUDE.md` has `@imports` that point outside
  `~/.claude`, a hint lists them: "won't resolve in the sandbox" (decision N6).
- **PERSONAL SKILLS** — one checkbox tile per `~/.claude/skills/<name>/SKILL.md` (synced
  skills excluded): the name, the first line of its description, and a "picked N of M" count.
  Default: none.
- **PLUGINS** — one checkbox tile per installed plugin: `name` · marketplace · version, with
  badges:
  - "14 skills";
  - "hooks: SessionStart, Stop";
  - "MCP: figma".

  Two warning chips:
  - "Stop hook: can keep a turn running" (allowed, decision N3);
  - "MCP may need network or login".

  A **USED BY INTERVIEW** tag marks plugins that ship `interview-me`, `brainstorming` or
  `spec-driven-development`. Default: those plugins, when installed (in practice `agent-skills`
  and `superpowers`), ticked until the user saves a different list (decision N2, §5.8).
- **MCP SERVERS** — one checkbox tile per server found in the host's Claude Code config
  (§5.8.4):
  - The tile shows the name, the scope ("user" or the project path), the transport
    (`stdio · npx` / `http · api.example.com`), and "has secrets" when it has env values or
    headers.
  - Servers whose login lives outside the config are tagged **NEEDS LOGIN**. They can be ticked
    but won't connect.
  - Plugin MCP servers are listed separately, read-only: "comes with plugin <name>", ticked
    when the plugin is.
  - Default: none.
  - Footer: "SAVE rewrites petree's MCP file; running turns keep the old one."
- Footer hint: "Changes apply from each quest's next turn."

### 5.2 Card data contract changes (`src/inbox.ts`)

`cardFor(task, status, cfg, now, asked)` gains `asked`: the validated questionnaire (§5.3) or
`null`. `withCard` reads it only when `task.state === 'waiting-for-you'` and
`interviewPhase(task).kind === 'ask'`.

**A questionnaire is waiting** when all of these hold:
- `asked !== null`;
- the state is `waiting-for-you`;
- the stage is `investigate` or `spec`;
- the phase is `ask`.

This holds with AUTO-PLAY on too.

| field | how it is produced |
|---|---|
| `card.ask` | `null`, or `{ stage, round, total, outlook, first: { q, guess }, allGuessed }`. `first.q` is clipped to 140; `first.guess` is the guess as text (option label(s), "yes"/"no", number + unit, text clipped to 80) or `null`. |

| where | change |
|---|---|
| §5.2.1 state line | New row before "waiting-for-you": questionnaire waiting → "<N> questions before the <findings\|spec>" (+ " · round <R>" for R ≥ 2). Running with phase `ask` → "Preparing questions · <LEVEL> · <m>m". |
| §5.2.2 YOUR MOVE | New first row: questionnaire waiting → `action.label` "Answer <N> questions before the <findings\|spec>", `detail` = `status.needsYou`. |
| §5.2.3 progress | Unchanged (stage `current`, tone `needs-you`). |

### 5.3 The questions file (`src/notes.ts`)

**File**: `/work/_thread/questions.json`, next to `status.txt`, never committed.

**Schema** (the agent writes it; the types describe the result after validation):

```ts
type Kind = 'choice' | 'multi' | 'yesno' | 'number' | 'text'
interface Option { id: string; label: string }   // id /^[a-z0-9-]{1,16}$/, label ≤ 80

interface Question {
  id: string               // /^[a-z0-9-]{1,32}$/, unique in the file
  kind: Kind
  q: string                // 1..200
  why: string              // ≤ 160 (missing → '')
  options?: Option[]       // choice | multi: 2..6, unique ids
  allowOther?: boolean     // choice | multi
  unit?: string            // number: ≤ 12
  min?: number; max?: number; step?: number   // number: finite, min ≤ max
  guess: string | string[] | boolean | number | null
    // choice: option id · multi: option ids · yesno: boolean
    // number: within min..max · text: ≤ 500 · null = no guess
}

interface Questionnaire {
  round: number            // petree's count (§5.4); the file's value is only cross-checked
  intro: string            // ≤ 200, round 1: "Before I write the retry spec…"
  whyMore: string          // ≤ 200, round ≥ 2: why another round (missing → "no reason given")
  outlook: 'last' | 'more' | null   // the agent's estimate; anything else → null
  questions: Question[]    // 1..8 in every round
  dropped: string[]        // "q7: unknown kind 'scale'", "round says 3, petree counts 2"
}
```

Example from the prompt (trimmed):

```json
{
  "round": 1,
  "intro": "Before I write the retry spec, six things the code can't tell me.",
  "outlook": "last",
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

**Reading**: `readThreadQuestions(workDir, since, round)`, built like `readThreadStatus`:

- `contained(p, workDir)`, then `readCapped(p, 32 KiB)`, then mtime ≥ `since`.
- `JSON.parse`; a failure returns `null` and keeps the reason for Info.
- **Salvage per question**:
  - A question that breaks its rules is dropped and listed in `dropped`: unknown kind, a bad
    or duplicate id, empty `q`, options missing or out of range, `min > max`.
  - A bad **guess** keeps the question with `guess: null` (NEEDS AN ANSWER).
  - Strings are trimmed and clipped. Unknown fields are ignored.
  - Past 8 questions, the first 8 are kept and the rest listed.
- No question left → `null`, and the gate falls back to the normal document gate (§8).

**Serving**: `GET /api/tasks/:id/thread` adds `questions` (only while waiting),
`questionsError`, and `interview: InterviewRecord[]` for the recap.

### 5.4 Prompt (`src/prompt.ts`)

**Phase**: a pure `interviewPhase(task)` returns `{ kind: 'off' }`, `{ kind: 'ask', round }` or
`{ kind: 'write' }`:

- `off`: `!task.interview`, or the stage is `build`.
- `visit` is the trailing archived turns with `stage === task.stage`, i.e. this visit's turns.
  The turn that moved the thread here is archived under the previous stage.
- `visit` empty → `ask`, round 1.
- The last `visit` turn has an `interview` record with `final !== true` → `ask`,
  round = that round + 1.
- Anything else → `write`: after WRITE IT NOW, or after a turn that wrote the document (e.g.
  RETRY STAGE on a document gate).

`composePrompt` swaps the stage section by phase. `off` and `write` use today's
`STAGE_INSTRUCTIONS`. `write` after a questionnaire adds "Record the user's answers from this
thread under a `Decisions` heading in the document; do not ask more questions."

**`ask`, round 1** (replaces the stage's "Do not ask interactive questions" lines):

```
## Stage: spec — interview first

Before you write the spec, interview the user with a questionnaire.

1. Explore first: read the repos, `/work/_thread/findings.md` if present, and this thread,
   so you only ask what the code and the thread cannot tell you. Do not modify repo files.
2. If the `interview-me` skill is available, use it to decide what to ask
   (`brainstorming` and `spec-driven-development` may help too). Its one-question-at-a-time
   rule does not apply here: petree shows all your questions in one form and sends back all
   the answers at once.
3. Ask 1 to 8 questions (never more than 8) whose answers would change what you write.
   Give each your best guess and one short line on why you ask. Prefer choice, multi,
   yesno and number over text. Never ask what this thread already answered.
4. Write them to `/work/_thread/questions.json`, exactly in this shape: <schema example §5.3>
   Set "round" to 1 and "outlook" to "last" if you expect to write the spec after these
   answers, "more" if you expect another round.
5. Then stop. Do not write `/work/_thread/spec.md` this turn. In status.txt set
   needs-you to "Answer <N> questions".

If nothing is worth asking, do not write questions.json: write the spec now, following
the normal instructions: <today's STAGE_INSTRUCTIONS[stage]>
```

**PLAN after a SCOUT interview** (decided 2026-11-14): the SCOUT questionnaire is the main
interview. When this thread already has answered SCOUT rounds, PLAN's round-1 prompt adds
"The SCOUT answers above already settled the scope. Ask only what writing the plan newly
raised; if nothing did, write the spec now." So the usual path is SCOUT questions → findings
→ PLAN writes the spec straight away → you review the plan at the normal spec gate. PLAN
still interviews in full when SCOUT was skipped (the quest started at PLAN) or SCOUT had no
questionnaire.

For SCOUT, step 1 reads "Explore the repos and the question first; do not modify any repo
files", and the document is the findings.

**`ask`, round N ≥ 2** (after any answered, non-final round; it goes in front of the stage
instructions):

```
## Stage: spec — your questions were answered (above)

Write the spec now, following the instructions below, and record the answers under a
`Decisions` heading. Only if the answers raised questions that block the spec, write a new
`/work/_thread/questions.json` instead (round <N>, 1 to 8 questions, same shape), with
"whyMore": one line on why you need another round, and "outlook" as before. Then stop.
The user can end the questions at any time; ask only what you truly need.
```

**Your instructions and skills** (fixed, every stage, placed before the status section; each
line is present only when its mount is, §5.8):

```
## The user's own setup

The user's own instructions (`~/.claude/CLAUDE.md`, `~/.claude/rules/`), skills and plugins
are loaded, read-only. Where they conflict with this prompt's stage instructions or the
`/work/_thread/` file contracts (status.txt, questions.json, findings.md, spec.md), this
prompt wins. You run unattended in a sandbox: instructions that assume an interactive user,
the user's machine (local paths, local tools, MCP servers that aren't connected) or asking
before acting don't apply; skip those steps and say so in your final message. Never copy
instruction or skill text into repo files, documents, commits or PRs.
```

### 5.5 How answers travel back (`src/server.ts`, `src/store.ts`)

The existing `POST /api/tasks/:id/next` gains two optional body fields:

```ts
answers?: Record<string, Answer> | 'guesses'
final?: boolean            // WRITE IT NOW: no more rounds
// Answer by kind:
//   choice → option id, or { other: string ≤ 500 }    (other only when allowOther)
//   multi  → option ids[], or { picks: ids[], other: string ≤ 500 }
//   yesno  → boolean    number → finite, in min..max    text → string ≤ 2000
```

With `answers` present the route does the following:

1. Requires a waiting questionnaire (§5.2), else 409 "no questions waiting".
2. Requires `stage` to be omitted or equal to `task.stage`, else 400.
3. Re-reads the questionnaire through `readThreadQuestions` (never trusts the client's copy):
   - `'guesses'` takes every guess, and is 400 if any question has none;
   - for an object, an unknown id is 400 and each value is checked against its kind
     ("Q4: pick one of …");
   - a missing id takes its guess. With no guess it is 400, unless `final`, in which case it
     is recorded as "no answer — decide yourself".
4. Builds the `InterviewRecord` (§5.6) and the prompt below, then calls
   `store.followUp(id, prompt, undefined, task.stage, record)`. Pending comments fold in,
   `sessionId` is kept, and the launcher's `--resume` continues the same conversation.

**The structured note** (`renderAnswers(record, note)`, pure):

```
## Answers to your questions (PLAN, round 2)

The user answered in petree's form. "guess kept" means they left your guess as it was.

1. [key-header] Which header carries the idempotency key?
   Answer: Idempotency-Key — guess kept
2. [attempts] How many attempts at most?
   Answer: 5 attempts — changed (your guess: 3 attempts)
3. [jitter] Which jitter strategy?
   Answer: other: "full jitter, like the AWS guidance" — changed (your guess: Equal jitter)

The user pressed WRITE IT NOW: do not ask more questions. Write the spec.

## Note from the user

Also cap total retry time at 2 minutes.
```

- `'guesses'` uses the header line "The user accepted all your guesses."
- The WRITE IT NOW line appears only with `final`.
- Multi-line text answers are indented as a block.
- The stage section (§5.4) follows, composed at launch.

**Why `/next`**: it already archives the turn and requeues with a prompt on the same or a moved
stage, with the 409s for binned and running threads.

### 5.6 Where answered Q&A stays visible (`src/store.ts`)

`Turn` gains an optional field. It lives in the `turns` JSON column, so no migration is needed:

```ts
interface InterviewRecord {
  stage: Stage
  round: number
  questions: Question[]                  // as asked, validated
  answers: Record<string, Answer | null> // null = "no answer — decide yourself" (final only)
  how: 'answered' | 'guesses'
  final: boolean                         // WRITE IT NOW
  changed: number
  whyMore: string; outlook: 'last' | 'more' | null
}
interface Turn { /* … */ interview?: InterviewRecord }
```

- `followUp(id, prompt, model?, stage?, interview?)` stores it on the turn it archives (the
  question turn).
- The recap (§5.1e), the quest log and `interviewPhase` all read `turns`; nothing else is
  stored.
- The document carries the answers forward: the round-N and `write` prompts tell the agent to
  record them under `Decisions`. CRAFT and PARTY MODE subagents see them through the spec,
  even when session resume fails.
- An engine-written `_thread/answers.md` was rejected: it would be a new host write into
  `_thread/`, and the document plus the session already carry the answers.

### 5.7 Quest option and AUTO-PLAY (`src/store.ts`, `src/server.ts`, `src/launcher.ts`)

- **Column**: `interview INTEGER NOT NULL DEFAULT 0` (same migration loop as `party`).
  Existing threads read as off.
- **Request**: `POST /api/tasks` accepts `interview` (boolean, 400 otherwise). It defaults to
  **true** when omitted. `rowToTask` maps `interview: r.interview === 1`.
- **Info**: "INTERVIEW on/off", next to PARTY MODE and AUTO-PLAY.
- **AUTO-PLAY stops at every questionnaire.** In the launcher's `autoPlay(id)`, the
  `waiting-for-you` branch returns early when `interviewPhase(t).kind === 'ask'` and
  `readThreadQuestions(…)` finds a waiting questionnaire. The thread stays YOUR MOVE. Once the
  user answers, the next turn writes the document (or asks again), and at that gate AUTO-PLAY
  carries on as today. A question turn that wrote no questions is an ordinary document gate,
  so AUTO-PLAY moves on.
- **PARTY MODE**: no interaction; the lead agent asks.

### 5.8 The user's `~/.claude` in the sandbox (`src/sandbox.ts`, `src/config.ts`, `src/server.ts`)

**Today**:
- `~/.petree/shared/skills → /home/dev/.claude/skills:ro`, nested inside the rw session mount
  `~/.petree/sessions/<id> → /home/dev/.claude`. README step 5 copies plugin skills there by
  hand.
- `repos.yaml` per-repo `skills:` is parsed but unused, and stays untouched.

`claudeHome` (host) = `$CLAUDE_CONFIG_DIR` or `~/.claude`.

**Config** (`repos.yaml` `defaults:`, written by GAME RULES through `PUT /api/defaults`):

```yaml
defaults:
  claude_home:
    instructions: true                 # CLAUDE.md + rules/ (default true)
    skills: [sip-expert]               # personal skill allowlist (default [])
    plugins: [agent-skills@addy-agent-skills, superpowers@claude-plugins-official]
    mcp: [linear, docs@/Users/me/code/api]   # MCP server allowlist (default []), §5.8.4
```

**Default plugins** (decision N2): while `plugins` is absent, the default is every installed
plugin that ships `interview-me`, `brainstorming` or `spec-driven-development` (in practice
`agent-skills` and `superpowers`). GAME RULES shows them ticked. Once SAVE writes an explicit
list, even `[]`, that list rules. The engine and the form use the same rule, so the first quest
after the upgrade already has the interview skills.

**1. Instructions** (when `instructions` is true and the source exists):

```
-v <claudeHome>/CLAUDE.md:/home/dev/.claude/CLAUDE.md:ro
-v <claudeHome>/rules:/home/dev/.claude/rules:ro
```

- These are nested inside the rw session mount, which Docker allows: it creates the mount
  points (an empty file and an empty dir) in `~/.petree/sessions/<id>/` on the host. Claude
  Code reads them as user memory, exactly as on the host.
- `@imports` inside `CLAUDE.md` that point outside `~/.claude` do not resolve. GAME RULES lists
  them as a hint (decision N6).
- Precedence is stated in the prompt (§5.4): petree's stage instructions and `_thread/`
  contracts win.
- **Risk**: these files hold machine and infrastructure details (cluster names, IPs, local
  tool habits), and the model now sees them in every thread.

**2. Personal skills** (allowlist): one `:ro` bind per allowlisted
`<claudeHome>/skills/<name>/` that holds a `SKILL.md`:

```
-v <claudeHome>/skills/<name>:/petree/skills/.claude/skills/<name>:ro   (one per skill)
claude … --add-dir /petree/skills                                       (once, if any)
```

- They can't nest under the read-only `/home/dev/.claude/skills`: Docker would create mount
  points inside a read-only bind, i.e. on the host in `shared/skills`. Claude Code loads
  `.claude/skills/` from `--add-dir` directories (code.claude.com/docs/en/skills, "Skills from
  additional directories").
- A symlinked skill dir works, because Docker resolves a bind source on the host.
- `synced/` (claude.ai-synced skills) is never offered.
- **Duplicate names**: first wins, with `shared/skills` before personal. The skipped name shows
  in INFO. Plugin skills don't collide, because they keep their `plugin:` prefix.

**3. Plugins** (allowlist): whole plugins — skills, hooks, MCP servers, agents and commands —
loaded with `--plugin-dir`:

```
-v <installPath>:/petree/plugins/<slug>:ro      (one per allowlisted plugin)
claude … --plugin-dir /petree/plugins/<slug>    (one flag per plugin)
```

- **Host install paths.** Petree reads `<claudeHome>/plugins/installed_plugins.json`
  (`version: 2`, `plugins[key][0].installPath`) **on the host**, only to find the directory to
  bind.
  - Inside the container the plugin is known only by its container path.
  - `installed_plugins.json`, `known_marketplaces.json`, `settings.json` and the plugin cache
    are never mounted, so no absolute host path exists in the container to dangle.
  - Plugin configs that use `${CLAUDE_PLUGIN_ROOT}` (hooks, `.mcp.json`) resolve to
    `/petree/plugins/<slug>`.
  - A plugin that hardcodes a host path breaks quietly and shows as failed in INFO.
- **Containment**: an `installPath` whose realpath is not under `<claudeHome>/plugins/` is
  refused, so a hand-edited JSON can't mount an arbitrary host directory. It shows in INFO as
  "outside ~/.claude/plugins".
- `<slug>` is the plugin name (`[a-z0-9-]`), or `<name>-<marketplace>` when two allowlisted
  plugins share a name.
- Plugin data (`${CLAUDE_PLUGIN_DATA}`) lands in the per-thread session dir (rw), not in the
  host's plugin data.
- `--plugin-dir` loads a plugin for the session whatever `enabledPlugins` says, so the GAME
  RULES allowlist alone decides.
- Check in PR 4: `--plugin-dir` and `${CLAUDE_PLUGIN_ROOT}` on the CLI version in the sandbox
  images.
- Plugins with a `Stop` hook are allowed, with the warning chip (decision N3); the turn timeout
  bounds them.

**4. MCP servers** (allowlist, decision N4): petree never mounts `~/.claude.json`. It keeps its
own file, `<petree home>/claude.mcp.json`, holding only the allowlisted servers' definitions:

```
-v <petree home>/claude.mcp.json:/petree/mcp.json:ro
claude … --mcp-config /petree/mcp.json            (only when the allowlist is non-empty)
```

- **Where the picker's list comes from** (`GET /api/claude-home`, host-side):
  - **User scope**: top-level `mcpServers` in `<claudeHome>/../.claude.json` (i.e.
    `~/.claude.json`; with `$CLAUDE_CONFIG_DIR`, the `.claude.json` inside it). Id: `<name>`.
  - **Local/project scope**: `projects[<path>].mcpServers` in the same file. Id:
    `<name>@<path>`. In the generated file a name clash with another chosen server gets
    `-<project dir basename>` appended.
  - **Plugin servers**: each installed plugin's `.mcp.json`. These are listed read-only, as
    "comes with plugin <name>". They are **not** copied: they load with their plugin through
    `--plugin-dir` (§5.8.3), so the plugin allowlist controls them.
  - Project `.mcp.json` files in repos are not offered. Repos bring their own, and `/work` is
    not a repo root.
- **What is copied**: for each allowlisted id, the definition as written:
  - `stdio`: `command`, `args`, `env`;
  - `http`/`sse`: `type`, `url`, `headers`.

  Nothing else from `~/.claude.json` is read into the file. `${VAR}` references are copied as
  written. They resolve only if the sandbox has that variable, which it usually doesn't, so the
  picker tags such servers "uses host env vars".
- **Secrets**: env and header values are copied only for allowlisted servers. The file is
  written by temp file + rename with mode `0600`. `repos.yaml` stores only ids, and
  `GET /api/claude-home` returns names, scope, transport, the command name or URL host, and a
  `hasSecrets` flag, never values.
  - On Linux the container user must be able to read a 0600 file. That holds when the host
    uid equals the image's `dev` uid, the same condition the rw session mount already needs.
- **Needs login**: a remote server with no `Authorization` header (or a stdio server that
  shells out to an OAuth helper) relies on a token kept outside the config: the keychain,
  Claude Code's credentials store, or a claude.ai connector. Those servers are tagged
  **NEEDS LOGIN** in the picker. In the sandbox they fail to authenticate, and INFO shows
  "needs login". claude.ai connectors are not in `~/.claude.json` at all, so they are never
  listed.
- **SAVE regenerates the file**: `PUT /api/defaults` with `claude_home.mcp` re-reads the host
  config and rewrites `claude.mcp.json`. It also does this at server start, so host-side edits
  to a server's command or token arrive after a restart or the next SAVE. Running containers
  keep the old file, because the rename leaves their bound inode in place.
  - An allowlisted id that has vanished from the host config is dropped from the file and shown
    in INFO as skipped.
- **No `--strict-mcp-config`**: that flag also drops plugin MCP servers (SDK `strictMcpConfig`:
  "ignore project `.mcp.json`, user settings, plugin-provided MCP servers, and claude.ai
  connectors"), and decision 9 keeps those. Without it, the only other sources in the sandbox
  are the per-thread session `~/.claude.json` (starts empty) and a `/work/.mcp.json` the agent
  could write itself. That gives no new power: the agent can already start any process.
  §11.3 asks whether to add strict anyway.

**Failing quietly, reported in INFO**:
- Docker binds only paths that exist. A missing source (deleted skill, uninstalled plugin) is
  skipped at launch with no error.
- An MCP server that can't start (no binary, no network, needs an OAuth login the sandbox
  doesn't have) or a hook that fails doesn't fail the turn. Claude Code carries on.
- The report comes from the `system/init` stream event the log already holds: `plugins:
  [{name, path}]`, `mcp_servers: [{name, status}]` and `skills: string[]`.
  `GET /api/tasks/:id/stats` adds:

  ```ts
  sandbox: {
    plugins: { name: string; loaded: boolean }[]
    mcp: { name: string; status: string }[]
    skills: number
    skipped: string[]
  }
  ```

  `loaded: false` means allowlisted but absent from the init event. `mcp` covers both copied
  and plugin servers, with the init status (`connected`, `failed`, `needs-auth`); an
  allowlisted server missing from init shows as "failed". `skipped` is filled at launch:
  missing source, outside `~/.claude/plugins`, duplicate name, MCP id gone from the host
  config. `ponytail:` it compares
  against the current allowlist, not a launch snapshot; store one if allowlists change
  mid-quest often.
- Details › Info shows "PLUGINS 2 of 3 loaded", "MCP linear: connected · notion: needs login",
  "SKILLS 41" and the skipped list.

**Listing for GAME RULES**: `GET /api/claude-home` (read-only, host-side) returns:

```ts
{
  instructions: { claudeMd: boolean; rules: number; unresolvedImports: string[] }
  skills: { name: string; description: string }[]   // description: first line, ≤ 140
  plugins: {
    key: string; name: string; marketplace: string; version: string
    skills: string[]; hooks: string[]; mcp: string[]; outside: boolean; interview: boolean
  }[]
  mcp: {
    id: string; name: string; scope: 'user' | string   // string = project path
    transport: 'stdio' | 'http' | 'sse'; target: string // command name or URL host
    hasSecrets: boolean; hostEnv: boolean; needsLogin: boolean
  }[]
}
```

- Skills come from `SKILL.md` front matter.
- Plugins come from `installed_plugins.json` + each plugin's `.claude-plugin/plugin.json`,
  `hooks/hooks.json` event names, `.mcp.json` server names and `skills/*`.
- MCP servers come from `~/.claude.json` (user and project scope, §5.8.4). Plugin servers are
  under their plugin.
- It never returns file bodies or secret values. Unreadable entries are left out.

## 6. What is reused, changed, or added

| piece | fate |
|---|---|
| Task states, `waiting-for-you` gate | **Reused**: a questionnaire is a gate with a different payload. |
| `POST /next`, `followUp`, comment folding, `--resume` | **Reused**; `/next` gains `answers`/`final`, `followUp` gains `interview`. |
| `readCapped`, `contained`, mtime freshness | **Reused** by `readThreadQuestions`. |
| `cardFor` | **Changed**: one parameter, one field, two rows. |
| `composePrompt` | **Changed**: `interviewPhase` picks the stage variant; a "user's own setup" section. |
| Launcher `autoPlay` | **Changed**: one early return at a waiting questionnaire. |
| `buildSandboxCommands` | **Changed**: instruction, skill, plugin and MCP-file mounts; `--add-dir`, `--plugin-dir`, `--mcp-config`. |
| `GET /thread`, `GET /stats`, `PUT /api/defaults` | **Changed**: `questions`/`interview`; `sandbox`; `claude_home`. |
| Dashboard `tile()`, `sw()`, `thMoves`, `#thMove`, card, GAME RULES | **Reused** and extended; the card's `<a>` becomes a stretched link. |
| New | `interview` column, `Turn.interview`, `readThreadQuestions` + validator, `renderAnswers`, `interviewPhase`, `claudeMounts`, `claude_home` config, `writeMcpFile` (`<petree home>/claude.mcp.json`), `GET /api/claude-home`. |

## 7. API changes (`src/server.ts`)

Changed:
- `POST /api/tasks`: accepts `interview` (boolean, default `true`).
- `GET /api/tasks[/:id]`: tasks gain `interview` and `card.ask`; turns may carry `interview`.
- `GET /api/tasks/:id/thread`: adds `questions`, `questionsError`, `interview`.
- `POST /api/tasks/:id/next`: accepts `answers`, `final` (§5.5).
  - 409 "no questions waiting";
  - 400 on a stage move together with `answers`;
  - 400 on an invalid answer.
- `GET /api/tasks/:id/stats`: adds `sandbox` (§5.8).
- `PUT /api/defaults`: accepts `claude_home: { instructions, skills, plugins, mcp }`. Each
  name is validated against `GET /api/claude-home`, 400 on unknown. A successful save
  regenerates `claude.mcp.json` (§5.8.4).

New: `GET /api/claude-home`. Unchanged: everything else.

## 8. Error handling

- **questions.json missing, stale, oversize, not JSON, or empty after validation**: the gate
  falls back to the normal document gate. It shows `findings.md`/`spec.md` if written,
  otherwise the turn result, with CONTINUE / RETRY STAGE. The panel adds "The party's
  questions couldn't be read: <reason>". Never a card error.
- **Some questions invalid**: the valid ones are shown, plus "2 questions couldn't be read",
  with reasons in Info.
- **The file's `round` disagrees with petree's count**: petree's count is shown; the mismatch
  goes in `dropped`.
- **Invalid guess**: that question is NEEDS AN ANSWER. ACCEPT GUESSES is hidden on the card and
  the smart button is disabled until it's answered. WRITE IT NOW still works.
- **Questions and the document both written in an `ask` turn**: the questionnaire wins.
- **Questions written in a `write` turn** (after WRITE IT NOW): ignored; the gate is a
  document gate.
- **Two tabs answer**: the second `/next` gets 409.
- **Session transcript missing on resume**: a fresh session starts. The follow-up prompt holds
  every question and answer, and earlier rounds sit in the documents' `Decisions`.
- **Host `~/.claude` unreadable, a plugin path missing, JSON unparseable**: that part is
  skipped, the turn launches, and INFO lists it. A Docker bind failure (e.g. a path not shared
  with Docker Desktop) fails the turn with Docker's message, as any mount failure does today.
- **A plugin MCP server or hook fails inside the sandbox**: not an error; INFO shows the status.
- **MCP file**:
  - `~/.claude.json` is missing or unparseable at SAVE → the picker is empty, the existing
    `claude.mcp.json` is kept as is, and SAVE reports the error.
  - Writing the file fails → SAVE fails with the error, and `repos.yaml` is not written either
    (the file is written first, then the YAML).
  - An allowlisted server needs a login it lacks → "needs login" in INFO; the turn runs.

## 9. Delivery as small PRs

1. **Questions file.**
   - `parseQuestions` (salvage, round/whyMore/outlook), `readThreadQuestions`, `questions` on
     `GET /thread`.
   - *Tests:* each kind; each drop rule; bad guess → null; caps; round mismatch; stale mtime;
     symlink escape; FIFO; non-JSON.
2. **Interview option + prompt.**
   - The `interview` column, request field and Info line.
   - `interviewPhase`; `composePrompt` round-1 / round-N / write variants.
   - *Tests:* the phase table (first turn, after answered round N, after final, retry after
     doc, back-move, build, off); existing rows off; API default on.
3. **Answers path + cards + AUTO-PLAY stop.**
   - `/next` `answers`/`final`; `renderAnswers`; `Turn.interview`; `cardFor` `ask` and rows.
   - The AUTO-PLAY early return.
   - *Tests:* each answer kind; `'guesses'` with a missing guess → 400; `final` with an empty
     no-guess → recorded null; 409; rendered note snapshot; card cases; AUTO-PLAY with the fake
     runner stops at a questionnaire and continues after the answers.
4. **`~/.claude` mounts.**
   - The `claude_home` config with the interview-plugin default, `claudeMounts` (instructions,
     skills, plugins, containment, slugs, duplicates).
   - `writeMcpFile` (user/project scope, name clashes, 0600, temp + rename, run at start and on
     SAVE).
   - `--add-dir`/`--plugin-dir`/`--mcp-config`; the prompt section; `GET /api/claude-home`;
     `PUT /api/defaults`; `sandbox` from the init event; README step 5 optional.
   - *Tests:* a temp `claudeHome` + `.claude.json` fixture → the exact `-v`/flag list; all host
     mounts `:ro`; a plugin outside `plugins/` refused; the MCP file holds only allowlisted
     servers, with secrets, at mode 0600; `/api/claude-home` returns no secret values;
     needs-login detection; init event → `sandbox`.
   - *Manual:* one real thread with the default plugins uses `interview-me`; one allowlisted
     stdio MCP server connects; an OAuth-only one shows "needs login" in INFO.
5. **New quest switch + GAME RULES section** (screens a, g).
6. **Questionnaire UI** (screens b–f): form, round header, smart button, WRITE IT NOW, two-tap
   card with stretched link, QUESTING line, recap, quest log; phone. *Check:* against the
   mockups at 1280 and 390 px, light and dark.

## 10. Success criteria

1. A new SCOUT quest (INTERVIEW on by default) stops at YOUR MOVE with questions. The inbox
   card shows Q1 with its guess and "+N more".
2. Changing two answers flips the main button to "SEND ANSWERS · 2 changed".
3. Sending resumes the same session. The findings carry a `Decisions` section matching the
   answers.
4. If the agent asks round 2, the page shows "ROUND 2", its reason and its outlook. WRITE IT NOW
   then produces the document with no further round.
5. ACCEPT GUESSES on the card needs a second tap within 4 s; one tap alone sends nothing.
6. With AUTO-PLAY on, the quest stops at each questionnaire. After the answers it runs on to an
   open PR with no other stop.
7. A garbled `questions.json` never breaks the card; the gate falls back to the document.
8. A quest with INTERVIEW off and nothing allowlisted has a prompt identical to before, apart
   from the instructions line.
9. In the sandbox, `CLAUDE.md`, `rules/`, allowlisted skills and plugins are present and
   read-only. A non-allowlisted one is absent. A plugin whose MCP server can't start is listed
   in INFO, and the turn still runs.
10. Ticking one MCP server in GAME RULES and pressing SAVE writes `claude.mcp.json` with only
    that server (mode 0600). The next turn lists it in INFO as connected, or as "needs login"
    when its token lives in the keychain.
11. Every new screen works at 390 px without horizontal scroll.

## 11. Decisions and open questions

### 11.1 Decided (2026-11-14)

| # | question | decision |
|---|---|---|
| 1 | Second round, cap | **The model decides; no hard cap.** Each file carries `round`, `whyMore` (round ≥ 2), `outlook`. 1–8 questions per round. WRITE IT NOW always ends the questions. |
| 2 | INTERVIEW with AUTO-PLAY | **AUTO-PLAY stops at every questionnaire** (always a YOUR MOVE gate). |
| 3 | One switch or per stage | **One INTERVIEW switch** for SCOUT and PLAN. |
| 4 | Where the default lives | On by default in the API and New quest; existing threads stay off. |
| 5 | ACCEPT GUESSES on the card | **Two taps**: "SURE? N GUESSES ▶" for 4 s. |
| 6 | What the card shows | First question, its guess, "+N more", ACCEPT GUESSES. |
| 7 | Page buttons | **One smart main button** (ACCEPT ALL GUESSES → SEND ANSWERS · N changed) plus a quiet WRITE IT NOW. |
| 8 | Note box | Kept, under the answers. |
| 9 | Plugins | **Whole plugins** (skills, hooks, MCP) via `--plugin-dir`, **allowlisted** in GAME RULES; failures quiet and reported in INFO. |
| 10 | Personal skills | **Allowlist** in GAME RULES; no exclude list. |
| 11 | CLAUDE.md and rules | **Mounted read-only.** Petree's stage instructions and `_thread` contracts win, as the prompt says. |
| 12 | Duplicate skill names | First wins (shared, then personal); the others are skipped and listed. |
| 13 | Gate actions | Answer (or accept the guesses), WRITE IT NOW, or GAME OVER only. |
| 14 | Invalid questions file | Keep the valid questions; none valid → normal document gate. |
| 15 | When a stage asks again | First turn of each visit to a stage. |
| 16 | Synced skills | Skipped. |
| 17 | QUESTING wording | "Preparing questions · PLAN · 3m". |

### 11.2 Decided (2026-11-14, follow-up round)

| # | question | decision |
|---|---|---|
| N1 | What WRITE IT NOW sends | **The form as it stands**: edits kept, untouched answers as "guess kept", an empty no-guess question as "no answer — decide yourself". |
| N2 | Default allowlists | **Interview plugins on by default**: installed plugins that ship `interview-me` / `brainstorming` / `spec-driven-development` (`agent-skills`, `superpowers`) are allowlisted until GAME RULES saves another list. The USED BY INTERVIEW tag stays. |
| N3 | Plugins with a Stop hook | **Allowed**, with the warning chip. |
| N4 | MCP servers and the host's login | **Petree's own MCP file** (§5.8.4): an MCP SERVERS allowlist in GAME RULES; only those definitions are copied (0600) and passed with `--mcp-config`. `~/.claude.json` is never mounted. Servers whose token lives outside the config show "needs login". |
| N5 | Cost of many rounds | **No cap** beyond the round header for now. |
| N6 | Unresolved `@imports` | **Accept, with a hint** in GAME RULES. |

### 11.3 Decided (2026-11-14, last round)

- **PLAN after SCOUT**: PLAN asks only what writing the plan newly raised; usually it writes the
  spec straight away for review (§5.4).
- **S1 → (a), no strict.** The user keeps the MCP allowlist restrictive.

- **S1. Pass `--strict-mcp-config` too?** It would make `claude.mcp.json` the only MCP source.
  It would also drop the MCP servers of allowlisted plugins (and claude.ai connectors), which
  decision 9 keeps.
  - (a) **No strict.** The only other sources in the sandbox are the empty per-thread session
    config and a `/work/.mcp.json` the agent would have to write itself.
  - (b) Strict, and petree also copies allowlisted plugins' MCP definitions into the file,
    rewriting `${CLAUDE_PLUGIN_ROOT}` to `/petree/plugins/<slug>`.

  *Recommendation: (a).* (b) closes a door the agent can walk around anyway (it can start any
  process), at the cost of re-implementing plugin MCP loading.

## Risks in the decisions (for the reviewer)

- **The `interview-me` skill is built on one question at a time.** The batch form overrides its
  core rule, so the prompt borrows only its question selection. Model-decided rounds make up
  for part of that.
- **No hard cap on rounds**: an over-eager agent can keep asking. Each round costs a resumed
  turn, and only the user's WRITE IT NOW stops it (decision N5).
- **INTERVIEW on by default + AUTO-PLAY stops at questionnaires**: every AUTO-PLAY quest stops
  at the SCOUT questionnaire. PLAN usually doesn't ask again after an answered SCOUT round
  (§5.4), so one stop is the common case; PLAN still stops if writing the plan raises new
  questions.
- **MCP secrets readable by the agent**: accepted; the user keeps the MCP allowlist
  restrictive. No `--strict-mcp-config` (§11.3 S1 decided: off).
- **Whole plugins**: their hooks run in every turn of the thread. A persona hook changes the
  agent's style; a Stop hook can loop until the timeout (decision N3). MCP servers may try the
  network. With N2, `superpowers` is on by default, and its SessionStart hook comes with it.
- **MCP secrets in the sandbox**: allowlisted servers' tokens and env values are readable by
  the agent (it needs them to start the server). A careless agent could print one into a log,
  a spec or a PR. Allowlist only servers whose tokens you'd trust to an unattended agent.
- **CLAUDE.md and rules**: machine and infrastructure details reach every thread, and rules
  written for interactive sessions ("ask before…", "use MCP X") can still tug at the agent,
  despite the stated precedence.
- **ACCEPT GUESSES from the inbox** answers questions the user never read. The two taps make it
  deliberate, not informed.
