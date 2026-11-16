# Task List: Host-Aware PR Labels

## Phase 1: Foundation

- [ ] Task 1: Add host label helpers to `src/prs.ts` — `hostKindOf()` and `hostLabel()`

## Phase 2: Refactor Callers (Parallel)

- [ ] Task 2: Update `src/server.ts` — remove validation, add `hostKind` field
- [ ] Task 3: Update `src/inbox.ts` — rebuild `prLabel` on shared helper

## Phase 2 Checkpoint

- [ ] Both `test/server.test.ts` and `test/inbox.test.ts` pass

## Phase 3: Client Updates

- [ ] Task 4: Update `src/dashboard.html` — compute SHIP IT button text

## Phase 4: Cleanup

- [ ] Task 5: Delete `repoHostKind` from `src/config.ts` and its tests

## Phase 5: Test Updates

- [ ] Task 6: Update `test/server.test.ts` for mixed-host allowance
- [ ] Task 7: Update `test/inbox.test.ts` for new label wording

## Checkpoint: All Tests Pass

- [ ] Run `npm test` (full suite) and verify all pass
