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
  perp: "Perpetual futures",
  stockplus: "Stock+",
};

/**
 * The name as it reads inside a sentence. Card headings say "Perpetual futures", but dropped
 * into prose that becomes "Only one option works: the perpetual futures", which reads badly.
 */
export const ROUTE_NOUN: Record<RouteId, string> = {
  rtoken: "tokenized stock",
  perp: "perpetual",
  stockplus: "Stock+",
};

/** "the tokenized stock", "the perpetual", "Stock+". */
export const theRoute = (r: RouteId): string => (r === "stockplus" ? "Stock+" : `the ${ROUTE_NOUN[r]}`);
/** Same, capitalised for the start of a sentence. */
export const TheRoute = (r: RouteId): string => {
  const t = theRoute(r);
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** One line saying what each thing actually is, shown under the name. */
export const ROUTE_BLURBS: Record<RouteId, string> = {
  rtoken: "Spot. You own a token tracking the share price. No leverage, no funding.",
  perp: "Tracks the price with no expiry. Can be leveraged and can go short, but you pay or receive funding every 8 hours.",
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
 * from data on disk. They stay null and surface as a warning rather than an invented yes
 * or no.
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
        reason: `You cannot bet on a price falling with ${theRoute(route)}, because you have to own it first. Only the perpetual can do that.`,
        unverified,
      };
    }
  }

  if (c.leverage > cap.maxLeverage) {
    return {
      eligible: false,
      reason:
        cap.maxLeverage === 1
          ? `${TheRoute(route)} is bought outright with your own money, so it cannot give you ${c.leverage}x.`
          : `${TheRoute(route)} goes up to ${cap.maxLeverage}x, and you asked for ${c.leverage}x.`,
      unverified,
    };
  }

  if (c.wantsVoting && !cap.carriesVoting) {
    return {
      eligible: false,
      reason: `${TheRoute(route)} does not make you a shareholder, so it comes with no vote at company meetings.`,
      unverified,
    };
  }

  if (c.wantsDividends) {
    if (cap.paysDividends === false) {
      return {
        eligible: false,
        reason: `${TheRoute(route)} follows the share price only, so it never pays you a dividend.`,
        unverified,
      };
    }
    if (cap.paysDividends === null) {
      unverified.push(`We have not confirmed whether ${theRoute(route)} pays dividends on Bitget.`);
    }
  }

  if (c.usesAsCollateral) {
    if (cap.usableAsCollateral === false) {
      return {
        eligible: false,
        reason: `${TheRoute(route)} cannot be used as collateral to borrow against.`,
        unverified,
      };
    }
    if (cap.usableAsCollateral === null) {
      unverified.push(`We have not confirmed whether ${theRoute(route)} can be used as collateral on Bitget.`);
    }
  }

  if (c.needsOffHoursExit && cap.tradableSessions !== "all") {
    const allowed = cap.tradableSessions as Session[];
    if (!allowed.includes("overnight")) {
      return {
        eligible: false,
        reason: `${TheRoute(route)} only trades while US markets are open, so you could not sell it outside those hours.`,
        unverified,
      };
    }
  }

  if (cap.tradableSessions !== "all" && !(cap.tradableSessions as Session[]).includes(session)) {
    return {
      eligible: false,
      reason: `${TheRoute(route)} is closed right now. It only trades while US markets are open.`,
      unverified,
    };
  }

  return { eligible: true, reason: null, unverified };
}
