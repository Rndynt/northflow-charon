# Charon Fixes — 2026-08 Session

Comprehensive debugging + tuning session on the Charon Solana sniper bot (dry-run).
All changes are safe, reversible, and keep the bot in dry-run mode. No live-trading,
RPC, or private-key changes were made.

## Root causes found & fixed

### Bug #1 — SL sentinel (999/90/80 = instant stop-loss)
`src/execution/positions.js`:
```js
const slHit = pnlPercent <= effectiveSlPercent && pnlPercent < 0;
```
With `sl_percent = 999` (user thought "off"), `-25 <= 999` is ALWAYS true → SL fires on
first dip. `dynamicStopLossPercent()` also collapsed 999 → `Math.max(-50, Math.min(-8,999))`
= **-8% super-tight**. Result: 63/87 SL exits were instant stops within 1-3s, avg -14.76%.

**Fixes:**
- `src/utils.js` `dynamicStopLossPercent()` returns `null` when `base >= 0` (disabled).
- `src/execution/positions.js` `slHit` only fires when `effectiveSlPercent != null && < 0`.
- `src/telegram/commands.js` + `callbacks.js` reject any non-negative SL (or keyword `off`).

### Bug #2 — SL lives in TWO places
`settings.default_sl_percent` is only a fallback. The ACTIVE strategy's
`strategies.config_json.sl_percent` is what new positions use. A `sniper` strategy with
`sl_percent=80` kept spawning broken positions even after the DB was reset.
**Fix:** `scripts/fix_sl.sql.py` resets `sl_percent=-25` in BOTH `dry_run_positions` and
`strategies.config_json`.

### Bug #3 — Flash-dump past stop (circuit breaker)
Bot polls every `POSITION_CHECK_MS` (5s). Between polls a token can rug-pull 80%+
(liquidity pulled), so the recorded exit is far below SL%. 13 trades < -50% totaled -1087.8%.
**Fix:** `src/execution/positions.js` adds `panicHit` — if `trailDrop <= -panicDropPct`
(default 30%) from high-water in one check, exit immediately as SL. Setting
`panic_exit_enabled` (default on) + `panic_exit_drop_pct` (default 30) in `settings` table.

### Bug #4 (CRITICAL) — Route block skipped in rule-based mode
Strategy `degen` is `use_llm: false`. Route-blocking only lived in:
- `src/db/candidates.js` `recentEligibleCandidates()` — only called in the LLM branch
- `src/pipeline/llm.js` `normalizeDecision()` — only runs when `use_llm` is true

So rule-based mode bought `pumpfun_pregrad` ($6.2K tokens) and `dual_source` (unprofitable
routes) ignoring `blocked_routes`. Symptom: positions with `signal_key` `pumpfun_pregrad:...`
kept appearing.
**Fixes:**
- `src/pipeline/orchestrator.js` — route-block guard at TOP of `processCandidateFromSignals()`
  (covers both modes), reading `setting('blocked_routes')`.
- `src/pipeline/llm.js` — `BLOCKED_ROUTES` now reads `setting('blocked_routes')` instead of
  the hard-coded `['dual_source','fee_graduated_trending','graduated_trending']` (which
  wrongly blocked `graduated_trending`, a PROFITABLE route at +7.6%).
- `src/pipeline/candidateBuilder.js` — hard mcap floor $15K for fresh-grad tokens (prevents
  micro-cap rugs like Bailey #202 at -66%).

### Bug #5 — `better-sqlite3` native module crash
After a Node update the bot failed with `ERR_DLOPEN_FAILED ... _ZN2v811HandleScopeC1`.
**Fix:** `npm rebuild better-sqlite3`. (Repeats if Node is updated again.)

### start.sh
Was `cd /` + `exec node index.js` (broken — node can't find files). Fixed to project path.

## Telegram UI additions
- `/routes` command + **Routes** button in main menu (`menu:routes`) → toggle per-route on/off.
- **Panic Exit** status + toggle button in Agent menu (`toggle:panic_exit_enabled`).
- SL/TP validation on all Telegram inputs (rejects sentinel values).
- `blocked_routes` setting now drives route filtering everywhere (was hard-coded).

## Backtest results (used real 195 closed trades)
| Scenario | Total PnL |
|---|---|
| Baseline (recorded) | +129% |
| + Panic-exit circuit breaker | +1139% (+1010pp) |
| + Route block (pregrad/dual excluded) | further improvement (25% of trades were unprofitable routes) |

Post-fix live sample (22 trades): WR 50%, avg +8.6%, trailing-TP avg +44.6%.

## Files changed
- `src/utils.js` — dynamicStopLossPercent null-on-disabled
- `src/execution/positions.js` — slHit guard + panic-exit circuit breaker
- `src/db/candidates.js` — BLOCKED_ROUTES from setting
- `src/pipeline/llm.js` — BLOCKED_ROUTES from setting
- `src/pipeline/candidateBuilder.js` — hard mcap floor for fresh-grad
- `src/pipeline/orchestrator.js` — route-block guard (both modes)
- `src/telegram/menus.js` — Routes menu + Panic Exit status/toggle
- `src/telegram/callbacks.js` — menu:routes, routes: toggles, panic toggle, SL validation
- `src/telegram/commands.js` — /routes command, SL/TP validation
- `start.sh` — fixed working directory
- `scripts/backtest_fix_analysis.py`, `scripts/backtest_panic_exit.py`, `scripts/fix_sl.sql.py`

## Verification
- `node --check` on all edited files: PASS
- Unit logic: `slHit(-2, 999)===false`, `slHit(-30,-25)===true`, `dynamicStopLossPercent(999)===null`
- 0 blocked-route leaks after restart (pregrad/dual no longer bought)
- Bot RUNNING, stable, dry-run, all open positions `sl=-25`
