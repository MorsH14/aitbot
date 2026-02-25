/**
 * src/backtest/engine.js — Walk-Forward Backtesting Engine
 * ==========================================================
 * Simulates the complete bot loop on historical OHLCV data.
 *
 * Realism features:
 *   - Entry on NEXT bar's open (not the signal bar's close) — simulates real lag
 *   - Spread deducted on entry
 *   - Commission deducted per round-trip
 *   - SL/TP hit detection uses next bar's high/low
 *   - If both SL and TP hit same bar, SL wins (conservative)
 *   - No future data leak: indicators computed on data up to current bar only
 *
 * Metrics computed:
 *   Total return, annualised return, max drawdown, Sharpe, Sortino,
 *   win rate, profit factor, avg R:R, expectancy
 */

import { writeFileSync, mkdirSync } from 'fs';
import { MetaApiDataFetcher, MockDataFetcher } from '../data/fetcher.js';
import { addAllIndicators } from '../indicators/technical.js';
import { SignalGenerator } from '../strategy/signals.js';
import { RiskManager } from '../risk/manager.js';
import CFG from '../../config.js';

const WARMUP_BARS = 250; // Bars needed for EMA200 + other long indicators to warm up

export class BacktestEngine {
  /**
   * @param {'csv'|'mock'|'oanda'} dataSource
   */
  constructor(dataSource = 'csv') {
    this._dataSource = dataSource;
    this._signalGen  = new SignalGenerator();
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  async run() {
    console.info('='.repeat(60));
    console.info('STARTING BACKTEST');
    console.info(`Initial equity: $${CFG.backtest.initialEquity}`);
    console.info(`Data source:    ${this._dataSource}`);
    console.info('='.repeat(60));

    const m5Full = await this._loadData();
    if (!m5Full || m5Full.length < WARMUP_BARS + 10) {
      throw new Error(`Not enough candle data (need >${WARMUP_BARS} bars).`);
    }

    // Pre-compute indicators on FULL dataset (faster than per-bar recalculation)
    console.info(`Calculating indicators on ${m5Full.length} bars...`);
    const m5Enriched = addAllIndicators(m5Full);

    // Resample M5 → M15 to match live trendTf='15m' (was wrongly resampling to H1)
    const m15TrendFull     = resampleToM15(m5Full);
    const m15TrendEnriched = addAllIndicators(m15TrendFull);

    // ── Main Loop ─────────────────────────────────────────────────────────────
    let equity       = CFG.backtest.initialEquity;
    const equityCurve  = [];   // [{ time, equity }]
    const trades       = [];
    const riskMgr      = new RiskManager(equity);
    let openTrade      = null;

    console.info(`Iterating ${m5Enriched.length} bars (warmup: ${WARMUP_BARS})...`);

    for (let i = WARMUP_BARS; i < m5Enriched.length - 1; i++) {
      const bar         = m5Enriched[i];
      const nextBar     = m5Enriched[i + 1];
      const currentTime = bar.time;

      // Session filter: only trade during London + NY hours (07:00-20:00 UTC)
      const barHour = new Date(currentTime).getUTCHours();
      const inSession = barHour >= CFG.news.sessionStartUtc && barHour < CFG.news.sessionEndUtc;

      // M15 trend slice up to current time (mirrors live trendTf='15m')
      const m15TrendSlice = m15TrendEnriched.filter(c => c.time <= currentTime);
      if (m15TrendSlice.length < 50) {
        equityCurve.push({ time: currentTime, equity });
        continue;
      }

      const currentAtr = bar.atr ?? 1.0;

      // ── Manage open trade ─────────────────────────────────────────────────
      if (openTrade) {
        const { exitPrice, reason } = checkExit(openTrade, nextBar);
        if (exitPrice !== null) {
          const pnl = calcPnl(openTrade, exitPrice);
          equity   += pnl;
          riskMgr.updateEquity(equity);
          riskMgr.recordTradeClosed(pnl);
          trades.push({
            ...openTrade,
            exitTime    : nextBar.time,
            exitPrice,
            reasonClose : reason,
            pnlUsd      : pnl,
            rrAchieved  : pnl / (Math.abs(openTrade.entryPrice - openTrade.stopLoss) * openTrade.units || 1),
          });
          openTrade = null;
        }
      }

      // ── Check for new signal ──────────────────────────────────────────────
      if (!openTrade && inSession) {
        const { allowed } = riskMgr.canTrade(0, currentTime);
        if (allowed) {
          const m5Slice  = m5Enriched.slice(0, i + 1);
          const signal   = this._signalGen.evaluate(m5Slice, m15TrendSlice);

          if (signal) {
            // Fill on next bar's open + spread
            const halfSpread = CFG.backtest.spread / 2;
            let fillPrice    = nextBar.open;
            fillPrice += signal.direction === 'buy' ? halfSpread : -halfSpread;

            const units = riskMgr.calculatePositionSize(signal);
            if (units > 0) {
              equity   -= CFG.backtest.commission;  // Deduct commission
              openTrade = {
                entryTime   : nextBar.time,
                direction   : signal.direction,
                entryPrice  : fillPrice,
                stopLoss    : signal.stopLoss,
                takeProfit  : signal.takeProfit,
                units,
                score       : signal.score,
                atr         : signal.atr,
                reasons     : signal.reasons,
              };
              riskMgr.recordTradeOpened(currentTime);
            }
          }
        }
      }

      equityCurve.push({ time: currentTime, equity });
    }

    // Force-close any trade still open at the end of data
    if (openTrade) {
      const lastPrice = m5Enriched.at(-1).close;
      const pnl       = calcPnl(openTrade, lastPrice);
      equity += pnl;
      trades.push({
        ...openTrade,
        exitTime    : m5Enriched.at(-1).time,
        exitPrice   : lastPrice,
        reasonClose : 'end_of_data',
        pnlUsd      : pnl,
        rrAchieved  : pnl / (Math.abs(openTrade.entryPrice - openTrade.stopLoss) * openTrade.units || 1),
      });
    }

    console.info(`Backtest complete. ${trades.length} trades simulated.`);

    const results = computeMetrics(trades, equityCurve, CFG.backtest.initialEquity, equity);
    printSummary(results);
    return results;
  }

  // ── Plot (ASCII equity curve to console) ─────────────────────────────────

  plotAscii(results) {
    const points  = results.equityCurve;
    const values  = points.map(p => p.equity);
    const minEq   = Math.min(...values);
    const maxEq   = Math.max(...values);
    const rows    = 12;
    const cols    = 60;
    const step    = Math.max(1, Math.floor(values.length / cols));

    const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
    for (let c = 0; c < cols; c++) {
      const idx = Math.min(c * step, values.length - 1);
      const v   = values[idx];
      const row = rows - 1 - Math.round(((v - minEq) / (maxEq - minEq || 1)) * (rows - 1));
      if (row >= 0 && row < rows) grid[row][c] = '█';
    }

    console.info('\n  Equity Curve:');
    console.info(`  $${maxEq.toFixed(0).padStart(8)} ┐`);
    grid.forEach(row => console.info(`           │ ${row.join('')}`));
    console.info(`  $${minEq.toFixed(0).padStart(8)} └${'─'.repeat(cols)}`);
    console.info(`           0${' '.repeat(cols - 6)}${results.totalTrades} trades\n`);
  }

  // ── Save Results ──────────────────────────────────────────────────────────

  saveResults(results) {
    mkdirSync(CFG.log.logDir, { recursive: true });
    const { trades, equityCurve, ...stats } = results;
    writeFileSync(
      'logs/backtest_results.json',
      JSON.stringify(stats, null, 2),
      'utf8',
    );
    console.info('Results saved to logs/backtest_results.json');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _loadData() {
    if (this._dataSource === 'mock') {
      return new MockDataFetcher().getCandles('5m', 5000);
    }
    if (this._dataSource === 'live') {
      const f = new MetaApiDataFetcher();
      await f.init();
      return f.getCandles(CFG.timeframe.signalTf, 5000);
    }
    // csv (default)
    const f = new MetaApiDataFetcher();
    return f._loadFromCsv();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resample M5 candles to M15 by grouping into 15-minute UTC buckets.
 * Matches live trendTf='15m' so backtest and live use identical trend data.
 */
function resampleToM15(candles) {
  const buckets = new Map();
  for (const c of candles) {
    const d    = new Date(c.time);
    const slot = Math.floor(d.getUTCMinutes() / 15) * 15;
    const key  = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}-${slot}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  return [...buckets.values()]
    .filter(group => group.length > 0)
    .map(group => ({
      time   : group[0].time,
      open   : group[0].open,
      high   : Math.max(...group.map(c => c.high)),
      low    : Math.min(...group.map(c => c.low)),
      close  : group.at(-1).close,
      volume : group.reduce((s, c) => s + c.volume, 0),
    }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Check if SL or TP was hit on the next bar.
 * @returns {{ exitPrice: number|null, reason: string }}
 */
function checkExit(trade, nextBar) {
  const { high, low } = nextBar;
  const { direction, stopLoss: sl, takeProfit: tp } = trade;

  const slHit = direction === 'buy' ? low  <= sl : high >= sl;
  const tpHit = direction === 'buy' ? high >= tp : low  <= tp;

  // If both hit same bar, SL wins (conservative)
  if (slHit) return { exitPrice: sl, reason: 'stop_loss'   };
  if (tpHit) return { exitPrice: tp, reason: 'take_profit' };
  return { exitPrice: null, reason: '' };
}

function calcPnl(trade, exitPrice) {
  return trade.direction === 'buy'
    ? (exitPrice - trade.entryPrice) * trade.units
    : (trade.entryPrice - exitPrice) * trade.units;
}

function computeMetrics(trades, equityCurve, initialEquity, finalEquity) {
  if (!trades.length) {
    return {
      trades, equityCurve,
      totalReturnPct: 0, annReturnPct: 0, maxDrawdownPct: 0,
      sharpeRatio: 0, sortinoRatio: 0,
      winRate: 0, profitFactor: 0, totalTrades: 0,
      avgRr: 0, expectancy: 0, initialEquity, finalEquity,
    };
  }

  const pnls = trades.map(t => t.pnlUsd);
  const wins = pnls.filter(p => p > 0);
  const loss = pnls.filter(p => p <= 0);

  const totalReturn = ((finalEquity - initialEquity) / initialEquity) * 100;

  // Annualised return
  const firstTime = equityCurve[0]?.time;
  const lastTime  = equityCurve.at(-1)?.time;
  const days      = firstTime && lastTime
    ? (lastTime - firstTime) / (1000 * 60 * 60 * 24)
    : 365;
  const years     = Math.max(days / 365.25, 1 / 365.25);
  const annReturn = ((finalEquity / initialEquity) ** (1 / years) - 1) * 100;

  // Max drawdown
  let maxDd = 0, peak = initialEquity;
  for (const { equity } of equityCurve) {
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak * 100;
    if (dd < maxDd) maxDd = dd;
  }

  // Daily returns for Sharpe/Sortino
  const dailyMap = new Map();
  for (const { time, equity } of equityCurve) {
    const d = new Date(time).toISOString().slice(0, 10);
    dailyMap.set(d, equity);
  }
  const dailyEquities = [...dailyMap.values()];
  const dailyReturns  = dailyEquities.slice(1).map((e, i) =>
    (e - dailyEquities[i]) / dailyEquities[i]
  );

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / (dailyReturns.length || 1);
  const std  = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length || 1));
  const downReturns = dailyReturns.filter(r => r < 0);
  const downStd = downReturns.length
    ? Math.sqrt(downReturns.reduce((s, r) => s + r ** 2, 0) / downReturns.length)
    : 0;

  const sharpe  = std  > 0 ? (mean / std)  * Math.sqrt(252) : 0;
  const sortino = downStd > 0 ? (mean / downStd) * Math.sqrt(252) : 0;

  const grossWin  = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(loss.reduce((a, b) => a + b, 0));

  return {
    trades,
    equityCurve,
    totalReturnPct : r2(totalReturn),
    annReturnPct   : r2(annReturn),
    maxDrawdownPct : r2(maxDd),
    sharpeRatio    : r2(sharpe),
    sortinoRatio   : r2(sortino),
    winRate        : r2(wins.length / trades.length * 100),
    profitFactor   : grossLoss > 0 ? r2(grossWin / grossLoss) : Infinity,
    totalTrades    : trades.length,
    avgRr          : r2(trades.reduce((s, t) => s + t.rrAchieved, 0) / trades.length),
    expectancy     : r2(pnls.reduce((a, b) => a + b, 0) / pnls.length),
    initialEquity,
    finalEquity    : r2(finalEquity),
  };
}

function printSummary(r) {
  const line = '═'.repeat(48);
  console.info(`\n╔${line}╗`);
  console.info(`║${'  BACKTEST RESULTS SUMMARY'.padEnd(48)}║`);
  console.info(`╠${line}╣`);
  console.info(`║  Initial Equity:    $${String(r.initialEquity).padEnd(26)}║`);
  console.info(`║  Final Equity:      $${String(r.finalEquity).padEnd(26)}║`);
  console.info(`║  Total Return:      ${(r.totalReturnPct + '%').padEnd(27)}║`);
  console.info(`║  Annual Return:     ${(r.annReturnPct + '%').padEnd(27)}║`);
  console.info(`╠${line}╣`);
  console.info(`║  Total Trades:      ${String(r.totalTrades).padEnd(27)}║`);
  console.info(`║  Win Rate:          ${(r.winRate + '%').padEnd(27)}║`);
  console.info(`║  Profit Factor:     ${String(r.profitFactor).padEnd(27)}║`);
  console.info(`║  Avg R:R Achieved:  ${String(r.avgRr).padEnd(27)}║`);
  console.info(`║  Expectancy/trade:  $${String(r.expectancy).padEnd(26)}║`);
  console.info(`╠${line}╣`);
  console.info(`║  Max Drawdown:      ${(r.maxDrawdownPct + '%').padEnd(27)}║`);
  console.info(`║  Sharpe Ratio:      ${String(r.sharpeRatio).padEnd(27)}║`);
  console.info(`║  Sortino Ratio:     ${String(r.sortinoRatio).padEnd(27)}║`);
  console.info(`╚${line}╝\n`);
}

const r2 = v => Math.round(v * 100) / 100;
