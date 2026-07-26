import { db } from '../db/connection.js';
import { activeStrategy } from '../db/settings.js';
import { now } from '../utils.js';

function startOfUtcDay(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfTodayUtc() {
  return startOfUtcDay(now());
}

export function endOfTodayUtc() {
  return startOfUtcDay(now()) + 24 * 60 * 60 * 1000;
}

function rowToClose(row) {
  return {
    id: row.id,
    mint: row.mint,
    symbol: row.symbol,
    strategyId: row.strategy_id,
    pnlPercent: Number(row.pnl_percent || 0),
    pnlSol: Number(row.pnl_sol || 0),
    entryMcap: Number(row.entry_mcap || 0),
    exitReason: row.exit_reason,
    closedAt: row.closed_at_ms,
  };
}

export function dailyAggregate(sinceMs, untilMs = now()) {
  const rows = db.prepare(`
    SELECT id, mint, symbol, strategy_id, pnl_percent, pnl_sol, entry_mcap, exit_reason, closed_at_ms
    FROM dry_run_positions
    WHERE status = 'closed' AND closed_at_ms >= ? AND closed_at_ms < ?
    ORDER BY closed_at_ms DESC
  `).all(sinceMs, untilMs).map(rowToClose);

  const wins = rows.filter(r => r.pnlPercent > 0);
  const losses = rows.filter(r => r.pnlPercent < 0);
  const totalSol = rows.reduce((s, r) => s + r.pnlSol, 0);
  const best = rows.reduce((acc, r) => (!acc || r.pnlPercent > acc.pnlPercent) ? r : acc, null);
  const worst = rows.reduce((acc, r) => (!acc || r.pnlPercent < acc.pnlPercent) ? r : acc, null);
  const avgWin = wins.length ? wins.reduce((s, r) => s + r.pnlPercent, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + r.pnlPercent, 0) / losses.length : 0;
  const riskReward = avgLoss < 0 ? Math.abs(avgWin / avgLoss) : 0;

  return {
    total: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? (wins.length / rows.length) * 100 : 0,
    totalSol,
    best,
    worst,
    avgWin,
    avgLoss,
    riskReward,
    rows,
  };
}

export function openPositionStats() {
  const rows = db.prepare(`
    SELECT id, mint, symbol, strategy_id, pnl_percent, pnl_sol, entry_mcap, high_water_mcap, opened_at_ms
    FROM dry_run_positions
    WHERE status = 'open'
    ORDER BY opened_at_ms DESC
  `).all();
  return rows.map(r => ({
    id: r.id,
    mint: r.mint,
    symbol: r.symbol,
    strategyId: r.strategy_id,
    pnlPercent: r.pnl_percent != null ? Number(r.pnl_percent)
      : (r.entry_mcap && r.high_water_mcap ? (Number(r.high_water_mcap) / Number(r.entry_mcap) - 1) * 100 : 0),
    pnlSol: Number(r.pnl_sol || 0),
    entryMcap: Number(r.entry_mcap || 0),
    openedAt: r.opened_at_ms,
  }));
}

export function mcapRangeBreakdown(sinceMs) {
  const rows = db.prepare(`
    SELECT id, entry_mcap, pnl_percent, pnl_sol, status
    FROM dry_run_positions
    WHERE entry_mcap IS NOT NULL AND entry_mcap > 0
      AND opened_at_ms >= ?
  `).all(sinceMs);
  const buckets = [
    { label: 'Micro (<10K)', min: 0, max: 10000, count: 0, wins: 0, pnlSol: 0 },
    { label: 'Small (10-25K)', min: 10000, max: 25000, count: 0, wins: 0, pnlSol: 0 },
    { label: 'Mid (25-50K)', min: 25000, max: 50000, count: 0, wins: 0, pnlSol: 0 },
    { label: 'Upper (50-100K)', min: 50000, max: 100000, count: 0, wins: 0, pnlSol: 0 },
    { label: 'Large (100-250K)', min: 100000, max: 250000, count: 0, wins: 0, pnlSol: 0 },
    { label: 'Mega (250K+)', min: 250000, max: Infinity, count: 0, wins: 0, pnlSol: 0 },
  ];
  for (const r of rows) {
    const m = Number(r.entry_mcap);
    const bucket = buckets.find(b => m >= b.min && m < b.max);
    if (!bucket) continue;
    bucket.count++;
    if (r.status === 'closed') {
      if (Number(r.pnl_percent) > 0) bucket.wins++;
      bucket.pnlSol += Number(r.pnl_sol || 0);
    }
  }
  return buckets;
}

export function routeBreakdown(sinceMs) {
  const rows = db.prepare(`
    SELECT json_extract(snapshot_json, '$.candidate.signals.label') as label,
           json_extract(snapshot_json, '$.candidate.signals.route') as route,
           pnl_percent, pnl_sol, status
    FROM dry_run_positions
    WHERE opened_at_ms >= ?
  `).all(sinceMs);
  const map = new Map();
  for (const r of rows) {
    const key = (r.label || r.route || 'unknown').toString();
    if (!map.has(key)) map.set(key, { label: key, count: 0, wins: 0, pnlSol: 0, total: 0 });
    const e = map.get(key);
    e.count++;
    e.total++;
    if (r.status === 'closed') {
      if (Number(r.pnl_percent) > 0) e.wins++;
      e.pnlSol += Number(r.pnl_sol || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.pnlSol - a.pnlSol);
}

export function recentAlerts(limit = 8) {
  return db.prepare(`
    SELECT a.id, a.kind, a.mint, a.sent_at_ms, a.payload_json,
           json_extract(a.payload_json, '$.decision.verdict') as verdict,
           json_extract(a.payload_json, '$.decision.confidence') as confidence,
           json_extract(a.payload_json, '$.decision.reason') as reason
    FROM alerts a
    ORDER BY a.sent_at_ms DESC
    LIMIT ?
  `).all(limit);
}

export function dailySignalCount(sinceMs) {
  return db.prepare(`
    SELECT source, COUNT(*) as c
    FROM signal_events
    WHERE at_ms >= ?
    GROUP BY source
    ORDER BY c DESC
  `).all(sinceMs);
}

export function last24hReport() {
  return dailyAggregate(now() - 24 * 60 * 60 * 1000, now());
}

export function todayReport() {
  return dailyAggregate(startOfTodayUtc(), now());
}

export function botStatus() {
  const agentEnabled = db.prepare(`SELECT value FROM settings WHERE key = 'agent_enabled'`).get();
  return {
    active: agentEnabled ? agentEnabled.value === 'true' : false,
    strategy: activeStrategy(),
  };
}
