import Database from 'better-sqlite3';
import { fetchTokenSpotViaQuote, fetchJupiterAsset } from '../src/enrichment/jupiter.js';
import { DB_PATH } from '../src/config.js';

const db = new Database(DB_PATH);
const row = db.prepare(`
  SELECT mint, entry_price, entry_mcap, symbol FROM dry_run_positions
  WHERE status = 'closed' AND mint IS NOT NULL
  ORDER BY id DESC LIMIT 1
`).get();
db.close();

if (!row) {
  console.error('No closed positions found');
  process.exit(1);
}

console.log(`Token: ${row.symbol} (${row.mint})`);
console.log(`Entry: $${row.entry_price}  mcap: $${row.entry_mcap}`);

const [quotePrice, asset] = await Promise.all([
  fetchTokenSpotViaQuote(row.mint),
  fetchJupiterAsset(row.mint, { useCache: false }),
]);

const assetPrice = Number(asset?.usdPrice);
console.log(`\nQuote API price:   ${quotePrice != null ? `$${quotePrice.toFixed(10)}` : 'null'}`);
console.log(`Asset API price:  ${Number.isFinite(assetPrice) ? `$${assetPrice.toFixed(10)}` : 'null'}`);

if (quotePrice == null || !Number.isFinite(assetPrice) || assetPrice <= 0) {
  console.error('One or both prices unavailable — cannot assert divergence');
  process.exit(1);
}

const divergence = Math.abs(quotePrice - assetPrice) / assetPrice * 100;
console.log(`Divergence: ${divergence.toFixed(4)}%  (threshold: <15%)`);

if (divergence >= 15) {
  console.error(`FAIL: divergence ${divergence.toFixed(2)}% exceeds 15%`);
  process.exit(1);
}

console.log('PASS');
process.exit(0);
