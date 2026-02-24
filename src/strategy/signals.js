/**
 * src/strategy/signals.js — Signal Generation Engine (Professional Grade)
 * =========================================================================
 * Multi-Confluence Scalp Strategy for XAU/USD — rules based on 30-year
 * professional Gold trading principles:
 *
 * CORE LAWS:
 *   1. Never fight the trend with a tight stop.
 *   2. Counter-trend trades require PROOF of exhaustion (divergence), not
 *      just an overbought reading. Overbought can stay overbought for hours.
 *   3. A stop-loss below 1× ATR will be taken out by normal market noise.
 *   4. RSI at 80 in an uptrend means strong buyers — wait for divergence.
 *   5. Trade fewer setups with higher conviction. Quality over quantity.
 *
 * THE 5 CONFLUENCE CHECKS (each = 1 point):
 *   [1] Trend alignment — M15 EMA stack direction MUST match trade direction.
 *       Counter-trend is ONLY allowed when RSI divergence is confirmed (acts
 *       as substitute for this point + gates the entire check).
 *   [2] RSI — oversold/overbought zone OR confirmed divergence.
 *   [3] MACD crossover — momentum direction confirmed.
 *   [4] Stochastic crossover — secondary momentum, must NOT be at extreme
 *       (K>95 or K<5 is a spike, not a signal).
 *   [5] Bollinger Band touch + structural level confluence.
 *
 * GATES (hard blocks, not scored):
 *   - Counter-trend: requires RSI divergence (no divergence = no trade).
 *   - Counter-trend minimum score raised to 4/5.
 *   - RSI on wrong side of midline for trend-aligned trades = check [2] fails.
 *   - Minimum SL distance enforced at 1.0× ATR (noise floor).
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
 * @property {number}  score
 * @property {number}  atr
 * @property {boolean} isCounterTrend
 * @property {string[]} reasons
 * @property {Date}    timestamp
 */

// ── SignalGenerator ───────────────────────────────────────────────────────────

export class SignalGenerator {
  evaluate(m15Candles, h1Candles) {
    if (m15Candles.length < 100 || h1Candles.length < 30) return null;

    const bar   = m15Candles.at(-1);
    const h1Bar = h1Candles.at(-1);
    const atr   = bar.atr;

    if (atr == null) return null;
    if (atr < str.minAtr || atr > str.maxAtr) return null;

    const currentPrice = bar.close;

    // Pre-compute RSI divergence once (expensive — reused across directions)
    const rsiDiv = rsiDivergence(m15Candles, 20);

    // Score both directions
    const buyResult  = this._score('buy',  bar, h1Bar, m15Candles, rsiDiv);
    const sellResult = this._score('sell', bar, h1Bar, m15Candles, rsiDiv);

    // Each direction has its own minimum score threshold
    // Counter-trend trades require a higher bar of confidence
    let direction = null;
    let chosen    = null;

    const buyOk  = buyResult.score  >= buyResult.requiredScore;
    const sellOk = sellResult.score >= sellResult.requiredScore;

    if (buyOk && (!sellOk || buyResult.score >= sellResult.score)) {
      direction = 'buy';  chosen = buyResult;
    } else if (sellOk) {
      direction = 'sell'; chosen = sellResult;
    }

    if (!direction) return null;

    const levels = this._calculateLevels(direction, currentPrice, atr, m15Candles);
    if (!levels) return null;

    const { entry, sl, tp } = levels;
    const risk   = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    const rr     = risk > 0 ? reward / risk : 0;

    if (rr < str.minRrRatio) return null;

    return {
      direction,
      entryPrice     : round2(entry),
      stopLoss       : round2(sl),
      takeProfit     : round2(tp),
      rrRatio        : round2(rr),
      score          : chosen.score,
      requiredScore  : chosen.requiredScore,
      atr            : round2(atr),
      isCounterTrend : chosen.isCounterTrend,
      reasons        : chosen.reasons,
      timestamp      : bar.time,
    };
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  _score(direction, bar, h1Bar, candles, rsiDiv) {
    let score         = 0;
    const reasons     = [];
    const isBuy       = direction === 'buy';
    const h1Trend     = h1Bar?.trendDir ?? 0;

    // ── Trend Alignment Gate ─────────────────────────────────────────────────
    // Determine if this trade goes WITH or AGAINST the M15 trend.
    // Counter-trend trading is the #1 cause of preventable losses in Gold.
    const trendAligned    = (isBuy && h1Trend === 1) || (!isBuy && h1Trend === -1);
    const trendNeutral    = h1Trend === 0;
    const isCounterTrend  = !trendAligned && !trendNeutral;

    // Check if divergence confirms the trade direction
    const divConfirmed = (isBuy && rsiDiv === 'bullish') || (!isBuy && rsiDiv === 'bearish');

    // HARD GATE: If we're going counter-trend, RSI divergence is MANDATORY.
    // "RSI overbought" alone does NOT justify selling into a bull trend.
    // Gold can stay overbought for 3-4 hours during a momentum run.
    if (isCounterTrend && !divConfirmed) {
      return { score: 0, reasons: ['counter-trend without divergence'], requiredScore: 99, isCounterTrend };
    }

    // Counter-trend trades (even with divergence) need 4/5, not 3/5.
    // The extra bar protects against false reversals in strong trends.
    const requiredScore = isCounterTrend ? str.minSignalScore + 1 : str.minSignalScore;

    // ── [1] Trend / Divergence ────────────────────────────────────────────────
    if (trendAligned) {
      score++;
      reasons.push(`M15 trend ${isBuy ? 'bullish' : 'bearish'}`);
    } else if (divConfirmed) {
      // Divergence replaces trend point for counter-trend entries
      score++;
      reasons.push(`RSI ${rsiDiv} divergence (counter-trend confirmed)`);
    }

    // ── [2] RSI Zone ──────────────────────────────────────────────────────────
    // For trend-aligned trades: RSI must be recovering from the correct zone,
    // not already extended. Buying when RSI is at 70+ in an uptrend is
    // chasing — the pullback hasn't happened yet.
    //
    // For counter-trend (divergence already confirmed in [1]):
    // RSI must be in the extreme zone to add this point.
    const rsi = bar.rsi;
    if (rsi != null) {
      if (isBuy) {
        if (rsi < ind.rsiOversold) {
          score++;
          reasons.push(`RSI oversold (${rsi.toFixed(1)})`);
        } else if (trendAligned && rsi < 55) {
          // Buying in an uptrend when RSI is still below 55 = early entry on pullback
          score++;
          reasons.push(`RSI pullback zone (${rsi.toFixed(1)})`);
        } else if (divConfirmed && !isCounterTrend) {
          score++;
          reasons.push(`RSI bullish divergence`);
        }
      } else {
        if (rsi > ind.rsiOverbought) {
          score++;
          reasons.push(`RSI overbought (${rsi.toFixed(1)})`);
        } else if (trendAligned && rsi > 45) {
          // Selling in a downtrend when RSI is still above 45 = early entry on rally
          score++;
          reasons.push(`RSI rally zone (${rsi.toFixed(1)})`);
        } else if (divConfirmed && !isCounterTrend) {
          score++;
          reasons.push(`RSI bearish divergence`);
        }
      }
    }

    // ── [3] MACD Crossover ────────────────────────────────────────────────────
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

    // ── [4] Stochastic Crossover ──────────────────────────────────────────────
    // Stochastic at K=95-100 is a MOMENTUM SPIKE, not a reversal crossover.
    // A Stoch crossing from 99→97 means nothing — price is still surging.
    // We require the cross to happen BELOW the extreme ceiling (K < 90 for sell,
    // K > 10 for buy) so we're catching a genuine cycle turn, not noise.
    if (candles.length >= 2) {
      const prev = candles.at(-2);
      const { stochK: k, stochD: d }   = bar;
      const { stochK: kp, stochD: dp } = prev;

      if (k != null && d != null && kp != null && dp != null) {
        // Cross must happen below the extreme ceiling (< 90 for sell, > 10 for buy)
        const stochBuy  = (kp <= dp) && (k > d) && (k < ind.stochOb) && (kp < ind.stochOb);
        const stochSell = (kp >= dp) && (k < d) && (k > ind.stochOs) && (kp > ind.stochOs) && (k < 90);

        if (isBuy && stochBuy) {
          score++;
          reasons.push(`Stoch cross up (${k.toFixed(1)})`);
        } else if (!isBuy && stochSell) {
          score++;
          reasons.push(`Stoch cross down (${k.toFixed(1)})`);
        }
      }
    }

    // ── [5] BB Touch + Structural Level ──────────────────────────────────────
    const { close, bbUpper, bbLower, lastSH, lastSL, atr } = bar;
    if (bbUpper != null && bbLower != null && atr != null) {
      const nearLower      = close <= (bbLower + 0.3 * atr);
      const nearUpper      = close >= (bbUpper - 0.3 * atr);
      const nearSupport    = lastSL != null && Math.abs(close - lastSL) < 0.5 * atr;
      const nearResistance = lastSH != null && Math.abs(close - lastSH) < 0.5 * atr;

      if (isBuy && nearLower) {
        score++;
        reasons.push('Price at BB lower' + (nearSupport ? ' + support zone' : ''));
      } else if (!isBuy && nearUpper) {
        score++;
        reasons.push('Price at BB upper' + (nearResistance ? ' + resistance zone' : ''));
      }
    }

    return { score, reasons, requiredScore, isCounterTrend };
  }

  // ── Level Construction ────────────────────────────────────────────────────

  _calculateLevels(direction, price, atr, candles) {
    const isBuy = direction === 'buy';
    const bar   = candles.at(-1);

    // ATR-based SL — the baseline, always 1.5× ATR
    const atrSlDist = atr * str.slAtrMult;
    const atrSl     = isBuy ? price - atrSlDist : price + atrSlDist;

    // Structural SL — just beyond nearest swing point
    let structSl = atrSl;
    if (isBuy && bar.lastSL != null)  structSl = bar.lastSL - 0.2 * atr;
    if (!isBuy && bar.lastSH != null) structSl = bar.lastSH + 0.2 * atr;

    // PROFESSIONAL RULE: SL must be at least 1.0× ATR from entry.
    // Below that = normal market noise = guaranteed stop-out regardless
    // of direction. Gold breathes 1× ATR without effort on M5.
    const hardMinDist = 1.0 * atr;

    let sl;
    if (isBuy) {
      sl = Math.max(atrSl, structSl);              // Pick tighter (higher) stop
      sl = Math.min(sl, price - hardMinDist);      // But never closer than 1× ATR
    } else {
      sl = Math.min(atrSl, structSl);              // Pick tighter (lower) stop
      sl = Math.max(sl, price + hardMinDist);      // Never closer than 1× ATR
    }

    if (isBuy  && sl >= price) return null;
    if (!isBuy && sl <= price) return null;

    const slDist = Math.abs(price - sl);
    const tp     = isBuy ? price + slDist * str.tpSlMult
                         : price - slDist * str.tpSlMult;

    return { entry: price, sl, tp };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const round2 = v => Math.round(v * 100) / 100;

export function formatSignal(signal) {
  const ct = signal.isCounterTrend ? ' [COUNTER-TREND]' : '';
  return (
    `[${signal.direction.toUpperCase()}]${ct} @ ${signal.entryPrice} | ` +
    `SL: ${signal.stopLoss} | TP: ${signal.takeProfit} | ` +
    `R:R ${signal.rrRatio} | Score ${signal.score}/${signal.requiredScore} | ` +
    `ATR ${signal.atr} | ${signal.reasons.join(', ')}`
  );
}
