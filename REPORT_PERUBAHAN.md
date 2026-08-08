# Report Perubahan — northflow-charon (Fork Rndynt)

**Tanggal:** 2026-08-08
**Branch:** `main` (origin = Rndynt/northflow-charon)
**Upstream:** `yunus-0x/charon` (original)
**Merged forks:** `kaiserern/Kaiser.charon` (ML momentum model)

---

## 1. Ringkasan Metrik

| Metrik | Nilai |
|--------|-------|
| Commits di atas upstream/main | **53 commits** |
| Total commits lokal | 75 |
| Files berubah | 76 |
| Lines ditambah | +10,794 |
| Lines dihapus | −660 |
| Net change | **+10,134 lines** |

**Kontributor:**
- Rendyanta Maulana: 25 commits (user)
- kaiserern: 11 commits (ML fork merge)
- Charon Bot / Claude / charon-bot: 17 commits (agent work)

---

## 2. Breakdown per Kategori

### A. BUG FIXES (Exit / SL / TP / Panic / MaxHold) — inti bot

| # | Commit | Masalah | Perbaikan |
|---|--------|---------|-----------|
| 1 | `653bb44` | SL sentinel bug + panic circuit breaker | Fix SL=999 sentinel, add panic-exit circuit breaker |
| 2 | `f0b148a` | `const mcap` reassignment throw tiap rug | `mcap` jadi `let` (panic hard-cap threw on every rug) |
| 3 | `ab1fd2f` | Panic hard-cap realized loss | Hard-cap kerugian di panic drop threshold |
| 4 | `736d490` | SL/TP/TRAILING catat next-poll price (bukan stop level) | Cap mcap ke stop level (kemudian di-revert) |
| 5 | `dd859f9` | **User tolak cap** — mau harga REAL | Revert cap → semua exit catat real exit price (gak dibuat-buat) |
| 6 | `7ad1b1f` | Panic exit posisi profit | `panicHit` butuh `pnl < panic_floor_pct` (-2%) dari entry |
| 7 | `6133743` | FR #2 stale open: Promise.all reject → refresh gagal total | Decouple fetch (individual `.catch`); force-close stale losing posisi |
| 8 | `0b7722b` | Exit priority salah | SL→TP→TRAILING→PANIC→MAX_HOLD (MAX_HOLD terakhir) |
| 9 | `20a126d` | `exit_mcap` raw vs slippage-adjusted asymmetry | Align `dryExitMcap = exitMcap` (konsisten) |
| 10 | `d71f35b` | Sideways priority salah label | Pindah SIDEWAYS ke bawah SL/TP/TRAILING/PANIC |
| 11 | `de4cc34` | #6 re-entry dry≠live (unbounded) | Live pakai WIN_BLOCK_DAYS=7 (sama kayak dry-run) |
| 12 | `de4cc34` | #7 max_hold tiered commented | Re-enable (microcap 10min, highcap 15min) |
| 13 | `de4cc34` | #8 Guard 1/2 disabled | Re-implement sebagai observable crash signal (log, gak block) |

### B. SAFETY GUARDS (critical sebelum live)

| Commit | Fix |
|--------|-----|
| `d71f35b` | `sellInProgress` di-export + guard di `closePosition` (cegah double-sell) |
| `d71f35b` | Closing UPDATE/INSERT ditambah `AND status='open'` (cegah overwrite/dobel) |

### C. PERFORMANCE / MONITORING

| Commit | Perubahan |
|--------|-----------|
| `c69543a` | `POSITION_CHECK_MS` 5000→1000 (poll 1 detik, near-realtime) |
| `c69543a` | Tambah DexScreener sebagai 2nd price source (paralel Jupiter) |
| `d71f35b` | Cache `fetchJupiterChartContext` 30s/mint (fix 429 storm dari chart fetch tiap tick) |

### D. FEATURES BARU (Telegram / UX)

| Commit | Feature |
|--------|---------|
| `12ceddf` | Telegram route-control menu + `/routes` command |
| `4aa03a3` | Apply `blocked_routes` di rule-based mode |
| `3c99a25` | Close silent-entry gaps (manual + live buy) |
| `702f702` | `/position <id>` dan `/close <id>` commands |
| `21e81db` | Chunk `/positions` output (hindari 4096-char limit) |
| `d9308d0` | Refresh button di `/positions` |
| `6d8e655` | Split `/positions` Open/Closed |
| `a141558` | Close All action |
| `17114a7` | `/updatesmartwallets` — manual import GMGN smart-money → `saved_wallets` |
| `43f310f` | Button "🔄 Update Smart Money" + param filter (tags, --wr, --pnl) |

### E. LEARNING / ANALYTICS

| Commit | Perubahan |
|--------|-----------|
| `0b70f61` | Clearer `/learn` report + 24h default window |
| `a06ea69` | Distinct exit reasons (DB, /learn, TG) |
| `272b96a` | By Exit Reason: count + ratio only |
| `4930e05` | x-api-key di semua Jupiter calls + 429 backoff chart/holders/pnl |

### F. MERGED DARI KAISER FORK (bukan karya kita)

| File/Commit | Isi |
|-------------|-----|
| `14f98b0`, `26d0ea4` | Momentum ML model (pkl + scaler + features) |
| `src/pipeline/momentumFilter.js` | ML momentum scorer |
| `src/signals/smartMoney.js` | Smart-money signal source (berbeda dari fitur `saved_wallets` kita) |
| `underground_wallet_finder.py`, `verify_backtest.py` | Analysis/backtest scripts |
| `src/visuals/*` | Daily/entry/exit cards |

### G. INFRASTRUCTURE / DOCS

| Commit | Isi |
|--------|-----|
| `2aeffd9` | Fix `start.sh` working directory |
| `3b93160` | Hard $15K mcap floor untuk freshly-graduated |
| `e958df3` | Derive entry price/mcap dari on-chain swap (bukan signal snapshot) |
| `bbed764` | Docs FIXES_CHARON_2026-08 |

---

## 3. Perubahan Terbesar (by file)

| File | +/- | Kategori |
|------|-----|----------|
| `src/pipeline/candidateBuilder.js` | +420 | Signal filtering |
| `src/signals/pumpportal.js` | +428 | Signal source |
| `src/visuals/dailyCard.js` | +421 | Analytics (kaiser) |
| `src/pipeline/llm.js` | +356 | LLM screening |
| `src/learning/autoApply.js` | +286 | Learning auto-apply |
| `src/execution/positions.js` | +257 | **Exit engine (inti fix kita)** |
| `src/execution/router.js` | +111 | Live/dry execution |

---

## 4. Status Verifikasi (end-to-end)

- ✅ Bot RUNNING, 1 instance (gak ada ETELEGRAM 409 conflict)
- ✅ DB integrity OK, settings 36 utuh
- ✅ Near-realtime poll 1s + DexScreener jalan
- ✅ Panic gak exit posisi profit (panic_floor_pct=-2)
- ✅ Exit reason labels benar (SL/TP/TRAILING/PANIC/MAX_HOLD/SIDEWAYS)
- ✅ `saved_wallets` terisi dari GMGN (test: tag filter 13 wallet, WR filter 2/5)
- ✅ Smart-money = filter aktif kalau `min_saved_wallet_holders > 0`

---

## 5. Yang BELUM / Known Limitations

1. **Replay engine** — belum (butuh price timeline per tick; DB cuma snapshot). User tunda.
2. **True websocket realtime** — belum (hybrid 1s poll + DexScreener sebagai pengganti).
3. **WR/PnL filter lambat** — 1 GMGN call/wallet (~1s each), risk 429 kalau limit tinggi.
4. **Strategy `smart_money` disabled** — data scoring aktif, tapi strategy gak di-enable.
5. **GMGN private key** — butuh `GMGN_PRIVATE_KEY` (user sudah set) untuk `track smartmoney`.

---

## 6. Review Claude (8 temuan) — Status

| # | Temuan | Status |
|---|--------|--------|
| 1 | Double-sell guard | ✅ FIXED |
| 2 | Closing UPDATE gak ber-guard | ✅ FIXED |
| 3 | Chart 429 storm | ✅ FIXED (cache 30s) |
| 4 | Sideways priority salah | ✅ FIXED |
| 5 | exit_mcap asymmetry | ✅ FIXED |
| 6 | Re-entry dry≠live | ✅ FIXED |
| 7 | max_hold tiered commented | ✅ FIXED (re-enable) |
| 8 | Guard 1/2 disabled | ✅ ADDRESSED (observable) |

**8/8 resolved.**

---

*Report generated from git history (`git diff --stat upstream/main...HEAD`) + code verification.*
