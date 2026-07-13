# agentmeter — live dashboard for your AI coding CLIs

One localhost page showing every Claude Code **and Codex CLI** plugin, MCP server, and
hook on this machine: whether each is live, its realtime status, its per-session token
cost, and total tokens saved. Numbers update in **near real time** — a 1s heartbeat plus
`fs.watch` on both CLIs' transcripts pushes an update the instant a session writes a token.

Zero npm dependencies (Node stdlib only).

![deps](https://img.shields.io/badge/deps-0-brightgreen)

## What it shows

- **Live sessions** — one row per active/recent Claude Code or Codex session, with
  per-session token detail (total, today, output, cache read) updating live. Works with
  any number of concurrent sessions across both CLIs; the cumulative totals stay accurate.
- **Tokens used today** — combined across Claude Code + Codex, read straight from each
  CLI's own session transcripts. Never estimated.
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
start (idempotent; open-once so it never spams browser tabs):

```sh
codex() {
  CLAUDE_DASH_OPEN=once "$HOME/.claude/plugin-dashboard/launch.sh" >/dev/null 2>&1 &
  command codex "$@"
}
```

`launch.sh` is idempotent (won't double-start) and opens a browser tab. Control tab
behavior with `CLAUDE_DASH_OPEN=every|once|never`.

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
