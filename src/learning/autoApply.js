import { db } from '../db/connection.js';
import { now, json } from '../utils.js';

function parseNumericFromLesson(lesson, pattern) {
  const match = lesson.match(pattern);
  return match ? Number(match[1]) : null;
}

function extractRules(lessons) {
  const rules = [];

  for (const lesson of lessons) {
    const l = lesson.lesson;
    const evidence = lesson.evidence_json ? JSON.parse(lesson.evidence_json) : {};
    const priority = evidence.priority || 'medium';

    // Match: Exit reason "TRAILING_TP" (29x): avg PnL +29.01%
    if (/exit\s+reason.*"TRAILING_TP"/i.test(l) || /trailing.*avg\s*pnl/i.test(l)) {
      const avgPnl = parseNumericFromLesson(l, /avg\s*PnL\s*([+-]?\d+\.?\d*)%/i) || 0;
      if (avgPnl > 15) {
        rules.push({
          action: 'trailing_working_well',
          strategy_id: null,
          confidence: priority === 'high' ? 0.9 : 0.75,
          reason: l,
          suggestion: { param: 'trailing_percent', noChange: true },
        });
      }
    }

    // Match: Exit reason "SL" (37x): avg PnL -25.70%
    // Also: narrative format "stop loss" / "hit the -N% stop loss" / "all N losses"
    if (/exit\s+reason.*"SL"/i.test(l) || /sl\s*is\s*drag/i.test(l) || /sl\s.*avg\s*loss/i.test(l) ||
        /stop\s*loss/i.test(l) || /hit\s+the\s+-\d+/i.test(l)) {
      const avgPnl = parseNumericFromLesson(l, /avg\s*PnL\s*([+-]?\d+\.?\d*)%/i);
      // Narrative: "hit the -12% stop loss; all 11 losses" — always tighten SL
      // Refined: only match stop-loss context (negative numbers or stop-loss phrasing),
      // not arbitrary "hit the 50" patterns with positive integers.
      const hasSLIssues = /stop\s*loss|hit\s+the\s+-\d+/.test(l);
      if ((avgPnl && avgPnl < -15) || hasSLIssues) {
        // SL is too loose — tighten it (less negative = catch losers earlier)
        rules.push({
          action: 'tighten_sl',
          strategy_id: null,
          confidence: priority === 'high' ? 0.9 : 0.8,
          reason: l,
          suggestion: { param: 'sl_percent', increaseBy: 3, min: -15, max: -12 },
        });
      }
    }

    // Match: Exit reason "RUG_DETECTED" / "RUG_VELOCITY"
    if (/exit\s+reason.*"RUG_(DETECTED|VELOCITY)"/i.test(l)) {
      const avgPnl = parseNumericFromLesson(l, /avg\s*PnL\s*([+-]?\d+\.?\d*)%/i);
      if (avgPnl && avgPnl < -10) {
        rules.push({
          action: 'tighten_rug_filter',
          strategy_id: null,
          confidence: priority === 'high' ? 0.9 : 0.8,
          reason: l,
          suggestion: { param: 'trending_max_rug_ratio', decreaseBy: -0.05, min: 0.15 },
        });
      }
    }

    // Match: Higher MC tokens outperform
    if (/higher\s*MC.*outperform/i.test(l) || /raise.*min_mcap/i.test(l)) {
      const mcapMatches = [...l.matchAll(/\$(\d+(?:\.\d+)?[KMB]?)/gi)];
      const mcapVals = mcapMatches.map(m => {
        const raw = m[1];
        const num = parseFloat(raw);
        if (isNaN(num)) return null;
        const suffix = raw.slice(-1).toUpperCase();
        if (suffix === 'K') return num * 1_000;
        if (suffix === 'M') return num * 1_000_000;
        if (suffix === 'B') return num * 1_000_000_000;
        return num;
      }).filter(v => v !== null && v > 0);
      if (mcapVals.length >= 2) {
        // Take average of all parsed mcap values, clamped to a reasonable range.
        const avg = mcapVals.reduce((a, b) => a + b, 0) / mcapVals.length;
        const clamped = Math.max(5_000, Math.min(200_000, Math.round(avg)));
        rules.push({
          action: 'adjust_min_mcap',
          strategy_id: null,
          confidence: 0.7,
          reason: l,
          suggestion: { param: 'min_mcap_usd', newValue: clamped },
        });
      } else if (mcapMatches.length >= 2) {
        // Matches found but all failed to parse — log and skip.
        console.warn(`[autoApply] mcap regex matched but no values parsed for lesson: ${l.slice(0, 120)}`);
      }
    }

    // Match: Route with losses — deprioritize (note only, no config change)
    // Old format: route.*"smart_money".*losses
    // New format: "Avoid the 'dual_source' and 'fee_graduated_trending' routes completely; they produced 0% win rate and -36% combined PnL."
    if (/route.*"smart_money".*losses/i.test(l) ||
        (/avoid.*routes?\s*(completely)?.*produced\s+(\d+)%\s*win/i.test(l) && /pnl/i.test(l))) {
      rules.push({
        action: 'note_route_deprioritize',
        strategy_id: null,
        confidence: 0.6,
        reason: l,
        suggestion: { param: null, noChange: true },
      });
    }

    // Match: Route with losses — also single "Avoid the 'single_source' route" narrative
    if (/avoid.*'([^']+)'.*route.*(?:33%|unreliable|loss)/i.test(l) && !/completely|dual_source|fee_graduated/i.test(l)) {
      rules.push({
        action: 'note_route_deprioritize',
        strategy_id: null,
        confidence: 0.7,
        reason: l,
        suggestion: { param: null, noChange: true },
      });
    }

    // Match: "Reject candidates that trigger 'entry_rejected_fresh_filters'"
    if (/reject.*candidates.*entry_rejected_fresh_filters/i.test(l) || /fresh_filters.*rejections/i.test(l)) {
      rules.push({
        action: 'enable_fresh_filter_reject',
        strategy_id: null,
        confidence: 0.75,
        reason: l,
        suggestion: { param: 'reject_on_fresh_filters', newValue: true },
      });
    }

    // Match: Route with wins — prioritize (note only)
    // Old: route.*"(trenches_completed|dual_source)".*wins
    // New: "Prioritize 'graduated_trending' and 'pump_graduated' routes; they generated 62.5% win rate and +62.9% PnL"
    if (/route.*"(trenches_completed|dual_source)".*wins/i.test(l) ||
        (/prioritize.*routes?.*generated\s+(\d+)/i.test(l) && /win\s*rate/i.test(l) && /pnl/i.test(l))) {
      rules.push({
        action: 'note_route_prioritize',
        strategy_id: null,
        confidence: 0.6,
        reason: l,
        suggestion: { param: null, noChange: true },
      });
    }

    // Match: holders outperform
    if (/more\s*holders.*outperform/i.test(l) || /increas.*min_holders/i.test(l)) {
      const holderCount = parseNumericFromLesson(l, /avg\s*(\d+)/i);
      const capped = Math.min(holderCount || 200, 300);
      rules.push({
        action: 'increase_min_holders',
        strategy_id: null,
        confidence: 0.85,
        reason: l,
        suggestion: { param: 'min_holders', newValue: capped },
      });
    }

    // Match: LLM confidence adjustment
    // "lower LLM confidence" or "too many pass" → reduce threshold
    // "Increase LLM... confidence threshold above N%" → raise threshold (increaseBy)
    if (/lower.*llm.*confidence/i.test(l) || /too.*many.*pass/i.test(l) || /never.*buy/i.test(l)) {
      rules.push({
        action: 'lower_llm_confidence',
        strategy_id: null,
        confidence: 0.7,
        reason: l,
        suggestion: { param: 'llm_min_confidence', decreaseBy: -5, min: 25, max: 85 },
      });
    } else if (/increas.*llm.*confidence.*threshold.*above\s*(\d+)/i.test(l)) {
      const targetPct = Number(l.match(/increas.*llm.*confidence.*threshold.*above\s*(\d+)/i)[1]);
      rules.push({
        action: 'raise_llm_confidence',
        strategy_id: null,
        confidence: 0.85,
        reason: l,
        suggestion: { param: 'llm_min_confidence', newValue: targetPct, min: 20, max: 85 },
      });
    }
  }

  // Resolve strategy ID — apply to active strategy
  const activeStrat = db.prepare('SELECT id FROM strategies WHERE enabled = 1').get();
  const strategyId = activeStrat?.id || 'pump_scalp';

  for (const rule of rules) {
    rule.strategy_id = strategyId;
  }

  // Deduplicate by action
  const seen = new Set();
  return rules.filter(r => {
    if (seen.has(r.action)) return false;
    seen.add(r.action);
    return true;
  });
}

export function autoApplyLessons(minConfidence = 0.75) {
  // Ensure learning_applied table exists
  db.exec(`CREATE TABLE IF NOT EXISTS learning_applied (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id INTEGER,
    applied_at_ms INTEGER NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    strategy_id TEXT
  )`);

  // Recency gate: only consider lessons created in the last 7 days.
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const cutoffMs = now() - sevenDaysMs;
  const activeLessons = db.prepare(
    `SELECT id, lesson, evidence_json FROM learning_lessons
     WHERE status = 'active' AND created_at_ms >= ?
     ORDER BY created_at_ms DESC`
  ).all(cutoffMs);

  if (!activeLessons.length) {
    return { applied: 0, actions: [] };
  }

  const rules = extractRules(activeLessons);
  const applied = [];

  for (const rule of rules) {
    if (rule.confidence < minConfidence) continue;
    if (rule.suggestion.noChange) continue; // Skip note-only rules

    const strategyId = rule.strategy_id;

    // Idempotency: skip if same action already applied for this strategy in the last 24h.
    const oneDayAgoMs = now() - 24 * 60 * 60 * 1000;
    const recentApply = db.prepare(
      `SELECT id FROM learning_applied
       WHERE action = ? AND strategy_id = ? AND applied_at_ms >= ?`
    ).get(rule.action, strategyId, oneDayAgoMs);
    if (recentApply) continue;

    const strategy = db.prepare('SELECT config_json FROM strategies WHERE id = ?').get(strategyId);
    if (!strategy) continue;

    const cfg = JSON.parse(strategy.config_json);
    const suggestion = rule.suggestion;
    const oldValue = String(cfg[suggestion.param] ?? 'N/A');

    let newValue;
    if (suggestion.newValue !== undefined) {
      newValue = suggestion.newValue;
    } else if (suggestion.increaseBy !== undefined) {
      newValue = (cfg[suggestion.param] || 0) + suggestion.increaseBy;
      if (suggestion.max !== undefined) newValue = Math.min(newValue, suggestion.max);
      if (suggestion.min !== undefined) newValue = Math.max(newValue, suggestion.min);
    } else if (suggestion.decreaseBy !== undefined) {
      newValue = (cfg[suggestion.param] || 0) + suggestion.decreaseBy;
      if (suggestion.max !== undefined) newValue = Math.max(newValue, suggestion.max);
      if (suggestion.min !== undefined) newValue = Math.min(newValue, suggestion.min);
    }

    if (newValue !== undefined && newValue !== cfg[suggestion.param]) {
      cfg[suggestion.param] = newValue;
      db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), strategyId);

      const lessonIds = activeLessons
        .filter(l => l.lesson === rule.reason)
        .map(l => l.id);

      db.prepare(
        `INSERT INTO learning_applied (lesson_id, applied_at_ms, action, old_value, new_value, strategy_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(lessonIds[0] || null, now(), rule.action, oldValue, String(newValue), strategyId);

      applied.push({
        action: rule.action,
        param: suggestion.param,
        oldValue,
        newValue: String(newValue),
        strategyId,
        confidence: rule.confidence,
      });
    }
  }

  return { applied: applied.length, actions: applied };
}
