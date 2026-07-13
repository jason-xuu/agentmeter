# claudekit — unified plugin dashboard

A single localhost page showing every Claude Code plugin, MCP server, and hook on your machine: whether each is live, its realtime status, per-session token cost, and total tokens saved. Zero npm dependencies (Node stdlib only).

![status](https://img.shields.io/badge/deps-0-brightgreen)

## What it shows

- **Live status** of each plugin via realtime health probes (SSE, 3s tick)
- **Tokens saved** per plugin, pulled from each tool's own ledger — never estimated
- **Always-on context cost** each plugin adds to every session
- **Actual token spend** read from your Claude Code session transcripts

Sources: `headroom savings --json`, tokensave `savings_ledger`, `rtk gain`, `claude plugin details`, the claude-mem worker API, and live probes of the proxy/worker ports. Where a plugin exposes no savings ledger, it renders **"not measured"** rather than a fake zero — the headline total deliberately excludes unmeasured sources.

## Run

```sh
node server.js        # → http://127.0.0.1:37800
```

## Auto-start every session

Add a `SessionStart` hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "$HOME/.claude/plugin-dashboard/launch.sh", "timeout": 10 }] }
    ]
  }
}
```

`launch.sh` is idempotent (won't double-start) and opens a browser tab. Control tab behavior with `CLAUDE_DASH_OPEN=every|once|never`.

## Files

| file | role |
|---|---|
| `collectors.js` | reads each plugin's real data source; caches expensive calls |
| `server.js` | HTTP + SSE server |
| `index.html` | the dashboard page (theme-aware, no external assets) |
| `launch.sh` | idempotent SessionStart launcher |

## Notes

Plugin binaries, ports, and paths are resolved from the running machine. Collectors that shell out (`headroom`, `tokensave`, `claude`) assume those tools are installed and on `PATH`.
