/**
 * src/indicators/technical.js — Technical Indicator Suite
 * =========================================================
 * Uses the `technicalindicators` npm package — pure JS, no native binaries.
 *
 * All functions accept a candles array:
 *   [{ time, open, high, low, close, volume }, ...]   (oldest first)
 *
 * Returns an enriched copy of the array — each candle gets new fields like
 * emaFast, rsi, macd, stochK, atr, bbUpper, swingHigh, trendDir, etc.
 *
 * See config.js for all period/threshold settings.
 */

import {
  EMA,
  RSI,
  MACD,
  Stochastic,
  ATR,
  BollingerBands,
} from 'technicalindicators';
import CFG from '../../config.js';

const ind = CFG.indicator;

// ── Master Enrichment Function ───────────────────────────────────────────────

/**
 * Enriches all candles with every indicator.
 * Returns a new array — original candles are NOT mutated.
 *
 * @param {Array} candles  Raw OHLCV candle array (oldest first)
 * @returns {Array}        Same candles with indicator fields added
 */
export function addAllIndicators(candles) {
  if (!candles || candles.length < 2) return candles;

  const enriched = candles.map(c => ({ ...c })); // shallow copy

  _addEmas(enriched);
  _addRsi(enriched);
  _addMacd(enriched);
  _addStochastic(enriched);
  _addAtr(enriched);
  _addBollinger(enriched);
  _addSwingPoints(enriched);
  _addTrendDirection(enriched);

  return enriched;
}

// ── Individual Indicator Computations ────────────────────────────────────────

/**
 * EMA 21 / 50 / 200
 * The output array from technicalindicators is shorter than input
 * (it needs `period` bars before producing first value).
 * We right-align by padding the start with null.
 */
function _addEmas(candles) {
  const closes = candles.map(c => c.close);

  const pad = (arr, targetLen) => {
    const padding = new Array(targetLen - arr.length).fill(null);
    return [...padding, ...arr];
  };

  const fastVals  = pad(EMA.calculate({ period: ind.emaFast,  values: closes }), candles.length);
  const slowVals  = pad(EMA.calculate({ period: ind.emaSlow,  values: closes }), candles.length);
  const trendVals = pad(EMA.calculate({ period: ind.emaTrend, values: closes }), candles.length);

  candles.forEach((c, i) => {
    c.emaFast  = fastVals[i];
    c.emaSlow  = slowVals[i];
    c.emaTrend = trendVals[i];
  });
}

/**
 * RSI (14)
 * Also adds rsiSlope (3-bar difference) for divergence detection.
 */
function _addRsi(candles) {
  const closes = candles.map(c => c.close);
  const vals   = RSI.calculate({ period: ind.rsiPeriod, values: closes });
  const padded = _padLeft(vals, candles.length);

  candles.forEach((c, i) => { c.rsi = padded[i]; });

  // RSI slope over 3 bars — positive = accelerating up
  candles.forEach((c, i) => {
    if (i >= 3 && c.rsi != null && candles[i - 3].rsi != null) {
      c.rsiSlope = c.rsi - candles[i - 3].rsi;
    } else {
      c.rsiSlope = null;
    }
  });
}

/**
 * MACD (12/26/9)
 * Adds: macdLine, macdSignal, macdHist
 */
function _addMacd(candles) {
  const closes = candles.map(c => c.close);
  const vals   = MACD.calculate({
    fastPeriod   : ind.macdFast,
    slowPeriod   : ind.macdSlow,
    signalPeriod : ind.macdSignal,
    values       : closes,
    SimpleMAOscillator : false,
    SimpleMASignal     : false,
  });

  // MACD output is shorter — right-align
  const offset = candles.length - vals.length;
  candles.forEach((c, i) => {
    const v = vals[i - offset];
    c.macdLine   = v?.MACD   ?? null;
    c.macdSignal = v?.signal ?? null;
    c.macdHist   = v?.histogram ?? null;
  });
}

/**
 * Stochastic (14/3/3)
 * Adds: stochK, stochD
 */
function _addStochastic(candles) {
  const vals = Stochastic.calculate({
    high   : candles.map(c => c.high),
    low    : candles.map(c => c.low),
    close  : candles.map(c => c.close),
    period : ind.stochK,
    signalPeriod: ind.stochD,
  });

  const offset = candles.length - vals.length;
  candles.forEach((c, i) => {
    const v = vals[i - offset];
    c.stochK = v?.k ?? null;
    c.stochD = v?.d ?? null;
  });
}

/**
 * ATR (14) — in USD price units.
 * A $1.50 ATR on XAU/USD means the average candle range is $1.50.
 */
function _addAtr(candles) {
  const vals = ATR.calculate({
    high   : candles.map(c => c.high),
    low    : candles.map(c => c.low),
    close  : candles.map(c => c.close),
    period : ind.atrPeriod,
  });

  const padded = _padLeft(vals, candles.length);
  candles.forEach((c, i) => { c.atr = padded[i]; });
}

/**
 * Bollinger Bands (20/2σ)
 * Adds: bbUpper, bbMid, bbLower, bbWidth, bbPctB
 */
function _addBollinger(candles) {
  const closes = candles.map(c => c.close);
  const vals   = BollingerBands.calculate({
    period    : ind.bbPeriod,
    values    : closes,
    stdDev    : ind.bbStd,
  });

  const offset = candles.length - vals.length;
  candles.forEach((c, i) => {
    const v = vals[i - offset];
    if (v) {
      c.bbUpper = v.upper;
      c.bbMid   = v.middle;
      c.bbLower = v.lower;
      c.bbWidth = v.upper - v.lower;
      // %B: 0 = price at lower band, 1 = price at upper band
      c.bbPctB  = c.bbWidth > 0 ? (c.close - v.lower) / c.bbWidth : 0.5;
    } else {
      c.bbUpper = c.bbMid = c.bbLower = c.bbWidth = c.bbPctB = null;
    }
  });
}

/**
 * Fractal Swing Highs / Lows
 * A swing high at bar i: high[i] > all highs in [i-n, i-1] and [i+1, i+n]
 * Adds: swingHigh (price or null), swingLow (price or null),
 *        lastSH (most recent swing high, forward-filled),
 *        lastSL (most recent swing low, forward-filled)
 */
function _addSwingPoints(candles) {
  const n   = ind.swingWindow;
  const len = candles.length;

  candles.forEach(c => { c.swingHigh = null; c.swingLow = null; });

  for (let i = n; i < len - n; i++) {
    const windowHighs = candles.slice(i - n, i + n + 1).map(c => c.high);
    const windowLows  = candles.slice(i - n, i + n + 1).map(c => c.low);
    const maxH = Math.max(...windowHighs);
    const minL = Math.min(...windowLows);

    if (candles[i].high === maxH) candles[i].swingHigh = candles[i].high;
    if (candles[i].low  === minL) candles[i].swingLow  = candles[i].low;
  }

  // Forward-fill so every bar knows the most recent confirmed swing level
  let lastSH = null;
  let lastSL = null;
  candles.forEach(c => {
    if (c.swingHigh != null) lastSH = c.swingHigh;
    if (c.swingLow  != null) lastSL = c.swingLow;
    c.lastSH = lastSH;
    c.lastSL = lastSL;
  });
}

/**
 * Trend direction integer derived from the EMA stack.
 *  +1 = bullish  (emaFast > emaSlow > emaTrend AND price > emaTrend)
 *  -1 = bearish  (emaFast < emaSlow < emaTrend AND price < emaTrend)
 *   0 = neutral
 */
function _addTrendDirection(candles) {
  candles.forEach(c => {
    const { emaFast, emaSlow, emaTrend, close } = c;
    if (emaFast == null || emaSlow == null || emaTrend == null) {
      c.trendDir = 0;
      return;
    }
    if (emaFast > emaSlow && emaSlow > emaTrend && close > emaTrend) {
      c.trendDir = 1;
    } else if (emaFast < emaSlow && emaSlow < emaTrend && close < emaTrend) {
      c.trendDir = -1;
    } else {
      c.trendDir = 0;
    }
  });
}

// ── Utility Helpers ───────────────────────────────────────────────────────────

function _padLeft(arr, targetLen) {
  const pad = new Array(targetLen - arr.length).fill(null);
  return [...pad, ...arr];
}

/**
 * Detect RSI divergence over the last `lookback` bars.
 * @param {Array}  candles
 * @param {number} lookback
 * @returns {'bullish'|'bearish'|'none'}
 */
export function rsiDivergence(candles, lookback = 20) {
  if (candles.length < lookback) return 'none';
  const window = candles.slice(-lookback);
  const half   = Math.floor(lookback / 2);
  const first  = window.slice(0, half);
  const second = window.slice(half);

  const closeLow1  = Math.min(...first.map(c => c.close));
  const closeLow2  = Math.min(...second.map(c => c.close));
  const rsiLow1    = Math.min(...first.filter(c => c.rsi != null).map(c => c.rsi));
  const rsiLow2    = Math.min(...second.filter(c => c.rsi != null).map(c => c.rsi));

  const closeHigh1 = Math.max(...first.map(c => c.close));
  const closeHigh2 = Math.max(...second.map(c => c.close));
  const rsiHigh1   = Math.max(...first.filter(c => c.rsi != null).map(c => c.rsi));
  const rsiHigh2   = Math.max(...second.filter(c => c.rsi != null).map(c => c.rsi));

  if (closeLow2 < closeLow1 && rsiLow2 > rsiLow1)     return 'bullish';
  if (closeHigh2 > closeHigh1 && rsiHigh2 < rsiHigh1) return 'bearish';
  return 'none';
}

/**
 * Returns { support, resistance } nearest to currentPrice using swing levels.
 * @param {Array}  candles
 * @param {number} currentPrice
 */
export function getNearestSR(candles, currentPrice) {
  const shLevels = candles.map(c => c.swingHigh).filter(v => v != null && v > currentPrice);
  const slLevels = candles.map(c => c.swingLow).filter(v => v != null && v < currentPrice);

  const resistance = shLevels.length ? Math.min(...shLevels) : currentPrice + 5;
  const support    = slLevels.length ? Math.max(...slLevels) : currentPrice - 5;

  return { support, resistance };
}
