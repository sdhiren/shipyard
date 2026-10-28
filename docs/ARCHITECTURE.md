# Architecture

## Item lifecycle

```
             approve                 up_next              implement (Claude)
  proposed ───────────▶ backlog ───────────▶ planned ───────────────────▶ in_progress
     │ reject              │  ▲                  │                            │
     ▼                     │  └── restore ──┐    │                 run ok + commits
  rejected                 │                │    │                            ▼
                    skip / archive          │    │   revise (Claude) ◀──── in_review ──── PR merged ──▶ done
                           ▼                │    │                            │
                   skipped / archived ──────┘    └── run failed / no changes ─┘ (back to planned)
```

- `proposed` is the **Inbox**: AI suggestions and imports wait there until a human decides.
- Snoozing keeps the status but hides the item until `snoozedUntil`.
- Every transition is written to `activity`, which is the item's timeline.

## Data model (SQLite via Drizzle)

| Table | Purpose |
|---|---|
| `projects` | A registered repo: path, detected `stack`, `git` snapshot, `settings` (JSON), `health` scores, `key_prefix`, `next_item_number` |
| `items` | Backlog items with planning fields (type, priority, effort, impact, plan, acceptance criteria), provenance (`source`, `source_ref`, `analysis_id`, `rationale`) and delivery state (branch, worktree, Claude `session_id`, PR snapshot, cost) |
| `analyses` | One row per "Explore with Claude": focus, summary, strengths, risks, health, suggestion count, cost |
| `runs` | Every Claude invocation (`analyze`, `plan`, `implement`, `revise`): status, prompt, session, cost, duration |
| `run_events` | The streamed transcript of a run, ordered by `seq` |
| `activity` | The append-only timeline for projects and items |
| `settings` | Global settings (concurrency, PR poll interval, defaults, discovery roots) |

Migrations live in `apps/server/drizzle` and run on boot. Run `npm run db:generate` after changing `schema.ts`.

## Claude integration

`services/claude/runner.ts` spawns:

```
claude -p --output-format stream-json --verbose --model <m> --effort <e>
       [--json-schema <schema>] [--max-budget-usd N] [--resume <session>]
       <permission flags> --disallowedTools … Bash(git push*) Bash(gh *)
```

The prompt goes in on stdin. Each NDJSON line is turned into a `RunEvent`: `system`, `text`, `tool_use`, `tool_result`, `step`, `result` or `stderr`. Events are stored in `run_events` and broadcast over SSE. The final `result` message supplies `session_id`, `total_cost_usd`, `num_turns` and, for schema runs, `structured_output`. That output is validated against the Zod schemas in `packages/shared/src/schemas.ts` before anything is written.

| Run kind | cwd | Permissions | Output |
|---|---|---|---|
| analyze | project checkout | read-only allow-list; Edit/Write disallowed | `analysisResultSchema` → Inbox items + health |
| plan | worktree if present, else checkout | read-only | `planResultSchema` → item plan / criteria / effort |
| implement | `~/.shipyard/worktrees/<project>/<key>` | `acceptEdits` + project allow-list (guarded) or skip-permissions (full) | commits on the branch |
| revise | same worktree, `--resume <session>` | same as implement | more commits, pushed to the PR |
| rebase | same worktree; Claude only on conflicts | same as implement plus `git rebase --continue` and the like | rebased branch, force-pushed with lease |

### Branch base

Before every implementation run, `git.ensureWorktree` (serialised per repository) does the following:

1. Fetches `refs/heads/<default>` from origin into `origin/<default>`. If origin can't be reached, the run stops with an error instead of quietly using an old base. Repos without an `origin` remote use the local branch.
2. **New branch:** cuts `shipyard/<key>-<slug>` from the freshly fetched `origin/<default>`.
3. **Existing branch** (a re-run after a failure or cancel) is brought up to date only when that's safe:

| Branch state | What happens |
|---|---|
| No commits of its own | Fast-forwarded to the latest base |
| Has its own commits | Rebased onto the latest base; if that would conflict, the rebase is aborted and the branch stays as it was |
| Has uncommitted work | Left untouched |
| Already pushed, or has a PR | Never rewritten |

Revisions skip this step because they continue a published branch. The owner's checkout and local branches are never modified. The run log records the base commit, and the PR description includes it.

After an implement or revise run, `agent.finishDelivery` commits any leftovers and checks that the branch is ahead of base. Then, if the project has a GitHub remote and auto-PR is on, it pushes and opens the PR (or comments on the existing one).

## Run queue

`runs.ts` holds queued runs in order and starts each one when both limits allow it:

- **Global:** "Concurrent Claude runs" in Settings (default 2).
- **Per project:** implement, revise and rebase runs belong to the group `write:<projectId>`, capped by the project's `maxParallelImplementations` (default 1). Analysis and planning are read-only, so they only count toward the global limit.

A blocked run doesn't hold back runs behind it from other projects. Each queued run records why it's waiting, for example "Waiting for US-3 to finish: url-shortener allows 1 implementation at a time". The API returns it as `waitingReason`. Raising a project's limit starts eligible runs immediately.

## Needs rebase

The PR poller reads `mergeable` and `mergeStateStatus`. `CONFLICTING`/`DIRTY` sets `needsRebase`, and `BEHIND` sets `behindBase`. When a PR merges, the project's other open PRs are re-synced after 10s and again after 45s, because GitHub recalculates mergeability asynchronously. A newly conflicting PR gets an activity entry that names the PR whose merge caused it.

`agent.startRebase` (a `rebase` run, in the project's write group):

1. Ensures the worktree exists and is clean, then fetches the latest base and the PR branch.
2. Fast-forwards to any commits pushed to the PR branch elsewhere. If the local and GitHub branches have diverged, it stops.
3. Runs `git rebase origin/<base>`. If that's clean, Claude isn't involved.
4. On conflicts, leaves the rebase in progress and asks Claude to resolve it. Claude resumes its implementation session, may run `git rebase --continue`, and runs the tests. A non-interactive `GIT_EDITOR` is set, so nothing can hang on an editor.
5. Verifies the rebase finished, the branch contains the base, and no conflict markers remain. If any check fails, it aborts and resets the branch to its original commit.
6. Pushes with `--force-with-lease` against the SHA it fetched, comments on the PR and re-syncs it.

## Live updates

The server has an in-process `bus`. Services publish `LiveEvent`s such as `item.changed`, `run.event` and `analysis.changed`. `GET /api/events` streams them as SSE. In the browser, `useLiveUpdates` maps each event to React Query invalidations, and `RunLog` subscribes to `run.event` for its run.

## PR tracking

`pr-tracker.ts` polls every open PR every `prPollIntervalSec` seconds using `gh pr view --json state,isDraft,reviewDecision,statusCheckRollup,…`. A state change writes an activity entry. `MERGED` moves the item to `done` and, if configured, removes the worktree.

## Security

- The server binds to `127.0.0.1` by default.
- Non-GET `/api/*` requests require `X-Shipyard: 1`. Browsers can't add that header cross-origin without a CORS preflight, and CORS only allows localhost origins.
- No secrets are stored. Claude and GitHub auth belong to their CLIs.
- Commands are spawned without a shell, as an argv array, so item titles and paths can never be interpolated into a command line.
