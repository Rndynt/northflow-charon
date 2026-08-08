import { escapeHtml, fmtPct, fmtSol } from '../format.js';
import { formatWindow } from '../utils.js';

export function learningReportText(runId, summary, lessons) {
  const p = summary.positions;
  const winRate = p.winRate != null ? fmtPct(p.winRate) : 'n/a';
  const avgPnl = p.avgPnlPercent != null ? fmtPct(p.avgPnlPercent) : 'n/a';
  // Total PnL% is the meaningful aggregate for dry-run (SOL is often null in dry mode)
  const totalPnlPct = typeof p.totalPnlPercent === 'number' ? `${p.totalPnlPercent >= 0 ? '+' : ''}${p.totalPnlPercent.toFixed(1)}%` : 'n/a';
  const solNote = (p.totalPnlSol && Math.abs(p.totalPnlSol) > 0)
    ? ` · ${p.totalPnlSol >= 0 ? '+' : ''}${fmtSol(p.totalPnlSol)} SOL`
    : '';

  const lines = [
    '🧠 <b>Charon Learning</b>',
    `Run: #${runId} · Window: ${formatWindow(summary.windowMs)}`,
    `Closed: ${p.closed}/${p.opened} · Win rate: <b>${winRate}</b>`,
    `Avg PnL: ${avgPnl} · Total PnL: <b>${totalPnlPct}</b>${solNote}`,
    '',
    '<b>By Route</b>',
  ];

  // Full route breakdown (sorted by total PnL%, green/red by sign)
  if (p.byRoute?.length) {
    for (const r of p.byRoute) {
      const wr = r.winRate != null ? `${r.winRate.toFixed(0)}%` : '-';
      const pnl = `${r.pnlPercent >= 0 ? '+' : ''}${r.pnlPercent.toFixed(1)}%`;
      const emoji = r.pnlPercent >= 0 ? '🟢' : '🔴';
      lines.push(`${emoji} ${escapeHtml(r.route)}\nn: ${r.count} · WR ${wr} · <b>${pnl}</b>`);
    }
  } else {
    lines.push('(no closed trades in window)');
  }

  lines.push('');
  lines.push(`<b>By Exit Reason</b> (${p.closed} closed)`);
  if (p.byReason?.length) {
    for (const r of p.byReason) {
      lines.push(`${escapeHtml(r.reason)}: ${r.count} (${r.ratio.toFixed(1)}%)`);
    }
  } else {
    lines.push('(no closed trades in window)');
  }

  lines.push('');
  lines.push('<b>Lessons</b>');
  if (lessons?.length) {
    lines.push(...lessons.map((item, index) => `${index + 1}. ${escapeHtml(item.lesson)}`));
  } else {
    lines.push('(no lessons generated)');
  }

  return lines.join('\n');
}
