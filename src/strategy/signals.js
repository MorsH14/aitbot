/**
 * src/strategy/signals.js — Multi-TF Trend-Following Scalp Signal Engine
 * ========================================================================
 * Strategy: M15 trend alignment + M5 EMA cross + momentum confirmation
 *
 * BOTH DIRECTIONS supported.
 *
 *   MANDATORY (each adds 1 pt; early-exit if either fails — direction blocked):
 *   [M1] VOLATILITY GUARD : ATR within [minAtr, maxAtr]          (shared pre-check)
 *   [M2] M15 TREND FILTER : Price vs M15 EMA200 — WITH the trend only
 *   [M3] EMA ALIGNMENT    : EMA5/EMA13 aligned in signal direction + cross within 3 bars
 *
 *   SCORING (each adds 1 pt; need ≥ 2 of 4 to reach REQUIRED_SCORE=4):
 *   [S1] M5 TREND FILTER  : Price vs M5 EMA200 — dual-TF alignment
 *   [S2] RSI EXHAUSTION   : RSI(7) in OB/OS zone AND rolling over/up
 *   [S3] MACD MOMENTUM    : MACD histogram turning in signal direction
 *   [S4] STOCHASTIC CROSS : K/D cross inside overbought/oversold zone
 *
 *   REQUIRED_SCORE = 4  (M2 + M3 mandatory + ≥ 2 scoring gates)
 *   Competition   : both directions evaluated each bar — higher score wins; tie = no trade
 *
 * STOP LOSS  : max(swing structure ± 0.2×ATR,  entry ± 2.0×ATR), floor at 1×ATR
 * TAKE PROFIT: SL_distance × tpSlMult (2.0)  →  2:1 R:R
 * TRAILING   : RiskManager — activates at 1% profit, trails 0.8×ATR
 */

import CFG from '../../config.js';

const str = CFG.strategy;
const ind = CFG.indicator;

// Min score to fire a signal: M2(+1) + M3(+1) + any 1 scoring gate(+1) = 3
const REQUIRED_SCORE = 3;

// ── SignalGenerator ───────────────────────────────────────────────────────────

export class SignalGenerator {
  /**
   * Evaluate the current bar for a buy or sell entry.
   *
   * @param {Array} m5Candles   Signal-TF candles enriched with indicators (oldest first)
   * @param {Array} m15Candles  Trend-TF candles enriched with indicators (oldest first)
   * @returns {Signal|null}
   */
  evaluate(m5Candles, m15Candles) {
    this.lastBar = null;

    if (m5Candles.length < 50) return null;

    const bar  = m5Candles.at(-1);
    const prev = m5Candles.at(-2);
    const atr  = bar.atr;

    // [M1] Volatility guard — both directions share this check
    if (atr == null || atr < str.minAtr || atr > str.maxAtr) {
      const msg = `ATR ${atr?.toFixed(2) ?? 'null'} outside [${str.minAtr}, ${str.maxAtr}]`;
      this.lastBar = {
        sell: { score: 0, required: REQUIRED_SCORE, reasons: [msg] },
        buy:  { score: 0, required: REQUIRED_SCORE, reasons: [msg] },
      };
      return null;
    }

    const sellResult = this._evalDirection('sell', bar, prev, m5Candles, m15Candles);
    const buyResult  = this._evalDirection('buy',  bar, prev, m5Candles, m15Candles);

    this.lastBar = { sell: sellResult, buy: buyResult };

    const sellValid = sellResult.score >= REQUIRED_SCORE;
    const buyValid  = buyResult.score  >= REQUIRED_SCORE;

    if (!sellValid && !buyValid) return null;

    // Competition: higher score wins; equal scores = ambiguous market — no trade
    let direction;
    if (sellValid && !buyValid)                   direction = 'sell';
    else if (buyValid && !sellValid)              direction = 'buy';
    else if (sellResult.score > buyResult.score)  direction = 'sell';
    else if (buyResult.score  > sellResult.score) direction = 'buy';
    else return null;

    const evalResult = direction === 'sell' ? sellResult : buyResult;
    return this._buildSignal(direction, bar, atr, evalResult);
  }

  // ── Direction Evaluator ────────────────────────────────────────────────────

  /**
   * Score a single direction (buy or sell) against all gates.
   * Returns early with partial score if any mandatory gate fails.
   */
  _evalDirection(direction, bar, prev, m5Candles, m15Candles) {
    const isSell  = direction === 'sell';
    const reasons = [];
    let score     = 0;

    // [M2] M15 Trend Filter — MANDATORY
    // Selling into a bull M15 trend is the #1 preventable loss. Vice versa for buys.
    const m15bar = m15Candles?.at(-1);
    if (!m15bar || m15bar.emaTrend == null) {
      return { score, required: REQUIRED_SCORE, reasons: ['M15 EMA200 not yet computed (warmup)'] };
    }
    const m15Aligned = isSell
      ? m15bar.close < m15bar.emaTrend
      : m15bar.close > m15bar.emaTrend;
    if (!m15Aligned) {
      const trendLabel = isSell ? 'bullish' : 'bearish';
      return {
        score,
        required: REQUIRED_SCORE,
        reasons : [`M15 trend is ${trendLabel} — ${direction} blocked`],
      };
    }
    score++;
    reasons.push(
      `M15 price(${m15bar.close}) ${isSell ? '<' : '>'} M15 EMA${ind.emaTrend}(${m15bar.emaTrend.toFixed(2)})`
    );

    // [M3] M5 EMA5/EMA13 Alignment + recent cross within 3 bars
    // EMA must be crossed in the signal direction AND the cross must have occurred
    // within the last 3 bars (15 min window) — not a stale cross from hours ago.
    if (bar.emaFast == null || bar.emaSlow == null) {
      return { score, required: REQUIRED_SCORE, reasons: [...reasons, 'M5 EMA not computed'] };
    }
    const emaAligned = isSell ? bar.emaFast < bar.emaSlow : bar.emaFast > bar.emaSlow;
    if (!emaAligned) {
      return {
        score,
        required: REQUIRED_SCORE,
        reasons : [...reasons, `EMA${ind.emaFast} not ${isSell ? 'below' : 'above'} EMA${ind.emaSlow}`],
      };
    }
    // Check that the cross happened within the last 5 bars (25 min window) — so we don't enter a stale trend mid-move
    const lookback = m5Candles.slice(-6);  // current bar + up to 5 bars before
    const recentCross = lookback.some((b, i) => {
      if (i === 0 || b.emaFast == null || lookback[i - 1].emaFast == null) return false;
      return isSell
        ? (lookback[i - 1].emaFast >= lookback[i - 1].emaSlow) && (b.emaFast < b.emaSlow)
        : (lookback[i - 1].emaFast <= lookback[i - 1].emaSlow) && (b.emaFast > b.emaSlow);
    });
    if (!recentCross) {
      return {
        score,
        required: REQUIRED_SCORE,
        reasons : [...reasons, `EMA${ind.emaFast}/${ind.emaSlow} cross too stale (>5 bars ago)`],
      };
    }
    score++;
    reasons.push(
      `EMA${ind.emaFast}(${bar.emaFast.toFixed(2)}) ${isSell ? 'below' : 'above'} EMA${ind.emaSlow}(${bar.emaSlow.toFixed(2)}) — recent cross`
    );

    // ── Scoring Gates (need ≥ 2 of the 4 below) ──────────────────────────────

    // [S1] M5 EMA200 Trend Alignment
    // Both M5 and M15 aligned = stronger confluence; single-TF counter-trend misses this gate.
    if (bar.emaTrend != null) {
      const m5Aligned = isSell ? bar.close < bar.emaTrend : bar.close > bar.emaTrend;
      if (m5Aligned) {
        score++;
        reasons.push(
          `M5 price(${bar.close}) ${isSell ? '<' : '>'} M5 EMA${ind.emaTrend}(${bar.emaTrend.toFixed(2)})`
        );
      }
    }

    // [S2] RSI Exhaustion — overbought/oversold AND rolling over/up
    // "Overbought can stay overbought" — we need the slope to confirm reversal.
    const { rsi, rsiSlope } = bar;
    if (rsi != null && rsiSlope != null) {
      const rsiHit = isSell
        ? rsi > ind.rsiOverbought && rsiSlope < 0
        : rsi < ind.rsiOversold   && rsiSlope > 0;
      if (rsiHit) {
        score++;
        reasons.push(
          `RSI(${rsi.toFixed(1)}) ${isSell ? 'overbought+falling' : 'oversold+rising'} (slope ${rsiSlope.toFixed(1)})`
        );
      }
    }

    // [S3] MACD Histogram Momentum
    // Histogram turning in the signal direction = momentum shifting before price does.
    if (bar.macdHist != null && prev.macdHist != null) {
      const macdHit = isSell
        ? bar.macdHist < prev.macdHist   // shrinking / going negative
        : bar.macdHist > prev.macdHist;  // growing / going positive
      if (macdHit) {
        score++;
        reasons.push(
          `MACD hist ${isSell ? 'falling' : 'rising'} (${prev.macdHist.toFixed(3)}→${bar.macdHist.toFixed(3)})`
        );
      }
    }

    // [S4] Stochastic K/D Cross inside extreme zone
    // K crossing D while in the OB/OS zone = exhaustion cross, not a midrange noise cross.
    if (bar.stochK != null && bar.stochD != null &&
        prev.stochK != null && prev.stochD != null) {
      const stochCrossDown = (prev.stochK >= prev.stochD) && (bar.stochK < bar.stochD);
      const stochCrossUp   = (prev.stochK <= prev.stochD) && (bar.stochK > bar.stochD);
      const stochInZone    = isSell ? bar.stochK > ind.stochOb : bar.stochK < ind.stochOs;
      const stochHit       = isSell
        ? stochCrossDown && stochInZone
        : stochCrossUp   && stochInZone;
      if (stochHit) {
        score++;
        reasons.push(
          `Stoch K(${bar.stochK.toFixed(1)}) crossed ${isSell ? 'below' : 'above'} D(${bar.stochD.toFixed(1)}) in ${isSell ? 'OB' : 'OS'} zone`
        );
      }
    }

    return { score, required: REQUIRED_SCORE, reasons };
  }

  // ── Signal Construction ────────────────────────────────────────────────────

  _buildSignal(direction, bar, atr, evalResult) {
    const levels = this._calculateLevels(direction, bar.close, atr, bar);
    if (!levels) {
      this.lastBar[direction].reasons.push('Level calculation failed (SL ≤ entry)');
      return null;
    }

    const { entry, sl, tp } = levels;
    const slDist = Math.abs(sl - entry);
    const tpDist = Math.abs(tp - entry);
    const rr     = slDist > 0 ? tpDist / slDist : 0;

    if (rr < str.minRrRatio) {
      this.lastBar[direction].reasons.push(`R:R ${rr.toFixed(2)} below minimum ${str.minRrRatio}`);
      return null;
    }

    return {
      direction,
      entryPrice    : round2(entry),
      stopLoss      : round2(sl),
      takeProfit    : round2(tp),
      rrRatio       : round2(rr),
      score         : evalResult.score,
      requiredScore : REQUIRED_SCORE,
      atr           : round2(atr),
      isCounterTrend: false,
      reasons       : evalResult.reasons,
      timestamp     : bar.time,
    };
  }

  // ── Level Construction ────────────────────────────────────────────────────

  /**
   * Compute SL and TP for both directions.
   *
   * SELL — SL is ABOVE entry:
   *   structural: last swing high + 0.2×ATR  (just above the swing)
   *   ATR-based : entry + slAtrMult × ATR    (fixed fallback)
   *   Take the WIDER — protects against stop hunts on thin pullbacks.
   *   Hard floor: SL ≥ entry + 1×ATR
   *   TP = entry − SL_distance × tpSlMult
   *
   * BUY — SL is BELOW entry (mirror logic):
   *   structural: last swing low − 0.2×ATR
   *   Hard floor: SL ≤ entry − 1×ATR
   *   TP = entry + SL_distance × tpSlMult
   */
  _calculateLevels(direction, price, atr, bar) {
    if (direction === 'sell') {
      const atrSl    = price + atr * str.slAtrMult;
      const structSl = bar.lastSH != null ? bar.lastSH + 0.2 * atr : atrSl;
      let sl         = Math.max(atrSl, structSl);
      sl             = Math.max(sl, price + atr);   // floor: noise must not clip stop
      if (sl <= price) return null;
      const slDist   = sl - price;
      const tp       = price - slDist * str.tpSlMult;
      return { entry: price, sl, tp };
    } else {
      const atrSl    = price - atr * str.slAtrMult;
      const structSl = bar.lastSL != null ? bar.lastSL - 0.2 * atr : atrSl;
      let sl         = Math.min(atrSl, structSl);
      sl             = Math.min(sl, price - atr);   // floor: 1×ATR below entry
      if (sl >= price) return null;
      const slDist   = price - sl;
      const tp       = price + slDist * str.tpSlMult;
      return { entry: price, sl, tp };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const round2 = v => Math.round(v * 100) / 100;

export function formatSignal(signal) {
  return (
    `[${signal.direction.toUpperCase()}] @ ${signal.entryPrice} | ` +
    `SL: ${signal.stopLoss} | TP: ${signal.takeProfit} | ` +
    `R:R ${signal.rrRatio} | Score: ${signal.score}/${signal.requiredScore} | ` +
    `ATR: ${signal.atr} | ${signal.reasons.join(' · ')}`
  );
}
