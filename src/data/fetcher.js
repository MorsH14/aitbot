/**
 * src/data/fetcher.js — Market Data Fetcher (Deriv.com WebSocket API)
 * ====================================================================
 * Uses the free Deriv WebSocket API to stream XAU/USD candle data.
 *
 * Why Deriv?
 *   - 100% free, no subscription, no credit card
 *   - Works in Nigeria and worldwide
 *   - Official WebSocket API with full documentation
 *   - Real XAU/USD (frxXAUUSD) pricing from live markets
 *
 * Candle format returned by all public methods:
 *   { time: Date, open, high, low, close, volume }
 *
 * Deriv candle granularity is in SECONDS:
 *   M5=300, M15=900, H1=3600
 *
 * API docs: https://api.deriv.com/
 */

import { createReadStream, existsSync } from "fs";
import { parse } from "csv-parse";
import { DerivClient } from "./derivClient.js";
import CFG from "../../config.js";

// Map human-readable timeframe strings to Deriv granularity (seconds)
const TF_TO_SECONDS = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

// ── DerivDataFetcher ──────────────────────────────────────────────────────────

export class DerivDataFetcher {
  constructor() {
    this._client = null;
    this._ready = false;
  }

  /**
   * Must be called once at bot startup before any other method.
   * Establishes the Deriv WebSocket connection and authenticates.
   */
  async init() {
    const { appId, derivToken } = CFG.broker;
    if (!appId) {
      console.warn("[Fetcher] No DERIV_APP_ID set — CSV/mock mode only.");
      return;
    }
    try {
      this._client = new DerivClient(appId, derivToken || "");
      await this._client.connect();
      this._ready = true;
    } catch (err) {
      console.error("[Fetcher] Failed to connect to Deriv:", err.message);
      this._client = null;
    }
  }

  /**
   * Fetch OHLCV candles for the configured symbol.
   *
   * @param {string} timeframe  e.g. '5m', '15m', '1h'
   * @param {number} count      Number of completed candles to fetch
   * @returns {Promise<Array<{time,open,high,low,close,volume}>>}
   */
  async getCandles(timeframe, count = 300) {
    if (!this._ready) return this._loadFromCsv();

    const granularity = TF_TO_SECONDS[timeframe] ?? 300;

    try {
      // Use end:'latest' + count so Deriv counts back through actual trading bars,
      // skipping weekends/market-close gaps automatically.
      const res = await this._client.send({
        ticks_history: CFG.instrument.symbol,
        style: "candles",
        granularity,
        end: "latest",
        count,
        adjust_start_time: 1,
      });

      if (!res.candles || !res.candles.length) {
        console.warn(
          `[Fetcher] No candles returned for ${timeframe}. Using CSV.`,
        );
        return this._loadFromCsv();
      }

      // Deriv candle shape: { epoch, open, high, low, close }
      // No volume from Deriv — use 0 as placeholder
      return res.candles.map((c) => ({
        time: new Date(c.epoch * 1000),
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: 0,
      }));
    } catch (err) {
      console.error("[Fetcher] getCandles error:", err.message);
      throw err;
    }
  }

  /**
   * Fetch account balance and equity from Deriv.
   * @returns {Promise<{balance, equity, currency}>}
   */
  async getAccountSummary() {
    if (!this._ready || !this._client?.isReady) {
      return {
        balance: CFG.backtest.initialEquity,
        equity: CFG.backtest.initialEquity,
      };
    }
    try {
      const res = await this._client.send({ balance: 1, account: "current" });
      const bal = res.balance?.balance ?? 0;
      if (bal === 0) {
        console.warn(
          "[Fetcher] Account balance is $0. If this is a demo account, go to\n" +
            "  app.deriv.com → switch to Demo account → API Token → create a new token.\n" +
            "  Real accounts (CR...) need a deposit before trading.",
        );
      }
      return {
        balance: bal,
        equity: bal,
        currency: res.balance?.currency ?? "USD",
      };
    } catch (err) {
      console.warn("[Fetcher] Could not fetch balance:", err.message);
      return {
        balance: CFG.backtest.initialEquity,
        equity: CFG.backtest.initialEquity,
      };
    }
  }

  /**
   * Fetch all currently open Multiplier contracts.
   * @returns {Promise<Array>}
   */
  async getOpenTrades() {
    if (!this._ready || !this._client?.isReady) return [];
    try {
      const res = await this._client.send({ portfolio: 1 });
      // Filter to only multiplier contracts on our symbol
      return (res.portfolio?.contracts ?? []).filter(
        (c) =>
          c.contract_type?.startsWith("MULT") &&
          c.underlying === CFG.instrument.symbol,
      );
    } catch (err) {
      console.warn("[Fetcher] Could not fetch open trades:", err.message);
      return [];
    }
  }

  /** Load candles from local CSV (used when not connected to Deriv API). */
  async _loadFromCsv() {
    const path = CFG.backtest.dataPath;
    if (!existsSync(path)) {
      console.warn(`[Fetcher] CSV file not found: ${path}`);
      console.warn(
        "[Fetcher] Place a XAUUSD_M5.csv in data/historical/ for offline use.",
      );
      return [];
    }
    return new Promise((resolve, reject) => {
      const rows = [];
      createReadStream(path)
        .pipe(parse({ columns: true, skip_empty_lines: true }))
        .on("data", (row) =>
          rows.push({
            time: new Date(row.time),
            open: parseFloat(row.open),
            high: parseFloat(row.high),
            low: parseFloat(row.low),
            close: parseFloat(row.close),
            volume: parseInt(row.volume, 10) || 0,
          }),
        )
        .on("end", () => resolve(rows.sort((a, b) => a.time - b.time)))
        .on("error", reject);
    });
  }

  /** Close the Deriv WebSocket connection gracefully. */
  async close() {
    if (this._client) {
      this._client.close();
    }
  }
}

// For backwards-compat with backtest engine (engine.js imports MetaApiDataFetcher)
export { DerivDataFetcher as MetaApiDataFetcher };

// ── MockDataFetcher ───────────────────────────────────────────────────────────

/**
 * Generates synthetic M5 XAU/USD candles for offline/backtest testing.
 * No credentials or network required.
 */
export class MockDataFetcher {
  async init() {}

  async getCandles(timeframe, count = 300) {
    const candles = [];
    let price    = 2350.0;
    const now    = Date.now();
    const tfMs   = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };
    const interval = tfMs[timeframe] ?? 300_000;

    // Simulate realistic trending gold: longer cycles so M15 EMA stacks align.
    // Drift ± noise model calibrated to real gold M5 volatility (ATR ~$2-3).
    let trendDir      = 1;
    let barsInTrend   = 0;
    let trendDuration = 120 + Math.floor(Math.random() * 180); // 2-5 hours per leg

    for (let i = count - 1; i >= 0; i--) {
      barsInTrend++;
      if (barsInTrend >= trendDuration) {
        trendDir      = -trendDir;
        barsInTrend   = 0;
        trendDuration = 120 + Math.floor(Math.random() * 180);
      }

      // Drift 0.25 per bar + noise ±$1.50 → ATR ~$2, matches real gold M5
      const drift = trendDir * 0.25;
      const noise = (Math.random() - 0.5) * 3.0;
      const chg   = drift + noise;

      const o = price;
      const c = price + chg;
      const wickUp   = Math.random() * (trendDir === -1 ? 1.0 : 0.5);
      const wickDown = Math.random() * (trendDir ===  1 ? 1.0 : 0.5);
      const h = Math.max(o, c) + wickUp;
      const l = Math.min(o, c) - wickDown;

      candles.push({
        time  : new Date(now - i * interval),
        open  : parseFloat(o.toFixed(2)),
        high  : parseFloat(h.toFixed(2)),
        low   : parseFloat(l.toFixed(2)),
        close : parseFloat(c.toFixed(2)),
        volume: Math.floor(200 + Math.random() * 1000),
      });
      price = c;
    }
    return candles;
  }

  async getAccountSummary() {
    return {
      balance: CFG.backtest.initialEquity,
      equity: CFG.backtest.initialEquity,
    };
  }

  async getOpenTrades() {
    return [];
  }
  async close() {}
}
