/**
 * Fee constants.
 *
 * Every rate here traces to an observed fill on the account or to a published Bitget
 * schedule, and each one records which. Nothing is illustrative.
 *
 * Spot and perp tiers are independent on Bitget. This account runs 60% below the published
 * spot taker through its VIP tier and BGB payment, and pays the full published rate on
 * perps. Neither is derivable from the other, so they are measured and stored separately and
 * no code here infers one from the other.
 */

export type FeeProvenance = "measured" | "published";

export interface FeeLeg {
  /** One way taker fee as a fraction of notional. */
  taker: number;
  provenance: FeeProvenance;
  source: string;
  /** Present when the rate carries a caveat the user should see. */
  caveat?: string;
}

export interface FeeSchedule {
  spot: FeeLeg;
  perp: FeeLeg;
  stockplus: FeeLeg;
}

export type RouteFeeKey = "spot" | "perp" | "stockplus";

// ---------------------------------------------------------------- receipts

export interface FillReceipt {
  id: string;
  venue: "spot" | "perp";
  symbol: string;
  side: string;
  price: number;
  qty: number;
  notionalUsdt: number;
  feeRaw: number;
  feeCurrency: string;
  impliedRate: number;
  /** Exchange order number. Not supplied for these fills yet. */
  orderId: string | null;
  note?: string;
}

/** BGB's price when the four tokenized stock test orders were placed, for valuing their fees. */
const BGB_AT_TEST = 2.0293;

const perpFill = (side: string, price: number, fee: number, orderId: string): FillReceipt => ({
  id: `perp-nvda-${side.replace(/\s+/g, "-")}`,
  venue: "perp",
  symbol: "NVDAUSDT",
  side,
  price,
  qty: 0.05,
  notionalUsdt: price * 0.05,
  feeRaw: fee,
  feeCurrency: "USDT",
  impliedRate: fee / (price * 0.05),
  orderId,
});

/**
 * Observed fills, kept as the audit trail behind every fee constant.
 *
 * The four perp fills are 0.05 NVDA each, 1x cross, all taker, and every one implies
 * 0.060000% one way to six decimal places against the published rate. That is zero discount,
 * measured on both sides of both directions, so it is not a rebate that only applies to one
 * side.
 *
 * The four perp fills carry their exchange order numbers. The rGOOGL spot fill does not: the
 * order screen for it did not display one. It is stored as null rather than omitted, so the
 * gap is visible rather than silently absent, and the fill stays traceable by symbol, notional
 * and fee.
 */
export const FILL_RECEIPTS: FillReceipt[] = [
  {
    id: "spot-rgoogl-buy",
    venue: "spot",
    symbol: "RGOOGLUSDT",
    side: "buy",
    price: 0,
    qty: 0,
    notionalUsdt: 10.489708,
    feeRaw: 0.00217211,
    feeCurrency: "BGB",
    impliedRate: (0.00217211 * 1.9067) / 10.489708,
    orderId: null,
    note:
      "No order number: the rGOOGL order screen did not display one. " +
      "Fee paid in BGB, so the implied rate depends on the BGB price. Valued at 1.9067 USDT " +
      "this is 3.9482bp. The nearest published tier is 0.04%, reached as the 0.05% tier with " +
      "the 20% BGB discount, and the 1.3% shortfall is BGB drift between the fill and the lookup.",
  },
  perpFill("open long", 213.55, 0.0064065, "1484049356062105601"),
  perpFill("close long", 213.58, 0.0064074, "1484049393424965633"),
  perpFill("open short", 213.53, 0.0064059, "1484049459409756161"),
  perpFill("close short", 213.54, 0.0064062, "1484049475989839873"),
  ...[
    ["rba-buy", "RBAUSDT", "buy", 201.45, 0.054, 10.8783, 0.00214445, "1486701960111009797"],
    ["rba-sell", "RBAUSDT", "sell", 201.36, 0.054, 10.87344, 0.00214339, "1486701986992304149"],
    ["rnvda-buy", "RNVDAUSDT", "buy", 224.22, 0.0485, 10.875058, 0.0021436, "1486703108498862082"],
    ["rnvda-sell", "RNVDAUSDT", "sell", 224.2, 0.0485, 10.873797, 0.00214335, "1486703127809437697"],
  ].map(([id, symbol, side, price, qty, notional, fee, orderId]) => ({
    id: `spot-${id}`,
    venue: "spot" as const,
    symbol: symbol as string,
    side: side as string,
    price: price as number,
    qty: qty as number,
    notionalUsdt: notional as number,
    feeRaw: fee as number,
    feeCurrency: "BGB",
    impliedRate: ((fee as number) * BGB_AT_TEST) / (notional as number),
    orderId: orderId as string,
    note:
      "One of the four StockRoute test orders of 23 September 2026 (see evidence.ts). Fee paid in " +
      `BGB, valued at ${BGB_AT_TEST} USDT read at 17:11 UTC, which makes it 4.00bp, in line with ` +
      "the rGOOGL fill once the BGB price is allowed for.",
  })),
];

// ---------------------------------------------------------------- schedules

/** Bitget's published taker rates, the default for any account with no measurement. */
export const PUBLISHED_FEES: FeeSchedule = {
  spot: { taker: 0.001, provenance: "published", source: "Bitget standard spot taker" },
  perp: { taker: 0.0006, provenance: "published", source: "takerFeeRate on the Bitget perp instrument" },
  stockplus: { taker: 0.0006, provenance: "published", source: "published Bitget Stock+ schedule" },
};

/**
 * This account's measured schedule.
 *
 * spot is derived from the rGOOGL fill and carries a live caveat, because the rate was paid
 * in BGB and therefore moves with the BGB price. perp is measured from four NVDA fills that
 * agree exactly, so it carries none.
 */
export const ACCOUNT_FEES: FeeSchedule = {
  spot: {
    taker: 0.000394815,
    provenance: "measured",
    source: "observed rGOOGL fill on this account, see FILL_RECEIPTS",
    caveat:
      "Spot fee is paid in BGB, so the effective rate moves with the BGB price. " +
      "Measured at 3.95bp; the published tier it sits closest to is 0.04%.",
  },
  perp: {
    taker: 0.0006,
    provenance: "measured",
    source: "four observed NVDAUSDT taker fills, both directions, each implying 0.060000%",
  },
  stockplus: {
    taker: 0.0006,
    provenance: "published",
    source: "published Bitget Stock+ schedule, no account access",
  },
};

/** What the flip test assumed, kept so the two can be compared directly. */
export const FLIP_TEST_FEES: FeeSchedule = {
  spot: { taker: 0.001, provenance: "published", source: "assumed by canary/flip-test.ts" },
  perp: { taker: 0.0006, provenance: "published", source: "assumed by canary/flip-test.ts" },
  stockplus: { taker: 0.0006, provenance: "published", source: "not modeled by the flip test" },
};

/**
 * The schedule the engine uses unless a caller passes its own.
 *
 * Fee tiers are configuration, not a feature. There is no UI for them and no copy about them.
 * A rate falls back to the published one wherever this account has no measurement.
 */
export const DEFAULT_FEES: FeeSchedule = ACCOUNT_FEES;

export const bp = (fraction: number): number => fraction * 10_000;

export const feeLegFor = (route: "rtoken" | "perp" | "stockplus", fees: FeeSchedule): FeeLeg =>
  route === "rtoken" ? fees.spot : route === "perp" ? fees.perp : fees.stockplus;

/** Round trip fee in bp for a route under a schedule. */
export function roundTripFeeBp(route: "rtoken" | "perp" | "stockplus", fees: FeeSchedule): number {
  return bp(feeLegFor(route, fees).taker) * 2;
}

/** Caveats worth surfacing to the user, one per leg that carries one. */
export function feeCaveats(fees: FeeSchedule): string[] {
  const out: string[] = [];
  for (const leg of [fees.spot, fees.perp, fees.stockplus]) {
    if (leg.caveat && !out.includes(leg.caveat)) out.push(leg.caveat);
  }
  return out;
}

/** Legs still priced from a published rate rather than a measurement on this account. */
export function unverifiedLegs(fees: FeeSchedule): RouteFeeKey[] {
  const out: RouteFeeKey[] = [];
  if (fees.spot.provenance === "published") out.push("spot");
  if (fees.perp.provenance === "published") out.push("perp");
  if (fees.stockplus.provenance === "published") out.push("stockplus");
  return out;
}

/**
 * The fee gap the horizon question turns on: rToken round trip minus perp round trip.
 * Positive means fees favour the perp, which is what the flip test assumed. On this
 * account's measured rates it is negative, so fees favour the rToken.
 */
export function feeGapBp(fees: FeeSchedule): number {
  return roundTripFeeBp("rtoken", fees) - roundTripFeeBp("perp", fees);
}
