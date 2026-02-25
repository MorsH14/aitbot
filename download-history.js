/**
 * download-history.js — Fetch XAUUSD M5 history from Deriv and save to CSV
 *
 * Usage:
 *   node download-history.js
 *
 * Requires DERIV_TOKEN and DERIV_APP_ID in your .env (same as the live bot).
 * Deriv allows up to 5000 candles per request. This script fetches multiple
 * batches going back in time to build a longer history.
 *
 * Output: data/historical/XAUUSD_M5.csv
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { DerivClient } from './src/data/derivClient.js';

const SYMBOL      = 'frxXAUUSD';
const GRANULARITY = 300;           // M5 = 300 seconds
const BATCH_SIZE  = 5000;          // Max candles per Deriv request
const BATCHES     = 6;             // 6 × 5000 = 30 000 bars ≈ 104 days of M5
const OUT_PATH    = 'data/historical/XAUUSD_M5.csv';

async function main() {
  const appId = process.env.DERIV_APP_ID ?? '1089';
  const token = process.env.DERIV_TOKEN ?? '';

  if (!token) {
    console.error('ERROR: DERIV_TOKEN not set in .env');
    console.error('Get a token at: app.deriv.com → Settings → Security → API Token');
    process.exit(1);
  }

  console.log(`Connecting to Deriv (app_id: ${appId})...`);
  const client = new DerivClient(appId, token);
  await client.connect();
  console.log('Connected.\n');

  const allCandles = new Map(); // epoch → candle, deduplication
  let endEpoch     = 'latest';

  for (let batch = 1; batch <= BATCHES; batch++) {
    const req = {
      ticks_history  : SYMBOL,
      style          : 'candles',
      granularity    : GRANULARITY,
      end            : endEpoch,
      count          : BATCH_SIZE,
      adjust_start_time: 1,
    };

    process.stdout.write(`Fetching batch ${batch}/${BATCHES}...`);
    const res = await client.send(req);

    if (res.error) {
      console.error('\nDeriv error:', res.error.message);
      break;
    }

    const candles = res.candles ?? [];
    if (!candles.length) { console.log(' empty, stopping.'); break; }

    candles.forEach(c => allCandles.set(c.epoch, c));
    endEpoch = candles[0].epoch - 1;   // next batch ends just before this one

    console.log(` ${candles.length} candles (oldest: ${new Date(candles[0].epoch * 1000).toISOString().slice(0, 16)})`);
    await sleep(500); // be polite to the API
  }

  client.close();

  // Sort oldest-first and write CSV
  const sorted = [...allCandles.values()].sort((a, b) => a.epoch - b.epoch);
  mkdirSync('data/historical', { recursive: true });

  const header = 'time,open,high,low,close,volume';
  const rows   = sorted.map(c =>
    `${new Date(c.epoch * 1000).toISOString().replace('T', ' ').slice(0, 19)},${c.open},${c.high},${c.low},${c.close},0`
  );

  writeFileSync(OUT_PATH, [header, ...rows].join('\n'), 'utf8');
  console.log(`\nSaved ${sorted.length} candles to ${OUT_PATH}`);
  console.log(`Date range: ${new Date(sorted[0].epoch * 1000).toISOString().slice(0, 10)} → ${new Date(sorted.at(-1).epoch * 1000).toISOString().slice(0, 10)}`);
  console.log('\nRun backtest with: node main.js --backtest');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
main().catch(err => { console.error(err); process.exit(1); });
