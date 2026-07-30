import { generateExitCard } from '../src/visuals/exitCard.js';
import { writeFileSync, readFileSync } from 'node:fs';

function verifyPng(path) {
  const buf = readFileSync(path);
  const sig = buf.subarray(0, 8);
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!sig.equals(expected)) {
    return { ok: false, reason: 'bad signature' };
  }
  if (buf.length < 24) return { ok: false, reason: 'too small' };
  // IHDR chunk: bytes 8-11 length, 12-15 'IHDR', 16-19 width, 20-23 height
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return { ok: false, reason: 'no IHDR' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  // IEND: the last 12 bytes are [len=0][IEND][CRC], so the type is at len-8..len-4
  if (buf.toString('ascii', buf.length - 8, buf.length - 4) !== 'IEND') {
    return { ok: false, reason: 'no IEND' };
  }
  return { ok: true, bytes: buf.length, width, height, bitDepth, colorType };
}

const cases = [
  {
    name: 'profit',
    out: '/tmp/test_exit_card.png',
    pos: {
      id: 142, symbol: 'WIF',
      mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzL7xdM3jcqWif',
      size_sol: 0.1, pnl_sol: 0.0342, pnl_percent: 34.2,
      entry_mcap: 18500, exit_mcap: 24830,
      exit_reason: 'TRAILING_TP', execution_mode: 'live', strategy_id: 'sniper',
      opened_at_ms: Date.now() - 1000 * 60 * 47, closed_at_ms: Date.now(),
    },
  },
  {
    name: 'loss',
    out: '/tmp/test_exit_card_loss.png',
    pos: {
      id: 143, symbol: 'BONK',
      mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      size_sol: 0.05, pnl_sol: -0.0125, pnl_percent: -25.0,
      entry_mcap: 42000, exit_mcap: 31500,
      exit_reason: 'SL', execution_mode: 'dry_run', strategy_id: 'sniper',
      opened_at_ms: Date.now() - 1000 * 60 * 60 * 3, closed_at_ms: Date.now(),
    },
  },
  {
    name: 'rug',
    out: '/tmp/test_exit_card_rug.png',
    pos: {
      id: 144, symbol: 'RUGG',
      mint: 'RUGGdoNcDkKqKgYxqUJf4gZ1kLb3mNoPqRsTuVwXyZ',
      size_sol: 0.1, pnl_sol: -0.0821, pnl_percent: -82.1,
      entry_mcap: 12500, exit_mcap: 2237,
      exit_reason: 'RUG_VELOCITY_FAST', execution_mode: 'live', strategy_id: 'sniper',
      opened_at_ms: Date.now() - 1000 * 60 * 2, closed_at_ms: Date.now(),
    },
  },
];

let allOk = true;
for (const c of cases) {
  const buf = await generateExitCard(c.pos);
  writeFileSync(c.out, buf);
  const v = verifyPng(c.out);
  const tag = v.ok ? 'OK' : 'FAIL';
  console.log(`[${c.name}] ${tag}  ${c.out}  ${v.bytes ?? '?'} bytes  ${v.width}x${v.height}  depth=${v.bitDepth} colorType=${v.colorType}`);
  if (!v.ok) { console.log('  reason:', v.reason); allOk = false; }
}
process.exit(allOk ? 0 : 1);
