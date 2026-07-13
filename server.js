'use strict';
// Unified plugin dashboard — a single localhost page for every Claude Code and
// Codex CLI plugin/MCP/hook on this machine. Pushes live updates over SSE.
//
// Real-time: a 1s heartbeat refreshes savings/health, and fs.watch on both
// CLIs' transcript directories triggers an immediate (debounced) push the
// instant a session writes a token — so "tokens used today" moves in near
// real time without polling the 90MB+ of transcripts on a timer.
//
// Start: node ~/.claude/plugin-dashboard/server.js
// Page:  http://127.0.0.1:37800

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectAll } = require('./collectors.js');

const PORT = Number(process.env.CLAUDE_DASH_PORT || 37800);
const HOST = '127.0.0.1';
const TICK_MS = 1000;          // heartbeat: keeps savings/health fresh
const WATCH_DEBOUNCE_MS = 150; // coalesce transcript-write bursts into one push

const HOME = os.homedir();
const WATCH_DIRS = [
  path.join(HOME, '.claude/projects'),
  path.join(HOME, '.codex/sessions'),
  path.join(HOME, '.headroom'), // savings_events.jsonl — per-message compression log
];

const clients = new Set();
let last = null;
let ticking = false;

async function tick() {
  if (ticking) return;         // never overlap collections
  ticking = true;
  try {
    last = await collectAll();
    broadcast(`data: ${JSON.stringify(last)}\n\n`);
  } catch (e) {
    broadcast(`data: ${JSON.stringify({ error: String((e && e.message) || e) })}\n\n`);
  } finally {
    ticking = false;
  }
}

function broadcast(payload) {
  for (const res of clients) res.write(payload);
}

// fs.watch fires on every transcript append. Debounce so a burst of writes
// collapses into a single collect+push.
let debounce = null;
function onChange() {
  if (debounce) return;
  debounce = setTimeout(() => { debounce = null; tick(); }, WATCH_DEBOUNCE_MS);
}
function startWatchers() {
  for (const dir of WATCH_DIRS) {
    try { fs.watch(dir, { recursive: true }, onChange); }
    catch { /* dir may not exist (e.g. Codex not installed) — skip it */ }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    if (last) res.write(`data: ${JSON.stringify(last)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/plugins') {
    const data = last || (await collectAll());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data, null, 2));
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', clients: clients.size, port: PORT }));
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  res.writeHead(404).end('not found');
});

// Refuse double-start: if the port is taken, assume a dashboard is already up
// and exit quietly. The SessionStart hook relies on this being idempotent.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`dashboard already running: http://${HOST}:${PORT}`);
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`dashboard: http://${HOST}:${PORT}`);
  tick();
  setInterval(tick, TICK_MS);
  startWatchers();
});
