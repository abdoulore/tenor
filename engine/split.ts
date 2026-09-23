/**
 * Splitting a large order across the two wrappers.
 *
 * Both the tokenized stock and the perpetual give exposure to the same share. For a small order
 * one of them is simply cheaper and the whole order should go there. For a large order, walking
 * deep into one book gets expensive, and taking part of the size from the other book, where the
 * first levels are still cheap, can cost less in total.
 *
 * This searches every split from 0% to 100% in the perpetual, in 1% steps, and prices each side
 * by walking its live book for its share of the order. Each side carries its own fee, and the
 * perpetual side carries its funding over the holding period, so the split is judged on the full
 * cost of holding, not just the cost of getting in.
 *
 * It only recommends a split when the saving is worth the trouble of holding two positions.
 */

import { execution } from "./book.ts";
import type { Book, Direction, Quote, Range } from "./types.ts";

export interface SplitPoint {
  /** Share of the order placed through the perpetual, 0 to 1. */
  perpShare: number;
  /** Total cost in dollars, or null when one side cannot absorb its share. */
  totalUsd: number | null;
}

export interface SplitPlan {
  applicable: boolean;
  /** Why no split is offered, when it is not. */
  reason: string | null;
  notionalUsd: number;

  perpUsd: number;
  tokenUsd: number;
  perpShare: number;
  totalUsd: number;
  /** The same total with funding at the low and high end of its projected range. */
  totalRangeUsd: { low: number; high: number };

  bestSingle: { route: "rtoken" | "perp"; totalUsd: number } | null;
  savingUsd: number;
  savingBp: number;
  /** True when the saving clears the bar for recommending two positions instead of one. */
  worthIt: boolean;

  /** Total cost across the split range, for the chart. */
  curve: SplitPoint[];
}

/**
 * A split has to save at least this many basis points of the order, and at least a dollar, before
 * it is recommended. Holding two positions is more to manage, and a saving smaller than this is
 * inside the day to day movement of the books anyway.
 */
export const MIN_SPLIT_SAVING_BP = 1;
export const MIN_SPLIT_SAVING_USD = 1;

interface SideCost {
  feeBp: number;
  fundingBp: Range;
}

/** Dollars to hold `usd` through one wrapper: its execution at that size, its fee, its funding. */
function sideCost(book: Book, usd: number, direction: Direction, side: SideCost, fundingAt: "low" | "mid" | "high"): number | null {
  if (usd <= 0) return 0;
  const e = execution(book, usd, direction);
  if (!e || e.roundTripBp === null) return null;
  return (usd * (e.roundTripBp + side.feeBp + side.fundingBp[fundingAt])) / 10_000;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Plan a split for a priced quote. Reuses the quote's own fees and funding projection, so the
 * split can never disagree with the prices shown beside it, and walks the same live books.
 */
export function planSplit(quote: Quote, books: { rtoken?: Book; perp?: Book }): SplitPlan {
  const N = quote.intent.notionalUsd;
  const empty: SplitPlan = {
    applicable: false, reason: null, notionalUsd: N,
    perpUsd: 0, tokenUsd: 0, perpShare: 0, totalUsd: 0, totalRangeUsd: { low: 0, high: 0 },
    bestSingle: null, savingUsd: 0, savingBp: 0, worthIt: false, curve: [],
  };

  const rt = quote.routes.find((r) => r.route === "rtoken");
  const pp = quote.routes.find((r) => r.route === "perp");
  /*
   * A side that is too small for the whole order still counts: taking part of the order from it
   * may be exactly what makes the order fillable. What rules a side out is not being able to
   * express the view at all, or having no published depth.
   */
  const priced = (r: typeof rt) =>
    r && (r.status === "ok" || r.status === "stale" || r.status === "cannot_fill")
    && r.feeBp !== null && r.fundingBp !== null;

  // Splitting only makes sense when both wrappers can express the view and both can be priced.
  if (!priced(rt) || !priced(pp)) {
    return { ...empty, reason: "Splitting needs both the tokenized stock and the perpetual to be available and priced." };
  }
  if (!books.rtoken || !books.perp) {
    return { ...empty, reason: "Splitting needs a live book on both sides." };
  }

  const direction = quote.intent.direction;
  const token: SideCost = { feeBp: rt!.feeBp!, fundingBp: rt!.fundingBp! };
  const perp: SideCost = { feeBp: pp!.feeBp!, fundingBp: pp!.fundingBp! };

  const total = (share: number, at: "low" | "mid" | "high"): number | null => {
    const p = sideCost(books.perp!, share * N, direction, perp, at);
    const t = sideCost(books.rtoken!, (1 - share) * N, direction, token, at);
    return p === null || t === null ? null : p + t;
  };

  let best: { share: number; usd: number } | null = null;
  for (let i = 0; i <= 100; i++) {
    const share = i / 100;
    const usd = total(share, "mid");
    if (usd !== null && (best === null || usd < best.usd - 1e-9)) best = { share, usd };
  }
  if (!best) {
    return { ...empty, applicable: false, reason: "Neither book can absorb the order, whole or split." };
  }

  const allPerp = total(1, "mid");
  const allToken = total(0, "mid");
  const singles = [
    allPerp === null ? null : { route: "perp" as const, totalUsd: allPerp },
    allToken === null ? null : { route: "rtoken" as const, totalUsd: allToken },
  ].filter((x): x is { route: "perp" | "rtoken"; totalUsd: number } => x !== null);
  const bestSingle = singles.length ? singles.reduce((a, b) => (a.totalUsd <= b.totalUsd ? a : b)) : null;

  // When neither wrapper can take the whole order alone, any feasible split is the only answer.
  const savingUsd = bestSingle ? Math.max(0, bestSingle.totalUsd - best.usd) : 0;
  const savingBp = (savingUsd / N) * 10_000;
  const worthIt = bestSingle === null
    ? best.share > 0 && best.share < 1
    : savingUsd >= MIN_SPLIT_SAVING_USD && savingBp >= MIN_SPLIT_SAVING_BP && best.share > 0 && best.share < 1;

  const low = total(best.share, "low");
  const high = total(best.share, "high");

  const curve: SplitPoint[] = [];
  for (let i = 0; i <= 100; i += 2) {
    const usd = total(i / 100, "mid");
    curve.push({ perpShare: i / 100, totalUsd: usd === null ? null : round2(usd) });
  }

  return {
    applicable: true,
    reason: null,
    notionalUsd: N,
    perpUsd: round2(best.share * N),
    tokenUsd: round2((1 - best.share) * N),
    perpShare: best.share,
    totalUsd: round2(best.usd),
    totalRangeUsd: { low: round2(Math.min(low ?? best.usd, high ?? best.usd)), high: round2(Math.max(low ?? best.usd, high ?? best.usd)) },
    bestSingle: bestSingle ? { route: bestSingle.route, totalUsd: round2(bestSingle.totalUsd) } : null,
    savingUsd: round2(savingUsd),
    savingBp: Math.round(savingBp * 100) / 100,
    worthIt,
    curve,
  };
}
