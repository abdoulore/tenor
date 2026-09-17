/**
 * Eligibility: can this route express the view at all.
 *
 * Answered before price, because a route that cannot express the view is not an expensive
 * option, it is not an option. The reason string is returned for every rejection, since the
 * explanation is half the product.
 */

import type { Constraints, Direction, RouteId, Session } from "./types.ts";

/**
 * Names a person can read.
 *
 * "rToken" and "USDT perp" are Bitget's words, not the user's. Someone deciding how to hold
 * NVDA should not have to learn two pieces of exchange jargon before the page makes sense,
 * so the plain name leads and the exchange symbol is shown beside it in the interface.
 */
export const ROUTE_LABELS: Record<RouteId, string> = {
  rtoken: "Tokenized stock",
  perp: "Futures contract",
  stockplus: "Stock+",
};

/** One line saying what each thing actually is, shown under the name. */
export const ROUTE_BLURBS: Record<RouteId, string> = {
  rtoken: "You own a token that tracks the share price. No leverage, no ongoing cost.",
  perp: "A contract that tracks the price. Can be leveraged, can bet on a fall, but you pay or receive a holding fee every 8 hours.",
  stockplus: "Bitget's own stock product. Trades during US market hours only.",
};

export interface RouteCapability {
  canShort: boolean;
  maxLeverage: number;
  paysDividends: boolean | null;
  carriesVoting: boolean;
  usableAsCollateral: boolean | null;
  /** Sessions in which the venue itself accepts orders. */
  tradableSessions: Session[] | "all";
}

/**
 * What each wrapper can and cannot do.
 *
 * paysDividends and usableAsCollateral are null where Bitget's treatment is not confirmed
 * from data on disk. Per the plan's no-new-research rule those stay null and surface as a
 * warning rather than an invented yes or no.
 */
export const CAPABILITIES: Record<RouteId, RouteCapability> = {
  rtoken: {
    canShort: false,
    maxLeverage: 1,
    paysDividends: null,
    carriesVoting: false,
    usableAsCollateral: null,
    tradableSessions: "all",
  },
  perp: {
    canShort: true,
    maxLeverage: 100,
    paysDividends: false,
    carriesVoting: false,
    usableAsCollateral: false,
    tradableSessions: "all",
  },
  stockplus: {
    canShort: false,
    maxLeverage: 1,
    paysDividends: true,
    carriesVoting: true,
    usableAsCollateral: null,
    tradableSessions: ["regular"],
  },
};

export interface EligibilityVerdict {
  eligible: boolean;
  reason: string | null;
  /** Constraints that could not be checked from data on disk. */
  unverified: string[];
}

export function checkEligibility(
  route: RouteId,
  direction: Direction,
  c: Constraints,
  session: Session,
): EligibilityVerdict {
  const cap = CAPABILITIES[route];
  const label = ROUTE_LABELS[route];
  const unverified: string[] = [];

  if (direction === "short" || c.needsShort) {
    if (!cap.canShort) {
      return {
        eligible: false,
        reason: `You cannot bet on a price falling with ${label.toLowerCase()}, because you have to own it first. Only a futures contract can do that.`,
        unverified,
      };
    }
  }

  if (c.leverage > cap.maxLeverage) {
    return {
      eligible: false,
      reason:
        cap.maxLeverage === 1
          ? `${label} is bought outright with your own money, so it cannot give you ${c.leverage} times the exposure.`
          : `${label} goes up to ${cap.maxLeverage} times exposure, and you asked for ${c.leverage} times.`,
      unverified,
    };
  }

  if (c.wantsVoting && !cap.carriesVoting) {
    return {
      eligible: false,
      reason: `${label} does not make you a shareholder, so it comes with no vote at company meetings.`,
      unverified,
    };
  }

  if (c.wantsDividends) {
    if (cap.paysDividends === false) {
      return {
        eligible: false,
        reason: `A ${label.toLowerCase()} follows the share price only, so it never pays you a dividend.`,
        unverified,
      };
    }
    if (cap.paysDividends === null) {
      unverified.push(`We have not confirmed whether ${label.toLowerCase()} pays dividends on Bitget.`);
    }
  }

  if (c.usesAsCollateral) {
    if (cap.usableAsCollateral === false) {
      return {
        eligible: false,
        reason: `${label} cannot be used as collateral to borrow against.`,
        unverified,
      };
    }
    if (cap.usableAsCollateral === null) {
      unverified.push(`We have not confirmed whether ${label.toLowerCase()} can be used as collateral on Bitget.`);
    }
  }

  if (c.needsOffHoursExit && cap.tradableSessions !== "all") {
    const allowed = cap.tradableSessions as Session[];
    if (!allowed.includes("overnight")) {
      return {
        eligible: false,
        reason: `${label} only trades while US markets are open, so you could not sell it outside those hours.`,
        unverified,
      };
    }
  }

  if (cap.tradableSessions !== "all" && !(cap.tradableSessions as Session[]).includes(session)) {
    return {
      eligible: false,
      reason: `${label} is closed right now. It only trades while US markets are open.`,
      unverified,
    };
  }

  return { eligible: true, reason: null, unverified };
}
