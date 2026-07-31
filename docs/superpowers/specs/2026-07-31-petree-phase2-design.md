# Petree Phase 2 — Result Visibility & Task UX

*Design spec — 2026-07-31. Builds on Phase 1 (see 2026-07-30-petree-sandbox-orchestrator-design.md).*

## 1. Purpose

Phase 1 runs tasks unattended but surfaces almost nothing: the agent's answer
lives only inside a large stream-json log, repos are typed as free text, the
prompt box is one line, and there is no per-task detail view. Phase 2 closes
these gaps and adds per-task model selection. No new dependencies; same
TDD + subagent review flow as Phase 1.

Five features, two plan-phases (backend first so the UI renders real data):

- Capture and display the task **result** text.
- **Per-task model** selection (`--model`), with an optional registry default.
- A **repo multi-select** in the create form, fed by a new repos endpoint.
- A **smarter prompt editor** (auto-resize, keyboard submit, draft persistence).
- A **split list + detail** dashboard showing prompt, details, result, error,
  and the live log for one task.

## 2. Plan-Phase A — data & API

### 2.1 Store: `result` and `model` columns

Add two nullable TEXT columns to the `tasks` table: `result` and `model`.
`TaskRecord` gains `result: string | null` and `model: string | null`.

- `create({..., model})` persists `model` (nullable).
- New `setResult(id, text): TaskRecord` writes `result`.
- Migration: the table is created with the columns; for an existing DB, the
  constructor runs `ALTER TABLE tasks ADD COLUMN result TEXT` /
  `... ADD COLUMN model TEXT` guarded by a pragma check (idempotent), so a
  Phase-1 `petree.db` keeps working.

### 2.2 Launcher: capture the result

On the `done` event, before the terminal transition, call
`store.setResult(task.id, e.result)`. The reconciliation and failure paths are
unchanged. `error` remains the field for failures; `result` for successes.

### 2.3 Config: `default_model`

`Defaults` gains `defaultModel: string | null` (YAML `default_model`, default
null). `RepoConfig` gains `defaultModel: string | null` (per-repo override).
Resolution order for a task's effective model: explicit task `model` →
first-repo `default_model` → `defaults.default_model` → null (CLI default).

### 2.4 Sandbox: `--model`

`buildDockerCommand` takes the task's effective model. When it is non-null and
not the literal `default`, append `--model <model>` to the `claude` args
(after `-p <prompt>`, before `--output-format`). Otherwise omit it — the CLI
uses the account default.

### 2.5 API

- `POST /api/tasks` accepts optional `model`. Validate against the allowlist
  `['default','haiku','sonnet','opus']`; unknown → 400. Resolve the effective
  model (task → repo default → global default) and store it.
- `GET /api/repos` → `[{ name, defaultBranch, image, defaultModel }]` from the
  loaded config, for the dashboard's selector.
- `GET /api/tasks/:id` already returns the full record, now including `result`
  and `model`.

Model allowlist lives in one exported constant (`MODELS`) so the API and any
future validation share it.

## 3. Plan-Phase B — dashboard

### 3.1 Markdown renderer — `src/markdown.js`

A standalone plain-ESM module (no deps, no TypeScript) so it is importable by
**both** vitest and the browser `<script type="module">`.

- `renderMarkdown(text: string): string` returns an HTML string.
- **Escape first**: every character of the input is HTML-escaped before any
  formatting, so container-sourced result text can never inject markup
  (consistent with the Phase 1 XSS fix).
- Supported: `#`–`###` headings, `**bold**`, backtick inline code, triple-fence
  code blocks, `-`/`1.` lists, blank-line-separated paragraphs. Anything else
  passes through as escaped text.
- The server serves it at `GET /markdown.js` (read from the module dir, like
  `dashboard.html`), and the dashboard imports `./markdown.js`.

### 3.2 Layout: list + detail

- Left: the task list (id, state badge, repos, tokens) — polls every 3s.
- Right: a detail panel bound to the selected task id. Selecting a row loads
  `GET /api/tasks/:id` and its logs; the panel refreshes on each poll while
  a task is selected.
- Detail panel contents: full prompt, state, repos, model, tokens used/budget,
  created/updated timestamps, session id; **result rendered as markdown** when
  `state === 'done'`; **error** text when `state === 'failed'`; the live log
  (`textContent` sink, unchanged) below.

### 3.3 Create form

- **Repos**: checkboxes populated from `GET /api/repos` (replaces the free-text
  comma field). At least one must be checked to submit.
- **Model**: a `<select>` — `default` plus the allowlist aliases.
- **Prompt**: a `<textarea>` that auto-resizes to its content; **Cmd/Ctrl+Enter
  submits**; the in-progress value is mirrored to `localStorage` on input and
  restored on load, cleared on successful submit.

### 3.4 Safety

All task fields rendered into the DOM stay on safe sinks: the markdown renderer
escapes before formatting; every non-result interpolation continues to use the
Phase-1 `esc()` helper or `textContent`. The log-id traversal guard and the
`127.0.0.1` bind are unchanged.

## 4. Testing

- **store**: `model` persists via `create`; `setResult` round-trips; the
  ALTER-COLUMN migration is idempotent on a fresh and a pre-existing DB.
- **config**: `default_model` parsed at both levels; resolution order.
- **sandbox**: `--model` present when a model is set; absent for `default`/null.
- **server**: `GET /api/repos` shape; `POST` with a valid model stores it; an
  invalid model → 400; effective-model resolution.
- **markdown**: HTML is escaped before formatting (an `<img onerror>` in the
  input renders inert); each formatting rule; plain text passthrough.
- **dashboard wiring**: manually verified (no DOM harness in this project),
  but the markdown logic it depends on is unit-tested via `src/markdown.js`.

## 5. Out of scope (later phases)

Interactive checkpoints (plan approval, clarifying questions), rate-limit
auto-detection, container re-attach after restart, per-repo setup/test
execution, model allowlist enforcement/caps, persistent `CLAUDE_CONFIG_DIR`
mount for real resume, and network-egress policy — all remain future phases.
