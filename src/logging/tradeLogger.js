/**
 * src/logging/tradeLogger.js — Trade Journal & Bot Logger
 * =========================================================
 * Two outputs:
 *   1. logs/trades.csv  — machine-readable trade journal (one row per closed trade)
 *   2. logs/bot.log     — structured text log via winston
 *
 * The CSV enables importing into Excel/Google Sheets for:
 *   - Win rate, profit factor, average R:R calculation
 *   - Per-signal-reason performance breakdown
 *   - Drawdown analysis
 */

import { createObjectCsvWriter } from 'csv-writer';
import { createReadStream, existsSync, mkdirSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import winston from 'winston';
import CFG from '../../config.js';

// ── Winston Logger Setup ──────────────────────────────────────────────────────

const { combine, timestamp, colorize, printf, errors } = winston.format;

const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`),
);

const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack }) =>
    stack ? `${timestamp} [${level.toUpperCase()}] ${message}\n${stack}`
          : `${timestamp} [${level.toUpperCase()}] ${message}`
  ),
);

export function setupLogging() {
  mkdirSync(CFG.log.logDir, { recursive: true });

  const logger = winston.createLogger({
    level      : CFG.log.logLevel,
    transports : [
      new winston.transports.Console({ format: consoleFormat }),
      new winston.transports.File({
        filename : CFG.log.botLogFile,
        format   : fileFormat,
        level    : 'debug',
      }),
    ],
  });

  return logger;
}

// ── Trade Journal (CSV) ───────────────────────────────────────────────────────

const CSV_HEADERS = [
  { id: 'timestampOpen',  title: 'timestamp_open'  },
  { id: 'timestampClose', title: 'timestamp_close' },
  { id: 'direction',      title: 'direction'        },
  { id: 'entry',          title: 'entry'            },
  { id: 'stopLoss',       title: 'stop_loss'        },
  { id: 'takeProfit',     title: 'take_profit'      },
  { id: 'exitPrice',      title: 'exit_price'       },
  { id: 'units',          title: 'units'            },
  { id: 'pnlUsd',         title: 'pnl_usd'          },
  { id: 'pnlPct',         title: 'pnl_pct'          },
  { id: 'rrAchieved',     title: 'rr_achieved'      },
  { id: 'reasonOpen',     title: 'reason_open'      },
  { id: 'reasonClose',    title: 'reason_close'     },
  { id: 'score',          title: 'score'            },
  { id: 'minRr',          title: 'min_rr'           },
  { id: 'atr',            title: 'atr'              },
  { id: 'equityBefore',   title: 'equity_before'    },
];

export class TradeJournal {
  constructor() {
    mkdirSync(CFG.log.logDir, { recursive: true });
    this._path   = CFG.log.tradeLogCsv;
    // append: true — keeps existing rows when the bot restarts
    this._writer = createObjectCsvWriter({
      path    : this._path,
      header  : CSV_HEADERS,
      append  : true,
    });
  }

  /**
   * Append one completed trade to the CSV.
   *
   * @param {Signal}  signal
   * @param {number}  exitPrice
   * @param {number}  units
   * @param {number}  equityBefore   Account equity at trade entry
   * @param {string}  reasonClose    'take_profit' | 'stop_loss' | 'trailing_stop' | 'manual'
   * @param {Date}    [timestampClose]
   */
  async logTrade(signal, exitPrice, units, equityBefore, reasonClose, timestampClose = new Date()) {
    const pnlUsd = signal.direction === 'buy'
      ? (exitPrice - signal.entryPrice) * units
      : (signal.entryPrice - exitPrice) * units;

    const pnlPct      = equityBefore > 0 ? (pnlUsd / equityBefore) * 100 : 0;
    const initialRisk = Math.abs(signal.entryPrice - signal.stopLoss) * units;
    const rrAchieved  = initialRisk > 0 ? pnlUsd / initialRisk : 0;

    const row = {
      timestampOpen  : signal.timestamp.toISOString(),
      timestampClose : timestampClose.toISOString(),
      direction      : signal.direction,
      entry          : signal.entryPrice,
      stopLoss       : signal.stopLoss,
      takeProfit     : signal.takeProfit,
      exitPrice      : r2(exitPrice),
      units,
      pnlUsd         : r2(pnlUsd),
      pnlPct         : r4(pnlPct),
      rrAchieved     : r2(rrAchieved),
      reasonOpen     : signal.reasons.join(' | '),
      reasonClose,
      score          : signal.score,
      minRr          : CFG.strategy.minRrRatio,
      atr            : signal.atr,
      equityBefore   : r2(equityBefore),
    };

    await this._writer.writeRecords([row]);

    const icon = pnlUsd >= 0 ? '✓' : '✗';
    console.info(
      `${icon} TRADE CLOSED | ${signal.direction.toUpperCase()} | ` +
      `Entry: ${signal.entryPrice} | Exit: ${exitPrice} | ` +
      `P/L: $${r2(pnlUsd)} (${r2(pnlPct)}%) | ` +
      `R:R: ${r2(rrAchieved)} | ${reasonClose}`
    );
  }

  /**
   * Read the CSV and compute aggregate performance statistics.
   * @returns {Object|null}
   */
  getSummaryStats() {
    if (!existsSync(this._path)) return null;
    try {
      const content = readFileSync(this._path, 'utf8');
      const rows    = parse(content, { columns: true, skip_empty_lines: true });
      if (!rows.length) return null;

      const pnls = rows.map(r => parseFloat(r.pnl_usd));
      const wins = pnls.filter(p => p > 0);
      const loss = pnls.filter(p => p <= 0);

      return {
        totalTrades    : rows.length,
        winners        : wins.length,
        losers         : loss.length,
        winRate        : r2(wins.length / rows.length * 100),
        totalPnlUsd    : r2(pnls.reduce((a, b) => a + b, 0)),
        avgWinUsd      : wins.length ? r2(wins.reduce((a,b) => a+b, 0) / wins.length) : 0,
        avgLossUsd     : loss.length ? r2(loss.reduce((a,b) => a+b, 0) / loss.length) : 0,
        profitFactor   : loss.length && loss.reduce((a,b)=>a+b,0) !== 0
          ? r2(wins.reduce((a,b)=>a+b,0) / Math.abs(loss.reduce((a,b)=>a+b,0)))
          : Infinity,
        avgRrAchieved  : r2(rows.map(r => parseFloat(r.rr_achieved)).reduce((a,b)=>a+b,0) / rows.length),
        bestTradeUsd   : r2(Math.max(...pnls)),
        worstTradeUsd  : r2(Math.min(...pnls)),
      };
    } catch {
      return null;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 10000) / 10000;
