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
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects');
const CODEX_SESSIONS = path.join(HOME, '.codex/sessions');
const CODEX_CONFIG = path.join(HOME, '.codex/config.toml');
const HEADROOM_EVENTS = path.join(HOME, '.headroom/savings_events.jsonl');

// A session counts as "live" if its transcript was written within this window.
const ACTIVE_MS = 90 * 1000;
// Sessions older than this are dropped from the per-session list entirely.
const RECENT_MS = 6 * 60 * 60 * 1000;

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
    clis: ['claude', 'codex'], // registered as an MCP server in both CLIs
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
    clis: ['claude', 'codex'], // registered as an MCP server in both CLIs
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
    clis: ['claude'], // Claude Code hook; no Codex equivalent
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
    clis: ['claude'], // Claude Code plugin + worker; no Codex equivalent
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
    clis: ['claude'], // Claude Code hooks plugin
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

// Parse `claude plugin list` into structured records: name, marketplace,
// version, scope, enabled. This is the source of truth for what is installed.
async function listPlugins() {
  const r = await run('claude', ['plugin', 'list'], 20000);
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/❯\s*([\w.-]+)@([\w.-]+)/);
    if (m) { cur = { name: m[1], marketplace: m[2], version: null, scope: null, enabled: false }; out.push(cur); continue; }
    if (!cur) continue;
    const v = line.match(/Version:\s*([\w.-]+)/); if (v) cur.version = v[1];
    const s = line.match(/Scope:\s*(\w+)/); if (s) cur.scope = s[1];
    if (/Status:.*enabled/i.test(line)) cur.enabled = true;
  }
  return out;
}

// Which MCP servers Codex has registered (from ~/.codex/config.toml). Used to
// show that headroom/tokensave actually serve the Codex CLI too, not just
// Claude Code. Parsed with a plain regex — no TOML dependency for two keys.
async function codexMcpServers() {
  try {
    const toml = await fsp.readFile(CODEX_CONFIG, 'utf8');
    const set = new Set();
    for (const m of toml.matchAll(/\[mcp_servers\.([\w.-]+)\]/g)) set.add(m[1]);
    return set;
  } catch { return new Set(); }
}

// Generic collector for Claude Code plugins that have no dedicated card above.
// These are skill/command/hook plugins with no savings ledger — they cost
// context tokens and save nothing measurable, which is exactly what we show.
// Auto-discovered, so any plugin installed later appears with no code change.
const DEDICATED = new Set(['claude-mem', 'ponytail', 'headroom']);
async function discoveredPlugins() {
  const list = await listPlugins();
  const generic = list.filter((p) => !DEDICATED.has(p.name));
  const cards = await Promise.all(generic.map(async (p) => {
    const d = await run('claude', ['plugin', 'details', `${p.name}@${p.marketplace}`], 20000);
    const cost = d.stdout.match(/Always-on:\s*~?([\d,]+)\s*tok/i);
    const parts = [];
    for (const kind of ['Skills', 'Agents', 'Hooks', 'Commands', 'MCP servers']) {
      const m = d.stdout.match(new RegExp(`${kind}\\s*\\((\\d+)\\)`, 'i'));
      if (m && Number(m[1]) > 0) parts.push(`${m[1]} ${kind.toLowerCase()}`);
    }
    return {
      id: p.name,
      name: p.name,
      kind: `plugin · ${p.marketplace}`,
      clis: ['claude'],
      active: p.enabled,
      status: p.enabled ? `enabled · v${p.version ?? '?'}` : 'disabled',
      detail: (parts.join(' · ') || 'no components') + ` · ${p.scope ?? '?'} scope`,
      savedTokens: null,
      savedCost: null,
      savedPct: null,
      calls: null,
      alwaysOnTokens: cost ? Number(cost[1].replace(/,/g, '')) : null,
      tokensNote: 'skills/commands plugin — no savings ledger; costs context only',
    };
  }));
  return cards;
}

// ── incremental transcript tailing (ground-truth token spend) ───────────────
// Full re-scans of 90+MB of transcripts were the real-time bottleneck. Instead
// we keep a per-file cache and only parse the bytes appended since last tick.
// Files are append-only JSONL, so a byte offset is a safe resume point; we hold
// back any trailing partial line until its newline lands.
//
// Each entry aggregates the WHOLE session (agg) plus just today's slice
// (todayAgg, rebucketed on date rollover). This makes the per-tick cost
// proportional to newly-written bytes, not total history.
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const hours = () => new Array(24).fill(0);
const addHours = (into, from) => { for (let i = 0; i < 24; i++) into[i] += from[i]; };
const addU = (acc, u) => {
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  acc.cacheWrite += u.cache_creation_input_tokens || 0;
};
const totalOf = (a) => a.input + a.output + a.cacheRead + a.cacheWrite;
const sumInto = (acc, a) => { acc.input += a.input; acc.output += a.output; acc.cacheRead += a.cacheRead; acc.cacheWrite += a.cacheWrite; };

async function readTail(fp, from, to) {
  const fh = await fsp.open(fp, 'r');
  try {
    const len = to - from;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, from);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

// project dir name in ~/.claude/projects is the cwd with slashes -> dashes.
// Produce a human label: recognize claude-mem's own worker sessions, and skip
// generic path tails ("sessions", "tmp", …) so the real project name shows.
function decodeProject(dir) {
  const raw = dir.replace(/^-/, '');
  const joined = '/' + raw.split('-').filter(Boolean).join('/');
  if (/claude\/?-?mem/i.test(joined) || joined.includes('claude/mem')) return 'claude-mem';
  const stop = new Set(['sessions', 'projects', 'tmp', 'private', 'users', 'var', 'folders']);
  const segs = raw.split('-').filter(Boolean);
  const meaningful = segs.filter((s) => !stop.has(s.toLowerCase()));
  return (meaningful.length ? meaningful[meaningful.length - 1] : segs[segs.length - 1]) || dir;
}

const claudeCache = new Map(); // fp -> { size, mtimeMs, offset, leftover, dayMs, agg, todayAgg, todayByHour, model, lastTs, project, id }

async function claudeSpend(dayMs) {
  const today = zero(), allTime = zero();
  const byHour = hours();
  const sessions = [];
  let dirs = [];
  try { dirs = await fsp.readdir(CLAUDE_PROJECTS, { withFileTypes: true }); }
  catch { return { today, allTime, byHour, sessions }; }

  const seen = new Set();
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files = [];
    try { files = await fsp.readdir(path.join(CLAUDE_PROJECTS, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(CLAUDE_PROJECTS, d.name, f);
      seen.add(fp);
      let st;
      try { st = await fsp.stat(fp); } catch { continue; }

      let ent = claudeCache.get(fp);
      const rollover = ent && ent.dayMs !== dayMs;
      if (!ent || rollover) {
        ent = { size: 0, mtimeMs: 0, offset: 0, leftover: '', dayMs,
                agg: zero(), todayAgg: zero(), todayByHour: hours(), model: null, lastTs: 0,
                project: decodeProject(d.name), id: f.replace(/\.jsonl$/, '') };
      }
      // Unchanged since last read → reuse cached aggregates untouched.
      if (ent.size === st.size && ent.mtimeMs === st.mtimeMs && !rollover) {
        // no-op
      } else {
        if (rollover) { ent.todayAgg = zero(); ent.todayByHour = hours(); } // yesterday no longer "today"
        const chunk = await readTail(fp, ent.offset, st.size);
        const text = ent.leftover + chunk;
        const parts = text.split('\n');
        ent.leftover = parts.pop(); // trailing partial line, if any
        for (const line of parts) {
          if (!line || line.indexOf('"usage"') === -1) continue;
          let rec; try { rec = JSON.parse(line); } catch { continue; }
          const u = rec?.message?.usage;
          if (!u) continue;
          if (rec?.message?.model) ent.model = rec.message.model;
          const ts = rec.timestamp ? Date.parse(rec.timestamp) : st.mtimeMs;
          if (ts > ent.lastTs) ent.lastTs = ts;
          addU(ent.agg, u);
          if (ts >= dayMs) {
            addU(ent.todayAgg, u);
            const tot = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            ent.todayByHour[new Date(ts).getHours()] += tot;
          }
        }
        ent.offset = st.size; ent.size = st.size; ent.mtimeMs = st.mtimeMs; ent.dayMs = dayMs;
        claudeCache.set(fp, ent);
      }

      sumInto(today, ent.todayAgg);
      sumInto(allTime, ent.agg);
      addHours(byHour, ent.todayByHour);
      const last = ent.lastTs || st.mtimeMs;
      if (Date.now() - last <= RECENT_MS && totalOf(ent.agg) > 0) {
        sessions.push({
          cli: 'claude', id: ent.id, label: ent.project, model: shortModel(ent.model),
          tokens: { ...ent.agg, total: totalOf(ent.agg) },
          todayTotal: totalOf(ent.todayAgg),
          lastTs: last,
        });
      }
    }
  }
  // Drop cache entries for deleted files.
  for (const fp of claudeCache.keys()) if (!seen.has(fp)) claudeCache.delete(fp);
  return { today, allTime, byHour, sessions };
}

// Collapse a full model id to a short human label ("claude-opus-4-8[1m]" -> "opus-4.8").
function shortModel(m) {
  if (!m) return null;
  const s = String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, '');
  const fam = s.match(/(opus|sonnet|haiku|fable)-?(\d+)-?(\d+)?/i);
  return fam ? `${fam[1]}${fam[2] ? ' ' + fam[2] + (fam[3] ? '.' + fam[3] : '') : ''}` : s;
}

// ── Codex CLI spend ─────────────────────────────────────────────────────────
// Codex rollout files record cumulative token_count events:
//   payload.info.total_token_usage.{input_tokens,cached_input_tokens,
//     output_tokens,reasoning_output_tokens,total_tokens}   (cumulative)
//   payload.info.last_token_usage.{...}                     (this turn's delta)
// Session total = the LAST total_token_usage. Today's slice = sum of
// last_token_usage deltas whose event timestamp is today.
const codexCache = new Map(); // fp -> { size, mtimeMs, dayMs, cum, todayTotal, lastTs, id, label }

function codexMap(u) {
  // Normalize Codex usage into the same shape as Claude's.
  return {
    input: (u.input_tokens || 0) - (u.cached_input_tokens || 0),
    output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
    cacheRead: u.cached_input_tokens || 0,
    cacheWrite: 0,
  };
}

async function listCodexRollouts() {
  const out = [];
  async function walk(dir) {
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  await walk(CODEX_SESSIONS);
  return out;
}

async function codexSpend(dayMs) {
  const allTime = zero();
  const byHour = hours();
  const sessions = [];
  let todayTotal = 0;
  let files = [];
  try { files = await listCodexRollouts(); } catch { return { allTime, byHour, sessions, todayTotal }; }

  const seen = new Set();
  for (const fp of files) {
    seen.add(fp);
    let st; try { st = await fsp.stat(fp); } catch { continue; }
    const isTodayFile = st.mtimeMs >= dayMs;

    let ent = codexCache.get(fp);
    const rollover = ent && ent.dayMs !== dayMs;
    const changed = !ent || ent.size !== st.size || ent.mtimeMs !== st.mtimeMs;
    if (changed || rollover) {
      const id = path.basename(fp).replace(/^rollout-|\.jsonl$/g, '');
      ent = ent || { cum: zero(), todayTotal: 0, todayByHour: hours(), model: null, lastTs: 0, id, label: 'codex' };
      ent.todayTotal = 0; ent.todayByHour = hours(); // recomputed below
      // Today's files: full parse for accurate today-slice + label. Older files:
      // tail-read just the last cumulative total (cheap, no per-turn detail).
      let text;
      if (isTodayFile) {
        try { text = await fsp.readFile(fp, 'utf8'); } catch { text = ''; }
      } else {
        text = await readTail(fp, Math.max(0, st.size - 16384), st.size);
      }
      const cum = zero();
      let sawCum = false;
      for (const line of text.split('\n')) {
        if (!line) continue;
        if (line.indexOf('token_count') === -1 && line.indexOf('cwd') === -1 && line.indexOf('"model"') === -1) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec?.payload?.cwd) ent.label = path.basename(rec.payload.cwd) || ent.label;
        if (rec?.payload?.model) ent.model = rec.payload.model;
        const info = rec?.payload?.info;
        if (rec?.payload?.type !== 'token_count' || !info) continue;
        const ts = rec.timestamp ? Date.parse(rec.timestamp) : st.mtimeMs;
        if (ts > ent.lastTs) ent.lastTs = ts;
        if (info.total_token_usage) { Object.assign(cum, codexMap(info.total_token_usage)); sawCum = true; }
        if (isTodayFile && ts >= dayMs && info.last_token_usage) {
          const d = codexMap(info.last_token_usage);
          const tot = d.input + d.output + d.cacheRead + d.cacheWrite;
          ent.todayTotal += tot;
          ent.todayByHour[new Date(ts).getHours()] += tot;
        }
      }
      if (sawCum) ent.cum = cum;
      ent.size = st.size; ent.mtimeMs = st.mtimeMs; ent.dayMs = dayMs;
      codexCache.set(fp, ent);
    }

    sumInto(allTime, ent.cum);
    todayTotal += ent.todayTotal;
    addHours(byHour, ent.todayByHour);

    const last = ent.lastTs || st.mtimeMs;
    if (Date.now() - last <= RECENT_MS && totalOf(ent.cum) > 0) {
      sessions.push({
        cli: 'codex', id: ent.id, label: ent.label, model: shortModel(ent.model) || 'codex',
        tokens: { ...ent.cum, total: totalOf(ent.cum) },
        todayTotal: ent.todayTotal,
        lastTs: last,
      });
    }
  }
  for (const fp of codexCache.keys()) if (!seen.has(fp)) codexCache.delete(fp);
  return { allTime, byHour, sessions, todayTotal };
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

// ── per-message feed (headroom's per-call savings log) ──────────────────────
// headroom appends one event per proxied API call to savings_events.jsonl:
//   {ts, before, after, saved, cost_usd, model, client, source}
// That is exactly "one message you sent": how many tokens it cost (after), how
// much headroom compressed out (saved), which CLI (client), and which model.
// Real measured values — nothing estimated. We read only the tail (newest N).
async function recentMessages(limit = 32) {
  let st;
  try { st = await fsp.stat(HEADROOM_EVENTS); } catch { return { messages: [], live: false }; }
  const text = await readTail(HEADROOM_EVENTS, Math.max(0, st.size - 64 * 1024), st.size);
  const lines = text.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"before"') === -1) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.before !== 'number') continue;
    out.push({
      ts: e.ts ? Date.parse(e.ts) : st.mtimeMs,
      model: shortModel(e.model) || e.model || '?',
      client: e.client || e.source || 'proxy',
      before: e.before, after: e.after ?? e.before,
      saved: e.saved || 0,
      savedPct: e.before ? +((e.saved || 0) / e.before * 100).toFixed(1) : 0,
      cost: e.cost_usd || 0,
    });
  }
  // Newest first. "live" = a message compressed within the last 5 minutes.
  return { messages: out, live: out.length ? (Date.now() - out[0].ts < 5 * 60 * 1000) : false };
}

// claude-mem spawns one Claude session per compression job; a dozen near-identical
// tiles is noise. Collapse them into a single aggregate tile (their tokens already
// live in the day totals independently, so this is display-only — nothing hidden).
function groupWorkers(sessions) {
  const workers = sessions.filter((s) => s.cli === 'claude' && s.label === 'claude-mem');
  if (workers.length < 2) return sessions;
  const rest = sessions.filter((s) => !(s.cli === 'claude' && s.label === 'claude-mem'));
  const tokens = zero();
  let todayTotal = 0, lastTs = 0, active = false;
  for (const w of workers) {
    tokens.input += w.tokens.input; tokens.output += w.tokens.output;
    tokens.cacheRead += w.tokens.cacheRead; tokens.cacheWrite += w.tokens.cacheWrite;
    todayTotal += w.todayTotal || 0;
    if (w.lastTs > lastTs) lastTs = w.lastTs;
    if (w.active) active = true;
  }
  rest.push({
    cli: 'claude', id: 'claude-mem-workers', label: 'claude-mem', model: 'haiku · background',
    aggregate: true, count: workers.length,
    tokens: { ...tokens, total: totalOf(tokens) }, todayTotal, lastTs, active,
  });
  return rest;
}

async function collectAll() {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const dayMs = startOfDay.getTime();

  // Plugin inventory and per-session cost are slow and change rarely; savings
  // ledgers are cheap enough to refresh every couple of seconds; transcript
  // spend is now incremental so it runs live on every tick.
  const [costs, enabled, codexServers] = await Promise.all([
    memo('costs', 120000, pluginTokenCosts),
    memo('enabled', 30000, enabledPlugins),
    memo('codexServers', 30000, codexMcpServers),
  ]);
  const [hr, ts, rk, cm, pt, disc, cSpend, xSpend, msgs] = await Promise.all([
    memo('headroom', 2000, headroom),
    memo('tokensave', 2000, tokensave),
    memo('rtk', 15000, rtk),
    claudeMem(costs),                    // live: worker health must be realtime
    ponytail(costs, enabled.has('ponytail')),
    memo('discovered', 30000, discoveredPlugins),
    claudeSpend(dayMs),                  // live: incremental, cheap
    codexSpend(dayMs),                   // live: incremental, cheap
    recentMessages(32),                  // live: per-message savings feed (tail read)
  ]);

  // Dedicated cards first, then any auto-discovered Claude Code plugins.
  const plugins = [hr, cm, ts, pt, rk, ...disc];
  // Mark which plugins Codex actually serves right now (MCP-registered).
  for (const p of plugins) {
    p.codexActive = codexServers.has(p.id);
    if (p.codexActive && !(p.clis || []).includes('codex')) p.clis = [...(p.clis || []), 'codex'];
  }

  // Only sum sources that actually measured something. A null stays out of the
  // total; it does not silently become 0.
  const measured = plugins.filter((p) => typeof p.savedTokens === 'number');
  const totalSaved = measured.reduce((a, p) => a + p.savedTokens, 0);
  const totalCost = plugins.reduce((a, p) => a + (p.savedCost || 0), 0);
  const alwaysOn = plugins.reduce((a, p) => a + (p.alwaysOnTokens || 0), 0);

  // Merge per-session lists across CLIs, active-first then most-recent.
  let sessions = [...cSpend.sessions, ...xSpend.sessions]
    .map((s) => ({ ...s, active: Date.now() - s.lastTs <= ACTIVE_MS }));
  sessions = groupWorkers(sessions);
  sessions.sort((a, b) => (b.active - a.active) || (b.lastTs - a.lastTs));

  const claudeTodayTotal = totalOf(cSpend.today);
  const codexTodayTotal = xSpend.todayTotal || 0;

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
    // Backwards-compatible: spend.today/allTime are Claude's per-field breakdown
    // (what the original cards read); the combined + per-CLI numbers are new.
    spend: {
      today: cSpend.today,
      allTime: cSpend.allTime,
      sessions: cSpend.sessions.length + xSpend.sessions.length,
      claudeTodayTotal,
      codexTodayTotal,
      todayTotal: claudeTodayTotal + codexTodayTotal,
      allTimeTotal: totalOf(cSpend.allTime) + totalOf(xSpend.allTime),
    },
    sessions,
    activeSessions: sessions.filter((s) => s.active).length,
    // Intraday token burn, split by CLI identity (24 hourly buckets, local time).
    charts: {
      byHour: { claude: cSpend.byHour, codex: xSpend.byHour },
    },
    // Per-message feed: newest-first, each with tokens used + saved + model + CLI.
    messages: msgs.messages,
    messagesLive: msgs.live,
    compressor: hr.active ? 'headroom' : null,
  };
}

module.exports = { collectAll };
