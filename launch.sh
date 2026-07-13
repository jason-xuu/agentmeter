#!/bin/sh
# SessionStart launcher for the unified plugin dashboard.
# Must be fast, silent, and idempotent — it runs on every Claude Code session.
#
# CLAUDE_DASH_OPEN=smart : open a tab only when no dashboard tab is open (default)
# CLAUDE_DASH_OPEN=every : open a browser tab every session
# CLAUDE_DASH_OPEN=once  : only open when the dashboard wasn't already running
# CLAUDE_DASH_OPEN=never : never open a tab, just keep the server up

DIR="$HOME/.claude/plugin-dashboard"
PORT="${CLAUDE_DASH_PORT:-37800}"
URL="http://127.0.0.1:$PORT"
POLICY="${CLAUDE_DASH_OPEN:-smart}"

# nvm puts node outside the non-interactive PATH; fall back to a login shell.
NODE="$(command -v node 2>/dev/null)"
[ -z "$NODE" ] && NODE="$($SHELL -lc 'command -v node' 2>/dev/null)"
[ -z "$NODE" ] && exit 0   # no node → stay silent rather than erroring every prompt

was_running=0
if curl -s -o /dev/null --max-time 1 "$URL/health" 2>/dev/null; then
  was_running=1
else
  nohup "$NODE" "$DIR/server.js" >"$DIR/server.log" 2>&1 &
  # Give it a moment to bind before we point a browser at it.
  i=0
  while [ $i -lt 20 ]; do
    curl -s -o /dev/null --max-time 1 "$URL/health" 2>/dev/null && break
    i=$((i + 1)); sleep 0.1
  done
fi

# Smart: open a tab only when no dashboard tab is currently connected. The
# server reports its live SSE client count at /health; clients==0 means no tab
# is showing the dashboard, so this session is the one that should open it. This
# opens on the first session (and after you close the tab and start a session
# again) but never spawns a duplicate tab for additional concurrent sessions.
open_if_no_tab() {
  clients="$(curl -s --max-time 1 "$URL/health" 2>/dev/null | sed -n 's/.*"clients":\([0-9][0-9]*\).*/\1/p')"
  [ "${clients:-0}" = "0" ] && open "$URL" >/dev/null 2>&1
}

case "$POLICY" in
  never)   ;;
  once)    [ "$was_running" -eq 0 ] && open "$URL" >/dev/null 2>&1 ;;
  every)   open "$URL" >/dev/null 2>&1 ;;
  smart|*) open_if_no_tab ;;
esac

exit 0
