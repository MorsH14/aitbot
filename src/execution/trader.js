/**
 * src/execution/trader.js — Order Execution Engine (MetaAPI / Exness MT5)
 * =========================================================================
 * Places market orders through the MetaAPI RPC connection to your MT5 account.
 *
 * Key notes for MT5 / MetaAPI:
 *   - Volume is in LOTS, not units.  1 lot XAU/USD = 100 oz.
 *   - Minimum lot on Exness: 0.01 (= 1 oz)
 *   - Position sizing: lots = riskAmount / (slDistance × ozPerLot)
 *   - SL/TP are price levels, same as any MT5 order
 *   - MetaAPI positions have an `id` field used for modifications and closes
 *
 * Paper mode:
 *   If the fetcher is not connected (no credentials), all orders are simulated
 *   locally and logged — nothing is sent to the broker.
 */

import CFG from '../../config.js';

export class TradeExecutor {
  /**
   * @param {RiskManager} riskManager
   * @param {Object|null} connection  MetaAPI RPC connection (from fetcher._conn), or null for paper
   */
  constructor(riskManager, connection = null) {
    this._risk  = riskManager;
    this._conn  = connection;
    this._paper = (connection === null);
    if (this._paper) {
      console.warn('[Executor] PAPER mode — no real orders will be placed.');
    }
  }

  // ── Place Order ───────────────────────────────────────────────────────────

  /**
   * Place a market BUY or SELL order for the given signal.
   *
   * Position sizing (MT5 lots):
   *   riskAmount = equity × (maxRiskPct / 100)     [capped at maxRiskUsd]
   *   slDistance = |entryPrice − stopLoss|          [in USD]
   *   lots       = riskAmount / (slDistance × 100)  [100 oz per lot]
   *   lots       = max(lots, 0.01)                  [minimum 0.01 lots]
   *
   * @param {Signal} signal
   * @returns {Promise<Object|null>}
   */
  async placeOrder(signal) {
    const lots = this._calculateLots(signal);
    if (lots <= 0) {
      console.error('[Executor] Order rejected: lot size is 0.');
      return null;
    }

    const p = CFG.instrument.pricePrecision;

    const result = this._paper
      ? this._paperOrder(signal, lots)
      : await this._liveOrder(signal, lots, p);

    if (result) {
      this._risk.recordTradeOpened();
      console.info(
        `[Executor] ORDER PLACED: ${signal.direction.toUpperCase()} ` +
        `${lots} lots ${CFG.instrument.symbol} @ ${signal.entryPrice} | ` +
        `SL: ${signal.stopLoss} | TP: ${signal.takeProfit}`
      );
    }
    return result;
  }

  // ── Trailing Stop Updates ─────────────────────────────────────────────────

  /**
   * Review open positions and update SL if trailing conditions are met.
   *
   * @param {Array}  openPositions  From fetcher.getOpenTrades() — MetaAPI position objects
   * @param {number} currentPrice
   * @param {number} currentAtr
   */
  async updateTrailingStops(openPositions, currentPrice, currentAtr) {
    for (const pos of openPositions) {
      const posId     = pos.id;
      const entry     = pos.openPrice;
      const direction = pos.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell';
      const currentSl = pos.stopLoss;
      if (!currentSl) continue;

      const newSl = this._risk.calculateTrailingStop(
        direction, entry, currentPrice, currentAtr, currentSl
      );

      if (Math.abs(newSl - currentSl) > 0.01) {
        await this._modifyPositionSl(posId, newSl, pos.takeProfit);
      }
    }
  }

  // ── Close Trade ───────────────────────────────────────────────────────────

  /**
   * Close a specific open position at market price.
   * @param {string} positionId  MetaAPI position ID
   * @param {string} [reason]
   */
  async closeTrade(positionId, reason = 'manual') {
    console.info(`[Executor] Closing position ${positionId} — ${reason}`);
    if (this._paper) return { id: positionId, reason };

    try {
      const result = await this._conn.closePosition(positionId);
      return result;
    } catch (err) {
      console.error(`[Executor] Failed to close position ${positionId}:`, err.message);
      return null;
    }
  }

  /**
   * Close ALL open positions — used for emergency shutdown or daily limit breach.
   */
  async closeAllPositions(reason = 'emergency') {
    console.warn(`[Executor] CLOSING ALL POSITIONS — ${reason}`);
    if (this._paper) { console.info('[PAPER] All positions closed.'); return; }

    try {
      const positions = await this._conn.getPositions();
      for (const pos of positions) {
        await this._conn.closePosition(pos.id);
        console.info(`[Executor] Closed position ${pos.id} (${pos.symbol})`);
      }
    } catch (err) {
      console.error('[Executor] Error closing all positions:', err.message);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Calculate lot size from signal's SL distance and account risk rules.
   *
   * For XAU/USD on MT5:
   *   1 lot = 100 oz
   *   P/L per lot = (exit - entry) × 100
   *   So: lots = riskAmount / (slDistance × 100)
   */
  _calculateLots(signal) {
    const r = CFG.risk;
    let riskAmount = this._risk.equity * (r.maxRiskPct / 100);
    riskAmount = Math.min(riskAmount, r.maxRiskUsd);

    const slDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    if (slDistance <= 0) return 0;

    // Round to 2 decimal places (MT5 lot precision)
    const lots = Math.floor((riskAmount / (slDistance * CFG.instrument.ozPerLot)) * 100) / 100;
    return Math.max(lots, CFG.instrument.minLots);
  }

  async _liveOrder(signal, lots, p) {
    try {
      if (signal.direction === 'buy') {
        return await this._conn.createMarketBuyOrder(
          CFG.instrument.symbol,
          lots,
          parseFloat(signal.stopLoss.toFixed(p)),
          parseFloat(signal.takeProfit.toFixed(p)),
          { comment: `bot-score${signal.score}` },
        );
      } else {
        return await this._conn.createMarketSellOrder(
          CFG.instrument.symbol,
          lots,
          parseFloat(signal.stopLoss.toFixed(p)),
          parseFloat(signal.takeProfit.toFixed(p)),
          { comment: `bot-score${signal.score}` },
        );
      }
    } catch (err) {
      console.error('[Executor] Order failed:', err.message);
      return null;
    }
  }

  _paperOrder(signal, lots) {
    return {
      paper        : true,
      positionId   : `PAPER-${Date.now()}`,
      direction    : signal.direction,
      lots,
      entryPrice   : signal.entryPrice,
      stopLoss     : signal.stopLoss,
      takeProfit   : signal.takeProfit,
      time         : new Date().toISOString(),
    };
  }

  async _modifyPositionSl(positionId, newSl, currentTp) {
    if (this._paper) {
      console.debug(`[PAPER] Trailing SL: position ${positionId} → ${newSl.toFixed(2)}`);
      return;
    }
    try {
      const p = CFG.instrument.pricePrecision;
      await this._conn.modifyPosition(
        positionId,
        parseFloat(newSl.toFixed(p)),
        currentTp ? parseFloat(currentTp.toFixed(p)) : undefined,
      );
      console.info(`[Executor] Trailing SL updated: ${positionId} → ${newSl.toFixed(2)}`);
    } catch (err) {
      console.error(`[Executor] Failed to modify SL for ${positionId}:`, err.message);
    }
  }
}
