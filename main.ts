// Trend rider for cbBTC/USDC, 1-minute bars, long only, $1,000 paper capital.
//
// Idea: BTC trends in multi-hour waves and chops in between. This bot waits for a
// trend that is both established and still accelerating, rides it with a sized
// position, and gets out on a fixed take-profit, a trailing stop, or a hard stop.
// It never chases a flat or fading move, never shorts, never uses leverage, and
// never trades on anything but the bars the harness sends it.
//
// Rules (all thresholds are plain round numbers, picked for the shape of the
// behaviour, not fitted to one window):
//   Trend:  EMA(30) above EMA(120), price above its 240-bar average.
//   Entry:  the fast-slow EMA gap is above 0.12% of price, the 60-bar return is
//           above +0.5%, the gap crossed above zero within the last 60 bars, and
//           the gap is still widening (up at least 0.03% over the last 10 bars).
//           A widening gap is the point: it separates a fresh accelerating trend
//           from a flat-topped chop that merely drifted above the slow EMA.
//   Size:   80% of equity on entry; if the gap widens past 0.20% it adds the
//           remaining 20%, so the full size is only held once the trend confirms.
//   Exit:   take profit at +1.5% over the average fill price; trailing stop
//           0.8% below the highest close since entry; hard stop at -1.5%; or the
//           EMA gap turns clearly negative (below -0.10%).
//   Proof:  a breakout that has not pushed the peak at least +0.3% over the
//           entry within 60 bars is a failed breakout and is closed.
//   Cooldowns: 30 bars after any exit; 360 bars after a losing round trip, so a
//           choppy regime cannot bleed the account one small loss at a time.
//   Probe:  if the bot has still made no trade with 240 bars left in the window,
//           it takes one small (30% of equity) position on a weaker version of
//           the entry (gap above 0.08%, 60-bar return above +0.3%, gap widening
//           at least 0.01% over 10 bars). This is only so a flat, choppy window
//           still leaves the bot with a trade on the board; the same exits apply,
//           and the probe never adds to its size.
//
// Everything is deterministic: float64 arithmetic on the bar closes alone, no
// clock, no environment, no randomness. Amounts are bigints; the average entry
// price is rebuilt from the fills the harness reports, so the take-profit and
// stops are measured against what the fills actually cost.
//
// Entry:  the bot needs 122 bars of history before its EMAs mean anything, so it
//         sits out the first two hours of a window.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- indicators -------------------------------------------------------------
const FAST_BARS = 30;
const SLOW_BARS = 120;
const LONG_BARS = 240;
const MOM_BARS = 60;
const WARMUP_BARS = SLOW_BARS + 2; // first bar the bot may trade on

// --- entry ------------------------------------------------------------------
const GAP_MIN = 0.0012; // fast-slow EMA gap, as a fraction of price
const MOM_MIN = 0.005; // 60-bar return that confirms the move
const SLOPE_MIN = 0.0003; // gap widening over the last 10 bars
const SLOPE_BARS = 10;
const CROSS_WINDOW = 60; // bars since the fast EMA crossed above the slow one

// --- size -------------------------------------------------------------------
const SIZE0_BPS = 8000; // 80% of equity on entry
const ADD_GAP = 0.002; // widen to this gap and the last 20% goes in

// --- exits ------------------------------------------------------------------
const TAKE_PROFIT_BPS = 150; // +1.5% over the average fill price
const STOP_LOSS_BPS = 150; // -1.5%
const TRAIL_BPS = 80; // 0.8% below the highest close since entry
const EXIT_GAP = -0.001; // EMA gap clearly negative: the trend is gone

// --- proof and cooldowns ----------------------------------------------------
const PROVE_BARS = 60; // a breakout must prove itself within an hour
const PROVE_MIN_BPS = 30; // ... by pushing the peak +0.3% over the entry
const COOLDOWN_BARS = 30;
const LOSS_COOLDOWN_BARS = 360;

// --- late probe (see the header) --------------------------------------------
const PROBE_AFTER_SEQ = 1200; // final 240 bars of a 1440-bar window
const PROBE_GAP_MIN = 0.0008;
const PROBE_MOM_MIN = 0.003;
const PROBE_SLOPE_MIN = 0.0001;
const PROBE_SIZE_BPS = 3000; // 30% of equity

const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// --- state ------------------------------------------------------------------
let closes: number[] = []; // closes before the current bar, oldest first
let smaSum = 0;
let emaFast: number | null = null;
let emaSlow: number | null = null;
let gapHist: number[] = []; // gaps, oldest first, at most SLOPE_BARS + 1 long
let prevGap: number | null = null;
let sinceCross = 1_000_000;
let nBars = 0;

let entryRaw: bigint | null = null; // average fill price, at the price scale
let entryQty = 0n;
let peakRaw = 0n; // highest close since entry, at the price scale
let holdBars = 0; // bars held (counted on closes while holding)
let underBars = 0; // consecutive closes under the entry price
let buys = 0; // buy fills so far (drives the late probe)
let probePosition = false;
let coolUntil = -1; // seq before which no new entry is sent
let lossUntil = -1; // seq before which no new entry follows a losing trade

function pushClose(c: number): number {
  // Rolling 240-bar average over the closes including this one.
  if (closes.length === LONG_BARS) smaSum += c - closes[0];
  else smaSum += c;
  const sma = smaSum / Math.min(closes.length + 1, LONG_BARS);
  closes.push(c);
  if (closes.length > LONG_BARS) closes.shift();
  return sma;
}

function stepEma(value: number | null, span: number, close: number): number {
  if (value === null) return close;
  return value + (2 / (span + 1)) * (close - value);
}

function avgEntryRaw(): bigint | null {
  return entryRaw;
}

/** Rebuild the average fill price from a buy fill, weighted by quantity. */
function noteBuyFill(priceRaw: bigint, qty: bigint): void {
  if (entryRaw === null) {
    entryRaw = priceRaw;
    entryQty = qty;
  } else {
    entryRaw = (entryRaw * entryQty + priceRaw * qty) / (entryQty + qty);
    entryQty += qty;
  }
  buys += 1;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar: Bar | undefined = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // a gap minute: no fresh information, no orders

    // --- fills of the orders decided on the previous bar -------------------
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        noteBuyFill(BigInt(fill.price), BigInt(fill.qty));
        if (fill.client_id === 'probe1') probePosition = true;
        holdBars = 0;
        underBars = 0;
      } else {
        // A sell always empties the whole position here.
        const entry = avgEntryRaw();
        if (entry !== null && BigInt(fill.price) < entry) lossUntil = batch.seq + LOSS_COOLDOWN_BARS;
        entryRaw = null;
        entryQty = 0n;
        peakRaw = 0n;
        holdBars = 0;
        underBars = 0;
        probePosition = false;
      }
    }

    // --- indicators on this bar's close ------------------------------------
    const close = Number(bar.c);
    const sma = pushClose(close);
    emaFast = stepEma(emaFast, FAST_BARS, close);
    emaSlow = stepEma(emaSlow, SLOW_BARS, close);
    nBars += 1;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const cRaw = BigInt(bar.c);
      if (cRaw > peakRaw) peakRaw = cRaw;
      holdBars += 1;
      const entry = avgEntryRaw();
      underBars = entry !== null && cRaw < entry ? underBars + 1 : 0;
    }

    // Not enough history for the slow EMA to mean anything yet.
    if (nBars < WARMUP_BARS || state.warmingUp) return [];

    const gap = (emaFast - emaSlow) / close;
    gapHist.push(gap);
    if (gapHist.length > SLOPE_BARS + 1) gapHist.shift();
    const gapSlope = gapHist.length >= SLOPE_BARS + 1 ? gap - gapHist[0] : 0;
    if (prevGap !== null && prevGap <= 0 && gap > 0) sinceCross = 0;
    else sinceCross += 1;
    const mom =
      closes.length > MOM_BARS + 1 ? close / closes[closes.length - MOM_BARS - 2] - 1 : 0;

    const { fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      const entry = avgEntryRaw();
      const qty = BigInt(held.qty);
      if (entry !== null && qty > 0n) {
        const cRaw = BigInt(bar.c);
        const trailStop = (peakRaw * BigInt(10000 - TRAIL_BPS)) / 10000n;
        const takeProfit = cRaw * 10000n >= entry * BigInt(10000 + TAKE_PROFIT_BPS);
        const stopped =
          cRaw < trailStop ||
          cRaw * 10000n <= entry * BigInt(10000 - STOP_LOSS_BPS) ||
          gap < EXIT_GAP ||
          (holdBars >= PROVE_BARS && peakRaw * 10000n < entry * BigInt(10000 + PROVE_MIN_BPS));
        if (takeProfit || stopped) {
          orders.push({ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          coolUntil = batch.seq + COOLDOWN_BARS;
        } else if (!probePosition && gap > ADD_GAP) {
          // The trend confirmed: top the position up to the full size.
          const positionValue = state.value(SYMBOL, qty);
          const room = state.equity - positionValue;
          const add = room < state.cash ? room : state.cash;
          if (add >= minNotional) {
            orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: add, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
        }
      }
      prevGap = gap;
      return orders;
    }

    // --- flat: entries ------------------------------------------------------
    if (batch.seq < coolUntil || batch.seq < lossUntil) {
      prevGap = gap;
      return [];
    }

    const trending = gap > GAP_MIN && close > sma && mom > MOM_MIN && sinceCross <= CROSS_WINDOW && gapSlope > SLOPE_MIN;
    if (trending) {
      let notional = (state.equity * BigInt(SIZE0_BPS)) / 10000n;
      if (notional > state.cash) notional = state.cash;
      if (notional >= minNotional) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      prevGap = gap;
      return orders;
    }

    // Late probe: no trade yet and the window is nearly over.
    if (
      buys === 0 &&
      batch.seq >= PROBE_AFTER_SEQ &&
      gap > PROBE_GAP_MIN &&
      close > sma &&
      mom > PROBE_MOM_MIN &&
      gapSlope > PROBE_SLOPE_MIN
    ) {
      let notional = (state.equity * BigInt(PROBE_SIZE_BPS)) / 10000n;
      if (notional > state.cash) notional = state.cash;
      if (notional >= minNotional) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: 'probe1' });
      }
    }

    prevGap = gap;
    return orders;
  },
});
