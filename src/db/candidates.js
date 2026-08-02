import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';
import { numSetting } from './settings.js';

export function candidateSignalKey(candidate, signature = null) {
  const route = candidate.signals?.route || 'signal';
  const bucket = Math.floor(Number(candidate.createdAtMs || now()) / (5 * 60 * 1000));
  const sigFragment = signature ? `:${signature.slice(0, 16)}` : '';
  return `${route}:${candidate.token.mint}:${bucket}${sigFragment}`;
}

export function upsertCandidate(candidate, signature) {
  const signalKey = candidateSignalKey(candidate, signature);
  const mint = candidate.token.mint;
  const status = candidate.filters.passed ? 'candidate' : 'filtered';
  const candidateJson = json(candidate);
  const filterJson = json(candidate.filters);

  // The candidates table enforces UNIQUE(signature, mint), but signal_key is a
  // *different* dedup key (route:mint:5min-bucket). The same underlying token
  // event is often picked up by more than one signal source (e.g. trenches +
  // graduated + trending) with different routes, producing different signal_keys
  // for the same (signature, mint) pair. Checking signal_key alone let two such
  // calls both fall into the INSERT branch, and the second violated the DB's
  // UNIQUE(signature, mint) constraint. Check both keys before deciding.
  const findExisting = () => {
    const bySignalKey = db.prepare('SELECT id FROM candidates WHERE signal_key = ?').get(signalKey);
    if (bySignalKey) return bySignalKey;
    if (signature) {
      return db.prepare('SELECT id FROM candidates WHERE signature = ? AND mint = ?').get(signature, mint);
    }
    return null;
  };

  return db.transaction(() => {
    const existing = findExisting();
    if (existing) {
      db.prepare(`
        UPDATE candidates
        SET status = ?, updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
        WHERE id = ?
      `).run(status, now(), candidateJson, filterJson, existing.id);
      return existing.id;
    }

    try {
      const result = db.prepare(`
        INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signature, signal_key, candidate_json, filter_result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(mint, status, now(), now(), signature, signalKey, candidateJson, filterJson);
      return Number(result.lastInsertRowid);
    } catch (err) {
      // Defensive fallback in case of a UNIQUE(signature, mint) collision we
      // didn't catch above — update the existing row instead of crashing.
      if (signature && String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
        const raceRow = db.prepare('SELECT id FROM candidates WHERE signature = ? AND mint = ?').get(signature, mint);
        if (raceRow) {
          db.prepare(`
            UPDATE candidates
            SET status = ?, updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
            WHERE id = ?
          `).run(status, now(), candidateJson, filterJson, raceRow.id);
          return raceRow.id;
        }
      }
      throw err;
    }
  })();
}

export function updateCandidateStatus(candidateId, status) {
  db.prepare('UPDATE candidates SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, now(), candidateId);
}

export function updateCandidateSnapshot(candidateId, candidate, status = null) {
  db.prepare(`
    UPDATE candidates
    SET status = COALESCE(?, status), updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
    WHERE id = ?
  `).run(status, now(), json(candidate), json(candidate.filters || {}), candidateId);
}

export function candidateById(id) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

export function candidatesByIds(ids) {
  return ids.map(id => candidateById(Number(id))).filter(Boolean);
}

export function latestCandidateByMint(mint) {
  const row = db.prepare('SELECT * FROM candidates WHERE mint = ? ORDER BY id DESC LIMIT 1').get(mint);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

export function recentEligibleCandidates(limit = 10) {
  const maxAgeMs = numSetting('llm_candidate_max_age_ms', 10 * 60 * 1000);
  const cutoff = now() - Math.max(30_000, maxAgeMs);
  // Lesson #3: block unprofitable routes at query level — prevents blocked routes from drowning out profitable ones
  // pumpfun_pregrad: pre-grad tokens still on bonding curve, can't reliably trade yet — keep for data only
  const BLOCKED_ROUTES = ['dual_source', 'fee_graduated_trending', 'pumpfun_pregrad', 'graduated_trending'];
  const blockedClause = BLOCKED_ROUTES.map(r => `signal_key NOT LIKE '${r}:%'`).join(' AND ');
  const rows = db.prepare(`
    SELECT c.*
    FROM candidates c
    INNER JOIN (
      SELECT mint, MAX(id) as max_id
      FROM candidates
      WHERE status IN ('candidate', 'watch', 'buy', 'pass')
        AND created_at_ms >= ?
        AND id NOT IN (SELECT COALESCE(candidate_id, -1) FROM dry_run_positions WHERE status = 'open')
        AND ${blockedClause}
        AND (
          json_extract(candidate_json, '$.filters.passed') IS NULL
          OR json_extract(candidate_json, '$.filters.passed') = 1
        )
      GROUP BY mint
    ) latest ON c.id = latest.max_id
    ORDER BY c.id DESC
    LIMIT ?
  `).all(cutoff, limit);
  return rows.map(row => ({ ...row, candidate: safeJson(row.candidate_json, {}) })).reverse();
}
