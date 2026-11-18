# Trend Rider — a cbBTC trading bot for make.fun
[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/usb-star001/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/usb-star001/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

Entry for the [make.fun](https://make.fun) bounty
`btc-race-24h-20261118-1444` — "Race a BTC trading bot live for 24 hours".
It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars,
long only, starting from $1,000 of paper money.

## Strategy

BTC moves in multi-hour waves with chop in between. The bot waits for a trend
that is both established **and still accelerating**, rides it with a sized
position, and exits on a fixed take-profit, a trailing stop, or a hard stop.
It never shorts, never uses leverage, and never trades on anything but the
bars the harness sends it.

- **Trend filter:** EMA(30) above EMA(120), price above its 240-bar average.
- **Entry:** the fast–slow EMA gap is above 0.12% of price, the 60-bar return
  is above +0.5%, the gap crossed above zero within the last 60 bars, and the
  gap is still widening — up at least 0.03% over the last 10 bars. A widening
  gap is the point: it separates a fresh accelerating trend from flat-topped
  chop that merely drifted above the slow EMA.
- **Size:** 80% of equity on entry; if the gap widens past 0.20% the remaining
  20% goes in, so the full size is only held once the trend confirms.
- **Exit:** take profit at +1.5% over the average fill price; trailing stop
  0.8% below the highest close since entry; hard stop at −1.5%; or the EMA
  gap turns clearly negative (below −0.10%).
- **Proof:** a breakout that has not pushed the peak at least +0.3% over the
  entry within 60 bars is a failed breakout and is closed.
- **Cooldowns:** 30 bars after any exit; 360 bars after a losing round trip,
  so a choppy regime cannot bleed the account one small loss at a time.
- **Late probe:** if the bot has still made no trade with 240 bars left in
  the window, it takes one small (30% of equity) position on a weaker version
  of the entry. This only matters on a flat, choppy window; the same exits
  apply, and the probe never adds to its size.

The bot needs 122 bars of history before its EMAs mean anything, so it sits
out the first two hours of a window. Everything is deterministic — float64
arithmetic on the bar closes alone, no clock, no environment, no randomness —
so two runs on the same data produce identical orders.

## Dev grade (frozen 24 h window, local `grade-local`, process driver)

| | |
|---|---|
| Net PnL | **+$13.47 USDC** (+1.35% on $1,000) |
| Trades | 3 (buy 80%, add 20%, take-profit sell — one winning round trip) |
| Win rate | 100% |
| Max drawdown | 0.64% |
| Fees paid | $0.81 (net PnL at 2× fees: +$12.66) |
| Guardrails | met (≥1 trade, drawdown ≤ 25%) |
| Determinism | two executions reproduced byte for byte |

For comparison on the same window: buy-and-hold −$31.63, momentum −$23.87,
EMA-cross −$148.17, ADX-momentum −$75.57, RSI-Bollinger −$39.92. The window
fell 2.8% overall; the bot stayed flat through both declines and caught part
of the mid-window rally. The first half of the window alone scores +$13.47;
the second half scores $0 with no trades (no qualifying trend), and a
180-bar slice starting mid-decline still scores +$13.78 — the result does not
depend on one lucky stretch.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, run as `node main.ts`).
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK, vendored unchanged.
- `.makefun/owner.json` — payout wallet for the entry.

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kitdir> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
