/**
 * config.js — Centralised configuration for the XAU/USD Scalping Bot
 * ===================================================================
 * Broker: Deriv.com (free WebSocket API, works in Nigeria & worldwide)
 * Signal TF: M5 | Trend TF: M15
 *
 * Usage:
 *   import CFG from './config.js';
 */

import 'dotenv/config';

// ── Broker / Deriv ────────────────────────────────────────────────────────────

const broker = {
  // Deriv app_id — use '1089' for demo/testing
  // Register your own free app at https://api.deriv.com/ for production
  appId : process.env.DERIV_APP_ID ?? '1089',

  // Deriv API token — from https://app.deriv.com/ → Account Settings → Security → API Token
  // Create a token with "Trade" and "Read" scope
  derivToken : process.env.DERIV_TOKEN ?? '',

  // 'demo' or 'real' — informational; Deriv uses the token's account type automatically
  accountType : process.env.ACCOUNT_TYPE ?? 'demo',
};

// ── Instrument ────────────────────────────────────────────────────────────────

const instrument = {
  // Deriv symbol for XAU/USD — always 'frxXAUUSD'
  symbol : 'frxXAUUSD',

  pricePrecision : 2,

  // Deriv Multiplier value — amplifies the price move
  // Available: 10, 20, 30, 40, 50, 100, 200, 500
  // Higher = more leverage = higher P/L per $ stake
  multiplier : parseInt(process.env.DERIV_MULTIPLIER ?? '100', 10),

  // Minimum stake in USD (Deriv's minimum is $1)
  minStake : 1.0,

  // Maximum stake in USD — Deriv hard limit for frxXAUUSD Multipliers
  maxStake : 2000.0,
};

// ── Timeframes ────────────────────────────────────────────────────────────────
// Deriv uses: '1m','3m','5m','10m','15m','30m','1h','4h','1d'

const timeframe = {
  signalTf : '5m',   // M5  — where signals fire (scalping TF)
  trendTf  : '15m',  // M15 — trend direction filter
  lookback : 500,    // Candles to fetch for indicator warm-up (extra buffer for weekends)
};

// ── Technical Indicator Parameters ───────────────────────────────────────────

const indicator = {
  // Exponential Moving Averages (H1 trend filter)
  emaFast  : 21,   // Short-term momentum
  emaSlow  : 50,   // Medium-term trend
  emaTrend : 100,  // Macro direction filter (100 bars on M5 = ~8h of trend context)

  // RSI — momentum / overbought-oversold
  rsiPeriod      : 14,
  rsiOverbought  : 65.0,  // Tighter than standard 70 for gold volatility
  rsiOversold    : 35.0,  // Tighter than standard 30

  // MACD — momentum confirmation
  macdFast   : 12,
  macdSlow   : 26,
  macdSignal : 9,

  // Stochastic — secondary momentum / crossover
  stochK      : 14,
  stochD      : 3,
  stochSmooth : 3,
  stochOb     : 80.0,
  stochOs     : 20.0,

  // ATR — volatility measurement (drives SL/TP sizing)
  atrPeriod : 14,

  // Bollinger Bands — volatility squeeze / band touch
  bbPeriod : 20,
  bbStd    : 2,

  // Swing high/low detection: number of candles each side of pivot
  swingWindow : 5,
};

// ── Strategy / Signal Rules ───────────────────────────────────────────────────

const strategy = {
  // On M5 candles, ATR is smaller than M15 — adjust thresholds accordingly
  minAtr         : 0.20,  // Min ATR in USD — skip dead markets
  maxAtr         : 20.0,  // Max ATR in USD — skip extreme news spikes (Gold M5 ATR ~2–12 normal)
  minSignalScore : 3,     // Minimum confluence score (out of 5)
  minRrRatio     : 1.8,   // Minimum Risk:Reward ratio
  slAtrMult      : 1.5,   // Stop-loss = ATR × this
  tpSlMult       : 2.0,   // Take-profit = SL_distance × this (2:1 R:R)
};

// ── Risk Management ───────────────────────────────────────────────────────────

const risk = {
  maxRiskPct           : 1.0,    // Max % of equity risked per trade
  maxRiskUsd           : 200.0,  // Hard USD cap per trade
  maxOpenTrades        : 2,      // Max simultaneous positions
  maxDailyDrawdownPct  : 3.0,    // Daily drawdown % limit — bot pauses if breached
  maxDailyLossUsd      : 500.0,  // Hard USD daily loss limit

  // Trailing stop: activates when profit reaches X × ATR
  trailingSlActivationMult : 1.0,
  trailingSlDistanceMult   : 0.8,
};

// ── News / Macro Filter ───────────────────────────────────────────────────────

const news = {
  blackoutBeforeMins : 30,   // Minutes to avoid trading BEFORE a high-impact event
  blackoutAfterMins  : 30,   // Minutes to avoid trading AFTER a high-impact event
  watchCurrencies    : ['USD', 'XAU'],
  sessionStartUtc    : 7,    // 07:00 UTC — London open
  sessionEndUtc      : 20,   // 20:00 UTC — NY close
};

// ── Logging ───────────────────────────────────────────────────────────────────

const log = {
  logDir       : 'logs',
  tradeLogCsv  : 'logs/trades.csv',
  botLogFile   : 'logs/bot.log',
  logLevel     : process.env.LOG_LEVEL ?? 'info',
};

// ── Backtest ──────────────────────────────────────────────────────────────────

const backtest = {
  dataPath      : 'data/historical/XAUUSD_M5.csv',  // M5 data for backtest
  initialEquity : 10_000.0,
  spread        : 0.25,  // Simulated spread in USD
  commission    : 2.0,   // Round-trip commission per trade (USD)
};

// ── Export ────────────────────────────────────────────────────────────────────

const CFG = { broker, instrument, timeframe, indicator, strategy, risk, news, log, backtest };
export default CFG;
