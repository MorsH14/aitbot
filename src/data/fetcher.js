/**
 * src/data/fetcher.js — Market Data Fetcher (MetaAPI / Exness MT5)
 * =================================================================
 * Uses the official `metaapi.cloud` Node.js SDK to connect to your
 * Exness MT5 demo/live account and fetch XAU/USD candle data.
 *
 * Why MetaAPI?
 *   - Works with Exness and every other MT5 broker (Nigeria-friendly)
 *   - Official Node.js SDK with proper async/await
 *   - Handles reconnects and synchronisation automatically
 *   - Returns standardised candle data regardless of broker
 *
 * Candle format returned by all public methods:
 *   { time: Date, open, high, low, close, volume }
 */

import { createReadStream } from 'fs';
import { parse }            from 'csv-parse';
import CFG                  from '../../config.js';

// ── MetaAPI connection builder ────────────────────────────────────────────────

async function buildMetaApiConnection() {
  if (!CFG.broker.metaapiToken || !CFG.broker.metaapiAccountId) {
    return null;
  }

  const { default: MetaApi } = await import('metaapi.cloud-sdk');
  const api     = new MetaApi(CFG.broker.metaapiToken);
  const account = await api.metatraderAccountApi.getAccount(CFG.broker.metaapiAccountId);

  // Deploy if not already running (first launch takes ~30s)
  if (!['DEPLOYING', 'DEPLOYED'].includes(account.state)) {
    console.info('[Fetcher] Deploying MetaAPI account — first time takes ~30s...');
    await account.deploy();
  }
  await account.waitDeployed();

  const connection = account.getRPCConnection();
  await connection.connect();
  await connection.waitSynchronized();

  console.info('[Fetcher] MetaAPI connected to Exness MT5 ✓');
  return { api, account, connection };
}

// ── MetaApiDataFetcher ────────────────────────────────────────────────────────

export class MetaApiDataFetcher {
  constructor() {
    this._conn  = null;
    this._ready = false;
  }

  /**
   * Must be called once at bot startup before any other method.
   * Establishes the MT5 connection via MetaAPI cloud.
   */
  async init() {
    const result = await buildMetaApiConnection();
    if (!result) {
      console.warn('[Fetcher] No MetaAPI credentials — CSV/mock mode only.');
      return;
    }
    this._conn  = result.connection;
    this._ready = true;
  }

  /**
   * Fetch OHLCV candles for the configured symbol.
   *
   * @param {string} timeframe  e.g. '5m', '15m', '1h'
   * @param {number} count      Number of completed candles
   * @returns {Promise<Array<{time,open,high,low,close,volume}>>}
   */
  async getCandles(timeframe, count = 300) {
    if (!this._ready) return this._loadFromCsv();

    try {
      // MetaAPI returns newest-first — reverse to oldest-first
      const raw = await this._conn.getHistoricalCandles(
        CFG.instrument.symbol,
        timeframe,
        new Date(),
        count,
      );
      return raw.slice().reverse().map(c => ({
        time   : new Date(c.time),
        open   : c.open,
        high   : c.high,
        low    : c.low,
        close  : c.close,
        volume : c.tickVolume ?? 0,
      }));
    } catch (err) {
      console.error('[Fetcher] getCandles error:', err.message);
      throw err;
    }
  }

  /**
   * Fetch account balance, equity, and margin info.
   * @returns {Promise<{balance, equity, margin}>}
   */
  async getAccountSummary() {
    if (!this._ready) {
      return { balance: CFG.backtest.initialEquity, equity: CFG.backtest.initialEquity };
    }
    return this._conn.getAccountInformation();
  }

  /**
   * Fetch all currently open positions (trades).
   * @returns {Promise<Array>}
   */
  async getOpenTrades() {
    if (!this._ready) return [];
    return this._conn.getPositions();
  }

  /** Load candles from local CSV (used when not connected to MetaAPI). */
  async _loadFromCsv() {
    const path = CFG.backtest.dataPath;
    return new Promise((resolve, reject) => {
      const rows = [];
      createReadStream(path)
        .pipe(parse({ columns: true, skip_empty_lines: true }))
        .on('data', row => rows.push({
          time   : new Date(row.time),
          open   : parseFloat(row.open),
          high   : parseFloat(row.high),
          low    : parseFloat(row.low),
          close  : parseFloat(row.close),
          volume : parseInt(row.volume, 10) || 0,
        }))
        .on('end',   () => resolve(rows.sort((a, b) => a.time - b.time)))
        .on('error', reject);
    });
  }

  /** Close the MetaAPI connection gracefully on shutdown. */
  async close() {
    if (this._conn) {
      await this._conn.close();
      console.info('[Fetcher] MetaAPI connection closed.');
    }
  }
}

// ── MockDataFetcher ───────────────────────────────────────────────────────────

/**
 * Generates synthetic M5 XAU/USD candles for offline/backtest testing.
 * No credentials or network required.
 */
export class MockDataFetcher {
  async init() {}

  async getCandles(timeframe, count = 300) {
    const candles  = [];
    let   price    = 2350.0;
    const now      = Date.now();
    const interval = 5 * 60 * 1000;  // 5 minutes in ms

    for (let i = count - 1; i >= 0; i--) {
      const chg = (Math.random() - 0.5) * 1.5;  // ±$0.75 typical M5 move
      const o   = price;
      const c   = price + chg;
      const h   = Math.max(o, c) + Math.random() * 0.3;
      const l   = Math.min(o, c) - Math.random() * 0.3;

      candles.push({
        time   : new Date(now - i * interval),
        open   : parseFloat(o.toFixed(2)),
        high   : parseFloat(h.toFixed(2)),
        low    : parseFloat(l.toFixed(2)),
        close  : parseFloat(c.toFixed(2)),
        volume : Math.floor(200 + Math.random() * 1000),
      });
      price = c;
    }
    return candles;
  }

  async getAccountSummary() {
    return { balance: CFG.backtest.initialEquity, equity: CFG.backtest.initialEquity };
  }

  async getOpenTrades() { return []; }
  async close()         {}
}
