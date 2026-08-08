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

// Pull the active smart-money trade feed from GMGN via the official gmgn-cli and return the
// unique wallet addresses seen trading (with their tag labels). Manual trigger only — no auto-run.
// Requires gmgn-cli installed globally and GMGN_API_KEY / GMGN_PRIVATE_KEY set in the environment.
export async function fetchGmgnSmartWallets({ limit = 100, chain = 'sol' } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['track', 'smartmoney', '--chain', chain, '--limit', String(limit), '--raw'];
    const proc = spawn('gmgn-cli', args, { env: process.env });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`gmgn-cli exited ${code}: ${err.slice(0, 200)}`));
      try {
        const parsed = JSON.parse(out.trim());
        const list = parsed?.list || parsed?.data?.list || [];
        const seen = new Map();
        for (const t of list) {
          const addr = t.maker || t.wallet || t.address;
          if (!addr || seen.has(addr)) continue;
          const tags = (t.maker_info?.tags || []).join(',');
          seen.set(addr, tags);
        }
        resolve([...seen.entries()].map(([address, tags]) => ({ address, tags })));
      } catch (e) {
        reject(new Error(`parse failed: ${e.message} raw=${out.slice(0, 120)}`));
      }
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
