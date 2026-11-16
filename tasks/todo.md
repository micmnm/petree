# Task List: Reorganise the OPTIONS page

## Wave 1: Foundation (Parallel)

- [x] Task 1: `src/options-state.js` + `test/options-state.test.ts` (route parsing, draft bookkeeping, search index)
- [x] Task 2: Docs vocabulary edit (`docs/design/handheld-arcade.md`, spec R40)
- [x] Task 3: `dashboard.html` Phase 1 — sticky SAVE bar, roster search + tag filter (spec R1-R6)

## Wave 2: Core (depends on 1, 3)

- [x] Task 4: `dashboard.html` Phase 2 core — routing, draft lifetime, save-bar fan-out fix (spec R7-R19)

## Wave 3: Content (depends on 4)

- [ ] Task 5: `dashboard.html` Phase 2 content — repos tab, repo page, rules tab, `~/.claude` tab (spec R25-R37)

## Wave 4: Search (depends on 1, 5)

- [ ] Task 6: `dashboard.html` Phase 2 — global search (spec R20-R24)

## Integration Checkpoint

- [ ] Task 7: Lead agent integrates — `npm install`, `npm test`, `npm run typecheck`, syntax-check inline script, fix issues

## Optional

- [ ] Task 8: Code review pass across the full diff

## Checkpoint: All Tests Pass

- [ ] Run `npm test` (full suite) and verify all pass
