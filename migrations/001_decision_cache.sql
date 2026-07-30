-- Migration: Add decision_cache table for LLM efficiency (Bug Fix #1)
-- Purpose: Cache WATCH/PASS decisions to prevent redundant LLM calls
-- Impact: Reduces LLM cost by ~60-70%, eliminates rate limit errors

CREATE TABLE IF NOT EXISTS decision_cache (
  mint TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT,
  route TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  mcap_snapshot REAL,
  holders_snapshot INTEGER,
  liq_snapshot REAL
);

CREATE INDEX IF NOT EXISTS idx_decision_cache_expires ON decision_cache(expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_decision_cache_mint_expires ON decision_cache(mint, expires_at_ms);
