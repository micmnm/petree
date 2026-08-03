# Petree restart survival — design

Date: 2026-08-03
Status: approved

## Problem

Petree launches each turn as a `docker run --rm --init` child process of the
server. When the server process dies (deploy restart, crash, Ctrl+C), the
docker client child is killed with it, `--init` stops the container, and
`--rm` erases it. The task row stays `running` in the DB forever:

- No startup pass reconciles `running`/`provisioning` rows, so nothing ever
  drives them to a terminal state (`index.ts` boots straight into the
  scheduler).
- The phantom `running` row permanently occupies a scheduler concurrency slot
  (`scheduler.ts` counts `running + provisioning` against the limit).
- `running` is in neither `FOLLOWUP_STATES` nor `RESUMABLE_STATES`, so the
  dashboard offers no way to unstick it.

Observed live: task `deb92764` — server restarted at 21:33 while turn 3 was
mid-flight (last log write 21:32:43); container vanished, row stuck `running`.

## Goal

Restarting the petree server must not interrupt in-flight turns. Turns keep
running while the server is down; on startup the server re-attaches. If a
container died while the server was down, the task continues automatically
via `--resume`, with backoff so a crash-looping setup cannot burn tokens.

## Decisions (with user)

1. **Keep running** — containers outlive the server; re-attach on startup.
2. **Dead container → auto-requeue + resume**, bounded, with backoff.
3. **Streaming via `docker logs --follow`** (not file redirection inside the
   container).

## Design

### 1. Container lifecycle — detach from the server process

`buildDockerCommand` switches from `docker run --rm --init` to
`docker run -d --init --name petree-<id>`. The container is owned by the
docker daemon and survives server death. `--rm` is dropped so an exited
container's logs and exit code remain collectable even if the server was down
when it exited. Petree removes containers explicitly (`docker rm`) once a
turn is finalized, and defensively (`docker rm -f`) before launch if a stale
container holds the name.

### 2. Streaming — one code path for launch and re-attach

`CliRunner` no longer treats the docker client as the process:

- `docker run -d ...` starts the container (fast exit, prints container id;
  non-zero exit → runner `error` event).
- `docker logs -f petree-<id>` is spawned as the stream source; its stdout is
  parsed line-by-line exactly as today.
- Exit code comes from `docker wait petree-<id>`; the runner's close logic
  (last `done` result wins; non-zero exit without result → `error`; clean
  exit without result → nothing, launcher reconciliation fails the task) is
  unchanged.

Re-attach is the same flow plus a `skipLines: K` option:

- At container launch, the byte offset of `logs/<id>.log` is persisted on the
  task row (`logOffset`). K = number of lines in the log file after that
  offset — i.e. lines this turn already streamed before the restart.
- The first K replayed lines run in *replay mode*: they rebuild in-memory
  state (`countedMessageIds`, `lastResult`, `sessionId`) but are not written
  to the log file and add no usage to the store (those tokens are already in
  `tokensUsed`). Lines after K are live and handled exactly as today.
- Accepted drift: a line flushed to the log whose `addUsage` didn't commit
  before the crash is skipped on replay — bounded to one message.

### 3. Startup reconciliation

New `recover(store, launcher)` module, called from `index.ts` before the
scheduler's first tick. For each task in `running` or `provisioning`,
`docker inspect petree-<id>`:

| Container state | Action |
| --- | --- |
| running | Re-attach (§2); task stays `running`. |
| exited | Replay full logs to finalize (result/usage), apply the runner's terminal logic (`done`/`failed`), then `docker rm`. A turn that finished while petree was down completes normally, including the commit-capture step. |
| absent | Auto-requeue with backoff (§4). Relaunch picks up `--resume <sessionId>` via the existing transcript-existence gate, so the turn continues from the persisted session. |

`provisioning` tasks always take the requeue path (no container is guaranteed
to exist yet; workspace prep is idempotent/reused).

State machine additions in `store.ts`: `running → queued` and
`provisioning → queued` (used only by recovery requeue).

### 4. Auto-requeue with backoff

Two new persisted fields on the task row:

- `restarts` — recovery-requeue count since the last completed turn.
- `retryAt` — earliest time the scheduler may pick the task up again.

Each recovery requeue: `restarts += 1`;
`retryAt = now + min(30s × 4^(restarts−1), 15m)` → 30s, 2m, 8m, 15m, 15m.
After **5** restarts without a completed turn, the task transitions to
`failed` with a clear error instead of requeueing. `nextQueued()` skips rows
with `retryAt` in the future. Finalizing a turn (any terminal transition out
of `running`) resets `restarts` to 0. This bounds token spend even if the
petree server itself is crash-looping on startup.

### 5. Timeout and budget across restarts

- Token budget: nothing new — `tokensUsed` is persisted and fed back as
  `alreadyUsed`.
- Timeout: turn start time (`startedAt`) is persisted at container launch.
  On re-attach the runner arms its timer with
  `remaining = timeoutMs − elapsed`, clamped to 0 (which triggers the
  `limit`/timeout path immediately). A restart can never extend a turn's
  deadline.

### 6. Stop/cancel

`launcher.stop()` switches from killing the child process to
`docker stop -t 5 petree-<id>` (docker's own TERM → grace → KILL). Keyed by
container name, it works identically for freshly-launched and re-attached
tasks. The pre-spawn cancellation path (`provisioning` with no container)
is unchanged.

### 7. Testing

TDD throughout, using existing seams:

- `LauncherOptions.buildCommand` injection + a fake `docker` shim script for
  launcher and reconciliation tests (running/exited/absent × task states).
- `CliRunner` unit tests: replay-mode skip counting, usage dedup across
  re-attach, timeout clamped to zero, exit-code via `docker wait`.
- Scheduler tests: `retryAt` gating, 5-restart cap → `failed`, `restarts`
  reset on completion.
- End-to-end: start a turn against the shim, simulate a restart (new store
  instance + `recover()`), assert the task finalizes `done` with correct
  tokens and a single log copy.

## Out of scope / unchanged

- Dashboard, `/next`, `/resume`, commit-on-finish flows are unchanged
  (reconciliation triggers commit capture for turns finalized offline).
- OAuth token is still passed via `-e` (visible in `docker inspect`) — same
  exposure as today, not widened by this change.
- Multi-host or non-docker runtimes.
