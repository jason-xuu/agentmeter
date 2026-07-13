# agentmeter — live dashboard for your AI coding CLIs

One localhost page showing every Claude Code **and Codex CLI** plugin, MCP server, and
hook on this machine: whether each is live, its realtime status, its per-session token
cost, and total tokens saved. Numbers update in **near real time** — a 1s heartbeat plus
`fs.watch` on both CLIs' transcripts pushes an update the instant a session writes a token.

Zero npm dependencies (Node stdlib only).

![deps](https://img.shields.io/badge/deps-0-brightgreen)

## What it shows

- **Messages** — a live, per-message feed: for every message you send it shows how many
  tokens it cost, how much headroom compressed out (with %/$ avoided), which CLI, and which
  model — read straight from headroom's per-call log (`~/.headroom/savings_events.jsonl`),
  never estimated. Includes a sparkline of per-message token usage with a hover tooltip.
- **Live sessions** — a clickable tile per active/recent Claude Code or Codex session.
  Click one for a drawer with its full token breakdown, cache-read share, model, and
  which extensions serve that CLI. Any number of concurrent sessions across both CLIs;
  cumulative totals stay accurate. claude-mem's background compression sessions collapse
  into one aggregate tile so they don't drown out your real work.
- **Token burn today, by hour** — a stacked chart split by CLI (Claude violet, Codex
  teal; both CVD-validated), with a hover tooltip. The bucketed values sum exactly to the
  headline "tokens used today" — the chart is the same source, not a separate estimate.
- **Cache-read share** — how much of today's Claude tokens came from cache (cheap).
- **Tokens saved** per plugin, pulled from the tool's own ledger — never estimated.
- **Always-on context cost** each plugin adds per session.
- **Per-CLI reach** — which extensions serve Claude Code, Codex, or both.

Where a plugin exposes no savings ledger it renders **"not measured"** rather than a fake
zero — the headline total deliberately excludes unmeasured sources.

## Sources

`headroom savings --json`, tokensave `savings_ledger`, `rtk gain`, `claude plugin details`,
`claude plugin list`, Codex `~/.codex/config.toml` MCP registry, the claude-mem worker API,
Claude Code transcripts (`~/.claude/projects`), Codex rollout transcripts
(`~/.codex/sessions`), and live health probes of the proxy/worker ports.

## Run

```sh
node server.js        # → http://127.0.0.1:37800
```

## Auto-start every session

**Claude Code** — add a `SessionStart` hook to `~/.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [ { "hooks": [{ "type": "command", "command": "$HOME/.claude/plugin-dashboard/launch.sh", "timeout": 10 }] } ] } }
```

**Codex CLI** — a shell wrapper in `~/.zshrc` / `~/.bashrc` boots the dashboard on `codex`
start:

```sh
codex() {
  CLAUDE_DASH_OPEN=smart "$HOME/.claude/plugin-dashboard/launch.sh" >/dev/null 2>&1 &
  command codex "$@"
}
```

`launch.sh` is idempotent (the server is a shared singleton — it won't double-start).
Tab behavior is controlled by `CLAUDE_DASH_OPEN`:

- `smart` (**default**) — open a tab only when no dashboard tab is currently open. The
  server reports its live SSE-client count at `/health`; zero clients means no tab is
  showing the dashboard. So it opens on your first session (and after you close the tab
  and start a session again) but never spawns a duplicate tab for additional concurrent
  sessions — no wasted memory.
- `every` — open a tab every session · `once` — only when the server wasn't already
  running · `never` — keep the server up, never open a tab.

## Files

| file | role |
|---|---|
| `collectors.js` | reads each plugin's real data source; incremental transcript tailing + per-session/per-CLI aggregation |
| `server.js` | HTTP + SSE server; 1s heartbeat + `fs.watch` push |
| `index.html` | dashboard page (theme-aware, no external assets) |
| `launch.sh` | idempotent SessionStart / codex launcher |

## Notes

Plugin binaries, ports, and paths are resolved from the running machine. Collectors shell
out (`headroom`, `tokensave`, `claude`, `sqlite3`) and assume those tools are installed on
`PATH`. Codex extension reach (headroom, tokensave) is read from `~/.codex/config.toml`;
Claude-Code-specific plugins (rtk hook, claude-mem worker) have no Codex equivalent and are
labelled `claude` only.
