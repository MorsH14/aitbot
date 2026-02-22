/**
 * src/risk/manager.js — Risk Management Engine
 * =============================================
 * Enforces all rules BEFORE any order is sent.
 *
 * Core rules:
 *   1. 1% max risk per trade  — position size = (equity × 1%) / SL_distance
 *   2. Hard USD cap per trade — never exceed maxRiskUsd regardless of account size
 *   3. Max 2 open positions   — prevents correlated gold over-exposure
 *   4. 3% daily drawdown limit — bot self-pauses for the rest of the day
 *   5. $500 daily USD loss cap — hard fuse
 *   6. Max 5 trades/day       — prevents overtrading on choppy days
 *   7. 15-min cooling period  — one candle gap between consecutive entries
 *   8. Trailing stop          — moves SL to breakeven then trails at 0.8×ATR
 */

import CFG from '../../config.js';

const r = CFG.risk;

export class RiskManager {
  /**
   * @param {number} initialEquity  Starting account balance in USD
   */
  constructor(initialEquity) {
    this.equity        = initialEquity;
    this._peakEquity   = initialEquity;
    this._dailyPnl     = 0;
    this._dayStartEq   = initialEquity;
    this._tradeCount   = 0;
    this._lastTradeTime = null;
    this._sessionDate  = _todayUtc();
  }

  // ── Equity Tracking ────────────────────────────────────────────────────────

  updateEquity(newEquity) {
    this.equity      = newEquity;
    this._peakEquity = Math.max(this._peakEquity, newEquity);
  }

  recordTradeClosed(pnl) {
    this._dailyPnl  += pnl;
    this._tradeCount += 1;
  }

  recordTradeOpened() {
    this._lastTradeTime = new Date();
  }

  // ── Pre-trade Check ────────────────────────────────────────────────────────

  /**
   * Master check before any trade is placed.
   * @param {number} openTradeCount  Number of currently open positions
   * @returns {{ allowed: boolean, reason: string }}
   */
  canTrade(openTradeCount) {
    this._resetIfNewDay();

    if (openTradeCount >= r.maxOpenTrades) {
      return { allowed: false, reason: `Max open trades (${openTradeCount}/${r.maxOpenTrades})` };
    }

    const dailyLossPct = (this._dailyPnl / this._dayStartEq) * 100;
    if (dailyLossPct <= -r.maxDailyDrawdownPct) {
      return { allowed: false, reason: `Daily drawdown limit hit (${dailyLossPct.toFixed(1)}%)` };
    }

    if (this._dailyPnl <= -r.maxDailyLossUsd) {
      return { allowed: false, reason: `Daily USD loss limit hit ($${this._dailyPnl.toFixed(2)})` };
    }

    if (this._tradeCount >= 5) {
      return { allowed: false, reason: `Max trades/day reached (${this._tradeCount})` };
    }

    if (this._lastTradeTime) {
      const elapsedMs = Date.now() - this._lastTradeTime.getTime();
      const cooldownMs = 15 * 60 * 1000;
      if (elapsedMs < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - elapsedMs) / 1000);
        return { allowed: false, reason: `Cooling period: ${remainingSec}s remaining` };
      }
    }

    return { allowed: true, reason: '' };
  }

  // ── Position Sizing ────────────────────────────────────────────────────────

  /**
   * Calculate how many units (troy ounces) to trade.
   *
   * Formula:
   *   riskAmount = equity × (maxRiskPct / 100)   [capped at maxRiskUsd]
   *   units      = riskAmount / slDistance
   *
   * @param {Signal} signal
   * @returns {number}  Integer units (≥ 1), or 0 if invalid
   */
  calculatePositionSize(signal) {
    let riskAmount = this.equity * (r.maxRiskPct / 100);
    riskAmount = Math.min(riskAmount, r.maxRiskUsd);  // Hard cap

    const slDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    if (slDistance <= 0) return 0;

    const units = Math.floor(riskAmount / slDistance);
    return Math.max(units, CFG.instrument.minUnits);
  }

  // ── Trailing Stop ──────────────────────────────────────────────────────────

  /**
   * Returns an updated stop-loss price based on trailing logic.
   * Never moves the SL against the position (one-directional ratchet).
   *
   * @param {'buy'|'sell'} direction
   * @param {number} entry         Entry fill price
   * @param {number} currentPrice  Current market price
   * @param {number} atr           Current ATR
   * @param {number} currentSl     Current stop-loss price
   * @returns {number}             New (potentially updated) stop-loss
   */
  calculateTrailingStop(direction, entry, currentPrice, atr, currentSl) {
    const profitDist = direction === 'buy'
      ? currentPrice - entry
      : entry - currentPrice;

    // Not yet in profit territory — keep existing SL
    if (profitDist < atr * r.trailingSlActivationMult) return currentSl;

    const isBuy = direction === 'buy';
    const breakeven  = isBuy ? entry + 0.05 : entry - 0.05;
    const trailLevel = isBuy
      ? currentPrice - atr * r.trailingSlDistanceMult
      : currentPrice + atr * r.trailingSlDistanceMult;

    return isBuy
      ? Math.max(currentSl, breakeven, trailLevel)
      : Math.min(currentSl, breakeven, trailLevel);
  }

  // ── State Summary ──────────────────────────────────────────────────────────

  summary() {
    return {
      equity      : round2(this.equity),
      dailyPnl    : round2(this._dailyPnl),
      tradesToday : this._tradeCount,
      peakEquity  : round2(this._peakEquity),
      drawdownPct : round2(((this.equity - this._peakEquity) / this._peakEquity) * 100),
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _resetIfNewDay() {
    const today = _todayUtc();
    if (today !== this._sessionDate) {
      this._sessionDate = today;
      this._dayStartEq  = this.equity;
      this._dailyPnl    = 0;
      this._tradeCount  = 0;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const round2  = v => Math.round(v * 100) / 100;
const _todayUtc = () => new Date().toISOString().slice(0, 10);
