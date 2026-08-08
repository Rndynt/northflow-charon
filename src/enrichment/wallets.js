import { db } from '../db/connection.js';
import { now } from '../utils.js';

export function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}

export async function fetchSavedWalletExposure(mint, holders) {
  const wallets = savedWallets();
  if (!wallets.length || !holders?.holders?.length) {
    return { holderCount: 0, checked: wallets.length, wallets: [] };
  }
  const holderSet = new Set(holders.holders.map(h => h.address));
  const matched = wallets.filter(wallet => holderSet.has(wallet.address));
  return {
    holderCount: matched.length,
    checked: wallets.length,
    wallets: matched.map(w => w.label),
  };
}

import { spawn } from 'node:child_process';
import { sleep } from '../utils.js';

// Pull the active smart-money trade feed from GMGN via the official gmgn-cli and return the
// unique wallet addresses seen trading (with their tag labels). Manual trigger only — no auto-run.
// Requires gmgn-cli installed globally and GMGN_API_KEY / GMGN_PRIVATE_KEY set in the environment.
//
// opts:
//   limit        number of trades to fetch from the feed (default 100)
//   chain        'sol' | 'bsc' | 'base' | 'eth' (default 'sol')
//   tags         comma-separated required tags, e.g. 'smart_degen,kol' — wallet kept only if it has ALL
//   minWinRate   0..1 — if set, query gmgn portfolio stats per wallet and keep only winrate >= this
//   minPnlSol    number — if set, keep only wallets with realized_profit (SOL) >= this
// Note: minWinRate/minPnlSol require one extra gmgn-cli call per wallet (rate-limited ~20/s burst).
export async function fetchGmgnSmartWallets({ limit = 100, chain = 'sol', tags = '', minWinRate = 0, minPnlSol = 0 } = {}) {
  const raw = await new Promise((resolve, reject) => {
    const args = ['track', 'smartmoney', '--chain', chain, '--limit', String(limit), '--raw'];
    const proc = spawn('gmgn-cli', args, { env: process.env });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`gmgn-cli exited ${code}: ${err.slice(0, 200)}`));
      resolve(out);
    });
  });
  const parsed = JSON.parse(raw.trim());
  const list = parsed?.list || parsed?.data?.list || [];
  const seen = new Map();
  for (const t of list) {
    const addr = t.maker || t.wallet || t.address;
    if (!addr || seen.has(addr)) continue;
    const tagList = (t.maker_info?.tags || []);
    seen.set(addr, tagList.join(','));
  }
  let wallets = [...seen.entries()].map(([address, tags]) => ({ address, tags }));

  // Tag filter
  const reqTags = (tags || '').split(',').map(s => s.trim()).filter(Boolean);
  if (reqTags.length) {
    wallets = wallets.filter(w => {
      const have = new Set(w.tags.split(',').filter(Boolean));
      return reqTags.every(rt => have.has(rt));
    });
  }

  // PnL / WR filter (requires per-wallet stats query)
  if (minWinRate > 0 || minPnlSol > 0) {
    const filtered = [];
    for (const w of wallets) {
      try {
        const stats = await queryWalletStats(w.address, chain);
        const wr = Number(stats?.pnl_stat?.winrate || 0);
        const pnlSol = Number(stats?.realized_profit || 0);
        if (wr >= minWinRate && pnlSol >= minPnlSol) filtered.push(w);
      } catch {
        // skip wallets we can't score
      }
      await sleep(1000); // respect GMGN ~20/s burst limit (weight varies per route)
    }
    wallets = filtered;
  }

  return wallets;
}

// Query gmgn portfolio stats for a single wallet (used for PnL/WR filtering).
function queryWalletStats(address, chain) {
  return new Promise((resolve, reject) => {
    const proc = spawn('gmgn-cli', ['portfolio', 'stats', '--chain', chain, '--wallet', address, '--raw'], { env: process.env });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`stats exited ${code}: ${err.slice(0, 120)}`));
      try { resolve(JSON.parse(out.trim())); } catch (e) { reject(e); }
    });
  });
}

// Insert GMGN smart-money wallets into saved_wallets (used by candidate scoring).
// Manual only — call from a Telegram command.
export async function importGmgnSmartWallets(opts) {
  const wallets = await fetchGmgnSmartWallets(opts);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)'
  );
  let count = 0;
  const ts = now();
  for (const w of wallets) {
    const label = `gmgn_smart|${w.tags}`;
    insert.run(label, w.address, ts);
    count++;
  }
  return { fetched: wallets.length, inserted: count, total: savedWallets().length };
}

export async function fetchWalletPnl(address) {
  try {
    const url = `https://datapi.jup.ag/v1/pnl?addresses=${encodeURIComponent(address)}&includeClosed=false`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.[address] ?? data?.data?.[address] ?? data;
    if (!d || typeof d !== 'object') return null;
    return {
      totalTrades: Number(d.totalTrades ?? d.total_trades ?? 0),
      wins: Number(d.wins ?? d.winCount ?? d.win_count ?? 0),
      winRate: Number(d.winRate ?? d.win_rate ?? 0),
      totalPnlPercent: Number(d.totalPnlPercent ?? d.total_pnl_percent ?? d.totalPnlUsd ?? 0),
    };
  } catch {
    return null;
  }
}
