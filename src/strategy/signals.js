/**
 * src/strategy/signals.js — Trend-Following Scalp Signal Engine
 * ==============================================================
 * Strategy: EMA cross filtered by EMA200 trend + RSI(7) exhaustion
 *
 * SELL ONLY — all four gates must pass on the same bar:
 *
 *   [1] VOLATILITY GUARD : ATR within [minAtr, maxAtr] — skip dead/spiked markets
 *   [2] TREND FILTER     : Close < EMA200 — only sell in a downtrend
 *   [3] EMA CROSS        : EMA5 crosses BELOW EMA13 on this bar (fresh momentum shift)
 *   [4] RSI EXHAUSTION   : RSI(7) > 70 AND slope < 0 (overbought and rolling over)
 *
 * STOP LOSS  : max(recent swing high + 0.2×ATR,  entry + 2.0×ATR)
 *              floored at entry + 1.0×ATR so normal noise never hits the stop
 * TAKE PROFIT: SL_distance × 1.5  →  1.5:1 R:R
 * TRAILING   : Managed by RiskManager — activates at 1% profit, trails 0.8×ATR
 */

import CFG from '../../config.js';

const str = CFG.strategy;
const ind = CFG.indicator;

// ── Signal Object ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Signal
 * @property {'sell'}    direction
 * @property {number}   entryPrice
 * @property {number}   stopLoss
 * @property {number}   takeProfit
 * @property {number}   rrRatio
 * @property {number}   score         — always 4 (one point per gate passed)
 * @property {number}   requiredScore — always 4
 * @property {number}   atr
 * @property {boolean}  isCounterTrend — always false (trend-following only)
 * @property {string[]} reasons
 * @property {Date}     timestamp
 */

// ── SignalGenerator ───────────────────────────────────────────────────────────

export class SignalGenerator {
  /**
   * Evaluate the current bar for a sell entry.
   *
   * @param {Array} m5Candles   Signal-TF candles enriched with indicators (oldest first)
   * @param {Array} m15Candles  Trend-TF candles (kept for API compat — not used directly)
   * @returns {Signal|null}
   */
  evaluate(m5Candles, m15Candles) {
    this.lastBar = null;

    if (m5Candles.length < 50) return null;

    const bar  = m5Candles.at(-1);
    const prev = m5Candles.at(-2);
    const atr  = bar.atr;

    // ── [1] Volatility Guard ──────────────────────────────────────────────────
    // Skip dead markets (no movement → false crosses) and news spikes (huge ATR)
    if (atr == null || atr < str.minAtr || atr > str.maxAtr) {
      this.lastBar = {
        sell: { score: 0, required: 4, reasons: [`ATR ${atr?.toFixed(2) ?? 'null'} outside [${str.minAtr}, ${str.maxAtr}]`] },
      };
      return null;
    }

    const price   = bar.close;
    const reasons = [];

    // ── [2] Trend Filter: price must be below EMA200 ──────────────────────────
    // Selling into a bull trend is the #1 cause of preventable losses.
    // The 200-period EMA on M5 gives ~16 hours of trend context.
    if (bar.emaTrend == null) {
      this.lastBar = { sell: { score: 0, required: 4, reasons: ['EMA200 not yet computed (warmup)'] } };
      return null;
    }
    if (price >= bar.emaTrend) {
      this.lastBar = {
        sell: { score: 0, required: 4, reasons: [`Price ${price} ≥ EMA200 ${bar.emaTrend.toFixed(2)} — trend is bullish`] },
      };
      return null;
    }
    reasons.push(`Price(${price}) < EMA${ind.emaTrend}(${bar.emaTrend.toFixed(2)})`);

    // ── [3] EMA5 × EMA13 Bearish Cross ────────────────────────────────────────
    // The fast EMA must cross BELOW the slow EMA on this exact bar.
    // A stale cross (already crossed bars ago) is NOT a signal — it is chasing.
    if (bar.emaFast == null || bar.emaSlow == null ||
        prev.emaFast == null || prev.emaSlow == null) {
      this.lastBar = { sell: { score: 1, required: 4, reasons: [...reasons, 'EMA not yet computed'] } };
      return null;
    }
    const crossedDown = (prev.emaFast >= prev.emaSlow) && (bar.emaFast < bar.emaSlow);
    if (!crossedDown) {
      this.lastBar = {
        sell: {
          score   : 1,
          required: 4,
          reasons : [...reasons, `No fresh EMA${ind.emaFast}/EMA${ind.emaSlow} cross (fast=${bar.emaFast.toFixed(2)}, slow=${bar.emaSlow.toFixed(2)})`],
        },
      };
      return null;
    }
    reasons.push(`EMA${ind.emaFast}(${bar.emaFast.toFixed(2)}) crossed below EMA${ind.emaSlow}(${bar.emaSlow.toFixed(2)})`);

    // ── [4] RSI(7) Overbought + Rolling Over ──────────────────────────────────
    // RSI must be ABOVE the overbought line AND the 3-bar slope must be negative.
    // RSI overbought alone means nothing — it must be turning. "Overbought can
    // stay overbought" (Gold rule #4). The cross + RSI reversal together = exhaustion.
    const { rsi, rsiSlope } = bar;
    if (rsi == null || rsiSlope == null) {
      this.lastBar = { sell: { score: 2, required: 4, reasons: [...reasons, 'RSI not computed'] } };
      return null;
    }
    if (rsi <= ind.rsiOverbought) {
      this.lastBar = {
        sell: {
          score   : 2,
          required: 4,
          reasons : [...reasons, `RSI(${rsi.toFixed(1)}) not overbought (need >${ind.rsiOverbought})`],
        },
      };
      return null;
    }
    if (rsiSlope >= 0) {
      this.lastBar = {
        sell: {
          score   : 2,
          required: 4,
          reasons : [...reasons, `RSI(${rsi.toFixed(1)}) overbought but still rising (slope=${rsiSlope.toFixed(1)})`],
        },
      };
      return null;
    }
    reasons.push(`RSI(${rsi.toFixed(1)}) overbought + falling (slope ${rsiSlope.toFixed(1)})`);

    // ── All 4 gates passed — calculate entry levels ───────────────────────────
    const levels = this._calculateLevels(price, atr, bar);
    if (!levels) {
      this.lastBar = { sell: { score: 4, required: 4, reasons: [...reasons, 'Level calculation failed'] } };
      return null;
    }

    const { entry, sl, tp } = levels;
    const slDist = sl - entry;   // positive: SL is above entry for a sell
    const tpDist = entry - tp;   // positive: TP is below entry for a sell
    const rr     = slDist > 0 ? tpDist / slDist : 0;

    if (rr < str.minRrRatio) {
      this.lastBar = {
        sell: {
          score   : 4,
          required: 4,
          reasons : [...reasons, `R:R ${rr.toFixed(2)} below minimum ${str.minRrRatio}`],
        },
      };
      return null;
    }

    this.lastBar = { sell: { score: 4, required: 4, reasons } };

    return {
      direction     : 'sell',
      entryPrice    : round2(entry),
      stopLoss      : round2(sl),
      takeProfit    : round2(tp),
      rrRatio       : round2(rr),
      score         : 4,
      requiredScore : 4,
      atr           : round2(atr),
      isCounterTrend: false,
      reasons,
      timestamp     : bar.time,
    };
  }

  // ── Level Construction ────────────────────────────────────────────────────

  /**
   * Compute SL and TP for a sell entry.
   *
   * SL logic (for sell, SL is ABOVE entry):
   *   - Structural: just above the most recent confirmed swing high
   *   - ATR-based:  entry + slAtrMult × ATR  (fixed fallback)
   *   - Take the HIGHER of the two (wider = more conservative = survives noise)
   *   - Enforce hard floor: SL must be at least 1×ATR above entry
   *
   * TP: entry − SL_distance × tpSlMult  →  1.5:1 R:R
   */
  _calculateLevels(price, atr, bar) {
    const atrSl    = price + atr * str.slAtrMult;                   // fixed ATR stop
    const structSl = bar.lastSH != null
      ? bar.lastSH + 0.2 * atr                                      // just above swing high
      : atrSl;                                                       // no swing point — fall back

    // Use the wider SL so market noise doesn't clip the stop prematurely
    let sl = Math.max(atrSl, structSl);

    // Hard noise floor: SL must be at least 1×ATR from entry
    sl = Math.max(sl, price + atr);

    if (sl <= price) return null;   // sanity — should never happen for sell

    const slDist = sl - price;
    const tp     = price - slDist * str.tpSlMult;

    return { entry: price, sl, tp };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const round2 = v => Math.round(v * 100) / 100;

export function formatSignal(signal) {
  return (
    `[${signal.direction.toUpperCase()}] @ ${signal.entryPrice} | ` +
    `SL: ${signal.stopLoss} | TP: ${signal.takeProfit} | ` +
    `R:R ${signal.rrRatio} | ATR ${signal.atr} | ${signal.reasons.join(', ')}`
  );
}
