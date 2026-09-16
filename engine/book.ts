/**
 * Book walking for the engine.
 *
 * This deliberately calls the sampler's own `walk` and `levels` rather than
 * reimplementing them. Kill condition 1 in the plan is the engine failing to reproduce the
 * sampler's numbers, and the cheapest way to never fail it is to run the same code.
 */

// @ts-expect-error plain .mjs module, types declared in depth.d.mts
import { levels, walk, sessionLabel } from "../sampler/depth.mjs";
import type { Book, Execution, Fill, Level, Session } from "./types.ts";

export { sessionLabel };

export function toBook(rawAsks: unknown, rawBids: unknown, ts: unknown): Book {
  const n = Number(ts);
  return {
    asks: levels(rawAsks) as Level[],
    bids: levels(rawBids) as Level[],
    ts: Number.isFinite(n) && n > 0 ? n : null,
  };
}

export const isEmpty = (b: Book): boolean => b.asks.length === 0 || b.bids.length === 0;

function fillFrom(side: Level[], notionalUsd: number, mid: number, isBuy: boolean): Fill {
  const r = walk(side, notionalUsd) as { vwap: number | null; filledUsd: number; exhausted: boolean };
  const bp =
    r.vwap === null ? null : ((isBuy ? r.vwap - mid : mid - r.vwap) / mid) * 10_000;
  return { vwap: r.vwap, bp: bp === null ? null : round(bp, 4), filledUsd: r.filledUsd, exhausted: r.exhausted };
}

/**
 * Round trip execution cost for a position of notionalUsd.
 *
 * A long enters by lifting asks and exits by hitting bids. A short is the mirror, and
 * costs the same on a symmetric book but not on a skewed one, which is exactly when it
 * matters, so the direction is honoured rather than assumed away.
 */
export function execution(book: Book, notionalUsd: number, direction: "long" | "short"): Execution | null {
  if (isEmpty(book)) return null;
  const bestAsk = book.asks[0][0];
  const bestBid = book.bids[0][0];
  const mid = (bestAsk + bestBid) / 2;
  if (!(mid > 0) || bestAsk < bestBid) return null;

  const entrySide = direction === "long" ? book.asks : book.bids;
  const exitSide = direction === "long" ? book.bids : book.asks;
  const entry = fillFrom(entrySide, notionalUsd, mid, direction === "long");
  const exit = fillFrom(exitSide, notionalUsd, mid, direction !== "long");

  return {
    mid: round(mid, 8),
    spreadBp: round(((bestAsk - bestBid) / mid) * 10_000, 4),
    entry,
    exit,
    roundTripBp: entry.bp === null || exit.bp === null ? null : round(entry.bp + exit.bp, 4),
    askBookUsd: Math.round(notionalOf(book.asks)),
    bidBookUsd: Math.round(notionalOf(book.bids)),
  };
}

/** The most this book could absorb on the tighter of the two sides. */
export function absorbable(book: Book): number {
  if (isEmpty(book)) return 0;
  return Math.round(Math.min(notionalOf(book.asks), notionalOf(book.bids)));
}

function notionalOf(side: Level[]): number {
  let t = 0;
  for (const [p, q] of side) t += p * q;
  return t;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Sessions in the order they occur in a US trading day, used to name the next better one. */
export const SESSION_ORDER: Session[] = ["premarket", "regular", "afterhours", "overnight"];
