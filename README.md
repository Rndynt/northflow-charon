# Kaiser.Charon

This is my working fork of [Charon](https://github.com/yunus-0x/charon) by [@yunus-0x](https://github.com/yunus-0x). All credit for the original idea and codebase goes to him — I just kept changing things while running it, and at some point the diff got big enough that it needed its own home.

Charon is a Telegram bot that screens Solana pump.fun tokens, runs them through strategy filters, optionally asks an LLM to pick entries, and trades via Jupiter. Three modes: `dry_run` (paper trading into SQLite), `confirm` (Telegram approve/reject buttons), and `live` (real swaps, real money, real regret potential).

## What changed in this fork

- **FLOW filter** — candidates need `s1h_priceChange >= 0` and `net_buyer_ratio_5m >= 0.2` before they enter the pipeline. Cut a lot of dying-chart entries.
- **GMGN signed auth** — enrichment calls use Ed25519-signed requests against GMGN's API for holder counts, fees, and socials.
- **Trailing TP guard** — trailing take-profit no longer triggers on underwater positions. It used to "lock in profits" at a loss. Fixed.
- **Backtest tooling** — scripts that run filter candidates against the local trade history so changes get measured before they get deployed.
- **Live execution hardening** — realized PnL tracking, sell guards, Jupiter Ultra routing.

Everything from the original still applies: signal server, strategies (`sniper`, `dip_buy`, `smart_money`, `degen`), hot-reloaded config in SQLite, Telegram menus, the works.

## Setup

```bash
git clone git@github.com:kaiserern/charon.git
cd charon
npm install
cp .env.example .env
# fill in .env
npm start
```

You need a Telegram bot token, a signal server key (see the original repo for access), and a Helius RPC endpoint. For live mode add a wallet private key and a Jupiter API key. Everything lives in `.env.example` with comments.

## Usage

Run it, open Telegram, `/menu`. Strategy parameters are stored in SQLite and hot-read, so most tuning happens from the chat without restarts. API keys and RPC URLs are env values — those need a restart.

Start with `TRADING_MODE=dry_run`. Watch it for a week. The dry-run numbers will look better than live because paper fills don't suffer slippage — expect 20-50% worse execution on real swaps during volatile moves. Only then decide if live is worth it.

## Honest warnings

- This trades memecoins. Most memecoins go to zero. The bot's edge is catching the few that don't — one good runner pays for a lot of small losses, and that's the whole strategy. If the runners don't show up, the PnL is negative. That's not a bug.
- Live mode signs transactions automatically. Use a dedicated wallet with money you can afford to lose completely.
- GMGN rate limits are aggressive. Don't lower `GMGN_REQUEST_DELAY_MS` below 2500 unless you enjoy banned API keys.

## Credit

Original project: [yunus-0x/charon](https://github.com/yunus-0x/charon). If you're looking for the upstream version, that's the one. This fork is my personal trading setup, shared as-is.
