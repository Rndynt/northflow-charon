#!/usr/bin/env node
import { sendDailyReport } from '../telegram/dailyReport.js';

sendDailyReport().catch(err => {
  console.error('[dailyReport script] failed:', err);
  process.exit(1);
});
