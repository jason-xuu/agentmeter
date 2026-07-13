'use strict';
// Data collectors for the unified plugin dashboard.
//
// Every number here traces to a real source on this machine. Where a plugin
// exposes no ledger, the collector reports savings: null and the UI renders
// "not measured" — it never substitutes a zero or an estimate.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const HEADROOM_BIN = '/opt/anaconda3/bin/headroom';
const TOKENSAVE_BIN = path.join(HOME, '.local/bin/tokensave');
const RTK_BIN = path.join(HOME, '.headroom/bin/rtk');
const SQLITE = '/opt/anaconda3/bin/sqlite3';
const CLAUDE_MEM_URL = 'http://127.0.0.1:37701';
const HEADROOM_PROXY = 'http://127.0.0.1:8787';

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

async function probe(url, timeout = 1200) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return { up: res.ok, json: await res.json().catch(() => null) };
  } catch {
    return { up: false, json: null };
  } finally {
    clearTimeout(t);
  }
}

// ── headroom ────────────────────────────────────────────────────────────────
// Savings ledger is real and durable (proxy_savings.json). The compression
// only actually happens when the proxy is up AND the client is routed at it,
// so status is gated on the live proxy probe, not on the lifetime ledger.
async function headroom() {
  const [savings, proxyUp] = await Promise.all([
    run(HEADROOM_BIN, ['savings', '--json']),
    probe(`${HEADROOM_PROXY}/health`).then((r) => r.up),
  ]);

  // Real schema (verified against `headroom savings --json`):
  //   lifetime.{tokens_saved,tokens_before,cost_usd,calls,savings_percent}
  //   windows.{today,last_7_days,all_time}.{...same...}
  let saved = null, pct = null, cost = null, calls = null, today = null, week = null;
  if (savings.ok) {
    try {
      const j = JSON.parse(savings.stdout);
      const life = j.lifetime || {};
      saved = num(life.tokens_saved);
      cost = num(life.cost_usd);
      calls = num(life.calls);
      pct = num(life.savings_percent);
      const w = j.windows || {};
      const pick = (o) => (o ? { saved: num(o.tokens_saved), cost: num(o.cost_usd), calls: num(o.calls) } : null);
      today = pick(w.today);
      week = pick(w.last_7_days);
    } catch { /* leave null — UI shows "not measured" */ }
  }

  return {
    id: 'headroom',
    name: 'headroom',
    kind: 'MCP server',
    active: proxyUp,
    // The distinction that matters: MCP tools work, compression does not.
    status: proxyUp ? 'compressing' : 'proxy down — not compressing',
    detail: proxyUp
      ? 'proxy up on :8787'
      : 'MCP tools reachable, but proxy is down and Claude Code is not routed through it — saving 0 right now',
    savedTokens: saved,
    savedCost: cost,
    savedPct: pct,
    calls,
    alwaysOnTokens: null, // tool schemas are deferred; not charged per session
    tokensNote: 'tool schemas load on demand (deferred) — no fixed per-session cost',
    extra: { today, week },
  };
}

// ── tokensave ───────────────────────────────────────────────────────────────
// savings_ledger is the only savings source. It is currently near-empty and
// nets negative; we report exactly that rather than clamping it to 0.
async function tokensave() {
  const q = `SELECT COUNT(*), COALESCE(SUM(before_tokens),0), COALESCE(SUM(after_tokens),0) FROM savings_ledger;`;
  const db = path.join(HOME, '.tokensave/global.db');
  const [row, mcpUp] = await Promise.all([
    run(SQLITE, [db, q]),
    fsp.access(TOKENSAVE_BIN, fs.constants.X_OK).then(() => true).catch(() => false),
  ]);

  let calls = null, saved = null;
  if (row.ok && row.stdout.trim()) {
    const [c, before, after] = row.stdout.trim().split('|').map(Number);
    calls = c;
    saved = before - after; // may legitimately be negative
  }

  return {
    id: 'tokensave',
    name: 'tokensave',
    kind: 'MCP server',
    active: mcpUp,
    status: mcpUp ? 'indexed · serving' : 'binary missing',
    detail: calls === 0
      ? 'ledger empty — no savings recorded yet'
      : `ledger has ${calls} row(s); net ${saved >= 0 ? 'saved' : 'overhead'}`,
    savedTokens: saved,
    savedCost: null,
    savedPct: null,
    calls,
    alwaysOnTokens: null,
    tokensNote: 'tool schemas load on demand (deferred) — no fixed per-session cost',
  };
}

// ── rtk ─────────────────────────────────────────────────────────────────────
// Registered as a PreToolUse hook, but the binary is not on PATH, so the hook
// has been failing silently. Surface that instead of a comforting zero.
async function rtk() {
  const onPath = await run('/bin/sh', ['-lc', 'command -v rtk']);
  const exists = await fsp.access(RTK_BIN, fs.constants.X_OK).then(() => true).catch(() => false);
  const gain = exists ? await run(RTK_BIN, ['gain']) : { ok: false, stdout: '' };
  const hasData = gain.ok && !/no tracking data/i.test(gain.stdout);

  // Real format: "Tokens saved:      83 (79.0%)" — number follows the label.
  let saved = null, pct = null, cmds = null;
  if (hasData) {
    const m = gain.stdout.match(/Tokens saved:\s*([\d,]+)\s*(?:\(([\d.]+)%\))?/i);
    if (m) {
      saved = Number(m[1].replace(/,/g, ''));
      pct = m[2] ? Number(m[2]) : null;
    }
    const c = gain.stdout.match(/Total commands:\s*([\d,]+)/i);
    if (c) cmds = Number(c[1].replace(/,/g, ''));
  }

  const reachable = onPath.ok && onPath.stdout.trim() !== '';
  return {
    id: 'rtk',
    name: 'rtk',
    kind: 'PreToolUse hook',
    active: reachable,
    status: reachable ? 'hook firing' : 'BROKEN — not on PATH',
    detail: reachable
      ? 'rtk resolves on the hook shell PATH'
      : `binary exists at ~/.headroom/bin/rtk but does not resolve on PATH — the PreToolUse hook "rtk hook claude" fails silently on every Bash call`,
    savedTokens: hasData ? saved : null,
    savedCost: null,
    savedPct: pct,
    calls: cmds,
    alwaysOnTokens: null,
    tokensNote: hasData ? 'rewrites Bash commands through rtk to shrink their output' : 'no tracking data — hook has never run successfully',
  };
}

// ── claude-mem ──────────────────────────────────────────────────────────────
// Live worker API. This one SPENDS tokens (Haiku compression) rather than
// saving them, so savedTokens stays null by design.
async function claudeMem(pluginCost) {
  const [health, stats] = await Promise.all([
    probe(`${CLAUDE_MEM_URL}/health`),
    probe(`${CLAUDE_MEM_URL}/api/stats`),
  ]);
  const s = stats.json || {};
  const w = s.worker || {};
  const d = s.database || {};

  return {
    id: 'claude-mem',
    name: 'claude-mem',
    kind: 'plugin + worker',
    active: health.up,
    status: health.up ? `worker running · :${w.port ?? 37701}` : 'worker down',
    detail: health.up
      ? `v${w.version ?? '?'} · uptime ${fmtUptime(w.uptime)} · ${d.observations ?? 0} observations · ${d.sessions ?? 0} sessions`
      : 'worker not responding — nothing is being captured',
    savedTokens: null,
    savedCost: null,
    savedPct: null,
    calls: null,
    alwaysOnTokens: pluginCost['claude-mem'] ?? null,
    // Honest framing: this is a net token *consumer*.
    tokensNote: 'spends tokens: compresses every session with Haiku via your Claude auth',
    extra: {
      observations: d.observations ?? 0,
      sessions: d.sessions ?? 0,
      summaries: d.summaries ?? 0,
      activeSessions: w.activeSessions ?? 0,
      uptime: w.uptime ?? 0,
    },
  };
}

// ── ponytail ────────────────────────────────────────────────────────────────
// No savings ledger exists anywhere in the package. Its README claims LOC
// reduction, which is not the same thing as tokens and is not measured here.
async function ponytail(pluginCost, enabled) {
  let mode = 'full';
  try {
    const cfg = JSON.parse(await fsp.readFile(path.join(HOME, '.config/ponytail/config.json'), 'utf8'));
    if (cfg.defaultMode) mode = cfg.defaultMode;
  } catch { /* default mode */ }

  return {
    id: 'ponytail',
    name: 'ponytail',
    kind: 'plugin (hooks)',
    active: enabled,
    status: enabled ? `injecting · mode: ${mode}` : 'disabled',
    detail: enabled
      ? 'SessionStart / SubagentStart / UserPromptSubmit hooks inject the ruleset'
      : 'plugin not enabled',
    savedTokens: null,
    savedCost: null,
    savedPct: null,
    calls: null,
    alwaysOnTokens: pluginCost['ponytail'] ?? null,
    tokensNote: 'no savings ledger exists — its README claims LOC reduction, which is not token savings',
  };
}

// ── per-plugin always-on token cost (from Claude Code itself) ───────────────
async function pluginTokenCosts() {
  const out = {};
  for (const [key, ref] of [['claude-mem', 'claude-mem@thedotmack'], ['ponytail', 'ponytail@ponytail']]) {
    const r = await run('claude', ['plugin', 'details', ref], 20000);
    const m = r.stdout.match(/Always-on:\s*~?([\d,]+)\s*tok/i);
    out[key] = m ? Number(m[1].replace(/,/g, '')) : null;
  }
  return out;
}

async function enabledPlugins() {
  const r = await run('claude', ['plugin', 'list'], 20000);
  const enabled = new Set();
  let current = null;
  for (const line of r.stdout.split('\n')) {
    const nameM = line.match(/❯\s*([\w.-]+)@/);
    if (nameM) current = nameM[1];
    if (current && /Status:.*enabled/i.test(line)) enabled.add(current);
  }
  return enabled;
}

// ── actual Claude Code token spend (ground truth from session transcripts) ──
// This is real usage, read from the same JSONL the CLI writes. It is TOTAL
// spend, not per-plugin — no per-plugin attribution exists, and we do not
// pretend otherwise.
async function tokenSpend() {
  const root = path.join(HOME, '.claude/projects');
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const dayMs = startOfDay.getTime();

  let today = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let allTime = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  let dirs = [];
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return { today, allTime, sessions: 0 }; }

  let sessions = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files = [];
    try { files = await fsp.readdir(path.join(root, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(root, d.name, f);
      let st;
      try { st = await fsp.stat(fp); } catch { continue; }
      sessions++;
      const isToday = st.mtimeMs >= dayMs;
      let raw;
      try { raw = await fsp.readFile(fp, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line || line.indexOf('"usage"') === -1) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const u = rec?.message?.usage;
        if (!u) continue;
        const ts = rec.timestamp ? Date.parse(rec.timestamp) : st.mtimeMs;
        const add = (acc) => {
          acc.input += u.input_tokens || 0;
          acc.output += u.output_tokens || 0;
          acc.cacheRead += u.cache_read_input_tokens || 0;
          acc.cacheWrite += u.cache_creation_input_tokens || 0;
        };
        add(allTime);
        if (isToday && ts >= dayMs) add(today);
      }
    }
  }
  return { today, allTime, sessions };
}

// Expensive sources (CLI spawns, full transcript scans) are memoized so the
// live tick stays cheap. Health probes are never cached — they must be live.
const _cache = new Map();
function memo(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val;
  const val = Promise.resolve(fn()).catch((e) => { _cache.delete(key); throw e; });
  _cache.set(key, { at: Date.now(), val });
  return val;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function fmtUptime(s) {
  if (!s && s !== 0) return '?';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

async function collectAll() {
  // Plugin inventory and transcript scans are slow and change rarely; health
  // probes are live on every tick.
  const [costs, enabled] = await Promise.all([
    memo('costs', 120000, pluginTokenCosts),
    memo('enabled', 30000, enabledPlugins),
  ]);
  const [hr, ts, rk, cm, pt, spend] = await Promise.all([
    memo('headroom', 5000, headroom),
    memo('tokensave', 5000, tokensave),
    memo('rtk', 30000, rtk),
    claudeMem(costs),                    // live: worker health must be realtime
    ponytail(costs, enabled.has('ponytail')),
    memo('spend', 20000, tokenSpend),
  ]);

  const plugins = [hr, cm, ts, pt, rk];

  // Only sum sources that actually measured something. A null stays out of the
  // total; it does not silently become 0.
  const measured = plugins.filter((p) => typeof p.savedTokens === 'number');
  const totalSaved = measured.reduce((a, p) => a + p.savedTokens, 0);
  const totalCost = plugins.reduce((a, p) => a + (p.savedCost || 0), 0);
  const alwaysOn = plugins.reduce((a, p) => a + (p.alwaysOnTokens || 0), 0);

  return {
    ts: Date.now(),
    plugins,
    totals: {
      savedTokens: totalSaved,
      savedCost: totalCost,
      alwaysOnTokens: alwaysOn,
      measuredCount: measured.length,
      unmeasuredCount: plugins.length - measured.length,
      unmeasured: plugins.filter((p) => typeof p.savedTokens !== 'number').map((p) => p.name),
    },
    spend,
  };
}

module.exports = { collectAll };
