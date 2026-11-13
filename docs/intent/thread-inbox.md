# Intent: petree as a thread inbox

Confirmed 2026-11-13.

- **Outcome:** one calm screen listing every thread: short topic, current state,
  how far along (investigate → spec → build → PR → merged), and what it needs
  from me. Open one to read the short md/spec, then approve or comment right there.
- **User:** just me, across personal (GitHub) and work (Azure DevOps) repos.
- **Why now:** several threads at once; terminals and the current cluttered
  dashboard leave me lost between them, which makes the idea feel weaker than it is.
- **Success:** back after an hour or a day, I see in seconds what needs me and move
  each thread on with read + approve/comment, no logs or terminals.
- **Limits:** redo the UI; keep the engine, but improve it where it helps this
  (agent writes the short status and "needs you" line, progress tracked through
  PR/merge, tasks always start from the latest code).
- **Not in:** live log watching as a main view, deep code review (stays in IDE/PR),
  taking over a thread interactively, multi-user or a public product.

## Context

- Most of petree's existing PRs were dashboard polish (log view, markdown,
  settings, layout); the engine underneath (sandboxed runs, `repos.yaml`,
  stages + gates, notes, push/PR) is the part that works.
- PR #13 was built on a stale base because tasks clone from the remote and local
  work was unpushed — hence "always start from the latest code".
- Nothing found on the market covers local, Max-subscription, Azure DevOps +
  GitHub, stage-gated threads with per-repo memory (market scan, Nov 2026).
