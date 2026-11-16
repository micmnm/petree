# Implementation Plan: Host-Aware PR Labels (GitHub/Azure)

## Overview

Implement spec `/work/_thread/spec.md`: make the SHIP IT button and inbox card PR labels show the actual host(s) of repos being shipped. Removes the hardcoded "GitHub/Azure" text with a dynamic label, allows mixed-host threads, and consolidates two duplicate host-detection functions onto one shared helper.

## Architecture Decisions

- **Shared helper in `src/prs.ts`:** Both `src/server.ts` and `src/inbox.ts` will consume `hostLabel()` and `hostKindOf()` from `prs.ts`, eliminating the duplicate `repoHostKind()` function in `config.ts`.
- **Expose `hostKind` field, compute client-side:** `GET /api/repos` gains `hostKind: 'github'|'azure'|'unknown'` per repo; `dashboard.html` computes button text locally, mirroring the existing merged-screen pattern (`dashboard.html:1932`).
- **No breaking changes to contracts:** `url` field stays private (not sent to browser); all existing API consumers unaffected.
- **Sequential test updates:** Each source file change gets its test updated in parallel; checkpoint runs full suite once all changes land.

## Dependency Graph

```
src/prs.ts (add helpers)
    ├── src/server.ts (use helpers, expose hostKind, remove validation)
    │       └── src/dashboard.html (compute labels from hostKind)
    │
    ├── src/inbox.ts (use helpers, rebuild prLabel)
    │
    └── src/config.ts (delete repoHostKind after callers migrated)

test/{server,inbox,config}.test.ts (update/add tests per source changes)
```

## Task List

### Phase 1: Foundation

- [ ] **Task 1: Add host label helpers to `src/prs.ts`**
  - Add `hostKindOf(url)` function: thin wrapper on `prHost()` that returns `'github'|'azure'|'unknown'` (treating `'untracked'` as `'unknown'`)
  - Add `hostLabel(kinds: HostKind[])` function: takes array of kinds, returns `''` for no recognized hosts, `'GitHub'` for GitHub-only, `'Azure'` for Azure-only, `'GitHub/Azure ⚠️'` for mixed
  - Export both functions and a new `HostKind` type
  - No tests yet; we test it via the callers

### Phase 2: Refactor Callers (Parallel)

- [ ] **Task 2: Update `src/server.ts` — remove validation, add `hostKind` field**
  - Delete the mixed-host validation block (`src/server.ts:128-133`)
  - Replace `repoHostKind` import with `prHost` (already imported for other uses)
  - In `GET /api/repos` handler, add `hostKind` field to each repo object: `hostKindOf(r.url)` (import from prs)
  - Update test file per Task 4 below
  - Verify: `npm test -- test/server.test.ts`

- [ ] **Task 3: Update `src/inbox.ts` — rebuild `prLabel` on shared helper**
  - Replace the `getHostInfo`/`hostSuffix` logic with a call to `hostLabel()`
  - Import `hostKindOf` and `hostLabel` from `src/prs.ts`
  - Rebuild all three branches (`Open the PR`, `Push the update`, `Merge PR #N`) using a helper like `withHost(base, repos)` that applies the host label
  - Drop the direct usage of `prHost(...).kind === 'azure' ? 'Azure DevOps' : 'GitHub'`; use `hostLabel()` instead
  - Update test file per Task 5 below
  - Verify: `npm test -- test/inbox.test.ts`

### Phase 2 Checkpoint
- [ ] Both `npm test -- test/server.test.ts` and `npm test -- test/inbox.test.ts` pass

### Phase 3: Client Updates

- [ ] **Task 4: Update `src/dashboard.html` — compute SHIP IT button text**
  - In `thMoves()`, the `need.length` branch (line 1734 area): replace the hardcoded `'open PR on GitHub/Azure'` with a computed label
  - Define a local helper (or inline logic) that reads `hostKind` from `allRepos` (via `repoOf(name)`) and calls `hostLabel()` equivalent
  - Reuse pattern: `const kind = repoOf(name)?.hostKind; ...` (no function import needed, just inline logic matching existing merged-screen pattern at line 1932)
  - Leave the `stale.length` branch (line 1735) unchanged per spec's scope
  - No test harness exists for dashboard.html JS; verify by hand against mixed-host setup

### Phase 4: Cleanup

- [ ] **Task 5: Delete `repoHostKind` from `src/config.ts` and its tests**
  - Remove `repoHostKind` function definition and its regex consts (`GITHUB_REGEX`, `AZURE_REGEX`, `AZURE_VS_REGEX`) if unused elsewhere
  - Confirm deletion: `git grep GITHUB_REGEX` and `git grep AZURE_REGEX` must return nothing in src/ (other than patterns in prs.ts)
  - Remove both `describe('repoHostKind', ...)` blocks from `test/config.test.ts` (lines 301-325 and 327-358 in current HEAD)

### Phase 5: Test Updates

- [ ] **Task 6: Update `test/server.test.ts` for mixed-host allowance and `hostKind` field**
  - Replace test `'rejects thread mixing GitHub and Azure repos'` with `'accepts thread mixing GitHub and Azure repos'` (expects 201, both repos present)
  - Keep all other tests unchanged (single-host GitHub, single-host Azure, multi-GitHub, multi-Azure, unknown-host, GitHub+unknown; all expect 201)
  - Add one test: `'GET /api/repos includes hostKind per repo'` — fetch repos, assert each has `hostKind: 'github'|'azure'|'unknown'`, assert `url` is not present
  - Verify: `npm test -- test/server.test.ts`

- [ ] **Task 7: Update `test/inbox.test.ts` for new label wording**
  - Rewrite the `describe('prLabel with multi-host repos', ...)` block (added in commit 34d2334) to assert new wording:
    - `'Open the PR on GitHub'` (single GitHub, was `'Open the PR'`)
    - `'Open the PR on Azure'` (single Azure)
    - `'Open the PR on GitHub/Azure ⚠️'` (mixed, was `'Open the PR (azure+github)'`)
    - `'Merge PR #1 on GitHub/Azure ⚠️'` (was `'Merge PR #1 on (azure+github)'`)
    - `'Push the update to PR #1 on GitHub/Azure ⚠️'` (was `'Push the update to PR #1 (azure+github)'`)
  - Add one new test case with an unrecognized-host repo in the mix: assert host label is computed only from recognized hosts
  - Keep existing tests for single-host cases unchanged
  - Verify: `npm test -- test/inbox.test.ts`

### Checkpoint: All Unit Tests Pass
- [ ] `npm test` (full suite)
- [ ] All pass (server, inbox, config tests)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Deleting `repoHostKind` too early | Tests fail if a caller is missed | Task 5 is last; confirm no grep hits after deletion |
| Mixed-host threads break somewhere untested | Runtime error on dashboard or PR creation | Manual test with a repos.yaml having one GitHub, one Azure repo; create a mixed thread, verify SHIP IT label and button work |
| `hostKind` field mismatch between code and tests | Test false positives | Verify test assertions match the function outputs exactly |

## Parallelization

**Can run in parallel:**
- Task 2 (server.ts) and Task 3 (inbox.ts) are independent; both consume the same helpers from Task 1 but don't depend on each other
- Task 6 and Task 7 (test updates) can follow Tasks 2 and 3 in parallel

**Must be sequential:**
- Task 1 → Tasks 2 & 3 (depend on helpers)
- Task 4 → Task 2 (depends on `hostKind` field being exposed)
- Task 5 must be last (deletes code that Task 2 and 3 stop using)

## Expected Changes Summary

- **src/prs.ts:** +8 lines (2 functions + type export)
- **src/server.ts:** +2 lines (one field in response), −6 lines (delete validation block), rewrite import
- **src/inbox.ts:** ~15 line rewrite (inline helper + three branches using hostLabel)
- **src/config.ts:** −11 lines (delete repoHostKind and regex consts)
- **src/dashboard.html:** ~10 line rewrite (compute button label instead of hardcoding)
- **tests:** rewrite existing test blocks (no net addition, replacing assertion wording)

## Open Questions

None blocking; all decisions from the spec are clear. Manual testing of mixed-host threads recommended before shipping.
