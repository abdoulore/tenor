/**
 * The test orders that decided how the tokenized stock is priced.
 *
 * Tenor used to price the tokenized stock by walking Bitget's public order book, as it does for
 * the perpetual. On 23 September 2026 that book for rNVDA sat a full 0.7% away from Bitget's own
 * ticker for over half an hour, with a bid above the ticker's ask, so the two could not both be
 * what an order fills at. Four small market orders settled which one is.
 *
 * All four were tagged StockRoute in the Bitget app and all four filled at the ticker's quote.
 * For rNVDA the order book was wider and did not move while the quote did; for rBA the order
 * book was empty. So the tokenized stock is priced from the quote, and the order book is not
 * used for it. The perpetual still walks its book, which is what futures trade against.
 *
 * Quote and book readings were logged every three seconds while the orders were placed
 * (data/evidence/quotes-2026-09-23.ndjson). Each fill is shown with the readings either side of
 * it, because a quote can move in the second between two readings and the record should show
 * that rather than pick whichever reading flatters the result.
 */

export interface QuoteReading {
  at: string;
  bid: number;
  ask: number;
}

export interface QuoteTest {
  symbol: string;
  side: "buy" | "sell";
  orderId: string;
  /** Filled time in UTC. The app showed it in UTC+1. */
  filledAt: string;
  fillPrice: number;
  notionalUsdt: number;
  before: QuoteReading;
  after: QuoteReading;
  /** The order book's best bid and ask at the time, or null when the book was empty. */
  book: { bid: number; ask: number } | null;
}

export const QUOTE_TESTS: QuoteTest[] = [
  {
    symbol: "RBAUSDT", side: "buy", orderId: "1486701960111009797",
    filledAt: "2026-09-23T17:08:10Z", fillPrice: 201.45, notionalUsdt: 10.8783,
    before: { at: "2026-09-23T17:08:07.108Z", bid: 201.26, ask: 201.35 },
    after: { at: "2026-09-23T17:08:10.115Z", bid: 201.33, ask: 201.48 },
    book: null,
  },
  {
    symbol: "RBAUSDT", side: "sell", orderId: "1486701986992304149",
    filledAt: "2026-09-23T17:08:16Z", fillPrice: 201.36, notionalUsdt: 10.87344,
    before: { at: "2026-09-23T17:08:15.965Z", bid: 201.33, ask: 201.47 },
    after: { at: "2026-09-23T17:08:19.091Z", bid: 201.33, ask: 201.47 },
    book: null,
  },
  {
    symbol: "RNVDAUSDT", side: "buy", orderId: "1486703108498862082",
    filledAt: "2026-09-23T17:12:43Z", fillPrice: 224.22, notionalUsdt: 10.875058,
    before: { at: "2026-09-23T17:12:41.907Z", bid: 224.24, ask: 224.26 },
    after: { at: "2026-09-23T17:12:44.835Z", bid: 224.22, ask: 224.23 },
    book: { bid: 224.15, ask: 224.34 },
  },
  {
    symbol: "RNVDAUSDT", side: "sell", orderId: "1486703127809437697",
    filledAt: "2026-09-23T17:12:48Z", fillPrice: 224.2, notionalUsdt: 10.873797,
    before: { at: "2026-09-23T17:12:47.740Z", bid: 224.23, ask: 224.25 },
    after: { at: "2026-09-23T17:12:50.635Z", bid: 224.19, ask: 224.2 },
    book: { bid: 224.15, ask: 224.34 },
  },
];

/**
 * How far a fill landed from the price each source said it would get, in basis points of the
 * fill. For a buy the relevant price is the ask, for a sell the bid. The quote is taken as the
 * nearer of the two readings either side of the fill.
 */
export function fillGaps(t: QuoteTest): { quoteBp: number; bookBp: number | null } {
  const side = (r: { bid: number; ask: number }) => (t.side === "buy" ? r.ask : r.bid);
  const gap = (p: number) => Math.round((Math.abs(t.fillPrice - p) / t.fillPrice) * 10_000 * 100) / 100;
  const quoteBp = Math.min(gap(side(t.before)), gap(side(t.after)));
  return { quoteBp, bookBp: t.book ? gap(side(t.book)) : null };
}
