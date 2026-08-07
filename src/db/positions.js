import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy, slippageAdjustedMcap } from './settings.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function hasClosedPosition(mint) {
  const row = db.prepare(`
    SELECT 1 FROM dry_run_positions WHERE mint = ? AND status = 'closed' LIMIT 1
  `).get(mint);
  return !!row;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(closedLimit = 10) {
  // Previously: `ORDER BY id DESC LIMIT ?` on the whole table. Once more than
  // `closedLimit` trades had happened since a position opened, that position's
  // row fell outside the window and silently vanished from every menu/command
  // that calls this — even though it was still genuinely open. Open positions
  // are unbounded (there are only ever a handful) and closed ones are capped.
  const open = db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
  const closed = db.prepare('SELECT * FROM dry_run_positions WHERE status != ? ORDER BY id DESC LIMIT ?').all('open', closedLimit);
  return [...open, ...closed];
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  let sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  
  // OPTION C HYBRID: Risk-based position sizing
  // Calculate total risk severity from candidate.riskFlags
  const riskFlags = candidate.riskFlags || [];
  const totalRiskSeverity = riskFlags.reduce((sum, flag) => sum + (flag.severity || 0), 0);
  
  if (totalRiskSeverity >= 2) {
    // High risk (severity ≥2) → cut size to 50%
    const originalSize = sizeSol;
    sizeSol *= 0.5;
    console.log(`[position] risk-adjusted size: ${originalSize} → ${sizeSol} SOL (total risk severity: ${totalRiskSeverity}, flags: ${riskFlags.map(f => f.type).join(', ')})`);
  }
  
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  let entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  entryMcap = slippageAdjustedMcap(entryMcap, 'entry');
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    // Atomic re-check: the caller's canOpenMorePositions() check happens before an
    // `await` (LLM call / execution refresh), so concurrent candidates can all pass
    // it while the count is still stale, then all reach here before any of them is
    // counted — that's how open positions blew past the configured cap. This check
    // is inside the same synchronous db.transaction as the INSERT below (no `await`
    // between them), so it's race-free against other calls to this function.
    const maxOpen = strat.max_open_positions ?? numSetting('max_open_positions', 3);
    if (maxOpen > 0) {
      const openCount = db.prepare(`SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = 'open'`).get().count;
      if (openCount >= maxOpen) {
        console.log(`[positions] blocked entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — max open positions reached (${openCount}/${maxOpen}) at insert time`);
        return { id: null, isNew: false, blockedBy: 'max_open_positions' };
      }
    }

    // Dedup: block re-entry if this token has been closed within 24 hours
    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — closed <24h ago`);
      return { id: recentClosed.id, isNew: false };
    }

    // Block re-entry if this mint had a winning trade in the last WIN_BLOCK_DAYS days (avoid round-trip losses)
    const WIN_BLOCK_DAYS = 7;
    const pastWin = db.prepare(`
      SELECT id, pnl_sol, closed_at_ms FROM dry_run_positions
      WHERE mint = ? AND status = 'closed' AND pnl_percent > 0
        AND closed_at_ms > ?
      ORDER BY closed_at_ms DESC LIMIT 1
    `).get(candidate.token.mint, now() - WIN_BLOCK_DAYS * 86400000);
    if (pastWin) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — past WIN exists`);
      return { id: pastWin.id, isNew: false, blockedBy: 'past_win', pastWinPnlSol: pastWin.pnl_sol, pastWinClosedAtMs: pastWin.closed_at_ms };
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  // In LIVE mode, derive entry price/mcap from the actual on-chain swap, not the
  // signal snapshot (which can lag 10-30s and misreport entry). Fall back to the
  // snapshot only if the swap result is missing.
  let entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  let entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  if (swap && swap.outputAmount) {
    const outAmt = Number(swap.outputAmount) || 0;
    if (outAmt > 0) {
      // Real execution price = SOL spent / tokens received.
      entryPrice = sizeSol / outAmt;
      // Best mcap proxy we have on-chain: derive from the Jupiter order if present.
      const order = swap.order || {};
      if (order.outAmount && order.inAmount) {
        const orderOut = Number(order.outAmount) / 1e6; // Jupiter tokens are 6dp
        const orderIn = Number(order.inAmount) / 1e9;   // SOL is 9dp
        if (orderOut > 0) entryPrice = orderIn / orderOut;
      }
      entryMcap = entryPrice * (Number(candidate.metrics.supply || 0) || 1e9);
      if (!Number.isFinite(entryMcap) || entryMcap <= 0) {
        // Fallback: keep snapshot mcap if derivation failed, but price is now accurate.
        entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
      }
    }
  }
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    // Same atomic re-check as createDryRunPosition — see comment there. Not the
    // currently active mode (dry_run is), but left inconsistent this becomes a bug
    // waiting for whenever live trading is turned on.
    const maxOpenLive = strat.max_open_positions ?? numSetting('max_open_positions', 3);
    if (maxOpenLive > 0) {
      const openCountLive = db.prepare(`SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = 'open'`).get().count;
      if (openCountLive >= maxOpenLive) {
        console.log(`[positions] blocked live entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — max open positions reached (${openCountLive}/${maxOpenLive}) at insert time`);
        return { id: null, isNew: false, blockedBy: 'max_open_positions' };
      }
    }

    // Dedup: block re-entry if this token has been closed within 24 hours
    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — closed <24h ago (live)`);
      return { id: recentClosed.id, isNew: false };
    }

    // Block re-entry if this mint ever had a winning trade (avoid round-trip losses)
    const pastWin = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND pnl_percent > 0 LIMIT 1
    `).get(candidate.token.mint);
    if (pastWin) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — past WIN exists (live)`);
      return { id: pastWin.id, isNew: false };
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}
