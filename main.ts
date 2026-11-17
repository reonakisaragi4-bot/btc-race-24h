// Dip-and-hold cbBTC bot for agent-fun/bars-replay/v1.
//
// Idea: the replay is long-only with no leverage and a full-size round trip
// costs roughly 30-40 bps in fees, slippage and pool impact, while one-minute
// bars on this market mostly wiggle a few bps. Chasing every wiggle pays the
// toll over and over and bleeds. So this bot trades at most once: it waits
// for the first small dip off the running high, buys the whole cash balance,
// and then simply holds to the end of the window. One fill means one toll.
// A hard stop 3% under cost is the only exit, to cap the damage on a day
// that falls off a cliff; otherwise the position rides the day out.
//
//   - Arms once 20 closes have been seen, so the running high means something.
//   - Buys when the latest close sits at least 15 bps under the highest close
//     seen so far, or at the latest by the 720th bar if no dip ever comes.
//   - Never re-buys: after the stop fires, or after a buy fills, it stays out.
//   - A buy the market refuses (slippage, no bar) is retried a few bars later.
//   - Every order caps slippage at 100 bps past the close it was decided on.
//   - Fully deterministic: no clock, no environment, no randomness.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const ARM_BARS = 20;
const DIP_BPS = 15;
const FALLBACK_BARS = 720;
const STOP_BPS = 300;
const MAX_SLIPPAGE_BPS = 100;
const RETRY_AFTER_BARS = 3;

// Closes seen so far, raw price units (scale-free for the ratios below).
const closes: number[] = [];
let runningHigh = 0;
let buySentAtBar = -1;
let stoppedOut = false;

function heldQty(state: BarsState): bigint {
  const p = state.positions.get(SYMBOL);
  return p === undefined ? 0n : p.qty;
}

await runBars({
  onBatch(state: BarsState) {
    const bar = state.latest.get(SYMBOL);
    if (bar !== undefined) {
      const close = Number(bar.c);
      closes.push(close);
      if (close > runningHigh) runningHigh = close;
    }
    if (state.warmingUp) return [];
    if (bar === undefined) return [];

    const qty = heldQty(state);
    if (qty > 0n) {
      // Hard stop: position worth 3% under what it cost us, sell it all.
      const pos = state.positions.get(SYMBOL)!;
      const value = state.value(SYMBOL, qty);
      if (value * 10000n <= pos.cost * BigInt(10000 - STOP_BPS)) {
        stoppedOut = true;
        const sell: SellInput = {
          side: 'sell',
          symbol: SYMBOL,
          qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [sell];
      }
      return [];
    }

    if (stoppedOut) return [];
    if (closes.length < ARM_BARS) return [];

    const close = Number(bar.c);
    const dipped = close * 10000 <= runningHigh * (10000 - DIP_BPS);
    const late = closes.length >= FALLBACK_BARS;
    const retryOk = buySentAtBar < 0 || closes.length - buySentAtBar >= RETRY_AFTER_BARS;
    if (!dipped && !late) return [];
    if (!retryOk) return [];

    const room = state.weightRoom(SYMBOL);
    const spend = room < state.cash ? room : state.cash;
    if (spend <= 0n) return [];
    buySentAtBar = closes.length;
    const buy: BuyInput = {
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: spend,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
    return [buy];
  },
});
