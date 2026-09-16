/**
 * Eligibility: can this route express the view at all.
 *
 * Answered before price, because a route that cannot express the view is not an expensive
 * option, it is not an option. The reason string is returned for every rejection, since the
 * explanation is half the product.
 */

import type { Constraints, Direction, RouteId, Session } from "./types.ts";

export const ROUTE_LABELS: Record<RouteId, string> = {
  rtoken: "rToken (spot)",
  perp: "USDT perp",
  stockplus: "Stock+ (modeled)",
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
      return { eligible: false, reason: `${label} cannot be sold short, it is a spot holding`, unverified };
    }
  }

  if (c.leverage > cap.maxLeverage) {
    return {
      eligible: false,
      reason:
        cap.maxLeverage === 1
          ? `${label} is unlevered, so it cannot express ${c.leverage}x`
          : `${label} tops out at ${cap.maxLeverage}x, below the ${c.leverage}x requested`,
      unverified,
    };
  }

  if (c.wantsVoting && !cap.carriesVoting) {
    return { eligible: false, reason: `${label} carries no voting rights`, unverified };
  }

  if (c.wantsDividends) {
    if (cap.paysDividends === false) {
      return { eligible: false, reason: `${label} pays no dividend, it tracks price only`, unverified };
    }
    if (cap.paysDividends === null) {
      unverified.push(`dividend treatment for ${label} is not confirmed`);
    }
  }

  if (c.usesAsCollateral) {
    if (cap.usableAsCollateral === false) {
      return { eligible: false, reason: `${label} cannot be posted as collateral`, unverified };
    }
    if (cap.usableAsCollateral === null) {
      unverified.push(`collateral treatment for ${label} is not confirmed`);
    }
  }

  if (c.needsOffHoursExit && cap.tradableSessions !== "all") {
    const allowed = cap.tradableSessions as Session[];
    if (!allowed.includes("overnight")) {
      return {
        eligible: false,
        reason: `${label} only trades during ${allowed.join(", ")}, so it cannot be exited off hours`,
        unverified,
      };
    }
  }

  if (cap.tradableSessions !== "all" && !(cap.tradableSessions as Session[]).includes(session)) {
    return {
      eligible: false,
      reason: `${label} is closed during ${session}, it trades ${(cap.tradableSessions as Session[]).join(", ")} only`,
      unverified,
    };
  }

  return { eligible: true, reason: null, unverified };
}
