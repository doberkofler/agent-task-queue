# agent-task-queue

Runs queued agent tasks sequentially in isolated [OpenCode](https://opencode.ai) sessions and records completion only after the configured repository policies pass.

The runner is generic: it knows about Markdown checklists, legacy JSON queues, GitHub issues, Git commit policies, and one agent backend. It has no defaults specific to this repository, a package manager, or a language project.

## Requirements

- Node.js 26 or newer
- Git
- OpenCode on `PATH` (or `OPENCODE_BIN`)
- GitHub CLI (`gh`) for GitHub issue queues (or `GH_BIN`)

## Install

```bash
npm install --save-dev agent-task-queue
# or run ad hoc
npx agent-task-queue --help
```

## Usage

```bash
# Markdown checklist
npx agent-task-queue TODO.md --verify "pnpm verify"

# Legacy JSON queue
npx agent-task-queue queue.json --verify "pnpm verify" --model openai/gpt-5

# GitHub issue queue from a file
npx agent-task-queue queue.json --verify "pnpm verify"

# GitHub issue queue from stdin
echo '{"version":1,"kind":"github-issues","items":[{"url":"https://github.com/OWNER/REPOSITORY/issues/16"}]}' \
  | npx agent-task-queue - --verify "pnpm verify"
```

Every invocation needs an explicit verification policy: `--verify <command>`, `--no-verify`, or a `verification.command` in the configuration file.

## Output

Progress uses a compact, Vitest-style layout:

```text
 RUN  milestone-2.json
      model deepseek/deepseek-flash · verify pnpm run verify

 ✓ Preflight · 29.8s

 ✓ #39 [TEST-001] Inventory tests by class and establish ownership
   2m08s · 12 tools · 24.1k tokens · $0.0842 · commit a1b2c3d

   Implemented ownership tests.
   Updated testing documentation.

 ✓ 1 task completed · 2m38s
```

While a task is running, stable progress and volatile activity occupy separate rows:

```text
   ⠸ #57 · 107 tools · 5m22s
     Agent · Running command
```

- Two transient rows are updated independently on a terminal; completed work stays in scrollback.
- Tool arguments and shell commands become semantic activity such as `Reading src/config.ts` or `Running command`. Commands are not echoed.
- Only two meaningful lines of the agent's final response are shown.
- Failures print the retained output tail and the exact history log path.
- Piped output contains phase milestones only, without animation or activity lines.
- `--verbose` adds tool details, event diagnostics, and log paths to successful runs.

Color is enabled only on a terminal and can be controlled with `NO_COLOR` and `FORCE_COLOR`.

## Queue formats

### Markdown

```markdown
- [x] #1 completed item
- [ ] #2 [EVAL-002] pending item
```

- One item per line, matching `- [ ] #N title`.
- Issues must be unique.
- Completion flips `[ ]` to `[x]` and commits the file by default.

### Legacy JSON

```json
{
  "name": "milestone",
  "items": [
    {"issue": 14, "evaluation": "EVAL-006", "title": "Runner", "done": false, "owner": "team"}
  ]
}
```

- `issue` is a positive integer, `evaluation` and `title` are non-empty strings, and `done` is a boolean.
- Unknown document and item fields are preserved.
- Completion sets `done` to `true` and commits the file by default.

### GitHub issues

```json
{
  "version": 1,
  "kind": "github-issues",
  "items": [{"url": "https://github.com/OWNER/REPOSITORY/issues/16"}]
}
```

- Only `url` is accepted per item.
- Closed issues and issues with an existing local closure commit are skipped.
- Completion creates an empty commit with the footer `Closes OWNER/REPOSITORY#N`.
- The issue queue requires `completion.commit` and `completion.closeGitHubIssue` to remain enabled.

## Configuration

The runner reads `agent-task-queue.config.json` from the working directory, or the path passed with `--config`. Command-line flags override the file.

```json
{
  "agent": {
    "backend": "opencode",
    "name": "build",
    "model": null,
    "timeoutSeconds": 3600
  },
  "repository": {
    "requireCleanTree": true,
    "commitPolicy": "exactly-one",
    "requireChangedFiles": true
  },
  "verification": {
    "command": ["pnpm", "verify"],
    "timeoutSeconds": 900,
    "preflight": true,
    "afterEachTask": true
  },
  "completion": {
    "commit": true,
    "closeGitHubIssue": true
  }
}
```

### Agent

| Key | Meaning |
| --- | --- |
| `backend` | Only `opencode` in this release. |
| `name` | OpenCode agent name passed as `--agent`. |
| `model` | `provider/model[#variant]`; `null` lets OpenCode choose. |
| `timeoutSeconds` | Wall-clock limit for one agent session. |

### Repository policies

| Key | Meaning |
| --- | --- |
| `requireCleanTree` | Reject a dirty working tree before and after each phase. |
| `commitPolicy` | `exactly-one` (default), `at-least-one`, or `none`. |
| `requireChangedFiles` | Reject an agent commit that contains no changes. |

`commitPolicy: "none"` requires `completion.commit: false`, and uncommitted completion requires `requireCleanTree: false`.

### Verification

| Key | Meaning |
| --- | --- |
| `command` | Preferred argv array, or a shell string. `null` disables verification and requires `--no-verify`. |
| `timeoutSeconds` | Wall-clock limit for one verification phase. |
| `preflight` | Run verification before the first agent. |
| `afterEachTask` | Run verification after each validated agent commit. |

Prefer argv arrays. They avoid shell quoting and work the same on every platform. `--verify` always uses the platform shell.

### Completion

| Key | Meaning |
| --- | --- |
| `commit` | Commit the queue mutation or the GitHub closure commit. |
| `closeGitHubIssue` | Add the GitHub closure footer to the completion commit. |

## Logs and environment

Every agent and verification run writes two private files under `$QUEUE_LOG_DIR`, else `$XDG_STATE_HOME/agent-task-queue`, else `~/.local/state/agent-task-queue`:

- `<timestamp>-<issue>.jsonl`: raw agent stdout
- `<timestamp>-<issue>.log`: complete history, including stderr

| Variable | Meaning |
| --- | --- |
| `OPENCODE_BIN` | OpenCode executable; default `opencode`. |
| `GH_BIN` | GitHub CLI executable; default `gh`. |
| `QUEUE_MODEL` | Model fallback when neither `--model` nor `agent.model` is set. |
| `QUEUE_LOG_DIR` | Log directory fallback. |
| `XDG_STATE_HOME` | Base directory for the default log location. |
| `NO_COLOR` | Disable ANSI colors when set to a non-empty value. |
| `FORCE_COLOR` | Force ANSI colors unless set to `0`. |

## Behavior and guarantees

- Items run strictly one at a time.
- A failed agent, verification failure, timeout, dirty tree, or invalid commit leaves the queue item pending.
- A failed build never marks the item done.
- The agent must not modify the queue file.
- Child process trees are terminated on timeout and on `SIGINT`/`SIGTERM`.
- macOS inhibits idle sleep while the run is active; Linux uses `systemd-inhibit` when available; other platforms run without inhibition.
- Output is sanitized of terminal control sequences.
- Exit codes: `0` success, `1` run failure, `2` invalid usage, `130` interrupted, `143` terminated.

## Development

```bash
pnpm install
pnpm verify
pnpm build
```

See [roadmap.md](roadmap.md) for planned work.
