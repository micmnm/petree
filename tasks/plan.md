# Implementation Plan: Reorganise the OPTIONS page

## Overview

Implement `/work/_thread/spec.md`: split petree's single-scroll OPTIONS page
(20-repo roster, 11-field GAME RULES, an unbounded `~/.claude` checkbox wall,
one non-sticky SAVE) into four hash-routed tabs, a global search box, a
deep-linkable per-repo page, and one sticky SAVE whose drafts survive
navigating the app (but not a reload).

## Architecture Decisions

- **New pure module `src/options-state.js`**, sibling to `markdown.js` /
  `activity.js`: route parsing, draft-dirty bookkeeping, and the search index/
  ranking. DOM-free, tested under plain vitest — no jsdom, no new dependency.
- **No server or API change.** Every input the client needs is already exposed.
- **`drafts = {}` is deleted, not rescoped** (spec decision 10): leaving OPTIONS
  keeps unsaved edits; only SAVE or an explicit DISCARD ALL clears them. Re-entry
  re-fetches but must not clobber a dirty field (spec R12).
- **Phase 1 ships independently of phase 2** (spec decision 14): sticky save bar
  and roster search/tag-filter touch neither routing nor draft lifetime, so they
  land first and stay useful even if phase 2 is delayed.
- **`npm test` is the only automated gate.** `dashboard.html` has no test
  harness; UI behaviour that needs a DOM (tab switching, focus, highlighting,
  the sticky bar) is verified by code tracing, not execution — there is no
  browser available in this environment.

## Dependency Graph

```
src/options-state.js (+ test/options-state.test.ts)         [T1, independent]
docs/design/handheld-arcade.md vocabulary edit (R40)         [T2, independent]
dashboard.html Phase 1: sticky SAVE, roster search+tags      [T3, independent]
        │
        ▼
dashboard.html Phase 2 core: routing, draft lifetime,         [T4, needs T1 + T3]
  save-bar fan-out fix (R7-R19)
        │
        ▼
dashboard.html Phase 2 content: repos tab, repo page,         [T5, needs T4]
  rules tab, ~/.claude tab (R25-R37)
        │
        ▼
dashboard.html Phase 2 global search (R20-R24)                [T6, needs T1 + T5]
        │
        ▼
Integration: npm test, typecheck, syntax-check the inline     [T7, lead agent]
  <script type="module">, fix issues
        │
        ▼
Code review pass (correctness, readability, security,         [T8, optional]
  architecture, performance)
```

## Task List

### Wave 1 — parallel, no file overlap

- [ ] **Task 1 (T1): `src/options-state.js` + `test/options-state.test.ts`**
  - TDD: write failing tests first, then implement
  - Exports: `parseOptionsHash(hash)`, `optionsHash(route)`, `normFields(fields)`,
    `isDirty(draft)`, `dirtySummary(items)`, `forwardHash(moved, hash)`,
    `buildSearchIndex({ repos, settingsFields, claude })`,
    `searchOptions(index, query, limit)`
  - Cover: route round-trip for every route incl. repo names with `.`/`-`/`_`
    and a repo literally named `recruit`; unknown tab/sub-tab fallback;
    `normFields` list handling (tags split/trim/dedupe/sort, blank command
    lines dropped, empty values omitted); `isDirty` false on round-trip, true
    after one change; `dirtySummary` wording for 0/1/N; `forwardHash` chaining
    and no-op; search ranking order, 8-result cap, case-insensitivity, no-match,
    help-text-only match
  - Verify: `npm test -- test/options-state.test.ts`

- [ ] **Task 2 (T2): docs edit (spec R40)**
  - `docs/design/handheld-arcade.md`: fix the `BACK` row (no longer "leave
    without saving"), add the tab names and DISCARD ALL to the vocabulary table
  - Verify: read the diff; no test covers prose

- [ ] **Task 3 (T3): `dashboard.html` Phase 1 — sticky SAVE, roster search + tags**
  - Spec R1-R6
  - Sticky save bar: `position: sticky; bottom: 0`, mirroring `.nq-foot`
  - Repo search input mounted outside `#roster` (survives re-render), filters
    by toggling `hidden` on existing rows — never re-renders `#roster` on
    keystroke
  - Tag filter radiogroup beside it, reusing `.o-picks`/`pick()`
  - Live count ("7 of 20") and an empty state
  - Structure the match predicate as one isolated function so Task 6 can lift
    it into `options-state.js` unchanged
  - Verify: `npm test` (no regressions; this view has no direct test)

### Wave 2 — sequential, after T1 + T3

- [ ] **Task 4 (T4): `dashboard.html` Phase 2 core — routing, draft lifetime, save bar**
  - Spec R7-R19
  - Extend `route()` to parse `#/options/...` prefixes via
    `parseOptionsHash`/`optionsHash` from `options-state.js`
  - Delete the `drafts = {}` reset on entering options; re-scope the three
    loads + `saveMsg` clear to "arriving from another view" only
  - Re-entry must not clobber a dirty field: always refresh `defaultValue`,
    set `.value` only on untouched fields (mirror the `chSync` keep-pattern)
  - Add DISCARD ALL (two-click confirm, matching DISMISS) and an unsaved
    indicator on the header gear
  - Rework the save bar into persistent chrome: dirty summary (via
    `dirtySummary`), SAVE, DISCARD ALL, BACK, RAW link, `saveMsg`
  - On a failed write, navigate to the failing repo/tab before rendering its
    error box
  - Fix the fan-out bug: first failure aborts all remaining writes (today a
    failed repo write skips the defaults PUT but still sends the settings PUT)
  - Verify: `npm test`; trace through criterion 5 and 7 by hand (edit two
    things, navigate away and back, confirm both still dirty; force a 409 and
    confirm nothing else got written)

### Wave 3 — sequential, after T4

- [ ] **Task 5 (T5): `dashboard.html` Phase 2 content — repos/rules/claude tabs, repo page**
  - Spec R25-R37
  - Repos tab: slim rows (hue, name, tags, idle badge, edited badge, last-quest
    age), whole row links to `#/options/repo/<name>`; keep scoreboard, sort,
    and Task 3's search/tag filter
  - Repo page: BASICS / INSTRUCTIONS / COMMANDS / USAGE headings, no sub-tabs;
    DISMISS and the YAML-anchors RAW-ONLY fallback both still work;
    `#/options/recruit` on its own page
  - Rules tab: QUEST DEFAULTS visible (concurrency, token budget, two
    timeouts); ADVANCED as a `<details>` (window budget, two clean-up counts,
    LM Studio ×4) — must be a real `<details>`, not `hidden`, so its fields
    stay in the DOM for search (Task 6) while closed
  - `~/.claude` tab: SKILLS/PLUGINS/MCP sub-tabs, INSTRUCTIONS switch + SYNC in
    the tab header above them; SYNC still refreshes the RAW editor afterwards
  - Verify: `npm test`; trace criteria 2, 4, 6

### Wave 4 — sequential, after T1 + T5

- [ ] **Task 6 (T6): `dashboard.html` Phase 2 — global search**
  - Spec R20-R24
  - One combobox in the OPTIONS header, mounted outside every re-rendered
    region, keyboard pattern matching `nqSearch` (↑/↓/enter/esc)
  - Build the index by walking `#rules .o-field` for setting entries (label +
    help text + input name) rather than a hand-kept table — plus repos, tags,
    skills, plugins, mcp servers, and the RAW page — using
    `buildSearchIndex`/`searchOptions` from `options-state.js`
  - Opening a result navigates to its tab/repo page and highlights the target
    (scroll into view, `.hit` outline cleared after 2500 ms or next keystroke);
    open ADVANCED first if the target is inside it
  - Verify: `npm test`; trace criterion 3 (typing "token" surfaces TOKEN
    BUDGET and opens ADVANCED if closed)

### Integration Checkpoint

- [ ] **Task 7 (T7, lead agent): integrate and verify**
  - Run `npm install`, `npm test`, `npm run typecheck`
  - Extract the `<script type="module">` body and run `node --check` on it as
    a syntax safety net (`npm run typecheck` does not cover `.html`/inline
    `<script>`, and misses ESM default-import breaks per existing project note)
  - Re-read the full options section of `dashboard.html` end to end once,
    checking the four waves compose (no leftover references to deleted
    functions, no duplicate IDs, no dead CSS)
  - Fix anything broken

### Optional

- [ ] **Task 8: code review pass** (`agent-skills:code-reviewer`) across the
  diff — correctness, readability, architecture, security, performance

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Draft-wipe trap recurring in a different form during T4 | T4's acceptance criteria explicitly require tracing criterion 5 by hand before moving on |
| T5 and T6 both touch the options markup heavily — running them in parallel would conflict | Kept strictly sequential (Wave 3 then Wave 4), not dispatched together |
| No jsdom/browser in this environment to verify UI | T7's `node --check` catches syntax errors; behavioural correctness is verified by code tracing against the spec's criteria, stated as a limitation, not claimed as tested |
| Search index drifting from markup labels | T6 walks the live DOM for setting entries instead of a hand-kept table |
| Four sequential dashboard.html-editing tasks losing context between agents | Each task is handed exact spec section references (R-numbers) and told to grep for current anchors rather than trust stale line numbers |

## Parallelization

**Run in parallel:** Tasks 1, 2, 3 (Wave 1) — no file overlap.
**Must be sequential:** 1,3 → 4 → 5 → 6 → 7 → 8. Tasks 5 and 6 are deliberately
*not* parallelized despite being separate spec sections, because both rewrite
large shared regions of the same single file.

## Open Questions

Carried from the spec, non-blocking (each has a stated default there): the
scannable signal on a slim repo row (last-quest age), whether the gear's
unsaved indicator is wanted, a picked-only filter on the `~/.claude` tab, tag
filter persistence, and whether the docs vocabulary edit belongs in this work.
