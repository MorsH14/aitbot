/**
 * resample-m1-to-m5.js — Convert Histdata M1 CSV to M5 CSV
 *
 * Usage:
 *   node resample-m1-to-m5.js <file1.csv> [file2.csv ...]
 *
 * Supported Histdata formats (auto-detected):
 *   Format A (standard):  20230102 000100,2063.45,2064.12,2062.89,2063.78,1234
 *   Format B (MT/MS):     XAUUSD,202601011800,2063.45,2064.12,2062.89,2063.78,0
 *   Format C (MT):        2026.02.01,18:06,2063.45,2064.12,2062.89,2063.78,0
 *
 * Output: data/historical/XAUUSD_M5.csv
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const inputPaths = process.argv.slice(2);
if (!inputPaths.length) {
  console.error('Usage: node resample-m1-to-m5.js <file1.csv> [file2.csv ...]');
  process.exit(1);
}

const OUT     = 'data/historical/XAUUSD_M5.csv';
const buckets = new Map();
let totalLines = 0;

for (const inputPath of inputPaths) {
  console.log(`Reading ${inputPath}...`);
  const lines = readFileSync(inputPath, 'utf8').trim().split('\n');
  totalLines += lines.length;
  processLines(lines);
}

function processLines(lines) {
  for (const line of lines) {
    const parts = line.trim().split(',');
    if (parts.length < 5) continue;

    let y, mo, d, hh, mm, oIdx;

    // Auto-detect format:
    //   Format B: first column is non-numeric (symbol like "XAUUSD")
    //   Format C: first column has dots (2026.02.01), second has colon time (18:06)
    //   Format A: first column starts with digit + space separator (20230102 000100)
    if (isNaN(parts[0][0])) {
      // Format B: XAUUSD,202601011800,o,h,l,c,v
      const dt = parts[1].trim();   // "202601011800" (12 chars)
      y  = dt.slice(0, 4);
      mo = dt.slice(4, 6);
      d  = dt.slice(6, 8);
      hh = dt.slice(8, 10);
      mm = dt.slice(10, 12);
      oIdx = 2;
    } else if (parts[0].includes('.')) {
      // Format C: 2026.02.01,18:06,o,h,l,c,v  (MT format)
      [y, mo, d] = parts[0].split('.');
      [hh, mm]   = parts[1].split(':');
      oIdx = 2;
    } else {
      // Format A: "20230102 000100",o,h,l,c,v
      const [datePart, timePart] = parts[0].split(' ');
      y  = datePart.slice(0, 4);
      mo = datePart.slice(4, 6);
      d  = datePart.slice(6, 8);
      hh = timePart.slice(0, 2);
      mm = timePart.slice(2, 4);
      oIdx = 1;
    }

    const slot = Math.floor(parseInt(mm, 10) / 5) * 5;
    const key  = `${y}-${mo}-${d} ${hh}:${String(slot).padStart(2, '0')}:00`;

    const o = parseFloat(parts[oIdx]);
    const h = parseFloat(parts[oIdx + 1]);
    const l = parseFloat(parts[oIdx + 2]);
    const c = parseFloat(parts[oIdx + 3]);
    const v = parseInt(parts[oIdx + 4] ?? '0', 10);

    if (!buckets.has(key)) {
      buckets.set(key, { time: key, open: o, high: h, low: l, close: c, volume: v });
    } else {
      const b = buckets.get(key);
      b.high   = Math.max(b.high, h);
      b.low    = Math.min(b.low, l);
      b.close  = c;
      b.volume += v;
    }
  }
}

const sorted = [...buckets.values()].sort((a, b) => a.time.localeCompare(b.time));
mkdirSync('data/historical', { recursive: true });

const header = 'time,open,high,low,close,volume';
const rows   = sorted.map(b => `${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}`);
writeFileSync(OUT, [header, ...rows].join('\n'), 'utf8');
console.log(`Resampled ${totalLines} M1 bars → ${sorted.length} M5 bars`);
console.log(`Date range: ${sorted[0].time.slice(0, 10)} → ${sorted.at(-1).time.slice(0, 10)}`);
console.log(`Saved to ${OUT}`);
console.log('Run backtest with: node main.js --backtest');
