'use strict';
// Unified plugin dashboard — single localhost page for every Claude Code
// plugin/MCP/hook on this machine. Pushes live updates over SSE.
//
// Start:  node ~/.claude/plugin-dashboard/server.js
// Page:   http://127.0.0.1:37800

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { collectAll } = require('./collectors.js');

const PORT = Number(process.env.CLAUDE_DASH_PORT || 37800);
const HOST = '127.0.0.1';
const TICK_MS = 3000;

const clients = new Set();
let last = null;

async function tick() {
  try {
    last = await collectAll();
    const payload = `data: ${JSON.stringify(last)}\n\n`;
    for (const res of clients) res.write(payload);
  } catch (e) {
    const payload = `data: ${JSON.stringify({ error: String(e && e.message || e) })}\n\n`;
    for (const res of clients) res.write(payload);
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

// Refuse to double-start: if the port is taken, assume a dashboard is already
// up and exit quietly. The session hook relies on this being idempotent.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`dashboard already running at http://${HOST}:${PORT}`);
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`dashboard: http://${HOST}:${PORT}`);
  tick();
  setInterval(tick, TICK_MS);
});
