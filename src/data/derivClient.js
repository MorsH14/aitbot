/**
 * src/data/derivClient.js — Shared Deriv WebSocket Client
 * ========================================================
 * Handles the persistent WebSocket connection to Deriv's API.
 *
 * Features:
 *   - Promise-based send() — each request gets a unique req_id and
 *     resolves when the matching response arrives
 *   - Auto-reconnect with exponential back-off on disconnect
 *   - Re-authenticates automatically after reconnect
 *   - Single shared instance avoids duplicate connections
 *
 * Deriv API docs: https://api.deriv.com/
 * WebSocket URL : wss://ws.binaryws.com/websockets/v3?app_id=APP_ID
 */

import WebSocket from 'ws';

const WS_BASE = 'wss://ws.binaryws.com/websockets/v3';

export class DerivClient {
  /**
   * @param {string} appId   Deriv app_id (use '1089' for testing, register at api.deriv.com)
   * @param {string} token   Deriv API token (from app.deriv.com → Account → Security → API Token)
   */
  constructor(appId, token) {
    this._appId    = appId;
    this._token    = token;
    this._ws       = null;
    this._pending  = new Map();   // reqId → { resolve, reject }
    this._reqId    = 1;
    this._ready    = false;       // true after authorize succeeds
    this._reconnectDelay = 1000;  // ms, doubles on each failed attempt
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Open the WebSocket connection and authenticate.
   * Must be called before any other method.
   */
  async connect() {
    await this._openSocket();
    await this._authorize();
    console.info('[Deriv] Connected and authorised ✓');
  }

  /**
   * Send a request and wait for the matching response.
   *
   * @param {Object} payload  Deriv API request object (without req_id)
   * @param {number} [timeout=30000]  ms before rejecting
   * @returns {Promise<Object>}  The full Deriv response object
   */
  send(payload, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('DerivClient: WebSocket is not open'));
      }

      const reqId = this._reqId++;
      const msg   = { ...payload, req_id: reqId };

      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error(`DerivClient: request ${reqId} timed out (${JSON.stringify(payload)})`));
      }, timeout);

      this._pending.set(reqId, {
        resolve: (data) => { clearTimeout(timer); resolve(data); },
        reject:  (err)  => { clearTimeout(timer); reject(err);   },
      });

      this._ws.send(JSON.stringify(msg));
    });
  }

  /**
   * Close the WebSocket connection gracefully.
   */
  close() {
    this._ready = false;
    if (this._ws) {
      this._ws.removeAllListeners();
      this._ws.close();
      this._ws = null;
    }
    console.info('[Deriv] Connection closed.');
  }

  get isReady() { return this._ready; }

  // ── Internal ──────────────────────────────────────────────────────────────

  _openSocket() {
    return new Promise((resolve, reject) => {
      const url = `${WS_BASE}?app_id=${this._appId}`;
      const ws  = new WebSocket(url);
      this._ws  = ws;

      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));

      ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        // Route to waiting promise
        const reqId = data.req_id;
        if (reqId && this._pending.has(reqId)) {
          const { resolve, reject } = this._pending.get(reqId);
          this._pending.delete(reqId);
          if (data.error) {
            reject(new Error(`Deriv API error [${data.error.code}]: ${data.error.message}`));
          } else {
            resolve(data);
          }
        }
      });

      ws.on('close', () => {
        console.warn('[Deriv] WebSocket closed — scheduling reconnect...');
        this._ready = false;
        this._scheduleReconnect();
      });

      ws.on('error', (err) => {
        console.error('[Deriv] WebSocket error:', err.message);
      });
    });
  }

  async _authorize() {
    if (!this._token) {
      console.warn('[Deriv] No API token — operating in read-only mode (no trading).');
      this._ready = false;
      return;
    }
    const res = await this.send({ authorize: this._token });
    if (res.error) throw new Error(`Deriv auth failed: ${res.error.message}`);
    this._ready = true;
    this._reconnectDelay = 1000; // Reset back-off on success
    console.info(`[Deriv] Authorised as: ${res.authorize?.loginid ?? 'unknown'}`);
  }

  _scheduleReconnect() {
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(delay * 2, 30_000); // Cap at 30s
    console.info(`[Deriv] Reconnecting in ${delay / 1000}s...`);
    setTimeout(async () => {
      try {
        await this._openSocket();
        await this._authorize();
        console.info('[Deriv] Reconnected successfully ✓');
      } catch (err) {
        console.error('[Deriv] Reconnect failed:', err.message);
        this._scheduleReconnect();
      }
    }, delay);
  }
}
