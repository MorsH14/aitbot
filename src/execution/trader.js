/**
 * src/execution/trader.js — Order Execution Engine (Deriv.com Multipliers)
 * ==========================================================================
 * Places Multiplier contracts through the Deriv WebSocket API.
 *
 * How Deriv Multipliers work (vs MT5 lots):
 *   - You open a MULTUP (long) or MULTDOWN (short) contract with a USD stake
 *   - A multiplier (e.g. 100×) amplifies the underlying price movement
 *   - P/L = stake × multiplier × (priceChange / entryPrice)
 *   - SL and TP are expressed in USD loss/profit amounts (not price levels)
 *
 * Stake calculation:
 *   riskAmount  = equity × (maxRiskPct / 100)      capped at maxRiskUsd
 *   slDistance  = |entryPrice − stopLoss|           in USD (price)
 *   slPercent   = slDistance / entryPrice
 *   stake       = riskAmount / (multiplier × slPercent)
 *   stopLossUsd = riskAmount                        (USD amount to lose if SL hit)
 *   takeProfitUsd = riskAmount × rrRatio            (USD amount to win if TP hit)
 *
 * Paper mode:
 *   If no DerivClient is provided (no credentials), orders are simulated
 *   locally and logged — nothing is sent to Deriv.
 */

import CFG from '../../config.js';

export class TradeExecutor {
  /**
   * @param {RiskManager}   riskManager
   * @param {DerivClient|null} derivClient  From fetcher._client, or null for paper mode
   */
  constructor(riskManager, derivClient = null) {
    this._risk   = riskManager;
    this._client = derivClient;
    this._paper  = (derivClient === null || !derivClient.isReady);
    if (this._paper) {
      console.warn('[Executor] PAPER mode — no real orders will be placed.');
    }
  }

  // ── Place Order ───────────────────────────────────────────────────────────

  /**
   * Open a Multiplier contract for the given signal.
   *
   * @param {Signal} signal  From SignalGenerator — includes direction, entryPrice, stopLoss, takeProfit, rrRatio
   * @returns {Promise<Object|null>}
   */
  async placeOrder(signal) {
    const { stake, stopLossUsd, takeProfitUsd } = this._calculateStake(signal);

    if (stake < CFG.instrument.minStake) {
      console.error(`[Executor] Order rejected: stake $${stake.toFixed(2)} below minimum $${CFG.instrument.minStake}.`);
      return null;
    }

    const contractType = signal.direction === 'buy' ? 'MULTUP' : 'MULTDOWN';

    const result = this._paper
      ? this._paperOrder(signal, stake, stopLossUsd, takeProfitUsd, contractType)
      : await this._liveOrder(signal, stake, stopLossUsd, takeProfitUsd, contractType);

    if (result) {
      this._risk.recordTradeOpened();
      console.info(
        `[Executor] ORDER PLACED: ${contractType} ${CFG.instrument.symbol} | ` +
        `Stake: $${stake.toFixed(2)} | SL: -$${stopLossUsd.toFixed(2)} | TP: +$${takeProfitUsd.toFixed(2)}`
      );
    }
    return result;
  }

  // ── Trailing Stop Updates ─────────────────────────────────────────────────

  /**
   * Review open Multiplier contracts and update SL if trailing conditions are met.
   * For Deriv, the trailing SL is expressed in USD, so we compute the new
   * USD stop amount based on the current unrealised P/L.
   *
   * @param {Array}  openContracts  From fetcher.getOpenTrades()
   * @param {number} currentPrice
   * @param {number} currentAtr
   */
  async updateTrailingStops(openContracts, currentPrice, currentAtr) {
    for (const contract of openContracts) {
      const contractId   = contract.contract_id;
      const direction    = contract.contract_type === 'MULTUP' ? 'buy' : 'sell';
      const entryPrice   = contract.buy_price ? (contract.buy_price / contract.multiplier) : currentPrice;
      const currentSlUsd = contract.limit_order?.stop_loss?.order_amount ?? null;

      if (!currentSlUsd) continue;

      // Compute the new price-level SL using existing risk logic, then convert back to USD
      const currentSlPrice = this._risk.calculateTrailingStop(
        direction, entryPrice, currentPrice, currentAtr,
        direction === 'buy'
          ? entryPrice - (currentSlUsd / (contract.multiplier || CFG.instrument.multiplier))
          : entryPrice + (currentSlUsd / (contract.multiplier || CFG.instrument.multiplier))
      );

      const newSlDistance = Math.abs(entryPrice - currentSlPrice);
      const newSlUsd      = newSlDistance * (contract.multiplier || CFG.instrument.multiplier);

      if (Math.abs(newSlUsd - currentSlUsd) > 0.01) {
        await this._modifyContractSl(contractId, newSlUsd);
      }
    }
  }

  // ── Close Trade ───────────────────────────────────────────────────────────

  /**
   * Close (sell) a specific open Multiplier contract.
   * @param {number} contractId  Deriv contract_id
   * @param {string} [reason]
   */
  async closeTrade(contractId, reason = 'manual') {
    console.info(`[Executor] Closing contract ${contractId} — ${reason}`);
    if (this._paper) return { contract_id: contractId, reason };

    try {
      const res = await this._client.send({ sell: contractId, price: 0 });
      if (res.error) throw new Error(res.error.message);
      console.info(`[Executor] Contract ${contractId} closed. Sold at: ${res.sell?.sold_for}`);
      return res.sell;
    } catch (err) {
      console.error(`[Executor] Failed to close contract ${contractId}:`, err.message);
      return null;
    }
  }

  /**
   * Close ALL open Multiplier contracts — used for emergency or daily limit breach.
   */
  async closeAllPositions(reason = 'emergency') {
    console.warn(`[Executor] CLOSING ALL POSITIONS — ${reason}`);
    if (this._paper) { console.info('[PAPER] All positions closed.'); return; }

    try {
      const res = await this._client.send({ portfolio: 1 });
      const contracts = (res.portfolio?.contracts ?? []).filter(c =>
        c.contract_type?.startsWith('MULT') && c.underlying === CFG.instrument.symbol
      );
      for (const c of contracts) {
        await this.closeTrade(c.contract_id, reason);
      }
    } catch (err) {
      console.error('[Executor] Error closing all positions:', err.message);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Calculate the USD stake and SL/TP amounts from the signal.
   *
   * Formula:
   *   slPercent   = slDistance / entryPrice
   *   stake       = riskAmount / (multiplier × slPercent)
   *   stopLossUsd = riskAmount                         (the USD amount at risk)
   *   takeProfitUsd = riskAmount × rrRatio
   */
  _calculateStake(signal) {
    const r = CFG.risk;
    let riskAmount = this._risk.equity * (r.maxRiskPct / 100);
    riskAmount = Math.min(riskAmount, r.maxRiskUsd);

    const slDistance  = Math.abs(signal.entryPrice - signal.stopLoss);
    if (slDistance <= 0) return { stake: 0, stopLossUsd: 0, takeProfitUsd: 0 };

    const slPercent    = slDistance / signal.entryPrice;
    const multiplier   = CFG.instrument.multiplier;
    const stake        = riskAmount / (multiplier * slPercent);
    const stopLossUsd  = riskAmount;
    const takeProfitUsd = riskAmount * (signal.rrRatio ?? CFG.strategy.tpSlMult);

    return {
      stake        : Math.max(parseFloat(stake.toFixed(2)), CFG.instrument.minStake),
      stopLossUsd  : parseFloat(stopLossUsd.toFixed(2)),
      takeProfitUsd: parseFloat(takeProfitUsd.toFixed(2)),
    };
  }

  async _liveOrder(signal, stake, stopLossUsd, takeProfitUsd, contractType) {
    try {
      // Step 1 — Get a price proposal
      const proposalRes = await this._client.send({
        proposal      : 1,
        contract_type : contractType,
        symbol        : CFG.instrument.symbol,
        amount        : stake,
        basis         : 'stake',
        currency      : 'USD',
        multiplier    : CFG.instrument.multiplier,
        limit_order   : {
          stop_loss  : stopLossUsd,
          take_profit: takeProfitUsd,
        },
      });

      if (proposalRes.error) throw new Error(proposalRes.error.message);
      const proposalId = proposalRes.proposal?.id;
      if (!proposalId) throw new Error('No proposal ID returned by Deriv');

      // Step 2 — Buy the proposal
      const buyRes = await this._client.send({
        buy   : proposalId,
        price : stake,
      });

      if (buyRes.error) throw new Error(buyRes.error.message);
      return buyRes.buy;
    } catch (err) {
      console.error('[Executor] Order failed:', err.message);
      return null;
    }
  }

  _paperOrder(signal, stake, stopLossUsd, takeProfitUsd, contractType) {
    return {
      paper         : true,
      contract_id   : `PAPER-${Date.now()}`,
      contract_type : contractType,
      direction     : signal.direction,
      stake,
      stop_loss_usd  : stopLossUsd,
      take_profit_usd: takeProfitUsd,
      entry_price   : signal.entryPrice,
      time          : new Date().toISOString(),
    };
  }

  async _modifyContractSl(contractId, newSlUsd) {
    if (this._paper) {
      console.debug(`[PAPER] Trailing SL: contract ${contractId} → -$${newSlUsd.toFixed(2)}`);
      return;
    }
    try {
      const res = await this._client.send({
        contract_update : contractId,
        limit_order     : { stop_loss: parseFloat(newSlUsd.toFixed(2)) },
      });
      if (res.error) throw new Error(res.error.message);
      console.info(`[Executor] Trailing SL updated: contract ${contractId} → -$${newSlUsd.toFixed(2)}`);
    } catch (err) {
      console.error(`[Executor] Failed to modify SL for ${contractId}:`, err.message);
    }
  }
}
