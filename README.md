# ⚓ Shipyard

**Mission control for your side projects.** Shipyard keeps one backlog per repository, asks Claude to study each codebase and propose improvements, and, once you approve an item, has Claude build it in an isolated git worktree, open the pull request, and follow it until it merges.

```
 Explore ──▶ Inbox ──▶ Backlog ──▶ Up next ──▶ In progress ──▶ In review ──▶ Done
 (Claude     (you        │            │        (Claude in a     (PR open,      (PR merged,
  reads the   approve    │            │         worktree,        checks +       detected
  repo)       or reject) └─ skip / snooze / archive ─┘   commits)   reviews synced) automatically)
```

## Features

**Portfolio**
- Register any local git repository, or pick from repos auto-discovered under `~/Developer`, `~/Desktop` and `~/code`.
- Stack detection (languages, frameworks, package manager, tests, CI, Docker) and git state (remote, default branch, dirty tree).
- A dashboard across all projects: Inbox count, open PRs, Up next, live Claude runs, weekly throughput, and monthly Claude spend.

**Backlog, one per project**
- Kanban board with drag and drop. Dropping a card into **In progress** asks Claude to implement it.
- A dense list view with filters, sorting (priority, best bet, newest, updated), grouping and bulk actions.
- Items carry a type, a priority, an effort (XS–XL), an impact (1–5) and a **best-bet score** (impact ÷ effort), plus tags, acceptance criteria, a plan, a timeline and notes.
- Per-project keys such as `US-12` and `LA-3`.
- Decisions: approve, reject, up next, implement, plan first, skip (with a reason), snooze (until a date), archive, restore, mark done. Hard delete is allowed only from archived, skipped or rejected.

**AI ideation ("Explore with Claude")**
- Claude reads the repository read-only, focused on what you choose (new features, UX, performance, security, tech debt, testing, DX, observability), plus an optional steer.
- It returns a project summary, strengths, risks, 0–10 health scores, and concrete PR-sized suggestions. Each suggestion has a rationale, the affected files and acceptance criteria.
- Suggestions land in the **Inbox**. Nothing reaches your backlog until you approve it. Keyboard triage: `J`/`K` to move, `A` approve, `U` up next, `R` reject.
- Existing titles are passed to Claude so it doesn't suggest duplicates.

**Importers**
- Unchecked `- [ ]` items from `BACKLOG.md`, `docs/BACKLOG.md`, `TODO.md` and `ROADMAP.md`. It understands `**ID · Title (S)**: details` and P0–P3 section headings.
- `TODO`, `FIXME` and `HACK` comments, found with `git grep`.
- Open GitHub issues, read through `gh`.

**Delivery**
- **Plan first:** Claude writes an implementation plan, refines the acceptance criteria and re-estimates effort.
- **Implement:** a fresh `git worktree` on `shipyard/<key>-<slug>`, so your own checkout is never touched. Claude codes, runs the project's check command and commits. Shipyard then pushes and opens the PR (optionally as a draft).
- **Request changes:** Claude resumes the same session on the same branch with your feedback, then pushes to the PR.
- **PR tracking:** state, draft, CI checks and review decision are polled through `gh`. A merged PR moves the item to Done and cleans up the worktree.
- Link a PR you opened by hand, merge from the UI, and view the branch diff in the item drawer.
- Every run is logged: a streaming transcript (tool calls, results, Claude's notes), the prompt used, duration, turns and cost.

**Quality of life**
- `⌘K` command palette with search across all projects, and `C` to create an item from anywhere.
- Live updates over Server-Sent Events, so open tabs never need a refresh.
- Dark and light themes.

## Quick start

Requirements: Node 22+, git, [Claude Code](https://claude.com/claude-code) (`claude` on your PATH and signed in) and, for PRs, the [GitHub CLI](https://cli.github.com) (`gh auth login`).

```bash
make doctor          # check node, git, claude and gh are ready
make dev             # installs deps if needed; API on :4317, UI on http://localhost:5317
```

Production (one process serves both the API and the built UI):

```bash
make start           # builds, then serves http://localhost:4317
```

Run `make` to list every target:

| Target | What it does |
|---|---|
| `make install` | Install dependencies for all workspaces |
| `make doctor` | Check that node, git, the Claude CLI and the GitHub CLI are ready |
| `make dev` / `make server` / `make web` | Hot-reload dev servers: both, API only, or UI only |
| `make check` | Type-check and test (`make typecheck`, `make test`, `make test-watch`) |
| `make build` / `make start` | Production build / build and serve |
| `make db-generate` | Generate a migration after editing `apps/server/src/db/schema.ts` |
| `make db-shell` / `make db-backup` | Open the SQLite DB / back it up to `~/.shipyard/backups/` |
| `make worktrees` | List the worktrees created for implementation runs |
| `make clean` / `make distclean` | Remove build output / also remove `node_modules` |

`DATA_DIR` and `API_PORT` can be overridden, e.g. `make dev DATA_DIR=/tmp/shipyard-demo`. Plain `npm run dev`, `npm run build`, `npm start` and `npm test` work too.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SHIPYARD_DATA_DIR` | `~/.shipyard` | SQLite database and implementation worktrees |
| `SHIPYARD_PORT` / `SHIPYARD_HOST` | `4317` / `127.0.0.1` | API bind address (keep it on localhost) |
| `SHIPYARD_CLAUDE_BIN` | `claude` | Claude Code CLI to run |
| `SHIPYARD_GH_BIN` | `gh` | GitHub CLI to run |

Per-project settings, in the UI under Project → Settings:
- model and effort, plus a budget cap per run
- autonomy, the allowed shell commands, and the verification command
- standing instructions for Claude
- branch prefix, auto PR, draft PRs, and cleaning up worktrees on merge

## How it works

```
apps/web  (React + Vite)  ──HTTP + SSE──▶  apps/server  (Fastify)
                                              │
                                              ├── SQLite (Drizzle): projects, items, runs, run_events, analyses, activity
                                              ├── Run queue ──spawn──▶ claude -p --output-format stream-json
                                              ├── git (worktrees, commits, push)
                                              └── gh  (PR create / view / merge, issues)
```

- **Claude Code CLI, not raw API calls.** Shipyard drives `claude -p` in headless mode. It inherits your Claude Code login, your `CLAUDE.md` files, MCP servers and the full toolset (Read, Edit, Bash, Grep…) with the CLI's own permission engine. Structured results such as analyses and plans use `--json-schema`, and each output is validated with Zod.
- **A persistent job queue.** Runs and their event logs are stored in SQLite. A configurable number run at once. Runs interrupted by a restart are marked failed on boot.
- **The `gh` CLI for GitHub,** so Shipyard stores no tokens.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model, the item lifecycle and the safety model.

## Safety model

- **Analysis and planning are read-only:** `Edit` and `Write` are disallowed, and the only shell commands allowed are read-only ones (`git log`, `ls`, …).
- **Implementation runs in an isolated worktree** under `~/.shipyard/worktrees`. In *guarded* autonomy Claude may edit files and run only the commands on the project's allow-list. *Full* autonomy is opt-in per project.
- **Claude can never push or call `gh`.** Shipyard does those steps itself, after the run, in code you can read.
- **Budget cap** per run (`--max-budget-usd`).
- **The API binds to localhost,** and every state-changing request must carry an `X-Shipyard` header. Other websites can't forge that header (it forces a CORS preflight), which blocks drive-by requests.

## Project structure

```
packages/shared   Domain constants, Zod schemas (API inputs + Claude output contracts), DTO types
apps/server       Fastify API
  src/db          Drizzle schema, client, migrations (./drizzle)
  src/services    projects · items · agent (analyze/plan/implement/revise/PRs) · runs (queue)
                  scanner (stack detection + importers) · git · github · pr-tracker · dashboard
  src/services/claude   runner (CLI driver + stream parser) · prompts
  src/routes      HTTP + SSE endpoints
apps/web          React 19 + Vite + Tailwind v4 + TanStack Query + dnd-kit + cmdk
  src/api         typed client, query hooks, live SSE bridge
  src/components  design system, item drawer, run log, dialogs, layout/palette
  src/pages       dashboard, inbox, runs, settings, project (board/list/inbox/insights/settings)
```

## Roadmap ideas

- **Scheduled exploration:** a weekly analysis per project, with a digest of new suggestions.
- **Auto-pilot lanes:** let Claude implement low-risk `XS`/`S` items in the Up next lane overnight, within a budget.
- **CI-failure auto-fix:** when a PR's checks fail, offer a one-click "fix CI" revision with the failing logs attached.
- **PR review comments → revisions:** pull GitHub review comments into the Request changes dialog.
- **Dependencies between items** and an "unblocked" view.
- **Cross-project insights:** shared patterns ("3 projects lack rate limiting"), spend per project, cycle time.
- **Two-way sync** of items with BACKLOG.md (tick the checkbox when a PR merges) and GitHub Issues.
- **Desktop notifications** when a run finishes or a PR needs attention.
