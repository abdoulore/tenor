/**
 * Fee constants.
 *
 * Every rate here either traces to an observed fill on the account or to a published
 * Bitget schedule, and each one records which. Nothing is illustrative.
 */

export interface FeeSchedule {
  /** One way taker fee as a fraction of notional. */
  spotTaker: number;
  perpTaker: number;
  stockPlusTaker: number;
  source: Record<string, string>;
  /** Rates not confirmed against this account, so they may be too high. */
  unverified: RouteFeeFlag[];
}

export type RouteFeeFlag = "spot" | "perp" | "stockplus";

/**
 * Observed fill on the account, used to derive the real spot taker rate.
 *
 * An rGOOGL buy of 10.489708 USDT paid 0.00217211 BGB in fees. Valuing BGB at 1.9067
 * USDT gives 0.00414156 USDT, which is 3.948bp of notional. The nearest published rate is
 * 0.04%, reached as the 0.05% tier with the 20% BGB payment discount, and the 1.3% shortfall
 * is BGB drift between the fill and the price lookup.
 *
 * This is the single most consequential constant in the product, because it is 60% below
 * the 0.1% the flip test assumed, so it is recorded with its full derivation rather than
 * as a bare number.
 */
export const OBSERVED_SPOT_FILL = {
  symbol: "RGOOGLUSDT",
  notionalUsdt: 10.489708,
  feeBgb: 0.00217211,
  bgbUsdtAtLookup: 1.9067,
  impliedBp: 3.9482,
  nearestPublishedRate: 0.0004,
};

/**
 * What the engine prices with.
 *
 * spotTaker is derived from the fill above. perpTaker is the rate published on the perp
 * instrument itself (takerFeeRate 0.0006) and is NOT confirmed against this account. If the
 * account carries the same VIP tier and BGB discount on perps that it carries on spot, the
 * real perp rate is lower and every perp number here is too expensive. That biases the
 * engine toward the rToken, which is the safe direction to be wrong in, but it must be said.
 *
 * stockPlusTaker is modeled from the published schedule with no account access at all.
 */
export const ACCOUNT_FEES: FeeSchedule = {
  spotTaker: 0.0004,
  perpTaker: 0.0006,
  stockPlusTaker: 0.0006,
  source: {
    spotTaker: "derived from an observed rGOOGL fill on this account, see OBSERVED_SPOT_FILL",
    perpTaker: "takerFeeRate published on the Bitget perp instrument, not account confirmed",
    stockPlusTaker: "published Bitget Stock+ schedule, modeled, no account access",
  },
  unverified: ["perp", "stockplus"],
};

/**
 * What the flip test assumed, kept so the two can be compared directly.
 *
 * The flip test's whole thesis rested on an 8bp round trip gap in the perp's favour:
 * spot 20bp against perp 12bp. On the account's real rates the spot round trip is 8bp
 * against the perp's 12bp, so the fee gap is 4bp the other way. Fees now favour the rToken.
 * Execution cost still favours the perp by far more than 4bp on most names, so the ranking
 * mostly survives, but the reason for it has changed and any copy claiming an 8bp fee
 * advantage for the perp is now wrong.
 */
export const FLIP_TEST_FEES: FeeSchedule = {
  spotTaker: 0.001,
  perpTaker: 0.0006,
  stockPlusTaker: 0.0006,
  source: {
    spotTaker: "Bitget standard spot taker, assumed by canary/flip-test.ts",
    perpTaker: "Bitget standard USDT perp taker, assumed by canary/flip-test.ts",
    stockPlusTaker: "not modeled by the flip test",
  },
  unverified: ["spot", "perp", "stockplus"],
};

export const bp = (fraction: number): number => fraction * 10_000;

/** Round trip fee in bp for a route under a schedule. */
export function roundTripFeeBp(route: "rtoken" | "perp" | "stockplus", fees: FeeSchedule): number {
  const oneWay =
    route === "rtoken" ? fees.spotTaker : route === "perp" ? fees.perpTaker : fees.stockPlusTaker;
  return bp(oneWay) * 2;
}

/**
 * The fee gap the horizon question turns on: rToken round trip minus perp round trip.
 * Positive means fees favour the perp, which is what the flip test found and what the
 * account's real rates reverse.
 */
export function feeGapBp(fees: FeeSchedule): number {
  return roundTripFeeBp("rtoken", fees) - roundTripFeeBp("perp", fees);
}
