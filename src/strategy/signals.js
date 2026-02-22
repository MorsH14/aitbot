/**
 * src/strategy/signals.js — Signal Generation Engine
 * ====================================================
 * Evaluates enriched M15 and H1 candle arrays and produces a Signal object
 * (or null) based on the Multi-Confluence Scalp strategy.
 *
 * The 5 Confluence Checks (each = 1 point, min 3 required to trade):
 *   [1] H1 EMA trend alignment
 *   [2] RSI zone / divergence
 *   [3] MACD crossover
 *   [4] Stochastic crossover
 *   [5] Bollinger Band touch + swing structure level
 *
 * Entry is the current close price (order fills on next candle open in reality).
 * SL = ATR × 1.5 (or just beyond nearest swing level, whichever tightens R:R).
 * TP = SL_distance × 2.0 (minimum 2:1 R:R).
 */

import { rsiDivergence } from '../indicators/technical.js';
import CFG from '../../config.js';

const str = CFG.strategy;
const ind = CFG.indicator;

// ── Signal Object ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Signal
 * @property {'buy'|'sell'} direction
 * @property {number}  entryPrice
 * @property {number}  stopLoss
 * @property {number}  takeProfit
 * @property {number}  rrRatio
 * @property {number}  score         Confluence score 0–5
 * @property {number}  atr           ATR at signal time
 * @property {string[]} reasons      Human-readable list of triggers
 * @property {Date}    timestamp
 */

// ── SignalGenerator ───────────────────────────────────────────────────────────

export class SignalGenerator {
  /**
   * Evaluate candle data and return a Signal or null.
   *
   * @param {Array} m15Candles  Enriched M15 candles (from addAllIndicators)
   * @param {Array} h1Candles   Enriched H1 candles
   * @returns {Signal|null}
   */
  evaluate(m15Candles, h1Candles) {
    if (m15Candles.length < 100 || h1Candles.length < 50) return null;

    const bar    = m15Candles.at(-1);   // Latest complete M15 candle
    const h1Bar  = h1Candles.at(-1);    // Latest complete H1 candle
    const atr    = bar.atr;

    if (atr == null) return null;

    // Volatility pre-filter — skip dead markets and extreme spikes
    if (atr < str.minAtr) return null;
    if (atr > str.maxAtr) return null;

    const currentPrice = bar.close;

    // Score both directions
    const { score: buyScore,  reasons: buyReasons  } = this._score('buy',  bar, h1Bar, m15Candles);
    const { score: sellScore, reasons: sellReasons } = this._score('sell', bar, h1Bar, m15Candles);

    // Select the stronger direction (if both pass threshold, take higher score)
    let direction = null;
    let score     = 0;
    let reasons   = [];

    if (buyScore >= str.minSignalScore && buyScore >= sellScore) {
      direction = 'buy';  score = buyScore;  reasons = buyReasons;
    } else if (sellScore >= str.minSignalScore && sellScore > buyScore) {
      direction = 'sell'; score = sellScore; reasons = sellReasons;
    }

    if (!direction) return null;

    // Build trade levels
    const levels = this._calculateLevels(direction, currentPrice, atr, m15Candles);
    if (!levels) return null;

    const { entry, sl, tp } = levels;
    const risk   = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    const rr     = risk > 0 ? reward / risk : 0;

    if (rr < str.minRrRatio) return null;

    return {
      direction,
      entryPrice : round2(entry),
      stopLoss   : round2(sl),
      takeProfit : round2(tp),
      rrRatio    : round2(rr),
      score,
      atr        : round2(atr),
      reasons,
      timestamp  : bar.time,
    };
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  /**
   * Run all 5 confirmation checks for one direction.
   * @returns {{ score: number, reasons: string[] }}
   */
  _score(direction, bar, h1Bar, candles) {
    let score   = 0;
    const reasons = [];
    const isBuy = direction === 'buy';

    // ── [1] H1 Trend Alignment ───────────────────────────────────────────────
    const h1Trend = h1Bar?.trendDir ?? 0;
    if ((isBuy && h1Trend === 1) || (!isBuy && h1Trend === -1)) {
      score++;
      reasons.push(`H1 trend ${isBuy ? 'bullish' : 'bearish'}`);
    }

    // ── [2] RSI Zone or Divergence ───────────────────────────────────────────
    const rsi = bar.rsi;
    if (rsi != null) {
      if (isBuy && rsi < ind.rsiOversold) {
        score++;
        reasons.push(`RSI oversold (${rsi.toFixed(1)})`);
      } else if (!isBuy && rsi > ind.rsiOverbought) {
        score++;
        reasons.push(`RSI overbought (${rsi.toFixed(1)})`);
      } else {
        const div = rsiDivergence(candles, 20);
        if ((isBuy && div === 'bullish') || (!isBuy && div === 'bearish')) {
          score++;
          reasons.push(`RSI ${div} divergence`);
        }
      }
    }

    // ── [3] MACD Crossover ───────────────────────────────────────────────────
    if (candles.length >= 2) {
      const prev = candles.at(-2);
      const { macdLine: m, macdSignal: s, macdHist: h } = bar;
      const { macdLine: mp, macdSignal: sp }             = prev;

      if (m != null && s != null && h != null && mp != null && sp != null) {
        const buyCross  = (mp <= sp) && (m > s) && (h > 0);
        const sellCross = (mp >= sp) && (m < s) && (h < 0);
        if (isBuy && buyCross) {
          score++;
          reasons.push('MACD bullish crossover');
        } else if (!isBuy && sellCross) {
          score++;
          reasons.push('MACD bearish crossover');
        }
      }
    }

    // ── [4] Stochastic Crossover ─────────────────────────────────────────────
    if (candles.length >= 2) {
      const prev = candles.at(-2);
      const { stochK: k, stochD: d }    = bar;
      const { stochK: kp, stochD: dp }  = prev;

      if (k != null && d != null && kp != null && dp != null) {
        const stochBuy  = (kp <= dp) && (k > d) && (k < ind.stochOb);
        const stochSell = (kp >= dp) && (k < d) && (k > ind.stochOs);
        if (isBuy && stochBuy) {
          score++;
          reasons.push(`Stoch cross up (${k.toFixed(1)})`);
        } else if (!isBuy && stochSell) {
          score++;
          reasons.push(`Stoch cross down (${k.toFixed(1)})`);
        }
      }
    }

    // ── [5] BB Touch + Structural Level ─────────────────────────────────────
    const { close, bbUpper, bbLower, lastSH, lastSL, atr } = bar;
    if (bbUpper != null && bbLower != null && atr != null) {
      const nearLower = close <= (bbLower + 0.3 * atr);
      const nearUpper = close >= (bbUpper - 0.3 * atr);
      const nearSupport    = lastSL != null && Math.abs(close - lastSL) < 0.5 * atr;
      const nearResistance = lastSH != null && Math.abs(close - lastSH) < 0.5 * atr;

      if (isBuy && nearLower) {
        score++;
        reasons.push('Price at BB lower band' + (nearSupport ? ' + support' : ''));
      } else if (!isBuy && nearUpper) {
        score++;
        reasons.push('Price at BB upper band' + (nearResistance ? ' + resistance' : ''));
      }
    }

    return { score, reasons };
  }

  // ── Level Construction ─────────────────────────────────────────────────────

  /**
   * Build entry, SL, TP levels.
   * Uses the better of ATR-based SL or structural SL (tighter = better R:R).
   * @returns {{ entry, sl, tp }|null}
   */
  _calculateLevels(direction, price, atr, candles) {
    const isBuy = direction === 'buy';
    const bar   = candles.at(-1);

    // ATR-based SL
    const atrSlDist = atr * str.slAtrMult;
    const atrSl     = isBuy ? price - atrSlDist : price + atrSlDist;

    // Structural SL (just beyond last swing point)
    const minSlDist = 0.3 * atr;
    let structSl = atrSl;

    if (isBuy && bar.lastSL != null) {
      structSl = bar.lastSL - 0.2 * atr;
    } else if (!isBuy && bar.lastSH != null) {
      structSl = bar.lastSH + 0.2 * atr;
    }

    // Pick tighter stop (better R:R), enforce minimum distance from entry
    let sl;
    if (isBuy) {
      sl = Math.max(atrSl, structSl);          // Higher = tighter for buy
      sl = Math.min(sl, price - minSlDist);    // Ensure minimum gap
    } else {
      sl = Math.min(atrSl, structSl);          // Lower = tighter for sell
      sl = Math.max(sl, price + minSlDist);
    }

    // Validate SL is on the correct side
    if (isBuy  && sl >= price) return null;
    if (!isBuy && sl <= price) return null;

    // Take-profit
    const slDist = Math.abs(price - sl);
    const tp     = isBuy ? price + slDist * str.tpSlMult
                         : price - slDist * str.tpSlMult;

    return { entry: price, sl, tp };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const round2 = v => Math.round(v * 100) / 100;

/**
 * Format a signal for logging.
 * @param {Signal} signal
 * @returns {string}
 */
export function formatSignal(signal) {
  return (
    `[${signal.direction.toUpperCase()}] @ ${signal.entryPrice} | ` +
    `SL: ${signal.stopLoss} | TP: ${signal.takeProfit} | ` +
    `R:R ${signal.rrRatio} | Score ${signal.score}/5 | ` +
    `ATR ${signal.atr} | ${signal.reasons.join(', ')}`
  );
}
