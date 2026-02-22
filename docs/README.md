# XAU/USD Scalping Bot — Documentation

## Table of Contents
1. [Strategy Logic](#1-strategy-logic)
2. [Indicator Rationale](#2-indicator-rationale)
3. [Risk Management](#3-risk-management)
4. [Project Structure](#4-project-structure)
5. [Setup & Installation](#5-setup--installation)
6. [Running the Bot](#6-running-the-bot)
7. [Backtesting](#7-backtesting)
8. [Configuration Reference](#8-configuration-reference)
9. [Trade Signal Flow](#9-trade-signal-flow)
10. [CSV Trade Journal Fields](#10-csv-trade-journal-fields)
11. [Important Disclaimers](#11-important-disclaimers)

---

## 1. Strategy Logic

### Overview: Multi-Confluence Scalp

Signals fire on the **M15 timeframe** using a **5-point confluence scoring system** with a **H1 trend filter**. A trade requires **≥ 3 out of 5** independent confirmations.

| Check | Buy Trigger | Sell Trigger |
|-------|------------|-------------|
| **[1] H1 EMA Stack** | EMA21 > EMA50 > EMA200 | EMA21 < EMA50 < EMA200 |
| **[2] RSI Zone** | RSI < 35 or bullish divergence | RSI > 65 or bearish divergence |
| **[3] MACD Cross** | MACD crosses above signal + hist > 0 | MACD crosses below signal + hist < 0 |
| **[4] Stochastic** | %K crosses above %D from < 20 | %K crosses below %D from > 80 |
| **[5] BB + Structure** | Price at lower BB near swing support | Price at upper BB near swing resistance |

### Trade Levels Example

```
LONG XAU/USD @ 2340.00  |  ATR = $1.20
──────────────────────────────────────────
Entry      : 2340.00   ← fills on next candle's open
Stop Loss  : 2338.20   ← entry − (ATR × 1.5) = −$1.80
Take Profit: 2343.60   ← SL_dist × 2.0 = +$3.60
R:R        : 1:2.0
```

SL is placed just beyond the nearest structural swing low if that gives a tighter stop.

### Trade Management

- **Breakeven**: when price moves 1×ATR in profit → SL moves to entry
- **Trailing**: when price moves 1.5×ATR → SL trails at price − 0.8×ATR
- **Server-side SL/TP**: attached to the OANDA order (GTT) — survive bot restarts

---

## 2. Indicator Rationale

| Indicator | Why |
|-----------|-----|
| **EMA 21/50/200** | EMAs react faster than SMAs. Stack alignment defines the macro trend direction to trade *with*, not against. |
| **RSI 14** | Identifies momentum exhaustion at extreme zones (35/65 tightened from 30/70 for gold's higher vol). Divergence provides early entry signals. |
| **MACD 12/26/9** | Confirms short-term momentum has accelerated past the medium-term mean. Histogram expansion filters weak crossovers. |
| **Stochastic 14/3** | Faster than RSI on intraday frames. Crossover *inside* OB/OS zone confirms momentum turning. |
| **ATR 14** | Gold's volatility varies 10× between Asian session and NY. Fixed-pip stops are useless; ATR-based stops self-adapt. |
| **Bollinger Bands 20** | Statistical extreme (±2σ) + squeeze detection. BB touch at a structural level = high mean-reversion probability. |
| **Swing Highs/Lows** | Natural S/R levels from market structure. Placing SL just beyond a swing level gives the trade room to breathe while respecting price action. |

---

## 3. Risk Management

### The 1% Rule

```
riskAmount = equity × 0.01              // 1% of account
slDistance = |entryPrice − stopLoss|    // in USD
units      = Math.floor(riskAmount / slDistance)
```

**Example** — $10,000 account, SL = $1.50 away:
- Risk: $100
- Units: 100 / 1.50 = **66 oz**
- If SL hit: lose $99 ✓  |  If TP hit (+$3.00): gain $198 ✓

### Hard Limits

| Rule | Value | Why |
|------|-------|-----|
| Max risk/trade | 1% | Survives 20 consecutive losses |
| Max risk/trade (USD) | $200 | Caps large accounts in volatile periods |
| Max open positions | 2 | Prevents correlated over-exposure |
| Daily drawdown limit | 3% | Forces a pause on bad days |
| Daily USD loss cap | $500 | Hard fuse regardless of % |
| Max trades/day | 5 | Prevents revenge trading |
| Min gap between trades | 15 min | One cool-down candle before re-entry |

---

## 4. Project Structure

```
aiBot/
├── main.js                           # Entry point — live loop + backtest CLI
├── config.js                         # All tuneable parameters
├── package.json
├── .env.example                      # Credential template
│
├── src/
│   ├── data/
│   │   ├── fetcher.js                # OANDA REST (axios) + CSV loader + mock
│   │   └── newsFilter.js             # NFP/FOMC/CPI blackout + Forex Factory feed
│   ├── indicators/
│   │   └── technical.js             # EMA/RSI/MACD/Stoch/ATR/BB/Swings
│   ├── strategy/
│   │   └── signals.js               # Scoring, level construction, R:R validation
│   ├── risk/
│   │   └── manager.js               # Position sizing, daily limits, trailing stop
│   ├── execution/
│   │   └── trader.js                # Market order placement, SL/TP management
│   ├── logging/
│   │   └── tradeLogger.js           # Winston logger + CSV trade journal
│   └── backtest/
│       └── engine.js                # Walk-forward backtest, metrics, ASCII plot
│
├── logs/
│   ├── bot.log                       # Human-readable activity log
│   ├── trades.csv                    # Machine-readable trade journal
│   └── backtest_results.json         # Backtest summary stats
│
└── data/historical/
    └── XAUUSD_M15.csv                # You supply this for backtesting
```

---

## 5. Setup & Installation

### Prerequisites
- Node.js 18+
- OANDA account — [open a free practice account](https://www.oanda.com/register/)

### Install

```bash
npm install
```

### Configure credentials

```bash
cp .env.example .env
# Edit .env:
# OANDA_ACCOUNT_TYPE=practice
# OANDA_ACCOUNT_ID=12345678-1
# OANDA_API_TOKEN=your_token_here
```

Get your OANDA API token:
1. Log in to [OANDA fxTrade Practice](https://fxtrade.oanda.com)
2. **My Account → My Services → API Access**
3. Generate a Personal Access Token

---

## 6. Running the Bot

```bash
# Paper trading (requires .env with OANDA credentials)
npm start

# Or directly:
node main.js
```

The bot will:
1. Connect to OANDA practice environment
2. Fetch candles every 60 seconds
3. Check news blackout / session hours
4. Calculate indicators and evaluate signals
5. Place orders with server-side SL/TP
6. Log everything to `logs/`

### Stop

`Ctrl+C` — prints a session summary before exiting.

### Switch to live trading

1. Set `OANDA_ACCOUNT_TYPE=live` in `.env`
2. Update `OANDA_ACCOUNT_ID` and `OANDA_API_TOKEN` with your live credentials
3. **Run paper for ≥ 4 weeks first**
4. Consider starting with `maxRiskPct: 0.5` in `config.js`

---

## 7. Backtesting

### Quick test (no files needed)

```bash
npm run backtest:mock
# or: node main.js --backtest --mock
```

### Backtest on real historical data

1. **Download XAUUSD M15 data** from one of:
   - [Dukascopy](https://www.dukascopy.com/swiss/english/marketwatch/historical/) (free OHLCV export)
   - [TrueFX](https://www.truefx.com) (tick data, resample to M15)
   - OANDA historical rates download

2. **Format the CSV**:
   ```
   time,open,high,low,close,volume
   2023-01-02T07:00:00.000Z,1823.45,1824.12,1822.88,1823.67,1234
   ```

3. **Place at** `data/historical/XAUUSD_M15.csv`

4. **Run**:
   ```bash
   npm run backtest
   # or: node main.js --backtest
   ```

5. Results: `logs/backtest_results.json` + ASCII chart in console

### Interpreting backtest results

| Metric | Target |
|--------|--------|
| Win Rate | > 45% |
| Profit Factor | > 1.3 |
| Sharpe Ratio | > 1.0 |
| Max Drawdown | < 15% |
| Avg R:R Achieved | > 1.5 |
| Expectancy | > $0 |

---

## 8. Configuration Reference

Everything lives in `config.js`. Key parameters:

```js
// Strategy — more conservative = fewer but higher-quality trades
strategy.minSignalScore = 3    // Raise to 4 for fewer, higher-quality entries
strategy.minRrRatio     = 1.8  // Raise to 2.5 for higher minimum R:R

// SL/TP sizing
strategy.slAtrMult = 1.5   // Wider SL = fewer stops, larger losses when hit
strategy.tpSlMult  = 2.0   // Increase for bigger winners (but fewer TP hits)

// Risk
risk.maxRiskPct = 1.0    // Reduce to 0.5% for conservative accounts

// Indicators — don't change without re-backtesting
indicator.rsiPeriod  = 14
indicator.emaFast    = 21
indicator.atrPeriod  = 14
```

---

## 9. Trade Signal Flow

```
Every 60 seconds:
│
├─► Session hours? (07:00–20:00 UTC)          NO  → skip
│
├─► High-impact event within ±30 min?          YES → skip (blackout)
│
├─► Fetch M15 (300 bars) + H1 (75 bars)
│
├─► Calculate all indicators
│
├─► Update trailing stops on open trades
│
├─► Risk checks:
│     openTrades ≥ 2?                           → skip
│     daily drawdown ≥ 3%?                      → skip (day paused)
│     daily loss ≥ $500?                        → skip
│     trades today ≥ 5?                         → skip
│     last trade < 15 min ago?                  → skip
│
├─► Score confluences for BUY and SELL (0–5)
│     score < 3?                                → no signal
│     R:R < 1.8?                                → discard
│
├─► Calculate position size (1% rule)
│
└─► MARKET order + server-side GTT SL + TP
```

---

## 10. CSV Trade Journal Fields

| Field | Description |
|-------|-------------|
| `timestamp_open` | UTC time trade was entered |
| `timestamp_close` | UTC time trade closed |
| `direction` | `buy` or `sell` |
| `entry` | Fill price at entry |
| `stop_loss` | Initial stop-loss price |
| `take_profit` | Take-profit target |
| `exit_price` | Actual close price |
| `units` | Troy ounces traded |
| `pnl_usd` | Realised P/L in USD |
| `pnl_pct` | P/L as % of equity at entry |
| `rr_achieved` | Actual R-multiple (pnl / initial_risk) |
| `reason_open` | Signal confluence triggers |
| `reason_close` | `take_profit` / `stop_loss` / `trailing_stop` / `manual` |
| `score` | Confluence score (0–5) |
| `atr` | ATR at entry |
| `equity_before` | Account equity before this trade |

---

## 11. Important Disclaimers

> **TRADING FOREX AND COMMODITIES INVOLVES SUBSTANTIAL RISK OF LOSS.**
> This code is for educational and research purposes. Past performance
> does not guarantee future results. Only trade with capital you can afford to lose.

**Before going live:**
- [ ] Paper trade for at least 4 weeks
- [ ] Backtest on out-of-sample data (test year ≠ optimised year)
- [ ] Understand OANDA margin requirements for XAU/USD
- [ ] Reduce `maxRiskPct` to 0.5% when starting live
- [ ] Never run unmonitored on a large account
