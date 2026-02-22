/**
 * main.js — XAU/USD Scalping Bot Entry Point
 * ===========================================
 * Supports two modes via CLI flags:
 *
 *   node main.js                     → Live / paper trade (requires .env)
 *   node main.js --backtest          → Backtest on historical CSV
 *   node main.js --backtest --mock   → Backtest on synthetic data (no files needed)
 *
 * Live loop interval: 60 seconds (checks once per completed candle slot)
 */

import { program }     from 'commander';
import CFG             from './config.js';
import { setupLogging, TradeJournal } from './src/logging/tradeLogger.js';
import { MetaApiDataFetcher, MockDataFetcher } from './src/data/fetcher.js';
import { NewsFilter }  from './src/data/newsFilter.js';
import { addAllIndicators } from './src/indicators/technical.js';
import { SignalGenerator, formatSignal } from './src/strategy/signals.js';
import { RiskManager } from './src/risk/manager.js';
import { TradeExecutor } from './src/execution/trader.js';
import { BacktestEngine } from './src/backtest/engine.js';

const BOT_VERSION      = '1.0.0';
const LOOP_INTERVAL_MS = 60_000;  // 60 seconds

// ── CLI ───────────────────────────────────────────────────────────────────────

program
  .name('xauusd-bot')
  .description('Automated XAU/USD scalping bot')
  .option('--backtest', 'Run backtesting mode instead of live trading')
  .option('--mock',     'Use synthetic data (no MetaAPI connection required)')
  .parse(process.argv);

const opts = program.opts();

// ── Entry Point ───────────────────────────────────────────────────────────────

const logger = setupLogging();

logger.info('='.repeat(60));
logger.info(`  XAU/USD Scalping Bot v${BOT_VERSION}`);
logger.info(`  Mode: ${opts.backtest ? 'BACKTEST' : (opts.mock ? 'PAPER (mock)' : CFG.broker.accountType.toUpperCase())}`);
logger.info(`  Account: ${CFG.broker.metaapiAccountId || 'not configured'}`);
logger.info('='.repeat(60));

if (opts.backtest) {
  await runBacktest(opts.mock);
} else {
  await runLive(opts.mock);
}

// ── Live / Paper Trading Loop ─────────────────────────────────────────────────

async function runLive(mock = false) {
  // Validate credentials for live/paper mode
  if (!mock && (!CFG.broker.metaapiToken || !CFG.broker.metaapiAccountId)) {
    logger.error('METAAPI_TOKEN and METAAPI_ACCOUNT_ID must be set in .env');
    logger.error('Run with --backtest --mock to test without credentials.');
    process.exit(1);
  }

  // Initialise fetcher (MetaAPI connection or mock)
  const fetcher = mock ? new MockDataFetcher() : new MetaApiDataFetcher();
  await fetcher.init();  // Establishes MT5 connection (or no-op for mock)

  const newsFilter = new NewsFilter();
  const signalGen  = new SignalGenerator();
  const journal    = new TradeJournal();

  // Get starting equity from broker
  const accountData   = await fetcher.getAccountSummary();
  const initialEquity = parseFloat(accountData.balance ?? accountData.equity ?? CFG.backtest.initialEquity);
  logger.info(`Starting equity: $${initialEquity.toFixed(2)}`);

  const riskMgr  = new RiskManager(initialEquity);
  // Pass the MetaAPI connection to the executor for order placement
  const executor = new TradeExecutor(riskMgr, fetcher._conn ?? null);

  logger.info(`Bot running. Loop interval: ${LOOP_INTERVAL_MS / 1000}s`);

  // Refresh news calendar once on startup
  await newsFilter.refreshCalendar();

  let iteration = 0;

  const loop = async () => {
    iteration++;
    const now = new Date();
    logger.debug(`─── Loop #${iteration} @ ${now.toISOString()} ───`);

    try {
      // ── A. Update equity from broker ───────────────────────────────────────
      if (!mock) {
        try {
          const acct = await fetcher.getAccountSummary();
          riskMgr.updateEquity(parseFloat(acct.balance ?? acct.equity ?? riskMgr.equity));
        } catch (e) {
          logger.warn(`Could not fetch account summary: ${e.message}`);
        }
      }

      // ── B. Refresh news calendar (cached, so this is a no-op most of the time)
      await newsFilter.refreshCalendar();

      // ── C. News / session blackout check ──────────────────────────────────
      if (newsFilter.isNewsBlackout(now)) {
        const upcoming = newsFilter.getUpcomingEvents(2);
        if (upcoming.length) {
          logger.info(`BLACKOUT — upcoming events: ${upcoming.map(e => e.title).join(', ')}`);
        } else {
          logger.debug('Outside session or near recurring event — skipping.');
        }
        return; // Skip this iteration
      }

      // ── D. Fetch candles ───────────────────────────────────────────────────
      let m15Candles, h1Candles;
      try {
        [m15Candles, h1Candles] = await Promise.all([
          fetcher.getCandles(CFG.timeframe.signalTf, CFG.timeframe.lookback),
          fetcher.getCandles(CFG.timeframe.trendTf,  Math.floor(CFG.timeframe.lookback / 4)),
        ]);
      } catch (e) {
        logger.error(`Data fetch failed: ${e.message}`);
        return;
      }

      if (!m15Candles.length || !h1Candles.length) {
        logger.warn('Empty candle data received.');
        return;
      }

      // ── E. Enrich with indicators ──────────────────────────────────────────
      const m15 = addAllIndicators(m15Candles);
      const h1  = addAllIndicators(h1Candles);

      const latestBar   = m15.at(-1);
      const currentPrice = latestBar.close;
      const currentAtr   = latestBar.atr ?? 1.0;
      const h1Trend      = h1.at(-1)?.trendDir ?? 0;
      const trendLabel   = { 1: 'BULL', '-1': 'BEAR', 0: 'NEUTRAL' }[h1Trend] ?? '?';

      logger.debug(`XAU/USD: ${currentPrice} | ATR: ${currentAtr?.toFixed(2)} | H1: ${trendLabel}`);

      // ── F. Manage open trades (trailing stops) ─────────────────────────────
      const openTrades = await fetcher.getOpenTrades();
      if (openTrades.length) {
        await executor.updateTrailingStops(openTrades, currentPrice, currentAtr);
        logger.debug(`${openTrades.length} open trade(s) — trailing stop checked.`);
      }

      // ── G. Risk gate ───────────────────────────────────────────────────────
      const { allowed, reason } = riskMgr.canTrade(openTrades.length);
      if (!allowed) {
        const s = riskMgr.summary();
        logger.info(
          `RISK BLOCK: ${reason} | equity=$${s.equity} | daily_pnl=$${s.dailyPnl} | ` +
          `trades=${s.tradesToday} | drawdown=${s.drawdownPct}%`
        );
        return;
      }

      // ── H. Signal evaluation ───────────────────────────────────────────────
      const signal = signalGen.evaluate(m15, h1);
      if (!signal) {
        logger.debug('No signal this bar.');
        return;
      }

      logger.info(`SIGNAL: ${formatSignal(signal)}`);

      // ── I. Place order ─────────────────────────────────────────────────────
      const result = await executor.placeOrder(signal);
      if (!result) {
        logger.warn('Order rejected by executor.');
      }

    } catch (err) {
      logger.error(`Unexpected error in loop: ${err.message}`);
    }
  };

  // Graceful shutdown — also closes MetaAPI connection
  const doShutdown = async () => {
    await fetcher.close();
    shutdown(riskMgr, journal, logger);
  };
  process.on('SIGINT',  doShutdown);
  process.on('SIGTERM', doShutdown);

  // Run immediately, then on interval
  await loop();
  setInterval(loop, LOOP_INTERVAL_MS);
}

// ── Backtest Mode ─────────────────────────────────────────────────────────────

async function runBacktest(mock = false) {
  const dataSource = mock ? 'mock' : 'csv';
  logger.info(`Running backtest | data source: ${dataSource}`);

  const engine  = new BacktestEngine(dataSource);
  const results = await engine.run();
  engine.plotAscii(results);
  engine.saveResults(results);
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

function shutdown(riskMgr, journal, logger) {
  logger.info('Shutdown signal received.');
  const s     = riskMgr.summary();
  const stats = journal.getSummaryStats();

  logger.info(
    `Session: equity=$${s.equity} | daily_pnl=$${s.dailyPnl} | trades=${s.tradesToday}`
  );
  if (stats) {
    logger.info(
      `All-time: ${stats.totalTrades} trades | WR ${stats.winRate}% | ` +
      `P/L $${stats.totalPnlUsd} | PF ${stats.profitFactor}`
    );
  }
  logger.info('Bot stopped cleanly.');
  process.exit(0);
}
