# Kaiser.Charon

This is my working fork of [Charon](https://github.com/yunus-0x/charon) by [@yunus-0x](https://github.com/yunus-0x). All credit for the original idea and codebase goes to him — I just kept changing things while running it, and at some point the diff got big enough that it needed its own home.

Charon is a Telegram bot that screens Solana pump.fun tokens, runs them through strategy filters, optionally asks an LLM to pick entries, and trades via Jupiter. Three modes: `dry_run` (paper trading into SQLite), `confirm` (Telegram approve/reject buttons), and `live` (real swaps, real money, real regret potential).

## What changed in this fork

- **FLOW filter** — candidates need `s1h_priceChange >= 0` and `net_buyer_ratio_5m >= 0.2` before they enter the pipeline. Cut a lot of dying-chart entries.
- **PumpPortal WebSocket source** — real-time graduated-token stream instead of polling. Also feeds the pre-graduation scanner.
- **Pre-grad scanner** — optional module that watches tokens before they hit the bonding curve cap.
- **GMGN signed auth** — enrichment calls use Ed25519-signed requests against GMGN's API for holder counts, fees, and socials.
- **Trailing TP guard** — trailing take-profit no longer triggers on underwater positions. It used to "lock in profits" at a loss. Fixed.
- **Tightened exit logic** — trailing stop narrows once a position clears a peak threshold, with a profit floor after arming. Reduces giving back runners.
- **Quote-first dry-run exits** — paper exits price off executable Jupiter quotes instead of stale mark data, so dry-run numbers track reality more closely.
- **Telegram reports + visual cards** — daily PnL reports and rendered entry/exit cards.
- **Backtest tooling** — scripts that run filter candidates against local trade history so changes get measured before they get deployed.
- **Live execution hardening** — realized PnL tracking, sell guards, Jupiter Ultra routing.

Everything from the original still applies: signal server, strategies (`sniper`, `dip_buy`, `smart_money`, `degen`), hot-reloaded config in SQLite, Telegram menus, the works.

## Latest additions (post-07-2026)

This fork now includes:

- **LLM Decision Cache** (`migrations/001_decision_cache.sql`) — WATCH/PASS verdicts cached 10min/60min to cut redundant LLM calls by ~60-70%. Invalidates on >20% mcap or >30% holder change.
- **ML Momentum Filter** (`src/pipeline/predict_momentum.py`) — Python subprocess scoring candidates 0.0-1.0 using a trained model (`models/momentum_model.pkl`). Optional; skips silently if model absent.
- **Hybrid Filter Strategy** (`OPTION_C_IMPLEMENTATION.md`) — bot holders ≥25% → HARD REJECT; holder deadzone [100,400] + dev migrations ≥20 → 50% size cut. Expected +20 SOL uplift based on 30-day backtest.
- **Tier 1 Universal Filters** (`TIER1_FILTERS.md`) — 3 data-driven filters from 634-trade backtest with bucketed evidence.
- **Code Audit** (`AUDIT_OPUS_2026-07-07.md`) — Claude Opus 4.8 static audit: 3 CRITICAL findings including C1 (Jupiter slippage cap never sent) and C2 (post-swap dedup → orphaned tokens).
- **Backtest Edge Analysis** (`BACKTEST_EDGE_2026-07-07.md`) — 1,146-position split-half backtest showing regime decay: 40.3% WR (+5.1 SOL) → 25.7% WR (-3.9 SOL).
- **Bug Fixes** (`BUGFIX_SUMMARY.md`) — 4 LLM-layer fixes: cache, pre-filter guard, execution failure logging, past-win audit trail.

## Requirements

- **Node.js 20+** (developed on v22).
- **Native build tools** — `better-sqlite3` and `canvas` compile from source:
  - Debian/Ubuntu: `sudo apt install -y build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
  - macOS: `xcode-select --install` and `brew install pkg-config cairo pango libpng jpeg giflib librsvg`
- A **Telegram bot token** and your chat ID.
- A **signal server key** — see the [original repo](https://github.com/yunus-0x/charon) for access.
- A **Helius RPC endpoint** (free tier is fine for `dry_run`).
- For `live` mode only: a **Solana wallet private key** and a **Jupiter API key**.

## Setup

```bash
git clone https://github.com/kaiserern/Kaiser.charon.git
cd Kaiser.charon
npm install
cp .env.example .env
# fill in .env — at minimum: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
# SIGNAL_SERVER_KEY, HELIUS_API_KEY / SOLANA_RPC_URL
npm run check   # syntax check before first boot
npm start
```

The SQLite database is created automatically at `DB_PATH` on first run. Nothing else to provision.

If `npm install` fails on `better-sqlite3` or `canvas`, it's the native build — install the build tools listed above and retry.

## Configuration

`.env.example` documents every environment variable the bot reads. The ones without a default are the ones you actually have to fill in; the rest have sane values already.

Optional subsystems are off by default and stay off until you set their flag:

- `GMGN_ENABLED=true` — enrichment via GMGN (on by default; set `false` to fall back to Jupiter data)
- `PUMPPORTAL_ENABLED=true` — real-time WebSocket signals, needs `PUMPPORTAL_API_KEY`
- `PREGRAD_ENABLED=true` — pre-graduation scanner
- `ENABLE_LLM=true` — LLM entry selection (on by default; needs `LLM_API_KEY`)

Strategy parameters live in SQLite, not `.env`, and are hot-read — most tuning happens from the Telegram chat without restarts. API keys and RPC URLs are env values, so those need a restart.

## Usage

Run it, open Telegram, `/menu`.

Start with `TRADING_MODE=dry_run`. Watch it for a week. The dry-run numbers will look better than live because paper fills don't suffer slippage — expect 20-50% worse execution on real swaps during volatile moves. Only then decide if live is worth it.

## Honest warnings

- This trades memecoins. Most memecoins go to zero. The bot's edge is catching the few that don't — one good runner pays for a lot of small losses, and that's the whole strategy. If the runners don't show up, the PnL is negative. That's not a bug.
- Live mode signs transactions automatically. Use a dedicated wallet with money you can afford to lose completely.
- GMGN rate limits are aggressive. Don't lower `GMGN_REQUEST_DELAY_MS` below 2500 unless you enjoy banned API keys.
- Never commit your `.env`. It's gitignored — keep it that way.

## Credit

Original project: [yunus-0x/charon](https://github.com/yunus-0x/charon). If you're looking for the upstream version, that's the one. This fork is my personal trading setup, shared as-is.
