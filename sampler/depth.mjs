/**
 * Orderbook maths for the spread sampler.
 *
 * A tight best bid/ask means nothing if it is only good for $100, and the whole cost
 * gap Tenor measures is 8bp. So every sample records what it actually costs to fill a
 * real position, not just the top of book.
 *
 * Convention: cost is signed basis points against the mid, positive meaning worse than
 * mid. A buy walks the asks, a sell walks the bids. buyBp + sellBp is the round trip
 * execution cost for that size, directly comparable to the fee gap.
 */

/*
 * Sizes the book is walked for.
 *
 * Adding sizes costs no extra requests: the book is already fetched, and walking it again is
 * local arithmetic. The only cost is about 14MB a day of record size, against a 5GB volume.
 *
 * Two sizes meant someone asking about $50,000 was shown the $10,000 figure. Four covers the
 * range without pretending to measure what was never measured, which is why this is a list of
 * real sizes rather than an interpolation.
 */
export const FILL_SIZES_USD = [500, 2_000, 10_000, 50_000];

/** Coerce a level array of [price, qty] in either string or number form. */
export function levels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const p = Number(row[0]);
    const q = Number(row[1]);
    if (Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0) out.push([p, q]);
  }
  return out;
}

/**
 * Walk a side of the book spending up to notionalUsd.
 * Returns the volume weighted fill price, or null when the book cannot fill the size.
 */
export function walk(side, notionalUsd) {
  let remaining = notionalUsd;
  let qty = 0;
  let spent = 0;
  for (const [price, size] of side) {
    const available = price * size;
    const take = Math.min(available, remaining);
    qty += take / price;
    spent += take;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9) return { vwap: null, filledUsd: spent, exhausted: true };
  return { vwap: spent / qty, filledUsd: spent, exhausted: false };
}

export function bookNotional(side) {
  let t = 0;
  for (const [p, q] of side) t += p * q;
  return t;
}

/**
 * Bitget's quote for a tokenized stock, as a one level book: the best bid and ask from the
 * ticker, each with the size shown at that price.
 *
 * This is what a tokenized stock order actually fills at. On 23 September 2026 four market
 * orders on this account, a buy and a sell of rBA and of rNVDA, all tagged StockRoute, filled
 * within three cents of the ticker's quote. For rNVDA the public order book was 6bp wider at
 * the time and did not move while the ticker did; for rBA the order book was empty. So the
 * order book is not what fills, and the quote is.
 *
 * Nothing beyond the shown size is visible, so a walk past it reports the order as not
 * fillable rather than guessing at a price.
 */
export function quoteLevels(row) {
  const bid = Number(row?.bid1Price);
  const ask = Number(row?.ask1Price);
  const bidSize = Number(row?.bid1Size);
  const askSize = Number(row?.ask1Size);
  const ts = Number(row?.ts);
  return {
    asks: ask > 0 && askSize > 0 ? [[ask, askSize]] : [],
    bids: bid > 0 && bidSize > 0 ? [[bid, bidSize]] : [],
    ts: Number.isFinite(ts) && ts > 0 ? ts : null,
  };
}

/** Derive every metric one leg contributes to a sample. */
export function legMetrics(rawAsks, rawBids) {
  const asks = levels(rawAsks);
  const bids = levels(rawBids);
  // An empty book is a measurement, not a failure. Many rTokens quote nothing at all
  // outside US market hours, which means the route is untradeable rather than expensive,
  // and that is one of the things the sampler exists to establish. It is recorded as
  // empty so analysis can count untradeable time without confusing it with a fetch error.
  if (!asks.length || !bids.length) {
    const side = !asks.length && !bids.length ? "both sides" : asks.length ? "bid side" : "ask side";
    return { ok: false, empty: true, reason: `empty book, ${side}` };
  }
  const bestAsk = asks[0][0];
  const bestBid = bids[0][0];
  const mid = (bestAsk + bestBid) / 2;
  if (!(mid > 0) || bestAsk < bestBid) return { ok: false, reason: "crossed or zero book" };

  const fills = {};
  for (const size of FILL_SIZES_USD) {
    const buy = walk(asks, size);
    const sell = walk(bids, size);
    const buyBp = buy.vwap === null ? null : ((buy.vwap - mid) / mid) * 10_000;
    const sellBp = sell.vwap === null ? null : ((mid - sell.vwap) / mid) * 10_000;
    fills[size] = {
      buyBp: round(buyBp, 3),
      sellBp: round(sellBp, 3),
      roundTripBp: buyBp === null || sellBp === null ? null : round(buyBp + sellBp, 3),
      buyFilledUsd: Math.round(buy.filledUsd),
      sellFilledUsd: Math.round(sell.filledUsd),
      exhausted: buy.exhausted || sell.exhausted,
    };
  }

  return {
    ok: true,
    bid: bestBid,
    ask: bestAsk,
    mid: round(mid, 8),
    spreadBp: round(((bestAsk - bestBid) / mid) * 10_000, 3),
    askLevels: asks.length,
    bidLevels: bids.length,
    askBookUsd: Math.round(bookNotional(asks)),
    bidBookUsd: Math.round(bookNotional(bids)),
    fills,
  };
}

function round(x, dp) {
  if (x === null || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * US equity session label for an instant, in America/New_York.
 * Market holidays are not handled, so a holiday reads as "regular". Sessions are
 * labelled because rToken depth is expected to differ sharply off hours, and that
 * difference is one of the things the sampler exists to measure.
 */
export function sessionLabel(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));

  if (weekday === "Sat" || weekday === "Sun") return "weekend";
  if (minutes >= 570 && minutes < 960) return "regular";   // 09:30 to 16:00
  if (minutes >= 240 && minutes < 570) return "premarket";  // 04:00 to 09:30
  if (minutes >= 960 && minutes < 1200) return "afterhours"; // 16:00 to 20:00
  return "overnight";
}
