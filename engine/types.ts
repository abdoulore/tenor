/**
 * Tenor cost engine: shared types.
 *
 * Everything the engine returns is in basis points against the notional, positive meaning
 * cost. A route is described by four gates answered in order: can you trade it, at your
 * size, at this hour, for how long.
 */

export type RouteId = "rtoken" | "perp" | "stockplus";

export type Session = "regular" | "premarket" | "afterhours" | "overnight" | "weekend";

export type Direction = "long" | "short";

export interface Constraints {
  /** Requested leverage. 1 means unlevered. */
  leverage: number;
  needsShort: boolean;
  wantsDividends: boolean;
  wantsVoting: boolean;
  usesAsCollateral: boolean;
  /** The position must be exitable outside US market hours. */
  needsOffHoursExit: boolean;
}

export interface Intent {
  ticker: string;
  notionalUsd: number;
  direction: Direction;
  horizonDays: number;
  constraints: Constraints;
}

export const DEFAULT_CONSTRAINTS: Constraints = {
  leverage: 1,
  needsShort: false,
  wantsDividends: false,
  wantsVoting: false,
  usesAsCollateral: false,
  needsOffHoursExit: false,
};

/** One side of a book, [price, quantity], best first. */
export type Level = [number, number];

export interface Book {
  asks: Level[];
  bids: Level[];
  /** Exchange timestamp in ms, when the venue supplies one. */
  ts: number | null;
}

/** What walking a book for a given notional actually costs. */
export interface Fill {
  /** Volume weighted fill price, or null when the book cannot fill the size. */
  vwap: number | null;
  /** Cost in bp against the mid, or null when the size does not fill. */
  bp: number | null;
  /** What the book could actually absorb. */
  filledUsd: number;
  exhausted: boolean;
}

export interface Execution {
  mid: number;
  spreadBp: number;
  entry: Fill;
  exit: Fill;
  /** entry.bp + exit.bp, the full round trip, or null if either side does not fill. */
  roundTripBp: number | null;
  askBookUsd: number;
  bidBookUsd: number;
}

/** A projected cost that is honestly a range rather than a point. */
export interface Range {
  low: number;
  mid: number;
  high: number;
}

export type GateStatus =
  | "ok"
  /** No order book at all. Not expensive, untradeable. */
  | "no_book"
  /** A book exists but cannot absorb the requested size. */
  | "cannot_fill"
  /** The route cannot express the view, whatever it costs. */
  | "ineligible"
  /**
   * Fees are known from a published schedule but no order book is reachable, so execution
   * cost is genuinely unknown. Shown with what is known, never ranked against live routes.
   */
  | "modeled"
  /** Priced, but from a stored snapshot rather than a live book. */
  | "stale";

export interface RouteResult {
  route: RouteId;
  label: string;
  status: GateStatus;
  /** Plain language reason, always present when status is not ok. */
  reason: string | null;
  /** True when the numbers come from a published schedule rather than a live book. */
  modeled: boolean;

  execution: Execution | null;
  /** What the book could absorb, when it could not absorb the whole order. */
  absorbableUsd: number | null;

  feeBp: number | null;
  /** Where this route's fee rate came from, so a reader never has to ask. */
  feeProvenance: "measured" | "published" | null;
  feeSource: string | null;
  executionBp: number | null;
  fundingBp: Range | null;
  totalBp: Range | null;

  /** Data age in ms at the time of pricing, when known. */
  stalenessMs: number | null;
  rank: number | null;
}

export interface SessionOutlook {
  session: Session;
  /** Median round trip execution cost for this route in this session, from sampled data. */
  executionBp: number | null;
  /** Share of samples in this session where the book was empty. */
  emptyShare: number | null;
  samples: number;
}

export interface Quote {
  intent: Intent;
  session: Session;
  at: string;
  routes: RouteResult[];
  /** Best eligible route by total cost, or null when nothing is tradeable. */
  recommended: RouteId | null;
  /**
   * Horizon only matters when the execution gap is inside the fee gap. Otherwise
   * execution decides and the break-even curve is noise.
   */
  horizonDecides: boolean;
  /** Per route, per session, from the sampler. Drives the session chart. */
  outlook: Record<RouteId, SessionOutlook[]> | null;
  /** Anything the user should not have to dig for. */
  warnings: string[];
}
