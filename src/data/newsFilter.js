/**
 * src/data/newsFilter.js — Macroeconomic News / High-Impact Event Filter
 * ========================================================================
 * Gold (XAU/USD) can spike $10–$20 in seconds on NFP, FOMC, or CPI prints.
 * This module enforces a trading blackout window around such events.
 *
 * Priority order:
 *   1. Session hours filter  — only trade during configured UTC window
 *   2. Hard-coded recurring events — always active as fallback
 *   3. Forex Factory JSON feed — dynamic events (cached for 1 hour)
 */

import axios from 'axios';
import CFG   from '../../config.js';

// ── Recurring High-Impact USD Events ────────────────────────────────────────
// Format: [weekday (0=Mon..6=Sun), hourUtc, minuteUtc, description]
// These are the fixed-time events whose WEEKDAY shifts monthly but TIME is fixed.

const RECURRING_EVENTS = [
  [4, 13, 30, 'Non-Farm Payrolls (USD)'],         // 1st Friday of month
  [2, 18,  0, 'FOMC Rate Decision (USD)'],          // ~every 6 weeks
  [2, 12, 30, 'US CPI Release'],
  [3, 12, 30, 'US CPI / PCE Release'],
  [0, 14,  0, 'ISM Manufacturing PMI'],
  [2, 14,  0, 'ISM Services PMI'],
  [3, 12, 30, 'US Retail Sales'],
  [1, 15,  0, 'Fed Chair Testimony'],
  [2, 15,  0, 'Fed Chair Testimony'],
  [2, 18,  0, 'FOMC Minutes'],
];

const FOREX_FACTORY_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

export class NewsFilter {
  constructor() {
    this._cachedEvents   = [];
    this._cacheExpiry    = null;
    this._lastFetchFailed = false;
  }

  /**
   * Returns true if the bot should avoid trading right now.
   * @param {Date} [now]  Defaults to current UTC time
   * @returns {boolean}
   */
  isNewsBlackout(now = new Date()) {
    // 1. Session hours
    if (!this._withinSession(now)) return true;

    const before = CFG.news.blackoutBeforeMins;
    const after  = CFG.news.blackoutAfterMins;

    // 2. Recurring events
    if (this._checkRecurring(now, before, after)) return true;

    // 3. Dynamic calendar (async-resolved cache) — best-effort
    if (this._checkCachedDynamic(now, before, after)) return true;

    return false;
  }

  /**
   * Fetch and cache this week's high-impact events.
   * Call this once per hour in the main loop to populate the cache.
   */
  async refreshCalendar() {
    if (this._lastFetchFailed) return;
    const now = new Date();
    if (this._cacheExpiry && now < this._cacheExpiry) return; // Still fresh

    try {
      const res = await axios.get(FOREX_FACTORY_URL, { timeout: 5000 });
      this._cachedEvents = (res.data ?? [])
        .filter(ev => ev.impact?.toLowerCase() === 'high')
        .filter(ev => CFG.news.watchCurrencies.includes(ev.currency?.toUpperCase()))
        .map(ev => ({
          ...ev,
          _parsedTime : ev.date ? new Date(ev.date) : null,
        }))
        .filter(ev => ev._parsedTime);

      this._cacheExpiry    = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
      this._lastFetchFailed = false;
    } catch {
      this._lastFetchFailed = true; // Stop retrying this session
    }
  }

  /**
   * Return events occurring within the next `hoursAhead` hours.
   * @param {number} hoursAhead
   * @returns {Array}
   */
  getUpcomingEvents(hoursAhead = 4) {
    const now    = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 3600_000);
    return this._cachedEvents.filter(ev => {
      const t = ev._parsedTime;
      return t && t >= now && t <= cutoff;
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _withinSession(now) {
    const h = now.getUTCHours();
    return h >= CFG.news.sessionStartUtc && h < CFG.news.sessionEndUtc;
  }

  _checkRecurring(now, before, after) {
    const weekday = (now.getUTCDay() + 6) % 7; // JS 0=Sun → 0=Mon
    for (const [day, hour, minute, name] of RECURRING_EVENTS) {
      if (weekday !== day) continue;
      const eventMs = Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        hour, minute, 0
      );
      const deltaMin = (now.getTime() - eventMs) / 60_000;
      if (deltaMin >= -before && deltaMin <= after) return true;
    }
    return false;
  }

  _checkCachedDynamic(now, before, after) {
    for (const ev of this._cachedEvents) {
      const t = ev._parsedTime;
      if (!t) continue;
      const deltaMin = (now.getTime() - t.getTime()) / 60_000;
      if (deltaMin >= -before && deltaMin <= after) return true;
    }
    return false;
  }
}
